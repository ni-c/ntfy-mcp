/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and in read-only mode the write tools are
 * never registered at all. Deriving the catalogue from what actually reached
 * `registerTool` would make `NTFY_ALLOW_TOOLS=delete_messages` report "unknown
 * tool" under `NTFY_READ_ONLY=true`, which is the one answer that is wrong.
 *
 * This is also the full tool surface, hard-coded on purpose: a tool that appears
 * or disappears by accident is a change to the server's contract and has to be a
 * deliberate edit here. `test/tool-filter.test.ts` asserts that these lists and
 * the tools the server really registers are the same set, so the duplication
 * cannot drift — and the test file no longer keeps a second copy of the names.
 */

/** Registered always. Every one carries `readOnlyHint: true`. */
export const READ_TOOLS = [
  'list_messages',
  'get_message',
  'check_topic_access',
  'get_server_info',
  'get_account',
  'list_users',
] as const;

/** Registered unless `NTFY_READ_ONLY` is set. */
export const WRITE_TOOLS = [
  'publish_message',
  'update_message',
  'mark_messages_read',
  'delete_messages',
  'create_user',
  'delete_user',
  'manage_user_access',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * What `NTFY_ALLOW_TOOLS=essential` selects.
 *
 * The end-to-end story of pointing a model at ntfy: find out what the instance
 * supports, confirm the topic is usable, send, check that it landed, read it in
 * full, correct it. Four of the six are read tools, so the preset stays a
 * working combination under `NTFY_READ_ONLY=true` instead of collapsing to
 * something that only explains why it cannot publish.
 *
 * `get_server_info` earns its place — on ntfy `/v1/config` is capability
 * discovery rather than administration, it is a small fixed-size payload, and it
 * is the one call that works before the credentials are right.
 *
 * Left out deliberately: everything irreversible (`delete_messages`,
 * `delete_user`), everything administrative (`create_user`,
 * `manage_user_access`, `get_account`), the largest payload here (`list_users`),
 * and `mark_messages_read`, which is a triage nicety rather than part of the
 * main task.
 *
 * `test/tool-filter.test.ts` checks every name here exists and that the list is
 * within 5..8.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'get_server_info',
  'check_topic_access',
  'publish_message',
  'list_messages',
  'get_message',
  'update_message',
];
