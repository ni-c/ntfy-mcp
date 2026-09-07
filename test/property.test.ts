import fc from 'fast-check';
import { orderedResourceKey, setResourceKey } from 'mcp-approval';
import { describe, expect, it } from 'vitest';

import { cleanText } from '../src/clean.js';
import {
  MAX_ITEM_BYTES,
  MAX_TAGS,
  messageView,
  PREVIEW_CHARS,
  toView,
} from '../src/messages.js';

/**
 * Properties of the two places where an ordering or a budget is the control.
 *
 * `manage_user_access` and `update_message` build their confirmation keys with
 * `orderedResourceKey` from mcp-approval, chosen over `setResourceKey` for a
 * security argument: sorting the targets would make "grant alice read_only on
 * topic deploy" and "grant deploy read_only on topic alice" the same key, so a
 * confirmation approved for one account and topic would execute a grant on a
 * pair nobody was shown. The properties below are that argument, stated
 * against the library function the two tools now call — the local
 * `tupleResourceKey` they used to call is gone.
 *
 * `toView` shapes a message written by whoever could publish to the topic,
 * which on an open instance is anyone who knows its name. Its budgets are the
 * only thing between that and the model's context window.
 */

const RUNS = { numRuns: 500 };

/** Derived rather than imported: `messages.ts` keeps the type to itself. */
type NtfyMessage = Parameters<typeof toView>[0];

const part = fc.stringMatching(/^[a-z0-9]{1,12}$/);

/** `toView` accepts every message the generators below build: each has a string id. */
const project = (
  raw: NtfyMessage,
  options: { preview: boolean }
): NonNullable<ReturnType<typeof toView>> => {
  const result = toView(raw, options);
  if (result === undefined) throw new Error('toView refused a shaped message');
  return result;
};

describe('a confirmation key depends on the order of its targets', () => {
  /**
   * The property the docstring argues for. Two different tuples of the same
   * parts must never fingerprint the same, because the vocabularies overlap
   * almost entirely — a username is a legal topic, and every action name is a
   * legal value for either.
   */
  it('swapping two targets changes the key', () => {
    fc.assert(
      fc.property(part, part, part, (a, b, c) => {
        fc.pre(a !== b);
        expect(orderedResourceKey('manage_user_access', [a, b, c])).not.toBe(
          orderedResourceKey('manage_user_access', [b, a, c])
        );
      }),
      RUNS
    );
  });

  /**
   * The bug the choice prevents, shown rather than described: the set key
   * really does give the swapped pair the same fingerprint, so a tool that
   * used it on positional arguments would accept one token for both.
   */
  it('the set key would have collided on the swap; the ordered key does not', () => {
    fc.assert(
      fc.property(part, part, (topic, id) => {
        fc.pre(topic !== id);
        expect(setResourceKey('update_message', [topic, id])).toBe(
          setResourceKey('update_message', [id, topic])
        );
        expect(orderedResourceKey('update_message', [topic, id])).not.toBe(
          orderedResourceKey('update_message', [id, topic])
        );
      }),
      RUNS
    );
  });

  it('the same tuple always fingerprints the same', () => {
    fc.assert(
      fc.property(fc.array(part, { maxLength: 6 }), (parts) => {
        expect(orderedResourceKey('update_message', parts)).toBe(
          orderedResourceKey('update_message', [...parts])
        );
      }),
      RUNS
    );
  });

  /**
   * The operation is part of the identity too. A token approved for one tool
   * must not execute another, however alike their arguments look.
   */
  it('the same targets under a different operation give a different key', () => {
    fc.assert(
      fc.property(
        fc.array(part, { maxLength: 4 }),
        fc.stringMatching(/^[a-z_]{3,20}$/),
        fc.stringMatching(/^[a-z_]{3,20}$/),
        (parts, first, second) => {
          fc.pre(first !== second);
          expect(orderedResourceKey(first, parts)).not.toBe(
            orderedResourceKey(second, parts)
          );
        }
      ),
      RUNS
    );
  });

  /**
   * Joining cannot be forged. Two different tuples must not collide because
   * their parts concatenate to the same string — the reason each part carries
   * its index and the parts go through `JSON.stringify` rather than a
   * separator someone picks.
   */
  it('parts cannot be merged or split into a matching key', () => {
    fc.assert(
      fc.property(part, part, (a, b) => {
        expect(orderedResourceKey('op', [a, b])).not.toBe(
          orderedResourceKey('op', [`${a}${b}`])
        );
        expect(orderedResourceKey('op', [a, b])).not.toBe(
          orderedResourceKey('op', [a, '', b])
        );
      }),
      RUNS
    );
  });
});

