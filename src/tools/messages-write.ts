import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { orderedResourceKey, setResourceKey } from 'mcp-approval';
import type {
  Approver,
  ConfirmationDetail,
  ConfirmationStore,
} from 'mcp-approval';
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

import type { NtfyApi } from '../api.js';
import { recordOr, stringOf } from '../boundary.js';
import { errorText } from '../clean.js';
import { errorResult, jsonResult, run } from '../result.js';

const MAX_TOPICS = 10;
const MAX_IDS = 25;

/**
 * What the two per-id tools answer with.
 *
 * `ok` per entry rather than one verdict for the call, because both tools need
 * ntfy 2.16 and an older server refuses every id inside a result that is not an
 * error. The schema puts that in front of a reader who never got as far as the
 * description.
 */
const perIdOutcome = z.object({
  topic: z.string(),
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean().describe('Check this per entry, not the call.'),
      error: z.string().optional(),
    })
  ),
});

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

/**
 * Describes what a call will write, for the person being asked.
 *
 * Lengths and counts rather than the text itself. `renderDetails` puts each
 * line under "supplied by the caller" precisely because these are not the
 * server's words — and a notification body is somewhere between a sentence and
 * four kilobytes, which is not a dialog line either way. What the person needs
 * in order to answer is which fields change, not their contents; what the
 * *token* needs is the exact values, and that is the key below.
 */
function contentDetails(body: Record<string, unknown>): ConfirmationDetail[] {
  const details: ConfirmationDetail[] = [];
  for (const [field, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      details.push({ label: field, value: `${value.length} characters` });
    } else if (Array.isArray(value)) {
      details.push({ label: field, value: `${value.length} entr(ies)` });
    } else {
      details.push({ label: field, value: JSON.stringify(value) ?? 'set' });
    }
  }
  return details;
}

/**
 * The content a call will write, as one part of its confirmation key.
 *
 * Stable because {@link contentBody} assigns the fields in a fixed order, so
 * the same arguments always serialise identically — the property test holds
 * that. One part rather than one per field: `orderedResourceKey` prefixes each
 * part with its index, and a JSON document is delimited by construction, so
 * nothing here can be split or merged into a matching key.
 */
function contentFingerprint(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

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
      outputSchema: z.object({
        published: z.number().int().describe('Topics that accepted it.'),
        failed: z.number().int().describe('Topics that refused it.'),
        results: z.array(
          z.object({
            topic: z.string(),
            ok: z.boolean().describe('Check this per entry, not the call.'),
            id: z.string().optional(),
            sequence_id: z
              .string()
              .optional()
              .describe('Pass to update_message to revise this notification.'),
            note: z
              .string()
              .optional()
              .describe('Set when the publish worked but the id did not.'),
            error: z.string().optional(),
          })
        ),
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
            const published = await api.publish({ ...base, topic });
            // `id` and `sequence_id` are declared `z.string()`, so an instance
            // answering with a number would fail the whole result *after* the
            // notification has gone out — the one moment when losing the answer
            // costs something that cannot be retried safely. Omitted with a
            // note instead: the publish happened either way.
            const id = stringOf(recordOr(published).id);
            results.push(
              id === undefined
                ? {
                    topic,
                    ok: true,
                    note:
                      'Published, but ntfy did not return a usable message ' +
                      'id, so this notification cannot be updated or deleted ' +
                      'by id.',
                  }
                : { topic, ok: true, id, sequence_id: id }
            );
          } catch (error) {
            results.push({ topic, ok: false, error: errorText(error, 500) });
          }
        }

        const failed = results.filter((entry) => !entry.ok).length;
        return jsonResult(
          {
            published: results.length - failed,
            failed,
            results,
          },
          'publish_message'
        );
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
        'receiving two, that is why — check get_server_info for the version.\n\n' +
        'Asks a person first; where the client cannot show a dialog, call once ' +
        'to receive a token and again with it.',
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
        confirm_token: confirmTokenParam.optional(),
      }),
      outputSchema: z.object({
        topic: z.string(),
        updated: z.string().describe('The sequence id that was revised.'),
        revision_id: z
          .string()
          .optional()
          .describe('Id of the revision entry the cache now also holds.'),
        note: z
          .string()
          .optional()
          .describe('Set when the revision landed but the id did not.'),
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const topic = api.resolveTopic(args.topic);
        const body = contentBody(args);
        if (Object.keys(body).length === 0) {
          return errorResult('Provide at least one field to change.');
        }

        // Gated like delete_messages, and for the same reason rather than by
        // analogy: from ntfy 2.16 this replaces the notification *on the
        // subscribers' devices*, so the text they were shown is gone with no
        // copy anywhere but this server's cache. It also carries the whole
        // content schema, which includes `actions` — an "http" button fires
        // from the recipient's phone with a method, headers and body chosen
        // here. Turning a delivered alert into a button that calls something is
        // not what publish_message's unguarded outbound-effect argument covers.
        //
        // orderedResourceKey, not setResourceKey: a topic name and a message id
        // are both letters and digits, so a sorted key would give (topic, id)
        // and (id, topic) the same fingerprint and let a confirmation for one
        // execute the pair the other way round. The ids in delete_messages
        // really are a set, which is why that tool stays on setResourceKey.
        //
        // The content **is** in the key, and this used to be argued the other
        // way: binding it means a person is asked again for every corrected
        // typo, and the replacement is only reachable through the same tool
        // call anyway. What that argument missed is the gap between the two
        // legs of the fallback token. The first call is answered with a token
        // bound to (topic, id); the second call presents that token with
        // whatever content it likes — so a confirmation obtained for "fix the
        // typo in the deploy alert" executed a call that added an `http` action
        // button, which fires from the recipient's phone with a method, headers
        // and body chosen here. The dialog names the fields (`details`, so the
        // caller's values are on their own labelled lines rather than in this
        // server's sentence) and the key binds them.
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what:
              `replace the content of notification "${args.sequence_id}" on ` +
              `topic "${topic}"`,
            consequence:
              'Subscribers who already received it see it change in place, ' +
              'and the text they were shown is not recoverable. Everything ' +
              'listed below is replaced, action buttons included — an "http" ' +
              "button fires from the recipient's device.",
            details: contentDetails(body),
            resourceKey: orderedResourceKey('update_message', [
              topic,
              args.sequence_id,
              contentFingerprint(body),
            ]),
            token: args.confirm_token,
            toolName: 'update_message',
            title: 'Revise this notification?',
            hint: 'Tick to go ahead, leave it to cancel.',
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult('The user declined. update_message did nothing.');
        }
        if (outcome.decision === 'pending') return outcome.result;

        const updated = await api.publish({
          ...body,
          topic,
          sequence_id: args.sequence_id,
        });
        const revisionId = stringOf(recordOr(updated).id);
        return jsonResult(
          {
            topic,
            updated: args.sequence_id,
            // Optional in the schema for the same reason as in
            // `publish_message`: the revision is applied by the time this is
            // read, so an id ntfy sent in an unexpected shape must not turn a
            // completed write into a failed call.
            ...(revisionId === undefined
              ? {
                  note:
                    'The revision was applied, but ntfy did not return a ' +
                    'usable id for the revision entry.',
                }
              : { revision_id: revisionId }),
          },
          'update_message'
        );
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
      outputSchema: perIdOutcome,
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
              error: errorText(error, 500),
            });
          }
        }
        return jsonResult({ topic, results }, 'per-id');
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
      outputSchema: perIdOutcome,
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
              error: errorText(error, 500),
            });
          }
        }
        return jsonResult({ topic, results }, 'per-id');
      })
  );
}
