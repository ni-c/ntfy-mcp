import { z } from 'zod';

import type { NtfyMessage } from './api.js';
import {
  arrayOf,
  finiteNumberOf,
  isRecord,
  stringOf,
  stringsOf,
  unixSecondsOf,
} from './boundary.js';
import { cleanCut, cleanDeep, cleanSlice } from './clean.js';
import { MAX_RESULT_BYTES } from './result.js';
import { anyJsonValue } from './schema.js';

export { MAX_RESULT_BYTES };

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
 * Bounds one publisher-controlled string, and removes what must not be passed
 * on at the same time.
 *
 * Applied to every such field rather than only the body: the body is the one
 * field ntfy itself limits, and it is not the one an escape sequence arrives in
 * most cheaply — a title is unbounded on the header form of the publish API.
 * The cut runs inside `cleanCut`, which repairs a surrogate pair the slice may
 * have split.
 */
function cap(value: string): string {
  return cleanCut(value, MAX_FIELD_CHARS);
}

/**
 * One notification, as this server reports it.
 *
 * The schema and not the interface is the definition, and `MessageView` is
 * derived from it. Two things are true at once here: this projection is what
 * `list_messages` and `get_message` advertise as their output schema, and it is
 * validated against the real answer before that answer goes out. A hand-written
 * interface next to a hand-written schema would drift, and the drift would
 * surface as a *failed tool call* rather than a type error — the SDK rejects a
 * result its schema does not accept.
 *
 * Everything a publisher controls is typed loosely on purpose. `actions` is
 * arbitrary JSON that ntfy neither validates nor bounds, so `z.unknown()`: a
 * publisher who sends `actions: ["oops"]` would otherwise take the tool down
 * rather than have their nonsense reported.
 */
export const messageView = z.object({
  id: z.string(),
  /** Set when this entry updates, clears or deletes an earlier notification. */
  updates: z.string().optional(),
  event: z.string(),
  topic: z.string(),
  /**
   * Optional, although ntfy sends it on every message: what arrives is whatever
   * answered, and a `time` that is a word or past the range `Date` holds has no
   * honest ISO rendering. Absent with `time_unavailable` beside it beats an
   * invented timestamp, and beats a `RangeError` that would take the whole
   * listing with it.
   */
  time: z
    .string()
    .optional()
    .describe('ISO 8601, converted from ntfy’s Unix seconds.'),
  /** Set when ntfy's timestamp was missing or outside the representable range. */
  time_unavailable: z.literal(true).optional(),
  title: z.string().optional(),
  message: z.string().optional(),
  /** Only on a preview that was cut. */
  message_truncated: z.literal(true).optional(),
  /** Set when the publisher supplied more tags than are shown. */
  tags_truncated: z.literal(true).optional(),
  /** Set when action buttons or attachment metadata were dropped for size. */
  oversized: z.literal(true).optional(),
  priority: z.number().optional(),
  tags: z.array(z.string()).optional(),
  click: z.string().optional(),
  icon: z.string().optional(),
  actions: z.array(anyJsonValue).optional(),
  attachment: anyJsonValue.optional(),
  content_type: z.string().optional(),
});

export type MessageView = z.infer<typeof messageView>;

/**
 * Reshapes a raw ntfy message for a tool result.
 *
 * Every field is read through `boundary.ts` rather than off the declared type.
 * `NtfyMessage` describes what ntfy 2.19.2 sends; what arrives is whatever
 * answered on the port, and for the fields a publisher chooses it is whoever
 * knew the topic name. Before this was so, `time: "later"` answered a
 * `RangeError` out of `toISOString()` and `tags: 7` a `TypeError` out of
 * `.slice` — each of them thrown from inside a `map` over a listing, so one
 * message made every other message in the answer unreachable.
 *
 * Answers `undefined` for a message with no usable id: an entry that cannot be
 * named cannot be fetched with `get_message`, marked read or deleted, and the
 * schema's `id` is not a field to invent a value for. The caller counts it.
 *
 * `sequence_id` is renamed to `updates` because the raw name invites the wrong
 * reading. On the original publish ntfy omits the field entirely — the message's
 * own `id` is its sequence id — and it only appears on follow-up events, where
 * it points back at what they revise. Calling it `updates` says that.
 */
