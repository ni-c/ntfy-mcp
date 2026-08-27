import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const published = (id = 'XGe5RN8RdcGO') => ({
  id,
  time: 1787820062,
  event: 'message',
  topic: 'alerts',
});

describe('publish_message', () => {
  it('sends one request per topic, because ntfy has no multi-topic publish', async () => {
    const harness = await connect({}, () => published());
    await harness.call('publish_message', {
      topics: ['alerts', 'deploys'],
      message: 'hello',
    });
    expect(harness.calls).toHaveLength(2);
    for (const call of harness.calls) {
      expect(call.url).toMatch(/\/$/);
      expect(call.method).toBe('POST');
    }
    const topics = harness.calls.map(
      (call) => (JSON.parse(call.body ?? '{}') as { topic: string }).topic
    );
    expect(topics).toEqual(['alerts', 'deploys']);
  });

  it('keeps the topics that worked when one is rejected', async () => {
    // A throw on the first failure would discard the successes, and the caller
    // would have no way to know which notifications actually went out.
    let seen = 0;
    const harness = await connect({}, () => {
      seen += 1;
      if (seen === 2) {
        return new Response('{"code":40301,"http":403,"error":"forbidden"}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return published();
    });
    const result = await harness.call('publish_message', {
      topics: ['a', 'b', 'c'],
      message: 'hello',
    });
    expect(result.isError).not.toBe(true);
    const text = harness.text(result);
    expect(text).toContain('"published": 2');
    expect(text).toContain('"failed": 1');
    expect(text).toContain('"ok": false');
  });

  it('maps cache=false to the string ntfy actually wants', async () => {
    // The JSON body takes the literal string "no"; sending `false` is silently
    // ignored, so the caller would believe caching was off when it was not.
    const harness = await connect({ topics: ['alerts'] }, () => published());
    await harness.call('publish_message', { message: 'x', cache: false });
    const body = JSON.parse(harness.calls[0]?.body ?? '{}') as {
      cache?: unknown;
    };
    expect(body.cache).toBe('no');
  });

  it('omits cache entirely when it is true, rather than inventing "yes"', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => published());
    await harness.call('publish_message', { message: 'x', cache: true });
    const body = JSON.parse(harness.calls[0]?.body ?? '{}') as Record<
      string,
      unknown
    >;
    expect('cache' in body).toBe(false);
  });

  it('does the same for firebase', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => published());
    await harness.call('publish_message', { message: 'x', firebase: false });
    expect(harness.calls[0]?.body).toContain('"firebase":"no"');
  });

  it('keeps markdown a real boolean', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => published());
    await harness.call('publish_message', { message: 'x', markdown: true });
    expect(harness.calls[0]?.body).toContain('"markdown":true');
  });

  it('rejects the string form of cache at the schema', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => published());
    const result = await harness.call('publish_message', {
      message: 'x',
      cache: 'no',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('explains the delay/cache conflict instead of relaying 40002', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => published());
    const result = await harness.call('publish_message', {
      message: 'x',
      delay: '30m',
      cache: false,
    });
    expect(result.isError).toBe(true);
    expect(harness.text(result)).toContain('has to exist on the server');
    expect(harness.calls).toHaveLength(0);
  });

  it('refuses a javascript: URL in every field that reaches a device', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => published());
    for (const field of ['click', 'icon', 'attach']) {
      const result = await harness.call('publish_message', {
        message: 'x',
        [field]: 'javascript:alert(1)',
      });
      expect(result.isError, field).toBe(true);
    }
    const result = await harness.call('publish_message', {
      message: 'x',
      actions: [{ action: 'http', label: 'Go', url: 'javascript:alert(1)' }],
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('refuses a fourth action button locally', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => published());
    const result = await harness.call('publish_message', {
      message: 'x',
      actions: Array.from({ length: 4 }, (_unused, index) => ({
        action: 'view',
        label: `a${index}`,
        url: 'https://example.net',
      })),
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('needs at least a message or a title', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => published());
    const result = await harness.call('publish_message', {});
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('reports the id as the sequence id for a later update', async () => {
    const harness = await connect({ topics: ['alerts'] }, () =>
      published('aaaaaaaaaaaa')
    );
    const result = await harness.call('publish_message', { message: 'x' });
    expect(harness.text(result)).toContain('"sequence_id": "aaaaaaaaaaaa"');
  });

  it('is bounded by the topic allowlist', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => published());
    const result = await harness.call('publish_message', {
      topics: ['attacker'],
      message: 'exfiltrated',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});

describe('update_message', () => {
  it('uses the JSON body with sequence_id, not the raw-body route', async () => {
    // `POST /{topic}/{sequence_id}` follows the raw-body convention: it would
    // publish the JSON document as the literal message text, which is exactly
    // what a first attempt against 2.27.0 did.
    const harness = await connect({ topics: ['alerts'] }, () =>
      published('bbbbbbbbbbbb')
    );
    await harness.call('update_message', {
      sequence_id: 'aaaaaaaaaaaa',
      message: 'v2',
    });
    const call = harness.calls[0];
    expect(call?.url).toBe('https://ntfy.example.net/');
    const body = JSON.parse(call?.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      message: 'v2',
      topic: 'alerts',
      sequence_id: 'aaaaaaaaaaaa',
    });
  });

  it('requires at least one field to change', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => published());
    const result = await harness.call('update_message', {
      sequence_id: 'aaaaaaaaaaaa',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});

describe('mark_messages_read', () => {
  it('clears each id and reports them individually', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => ({}));
    const result = await harness.call('mark_messages_read', {
      sequence_ids: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
    });
    expect(harness.calls.map((call) => call.url)).toEqual([
      'https://ntfy.example.net/alerts/aaaaaaaaaaaa/read',
      'https://ntfy.example.net/alerts/bbbbbbbbbbbb/read',
    ]);
    expect(harness.text(result)).toContain('"ok": true');
  });
});

describe('delete_messages', () => {
  it('asks for a token first and touches nothing', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => ({}));
    const result = await harness.call('delete_messages', {
      sequence_ids: ['aaaaaaaaaaaa'],
    });
    expect(harness.calls).toHaveLength(0);
    expect(harness.text(result)).toContain('confirm_token');
  });

  it('quotes only server-side metadata in the prompt', async () => {
    // No title, no message body: the prompt is read by a model, and everything
    // in a notification is third-party content.
    const harness = await connect({ topics: ['alerts'] }, () => ({}));
    const result = await harness.call('delete_messages', {
      sequence_ids: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
    });
    const text = harness.text(result);
    expect(text).toContain('2 notification(s)');
    expect(text).toContain('"alerts"');
  });

  it('executes with the token and refuses the replay', async () => {
    const harness = await connect({ topics: ['alerts'] }, () => ({}));
    const first = await harness.call('delete_messages', {
      sequence_ids: ['aaaaaaaaaaaa'],
    });
    const token = /confirm_token="([a-f0-9]{32})"/.exec(
      harness.text(first)
    )?.[1];
    expect(token).toBeDefined();

    const second = await harness.call('delete_messages', {
      sequence_ids: ['aaaaaaaaaaaa'],
      confirm_token: token,
    });
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.method).toBe('DELETE');
    expect(harness.text(second)).toContain('"ok": true');

    const replay = await harness.call('delete_messages', {
      sequence_ids: ['aaaaaaaaaaaa'],
      confirm_token: token,
    });
    expect(harness.text(replay)).toContain('confirm_token');
    expect(harness.calls).toHaveLength(1);
  });

  it('will not execute a longer list than the one confirmed', async () => {
    // The regression the set fingerprint exists for: a token issued for one id
    // must not delete two.
    const harness = await connect({ topics: ['alerts'] }, () => ({}));
    const first = await harness.call('delete_messages', {
      sequence_ids: ['aaaaaaaaaaaa'],
    });
    const token = /confirm_token="([a-f0-9]{32})"/.exec(
      harness.text(first)
    )?.[1];

    const wider = await harness.call('delete_messages', {
      sequence_ids: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
      confirm_token: token,
    });
    expect(harness.calls).toHaveLength(0);
    expect(harness.text(wider)).toContain('confirm_token');
  });
});