describe('a message view stays inside its budgets', () => {
  const message = (over: Partial<NtfyMessage> = {}): NtfyMessage =>
    ({
      id: 'abc123',
      event: 'message',
      topic: 'deploy',
      time: 1_700_000_000,
      ...over,
    }) as NtfyMessage;

  it('never exceeds the per-item byte budget, whatever the publisher sent', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 4000 }),
        fc.array(fc.string({ maxLength: 200 }), { maxLength: 80 }),
        fc.array(fc.jsonValue(), { maxLength: 12 }),
        (text, tags, actions) => {
          const view = project(
            message({ message: text, tags, actions } as Partial<NtfyMessage>),
            { preview: false }
          );
          if (view.oversized !== true) {
            expect(
              Buffer.byteLength(JSON.stringify(view), 'utf8')
            ).toBeLessThanOrEqual(MAX_ITEM_BYTES);
          } else {
            // Dropped rather than trimmed: a half-serialised action object is
            // worse than none, so the view says so instead.
            expect(view.actions).toBeUndefined();
            expect(view.attachment).toBeUndefined();
          }
        }
      ),
      RUNS
    );
  });

  it('a preview is cut at the documented length and says that it was', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 3000 }), (text) => {
        const view = project(message({ message: text }), { preview: true });
        // Against the *cleaned* text, which is what the projection works on:
        // the removal of control characters happens before the cut, so a body
        // that is long only because of them is not a body that gets previewed.
        const cleaned = cleanText(text);
        if (text.length > PREVIEW_CHARS) {
          expect(view.message_truncated).toBe(true);
          expect(view.message).toHaveLength(PREVIEW_CHARS + 1);
        } else {
          expect(view.message).toBe(cleaned);
          expect(view.message_truncated).toBeUndefined();
        }
      }),
      RUNS
    );
  });

  it('tags are capped, and the cap is reported rather than hidden', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 40 }), { maxLength: 100 }),
        (tags) => {
          const view = project(message({ tags }), { preview: false });
          expect(view.tags?.length ?? 0).toBeLessThanOrEqual(MAX_TAGS);
          if (tags.length > MAX_TAGS) expect(view.tags_truncated).toBe(true);
        }
      ),
      RUNS
    );
  });

  /**
   * The generator is the test.
   *
   * This property used to draw its fields from `fc.string()`, `fc.integer()`
   * and `fc.array(fc.string())` — the types `NtfyMessage` declares — and was
   * green while `toView` threw a `RangeError` on `time: "later"` and a
   * `TypeError` on `tags: 7`. A generator that respects the declared types
   * cannot find a value of the wrong type, and its title claimed the opposite.
   *
   * So the leaves are arbitrary JSON now, plus the values `JSON.parse` can
   * produce that `fc.jsonValue()` does not reach: `Infinity` from `1e999`, a
   * number past the safe range, and a timestamp outside what `Date` holds.
   */
  const leaf = fc.oneof(
    fc.jsonValue(),
    fc.constantFrom(
      Infinity,
      -Infinity,
      Number.NaN,
      1e300,
      -(2 ** 53),
      8.64e12 + 1,
      -8.64e12 - 1,
      Number.MAX_SAFE_INTEGER
    ),
    fc.double(),
    fc.string({ maxLength: 200 })
  );

  it('never throws, whatever shape the instance sent', () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            id: leaf,
            sequence_id: leaf,
            event: leaf,
            topic: leaf,
            time: leaf,
            title: leaf,
            message: leaf,
            click: leaf,
            icon: leaf,
            content_type: leaf,
            priority: leaf,
            tags: leaf,
            actions: leaf,
            attachment: leaf,
          },
          { requiredKeys: [] }
        ),
        (over) => {
          expect(() =>
            toView(over as unknown as NtfyMessage, { preview: true })
          ).not.toThrow();
        }
      ),
      RUNS
    );
  });

  it('answers something the output schema accepts, or nothing at all', () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            id: leaf,
            event: leaf,
            topic: leaf,
            time: leaf,
            title: leaf,
            message: leaf,
            priority: leaf,
            tags: leaf,
            actions: leaf,
            attachment: leaf,
            content_type: leaf,
          },
          { requiredKeys: [] }
        ),
        (over) => {
          const view = toView(over as unknown as NtfyMessage, {
            preview: true,
          });
          // A refusal is a legitimate answer — an entry with no usable id has
          // no honest projection. What must never happen is a view the SDK
          // then refuses, which fails the whole tool call rather than the
          // entry.
          if (view === undefined) return;
          expect(messageView.safeParse(view).success).toBe(true);
        }
      ),
      RUNS
    );
  });
});
