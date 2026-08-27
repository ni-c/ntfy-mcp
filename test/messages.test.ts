import { describe, expect, it } from 'vitest';

import type { NtfyMessage } from '../src/api.js';
import {
  buildEnvelope,
  MAX_FIELD_CHARS,
  MAX_ITEM_BYTES,
  MAX_RESULT_BYTES,
  MAX_TAGS,
  PREVIEW_CHARS,
  toView,
} from '../src/messages.js';

function message(overrides: Partial<NtfyMessage> = {}): NtfyMessage {
  return {
    id: 'XGe5RN8RdcGO',
    time: 1787820062,
    event: 'message',
    topic: 'alerts',
    message: 'disk full',
    ...overrides,
  };
}

describe('toView', () => {
  it('renders the timestamp as something readable', () => {
    expect(toView(message(), { preview: false }).time).toBe(
      '2026-08-27T08:41:02.000Z'
    );
  });

  it('omits "updates" on an original publish', () => {
    // ntfy leaves sequence_id out there — the message's own id *is* its
    // sequence id — and reporting `updates: <own id>` would read as a message
    // revising itself.
    expect(toView(message(), { preview: false }).updates).toBeUndefined();
    expect(
      toView(message({ sequence_id: 'XGe5RN8RdcGO' }), { preview: false })
        .updates
    ).toBeUndefined();
  });

  it('reports "updates" on a revision', () => {
    expect(
      toView(message({ id: 'bbbbbbbbbbbb', sequence_id: 'aaaaaaaaaaaa' }), {
        preview: false,
      }).updates
    ).toBe('aaaaaaaaaaaa');
  });

  it('previews a long body and says it did', () => {
    const view = toView(message({ message: 'x'.repeat(PREVIEW_CHARS + 10) }), {
      preview: true,
    });
    expect(view.message_truncated).toBe(true);
    expect(view.message).toHaveLength(PREVIEW_CHARS + 1);
  });

  it('leaves the body intact when not previewing', () => {
    const body = 'x'.repeat(PREVIEW_CHARS + 10);
    const view = toView(message({ message: body }), { preview: false });
    expect(view.message).toBe(body);
    expect(view.message_truncated).toBeUndefined();
  });
});

describe('buildEnvelope', () => {
  it('keeps the newest messages when the limit bites', () => {
    const messages = Array.from({ length: 10 }, (_unused, index) =>
      message({ id: `id${String(index).padStart(9, '0')}` })
    );
    const envelope = buildEnvelope(['alerts'], messages, 3);
    expect(envelope.count).toBe(3);
    expect(envelope.messages.map((view) => view.id)).toEqual([
      'id000000007',
      'id000000008',
      'id000000009',
    ]);
    expect(envelope.dropped).toBe(7);
    expect(envelope.note).toContain('left out');
  });

  it('reports the newest id as the cursor even when messages were dropped', () => {
    // The cursor has to describe what the *server* has, not what survived the
    // budget, or the next call would replay everything that was cut.
    const messages = Array.from({ length: 5 }, (_unused, index) =>
      message({ id: `id${String(index).padStart(9, '0')}` })
    );
    const envelope = buildEnvelope(['alerts'], messages, 2);
    expect(envelope.next_since).toBe('id000000004');
  });

  it('drops whole messages rather than cutting the JSON', () => {
    // Truncating the serialized string would cut from the end, which is where
    // next_since lives — destroying the one field needed to recover.
    const messages = Array.from({ length: 400 }, (_unused, index) =>
      message({
        id: `id${String(index).padStart(9, '0')}`,
        title: 'T'.repeat(MAX_FIELD_CHARS),
        tags: Array.from({ length: MAX_TAGS }, () => 'g'.repeat(60)),
      })
    );
    const envelope = buildEnvelope(['alerts'], messages, 400);
    const size = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    expect(size).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(envelope.next_since).toBe('id000000399');
    expect(envelope.dropped).toBeGreaterThan(0);
    // Still valid JSON with an intact envelope, which is the whole point.
    expect(() => JSON.parse(JSON.stringify(envelope)) as unknown).not.toThrow();
  });

  it('cannot be blown past the budget by a single crafted message', () => {
    // The interesting case for a publisher: one notification, so a
    // "never drop the last one" rule would have to keep it whatever its size.
    // The per-item cap is what actually stops this — the envelope loop's
    // `> 0` bound is a backstop behind it, not the mechanism.
    const huge = message({
      title: 'T'.repeat(200_000),
      tags: Array.from({ length: 10_000 }, () => 'g'.repeat(200)),
      actions: [{ blob: 'x'.repeat(MAX_RESULT_BYTES * 2) }],
    });
    const envelope = buildEnvelope(['alerts'], [huge], 50);
    expect(
      Buffer.byteLength(JSON.stringify(envelope), 'utf8')
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    // Still usable: the cursor survives and the caller is told what was cut.
    expect(envelope.next_since).toBe(huge.id);
    expect(envelope.messages[0]?.oversized).toBe(true);
    expect(envelope.messages[0]?.tags_truncated).toBe(true);
  });

  it('says nothing about truncation when nothing was truncated', () => {
    const envelope = buildEnvelope(['alerts'], [message()], 50);
    expect(envelope.dropped).toBeUndefined();
    expect(envelope.note).toBeUndefined();
  });

  it('handles an empty result', () => {
    const envelope = buildEnvelope(['alerts'], [], 50);
    expect(envelope.count).toBe(0);
    expect(envelope.next_since).toBeUndefined();
  });

  it('caps the fields ntfy itself does not bound', () => {
    // ntfy limits the message body to 4096 bytes and rejects an oversized JSON
    // publish — but a 60 000-character title goes straight through the header
    // form of the publish API, verified against 2.27.0.
    const view = toView(
      message({
        title: 'T'.repeat(100_000),
        tags: Array.from({ length: 5000 }, (_u, i) => `tag-${i}`),
        click: `https://example.net/${'p'.repeat(100_000)}`,
      }),
      { preview: false }
    );
    expect(view.title?.length).toBeLessThan(MAX_FIELD_CHARS + 20);
    expect(view.tags).toHaveLength(MAX_TAGS);
    expect(view.tags_truncated).toBe(true);
    expect(view.click?.length).toBeLessThan(MAX_FIELD_CHARS + 20);
  });

  it('drops structured fields it cannot trim, and says so', () => {
    const view = toView(
      message({ actions: [{ body: 'x'.repeat(MAX_ITEM_BYTES * 2) }] }),
      { preview: false }
    );
    expect(view.actions).toBeUndefined();
    expect(view.oversized).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBeLessThan(
      MAX_ITEM_BYTES
    );
  });

  it('leaves an ordinary message untouched', () => {
    const view = toView(
      message({ title: 'Deploy', tags: ['rocket'], actions: [{ a: 1 }] }),
      { preview: false }
    );
    expect(view.title).toBe('Deploy');
    expect(view.tags).toEqual(['rocket']);
    expect(view.actions).toEqual([{ a: 1 }]);
    expect(view.oversized).toBeUndefined();
    expect(view.tags_truncated).toBeUndefined();
  });
});