describe('create_user', () => {
  it('does not echo the password back', async () => {
    const harness = await connect({}, () => ({}));
    const result = await harness.call('create_user', {
      username: 'publisher',
      password: 'correct-horse',
    });
    const text = harness.text(result);
    expect(text).not.toContain('correct-horse');
    expect(text).toContain('publisher');
    expect(text).toContain('no topic access yet');
  });

  it('rejects a short password before sending it anywhere', async () => {
    const harness = await connect({}, () => ({}));
    const result = await harness.call('create_user', {
      username: 'publisher',
      password: 'short',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});

describe('delete_user', () => {
  it('is gated by a confirmation bound to the username', async () => {
    const harness = await connect({}, () => ({}));
    const first = await harness.call('delete_user', { username: 'alice' });
    const token = /confirm_token="([a-f0-9]{32})"/.exec(
      harness.text(first)
    )?.[1];
    expect(harness.calls).toHaveLength(0);

    const wrongTarget = await harness.call('delete_user', {
      username: 'bob',
      confirm_token: token,
    });
    expect(harness.calls).toHaveLength(0);
    expect(harness.text(wrongTarget)).toContain('confirm_token');

    const right = await harness.call('delete_user', {
      username: 'alice',
      confirm_token: token,
    });
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.method).toBe('DELETE');
    expect(harness.text(right)).toContain('"deleted": "alice"');
  });
});

describe('manage_user_access', () => {
  it('translates its own action names to ntfy permissions', async () => {
    const harness = await connect({}, () => ({}));
    const first = await harness.call('manage_user_access', {
      username: 'publisher',
      topic: 'deploy*',
      action: 'write_only',
    });
    const token = /confirm_token="([a-f0-9]{32})"/.exec(
      harness.text(first)
    )?.[1];
    await harness.call('manage_user_access', {
      username: 'publisher',
      topic: 'deploy*',
      action: 'write_only',
      confirm_token: token,
    });
    const call = harness.calls[0];
    expect(call?.method).toBe('PUT');
    expect(call?.url).toBe('https://ntfy.example.net/v1/users/access');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      username: 'publisher',
      topic: 'deploy*',
      permission: 'write-only',
    });
  });

  it('uses DELETE for revoke, which is a different operation from deny', async () => {
    const harness = await connect({}, () => ({}));
    const first = await harness.call('manage_user_access', {
      username: 'publisher',
      topic: 'alerts',
      action: 'revoke',
    });
    const token = /confirm_token="([a-f0-9]{32})"/.exec(
      harness.text(first)
    )?.[1];
    await harness.call('manage_user_access', {
      username: 'publisher',
      topic: 'alerts',
      action: 'revoke',
      confirm_token: token,
    });
    expect(harness.calls[0]?.method).toBe('DELETE');
    expect(harness.calls[0]?.body).not.toContain('permission');
  });

  it('will not reuse a token across a different action', async () => {
    // Widening access counts as destructive, so confirming a revoke must not
    // execute a grant.
    const harness = await connect({}, () => ({}));
    const first = await harness.call('manage_user_access', {
      username: 'publisher',
      topic: 'alerts',
      action: 'revoke',
    });
    const token = /confirm_token="([a-f0-9]{32})"/.exec(
      harness.text(first)
    )?.[1];
    const swapped = await harness.call('manage_user_access', {
      username: 'publisher',
      topic: 'alerts',
      action: 'read_write',
      confirm_token: token,
    });
    expect(harness.calls).toHaveLength(0);
    expect(harness.text(swapped)).toContain('confirm_token');
  });

  it('accepts a wildcard here, which publishing does not', async () => {
    const harness = await connect({}, () => ({}));
    const result = await harness.call('manage_user_access', {
      username: 'publisher',
      topic: 'deploy*',
      action: 'read_only',
    });
    expect(result.isError).not.toBe(true);
  });
});

describe('the read-only mode', () => {
  it('does not register any write tool at all', async () => {
    const harness = await connect({ readOnly: true, topics: ['alerts'] });
    const result = await harness.call('publish_message', { message: 'x' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'Tool publish_message not found'
    );
    expect(harness.calls).toHaveLength(0);
  });
});
