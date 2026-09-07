import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertHeaderValue, NtfyApi } from '../src/api.js';
import { MAX_RESULT_BYTES, untrustedBytes } from '../src/result.js';
import { connect, ndjson, testConfig } from './harness.js';

const NEWLINE = String.fromCharCode(10);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * The credential, on its way into the model's context.
 *
 * undici's message for a header value it refuses **quotes the value**, and the
 * value here is `Bearer <the ntfy token>`. That message is an ordinary rejected
 * promise, which the tool handler's generic catch turns into a tool result. A
 * token with a line break in the middle — a wrapped paste, or `$(cat token)` of
 * a wrapped file — is all it takes.
 */
describe('the credential never reaches an error message', () => {
  const token = `tk_${'A'.repeat(20)}${NEWLINE}SECRETTAIL${'B'.repeat(20)}`;

  it('the request is refused before the runtime can quote it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const api = new NtfyApi(
      testConfig({ credentials: { kind: 'token', token } })
    );
    await expect(api.get('/v1/account')).rejects.toThrow(
      /not allowed in one, at position/
    );
    // Never sent: the check is in front of `fetch`, not a repair after it.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('and the message that comes back carries none of it', async () => {
    const harness = await connect({ credentials: { kind: 'token', token } });
    const text = harness.text(await harness.call('get_account'));
    expect(text).not.toContain('SECRETTAIL');
    expect(text).not.toContain('AAAAAAAAAA');
    expect(text).toContain('not shown');
  });

  it('the same for a basic-auth password', async () => {
    // Base64 hides a line break, so this one travels — which is why the check
    // is on the header value rather than on the password: whatever the encoding
    // does, the thing that must be legal is the header.
    const harness = await connect({
      credentials: { kind: 'basic', username: 'u', password: `p${NEWLINE}w` },
    });
    const text = harness.text(await harness.call('get_account'));
    expect(text).not.toContain(`p${NEWLINE}w`);
  });

  it('names the position without showing the value', () => {
    expect(() =>
      assertHeaderValue('Authorization', `Bearer a${NEWLINE}b`)
    ).toThrow(/position 9 of 10/);
    expect(() =>
      assertHeaderValue('Authorization', `Bearer a${NEWLINE}b`)
    ).not.toThrow(/Bearer a/);
  });

  it('lets an ordinary token through', () => {
    expect(() =>
      assertHeaderValue('Authorization', 'Bearer tk_abcdef0123456789')
    ).not.toThrow();
  });
});

/**
 * ntfy counts failed logins per address, not per account.
 *
 * `maybeAuthenticate` (server/server_auth.go) spends a token of the visitor's
 * `authLimiter` on every 401 it answers, and once the bucket is empty
 * `AuthAllowed()` is false and **every** request from that address is answered
 * with 42909 — healthy traffic included. Every read tool here is annotated
 * read-only, idempotent and cheap, and answers a bad credential with "Check
 * NTFY_TOKEN", which is exactly what a model retries.
 */
const unauthorized = (): Response =>
  new Response(JSON.stringify({ code: 40101, error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });

describe('a refused credential is not sent again straight away', () => {
  it('repeats the refusal from memory instead of asking again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const harness = await connect({ topics: ['alerts'] }, unauthorized);
    const first = await harness.call('list_messages');
    expect(first.isError).toBe(true);
    expect(harness.calls).toHaveLength(1);

    const second = await harness.call('list_messages');
    expect(second.isError).toBe(true);
    // The number that matters: one request, not two.
    expect(harness.calls).toHaveLength(1);
    expect(harness.text(second)).toContain('repeated from memory');
    expect(harness.text(second)).toContain('Next real attempt possible in');
  });

  it('tries again once the cooldown has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const harness = await connect({ topics: ['alerts'] }, unauthorized);
    await harness.call('list_messages');
    vi.advanceTimersByTime(11_000);
    await harness.call('list_messages');
    expect(harness.calls).toHaveLength(2);
  });

  it('does not remember a 403, which is a per-topic answer', async () => {
    // ntfy's limiter counts *authentication* failures. A 403 is the account
    // existing and not being permitted on this topic, which costs the limiter
    // nothing — and check_topic_access exists to report exactly that, one line
    // per topic.
    vi.useFakeTimers({ toFake: ['Date'] });
    const harness = await connect(
      { topics: ['a', 'b', 'c'] },
      () =>
        new Response(JSON.stringify({ code: 40301, error: 'forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
    );
    const result = await harness.call('check_topic_access', {
      topics: ['a', 'b', 'c'],
    });
    expect(harness.calls).toHaveLength(3);
    const structured = result.structuredContent as {
      results: { topic: string; read_access: boolean }[];
    };
    expect(structured.results).toHaveLength(3);
    expect(structured.results.every((entry) => !entry.read_access)).toBe(true);
  });
});

/**
 * The status decides before the body is read.
 *
 * Reading first meant the *success* ceiling could answer for an error: a
 * reverse proxy answering a 401 with a two-megabyte login page surfaced as
 * "ntfy returned more than 2000000 bytes", thrown as a plain Error from inside
 * the reader — no status, so no typed error, so no hint, no admin note, and
 * nothing for check_topic_access to report per topic.
 */
const hugeError = (status: number): Response =>
  new Response('x'.repeat(3_000_000), {
    status,
    headers: { 'content-type': 'text/plain' },
  });

describe('an oversized error body does not eat the status', () => {
  it('a 401 behind a huge body is still a 401', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => hugeError(401));
    const text = harness.text(await harness.call('list_messages'));
    expect(text).toContain('HTTP 401');
    expect(text).toContain('Check NTFY_TOKEN');
    expect(text).not.toContain('more than 2000000 bytes');
  });

  it('a 401 on an admin route still explains the admin role', async () => {
    const harness = await connect({}, () => hugeError(401));
    expect(harness.text(await harness.call('list_users'))).toContain(
      'role "admin"'
    );
  });

  it('check_topic_access reports the topic instead of losing the call', async () => {
    const harness = await connect({ topics: ['a', 'b'] }, () => hugeError(403));
    const result = await harness.call('check_topic_access', {
      topics: ['a', 'b'],
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { results: unknown[] };
    expect(structured.results).toHaveLength(2);
  });

  it('the quoted body is cut to its own, much smaller ceiling', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => hugeError(500));
    const text = harness.text(await harness.call('list_messages'));
    expect(text.length).toBeLessThan(10_000);
  });

  it('a success body past the ceiling is still refused', async () => {
    // The other half: the read cap is a real cap, and only the *error* path
    // was ever the problem.
    const harness = await connect(
      { topics: ['alerts'] },
      () =>
        new Response('x'.repeat(3_000_000), {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        })
    );
    expect(harness.text(await harness.call('list_messages'))).toContain(
      'more than 2000000 bytes'
    );
  });
});