export function toView(
  message: NtfyMessage,
  options: { preview: boolean }
): MessageView | undefined {
  const raw = message as unknown;
  if (!isRecord(raw)) return undefined;

  const id = stringOf(raw.id);
  if (id === undefined) return undefined;

  const view: MessageView = {
    id: cap(id),
    event: cap(stringOf(raw.event) ?? 'unknown'),
    topic: cap(stringOf(raw.topic) ?? '(unknown)'),
  };

  const seconds = unixSecondsOf(raw.time);
  if (seconds === undefined) {
    view.time_unavailable = true;
  } else {
    view.time = new Date(seconds * 1000).toISOString();
  }

  const sequence = stringOf(raw.sequence_id);
  if (sequence !== undefined && sequence !== id) view.updates = cap(sequence);

  const title = stringOf(raw.title);
  if (title !== undefined) view.title = cap(title);

  const body = stringOf(raw.message);
  if (body !== undefined) {
    if (options.preview && body.length > PREVIEW_CHARS) {
      // The ellipsis alone, not the "(truncated)" note `cap` adds: this cut is
      // already announced in a field of its own, one line below.
      view.message = cleanSlice(body, PREVIEW_CHARS, '\u2026');
      view.message_truncated = true;
    } else {
      view.message = cap(body);
    }
  }

  const priority = finiteNumberOf(raw.priority);
  if (priority !== undefined) view.priority = priority;

  if (raw.tags !== undefined) {
    const tags = stringsOf(raw.tags, MAX_TAGS);
    view.tags = tags.map(cap);
    if (arrayOf(raw.tags).length > MAX_TAGS) view.tags_truncated = true;
  }

  const click = stringOf(raw.click);
  if (click !== undefined) view.click = cap(click);
  const icon = stringOf(raw.icon);
  if (icon !== undefined) view.icon = cap(icon);

  if (raw.actions !== undefined) {
    // Cleaned as a document rather than as a string: an action is arbitrary
    // JSON, and its label, url and header values are all the publisher's text.
    view.actions = arrayOf(raw.actions)
      .slice(0, MAX_ACTIONS_SHOWN)
      .map((action) => cleanDeep(action));
  }
  if (raw.attachment !== undefined) {
    view.attachment = cleanDeep(raw.attachment);
  }

  const contentType = stringOf(raw.content_type);
  if (contentType !== undefined) view.content_type = cap(contentType);

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

/** What `list_messages` answers with. Derived, for the reason above. */
export const messageEnvelope = z.object({
  topics: z.array(z.string()),
  count: z.number().int(),
  /**
   * Cursor for the next call. `since=<id>` is exclusive, verified against
   * 2.19.2, so passing this back returns strictly newer messages.
   */
  next_since: z
    .string()
    .optional()
    .describe('Pass back as "since" to get only what arrived after this call.'),
  note: z.string().optional(),
  dropped: z
    .number()
    .int()
    .optional()
    .describe('Messages left out to stay inside the result budget.'),
  /** Entries ntfy sent that carried no usable id. Reported, never silent. */
  unreadable: z.number().int().optional(),
  messages: z.array(messageView),
});

export type MessageEnvelope = z.infer<typeof messageEnvelope>;

/**
 * Roughly what one entry costs in the rendered result, in bytes.
 *
 * An estimate rather than a measurement, and deliberately an over-estimate: the
 * entries all sit at the same depth of the envelope, so the indentation each one
 * gains is a constant this can add rather than something to serialise the whole
 * document to discover. What it buys is the number of *rounds* — the loop below
 * used to drop one entry and re-serialise everything to see whether that was
 * enough, which is the input's length times the input's size.
 */
function estimateEntryBytes(view: MessageView): number {
  return Buffer.byteLength(JSON.stringify(view, null, 2), 'utf8') + 8 * 12;
}

/**
 * Builds the envelope, dropping whole messages until it fits the budget.
 *
 * Truncating the serialized JSON instead would cut from the end, which is where
 * `next_since` lives — destroying the one field a caller needs to recover from
 * the truncation.
 *
 * `measure` is the size of the result **as it will be emitted**, which is not
 * the size of this object: the marker helper puts a sentence in front of the
 * JSON and serialises it indented, so the two differ by more than a fifth on a
 * full envelope. Measuring the value rather than the rendering is a ceiling on a
 * string nobody receives.
 */
export function buildEnvelope(
  topics: readonly string[],
  messages: NtfyMessage[],
  limit: number,
  measure: (value: Record<string, unknown>) => number
): MessageEnvelope {
  const considered = messages.slice(-limit);
  const droppedByLimit = messages.length - considered.length;
  const last = messages[messages.length - 1];

  const views: MessageView[] = [];
  let unreadable = 0;
  for (const message of considered) {
    const view = toView(message, { preview: true });
    if (view === undefined) {
      unreadable += 1;
      continue;
    }
    views.push(view);
  }

  const envelope: MessageEnvelope = {
    topics: [...topics],
    count: views.length,
    messages: views,
  };
  if (unreadable > 0) envelope.unreadable = unreadable;
  const lastId =
    last === undefined
      ? undefined
      : stringOf((last as unknown as Record<string, unknown>).id);
  if (lastId !== undefined) envelope.next_since = lastId;

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
  //
  // Two passes, not one loop: the estimate says how many entries have to go,
  // and only then is the rendering measured. The second loop is what makes the
  // ceiling true rather than likely, and on a normal answer it runs zero times.
  const sizes = envelope.messages.map(estimateEntryBytes);
  let estimated = sizes.reduce((sum, size) => sum + size, 0);
  let index = 0;
  while (index < sizes.length && estimated > MAX_RESULT_BYTES) {
    estimated -= sizes[index] as number;
    index += 1;
  }
  if (index > 0) {
    envelope.messages = envelope.messages.slice(index);
    dropped += index;
  }
  while (envelope.messages.length > 0 && measure(envelope) > MAX_RESULT_BYTES) {
    envelope.messages.shift();
    dropped += 1;
  }
  envelope.count = envelope.messages.length;

  if (dropped > 0) {
    envelope.dropped = dropped;
    envelope.note =
      `${dropped} older message(s) were left out. Narrow the request with ` +
      '"since", a filter, or fewer topics.';
  }
  if (unreadable > 0) {
    envelope.note =
      `${envelope.note ? `${envelope.note} ` : ''}${unreadable} entr(ies) ` +
      'ntfy returned carried no usable id and could not be reported.';
  }
  return envelope;
}
