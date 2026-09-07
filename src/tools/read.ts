import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  anyJsonValue,
  foreignDocument,
  messageIdParam,
  priorityParam,
  sinceParam,
  tagParam,
  topicParam,
  untrustedFields,
  usernameParam,
} from '../schema.js';

import { NtfyApiError, type NtfyApi } from '../api.js';
import { arrayOf, isRecord, stringOf } from '../boundary.js';
import { cleanCut, cleanDeep, errorText } from '../clean.js';
import { READ_ONLY } from './annotations.js';
import {
  buildEnvelope,
  MAX_RESULT_BYTES,
  messageEnvelope,
  messageView,
  toView,
} from '../messages.js';
import {
  errorResult,
  jsonResult,
  renderJson,
  run,
  untrustedBytes,
  untrustedResult,
} from '../result.js';

const MAX_TOPICS = 10;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_USER_LIMIT = 100;
const MAX_USER_LIMIT = 500;

/**
 * Wall clock for one `check_topic_access` call.
 *
 * The per-request timeout is not a per-call budget: ten topics at fifteen
 * seconds each is a call that can run for two and a half minutes, on a tool
 * annotated cheap. What is not reached inside the budget is reported as
 * unchecked rather than left out — an absent entry reads as an answer.
 */
const ACCESS_CHECK_BUDGET_MS = 30_000;

/**
 * Ceilings on the parts of an answer the instance sizes rather than this server.
 *
 * A section of `get_server_info` is whatever `/v1/config` returns; an account
 * record carries `limits`, `stats` and every access token's metadata; a username
 * on an instance with signup enabled is chosen by whoever signed up. None of
 * them has a length in ntfy's API, and all of them used to be passed on whole —
 * so one call could answer with several megabytes, which costs the caller its
 * context window rather than merely being untidy.
 */
const MAX_SECTION_BYTES = 40_000;
const MAX_ACCOUNT_BYTES = 60_000;
const MAX_NAME_CHARS = 200;

/** What replaces a section too large to report. */
function tooLarge(what: string, bytes: number): { unavailable: string } {
  return {
    unavailable:
      `${what} is ${bytes} bytes, past the ${MAX_SECTION_BYTES}-byte ceiling ` +
      'this server puts on one section of an answer',
  };
}

/**
 * Cleans a pass-through document and refuses it if it is too big to report.
 *
 * The order matters: cleaning first would spend the walk on a document that is
 * then discarded, so the size is decided on what arrived.
 */
function boundedSection(
  value: unknown,
  what: string
): unknown | { unavailable: string } {
  // A section is a *document*: the schema's union is a loose object or a note
  // saying why there is none, and a number, a string or `null` is neither. Left
  // alone it fails the whole call's output validation — one endpoint answering
  // `42` costing every other section of the answer, which is exactly the shape
  // this tool's "one unavailable section does not fail the call" design exists
  // to prevent.
  if (isRecord(value)) {
    const bytes = Buffer.byteLength(renderJson(value), 'utf8');
    if (bytes > MAX_SECTION_BYTES) return tooLarge(what, bytes);
    return cleanDeep(value);
  }
  return {
    unavailable: `${what} was not a JSON object — this is not an ntfy API response`,
  };
}

/**
 * A section of `get_server_info`, or the note saying why it is absent.
 *
 * A union rather than an optional field: "not fetched" and "fetched and empty"
 * are different answers, and the tool's whole design is that one unavailable
 * section does not fail the call.
 */
const sectionOrUnavailable = z.union([
  foreignDocument,
  z.object({ unavailable: z.string() }),
]);

