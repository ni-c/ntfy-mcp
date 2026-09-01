import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  messageIdParam,
  priorityParam,
  sinceParam,
  tagParam,
  topicParam,
  usernameParam,
} from '../schema.js';

import { NtfyApiError, type NtfyApi } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { buildEnvelope, MAX_RESULT_BYTES, toView } from '../messages.js';
import { errorResult, jsonResult, run, untrustedResult } from '../result.js';

const MAX_TOPICS = 10;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_USER_LIMIT = 100;
const MAX_USER_LIMIT = 500;

/** A section of `get_server_info` that could not be fetched. */
interface Unavailable {
  unavailable: string;
}

async function section<T>(
  fetcher: () => Promise<T>,
  onError: (error: NtfyApiError) => string
): Promise<T | Unavailable> {
  try {
    return await fetcher();
  } catch (error) {
    if (error instanceof NtfyApiError) {
      return { unavailable: onError(error) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { unavailable: message };
  }
}

/**
 * Resolves the `topics` argument of the multi-topic read tools.
 *
 * Every entry goes through `resolveTopic`, so `NTFY_TOPICS` bounds reads exactly
 * as it bounds writes.
 */
function resolveTopics(api: NtfyApi, topics: string[] | undefined): string[] {
  if (topics === undefined || topics.length === 0) {
    return [api.resolveTopic(undefined)];
  }
  return topics.map((topic) => api.resolveTopic(topic));
}

export function registerReadTools(server: McpServer, api: NtfyApi): void {
  server.registerTool(
    'list_messages',
    {
      title: 'List cached messages',
      description:
        'Polls the cached messages of one or more topics, oldest first. ' +
        'Returns "next_since": pass it back as "since" to get only what ' +
        'arrived after this call.\n\n' +
        'ntfy has no way to list the topics that exist — a topic is created by ' +
        'publishing to it. You either know the name or you find it in ' +
        'get_account or list_users.\n\n' +
        'Retention is whatever the instance configures (12 hours by default), ' +
        'so an empty result usually means "nothing recent", not "no such ' +
        'topic". Message bodies are shortened here; use get_message for one in ' +
        'full. Entries with an "updates" field revise an earlier notification ' +
        'rather than being new ones.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        topics: z
          .array(topicParam)
          .min(1)
          .max(MAX_TOPICS)
          .optional()
          .describe(
            'Topics to poll. Defaults to the first entry of NTFY_TOPICS.'
          ),
        since: sinceParam
          .optional()
          .describe(
            'How far back to read: "all", "latest", "none", a 12-character ' +
              'message id (exclusive), a Unix timestamp, or a duration such ' +
              'as "24h". Defaults to "24h".'
          ),
        id: messageIdParam
          .optional()
          .describe('Return only the message with this id.'),
        title: z
          .string()
          .max(200)
          .optional()
          .describe('Exact-match filter on the title.'),
        message: z
          .string()
          .max(200)
          .optional()
          .describe('Exact-match filter on the message body.'),
        priority: z
          .array(priorityParam)
          .min(1)
          .max(5)
          .optional()
          .describe('Priorities to include — matches ANY of them.'),
        tags: z
          .array(tagParam)
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Tags to filter by — a message must carry ALL of them. Note that ' +
              'this is the opposite of "priority", which matches any.'
          ),
        scheduled: z
          .boolean()
          .optional()
          .describe(
            'Also include delayed messages that have not been delivered yet.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(
            `Most recent messages to return (default ${DEFAULT_LIMIT}).`
          ),
      }),
    },
    async (args) =>
      run(async () => {
        const topics = resolveTopics(api, args.topics);
        const query: Record<string, string> = {
          since: args.since ?? '24h',
        };
        if (args.id !== undefined) query.id = args.id;
        if (args.title !== undefined) query.title = args.title;
        if (args.message !== undefined) query.message = args.message;
        if (args.priority !== undefined) {
          query.priority = args.priority.join(',');
        }
        if (args.tags !== undefined) query.tags = args.tags.join(',');
        if (args.scheduled === true) query.scheduled = '1';

        const messages = await api.poll(topics, query);
        const envelope = buildEnvelope(
          topics,
          messages,
          args.limit ?? DEFAULT_LIMIT
        );
        return untrustedResult(JSON.stringify(envelope, null, 2));
      })
  );

  server.registerTool(
    'get_message',
    {
      title: 'Get one message',
      description:
        'Fetches a single cached message in full, including the untruncated ' +
        'body, its action buttons and any attachment. Ids come from ' +
        'list_messages or from the result of publish_message.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        id: messageIdParam.describe('The 12-character message id.'),
        topic: topicParam
          .optional()
          .describe(
            'Topic to look in. Defaults to the first NTFY_TOPICS entry.'
          ),
      }),
    },
    async (args) =>
      run(async () => {
        const topic = api.resolveTopic(args.topic);
        const messages = await api.poll([topic], {
          since: 'all',
          id: args.id,
          scheduled: '1',
        });
        const found = messages.find((message) => message.id === args.id);
        if (!found) {
          return errorResult(
            `No message ${args.id} in the cache of topic "${topic}". It may ` +
              'have expired — ntfy keeps messages for a limited time (12 ' +
              'hours by default) — or it was published to another topic.'
          );
        }
        // The same total budget list_messages honours. Without it this tool
        // is the way around the envelope cap: one notification, returned in
        // full, with the fields a publisher chose.
        let body = JSON.stringify(toView(found, { preview: false }), null, 2);
        if (Buffer.byteLength(body, 'utf8') > MAX_RESULT_BYTES) {
          body = JSON.stringify(toView(found, { preview: true }), null, 2);
        }
        return untrustedResult(body);
      })
  );

  server.registerTool(
    'check_topic_access',
    {
      title: 'Check topic access',
      description:
        'Reports whether the configured credentials may SUBSCRIBE to each ' +
        'topic, without publishing anything.\n\n' +
        'Read the result carefully: ntfy grants read and write separately, and ' +
        'this endpoint tests the read side only. A write-only publishing token ' +
        'is denied here and can still publish perfectly well — that ' +
        'combination is the single most common source of confusion with ntfy.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        topics: z
          .array(topicParam)
          .min(1)
          .max(MAX_TOPICS)
          .optional()
          .describe(
            'Topics to check. Defaults to the first NTFY_TOPICS entry.'
          ),
      }),
    },
    async (args) =>
      run(async () => {
        const topics = resolveTopics(api, args.topics);
        const results = [];
        // Sequential on purpose: repeated authentication failures trip ntfy's
        // own auth rate limit (42909), and a parallel fan-out is the fastest
        // way to get there.
        for (const topic of topics) {
          try {
            await api.get(`/${topic}/auth`);
            results.push({ topic, read_access: true });
          } catch (error) {
            if (error instanceof NtfyApiError) {
              results.push({
                topic,
                read_access: false,
                status: error.status,
                note:
                  error.status === 403 || error.status === 401
                    ? 'Not permitted to subscribe. Publishing may still work ' +
                      'if the account has write access.'
                    : 'Unexpected response.',
              });
              continue;
            }
            throw error;
          }
        }
        return jsonResult({ results });
      })
  );

  server.registerTool(
    'get_server_info',
    {
      title: 'Get server info',
      description:
        'Health, capabilities and usage of the ntfy instance. Health, config ' +
        'and stats are public, so this is the one tool that works before the ' +
        'credentials are right — a good first call after setup.\n\n' +
        'Each section is fetched independently; one that is unavailable is ' +
        'reported as such and does not fail the call. "version" needs an admin ' +
        'account, so its absence is normal.',
      annotations: READ_ONLY,
      inputSchema: z.object({}),
    },
    async () =>
      run(async () => {
        const [health, config, stats, version, account] = await Promise.all([
          section(
            () => api.get('/v1/health'),
            (error) => `health check failed with HTTP ${error.status}`
          ),
          section(
            () => api.get('/v1/config'),
            (error) => `not available (HTTP ${error.status})`
          ),
          section(
            () => api.get('/v1/stats'),
            (error) => `not available (HTTP ${error.status})`
          ),
          section(
            () => api.get('/v1/version'),
            () =>
              'requires an admin account — normal for a non-admin token, not ' +
              'an error'
          ),
          section(
            () => api.account(),
            () => 'not available'
          ),
        ]);

        const role =
          typeof account === 'object' &&
          account !== null &&
          'role' in account &&
          typeof account.role === 'string'
            ? (account as { role: string }).role
            : undefined;

        // jsonResult, not untrustedResult, unlike the other read tools: these
        // four sections are the instance's own configuration and counters,
        // set by whoever runs the server this client was pointed at — not by a
        // third party who happened to learn a topic name. Half the object is
        // also derived here rather than fetched, and marking that as upstream
        // content would be a lie in the other direction.
        return jsonResult({
          health,
          config,
          stats,
          version,
          // Answers "should I even try the user and access tools?" from one
          // cheap call, instead of after a confusing 401.
          admin_tools_available:
            role === undefined ? 'unknown' : role === 'admin',
          authenticated_as: role === undefined ? 'unknown' : role,
          topics_restricted_to:
            api.allowedTopics.length > 0 ? api.allowedTopics : null,
        });
      })
  );

  server.registerTool(
    'get_account',
    {
      title: 'Get account',
      description:
        'Identity, role, tier, limits and current usage of the configured ' +
        'credentials. Access token values are redacted — only their labels and ' +
        'timestamps are shown.',
      annotations: READ_ONLY,
      inputSchema: z.object({}),
    },
    async () =>
      run(async () =>
        // Token labels and the tier name are free text somebody typed, so the
        // result is framed as data rather than as this server speaking.
        untrustedResult(
          JSON.stringify(redactAccount(await api.account()), null, 2)
        )
      )
  );

  server.registerTool(
    'list_users',
    {
      title: 'List users',
      description:
        'Every account on the instance with its per-topic grants — the ' +
        'answer to "who can read or write topic X". Requires an admin ' +
        'account; get_server_info reports whether the current one qualifies.',
      annotations: READ_ONLY,
      inputSchema: z.object({
        username: usernameParam
          .optional()
          .describe('Return only this account.'),
        topic: topicParam
          .optional()
          .describe(
            'Return only accounts with a grant whose pattern matches this topic.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_USER_LIMIT)
          .optional()
          .describe(`Accounts to return (default ${DEFAULT_USER_LIMIT}).`),
      }),
    },
    async (args) =>
      run(async () => {
        const users = await api.get('/v1/users');
        let filtered = (Array.isArray(users) ? users : []).map(toUserView);
        if (args.username !== undefined) {
          filtered = filtered.filter((user) => user.username === args.username);
        }
        if (args.topic !== undefined) {
          const topic = args.topic;
          filtered = filtered.filter((user) =>
            user.grants.some((grant) => grantMatches(grant.topic, topic))
          );
        }

        const total = filtered.length;
        const shown = filtered.slice(0, args.limit ?? DEFAULT_USER_LIMIT);
        const payload: Record<string, unknown> = {
          count: shown.length,
          total,
          users: shown,
        };
        if (shown.length < total) {
          payload.note =
            `${total - shown.length} more account(s) exist. Narrow the ` +
            'request with "username" or "topic", or raise "limit".';
        }
        // Usernames and grant patterns are instance content, not server
        // metadata: on an instance with signup enabled, anyone on the internet
        // chooses their own username.
        return untrustedResult(JSON.stringify(payload, null, 2));
      })
  );
}

