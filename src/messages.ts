import type { NtfyMessage } from './api.js';

/** Total response budget for a tool result, before the untrusted-data marker. */
export const MAX_RESULT_BYTES = 200_000;

/** How much of a message body `list_messages` shows per entry. */
export const PREVIEW_CHARS = 500;

/**
 * Per-field caps on the parts of a message a publisher controls but ntfy does
 * not bound.
 *
 * ntfy limits the message body to 4096 bytes, and rejects an oversized JSON
 * publish with `41303 JSON body too large`. It does not limit the title, the
 * tag list or the action list on the header form of the publish API: verified
 * against 2.19.2, where a 60 000-character `X-Title` was accepted and a single
 * poll of that topic returned 80 kB. Anyone who can publish to a topic can
 * therefore choose how much of the reader's context one notification occupies.
 */
export const MAX_FIELD_CHARS = 2000;
export const MAX_TAGS = 30;
export const MAX_ACTIONS_SHOWN = 3;

/**
 * Ceiling on a single rendered message. `actions` and `attachment` are
 * structured values rather than strings, so they get a size check instead of a
 * character cap.
 */
export const MAX_ITEM_BYTES = 16_000;

/**
 * Bounds one publisher-controlled string. Applied to every such field rather
 * than only the body: the body is the one field ntfy itself limits.
 */
function cap(value: string): string {
  return value.length > MAX_FIELD_CHARS
    ? `${value.slice(0, MAX_FIELD_CHARS)}… (truncated)`
    : value;
}

export interface MessageView {
  id: string;
  /** Set when this entry updates, clears or deletes an earlier notification. */
  updates?: string;
  event: string;
  topic: string;
  time: string;
  title?: string;
  message?: string;
  /** Only on a preview that was cut. */
  message_truncated?: true;
  /** Set when the publisher supplied more tags than are shown. */
  tags_truncated?: true;
  /** Set when action buttons or attachment metadata were dropped for size. */
  oversized?: true;
  priority?: number;
  tags?: string[];
  click?: string;
  icon?: string;
  actions?: unknown[];
  attachment?: unknown;
  content_type?: string;
}

/**
 * Reshapes a raw ntfy message for a tool result.
 *
 * `sequence_id` is renamed to `updates` because the raw name invites the wrong
 * reading. On the original publish ntfy omits the field entirely — the message's
 * own `id` is its sequence id — and it only appears on follow-up events, where
 * it points back at what they revise. Calling it `updates` says that.
 */
export function toView(
  message: NtfyMessage,
  options: { preview: boolean }
): MessageView {
  const view: MessageView = {
    id: message.id,
    event: message.event,
    topic: message.topic,
    time: new Date(message.time * 1000).toISOString(),
  };
  if (message.sequence_id !== undefined && message.sequence_id !== message.id) {
    view.updates = message.sequence_id;
  }
  if (message.title !== undefined) view.title = cap(message.title);
  if (message.message !== undefined) {
    if (options.preview && message.message.length > PREVIEW_CHARS) {
      view.message = `${message.message.slice(0, PREVIEW_CHARS)}…`;
      view.message_truncated = true;
    } else {
      view.message = message.message;
    }
  }
  if (message.priority !== undefined) view.priority = message.priority;
  if (message.tags !== undefined) {
    view.tags = message.tags.slice(0, MAX_TAGS).map(cap);
    if (message.tags.length > MAX_TAGS) view.tags_truncated = true;
  }
  if (message.click !== undefined) view.click = cap(message.click);
  if (message.icon !== undefined) view.icon = cap(message.icon);
  if (message.actions !== undefined) {
    view.actions = message.actions.slice(0, MAX_ACTIONS_SHOWN);
  }
  if (message.attachment !== undefined) view.attachment = message.attachment;
  if (message.content_type !== undefined) {
    view.content_type = cap(message.content_type);
  }

  // Last resort for the structured fields. Everything above is bounded by
  // construction; `actions` and `attachment` are arbitrary JSON from the
  // publisher, so they are measured and dropped rather than trimmed — a
  // half-serialized action object is worse than none.
  if (Buffer.byteLength(JSON.stringify(view), 'utf8') > MAX_ITEM_BYTES) {
    delete view.actions;
    delete view.attachment;
    view.oversized = true;
  }
  return view;
}

export interface MessageEnvelope {
  topics: readonly string[];
  count: number;
  /**
   * Cursor for the next call. `since=<id>` is exclusive, verified against
   * 2.19.2, so passing this back returns strictly newer messages.
   */
  next_since?: string;
  note?: string;
  dropped?: number;
  messages: MessageView[];
}

/**
 * Builds the envelope, dropping whole messages until it fits the budget.
 *
 * Truncating the serialized JSON instead would cut from the end, which is where
 * `next_since` lives — destroying the one field a caller needs to recover from
 * the truncation.
 */
export function buildEnvelope(
  topics: readonly string[],
  messages: NtfyMessage[],
  limit: number
): MessageEnvelope {
  const considered = messages.slice(-limit);
  const droppedByLimit = messages.length - considered.length;
  const last = messages[messages.length - 1];

  const envelope: MessageEnvelope = {
    topics,
    count: considered.length,
    messages: considered.map((message) => toView(message, { preview: true })),
  };
  if (last !== undefined) envelope.next_since = last.id;

  let dropped = droppedByLimit;
  // Oldest first, so what survives is the newest — which is what someone
  // polling a notification topic wants.
  //
  // The loop runs down to zero rather than stopping at one. Keeping the last
  // message unconditionally would leave the budget with an exception a
  // publisher can aim at: one notification carrying an oversized title or tag
  // list is exactly the shape that survives a "never drop the last one" rule.
  // The per-field caps in `cap` make that hard on its own; this makes it
  // impossible.
  while (
    envelope.messages.length > 0 &&
    Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_RESULT_BYTES
  ) {
    envelope.messages.shift();
    dropped += 1;
    envelope.count = envelope.messages.length;
  }

  if (dropped > 0) {
    envelope.dropped = dropped;
    envelope.note =
      `${dropped} older message(s) were left out. Narrow the request with ` +
      '"since", a filter, or fewer topics.';
  }
  return envelope;
}
