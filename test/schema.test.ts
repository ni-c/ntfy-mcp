import { describe, expect, it } from 'vitest';

import {
  actionSchema,
  delayParam,
  httpUrl,
  MAX_MESSAGE_BYTES,
  messageBody,
  messageIdParam,
  safeFilename,
  sinceParam,
  tagParam,
  topicParam,
  topicPatternParam,
} from '../src/schema.js';

describe('topicParam', () => {
  it('accepts the characters ntfy allows', () => {
    for (const topic of ['alerts', 'my-topic_2', 'A', 'a'.repeat(64)]) {
      expect(topicParam.safeParse(topic).success, topic).toBe(true);
    }
  });

  it('rejects a dot, which is the dangerous one', () => {
    // ntfy does not answer 400 for `/has.dot/json`: the path misses its topic
    // route and falls through to the static handler, so the response is the web
    // app's HTML with status 200. Without this check that page is what the model
    // would be handed.
    expect(topicParam.safeParse('has.dot').success).toBe(false);
  });

  it('rejects slashes, spaces, wildcards and overlong names', () => {
    for (const topic of ['a/b', 'a b', 'alerts*', '', 'a'.repeat(65)]) {
      expect(topicParam.safeParse(topic).success, topic).toBe(false);
    }
  });

  it('explains the rule rather than showing a regex', () => {
    const result = topicParam.safeParse('has.dot');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('no dots');
    }
  });
});

describe('topicPatternParam', () => {
  it('allows a wildcard, which a publish topic must not', () => {
    expect(topicPatternParam.safeParse('deploy*').success).toBe(true);
    expect(topicParam.safeParse('deploy*').success).toBe(false);
  });

  it('still rejects a dot or a slash', () => {
    expect(topicPatternParam.safeParse('a.b').success).toBe(false);
    expect(topicPatternParam.safeParse('a/b').success).toBe(false);
  });
});

describe('httpUrl', () => {
  it('rejects the schemes zod’s own .url() accepts', () => {
    // Verified against ntfy 2.27.0: it stored `javascript:alert(1)` as a click
    // value without comment. The URL is then handed to the recipient's phone
    // and to the web app, so this guard is the only thing standing there.
    for (const value of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'ftp://example.net/x',
    ]) {
      expect(httpUrl.safeParse(value).success, value).toBe(false);
    }
  });

  it('accepts http and https', () => {
    expect(httpUrl.safeParse('https://example.net/x').success).toBe(true);
    expect(httpUrl.safeParse('http://example.net/x').success).toBe(true);
  });

  it('accepts a private address on purpose', () => {
    // An `http` action button firing at a local device is the intended use for
    // home automation, and the request never leaves the recipient's network —
    // so this is deliberately not an SSRF guard.
    expect(httpUrl.safeParse('http://192.168.1.1/api/light').success).toBe(
      true
    );
  });

  it('rejects a relative URL', () => {
    expect(httpUrl.safeParse('/relative').success).toBe(false);
  });
});

describe('messageBody', () => {
  it('counts bytes, not characters', () => {
    // `.max(4096)` measures UTF-16 code units, so 4096 emoji — about 16 kB on
    // the wire — would pass it and then be rejected by the server with a
    // message about attachments.
    const emoji = '\u{1F600}'.repeat(2000);
    expect(emoji.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(emoji, 'utf8')).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(messageBody.safeParse(emoji).success).toBe(false);
  });

  it('accepts a body exactly at the limit', () => {
    expect(messageBody.safeParse('x'.repeat(MAX_MESSAGE_BYTES)).success).toBe(
      true
    );
    expect(
      messageBody.safeParse('x'.repeat(MAX_MESSAGE_BYTES + 1)).success
    ).toBe(false);
  });

  it('says bytes, not characters, in the message', () => {
    const result = messageBody.safeParse('x'.repeat(MAX_MESSAGE_BYTES + 1));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('bytes');
      expect(result.error.issues[0]?.message).toContain('not');
    }
  });
});

describe('tagParam', () => {
  it('refuses a comma-joined list passed as one tag', () => {
    // The mistake a model makes after seeing ntfy's header form. ntfy itself
    // would accept it as a single absurd tag.
    const result = tagParam.safeParse('warning,skull');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('separate array');
    }
  });

  it('accepts a plain tag', () => {
    expect(tagParam.safeParse('warning').success).toBe(true);
  });
});

describe('sinceParam', () => {
  it('accepts every grammar ntfy documents', () => {
    for (const value of [
      'all',
      'latest',
      'none',
      'XGe5RN8RdcGO',
      '1787820062',
      '30m',
      '24h',
      '7d',
    ]) {
      expect(sinceParam.safeParse(value).success, value).toBe(true);
    }
  });

  it('rejects anything else, and lists the alternatives', () => {
    const result = sinceParam.safeParse('yesterday');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('"latest"');
    }
  });
});

describe('delayParam', () => {
  it('range-checks a duration locally', () => {
    // ntfy answers "too small, please refer to the docs"; naming the bound is
    // more use than relaying that.
    expect(delayParam.safeParse('5s').success).toBe(false);
    expect(delayParam.safeParse('10s').success).toBe(true);
    expect(delayParam.safeParse('3d').success).toBe(true);
    expect(delayParam.safeParse('4d').success).toBe(false);
  });

  it('passes natural language through for the server to judge', () => {
    expect(delayParam.safeParse('tomorrow, 10am').success).toBe(true);
  });
});

describe('actionSchema', () => {
  it('requires the fields each action type actually needs', () => {
    expect(
      actionSchema.safeParse({ action: 'view', label: 'Open' }).success
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        action: 'view',
        label: 'Open',
        url: 'https://example.net',
      }).success
    ).toBe(true);
    expect(
      actionSchema.safeParse({ action: 'copy', label: 'Copy' }).success
    ).toBe(false);
    expect(
      actionSchema.safeParse({ action: 'copy', label: 'Copy', value: 'x' })
        .success
    ).toBe(true);
  });

  it('guards the url of an http action too', () => {
    // This one is the sharpest: the request fires from the recipient's device
    // with a caller-chosen method and body.
    expect(
      actionSchema.safeParse({
        action: 'http',
        label: 'Go',
        url: 'javascript:alert(1)',
      }).success
    ).toBe(false);
  });

  it('rejects an unknown action type', () => {
    expect(
      actionSchema.safeParse({
        action: 'exec',
        label: 'x',
        url: 'https://e.net',
      }).success
    ).toBe(false);
  });
});

describe('safeFilename', () => {
  it('rejects path separators and traversal', () => {
    for (const value of ['../etc/passwd', 'a/b', 'a\\b', '..', '.']) {
      expect(safeFilename.safeParse(value).success, value).toBe(false);
    }
  });

  it('rejects control characters', () => {
    expect(safeFilename.safeParse('a\u0000b').success).toBe(false);
    expect(safeFilename.safeParse('a\nb').success).toBe(false);
  });

  it('accepts an ordinary name', () => {
    expect(safeFilename.safeParse('report.pdf').success).toBe(true);
  });
});

describe('messageIdParam', () => {
  it('accepts exactly twelve alphanumerics', () => {
    expect(messageIdParam.safeParse('XGe5RN8RdcGO').success).toBe(true);
    expect(messageIdParam.safeParse('short').success).toBe(false);
    expect(messageIdParam.safeParse('../../admin1').success).toBe(false);
  });
});
