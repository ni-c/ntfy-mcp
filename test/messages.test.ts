import { describe, expect, it } from 'vitest';

import type { NtfyMessage } from '../src/api.js';
import {
  buildEnvelope,
  MAX_RESULT_BYTES,
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
    //
    // The bulk is in `tags` rather than the body on purpose: bodies are already
    // previewed down to PREVIEW_CHARS, so the byte budget is a backstop for the
    // fields that are *not* shortened — tags, actions and attachment metadata,
    // all of which a publisher controls.
    const manyTags = Array.from({ length: 2000 }, (_unused, i) => `tag-${i}`);
    const messages = Array.from({ length: 40 }, (_unused, index) =>
      message({ id: `id${String(index).padStart(9, '0')}`, tags: manyTags })
    );
    const envelope = buildEnvelope(['alerts'], messages, 40);
    const size = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    expect(size).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(envelope.next_since).toBe('id000000039');
    expect(envelope.dropped).toBeGreaterThan(0);
    // Still valid JSON with an intact envelope, which is the whole point.
    expect(() => JSON.parse(JSON.stringify(envelope)) as unknown).not.toThrow();
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
});
