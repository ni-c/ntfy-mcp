/**
 * What this server is willing to believe about ntfy's JSON.
 *
 * `JSON.parse(...) as NtfyMessage` is not a check, and an exported interface
 * with a docblock on every field reads like one. Everything below the parse is
 * whatever the instance sent: a proxy in front of it, a typo in `NTFY_URL`
 * landing on somebody else's server, a forked or newer ntfy — or, for the fields
 * a publisher chooses, anyone who knows a topic name.
 *
 * Two things go wrong when that is taken on trust, and they look different from
 * each other:
 *
 * - **A crash.** `message.tags.slice(...)` on a `tags` that is a number, or
 *   `new Date(time * 1000).toISOString()` on a `time` that is a word, throws out
 *   of the projection — and the projection runs per entry inside a listing, so
 *   one poisoned message takes the whole answer down.
 * - **A schema violation.** Every tool here declares an `outputSchema`, and the
 *   SDK validates the result against it before it goes out. An `id` that is a
 *   number is refused *after* the work is done, and the model is told
 *   "Output validation error" with no cause it can act on.
 *
 * The rule this file follows is that the schema is never the thing that gives
 * way. Each reader answers `undefined` for a value of the wrong shape, and the
 * caller then decides per field: omit it, skip the element, or say in a sentence
 * that it was unusable. A field that is absent is a shape the schemas already
 * describe; a field that is wrong is not.
 */

/** Whether a value is a plain JSON object rather than an array or `null`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record, or an empty one — for the endpoints where "nothing" is an answer. */
export function recordOr(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** An array, or an empty one. */
export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A string field, or `undefined`.
 *
 * Numbers and booleans are *not* accepted and stringified. A projection that
 * turns `title: 42` into `"42"` invents a title nobody wrote, and the shape that
 * matters here — an object where a name belongs — would come out as
 * `[object Object]`, which looks like a name.
 */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A number that survives being serialised and read back.
 *
 * `JSON.parse` turns `1e999` into `Infinity` and a missing field into `NaN`
 * after arithmetic; both are `typeof "number"`, and zod refuses both for a plain
 * `z.number()`. So finiteness is the boundary, not the schema's problem.
 */
export function finiteNumberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value + 0 // `-0` serialises as `0` in the text block and as `-0` in the
    : undefined; // structured half, which splits the two channels.
}

/**
 * The widest instant `Date` can hold, in seconds.
 *
 * `new Date(ms)` is invalid past ±8.64e15 milliseconds, and `toISOString()`
 * answers a `RangeError` rather than a value — which is thrown, not returned, so
 * it escapes the projection and fails the listing the message appeared in.
 */
const MAX_UNIX_SECONDS = 8.64e12;

/**
 * A Unix timestamp in seconds that `new Date(value * 1000)` will accept.
 *
 * Not `safeIntegerOf`: the safe-integer range is four orders of magnitude wider
 * than the range `Date` accepts, so the check that matters is the narrower one.
 */
export function unixSecondsOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.abs(value) <= MAX_UNIX_SECONDS ? value : undefined;
}

/**
 * The elements of an array that are strings, up to `max` of them.
 *
 * Holes are dropped rather than turned into `null`: a list of tags with a
 * `null` in it is a list of tags with one fewer tag, and reporting the hole as a
 * value would put it in front of the model as one.
 */
export function stringsOf(value: unknown, max: number): string[] {
  const out: string[] = [];
  for (const entry of arrayOf(value)) {
    if (out.length >= max) break;
    if (typeof entry === 'string') out.push(entry);
  }
  return out;
}