interface UserView {
  username: string;
  role: string;
  tier?: string;
  grants: { topic: string; permission: string }[];
}

/**
 * Projects the four fields this tool is about, rather than spreading whatever
 * ntfy sent.
 *
 * A denylist would only remove the sensitive keys known today. ntfy 2.19.2's
 * user record happens to carry no password hash, but that is a property of this
 * upstream release, not of this server — a newer or forked ntfy adding one
 * would ship it into the transcript with no change here.
 */
function toUserView(entry: unknown): UserView {
  const source = (entry ?? {}) as Record<string, unknown>;
  const grants = Array.isArray(source.grants) ? source.grants : [];
  const view: UserView = {
    username: text(source.username, '(unknown)'),
    role: text(source.role, '(unknown)'),
    grants: grants.map((grant) => {
      const g = (grant ?? {}) as Record<string, unknown>;
      return {
        topic: text(g.topic, ''),
        permission: text(g.permission, ''),
      };
    }),
  };
  if (typeof source.tier === 'string') view.tier = source.tier;
  return view;
}

/**
 * A string field of an upstream object, or the fallback.
 *
 * `String(value)` would turn an object into the literal "[object Object]" and a
 * nested structure into a field that looks like a name — which is exactly the
 * shape a hostile upstream would send to smuggle something past a projection
 * that only checks for presence.
 */
function text(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

/** Whether an ACL pattern (which may end in `*`) covers `topic`. */
function grantMatches(pattern: string, topic: string): boolean {
  if (pattern.endsWith('*')) return topic.startsWith(pattern.slice(0, -1));
  return pattern === topic;
}

/**
 * Removes the credentials `GET /v1/account` hands out.
 *
 * ntfy returns every access token of the account in plaintext — verified
 * against 2.19.2. Putting a live credential into the model's context, and
 * therefore into the transcript, is exactly the leak this server exists to
 * avoid. `sync_topic` goes too: it is a topic name, which on ntfy is a bearer
 * secret, and no tool here has any use for it.
 */
export function redactAccount(account: unknown): unknown {
  if (typeof account !== 'object' || account === null) return account;
  const source = account as Record<string, unknown>;
  const result: Record<string, unknown> = { ...source };

  if (Array.isArray(source.tokens)) {
    result.tokens = source.tokens.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return '(redacted)';
      // Overwrite rather than omit: a caller seeing no `token` key at all
      // could reasonably read it as "this entry had none".
      return { ...(entry as Record<string, unknown>), token: '(redacted)' };
    });
  }
  if ('sync_topic' in source) result.sync_topic = '(redacted)';
  return result;
}
