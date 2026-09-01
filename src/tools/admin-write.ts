import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { setResourceKey } from 'mcp-approval';
import type { Approver, ConfirmationStore } from 'mcp-approval';

import { tupleResourceKey } from '../resource-key.js';
import {
  confirmTokenParam,
  topicPatternParam,
  usernameParam,
} from '../schema.js';

import type { NtfyApi } from '../api.js';
import { errorResult, jsonResult, run } from '../result.js';

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
  confirmations: ConfirmationStore,
  approval: Approver
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
        'Asks a person first; where the client cannot show a dialog, call once ' +
        'to receive a token and again with it.\n\n' +
        'Be aware that a password passed as a tool argument stays in the ' +
        'conversation transcript. For an account that matters, create it on ' +
        'the server instead.',
      annotations: {
        // Additive: it brings an account into existence. A privilege change
        // rather than a destruction — which is why it is guarded, not why it
        // would be destructive.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
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
        confirm_token: confirmTokenParam.optional(),
      }),
    },
    async (args, mcp) =>
      run(async () => {
        // The mirror image of delete_user, which is guarded: bringing an
        // account into existence is a change to who may reach this instance,
        // and the annotation cannot say that — destructiveHint is about what a
        // call takes away, and this takes nothing away.
        //
        // The password is in neither the key nor the text. It is a live
        // credential and both of those are read back: the key would put it in
        // the fallback token's binding, and the text in front of a person and
        // a model.
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `create the account "${args.username}"`,
            consequence:
              'It becomes an account on this instance. Nothing is reachable ' +
              'through it until manage_user_access grants a topic — but ' +
              'whoever has the password can then authenticate as it.',
            resourceKey: setResourceKey('create_user', [args.username]),
            token: args.confirm_token,
            toolName: 'create_user',
            title: `Create the account "${args.username}"?`,
            hint: 'Tick to create it, leave it to cancel.',
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult('The user declined. create_user did nothing.');
        }
        if (outcome.decision === 'pending') return outcome.result;

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
      annotations: {
        // Idempotent by the specification's wording — the second call fails,
        // but the world is the same either way. Every access grant attached
        // to the account goes with it.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        username: usernameParam.describe('The account to remove.'),
        confirm_token: confirmTokenParam.optional(),
      }),
    },
    async (args, mcp) =>
      run(async () => {
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what:
              `delete the account "${args.username}" and all of its topic ` +
              'access grants',
            consequence:
              'The account and every access grant attached to it are removed.',
            resourceKey: setResourceKey('delete_user', [args.username]),
            token: args.confirm_token,
            toolName: 'delete_user',
            title: `Delete the account "${args.username}"?`,
            hint: 'Tick to go ahead, leave it to cancel.',
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(`The user declined. delete_user did nothing.`);
        }
        if (outcome.decision === 'pending') return outcome.result;

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
      annotations: {
        // Replaces the rule for a user on a topic, and revoking takes access
        // away with no record of what it was.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
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
      }),
    },
    async (args, mcp) =>
      run(async () => {
        // tupleResourceKey, not setResourceKey: these three are positional and
        // their vocabularies overlap, so sorting them would let a token
        // approved for one (user, topic) pair execute the reverse pair.
        // tupleResourceKey, not setResourceKey: these three are positional and
        // their vocabularies overlap, so sorting them would let a token
        // approved for one (user, topic) pair execute the reverse pair.
        const what =
          args.action === 'revoke'
            ? `remove the access rule for "${args.username}" on topic ` +
              `"${args.topic}"`
            : `set "${args.username}" to ${args.action} on topic ` +
              `"${args.topic}"`;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: what,
            consequence:
              'Access rules take effect immediately for anyone using that account.',
            resourceKey: tupleResourceKey('manage_user_access', [
              args.username,
              args.topic,
              args.action,
            ]),
            token: args.confirm_token,
            toolName: 'manage_user_access',
            title: 'Change this access rule?',
            hint: 'Tick to go ahead, leave it to cancel.',
          }
        );
        if (outcome.decision === 'rejected') return errorResult(outcome.reason);
        if (outcome.decision === 'declined') {
          return errorResult(
            `The user declined. manage_user_access did nothing.`
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

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
