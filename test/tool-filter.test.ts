/**
 * What this repository still has to prove about its tool filter.
 *
 * The filter lives in `mcp-tool-allowlist` and is tested there: pattern syntax,
 * the preset, how a rejected entry is quoted back, the shape of every message.
 * What only this repository can assert is the wiring — that the catalogue names
 * exactly the tools the server registers, that the messages name *these*
 * variables, and that a filtered tool is really gone rather than merely hidden.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '../src/tools/catalogue.js';

import { createServer } from '../src/server.js';
import { ToolFilterError } from 'mcp-tool-allowlist';
import { connect, stubFetch, testConfig, toolNames } from './harness.js';

const config = testConfig;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the catalogue', () => {
  // These are what let the filter validate a name before anything is
  // registered. If they drift from the code, every error message drifts too.
  it('is exactly the set of tools the server registers', async () => {
    expect(await toolNames()).toEqual([...ALL_TOOLS].sort());
  });

  it('splits into read and write with nothing left over', async () => {
    expect([...READ_TOOLS, ...WRITE_TOOLS].sort()).toEqual(
      [...ALL_TOOLS].sort()
    );
    expect(
      READ_TOOLS.filter((t) => (WRITE_TOOLS as readonly string[]).includes(t))
    ).toEqual([]);
    expect(await toolNames({ readOnly: true })).toEqual([...READ_TOOLS].sort());
  });

  it('holds names the env-var syntax cannot misread', () => {
    // A comma or an asterisk in a name would break the separator or the
    // pattern; a tool called "essential" would be unreachable behind the preset.
    for (const tool of ALL_TOOLS) {
      expect(tool).toMatch(/^[a-z0-9_]+$/);
    }
    expect(ALL_TOOLS).not.toContain('essential');
  });

  it('has an essential preset that is a real, sensibly sized subset', () => {
    expect(new Set(ESSENTIAL_TOOLS).size).toBe(ESSENTIAL_TOOLS.length);
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
    for (const tool of ESSENTIAL_TOOLS) expect(ALL_TOOLS).toContain(tool);
  });

  it('keeps the preset useful under the read-only mode', () => {
    // Otherwise `NTFY_ALLOW_TOOLS=essential` plus `NTFY_READ_ONLY=true` — the
    // documented safe configuration — would collapse to almost nothing.
    const read = ESSENTIAL_TOOLS.filter((tool) =>
      (READ_TOOLS as readonly string[]).includes(tool)
    );
    expect(read.length).toBeGreaterThanOrEqual(3);
  });
});

describe('selecting tools', () => {
  it('narrows tools/list to an allow list', async () => {
    expect(
      await toolNames({ allowTools: 'list_messages,get_message' })
    ).toEqual(['get_message', 'list_messages']);
  });

  it('removes a whole family with a prefix pattern', async () => {
    const names = await toolNames({ denyTools: 'delete_*' });
    expect(names.some((n) => n.startsWith('delete_'))).toBe(false);
    expect(names).toHaveLength(
      ALL_TOOLS.length - ALL_TOOLS.filter((t) => t.startsWith('delete_')).length
    );
  });

  it('subtracts the deny list from the allow list', async () => {
    expect(
      await toolNames({
        allowTools: 'get_*,list_*',
        denyTools: 'list_users,get_account,get_server_info',
      })
    ).toEqual(['get_message', 'list_messages']);
  });

  it('selects the curated set for "essential"', async () => {
    expect(await toolNames({ allowTools: 'essential' })).toEqual(
      [...ESSENTIAL_TOOLS].sort()
    );
  });

  it('lets the preset compose with extra names', async () => {
    expect(
      await toolNames({ allowTools: 'essential,delete_messages' })
    ).toEqual([...ESSENTIAL_TOOLS, 'delete_messages'].sort());
  });

  it('leaves an unconfigured server untouched', async () => {
    expect(await toolNames()).toEqual([...ALL_TOOLS].sort());
  });

  it('supports the deny list the README recommends', async () => {
    // The documented hardening for the write-enabled default. If any of these
    // names is ever renamed, this fails rather than the advice going stale.
    const names = await toolNames({
      denyTools: 'delete_messages,create_user,delete_user,manage_user_access',
    });
    expect(names).not.toContain('delete_messages');
    expect(names).not.toContain('manage_user_access');
    expect(names).toContain('publish_message');
  });
});

describe('a filtered-out tool', () => {
  it('cannot be called either, not merely hidden', async () => {
    // This is the difference between removing the tool and disabling it: a
    // disabled tool still answers a call, which advertises a refusal.
    const harness = await connect({ allowTools: 'list_messages' });
    // SDK v2 reports an unknown tool as a JSON-RPC error rather than as a
    // result carrying isError. Either way the call fails and nothing reaches
    // the API, which is what this test is about.
    await expect(
      harness.call('delete_messages', {
        sequence_ids: ['aaaaaaaaaaaa'],
        topic: 'alerts',
      })
    ).rejects.toThrow('Tool delete_messages not found');
    expect(harness.calls).toHaveLength(0);
  });
});

describe('refusing an unusable list', () => {
  it('rejects a name no tool has, and says which names exist', () => {
    // A typo that was merely ignored would leave a tool missing with no trace
    // of why — nobody looks for the cause of an absence in an env var.
    stubFetch();
    expect(() => createServer(config({ allowTools: 'list_messagez' }))).toThrow(
      ToolFilterError
    );
    expect(() => createServer(config({ allowTools: 'list_messagez' }))).toThrow(
      /no tool matches "list_messagez".*list_messages/s
    );
  });

  it('applies the same rule to the deny list', () => {
    stubFetch();
    expect(() => createServer(config({ denyTools: 'delet_messages' }))).toThrow(
      /NTFY_DENY_TOOLS: no tool matches "delet_messages"/
    );
  });

  it('rejects a list that would leave no tools at all', () => {
    stubFetch();
    expect(() => createServer(config({ denyTools: '*' }))).toThrow(
      /empty tool list/
    );
  });
});

describe('together with read-only mode', () => {
  const readOnly = { readOnly: true } as const;

  it('names read-only as the reason, rather than calling the tool unknown', () => {
    // The tool exists; it is suppressed. Reporting "unknown tool" would send
    // the reader looking for a typo that is not there. This is the whole reason
    // the catalogue is declared rather than discovered.
    stubFetch();
    let thrown: unknown;
    try {
      createServer(config({ ...readOnly, allowTools: 'delete_messages' }));
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('NTFY_READ_ONLY');
    expect(message).not.toContain('no tool matches');
  });

  it('lets a pattern cover write tools without failing', async () => {
    // `get_*,create_*` is a legitimate template to hand to both kinds of
    // deployment; under read-only the write half simply contributes nothing.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await toolNames({ ...readOnly, allowTools: 'get_*,create_*' })
    ).toEqual(['get_account', 'get_message', 'get_server_info']);
    expect(warn.mock.calls.flat().join(' ')).toContain('contributes nothing');
  });

  it('keeps the essential preset usable, narrowed to its read half', async () => {
    expect(await toolNames({ ...readOnly, allowTools: 'essential' })).toEqual(
      ESSENTIAL_TOOLS.filter((t) =>
        (READ_TOOLS as readonly string[]).includes(t)
      ).sort()
    );
  });

  it('says read-only is the reason when a pattern leaves nothing at all', () => {
    stubFetch();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      createServer(config({ ...readOnly, allowTools: 'create_*' }))
    ).toThrow(/read-only mode suppresses.*NTFY_READ_ONLY is set/s);
  });

  it('does not apply the write-tool rule to the deny list', async () => {
    // Denying something already suppressed is how a defensive list is written.
    expect(
      await toolNames({ ...readOnly, denyTools: 'delete_messages' })
    ).toEqual([...READ_TOOLS].sort());
  });
});

describe('the tools themselves', () => {
  it('mark every read tool as read-only and no write tool', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const hint = tool.annotations?.readOnlyHint;
      if ((READ_TOOLS as readonly string[]).includes(tool.name)) {
        expect(hint, tool.name).toBe(true);
      } else {
        expect(hint, tool.name).toBe(false);
      }
    }
  });

  it('mark the irreversible ones as destructive', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const destructive = tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(destructive).toEqual([
      'delete_messages',
      'delete_user',
      'manage_user_access',
      // Added with the annotation sweep: it replaces the fields of a message
      // people have already received a copy of, and what was there does not
      // come back.
      'update_message',
    ]);
  });

  it('declares all four annotation hints on every tool', async () => {
    // Not a style rule. Two of the four default to a *stronger* claim than
    // silence suggests: the specification gives destructiveHint and
    // openWorldHint a default of true, so a tool that omits them announces
    // itself as destructive and open-world. Four tools here said only
    // `readOnlyHint: false`, which is that claim with a word in front of it.
    const { client } = await connect();
    const { tools } = await client.listTools();
    const hints = [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ] as const;
    for (const tool of tools) {
      for (const hint of hints) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe(
          'boolean'
        );
      }
    }
  });

  it('does not call publishing destructive', async () => {
    // The one that fits neither half of the rule. Sending a notification
    // destroys nothing, and it reaches people who cannot un-receive it. That
    // is an outbound effect, not a destructive one, and no annotation carries
    // it — marking it destructive would put the warning on the wrong axis.
    const { client } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get('publish_message')?.destructiveHint).toBe(false);
    expect(byName.get('create_user')?.destructiveHint).toBe(false);
    expect(byName.get('mark_messages_read')?.destructiveHint).toBe(false);
  });

  it('require a confirm token on the four guarded tools', async () => {
    // Deliberately a list rather than "wherever destructiveHint is true".
    // Those are two different claims: the annotation says what a call does,
    // the confirmation decides whether a person is asked first. update_message
    // is destructive and not guarded, and create_user is guarded without being
    // destructive — both are gaps worth seeing, not reasons to soften an
    // annotation until the two lists agree.
    const guarded = [
      'create_user',
      'delete_messages',
      'delete_user',
      'manage_user_access',
    ];
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const properties = (
        tool.inputSchema as { properties?: Record<string, unknown> }
      ).properties;
      const gated = properties !== undefined && 'confirm_token' in properties;
      expect(gated, tool.name).toBe(guarded.includes(tool.name));
    }
  });

  it('does not offer a tool that would mint or print a credential', async () => {
    // Deliberate omission: every /v1/account/token and /v1/account/login
    // endpoint hands back a live token, which would then live in the
    // transcript forever.
    const names = await toolNames();
    for (const name of names) {
      expect(name).not.toMatch(/token|login|password/);
    }
  });
});
