import fc from 'fast-check';
import { orderedResourceKey, setResourceKey } from 'mcp-approval';
import { describe, expect, it } from 'vitest';

import {
  MAX_ITEM_BYTES,
  MAX_TAGS,
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
          const view = toView(
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
        const view = toView(message({ message: text }), { preview: true });
        if (text.length > PREVIEW_CHARS) {
          expect(view.message_truncated).toBe(true);
          expect(view.message).toHaveLength(PREVIEW_CHARS + 1);
        } else {
          expect(view.message).toBe(text);
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
          const view = toView(message({ tags }), { preview: false });
          expect(view.tags?.length ?? 0).toBeLessThanOrEqual(MAX_TAGS);
          if (tags.length > MAX_TAGS) expect(view.tags_truncated).toBe(true);
        }
      ),
      RUNS
    );
  });

  it('never throws on a message the publisher shaped freely', () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            title: fc.string(),
            message: fc.string(),
            click: fc.string(),
            icon: fc.string(),
            content_type: fc.string(),
            priority: fc.integer(),
            tags: fc.array(fc.string(), { maxLength: 40 }),
          },
          { requiredKeys: [] }
        ),
        (over) => {
          expect(() =>
            toView(message(over as Partial<NtfyMessage>), { preview: true })
          ).not.toThrow();
        }
      ),
      RUNS
    );
  });
});
