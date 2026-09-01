import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { setResourceKey } from 'mcp-approval';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import {
  actionSchema,
  confirmTokenParam,
  delayParam,
  httpUrl,
  MAX_ACTIONS,
  messageBody,
  messageIdParam,
  priorityParam,
  safeFilename,
  tagParam,
  titleText,
  topicParam,
} from '../schema.js';

import type { NtfyApi, NtfyMessage } from '../api.js';
import { errorResult, jsonResult, run } from '../result.js';

const MAX_TOPICS = 10;
const MAX_IDS = 25;

/** The content fields shared by publishing and updating. */
const contentSchema = {
  message: messageBody.optional().describe('The notification body.'),
  title: titleText.optional().describe('The notification title.'),
  priority: priorityParam
    .optional()
    .describe('1 (min) to 5 (max), or "min"/"low"/"default"/"high"/"max".'),
  tags: z
    .array(tagParam)
    .max(20)
    .optional()
    .describe(
      'Tags as separate entries. Names that match an emoji short code ' +
        '(for example "warning", "rocket") are rendered as that emoji.'
    ),
  click: httpUrl
    .optional()
    .describe('URL opened when the notification itself is tapped.'),
  icon: httpUrl.optional().describe('URL of a JPEG or PNG icon.'),
  markdown: z
    .boolean()
    .optional()
    // A genuine boolean, unlike cache and firebase below — do not "fix" this
    // for symmetry.
    .describe('Render the message as Markdown in clients that support it.'),
  actions: z
    .array(actionSchema)
    .max(MAX_ACTIONS)
    .optional()
    .describe(
      `Up to ${MAX_ACTIONS} action buttons. An "http" action fires from the ` +
        "recipient's device, not from the server, and defaults to POST."
    ),
};

// `| undefined` on every field, not just `?`: under exactOptionalPropertyTypes
// the zod output type is "present and possibly undefined", which an optional
// property alone does not accept.
type ContentArgs = {
  message?: string | undefined;
  title?: string | undefined;
  priority?: number | string | undefined;
  tags?: string[] | undefined;
  click?: string | undefined;
  icon?: string | undefined;
  markdown?: boolean | undefined;
  actions?: unknown[] | undefined;
};

function contentBody(args: ContentArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.message !== undefined) body.message = args.message;
  if (args.title !== undefined) body.title = args.title;
  if (args.priority !== undefined) body.priority = args.priority;
  if (args.tags !== undefined) body.tags = args.tags;
  if (args.click !== undefined) body.click = args.click;
  if (args.icon !== undefined) body.icon = args.icon;
  if (args.markdown !== undefined) body.markdown = args.markdown;
  if (args.actions !== undefined) body.actions = args.actions;
  return body;
}

