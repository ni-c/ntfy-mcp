# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/ntfy-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

The credentials this server holds are ntfy credentials, and what they grant depends
entirely on what the ntfy account is allowed to do — so the answer is "as much as you
gave it", and the useful advice is to give it little.

- **A publishing token** can send notifications to the topics it is granted. Those
  notifications reach real devices, so the practical damage is noise, plausible
  phishing in your own alerting channel, and — if the account also has read access —
  a way to move data off the instance by publishing it to a topic somebody else is
  subscribed to.
- **An admin account** can enumerate every account on the instance, create accounts,
  and grant or revoke access to any topic. That is the whole authorization model of
  the ntfy server. Do not give this server an admin account unless you are actually
  using the user and access tools, and prefer a dedicated non-admin account with
  `write-only` access to the topics it needs.

Two ntfy-specific things worth stating plainly:

- **A topic name is a bearer credential.** On an instance with the default
  `auth-default-access`, anyone who knows a topic name can subscribe to it and publish
  to it. Set `NTFY_TOPICS` so this server can only touch the ones you meant, and treat
  the names the way you would treat a password. The list bounds the account tools as
  well as the message tools: `manage_user_access` refuses a grant pattern that
  reaches past it — `*` always does, and so does any prefix — and `list_users`
  reports grants against the allowed topics only, rather than handing back the name
  of every topic on the instance.
- **The write tools are registered by default.** `NTFY_READ_ONLY` defaults to `false`
  because ntfy exists to publish. The residual risk that follows: a prompt-injected
  client can publish what it has just read to another topic on the same instance.
  Confirmation tokens do not help, because publishing is not a destructive operation.
  `NTFY_TOPICS` is the control that does, and an account scoped to those topics is the
  control behind it.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a system whose data you would not put in a model's context.

Five operations **ask a person** through MCP elicitation: `delete_messages`,
`delete_user`, `manage_user_access`, `create_user` and `update_message`. That is a
dialog raised by the server and shown by the client, which the model cannot answer on
its behalf; nothing happens until an answer comes back, and the approval is bound to a
fingerprint of the exact target.

`update_message` is on that list because of what ntfy ≥ 2.16 does with it: the
revision replaces the notification **on the subscribers' devices**, so the text they
were shown is gone everywhere but this server's cache. It also carries the full
content schema, `actions` included — an `http` button fires from the recipient's
phone with a method, headers and body chosen by the caller — so an unguarded update
could turn a delivered alert into a button that calls something.

Where the client cannot show a dialog they fall back to a server-generated token
bound the same way. That fallback is weaker and this server says so rather than
implying somebody approved: it proves the call was made twice with the same
arguments, and nothing more. `ELICITATION=false` moves a capable client onto it
deliberately — it does not remove the guard, and the server prints one line at
startup saying it is off.

Data returned from the upstream API is untrusted input: it is marked as such, and
confirmation prompts never quote it — nor the password `create_user` was given,
which is a live credential and belongs neither in the prompt nor in the token's
binding.

## An approval proves binding, not freshness

The sealed state behind the dialog carries no nonce and nothing is spent when it is
verified, so the same answer can be submitted again until it expires — see
[`mcp-approval`'s own security notes](https://github.com/ni-c/mcp-approval/blob/main/SECURITY.md).
Whoever can replay it received the question in the first place and is therefore the
client, so this is not a way around the person; what it does mean is that
**at-most-once is not guaranteed on the dialog path**. A retried leg, a gateway that
re-sends or a host that reconnects mid-flow can run an approved operation twice. The
two-call token is the opposite — it is a secret this server keeps and deletes on use.

At-most-once is the server's job, and here the answer is that the five guarded tools
do not need it. Each of them lands on the same world either way, which is what their
`idempotentHint: true` claims:

- `create_user` and `delete_user` fail on the second run, and the account exists or
  does not exactly as it did after the first.
- `manage_user_access` writes or removes one rule for one account on one topic.
- `delete_messages` re-publishes a `message_delete` event for a message subscribers
  have already been told to drop. ntfy never removed it from the cache, so there is
  nothing left to delete a second time.
- `update_message` re-applies the same revision. A replay carries the same arguments
  by definition, so subscribers end up looking at the text they are already looking
  at.

**`publish_message` is the one operation here that genuinely acts twice**, and it is
deliberately not guarded — so no approval state exists to replay, and its
at-least-once behaviour is the ordinary property of retrying a tool call rather than
anything this section introduces. It is stated plainly because ntfy offers no way to
fix it: the API has no idempotency key and no client-supplied message id, and
`sequence_id` revises a notification whose id you already hold rather than
suppressing a duplicate first publish. Reading the topic before publishing would not
be that fix either — the write-only account recommended above cannot poll, a message
published with `cache: false` is not in the cache to be found, and two identical
alerts are frequently what somebody meant. A duplicate notification is noise; the
honest statement is that it can happen.
