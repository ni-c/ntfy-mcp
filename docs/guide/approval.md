# Asking a person

Five of the thirteen tools change who can reach this instance, or take
notifications away from people who may not have read them yet. All five **ask a
person first**.

Not a `confirm: true` argument the model can set. Not a token the model reads out
of its own previous result. A dialog, raised through [MCP
elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation),
that goes to the client and is shown to whoever is sitting there.

The specification says a client _should_ keep a human in the loop:

> there **SHOULD** always be a human in the loop with the ability to deny tool
> invocations

This server does not rely on that. It raises the question itself, and until an
answer comes back, nothing happens.

## What asks, and when

| Tool | When it asks |
| --- | --- |
| `delete_messages` | always |
| `delete_user` | always |
| `manage_user_access` | always |
| `create_user` | always |
| `update_message` | always |
| everything else | never |

`create_user` is the odd one on that list, because it destroys nothing. It is the
mirror image of `delete_user`: bringing an account into existence is a change to
who may reach this instance, and no annotation carries that — `destructiveHint` is
about what a call takes away. Its own annotation has said “which is why it is
guarded” since the tool was written, and it was not.

Publishing is deliberately **not** on the list. Sending a notification destroys
nothing, and it reaches people who cannot un-receive it — an outbound effect, not
a destructive one. The control for that is `NTFY_TOPICS`, which bounds where this
server may publish at all, and an ntfy account scoped to those topics behind it. A
dialog before every notification would be how people learn to tick without
reading.

`update_message` looks like publishing's sibling and is not, which is why that
argument stops before it. From ntfy 2.16 a revision replaces the notification **on
the subscribers' devices**: the text they were shown is gone everywhere but this
server's cache, so it takes something away rather than only adding one. It also
carries the same content schema as `publish_message`, `actions` included, and an
`http` button fires from the recipient's phone with a method, headers and body the
caller chose. What is confirmed is the notification, not the new text — binding the
content would ask again for every corrected typo while proving nothing.

## What the dialog contains

Topics, counts and usernames. Never the content of a notification, which was
written by whoever could publish to the topic — on an open instance, anyone who
knows its name.

And never the **password** `create_user` was given. It is a live credential, and
the prompt is read back by a person and by a model alike, so it is in neither the
text nor the token's binding. A consequence worth knowing: on the fallback path a
token issued for one password works with another, because what the approval is
about is the account name.

```
This will create the account "publisher".

It becomes an account on this instance. Nothing is reachable through it until
manage_user_access grants a topic — but whoever has the password can then
authenticate as it.
```

The approval is bound to its target, so one obtained for a call cannot be
replayed against another. For a *set* of targets the binding is a fingerprint of
the exact list: an approval for `["a"]` does not execute `["a", "b"]`.

## Clients that cannot show a dialog

Not every MCP client implements elicitation, and a stateless gateway may not be
able to speak for the one it is currently serving. Rather than refuse to work —
which pushes people towards switching the guard off entirely — the tool falls
back to a **two-call token**: the first call returns a random string, the second
has to quote it back.

Be clear about what that proves, because this server is:

> the token proves the call was made twice with the same arguments, and nothing
> more.

A model can read the token out of the first result and call again in the same
turn without anybody seeing it. It catches a widened target set; it does not
catch a model that was talked into the whole thing. The fallback text says so
rather than implying somebody approved.

## Switching the dialog off

```sh
ELICITATION=false
```

Default is `true`. `false` does **not** remove the guard — it takes the fallback
path above, which means the token. There is no setting in which a guarded call
goes unannounced.

Use it where a dialog is the wrong shape rather than an unwanted one: a scheduled
job, a test harness, a client whose dialog interrupts something else.

::: warning It is deliberately not prefixed
`ELICITATION` has no `NTFY_` in front of it, so one
`export ELICITATION=false` — or one `-e ELICITATION=false` in a compose file —
reaches **every** MCP server in that environment, not just this one. That is the
point of it and also its risk.

Two things make it visible rather than silent:

- a server started with it off prints one line at startup, in the log of every
  server it actually reached:

  ```
  ntfy-mcp: ELICITATION=false — guarded tools fall back to the two-call token
  ```

- the fallback text names the server that did not ask, instead of blaming a
  client that was working fine.
  :::

Anything other than `true` or `false` — `1`, `off`, `yes` — **stops the server**
with exit code 1 and a message naming both valid values. This is the only
variable in this family that defaults to _on_: a typo that fell back to the
default would leave the dialog running while the operator believed it was off,
and there would be nothing to tell them.

## Annotations are the other half, and they are only a hint

Every tool of this server declares all four MCP tool annotations —
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — so a
client can tell before it calls what a call would do. See
[Tools](/reference/tools).

They are advice, and the specification says so:

> clients **MUST** consider tool annotations to be untrusted unless they come
> from trusted servers

An annotation is something a client may ignore. The dialog is not: it is enforced
here, on the server side, and no answer means no change. The two are different
claims — the annotation says what a call _does_, the dialog decides whether it
_happens_ — so the two lists are related but not the same. `create_user` is the
standing example in the other direction: it destroys nothing, and it is guarded.

## An approval proves binding, not freshness

The state that carries a dialog's answer back is sealed, and the seal proves the
question was this server's and named this target. It does not prove the answer is
being used for the first time: it carries no nonce, and verifying it spends
nothing, so the same answer can be submitted again until it expires. Whoever can
do that received the question in the first place and is the client — this is not a
route around the person — but it does mean **at-most-once is not guaranteed on the
dialog path**. The two-call token is the opposite: it is a secret the server keeps
and deletes on use.

Every guarded tool here is idempotent in effect, so a repeated leg lands on the
same instance: `create_user` and `delete_user` fail the second time, the access
rule is written or removed once, a second delete re-announces a deletion
subscribers were already told about, and a replayed `update_message` re-applies
the revision it applied before. `publish_message` is the one operation that
genuinely acts twice, and it is unguarded — so there is no approval state to
replay, and ntfy offers no idempotency key that would make it safe to retry
blindly. See the [security policy](https://github.com/ni-c/ntfy-mcp/blob/main/SECURITY.md).

## Behind a gateway

Both protocol revisions are handled from one code path. On `2025-11-25` the
question is pushed to the client; on `2026-07-28` there is no server→client
channel at all, so the call returns `input_required`, ends, and the client
retries carrying the answer.

That answer arrives as ordinary request content, which the SDK does not
validate — so the state that ties an answer to its question is sealed (HMAC). A
reply whose seal does not open, or opens onto a different target, counts as **no
answer** and produces a fresh question rather than an error. The likeliest cause
is not an attack: it is a gateway that put the server to sleep while the person
was reading.

If you run this behind [mcp-hub](https://github.com/ni-c/mcp-hub), the hub passes
elicitation through in both directions; see its
[elicitation guide](https://ni-c.github.io/mcp-hub/guide/elicitation).