/** The budget is a budget on the string the caller receives. */
const bigMessage = (index: number): Record<string, unknown> => ({
  id: `id${String(index).padStart(10, '0')}`,
  time: 1_787_820_062,
  event: 'message',
  topic: 'alerts',
  title: 'T'.repeat(2000),
  message: 'm'.repeat(2000),
  tags: Array.from({ length: 30 }, () => 'g'.repeat(60)),
});

describe('every answer stays inside the result budget as emitted', () => {
  it('list_messages measures the rendering, not the value', async () => {
    const harness = await connect({ topics: ['alerts'] }, () =>
      ndjson(Array.from({ length: 200 }, (_unused, index) => bigMessage(index)))
    );
    const result = await harness.call('list_messages');
    const emitted = Buffer.byteLength(harness.text(result), 'utf8');
    expect(emitted).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(
      untrustedBytes(result.structuredContent as Record<string, unknown>)
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES + 200);
  });

  it('list_users drops whole accounts rather than answering with megabytes', async () => {
    const harness = await connect({}, () =>
      Array.from({ length: 500 }, (_unused, index) => ({
        username: `u${index}${'n'.repeat(150)}`,
        role: 'user',
        grants: Array.from({ length: 20 }, (_g, gi) => ({
          topic: `t${gi}`,
          permission: 'read-write',
        })),
      }))
    );
    const result = await harness.call('list_users', { limit: 500 });
    expect(result.isError).toBeFalsy();
    expect(Buffer.byteLength(harness.text(result), 'utf8')).toBeLessThanOrEqual(
      MAX_RESULT_BYTES
    );
    expect(harness.text(result)).toContain('result budget');
  });

  it('get_server_info reports an oversized section instead of sending it', async () => {
    const harness = await connect({}, (request) =>
      request.url.includes('/v1/config') ? { blob: 'x'.repeat(500_000) } : {}
    );
    const result = await harness.call('get_server_info');
    expect(result.isError).toBeFalsy();
    expect(harness.text(result)).toContain('past the');
    expect(Buffer.byteLength(harness.text(result), 'utf8')).toBeLessThanOrEqual(
      MAX_RESULT_BYTES
    );
  });

  it('get_account bounds the counters it passes through whole', async () => {
    const harness = await connect({}, () => ({
      username: 'me',
      role: 'user',
      stats: { blob: 'x'.repeat(500_000) },
    }));
    const result = await harness.call('get_account');
    expect(result.isError).toBeFalsy();
    expect(Buffer.byteLength(harness.text(result), 'utf8')).toBeLessThanOrEqual(
      MAX_RESULT_BYTES
    );
  });

  it('get_message honours the same ceiling as the listing', async () => {
    const harness = await connect({ topics: ['alerts'] }, () =>
      ndjson([
        {
          ...bigMessage(1),
          id: 'XGe5RN8RdcGO',
          message: 'm'.repeat(300_000),
        },
      ])
    );
    const result = await harness.call('get_message', { id: 'XGe5RN8RdcGO' });
    expect(Buffer.byteLength(harness.text(result), 'utf8')).toBeLessThanOrEqual(
      MAX_RESULT_BYTES
    );
  });
});
