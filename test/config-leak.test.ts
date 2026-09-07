import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';

const NEWLINE = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Everything `loadConfig` prints, for one environment.
 *
 * stderr is the MCP client's log file, so a value printed here is a value
 * written to disk — which is the destination that makes this worth checking at
 * all.
 */
function diagnostics(env: Record<string, string>): {
  lines: string[];
  exited: boolean;
} {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exited');
  });
  let exited = false;
  try {
    loadConfig({ ...env });
  } catch {
    exited = true;
  }
  return { lines, exited };
}

/** The shapes a secret pasted into the wrong variable actually has. */
const SECRETS = [
  ['a JWT', `eyJhbGciOiJIUzI1NiJ9.${'e'.repeat(80)}.${'s'.repeat(43)}`],
  ['a hex key', 'a3f9'.repeat(14)],
  ['a base64 secret', `${'QUJDREVG'.repeat(6)}==`],
  ['an ntfy token', `tk_${'a'.repeat(29)}`],
] as const;

describe('a value in the wrong variable is never printed back', () => {
  for (const [what, secret] of SECRETS) {
    it(`ELICITATION does not echo ${what}`, () => {
      const { lines, exited } = diagnostics({
        NTFY_URL: 'https://ntfy.example.net',
        ELICITATION: secret,
      });
      expect(exited).toBe(true);
      expect(lines.join('\n')).not.toContain(secret.slice(0, 20));
    });

    it(`NTFY_URL does not echo ${what}`, () => {
      // The value that fails `new URL()` is the one most likely to be a
      // secret, so the branch written for an operator's typo is exactly the
      // branch a secret reaches.
      const { lines, exited } = diagnostics({ NTFY_URL: secret });
      expect(exited).toBe(true);
      expect(lines.join('\n')).not.toContain(secret.slice(0, 20));
    });
  }

  it('does not print the scheme, which a key with a colon after it is', () => {
    // `<56 hex characters>:` parses as a URL whose *scheme* is the key, so the
    // "must use http:// or https://" branch had it in full.
    const key = 'a3f9'.repeat(14);
    const { lines, exited } = diagnostics({ NTFY_URL: `${key}:8080` });
    expect(exited).toBe(true);
    expect(lines.join('\n')).not.toContain(key.slice(0, 20));
    expect(lines.join('\n')).toContain('not shown');
  });

  it('still quotes a short, word-shaped value, which is the useful case', () => {
    // The point of the message is to show an operator their typo. Describing
    // `off` by its length would be safe and useless.
    const { lines } = diagnostics({
      NTFY_URL: 'https://ntfy.example.net',
      ELICITATION: 'off',
    });
    expect(lines.join('\n')).toContain('"off"');
  });
});

describe('a credential that cannot travel in a header is refused at startup', () => {
  const base = { NTFY_URL: 'https://ntfy.example.net' };

  it('refuses a token with a line break in the middle', () => {
    const token = `tk_${'a'.repeat(20)}${NEWLINE}${'b'.repeat(20)}`;
    const { lines, exited } = diagnostics({ ...base, NTFY_TOKEN: token });
    expect(exited).toBe(true);
    const message = lines.join('\n');
    expect(message).toContain('NTFY_TOKEN');
    expect(message).toContain('position 24');
    expect(message).toContain('not shown');
    expect(message).not.toContain('aaaaaaaaaa');
  });

  it('refuses a password with a tab in it', () => {
    const { lines, exited } = diagnostics({
      ...base,
      NTFY_USERNAME: 'alice',
      NTFY_PASSWORD: `secret${TAB}word`,
    });
    expect(exited).toBe(true);
    expect(lines.join('\n')).toContain('NTFY_PASSWORD');
    expect(lines.join('\n')).not.toContain('secret');
  });

  it('trims a trailing newline rather than refusing it', () => {
    // `$(cat token)` leaves one, and reading that as a broken credential would
    // be pedantic about the one case with an obvious correct reading.
    const config = loadConfig({
      ...base,
      NTFY_TOKEN: `tk_${'a'.repeat(29)}${NEWLINE}`,
    });
    expect(config.credentials).toEqual({
      kind: 'token',
      token: `tk_${'a'.repeat(29)}`,
    });
  });

  it('accepts an ordinary token', () => {
    const config = loadConfig({ ...base, NTFY_TOKEN: `tk_${'a'.repeat(29)}` });
    expect(config.credentials.kind).toBe('token');
  });
});

describe('the base URL is stored as something a path can be appended to', () => {
  it('keeps origin and path, and says what it dropped', () => {
    const { lines } = diagnostics({
      NTFY_URL: 'https://ntfy.example.net/base/?token=secret123456789#frag',
    });
    const config = loadConfig({
      NTFY_URL: 'https://ntfy.example.net/base/?token=secret123456789#frag',
    });
    expect(config.url).toBe('https://ntfy.example.net/base');
    expect(lines.join('\n')).toContain('a query string and a fragment');
    // Named, not quoted: a query string is where a token lives.
    expect(lines.join('\n')).not.toContain('secret123456789');
  });

  it('strips trailing slashes without a quadratic regex', () => {
    const config = loadConfig({
      NTFY_URL: `https://ntfy.example.net${'/'.repeat(5000)}`,
    });
    expect(config.url).toBe('https://ntfy.example.net');
  });
});

describe('NTFY_TOPICS has a ceiling on how many topics it names', () => {
  it('refuses a list longer than the server will walk', () => {
    const { lines, exited } = diagnostics({
      NTFY_URL: 'https://ntfy.example.net',
      NTFY_TOPICS: Array.from({ length: 300 }, (_u, i) => `t${i}`).join(','),
    });
    expect(exited).toBe(true);
    expect(lines.join('\n')).toContain('accepts up to 256');
  });

  it('accepts a list a person would actually write', () => {
    expect(
      loadConfig({
        NTFY_URL: 'https://ntfy.example.net',
        NTFY_TOPICS: 'alerts,deploys',
      }).topics
    ).toEqual(['alerts', 'deploys']);
  });
});
