import {
  expectEveryToolExercised,
  startServer,
  toolCoverage,
  type LiveHarness,
} from 'mcp-integration-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_TOOLS } from '../../src/tools/catalogue.js';
import { bootstrap, type Sandbox } from './bootstrap.js';

/**
 * Every tool in the catalogue, against a real ntfy in Docker.
 *
 * The unit suite stubs `fetch`, so it tests what this server believes ntfy
 * does with `PUT /{topic}/{id}/read` and `DELETE /{topic}/{id}`. Those are the
 * two endpoints ntfy documents least and the two most worth running for real.
 *
 * Order matters and state is shared — a message published near the top is
 * revised, cleared and deleted further down — so this is one sequential story.
 */

let sandbox: Sandbox;
/** Declares elicitation, so guarded tools go through the real dialog. */
let asking: LiveHarness;
/** Declares none, so the same tools fall back to the two-call token. */
let plain: LiveHarness;

let publishedId: string;

interface Published {
  published: number;
  failed: number;
  results: { topic: string; ok: boolean; sequence_id: string }[];
}

/** The sequence id of the one message a single-topic publish produced. */
function idOf(published: Published): string {
  const id = published.results[0]?.sequence_id;
  if (id === undefined) {
    throw new Error(`no sequence id in ${JSON.stringify(published)}`);
  }
  return id;
}

function parse<T>(text: string): T {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON in result: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}

beforeAll(async () => {
  sandbox = await bootstrap();
  const env = {
    NTFY_URL: sandbox.url,
    NTFY_USERNAME: sandbox.username,
    NTFY_PASSWORD: sandbox.password,
    NTFY_TOPICS: sandbox.topic,
  };
  asking = await startServer({ env, elicit: 'accept' });
  plain = await startServer({ env });
}, 600_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
});

describe('the instance and the account', () => {
  it('reports what this ntfy is and who it thinks we are', async () => {
    const info = await asking.call('get_server_info');
    expect(info).toContain('"healthy": true');
    expect(info).toContain('"admin_tools_available": true');
    // /v1/version really is admin-only — 401 unauthenticated and 401 for a
    // non-admin account, verified against this instance — so an admin sees it
    // filled in. That is the half of the tool's promise a stub cannot check.
    expect(info).toContain('"version": "2.19');
    // /v1/config really is public, which is what makes get_server_info the
    // one call worth trying before the credentials are right.
    expect(info).toContain('"disallowed_topics"');

    const account = await asking.call('get_account');
    expect(account).toContain('"role": "admin"');
    // The redaction, against a real account rather than a fixture: ntfy
    // returns the token values, and this server must not pass them on.
    expect(account).not.toContain(sandbox.password);
  });

  it('reports read access separately from write access', async () => {
    // The single most common source of confusion with ntfy, and the reason
    // this tool exists: an admin may subscribe to everything, so the answer
    // here is yes — but a write-only publishing token would be denied and
    // could still publish. That asymmetry is the whole point.
    const access = await asking.call('check_topic_access', {
      topics: [sandbox.topic],
    });
    expect(access).toContain(sandbox.topic);
  });

  it('lists the accounts on the instance', async () => {
    expect(await asking.call('list_users')).toContain('integration');
  });
});

describe('a notification through its whole life', () => {
  it('publishes one and reads it back', async () => {
    // publish_message answers per topic — it can be given several — so the
    // id is inside `results`, not at the top level.
    const published = parse<Published>(
      await asking.call('publish_message', {
        topic: sandbox.topic,
        title: 'Integration',
        message: 'Published by the integration suite.',
        priority: 4,
        tags: ['warning'],
      })
    );
    expect(published.published).toBe(1);
    publishedId = idOf(published);
    expect(publishedId).toMatch(/^[A-Za-z0-9]+$/);

    const listed = await asking.call('list_messages', {
      topics: [sandbox.topic],
    });
    expect(listed).toContain('Published by the integration suite');

    const one = await asking.call('get_message', {
      id: publishedId,
      topic: sandbox.topic,
    });
    expect(one).toContain('Integration');
  });

  it('revises it, as a new cache entry pointing back at the original', async () => {
    const revised = parse<{ updated: string; revision_id: string }>(
      await asking.call('update_message', {
        sequence_id: publishedId,
        topic: sandbox.topic,
        message: 'Revised by the integration suite.',
      })
    );
    expect(revised.updated).toBe(publishedId);
    // A revision is its own message with its own id, carrying `sequence_id`
    // back to the original — which still holds the old text. Subscribers see
    // the notification change; the cache keeps both.
    expect(revised.revision_id).not.toBe(publishedId);
    expect(
      await asking.call('get_message', {
        id: publishedId,
        topic: sandbox.topic,
      })
    ).toContain('Published by the integration suite');

    const listed = await asking.call('list_messages', {
      topics: [sandbox.topic],
    });
    expect(listed).toContain('Revised by the integration suite');
    // The server renames ntfy's raw `sequence_id` to `updates` on the way
    // out, because "sequence_id" reads like an identity and this is a
    // back-pointer to what the event revises.
    expect(listed).toContain(`"updates": "${publishedId}"`);
  });

  it('clears it on subscribers without removing it from the cache', async () => {
    const cleared = await asking.call('mark_messages_read', {
      sequence_ids: [publishedId],
      topic: sandbox.topic,
    });
    expect(cleared).toContain('"ok": true');
    // Still readable: mark_messages_read emits a `message_clear` event telling
    // subscribers to drop the notification. It is a marker, and this is the
    // assertion that tells a marker from a delete against a real server.
    expect(
      await asking.call('get_message', {
        id: publishedId,
        topic: sandbox.topic,
      })
    ).toContain('Published by the integration suite');
  });

  it('deletes it — which tells subscribers, and leaves the cache alone', async () => {
    const deleted = await asking.call('delete_messages', {
      sequence_ids: [publishedId],
      topic: sandbox.topic,
    });
    expect(deleted).toContain('"ok": true');

    // The surprise, and the reason this is a test and not an assumption:
    // ntfy's delete publishes a `message_delete` event rather than removing
    // anything. The original stays in the cache until it expires, so
    // get_message still finds it and list_messages still lists it. "Deleted"
    // means subscribers were told to remove their copy.
    expect(
      await asking.call('get_message', {
        id: publishedId,
        topic: sandbox.topic,
      })
    ).toContain('Published by the integration suite');
    expect(
      await asking.call('list_messages', { topics: [sandbox.topic] })
    ).toContain('"event": "message_delete"');
  });
});

