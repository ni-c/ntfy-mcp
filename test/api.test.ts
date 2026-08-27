import { afterEach, describe, expect, it, vi } from 'vitest';

import { NtfyApi, NtfyApiError } from '../src/api.js';
import { stubFetch, testConfig } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('authentication', () => {
  it('sends a bearer token', async () => {
    const calls = stubFetch();
    await new NtfyApi(testConfig()).get('/v1/health');
    expect(calls[0]?.headers.Authorization).toBe(
      'Bearer tk_testtokentesttokentesttoken'
    );
  });

  it('sends basic auth when that is configured', async () => {
    const calls = stubFetch();
    await new NtfyApi(
      testConfig({
        credentials: { kind: 'basic', username: 'alice', password: 'hunter2' },
      })
    ).get('/v1/health');
    const expected = Buffer.from('alice:hunter2').toString('base64');
    expect(calls[0]?.headers.Authorization).toBe(`Basic ${expected}`);
  });

  it('sends no header at all when anonymous', async () => {
    // Not an empty bearer: an open instance treats a malformed header as no
    // credentials anyway, but sending one invites the auth rate limit.
    const calls = stubFetch();
    await new NtfyApi(testConfig({ credentials: { kind: 'anonymous' } })).get(
      '/v1/health'
    );
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });
});

describe('request hardening', () => {
  it('never follows a redirect', async () => {
    // Following one would resend the credentials to whatever host the upstream
    // named.
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return new Response('{}', {
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    await new NtfyApi(testConfig()).get('/v1/health');
    expect(calls[0]?.redirect).toBe('error');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails with the setup message when the URL is missing', async () => {
    stubFetch();
    await expect(
      new NtfyApi(testConfig({ url: undefined })).get('/v1/health')
    ).rejects.toThrow(/NTFY_URL/);
  });

  it('carries ntfy’s five-digit code on the error', async () => {
    // The HTTP status is not enough: 429 alone covers eleven distinct limits.
    stubFetch(
      () =>
        new Response('{"code":40301,"http":403,"error":"forbidden"}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
    );
    const error = await new NtfyApi(testConfig())
      .get('/alerts/auth')
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NtfyApiError);
    expect((error as NtfyApiError).code).toBe(40301);
    expect((error as NtfyApiError).status).toBe(403);
  });

  it('survives an error body that is not JSON', async () => {
    stubFetch(() => new Response('<html>gateway</html>', { status: 502 }));
    const error = await new NtfyApi(testConfig())
      .get('/v1/health')
      .catch((thrown: unknown) => thrown);
    expect((error as NtfyApiError).code).toBeUndefined();
  });

  it('caps a response body while reading it', async () => {
    // `await response.text()` is unbounded, and content-length is absent on the
    // chunked NDJSON stream, so the limit has to be counted as it arrives.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(1_000_000));
              },
            }),
            { headers: { 'content-type': 'application/x-ndjson' } }
          )
      )
    );
    await expect(
      new NtfyApi(testConfig()).poll(['alerts'], { since: 'all' })
    ).rejects.toThrow(/more than/);
  });
});

describe('poll', () => {
  it('always sends poll=1', async () => {
    const calls = stubFetch(
      () =>
        new Response('', {
          headers: { 'content-type': 'application/x-ndjson' },
        })
    );
    await new NtfyApi(testConfig()).poll(['alerts'], { since: '24h' });
    expect(calls[0]?.url).toContain('poll=1');
  });

  it('parses one object per line and ignores blank lines', async () => {
    stubFetch(
      () =>
        new Response(
          '{"id":"a","time":1,"event":"message","topic":"t"}\n\n' +
            '{"id":"b","time":2,"event":"message","topic":"t"}\n',
          { headers: { 'content-type': 'application/x-ndjson' } }
        )
    );
    const messages = await new NtfyApi(testConfig()).poll(['t'], {
      since: 'all',
    });
    expect(messages.map((message) => message.id)).toEqual(['a', 'b']);
  });

  it('raises the error rather than parsing an error page as messages', async () => {
    // A path that is not a valid topic reaches ntfy's web app and comes back as
    // HTML with status 200; a bad `since` comes back as JSON with status 400.
    stubFetch(
      () =>
        new Response('{"code":40008,"http":400}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
    );
    await expect(
      new NtfyApi(testConfig()).poll(['t'], { since: 'nonsense' })
    ).rejects.toBeInstanceOf(NtfyApiError);
  });
});

describe('resolveTopic', () => {
  it('falls back to the first configured topic', () => {
    const api = new NtfyApi(testConfig({ topics: ['deploys', 'alerts'] }));
    expect(api.resolveTopic(undefined)).toBe('deploys');
  });

  it('refuses a topic outside the allowlist', () => {
    const api = new NtfyApi(testConfig({ topics: ['deploys'] }));
    expect(() => api.resolveTopic('other')).toThrow(/not in NTFY_TOPICS/);
  });

  it('does not name the other topics in the refusal', () => {
    // Listing them would hand out exactly the secret the allowlist protects.
    const api = new NtfyApi(testConfig({ topics: ['deploys', 'private-x'] }));
    expect(() => api.resolveTopic('other')).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('private-x') as unknown as string,
      }) as unknown as Error
    );
  });

  it('allows anything when the allowlist is unset', () => {
    const api = new NtfyApi(testConfig({ topics: [] }));
    expect(api.resolveTopic('anything')).toBe('anything');
    expect(() => api.resolveTopic(undefined)).toThrow(/no topic given/);
  });
});

describe('account caching', () => {
  it('reuses the answer within the cache window', async () => {
    const calls = stubFetch(() => ({ username: 'alice', role: 'admin' }));
    const api = new NtfyApi(testConfig());
    await api.account();
    await api.account();
    expect(calls).toHaveLength(1);
  });
});
