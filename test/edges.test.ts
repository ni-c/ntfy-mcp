import { afterEach, describe, expect, it, vi } from 'vitest';

import { NtfyApiError } from '../src/api.js';
import { connect } from './harness.js';

/**
 * The branches a caller or the instance can reach and nothing had exercised.
 *
 * Coverage gaps are where the bugs were. These are the ones left after the
 * review's own suites: an ntfy that answers something no API route would, a call
 * that runs out of its budget, a shrinking rule that does not shrink enough, and
 * the error path of the two per-id tools.
 */

afterEach(() => {
  vi.useRealTimers();
});

const html = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

describe('a 200 that is not an API answer', () => {
  it('is refused rather than handed on as data', async () => {
    // ntfy serves its web app for any path that matches no API route — status
    // 200, content-type text/html. Returning the body verbatim would put a
    // whole HTML page in front of the model as if it were the answer.
    const harness = await connect({}, () => html('<!doctype html><p>app</p>'));
    const text = harness.text(await harness.call('get_account'));
    expect(text).toContain('did not reach an ntfy API route');
    expect(text).not.toContain('<p>app</p>');
  });

  it('a long plain-text 200 is cut rather than passed on whole', async () => {
    // At the client rather than through a tool: every tool projects, so the
    // truncation is not visible in an answer — which is the point. Some ntfy
    // endpoints legitimately answer with a short plain-text body, and the cut
    // is what keeps "short" true.
    const { NtfyApi } = await import('../src/api.js');
    const { testConfig, stubFetch } = await import('./harness.js');
    stubFetch(
      () =>
        new Response('x'.repeat(50_000), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
    );
    const answer = await new NtfyApi(testConfig()).get('/v1/health');
    expect(typeof answer).toBe('string');
    expect(answer as string).toContain('truncated');
    expect((answer as string).length).toBeLessThan(3000);
  });

  it('a body announced as JSON that is not JSON comes back as text', async () => {
    const harness = await connect(
      {},
      () =>
        new Response('not json at all', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    // Not an object, so the account projection answers with nothing rather
    // than forwarding the string.
    const result = await harness.call('get_account');
    expect(result.isError).toBeFalsy();
    expect(harness.text(result)).not.toContain('not json at all');
  });
});

describe('the error code is read out of a body that may not be an object', () => {
  it('reads the code when there is one', () => {
    const error = new NtfyApiError(403, '{"code":40301}', 'GET', '/x');
    expect(error.code).toBe(40301);
  });

  it('survives a body that is legal JSON and not an object', () => {
    // `null`, `42` and `[1]` are all legal JSON. Reading `.code` off one threw
    // from inside a constructor, which is the worst place for it.
    for (const body of ['null', '42', '[1]', '"text"', 'not json']) {
      expect(() => new NtfyApiError(500, body, 'GET', '/x')).not.toThrow();
      expect(new NtfyApiError(500, body, 'GET', '/x').code).toBeUndefined();
    }
  });

  it('refuses a code that is not a finite number', () => {
    expect(
      new NtfyApiError(500, '{"code":1e999}', 'GET', '/x').code
    ).toBeUndefined();
    expect(
      new NtfyApiError(500, '{"code":"40301"}', 'GET', '/x').code
    ).toBeUndefined();
  });
});

describe('check_topic_access has a budget for the call, not only per request', () => {
  it('reports the topics it did not reach instead of leaving them out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Ten topics at the fifteen-second request timeout is two and a half
    // minutes on a tool the annotations call cheap. The clock advances per
    // request here, so the assertion is on the number of requests rather than
    // on elapsed time.
    const harness = await connect({ topics: ['a', 'b', 'c', 'd'] }, () => {
      vi.advanceTimersByTime(12_000);
      return {};
    });
    const result = await harness.call('check_topic_access', {
      topics: ['a', 'b', 'c', 'd'],
    });
    const structured = result.structuredContent as {
      results: { topic: string; not_checked?: true; note?: string }[];
    };
    // Every topic is still reported — an absent entry would read as an answer.
    expect(structured.results).toHaveLength(4);
    const skipped = structured.results.filter((r) => r.not_checked === true);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]?.note).toContain('30-second budget');
    expect(harness.calls.length).toBeLessThan(4);
  });
});

describe('a result that no shrinking rule could save is refused, not sent', () => {
  it('says which tool and how far over it was', async () => {
    // get_message returns one notification. Its per-item ceiling normally makes
    // this unreachable, which is exactly why the backstop needs a test: it is
    // the line that runs when a future field escapes the per-item cap.
    const { jsonResult } = await import('../src/result.js');
    expect(() =>
      jsonResult({ blob: 'x'.repeat(300_000) }, 'get_message')
    ).toThrow(/get_message answer is \d+ bytes/);
  });
});

describe('the per-id tools report a failure per id', () => {
  it('mark_messages_read keeps going after one id fails', async () => {
    let call = 0;
    const harness = await connect({ topics: ['alerts'] }, () => {
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ code: 40008, error: 'nope' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        : {};
    });
    const result = await harness.call('mark_messages_read', {
      sequence_ids: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
    });
    const structured = result.structuredContent as {
      results: { id: string; ok: boolean; error?: string }[];
    };
    expect(structured.results[0]?.ok).toBe(false);
    expect(structured.results[0]?.error).toContain('HTTP 400');
    expect(structured.results[1]?.ok).toBe(true);
  });

  it('delete_messages does the same, behind its confirmation', async () => {
    const { confirmed } = await import('./harness.js');
    let call = 0;
    const harness = await connect({ topics: ['alerts'] }, () => {
      call += 1;
      return call === 1
        ? new Response('{}', {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : {};
    });
    const result = await confirmed(harness.client, 'delete_messages', {
      sequence_ids: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
    });
    const structured = result.structuredContent as {
      results: { ok: boolean; error?: string }[];
    };
    expect(structured.results[0]?.ok).toBe(false);
    expect(structured.results[1]?.ok).toBe(true);
  });
});

describe('a section that failed for a reason other than an HTTP status', () => {
  it('reports the message cleaned rather than raw', async () => {
    // The generic branch of `section()`: undici quotes a header value it
    // refuses, Node's TLS layer quotes the certificate's names. Neither is this
    // server's own words.
    const escape = String.fromCharCode(0x1b);
    const harness = await connect({}, () => {
      throw new Error(`transport said ${escape}[2J something`);
    });
    const result = await harness.call('get_server_info');
    const text = harness.text(result);
    expect(text).not.toContain(escape);
    expect(text).toContain('transport said');
  });
});