export function registerMessageWriteTools(
  server: McpServer,
  api: NtfyApi,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'publish_message',
    {
      title: 'Publish a notification',
      description:
        'Sends a notification to one or more topics.\n\n' +
        'ntfy has no multi-topic publish, so this sends one request per topic ' +
        'and reports each outcome separately — a rejection on one topic does ' +
        'not discard the ones that succeeded. Check the "ok" field per entry ' +
        'rather than assuming the whole call worked.\n\n' +
        "The returned id is also the notification's sequence id: pass it to " +
        'update_message to revise this notification in place, which is how a ' +
        'progress report stays one notification instead of five.',
      annotations: {
        // Destroys nothing, and reaches people who cannot un-receive it.
        // That is an outbound effect, not a destructive one, and no annotation
        // carries it — the description does. Each call sends again.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
        topics: z
          .array(topicParam)
          .min(1)
          .max(MAX_TOPICS)
          .optional()
          .describe(
            'Topics to publish to. Defaults to the first NTFY_TOPICS entry.'
          ),
        ...contentSchema,
        attach: httpUrl
          .optional()
          .describe('URL of a file to attach by reference.'),
        filename: safeFilename
          .optional()
          .describe('Download name for the attachment.'),
        delay: delayParam
          .optional()
          .describe(
            'Deliver later: a duration such as "30m", a Unix timestamp, or ' +
              'natural language like "tomorrow, 10am". Between 10 seconds and ' +
              '3 days.'
          ),
        cache: z
          .boolean()
          .optional()
          .describe(
            'Set false to keep the message out of the server cache. It then ' +
              'reaches only clients connected at that moment, and cannot be ' +
              'updated or deleted afterwards.'
          ),
        firebase: z
          .boolean()
          .optional()
          .describe('Set false to skip forwarding via Firebase.'),
      }),
    },
    async (args) =>
      run(async () => {
        if (args.delay !== undefined && args.cache === false) {
          // ntfy answers 40002 here; saying why is more use than relaying it.
          return errorResult(
            'A delayed message must be cached — it has to exist on the server ' +
              'until it fires. Drop either "delay" or "cache": false.'
          );
        }
        if (args.message === undefined && args.title === undefined) {
          return errorResult('Provide at least a message or a title.');
        }

        const topics =
          args.topics === undefined || args.topics.length === 0
            ? [api.resolveTopic(undefined)]
            : args.topics.map((topic) => api.resolveTopic(topic));

        const base = contentBody(args);
        if (args.attach !== undefined) base.attach = args.attach;
        if (args.filename !== undefined) base.filename = args.filename;
        if (args.delay !== undefined) base.delay = args.delay;
        // Both of these are strings in ntfy's JSON body, not booleans: the API
        // wants the literal "no" and silently ignores `false`. Exposing them as
        // booleans and mapping here is the only shape a model cannot get wrong.
        if (args.cache === false) base.cache = 'no';
        if (args.firebase === false) base.firebase = 'no';

        const results = [];
        for (const topic of topics) {
          try {
            const published = (await api.publish({
              ...base,
              topic,
            })) as NtfyMessage;
            results.push({
              topic,
              ok: true,
              id: published.id,
              sequence_id: published.id,
            });
          } catch (error) {
            results.push({
              topic,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const failed = results.filter((entry) => !entry.ok).length;
        return jsonResult({
          published: results.length - failed,
          failed,
          results,
        });
      })
  );

  server.registerTool(
    'update_message',
    {
      title: 'Update a notification',
      description:
        'Replaces the content of a notification already published, so ' +
        'subscribers see it change in place instead of receiving another one.\n\n' +
        'The sequence id is the id returned by publish_message. It only exists ' +
        'for cached messages: one published with "cache": false cannot be ' +
        'updated. Only the fields given are sent; the cache keeps each ' +
        'revision as its own entry pointing back at the original, which is why ' +
        'list_messages shows them with an "updates" field — the original keeps ' +
        'its old text and a second entry carries the new one.\n\n' +
        'Needs ntfy 2.16.0 or newer, and the failure below that is silent: an ' +
        'older server simply publishes a **new notification** instead of ' +
        'revising the old one, and answers success. If subscribers report ' +
        'receiving two, that is why — check get_server_info for the version.',
      annotations: {
        // Replaces the fields of a message somebody already received a copy
        // of. What was there is not recoverable.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        sequence_id: messageIdParam.describe(
          'Id of the notification to revise, as returned by publish_message.'
        ),
        topic: topicParam
          .optional()
          .describe('Its topic. Defaults to the first NTFY_TOPICS entry.'),
        ...contentSchema,
      }),
    },
    async (args) =>
      run(async () => {
        const topic = api.resolveTopic(args.topic);
        const body = contentBody(args);
        if (Object.keys(body).length === 0) {
          return errorResult('Provide at least one field to change.');
        }
        const updated = (await api.publish({
          ...body,
          topic,
          sequence_id: args.sequence_id,
        })) as NtfyMessage;
        return jsonResult({
          topic,
          updated: args.sequence_id,
          revision_id: updated.id,
        });
      })
  );

  server.registerTool(
    'mark_messages_read',
    {
      title: 'Mark notifications read',
      description:
        "Clears notifications on subscribers' devices. The messages stay in " +
        'the server cache and remain readable with list_messages — that is the ' +
        'whole difference from delete_messages, which also leaves them there ' +
        'but tells subscribers to remove rather than to clear.\n\n' +
        'Needs ntfy 2.16.0 or newer. Against an older server every id comes ' +
        'back with ok:false inside a result that is not an error — check the ' +
        'per-id results rather than only whether the call succeeded.',
      annotations: {
        // A marker, and ntfy keeps the message either way.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        sequence_ids: z
          .array(messageIdParam)
          .min(1)
          .max(MAX_IDS)
          .describe('Ids of the notifications to clear.'),
        topic: topicParam
          .optional()
          .describe('Their topic. Defaults to the first NTFY_TOPICS entry.'),
      }),
    },
    async (args) =>
      run(async () => {
        const topic = api.resolveTopic(args.topic);
        const results = [];
        for (const id of args.sequence_ids) {
          try {
            await api.put(`/${topic}/${id}/read`);
            results.push({ id, ok: true });
          } catch (error) {
            results.push({
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return jsonResult({ topic, results });
      })
  );

  server.registerTool(
    'delete_messages',
    {
      title: 'Delete notifications',
      description:
        'Deletes notifications and cancels scheduled ones that have not been ' +
        'delivered yet. Requires a confirmation token: call once without it to ' +
        'receive the token, then again with it.\n\n' +
        '"Deleted" means subscribers are told to remove their copy. ntfy ' +
        'publishes a message_delete event and does **not** remove anything ' +
        'from its own cache, so list_messages and get_message still return the ' +
        'message afterwards, until it expires. Do not read that as the delete ' +
        'having failed, and do not delete again: the delete event is in the ' +
        'list too, alongside the message it refers to.\n\n' +
        'Needs ntfy 2.16.0 or newer. Against an older server every id comes ' +
        'back with ok:false inside a result that is not an error — check the ' +
        'per-id results rather than only whether the call succeeded.',
      annotations: {
        // Deleted notifications do not come back, and scheduled ones are not
        // sent. Idempotent: deleting the same ids twice leaves the same topic.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        sequence_ids: z
          .array(messageIdParam)
          .min(1)
          .max(MAX_IDS)
          .describe('Ids of the notifications to delete.'),
        topic: topicParam
          .optional()
          .describe('Their topic. Defaults to the first NTFY_TOPICS entry.'),
        confirm_token: confirmTokenParam.optional(),
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const topic = api.resolveTopic(args.topic);
        // Fingerprinted over the exact set, so a token issued for one id cannot
        // execute a longer list the model chose afterwards.
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what:
              `delete ${args.sequence_ids.length} notification(s) from topic ` +
              `"${topic}", including any that are still scheduled`,
            consequence:
              'Deleted notifications cannot be recovered, and scheduled ones will not be sent.',
            resourceKey: setResourceKey(
              'delete_messages',
              args.sequence_ids.map((id) => `${topic}/${id}`)
            ),
            token: args.confirm_token,
            toolName: 'delete_messages',
            title: `Delete ${args.sequence_ids.length} notification(s)?`,
            hint: 'Tick to go ahead, leave it to cancel.',
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(`The user declined. delete_messages did nothing.`);
        }
        if (outcome.decision === 'pending') return outcome.result;

        const results = [];
        for (const id of args.sequence_ids) {
          try {
            await api.delete(`/${topic}/${id}`);
            results.push({ id, ok: true });
          } catch (error) {
            results.push({
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return jsonResult({ topic, results });
      })
  );
}
