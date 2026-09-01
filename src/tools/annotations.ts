/**
 * The annotation block every reading tool of this server carries, and the rule
 * the writing ones follow.
 *
 * Written out rather than left to the defaults, because the defaults are not
 * neutral: the specification says `destructiveHint` and `openWorldHint` both
 * default to **true**, so an omitted field is the *stronger* claim. A tool that
 * says nothing is a destructive tool in an open world.
 *
 * The line this family draws for `destructiveHint`:
 *
 *   **Content that a person wrote, replaced with no way back — destructive.**
 *   **A setting, a state or a marker, changed — not destructive.**
 *
 * `publish_message` is the one that does not fit either half, and it is worth
 * being honest rather than tidy about it. Sending a notification destroys
 * nothing — but it does reach people's phones, and it cannot be recalled. That
 * is an outbound effect, not a destructive one, and no annotation carries it.
 * The tool description is where it belongs; `destructiveHint: true` would put
 * the warning on the wrong axis and make the field mean two things.
 *
 * `openWorldHint: false`: this server talks to the one ntfy it is configured
 * for. That the notification then travels to whoever subscribes to the topic is
 * ntfy's job, not a property of the tool call.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
