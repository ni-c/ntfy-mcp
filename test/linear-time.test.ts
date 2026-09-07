import { describe, expect, it, vi } from 'vitest';

import { cleanCut, cleanDeep, cleanText } from '../src/clean.js';
import { loadConfig } from '../src/config.js';
import { buildEnvelope, type MessageView } from '../src/messages.js';
import { untrustedBytes } from '../src/result.js';
import type { NtfyMessage } from '../src/api.js';

/**
 * What an input can buy, timed at the ceiling the code actually accepts.
 *
 * Every number below is measured against the largest value that can reach the
 * function — computed from the schema or the read cap, not guessed — and the
 * threshold is deliberately generous, because what these tests catch is a
 * *curve*, not a millisecond. A quadratic pass at 80 000 characters is seconds;
 * a linear one is single-digit milliseconds, and no plausible machine puts the
 * two within an order of magnitude of the bound.
 *
 * The one that was real: `url.replace(/\/+$/, '')` on `NTFY_URL`, 122 ms at
 * 20 000 slashes, 577 ms at 40 000 and 2233 ms at 80 000 — the pattern retried
 * from every position of the run, consuming it each time. The trigger has to be
 * `run + one character the pattern rejects`; a run at the end of the string
 * matches at position 0 in no time at all and reads as "held".
 */
const BUDGET_MS = 250;

function timed(what: string, run: () => void): number {
  const started = process.hrtime.bigint();
  run();
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  if (elapsed > BUDGET_MS) {
    throw new Error(`${what} took ${elapsed.toFixed(0)} ms, past ${BUDGET_MS}`);
  }
  return elapsed;
}

describe('the operator-supplied URL', () => {
  it('strips a long run of trailing slashes in linear time', () => {
    // The run is followed by a character the pattern rejects, which is what
    // makes every start position get tried. Without the trailing "api" this
    // probe passes against the old quadratic code and proves nothing.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const length of [20_000, 40_000, 80_000]) {
      const url = `https://ntfy.example.net/${'/'.repeat(length)}api`;
      timed(`${length} slashes`, () => {
        loadConfig({ NTFY_URL: url });
      });
    }
    vi.restoreAllMocks();
  });
});

describe('the cleaner', () => {
  /** The read cap: no single string from ntfy can be longer than this. */
  const CEILING = 2_000_000;

  it('cleans a body at the read ceiling in linear time', () => {
    const escape = String.fromCharCode(0x1b);
    for (const value of [
      'x'.repeat(CEILING),
      escape.repeat(CEILING),
      `${escape}x`.repeat(CEILING / 2),
      String.fromCharCode(0xd800).repeat(CEILING),
    ]) {
      timed('cleanText', () => {
        cleanText(value);
      });
    }
  });

  it('cuts a body at the read ceiling in linear time', () => {
    timed('cleanCut', () => {
      cleanCut('x'.repeat(CEILING), 2000);
    });
  });

  it('walks a wide document without paying per level', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 15_000 }, (_u, index) => [`k${index}`, `v${index}`])
    );
    timed('cleanDeep', () => {
      cleanDeep(wide);
    });
  });
});

const message = (index: number): NtfyMessage =>
  ({
    id: `id${String(index).padStart(10, '0')}`,
    time: 1_787_820_062,
    event: 'message',
    topic: 'alerts',
    title: 'T'.repeat(2000),
    message: 'm'.repeat(2000),
    tags: Array.from({ length: 30 }, () => 'g'.repeat(60)),
  }) as unknown as NtfyMessage;

describe('the result budget', () => {
  it('shrinks a full listing without re-serialising once per entry', () => {
    // The shape this replaced: drop one message, serialise the whole envelope,
    // ask again — the input's length times the input's size. 200 entries at the
    // per-item ceiling is the worst case the schema's `limit` allows.
    const messages = Array.from({ length: 200 }, (_u, index) => message(index));
    const elapsed = timed('buildEnvelope', () => {
      buildEnvelope(['alerts'], messages, 200, untrustedBytes);
    });
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('and still fits, which is the property the rounds were buying', () => {
    const messages = Array.from({ length: 200 }, (_u, index) => message(index));
    const envelope = buildEnvelope(['alerts'], messages, 200, untrustedBytes);
    expect(
      untrustedBytes(envelope as unknown as Record<string, unknown>)
    ).toBeLessThanOrEqual(200_000);
    // Dropped from the front, so what survives is the newest.
    const kept = envelope.messages as MessageView[];
    expect(kept[kept.length - 1]?.id).toBe('id0000000199');
  });
});
