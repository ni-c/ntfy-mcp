import type { NtfyMessage } from './api.js';

/** Total response budget for a tool result, before the untrusted-data marker. */
export const MAX_RESULT_BYTES = 200_000;

/** How much of a message body `list_messages` shows per entry. */
export const PREVIEW_CHARS = 500;

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
  if (message.title !== undefined) view.title = message.title;
  if (message.message !== undefined) {
    if (options.preview && message.message.length > PREVIEW_CHARS) {
      view.message = `${message.message.slice(0, PREVIEW_CHARS)}…`;
      view.message_truncated = true;
    } else {
      view.message = message.message;
    }
  }
  if (message.priority !== undefined) view.priority = message.priority;
  if (message.tags !== undefined) view.tags = message.tags;
  if (message.click !== undefined) view.click = message.click;
  if (message.icon !== undefined) view.icon = message.icon;
  if (message.actions !== undefined) view.actions = message.actions;
  if (message.attachment !== undefined) view.attachment = message.attachment;
  if (message.content_type !== undefined) {
    view.content_type = message.content_type;
  }
  return view;
}

export interface MessageEnvelope {
  topics: readonly string[];
  count: number;
  /**
   * Cursor for the next call. `since=<id>` is exclusive, verified against
   * 2.27.0, so passing this back returns strictly newer messages.
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
  while (
    envelope.messages.length > 1 &&
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
