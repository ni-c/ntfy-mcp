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

Data returned from the upstream API is untrusted input. It is marked as such in
both channels of every result, and it is stripped of control characters and lone
surrogates before it is reported — a notification title is a terminal control
sequence if nothing removes the escapes, and a half of a surrogate pair survives
`JSON.stringify` only to break the client that has to encode it. Confirmation
prompts never quote upstream text at all, nor the password `create_user` was
given, which is a live credential and belongs neither in the prompt nor in the
token's binding; values the _caller_ chose appear on their own labelled lines
rather than inside this server's sentence.

## An approval is single-use, per process

The sealed state behind the dialog carries a nonce, and it is spent the first
time it is verified — accepted or declined alike. Presenting the same
`requestState` a second time is refused, so an approved operation cannot be run
again by replaying the answer the client already holds. That is
`mcp-approval` 0.8.1 and newer; this server requires 0.8.2, and the Docker image
is built from the lockfile, so the pin is the guarantee.

Read the residual risk exactly: **the record of spent states lives in this
process**. A stdio server is spawned per session, so the process is the flow and
there is nothing half-finished to resume once it ends — but a restart forgets
what was spent, and if more than one process were ever to serve the two halves of
one flow they would not share the record. The two-call token used where a client
cannot show a dialog is the same shape: a secret this server keeps and deletes on
use, held in the same process.

The confirmation is bound as well as fresh. Each guarded tool builds a resource
key from the exact target, so a token issued for one call cannot execute a
different one:

- `manage_user_access` is keyed on (username, topic, action) and `update_message`
  on (topic, sequence id, content) — positionally, with `orderedResourceKey`. In
  both, the vocabularies overlap: a username is a legal topic name, and a
  twelve-character message id is one too, so a key built from a _sorted_ set of
  those parts would let a confirmation for "grant alice read_only on topic
  deploy" also execute "grant deploy read_only on topic alice".
- `update_message` includes the content it will write, because the call carries
  the whole content schema — `actions` included, and an `http` action button
  fires from the recipient's device. A confirmation obtained for a corrected
  typo must not be redeemable for a call that adds a button.
- `create_user` is keyed on (username, tier); `delete_user` and
  `delete_messages` on the account or the exact set of ids.
- The password `create_user` is given is in neither the key nor the prompt. It
  is a live credential, and both of those are read back.

## What is idempotent, and what is not

`publish_message` is the one operation here that genuinely acts twice, and it is
deliberately not guarded — so no approval state exists to replay, and its
at-least-once behaviour is the ordinary property of retrying a tool call. It is
stated plainly because ntfy offers no way to fix it: the API has no idempotency
key and no client-supplied message id, and `sequence_id` revises a notification
whose id you already hold rather than suppressing a duplicate first publish.
Reading the topic before publishing would not be that fix either — the
write-only account recommended above cannot poll, a message published with
`cache: false` is not in the cache to be found, and two identical alerts are
frequently what somebody meant. A duplicate notification is noise; the honest
statement is that it can happen.

The five guarded tools each land on the same world however often they run, which
is what their `idempotentHint: true` claims:

- `create_user` and `delete_user` fail on the second run, and the account exists
  or does not exactly as it did after the first.
- `manage_user_access` writes or removes one rule for one account on one topic.
- `delete_messages` re-publishes a `message_delete` event for a message
  subscribers have already been told to drop. ntfy never removed it from the
  cache, so there is nothing left to delete a second time.
- `update_message` re-applies the same revision — the content is part of the
  confirmation key, so a redemption carries the same text by construction.

## Credentials never reach the model

The ntfy credential travels in an `Authorization` header, and the HTTP layer's
refusal of a malformed header value **quotes the value**. A token with a line
break in the middle of it — what a wrapped paste, or `$(cat token)` of a wrapped
file, produces — would otherwise reach the model's context through an ordinary
tool result. Two checks close it: `loadConfig` refuses a credential that cannot
travel in a header at startup, naming the variable, the length and the position
of the offending character but never the value; and every request checks the
header it is about to send, so a `Config` built without `loadConfig` is covered
too.

The same rule applies to the variables beside the credential. A diagnostic quotes
a configuration value only when its shape makes that safe — short and
word-shaped — and describes everything else by its length. `NTFY_URL` is never
echoed, not even its scheme: a hexadecimal key with a colon after it is a valid
URL whose scheme is the key.

## Availability

A refused login is remembered for ten seconds and repeated from memory rather
than sent again. This is not politeness: ntfy keeps a failed-authentication
limiter **per visitor address** (`authLimiter` in `server/visitor.go`, spent by
`maybeAuthenticate` in `server/server_auth.go`), and once its budget is gone the
instance answers `42909` to _every_ request from that address, healthy traffic
included. Every read tool here is annotated read-only, idempotent and cheap and
answers a wrong credential with "check NTFY_TOKEN" — which is exactly what a
model retries.

Answers are bounded on the string the caller actually receives, not on a
serialisation of the value behind it. Response bodies are read under a counted
ceiling, error bodies under their own much smaller one, and the status of a
response is decided before a byte of its body is read — so a reverse proxy
answering a 401 with a two-megabyte login page is still reported as a 401.
