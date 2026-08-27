# Security

This page is the prose version of
[SECURITY.md](https://github.com/ni-c/ntfy-mcp/blob/main/SECURITY.md).

## Trust model

The credentials this server holds are ntfy credentials, and what they grant depends
entirely on what the ntfy account is allowed to do — so the answer is "as much as
you gave it", and the useful advice is to give it little.

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

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result.

## A topic name is a bearer credential

On an instance with the default `auth-default-access`, anyone who knows a topic name
can subscribe to it and publish to it. There is no membership to check and nothing
to revoke — the name is the credential.

Two things follow. Set `NTFY_TOPICS` so this server can only touch the topics you
meant, and treat the names the way you would treat a password. The server does its
part: the account's `sync_topic` is stripped out of `get_account`, and the first
`NTFY_TOPICS` entry is the default for tools called without a topic, so the name
does not have to travel through the tool arguments to be used.

## Writes are registered by default

`NTFY_READ_ONLY` defaults to `false` because ntfy exists to publish. The residual
risk that follows is worth stating plainly: a prompt-injected client can publish
what it has just read to another topic on the same instance. Confirmation tokens do
not help there, because publishing is not a destructive operation. `NTFY_TOPICS` is
the control that does, and an ntfy account scoped to those topics is the control
behind it.

## Confirmation tokens

`delete_messages`, `delete_user` and `manage_user_access` are refused on the first
call and answered with a short-lived, single-use token bound to a fingerprint of the
**exact** target. Only a second call carrying that token performs the operation.

The binding is what makes it worth having. A confirmation issued for one target
cannot execute another, cannot execute a longer list of message ids the model chose
afterwards, and — for `manage_user_access`, whose three arguments overlap in
vocabulary — cannot execute the same three values in a different order. A model
cannot mint a token either: it only ever exists in a previous result from this
server, so an instruction hidden in a notification cannot satisfy the gate.

Confirmation prompts never quote content that came from ntfy. They name the topic,
the count or the username and nothing else, because that text is read by a model.

## Untrusted content

Everything in a notification was written by whoever could publish to the topic, so
`list_messages`, `get_message`, `get_account` and `list_users` frame their results as
untrusted **data** rather than as this server speaking. Usernames and grant patterns
are included in that: on an instance with signup enabled, anyone on the internet
chooses their own username.

`get_server_info` is the exception, and deliberately so — its four sections are the
instance's own configuration and counters, set by whoever runs the server this client
was pointed at, and half of the object is derived locally rather than fetched.

## Access tokens are stripped from get_account

`GET /v1/account` returns every access token of the account **in plaintext**
(verified against ntfy 2.27.0). Each one is overwritten with `(redacted)` rather than
omitted — a caller seeing no `token` key at all could reasonably read it as "this
entry had none". No tool in this server creates, reads or exchanges a token either,
because every such endpoint hands back a live credential that would then live in the
conversation transcript.

`list_users` projects the four fields it is about instead of forwarding whatever ntfy
sent. A denylist would only remove the sensitive keys known today; a newer or forked
ntfy that adds a password hash to the user record would ship it into the transcript
with no change here.

## URLs must be http or https

`click`, `icon`, `attach` and every action-button URL are restricted to the `http:`
and `https:` schemes. ntfy stores whatever it is given — 2.27.0 accepted
`javascript:alert(1)` as a `click` value without comment — and the reason this
matters more than in an ordinary fetch guard is that **ntfy does not open these
URLs. The recipient's phone does.** A `click` or `icon` is handed to a mobile client
and to the web app, and an `http` action button is an outbound request originating on
the recipient's device with a caller-controlled method, headers and body.

The check is scheme-only, with no private-address rule, and that is the right shape:
a request to a device on the recipient's own network is the *intended* use of an
`http` action for home automation, and it never leaves that network.

The download name of an attachment is checked separately — no path separators, no
traversal, no control characters — because it is a filename on somebody else's
device.

## Every publisher-controlled field is bounded

ntfy caps the message body at 4096 bytes but not the title or the tag list, so those
are capped here. The body cap is enforced client-side too, and not out of politeness:
an oversized body is treated by ntfy as an attachment upload, so the error that comes
back is `40014 attachments not allowed`, which says nothing about size and sends
whoever reads it looking in the wrong place entirely. The count is in **bytes** — a
`.max(4096)` on characters would pass 4096 emoji, about 16 kB on the wire.

Topic names are validated before they reach a URL path. ntfy's failure mode there is
unusually bad: a path that does not match its topic pattern falls through to the
static file handler, so `GET /has.dot/json` answers **200 with the web app's HTML**.
Without the check that page is what the model would have to interpret.

## What is deliberately absent

- **Sending email or placing a phone call** from a published message. ntfy supports
  both; a tool that mails an arbitrary address on model output is a spam relay driven
  by injectable content, and `call` places a real, billable call.
- **Creating, reading or exchanging an access token.**
- **Streaming subscriptions** (`/sse`, `/ws`, `/raw`).
- **Attachment upload** — by URL only.

An absent tool cannot be called, which is the same reason `NTFY_READ_ONLY=true` does
not register the write tools rather than refusing them at call time, and why
`NTFY_DENY_TOOLS` cuts along the same line.

## Reporting a vulnerability

Use
[private vulnerability reporting](https://github.com/ni-c/ntfy-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.
