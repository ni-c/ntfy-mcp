import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, missingConfigKeys } from '../src/config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Turns `process.exit` into a throw so the tests can assert on it. */
function catchExit(): void {
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exited');
  }) as never);
}

describe('loadConfig', () => {
  it('starts without any configuration so tools stay listable', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const config = loadConfig({});
    expect(config.url).toBeUndefined();
    expect(config.credentials).toEqual({ kind: 'anonymous' });
    expect(missingConfigKeys(config)).toEqual(['NTFY_URL']);
  });

  it('treats missing credentials as a supported state, not an error', () => {
    // An open ntfy instance allows publishing and subscribing anonymously, so
    // only the URL is genuinely required.
    const config = loadConfig({ NTFY_URL: 'https://ntfy.example.net' });
    expect(missingConfigKeys(config)).toEqual([]);
    expect(config.credentials.kind).toBe('anonymous');
  });

  it('deletes the token from the environment after reading it', () => {
    const env = {
      NTFY_URL: 'https://ntfy.example.net',
      NTFY_TOKEN: 'tk_secret',
    };
    const config = loadConfig(env);
    expect(config.credentials).toEqual({ kind: 'token', token: 'tk_secret' });
    expect(env.NTFY_TOKEN).toBeUndefined();
  });

  it('deletes the password too, and before any early return', () => {
    // The URL is missing here, so loadConfig returns early. A delete placed
    // after that branch would leave the secret in the environment — the bug
    // this ordering exists to prevent.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = { NTFY_USERNAME: 'alice', NTFY_PASSWORD: 'hunter2' };
    loadConfig(env);
    expect(env.NTFY_PASSWORD).toBeUndefined();
  });

  it('reads basic auth credentials', () => {
    const config = loadConfig({
      NTFY_URL: 'https://ntfy.example.net',
      NTFY_USERNAME: 'alice',
      NTFY_PASSWORD: 'hunter2',
    });
    expect(config.credentials).toEqual({
      kind: 'basic',
      username: 'alice',
      password: 'hunter2',
    });
  });

  it('refuses a token and basic auth at the same time', () => {
    // Not a precedence rule: which credential is in force must never be
    // ambiguous.
    catchExit();
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(() =>
      loadConfig({
        NTFY_URL: 'https://ntfy.example.net',
        NTFY_TOKEN: 'tk_x',
        NTFY_USERNAME: 'alice',
        NTFY_PASSWORD: 'hunter2',
      })
    ).toThrow('exited');
    expect(errors.mock.calls.flat().join(' ')).toContain('pick one');
  });

  it('refuses a username without a password', () => {
    catchExit();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      loadConfig({
        NTFY_URL: 'https://ntfy.example.net',
        NTFY_USERNAME: 'alice',
      })
    ).toThrow('exited');
  });

  it('strips trailing slashes from the base URL', () => {
    const config = loadConfig({ NTFY_URL: 'https://ntfy.example.net///' });
    expect(config.url).toBe('https://ntfy.example.net');
  });

  it('rejects a URL containing credentials', () => {
    catchExit();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      loadConfig({ NTFY_URL: 'https://user:pw@ntfy.example.net' })
    ).toThrow('exited');
  });

  it('rejects a non-http scheme', () => {
    catchExit();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => loadConfig({ NTFY_URL: 'file:///etc/passwd' })).toThrow(
      'exited'
    );
  });

  it('does not echo the rejected URL', () => {
    // A mis-pasted token is exactly the kind of value that lands in NTFY_URL,
    // and this goes to a log.
    catchExit();
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(() => loadConfig({ NTFY_URL: 'tk_looks_like_a_token' })).toThrow(
      'exited'
    );
    expect(errors.mock.calls.flat().join(' ')).not.toContain(
      'tk_looks_like_a_token'
    );
  });

  it('warns about plain http to a remote host but keeps going', () => {
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const config = loadConfig({ NTFY_URL: 'http://ntfy.example.net' });
    expect(config.url).toBe('http://ntfy.example.net');
    expect(errors.mock.calls.flat().join(' ')).toMatch(/unencrypted/);
  });

  it('stays quiet about plain http to a loopback host', () => {
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    loadConfig({ NTFY_URL: 'http://127.0.0.1:8080' });
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/unencrypted/);
  });

  it('warns about anonymous writes against the public instance', () => {
    // The one shape where the blast radius is genuinely unbounded: knowing a
    // topic name is the whole of the access control on ntfy.sh.
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    loadConfig({ NTFY_URL: 'https://ntfy.sh' });
    expect(errors.mock.calls.flat().join(' ')).toContain('without credentials');
  });

  it('does not warn when those writes are restricted or authenticated', () => {
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    loadConfig({ NTFY_URL: 'https://ntfy.sh', NTFY_TOKEN: 'tk_x' });
    loadConfig({ NTFY_URL: 'https://ntfy.sh', NTFY_READ_ONLY: 'true' });
    expect(errors.mock.calls.flat().join(' ')).not.toContain(
      'without credentials'
    );
  });

  it('defaults to writes enabled', () => {
    // Deliberately the opposite of imap-mcp: ntfy exists to publish, and a
    // read-only default would ship a notification server that cannot notify.
    expect(loadConfig({ NTFY_URL: 'https://ntfy.example.net' }).readOnly).toBe(
      false
    );
  });

  it('only accepts the literal string "true" for read-only', () => {
    // Because the default is false, a typo leaves writes ON — the README says
    // so, and this is the assertion behind that sentence.
    for (const value of ['ture', 'TRUE', 'yes', '1', 'false']) {
      const config = loadConfig({
        NTFY_URL: 'https://ntfy.example.net',
        NTFY_READ_ONLY: value,
      });
      expect(config.readOnly, value).toBe(false);
    }
    expect(
      loadConfig({
        NTFY_URL: 'https://ntfy.example.net',
        NTFY_READ_ONLY: 'true',
      }).readOnly
    ).toBe(true);
  });

  it('parses the topic allowlist and keeps its order', () => {
    const config = loadConfig({
      NTFY_URL: 'https://ntfy.example.net',
      NTFY_TOPICS: ' deploys , alerts ,,',
    });
    expect(config.topics).toEqual(['deploys', 'alerts']);
  });

  it('rejects an invalid topic in the allowlist', () => {
    // Letting it through would produce the confusing failure later: ntfy serves
    // its web app for a path that is not a valid topic.
    catchExit();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      loadConfig({
        NTFY_URL: 'https://ntfy.example.net',
        NTFY_TOPICS: 'has.dot',
      })
    ).toThrow('exited');
  });
});
