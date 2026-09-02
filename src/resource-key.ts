import { createHash } from 'node:crypto';

/**
 * Resource key for an operation whose arguments are positional.
 *
 * Deliberately **not** `setResourceKey` from mcp-approval, which sorts its
 * targets. Sorting would be a security bug here rather than a convenience:
 * `manage_user_access` is confirmed on (username, topic, action), and those
 * three vocabularies overlap almost entirely — a username is a legal topic, and
 * every action name is a legal value for either. Under a sort, confirming
 * "grant alice read_only on topic deploy" produces the same key as "grant
 * deploy read_only on topic alice", so a token approved for one account and
 * topic would execute a grant on a different pair that was never shown to
 * anyone.
 *
 * `update_message` uses it for the weaker version of the same reason: a topic name
 * and a twelve-character message id are both letters and digits, so a sorted key
 * would give (topic, id) and (id, topic) the same fingerprint.
 *
 * Where the targets really are a set — the ids in `delete_messages` — the
 * library's `setResourceKey` is the right one and is what that tool uses.
 */
export function tupleResourceKey(operation: string, parts: string[]): string {
  return `${operation}:${createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 16)}`;
}
