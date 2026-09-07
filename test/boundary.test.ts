import { describe, expect, it } from 'vitest';

import { connect, ndjson } from './harness.js';

/**
 * What ntfy's JSON is allowed to do to an answer.
 *
 * Every response used to be a TypeScript cast — `JSON.parse(...) as
 * NtfyMessage`, `as Record<string, unknown>` — and a cast is not a check. The
 * declared interface describes what ntfy 2.19.2 sends; what arrives is whatever
 * answered on the port, and for a notification's own fields it is whoever knew
 * the topic name, which on an open instance is anybody.
 *
 * Two failure modes, and the tests below are written against both. A **crash**
 * — `tags.slice is not a function`, `RangeError: Invalid time value` — escapes
 * the per-entry projection and takes the whole listing with it. A **schema
 * violation** — an `id` that is a number against `z.string()` — is refused by
 * the SDK after the work is done, and the model is told "Output validation
 * error" with no cause it can act on. The assertion is therefore always the
 * same: the call answers, the good entries survive, and neither sentence
 * appears.
 */

/** The two sentences that mean the boundary let something through. */
function assertNoFault(text: string): void {
  expect(text).not.toContain('Output validation error');
  expect(text).not.toContain('is not a function');
  expect(text).not.toContain('Cannot read properties');
  expect(text).not.toContain('Invalid time value');
}

const good = {
  id: 'XGe5RN8RdcGO',
  time: 1_787_820_062,
  event: 'message',
  topic: 'alerts',
  message: 'disk full',
};

describe('one bad message does not cost the listing', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['a time that is a word', { time: 'later' }],
    ['a time past the range Date holds', { time: 9e15 }],
    ['a time that is null', { time: null }],
    ['tags that are a number', { tags: 7 }],
    ['tags with holes in them', { tags: ['ok', null, 5, 'fine'] }],
    ['a title that is a number', { title: 42 }],
    ['a body that is an object', { message: { nested: true } }],
    ['actions that are a string', { actions: 'boom' }],
    ['an id that is a number', { id: 5 }],
    ['an event that is an array', { event: ['message'] }],
    ['a topic that is null', { topic: null }],
    ['an attachment that is a number', { attachment: 12 }],
  ];

  for (const [name, overrides] of cases) {
    it(`survives ${name}`, async () => {
      const harness = await connect({ topics: ['alerts'] }, () =>
        ndjson([
          { ...good, ...overrides },
          { ...good, id: 'aaaaaaaaaaaa', message: 'the good one' },
        ])
      );
      const result = await harness.call('list_messages');
      const text = harness.text(result);
      assertNoFault(text);
      expect(result.isError).toBeFalsy();
      // The entry that was fine is still in the answer, which is the whole
      // point: the projection refuses an entry, never a listing.
      expect(text).toContain('the good one');
    });
  }

  it('survives 1e999, which only exists in the JSON text', async () => {
    // Not expressible as a JavaScript value first: `JSON.stringify(Infinity)`
    // is `null`, so a case written as `{ time: 1e999 }` in a fixture never
    // sends `1e999` at all and tests something else entirely. It has to go into
    // the body as text, which is how it arrives from an instance.
    const line = JSON.stringify({ ...good, id: 'aaaaaaaaaaaa' })
      .replace('"time":1787820062', '"time":1e999')
      .replace(
        '"message":"disk full"',
        '"message":"disk full","priority":1e999'
      );
    const harness = await connect(
      { topics: ['alerts'] },
      () =>
        new Response(line, {
          headers: { 'content-type': 'application/x-ndjson' },
        })
    );
    const result = await harness.call('list_messages');
    assertNoFault(harness.text(result));
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      messages: { time_unavailable?: true; priority?: number }[];
    };
    // Infinity is `typeof "number"` and refused by `z.number()`, so it has to
    // be gone rather than passed on.
    expect(structured.messages[0]?.time_unavailable).toBe(true);
    expect(structured.messages[0]?.priority).toBeUndefined();
  });

  it('reports an entry with no usable id rather than dropping it in silence', async () => {
    const harness = await connect({ topics: ['alerts'] }, () =>
      ndjson([
        { ...good, id: 5 },
        { ...good, id: 'aaaaaaaaaaaa' },
      ])
    );
    const result = await harness.call('list_messages');
    const structured = result.structuredContent as { unreadable?: number };
    expect(structured.unreadable).toBe(1);
    expect(harness.text(result)).toContain('no usable id');
  });

  it('says a timestamp was unusable instead of inventing one', async () => {
    const harness = await connect({ topics: ['alerts'] }, () =>
      ndjson([{ ...good, time: 'later' }])
    );
    const result = await harness.call('list_messages');
    const structured = result.structuredContent as {
      messages: { time?: string; time_unavailable?: true }[];
    };
    expect(structured.messages[0]?.time).toBeUndefined();
    expect(structured.messages[0]?.time_unavailable).toBe(true);
  });

  it('survives a stream line that is valid JSON and not an object', async () => {
    // `null`, `42` and `[1,2]` are all legal NDJSON lines. Reading `.event` off
    // one of them threw out of the poll, which is the listing rather than the
    // line.
    const harness = await connect({ topics: ['alerts'] }, () =>
      ndjson([null, 42, ['x'], { ...good, message: 'the good one' }])
    );
    const result = await harness.call('list_messages');
    assertNoFault(harness.text(result));
    expect(harness.text(result)).toContain('the good one');
  });
});

describe('the other read tools have a boundary too', () => {
  it('get_account survives a body that is not an object', async () => {
    const harness = await connect(
      {},
      () =>
        new Response('null', {
          headers: { 'content-type': 'application/json' },
        })
    );
    const result = await harness.call('get_account');
    assertNoFault(harness.text(result));
  });

  it('list_users survives entries that are not user records', async () => {
    const harness = await connect({}, () => [
      null,
      5,
      'nope',
      { username: 'real', role: 'user', grants: 'not-a-list' },
    ]);
    const result = await harness.call('list_users');
    assertNoFault(harness.text(result));
    expect(harness.text(result)).toContain('real');
  });

  it('list_users survives a role that is an object', async () => {
    const harness = await connect({}, () => [
      { username: 'a', role: { nested: 'admin' }, grants: [] },
    ]);
    const result = await harness.call('list_users');
    assertNoFault(harness.text(result));
    expect(harness.text(result)).toContain('(unknown)');
  });

  it('get_server_info survives sections that are not objects', async () => {
    const harness = await connect({}, (request) =>
      request.url.includes('/v1/config')
        ? new Response('42', {
            headers: { 'content-type': 'application/json' },
          })
        : {}
    );
    const result = await harness.call('get_server_info');
    assertNoFault(harness.text(result));
  });

  it('publish_message answers even when ntfy sends no usable id', async () => {
    // The one moment where losing the answer costs something that cannot be
    // retried safely: the notification has already gone out.
    const harness = await connect({ topics: ['alerts'] }, () => ({ id: 5 }));
    const result = await harness.call('publish_message', { message: 'hi' });
    assertNoFault(harness.text(result));
    expect(result.isError).toBeFalsy();
    expect(harness.text(result)).toContain(
      'did not return a usable message id'
    );
  });
});