/** The per-account view `list_users` builds. Mirrors {@link toUserView}. */
const userView = z.object({
  username: z.string(),
  role: z.string(),
  tier: z.string().optional(),
  grants: z.array(z.object({ topic: z.string(), permission: z.string() })),
});

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
    // Not this server's own words: undici quotes a header value it refuses,
    // Node's TLS layer quotes the certificate's names. Cleaned and cut like any
    // other text that arrived from outside.
    return { unavailable: errorText(error, 500) };
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
      outputSchema: messageEnvelope.extend(untrustedFields),
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
        // The budget is handed the renderer, not a serialisation of the value:
        // what goes out carries the marker sentence, the two marker fields and
        // two-space indentation, and none of those used to be measured.
        const envelope = buildEnvelope(
          topics,
          messages,
          args.limit ?? DEFAULT_LIMIT,
          untrustedBytes
        );
        return untrustedResult(envelope, 'list_messages');
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
      outputSchema: messageView.extend(untrustedFields),
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
        // The same total budget list_messages honours, measured on the same
        // string it will be emitted as. Without it this tool is the way around
        // the envelope cap: one notification, returned in full, with the fields
        // a publisher chose.
        let view = toView(found, { preview: false });
        if (view !== undefined && untrustedBytes(view) > MAX_RESULT_BYTES) {
          view = toView(found, { preview: true });
        }
        if (view === undefined) {
          // Only reachable if the id that matched is not a string, which the
          // comparison above already rules out — kept because the projection is
          // allowed to refuse and a silent `undefined` would be a crash later.
          return errorResult(
            `The entry ntfy returned for ${args.id} could not be read as a ` +
              'message.'
          );
        }
        return untrustedResult(view, 'get_message');
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
      outputSchema: z.object({
        results: z.array(
          z.object({
            topic: z.string(),
            read_access: z.boolean(),
            status: z
              .number()
              .int()
              .optional()
              .describe('HTTP status ntfy answered with, on a refusal.'),
            note: z.string().optional(),
            /** Set when the call ran out of time before reaching this topic. */
            not_checked: z.literal(true).optional(),
          })
        ),
      }),
    },
    async (args) =>
      run(async () => {
        const topics = resolveTopics(api, args.topics);
        const results = [];
        // A wall clock for the call, not only a timeout per request. Ten topics
        // at the fifteen-second request timeout is two and a half minutes on a
        // tool the annotations call cheap, and the deadline is checked before
        // each request rather than after.
        const deadline = Date.now() + ACCESS_CHECK_BUDGET_MS;
        // Sequential on purpose: repeated authentication failures trip ntfy's
        // own auth rate limit (42909), and a parallel fan-out is the fastest
        // way to get there.
        for (const topic of topics) {
          if (Date.now() >= deadline) {
            results.push({
              topic,
              read_access: false,
              not_checked: true as const,
              note:
                'Not checked: this call reached its ' +
                `${ACCESS_CHECK_BUDGET_MS / 1000}-second budget. Ask for ` +
                'fewer topics.',
            });
            continue;
          }
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
        return jsonResult({ results }, 'check_topic_access');
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
      outputSchema: z.object({
        health: sectionOrUnavailable,
        config: sectionOrUnavailable,
        stats: sectionOrUnavailable,
        version: sectionOrUnavailable,
        admin_tools_available: z
          .union([z.boolean(), z.literal('unknown')])
          .describe('Whether the user and access tools will work.'),
        authenticated_as: z
          .string()
          .describe('The role of the configured credentials, or "unknown".'),
        topics_restricted_to: z
          .array(z.string())
          .nullable()
          .describe('NTFY_TOPICS, or null when the server is unrestricted.'),
      }),
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

        const role = isRecord(account) ? stringOf(account.role) : undefined;

        // jsonResult, not untrustedResult, unlike the other read tools: these
        // four sections are the instance's own configuration and counters,
        // set by whoever runs the server this client was pointed at — not by a
        // third party who happened to learn a topic name. Half the object is
        // also derived here rather than fetched, and marking that as upstream
        // content would be a lie in the other direction.
        return jsonResult(
          {
            // Each section is the instance's document, bounded and cleaned on
            // its own so one oversized `/v1/config` costs that section rather
            // than the call. `role` above is read before this, off the raw
            // record, because it is this server's own derived answer.
            health: boundedSection(health, 'the health section'),
            config: boundedSection(config, 'the config section'),
            stats: boundedSection(stats, 'the stats section'),
            version: boundedSection(version, 'the version section'),
            // Answers "should I even try the user and access tools?" from one
            // cheap call, instead of after a confusing 401.
            admin_tools_available:
              role === undefined ? 'unknown' : role === 'admin',
            // The instance's word for what this account is, so cleaned and cut
            // like any other string it chose.
            authenticated_as:
              role === undefined ? 'unknown' : cleanCut(role, MAX_NAME_CHARS),
            topics_restricted_to:
              api.allowedTopics.length > 0 ? api.allowedTopics : null,
          },
          'get_server_info'
        );
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
      // Every field optional, and the three structured ones untyped. This is
      // `redactAccount`'s allowlist, which copies what ntfy sent rather than
      // rebuilding it — so the schema promises only what the allowlist decides,
      // which is *whether* a field is here, never what is inside it. `tier` is
      // the concrete reason to be careful: on `/v1/account` it is an object
      // (`{code, name}`), while on `/v1/users` the same word is a string.
      outputSchema: z.object({
        ...untrustedFields,
        username: anyJsonValue.optional(),
        role: anyJsonValue.optional(),
        tier: anyJsonValue.optional(),
        limits: anyJsonValue.optional().describe('Quota ceilings of the tier.'),
        stats: anyJsonValue
          .optional()
          .describe('Usage against those ceilings.'),
        language: anyJsonValue.optional(),
        tokens: z
          .array(anyJsonValue)
          .optional()
          .describe('Access tokens with their value replaced by "(redacted)".'),
      }),
    },
    async () =>
      run(async () =>
        // Token labels and the tier name are free text somebody typed, so the
        // result is framed as data rather than as this server speaking.
        untrustedResult(redactAccount(await api.account()), 'get_account')
      )
  );

  server.registerTool(
    'list_users',
    {
      title: 'List users',
      description:
        'Every account on the instance with its per-topic grants — the ' +
        'answer to "who can read or write topic X". Requires an admin ' +
        'account; get_server_info reports whether the current one qualifies.\n\n' +
        'Where NTFY_TOPICS restricts this server, the grants are reported ' +
        'against those topics only: a grant on a wildcard appears once per ' +
        'allowed topic it covers, and one that covers none of them is not ' +
        'shown at all.',
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
      outputSchema: z.object({
        ...untrustedFields,
        count: z.number().int().describe('Accounts in this answer.'),
        total: z.number().int().describe('Accounts that matched the filter.'),
        note: z.string().optional(),
        users: z.array(userView),
      }),
    },
    async (args) =>
      run(async () => {
        // Resolved rather than used as given, so the filter is bounded like
        // every other topic argument on this server. Only when present: an
        // absent filter means "every account", not "the default topic".
        const wanted =
          args.topic === undefined ? undefined : api.resolveTopic(args.topic);

        const users = await api.get('/v1/users');
        let filtered = arrayOf(users).map((entry) =>
          toUserView(entry, api.allowedTopics)
        );
        if (args.username !== undefined) {
          filtered = filtered.filter((user) => user.username === args.username);
        }
        if (wanted !== undefined) {
          filtered = filtered.filter((user) =>
            user.grants.some((grant) => grantMatches(grant.topic, wanted))
          );
        }

        const total = filtered.length;
        let shown = filtered.slice(0, args.limit ?? DEFAULT_USER_LIMIT);
        const build = (): Record<string, unknown> => ({
          count: shown.length,
          total,
          users: shown,
        });
        // `limit` bounds the number of accounts and nothing bounds an account:
        // a username is chosen by whoever signed up, and a grant list by
        // whoever administers the instance. Drop whole accounts from the end —
        // an account reported in half is worse than one reported as missing —
        // and say how many are gone.
        let droppedForSize = 0;
        while (shown.length > 0 && untrustedBytes(build()) > MAX_RESULT_BYTES) {
          shown = shown.slice(0, -1);
          droppedForSize += 1;
        }
        const payload = build();
        if (shown.length < total) {
          payload.note =
            `${total - shown.length} more account(s) exist` +
            (droppedForSize > 0
              ? `, ${droppedForSize} of them left out to stay inside the ` +
                'result budget'
              : '') +
            '. Narrow the request with "username" or "topic", or raise "limit".';
        }
        // Usernames and grant patterns are instance content, not server
        // metadata: on an instance with signup enabled, anyone on the internet
        // chooses their own username.
        return untrustedResult(payload, 'list_users');
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
function toUserView(entry: unknown, allowed: readonly string[]): UserView {
  const source = isRecord(entry) ? entry : {};
  const grants = arrayOf(source.grants);
  const view: UserView = {
    username: text(source.username, '(unknown)'),
    role: text(source.role, '(unknown)'),
    grants: projectGrants(
      // `MAX_GRANTS` before the projection, not after: `projectGrants` walks
      // the allowed topics once per grant, so an account the instance reports
      // with a hundred thousand grants is a product, not a list.
      grants.slice(0, MAX_GRANTS).map((grant) => {
        const g = isRecord(grant) ? grant : {};
        return {
          topic: text(g.topic, ''),
          permission: text(g.permission, ''),
        };
      }),
      allowed
    ),
  };
  const tier = stringOf(source.tier);
  if (tier !== undefined) view.tier = cleanCut(tier, MAX_NAME_CHARS);
  return view;
}

/** Ceiling on the grants of one account, which ntfy does not bound. */
const MAX_GRANTS = 500;

/**
 * Restates an account's grants in terms of `NTFY_TOPICS`.
 *
 * A grant pattern is a topic name, and on ntfy a topic name is a bearer
 * credential — so an unfiltered `/v1/users` answers "which topics exist on this
 * instance" for every one of them, which is the question `NTFY_TOPICS` exists to
 * keep this server from answering. Each grant is therefore reported against the
 * allowed topics it actually covers, and one that covers none of them is
 * dropped: the account still appears, with the access it has to the topics this
 * server may know about.
 *
 * Two patterns can cover the same allowed topic — `deploy*` and `deploys` — and
 * both entries are kept. Which of them ntfy applies is its own precedence rule,
 * and a projection that picked one would be inventing an answer.
 */
function projectGrants(
  grants: { topic: string; permission: string }[],
  allowed: readonly string[]
): { topic: string; permission: string }[] {
  if (allowed.length === 0) return grants;
  const projected: { topic: string; permission: string }[] = [];
  for (const grant of grants) {
    for (const topic of allowed) {
      if (grantMatches(grant.topic, topic)) {
        projected.push({ topic, permission: grant.permission });
      }
    }
  }
  return projected;
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
  if (typeof value === 'string') return cleanCut(value, MAX_NAME_CHARS);
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
 * The keys of `GET /v1/account` this tool is about: who the credentials are,
 * what they may do, and how much of their quota is used.
 */
const ACCOUNT_FIELDS = [
  'username',
  'role',
  'tier',
  'limits',
  'stats',
  'language',
] as const;

/** The metadata of an access token — everything except its value. */
const TOKEN_FIELDS = ['label', 'last_access', 'expires'] as const;

/**
 * Projects the fields `get_account` is about, rather than spreading whatever
 * ntfy sent.
 *
 * An allowlist for the same reason {@link toUserView} uses one, and the reason
 * is sharper here because the account record is the densest personal payload
 * ntfy has. A denylist that removed the token values and `sync_topic` — the two
 * that were known to be secret — still passed through `phone_numbers`, `billing`
 * with its Stripe identifiers, and the `reservations` and `subscriptions`
 * arrays, each of which is a list of topic names, and a topic name on ntfy is a
 * bearer credential. None of those is what this tool was asked for, and none of
 * them has a tool here that uses it.
 *
 * `tokens` survives as metadata only: ntfy returns every access token of the
 * account in plaintext — verified against 2.19.2 — and the value is overwritten
 * rather than dropped, because a caller seeing no `token` key at all could
 * reasonably read it as "this entry had none".
 *
 * The allowlist is one level deep. `limits` and `stats` are counters and pass
 * through whole; a future ntfy that hides something inside one of them would get
 * past this, which is the price of reporting them at all.
 */
export function redactAccount(account: unknown): Record<string, unknown> {
  // An empty object, not the value itself. An allowlist keeps nothing it does
  // not understand, and a non-object account body has none of these fields to
  // begin with — returning it verbatim would forward exactly the shape the
  // allowlist exists to stop, and would not fit the declared output schema.
  if (!isRecord(account)) return {};
  const source = account;
  const result: Record<string, unknown> = {};

  for (const field of ACCOUNT_FIELDS) {
    // `Object.hasOwn`, not `in`: the record comes from `JSON.parse`, so what
    // the prototype chain carries is not this account's.
    if (Object.hasOwn(source, field)) {
      const value = source[field];
      // Bounded per field rather than only in total: `limits` and `stats` pass
      // through whole, and "whole" is the instance's choice of size.
      result[field] =
        Buffer.byteLength(renderJson({ value }), 'utf8') > MAX_ACCOUNT_BYTES
          ? tooLarge(
              `the ${field} field`,
              Buffer.byteLength(renderJson({ value }), 'utf8')
            )
          : cleanDeep(value);
    }
  }

  if (Array.isArray(source.tokens)) {
    result.tokens = source.tokens.slice(0, MAX_TOKENS).map((entry) => {
      if (!isRecord(entry)) return '(redacted)';
      const view: Record<string, unknown> = { token: '(redacted)' };
      for (const field of TOKEN_FIELDS) {
        if (Object.hasOwn(entry, field)) {
          view[field] = cleanDeep(entry[field]);
        }
      }
      return view;
    });
  }
  return result;
}

/** Ceiling on the access tokens of one account, which ntfy does not bound. */
const MAX_TOKENS = 200;