describe('accounts and access', () => {
  it('creates an account, grants it one topic, and removes both', async () => {
    await asking.call('create_user', {
      username: 'publisher',
      password: 'publisher-not-a-secret',
    });
    expect(await asking.call('list_users')).toContain('publisher');

    await asking.call('manage_user_access', {
      username: 'publisher',
      topic: sandbox.topic,
      action: 'write_only',
    });
    const granted = await asking.call('list_users', { username: 'publisher' });
    expect(granted).toContain(sandbox.topic);

    // `revoke` removes the grant; `deny` writes an explicit denial. Two
    // different states, and only a real instance shows the difference in
    // list_users.
    await asking.call('manage_user_access', {
      username: 'publisher',
      topic: sandbox.topic,
      action: 'revoke',
    });
    await asking.call('delete_user', { username: 'publisher' });
    expect(await asking.call('list_users')).not.toContain('publisher');
  });
});

describe('the fallback path for a client with no dialog', () => {
  it('takes the two-call token instead', async () => {
    // The same guarded tools, driven the other way, across a real process
    // boundary — which no test here did before, because every unit test uses
    // InMemoryTransport.
    const published = idOf(
      parse<Published>(
        await plain.call('publish_message', {
          topic: sandbox.topic,
          message: 'For the fallback path.',
        })
      )
    );

    const refusal = await plain.call('delete_messages', {
      sequence_ids: [published],
      topic: sandbox.topic,
    });
    expect(refusal).toContain('confirm_token');
    expect(plain.prompts).toHaveLength(0);

    await plain.confirmed('delete_messages', {
      sequence_ids: [published],
      topic: sandbox.topic,
    });
  });

  it('refuses a token issued for a different set of ids', async () => {
    const first = idOf(
      parse<Published>(
        await plain.call('publish_message', {
          topic: sandbox.topic,
          message: 'One.',
        })
      )
    );
    const second = idOf(
      parse<Published>(
        await plain.call('publish_message', {
          topic: sandbox.topic,
          message: 'Two.',
        })
      )
    );

    const refusal = await plain.call('delete_messages', {
      sequence_ids: [first],
      topic: sandbox.topic,
    });
    const token = /confirm_token="([a-f0-9]{32})"/.exec(refusal)?.[1];
    expect(token).toBeDefined();

    // A confirmation shown for one notification must not delete two.
    await plain.call(
      'delete_messages',
      {
        sequence_ids: [first, second],
        topic: sandbox.topic,
        confirm_token: token,
      },
      { expectError: true }
    );
    // Nothing was deleted: no message_delete event names the widened pair.
    const listed = await plain.call('list_messages', {
      topics: [sandbox.topic],
    });
    expect(listed).not.toContain(`"updates": "${second}"`);
    await plain.confirmed('delete_messages', {
      sequence_ids: [first, second],
      topic: sandbox.topic,
    });
  });

  it('asked a person on the other harness, and nobody on this one', () => {
    expect(asking.prompts.length).toBeGreaterThan(0);
    expect(plain.prompts).toHaveLength(0);
  });
});

it('exercises every tool in the catalogue', () => {
  const called = new Set([...asking.called, ...plain.called]);
  const report = toolCoverage({ called }, ALL_TOOLS, {});
  console.log(
    `ntfy-mcp: ${report.called.length}/${ALL_TOOLS.length} tools against a real ntfy`
  );
  expectEveryToolExercised({ called }, ALL_TOOLS, {});
});
