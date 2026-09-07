import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The one code path that weakens TLS, which had no test.
 *
 * `vi.mock` is hoisted above the imports, so undici's `fetch` is replaced before
 * `api.ts` binds it. What is asserted is not "the switch works" but the
 * containment: the relaxed dispatcher is used **only** under the switch, and the
 * default path does not touch undici's fetch at all.
 */
const undiciMock = vi.hoisted(() => ({
  fetch: vi.fn(),
  Agent: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: undiciMock.fetch,
  Agent: class {
    public readonly options: unknown;
    constructor(options: unknown) {
      this.options = options;
      undiciMock.Agent(options);
    }
  },
}));

const { NtfyApi } = await import('../src/api.js');
const { testConfig } = await import('./harness.js');

afterEach(() => {
  vi.unstubAllGlobals();
  undiciMock.fetch.mockReset();
  undiciMock.Agent.mockReset();
});

function jsonResponse(): Response {
  return new Response('{}', {
    headers: { 'content-type': 'application/json' },
  });
}

describe('NTFY_INSECURE_TLS', () => {
  it('is not built at all when the switch is off', () => {
    const globalFetch = vi.fn(async () => jsonResponse());
    vi.stubGlobal('fetch', globalFetch);
    const api = new NtfyApi(testConfig({ insecureTls: false }));
    expect(api).toBeDefined();
    expect(undiciMock.Agent).not.toHaveBeenCalled();
  });

  it('sends through the global fetch, with no dispatcher, when off', async () => {
    const globalFetch = vi.fn(async (_url: unknown, _init?: unknown) =>
      jsonResponse()
    );
    vi.stubGlobal('fetch', globalFetch);
    const api = new NtfyApi(testConfig({ insecureTls: false }));
    await api.get('/v1/health');
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(undiciMock.fetch).not.toHaveBeenCalled();
    const init = globalFetch.mock.calls[0]?.[1] as
      Record<string, unknown> | undefined;
    expect(init?.dispatcher).toBeUndefined();
  });

  it('scopes the relaxed validation to a dispatcher when on', async () => {
    // Scoped rather than NODE_TLS_REJECT_UNAUTHORIZED, which would weaken every
    // TLS connection the process makes, including ones this server knows
    // nothing about.
    const globalFetch = vi.fn(async () => jsonResponse());
    vi.stubGlobal('fetch', globalFetch);
    undiciMock.fetch.mockResolvedValue(jsonResponse());

    const insecure = new NtfyApi(testConfig({ insecureTls: true }));
    expect(undiciMock.Agent).toHaveBeenCalledWith({
      connect: { rejectUnauthorized: false },
    });

    await insecure.get('/v1/health');
    expect(undiciMock.fetch).toHaveBeenCalledTimes(1);
    // The global fetch is not used on this path, so nothing can fall back to it
    // and quietly lose the dispatcher.
    expect(globalFetch).not.toHaveBeenCalled();
    const init = undiciMock.fetch.mock.calls[0]?.[1] as
      Record<string, unknown> | undefined;
    expect(init?.dispatcher).toBeDefined();
  });

  it('still refuses to follow a redirect with the credential attached', async () => {
    undiciMock.fetch.mockResolvedValue(jsonResponse());
    const api = new NtfyApi(testConfig({ insecureTls: true }));
    await api.get('/v1/health');
    const init = undiciMock.fetch.mock.calls[0]?.[1] as
      Record<string, unknown> | undefined;
    expect(init?.redirect).toBe('error');
  });

  it('still checks the header value before sending on this path too', async () => {
    undiciMock.fetch.mockResolvedValue(jsonResponse());
    const api = new NtfyApi(
      testConfig({
        insecureTls: true,
        credentials: { kind: 'token', token: `a${String.fromCharCode(10)}b` },
      })
    );
    await expect(api.get('/v1/health')).rejects.toThrow('not shown');
    expect(undiciMock.fetch).not.toHaveBeenCalled();
  });
});
