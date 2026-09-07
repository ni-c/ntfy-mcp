/**
 * The one place text from ntfy is made safe to hand on.
 *
 * Everything this server reports was written by somebody else: a notification's
 * title, body, tags and action buttons by whoever could publish to the topic —
 * on an open instance anyone who knows its name — and a username, a grant
 * pattern or a token label by whoever runs the instance. Bounding the length of
 * that text, which is all this server used to do, leaves two problems.
 *
 * **Control characters.** An escape sequence in a notification title is a
 * terminal control sequence in the host's log and in whatever renders the tool
 * result. They carry no meaning in any field here — ntfy's own web app shows
 * them as nothing — so they are removed rather than escaped.
 *
 * **Lone surrogates.** A half of a surrogate pair survives `JSON.stringify`,
 * which writes it back as an escape, so the wire stays valid JSON — and a client
 * that encodes the text to UTF-8 raises on it (Python: `UnicodeEncodeError:
 * surrogates not allowed`). One arrives either because a publisher sent it or
 * because a cut landed between the halves of a pair, which is why every cut in
 * this file is followed by `toWellFormed()`.
 *
 * What is deliberately kept: tab, line feed and carriage return, which are
 * content in a notification body; and the format characters (bidi marks, joiners
 * and the like), which are content in any text a person wrote.
 */

/**
 * The code point ranges removed: C0 without tab, LF and CR; DEL; and the C1
 * block, which is where a terminal reads a second family of escapes.
 *
 * Built from numbers at runtime rather than spelled as escapes inside a
 * character class. The editing tools used on this repository turn a
 * backslash-u escape in a source file into the raw byte it names — which makes
 * the file binary to git, and makes the pattern wrong in a way no diff shows.
 */
const CONTROL_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
];

const CONTROL = new RegExp(
  `[${CONTROL_RANGES.map(
    ([low, high]) =>
      `${String.fromCodePoint(low)}-${String.fromCodePoint(high)}`
  ).join('')}]`,
  'gu'
);

/** What a cut string says about itself. */
const CUT_NOTE = '… (truncated)';

/**
 * Removes what must not be passed on, and repairs what a cut may have broken.
 *
 * Linear: one `replace` with a character class and one `toWellFormed`, neither
 * of which backtracks.
 */
export function cleanText(value: string): string {
  return value.replace(CONTROL, '').toWellFormed();
}

/**
 * {@link cleanText} plus a ceiling, saying so when it cuts.
 *
 * The note is added after the cut and before `toWellFormed`, so a pair split by
 * the slice is repaired rather than carried out into the result.
 */
export function cleanCut(value: string, max: number): string {
  return cleanSlice(value, max, CUT_NOTE);
}

/**
 * {@link cleanCut} with a marker of the caller's choosing.
 *
 * A preview says it was cut in a field of its own (`message_truncated`), so the
 * ellipsis is all the text needs; a field with no such flag has to carry the
 * word. Both go through the same cut so that both are repaired after it.
 */
export function cleanSlice(value: string, max: number, marker: string): string {
  const cleaned = value.replace(CONTROL, '');
  return cleaned.length > max
    ? `${cleaned.slice(0, max)}${marker}`.toWellFormed()
    : cleaned.toWellFormed();
}

/** Ceiling on a message this server did not write, before it is quoted. */
const MAX_ERROR_TEXT = 2000;

/**
 * A thrown message on its way into a tool result.
 *
 * The generic `catch` of a tool handler receives more than this server's own
 * sentences: undici quotes a header value it refuses (which is the credential),
 * Node's TLS layer quotes the certificate's subject alternative names (chosen by
 * whatever answered on the port), and any library may quote a response it
 * disliked. Every one of those is somebody else's text arriving under this
 * server's voice.
 */
export function errorText(
  value: unknown,
  max: number = MAX_ERROR_TEXT
): string {
  const message = value instanceof Error ? value.message : String(value);
  return cleanCut(message, max);
}

/**
 * How deep {@link cleanDeep} descends, and how many values it will look at.
 *
 * A pass-through document — ntfy's `/v1/config`, `/v1/stats`, a tier definition,
 * a publisher's attachment metadata — is shaped by whoever sent it, so both the
 * depth and the node count are theirs to choose. Past either ceiling the value
 * is replaced by a sentence rather than partially cleaned: a document this
 * server cannot walk is one it cannot promise anything about.
 */
const MAX_DEPTH = 12;
const MAX_NODES = 20_000;

/** What replaces a document that is deeper or larger than the walk allows. */
export const TOO_DEEP = '(omitted: nested deeper than this server walks)';
export const TOO_MANY = '(omitted: more values than this server walks)';

/**
 * Cleans every string inside a JSON value this server merely passes through.
 *
 * Rebuilt with `Object.fromEntries` rather than assigned key by key. A key of
 * `__proto__` arrives as an own property from `JSON.parse`, and `copy[key] =
 * value` on a fresh object sets the prototype and drops the field instead —
 * silently, so nothing notices. ntfy's configuration document is a map whose
 * keys are the instance's, and a tag key in an attachment is a publisher's.
 *
 * Keys are cleaned as well as values: a key is text in the result too.
 */
export function cleanDeep(value: unknown): unknown {
  let budget = MAX_NODES;

  function walk(node: unknown, depth: number): unknown {
    if (budget <= 0) return TOO_MANY;
    budget -= 1;
    if (typeof node === 'string') return cleanText(node);
    if (node === null || typeof node !== 'object') return node;
    if (depth >= MAX_DEPTH) return TOO_DEEP;
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, entry]) => [
        cleanText(key),
        walk(entry, depth + 1),
      ])
    );
  }

  return walk(value, 0);
}
