import { describe, expect, it } from 'vitest';

import {
  cleanCut,
  cleanDeep,
  cleanText,
  errorText,
  TOO_DEEP,
  TOO_MANY,
} from '../src/clean.js';
import { connect, ndjson } from './harness.js';

/**
 * The characters are built at runtime rather than spelled out.
 *
 * Two reasons, both learned the hard way in this family of repositories: the
 * editing tools turn a backslash-u escape in a file into the raw byte it names,
 * which makes the file binary to git and invisible in every diff afterwards;
 * and a shell refuses a command containing one outright, so a probe cannot be
 * typed either.
 */
const ESC = String.fromCharCode(0x1b);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);
const LONE_SURROGATE = String.fromCharCode(0xd800);

describe('cleanText', () => {
  it('removes the escapes a terminal would act on', () => {
    expect(cleanText(`before${ESC}[31mafter`)).toBe('before[31mafter');
    expect(cleanText(`a${NUL}b${DEL}c`)).toBe('abc');
  });

  it('keeps tab, line feed and carriage return, which are content', () => {
    expect(cleanText('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('keeps format characters, which are content in text a person wrote', () => {
    const rtl = String.fromCodePoint(0x202e);
    expect(cleanText(`a${rtl}b`)).toContain(rtl);
  });

  it('replaces a lone surrogate, which no client can encode', () => {
    // It survives JSON.stringify as an escape — so the wire stays valid JSON
    // and a Python client raises UnicodeEncodeError on the way out.
    const cleaned = cleanText(`a${LONE_SURROGATE}b`);
    expect(cleaned).toBe(`a�b`);
    expect(cleaned.isWellFormed()).toBe(true);
  });
});

describe('cleanCut', () => {
  it('repairs a pair the cut itself split', () => {
    // The cut is the *likelier* source of a lone surrogate than the publisher:
    // an emoji is two UTF-16 units and a ceiling lands between them sooner or
    // later.
    const emoji = String.fromCodePoint(0x1f600);
    const value = `${'a'.repeat(9)}${emoji}${'b'.repeat(100)}`;
    const cut = cleanCut(value, 10);
    expect(cut.isWellFormed()).toBe(true);
  });

  it('says that it cut', () => {
    expect(cleanCut('x'.repeat(50), 10)).toContain('truncated');
  });

  it('does not count removed characters towards the ceiling', () => {
    expect(cleanCut(ESC.repeat(100), 10)).toBe('');
  });
});

describe('errorText', () => {
  it('cleans and cuts what a library wrote', () => {
    expect(errorText(new Error(`boom${ESC}[2J`))).toBe('boom[2J');
    expect(errorText(new Error('x'.repeat(5000)))).toContain('truncated');
  });

  it('survives a thrown value that is not an Error', () => {
    expect(errorText({ toString: () => 'weird' })).toBe('weird');
    expect(errorText(null)).toBe('null');
  });
});

describe('cleanDeep', () => {
  it('keeps an own __proto__ key instead of losing it to the prototype', () => {
    // `copy[key] = value` on a fresh object sets the prototype and drops the
    // field, with no error — so a key ntfy chose vanishes and nothing notices.
    const parsed: unknown = JSON.parse('{"__proto__": "x", "keep": "y"}');
    const cleaned = cleanDeep(parsed) as Record<string, unknown>;
    expect(Object.hasOwn(cleaned, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype);
    expect(cleaned.keep).toBe('y');
  });

  it('cleans keys as well as values', () => {
    const cleaned = cleanDeep({ [`a${ESC}b`]: `c${ESC}d` }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(cleaned)).toEqual(['ab']);
    expect(cleaned.ab).toBe('cd');
  });

  it('refuses a document deeper than it walks, rather than half-cleaning it', () => {
    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 40; depth += 1) nested = { nested };
    expect(JSON.stringify(cleanDeep(nested))).toContain(TOO_DEEP);
  });

  it('refuses a document with more values than it walks', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 30_000 }, (_unused, index) => [`k${index}`, 'v'])
    );
    expect(JSON.stringify(cleanDeep(wide))).toContain(TOO_MANY);
  });
});

describe('the cleaner runs on what a publisher actually sends', () => {
  it('strips an escape sequence out of a notification title', async () => {
    const harness = await connect({ topics: ['alerts'] }, () =>
      ndjson([
        {
          id: 'XGe5RN8RdcGO',
          time: 1_787_820_062,
          event: 'message',
          topic: 'alerts',
          title: `deploy${ESC}[2Jdone`,
          message: `body${NUL}here`,
          tags: [`tag${ESC}x`],
        },
      ])
    );
    const result = await harness.call('list_messages');
    const text = harness.text(result);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(NUL);
    expect(text).toContain('deploy[2Jdone');
  });

  it('strips one out of an action button, which is arbitrary JSON', async () => {
    const harness = await connect({ topics: ['alerts'] }, () =>
      ndjson([
        {
          id: 'XGe5RN8RdcGO',
          time: 1_787_820_062,
          event: 'message',
          topic: 'alerts',
          actions: [
            { label: `press${ESC}[2J`, url: 'https://example.invalid' },
          ],
        },
      ])
    );
    expect(harness.text(await harness.call('list_messages'))).not.toContain(
      ESC
    );
  });

  it('strips one out of a username, which whoever signed up chose', async () => {
    const harness = await connect({}, () => [
      { username: `alice${ESC}[2J`, role: 'user', grants: [] },
    ]);
    expect(harness.text(await harness.call('list_users'))).not.toContain(ESC);
  });

  it("strips one out of the instance's own configuration document", async () => {
    const harness = await connect({}, (request) =>
      request.url.includes('/v1/config')
        ? { base_url: `https://example.invalid${ESC}[2J` }
        : {}
    );
    expect(harness.text(await harness.call('get_server_info'))).not.toContain(
      ESC
    );
  });

  it('strips one out of an error body ntfy sent', async () => {
    const harness = await connect(
      { topics: ['alerts'] },
      () =>
        new Response(JSON.stringify({ error: `nope${ESC}[2J`, code: 40301 }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
    );
    expect(harness.text(await harness.call('list_messages'))).not.toContain(
      ESC
    );
  });
});
