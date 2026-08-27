import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { NtfyApi } from '../api.js';
import {
  confirmationPrompt,
  setResourceKey,
  tupleResourceKey,
  type ConfirmationStore,
} from '../confirm.js';
import { jsonResult, run, textResult } from '../result.js';
import {
  confirmTokenParam,
  topicPatternParam,
  usernameParam,
} from '../schema.js';

/**
 * The five unambiguous names this server exposes, mapped to the permission
 * strings ntfy accepts.
 *
 * ntfy takes nine aliases for four permissions (`rw`, `read-write`, `ro`,
 * `read`, `read-only`, …), which is nine ways for a model to be almost right.
 * `deny` and `revoke` are genuinely different and both are needed: `deny` writes
 * an explicit rule, which is the only way to carve an exception out of a
 * wildcard grant, while `revoke` removes the rule entirely and lets whatever
 * wildcard or server default sits behind it apply again.
 */
export const ACCESS_ACTIONS = {
  read_write: 'read-write',
  read_only: 'read-only',
  write_only: 'write-only',
  deny: 'deny',
} as const;

/**
 * The enum the tool advertises. Spelled out because zod needs literals, then
 * tied back to {@link ACCESS_ACTIONS} by the assertion below — otherwise the two
 * could drift and an action would be accepted and then mapped to `undefined`.
 */
export const ACCESS_ACTION_NAMES = [
  'read_write',
  'read_only',
  'write_only',
  'deny',
  'revoke',
] as const;

type Mapped = keyof typeof ACCESS_ACTIONS;
type Advertised = Exclude<(typeof ACCESS_ACTION_NAMES)[number], 'revoke'>;
// Fails to compile if either list gains an entry the other does not have.
const _actionsAgree: [Mapped, Advertised] extends [Advertised, Mapped]
  ? true
  : never = true;
void _actionsAgree;

export function registerAdminWriteTools(
  server: McpServer,
  api: NtfyApi,
  confirmations: ConfirmationStore
): void {
  server.registerTool(
    'create_user',
    {
      title: 'Create a user',
      description:
        'Creates a non-admin account on a self-hosted instance. Requires an ' +
        'admin account. Grant it access to topics with manage_user_access — a ' +
        'new account can reach nothing until you do.\n\n' +
        'The API cannot create administrators; only the ntfy CLI can ' +
        '(`ntfy user add --role=admin`).\n\n' +
        'Be aware that a password passed as a tool argument stays in the ' +
        'conversation transcript. For an account that matters, create it on ' +
        'the server instead.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        username: usernameParam.describe('The account name.'),
        password: z
          .string()
          .min(8)
          .max(128)
          .describe('Initial password, at least 8 characters.'),
        tier: z
          .string()
          .max(64)
          .optional()
          .describe('Tier name, on an instance that defines tiers.'),
      },
    },
    async (args) =>
      run(async () => {
        const body: Record<string, unknown> = {
          username: args.username,
          password: args.password,
        };
        if (args.tier !== undefined) body.tier = args.tier;
        await api.post('/v1/users', body);
        // Note what is not echoed back: the password.
        return jsonResult({
          created: args.username,
          role: 'user',
          note:
            'The account has no topic access yet — use manage_user_access to ' +
            'grant it.',
        });
      })
  );

  server.registerTool(
    'delete_user',
    {
      title: 'Delete a user',
      description:
        'Removes an account and every access grant attached to it. Requires ' +
        'an admin account and a confirmation token: call once without it to ' +
        'receive the token, then again with it.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        username: usernameParam.describe('The account to remove.'),
        confirm_token: confirmTokenParam.optional(),
      },
    },
    async (args) =>
      run(async () => {
        const key = setResourceKey('delete_user', [args.username]);
        if (!confirmations.consume(key, args.confirm_token)) {
          const token = confirmations.issue(key);
          return textResult(
            confirmationPrompt(
              `delete the account "${args.username}" and all of its topic ` +
                'access grants',
              token,
              confirmations.ttlMinutes
            )
          );
        }
        await api.delete('/v1/users', { username: args.username });
        return jsonResult({ deleted: args.username });
      })
  );

  server.registerTool(
    'manage_user_access',
    {
      title: 'Manage topic access',
      description:
        "Sets or removes an account's access to a topic or topic pattern. " +
        'Requires an admin account and a confirmation token.\n\n' +
        'Destructive in both directions, which is why it is gated: taking ' +
        'access away breaks a running publisher, and granting it exposes a ' +
        "topic's traffic to another account.\n\n" +
        'A pattern may end in "*" to cover a family of topics. "deny" writes ' +
        'an explicit refusal — the only way to carve an exception out of a ' +
        'wildcard grant — whereas "revoke" removes the rule entirely, so a ' +
        'broader wildcard or the server default applies again.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        username: usernameParam.describe('The account to change.'),
        topic: topicPatternParam.describe(
          'A topic name, or a prefix ending in "*".'
        ),
        action: z
          .enum(ACCESS_ACTION_NAMES)
          .describe(
            'read_write, read_only, write_only, deny (explicit refusal), or ' +
              'revoke (remove the rule).'
          ),
        confirm_token: confirmTokenParam.optional(),
      },
    },
    async (args) =>
      run(async () => {
        // tupleResourceKey, not setResourceKey: these three are positional and
        // their vocabularies overlap, so sorting them would let a token
        // approved for one (user, topic) pair execute the reverse pair.
        const key = tupleResourceKey('manage_user_access', [
          args.username,
          args.topic,
          args.action,
        ]);
        if (!confirmations.consume(key, args.confirm_token)) {
          const token = confirmations.issue(key);
          const what =
            args.action === 'revoke'
              ? `remove the access rule for "${args.username}" on topic ` +
                `"${args.topic}"`
              : `set "${args.username}" to ${args.action} on topic ` +
                `"${args.topic}"`;
          return textResult(
            confirmationPrompt(what, token, confirmations.ttlMinutes)
          );
        }

        if (args.action === 'revoke') {
          await api.delete('/v1/users/access', {
            username: args.username,
            topic: args.topic,
          });
          return jsonResult({
            username: args.username,
            topic: args.topic,
            action: 'revoke',
          });
        }

        const permission = ACCESS_ACTIONS[args.action];
        await api.put('/v1/users/access', {
          username: args.username,
          topic: args.topic,
          permission,
        });
        return jsonResult({
          username: args.username,
          topic: args.topic,
          permission,
        });
      })
  );
}
