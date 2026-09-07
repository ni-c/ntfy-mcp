import { describe, expect, it } from 'vitest';

import { UNTRUSTED_PREFIX } from '../src/result.js';
import { ALL_TOOLS } from '../src/tools/catalogue.js';
import { confirmed, connect, ndjson, type Harness } from './harness.js';

/**
 * The two channels of every tool, held to saying the same thing.
 *
 * Until one test asserts this over the whole catalogue the rule does not
 * exist — and the tools that break it *on purpose* are what make it
 * enforceable. Here exactly one shape does: {@link untrustedResult} puts the
 * warning sentence in front of the JSON, because a client reading only `content`
 * has to see the framing before the publisher's prose. That is a documented
 * exception with a reason; without this test it would be indistinguishable from
 * two channels that had drifted.
 */

/** How each tool is reached with a fake that answers plausibly. */
const CALLS: Record<string, { args?: Record<string, unknown>; gated?: true }> =
  {
    list_messages: {},
    get_message: { args: { id: 'XGe5RN8RdcGO' } },
    check_topic_access: {},
    get_server_info: {},
    get_account: {},
    list_users: {},
    publish_message: { args: { message: 'hello' } },
    update_message: {
      args: { sequence_id: 'aaaaaaaaaaaa', message: 'v2' },
      gated: true,
    },
    mark_messages_read: { args: { sequence_ids: ['aaaaaaaaaaaa'] } },
    delete_messages: { args: { sequence_ids: ['aaaaaaaaaaaa'] }, gated: true },
    create_user: {
      args: { username: 'alice', password: 'hunter2hunter2' },
      gated: true,
    },
    delete_user: { args: { username: 'alice' }, gated: true },
    manage_user_access: {
      args: { username: 'alice', topic: 'alerts', action: 'read_only' },
      gated: true,
    },
  };

const message = {
  id: 'XGe5RN8RdcGO',
  time: 1_787_820_062,
  event: 'message',
  topic: 'alerts',
  message: 'disk full',
};

function respond(request: { url: string }): unknown {
  if (request.url.includes('/json?')) return ndjson([message]);
  if (request.url.includes('/v1/users')) {
    return [{ username: 'alice', role: 'user', grants: [] }];
  }
  if (request.url.includes('/v1/account')) {
    return { username: 'me', role: 'admin' };
  }
  return { id: 'XGe5RN8RdcGO' };
}

async function callTool(harness: Harness, name: string) {
  const entry = CALLS[name];
  if (entry === undefined) throw new Error(`no call recorded for ${name}`);
  // A guarded tool has to be driven through its two-call token, or what is
  // compared is the confirmation prompt rather than the tool's answer.
  return entry.gated === true
    ? await confirmed(harness.client, name, entry.args ?? {})
    : await harness.call(name, entry.args ?? {});
}

describe('the text block and structuredContent carry the same document', () => {
  it('covers every tool in the catalogue', () => {
    expect(Object.keys(CALLS).toSorted()).toEqual([...ALL_TOOLS].toSorted());
  });

  for (const name of ALL_TOOLS) {
    it(`${name} answers with one document in two presentations`, async () => {
      const harness = await connect({ topics: ['alerts'] }, respond);
      const result = await callTool(harness, name);
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();

      const text = harness.text(result);
      expect(result.structuredContent).toBeDefined();

      // The one documented exception, and the reason it exists: the marker
      // sentence goes in front of the JSON so a client reading only `content`
      // sees the framing before the publisher's prose.
      const carriesMarker = text.startsWith(UNTRUSTED_PREFIX);
      const json = carriesMarker
        ? text.slice(UNTRUSTED_PREFIX.length).trimStart()
        : text;
      expect(JSON.parse(json)).toEqual(result.structuredContent);

      // And the marker is on exactly the tools whose answer is somebody else's
      // words, in the structured half as well as in the prose.
      const structured = result.structuredContent as Record<string, unknown>;
      if (carriesMarker) {
        expect(structured.untrusted).toBe(true);
        expect(structured.source).toBe('ntfy');
      } else {
        expect(structured.untrusted).toBeUndefined();
      }
    });
  }
});
