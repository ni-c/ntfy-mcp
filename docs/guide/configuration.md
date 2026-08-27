# Configuration

Everything is an environment variable; there is no config file. See the
[environment variable reference](/reference/environment) for the full table.

## The instance URL

```sh
NTFY_URL=https://ntfy.example.net
```

The only required variable, and the only one with **no default**. `https://ntfy.sh`
would be the obvious default and the worst possible one: a server that was
misconfigured, or never configured, would publish to the public internet instead of
failing.

A malformed URL, a scheme other than `http`/`https`, or credentials embedded in the
URL all stop the server at startup. A missing URL does not — the server has to
complete the MCP handshake and answer `tools/list` without it, so registries and
sandbox inspectors can introspect it. Every call then returns the setup instructions.

Use `https`. Over plain `http` the credentials cross the network unencrypted —
basic auth is base64, not encryption — and the server prints a warning unless the
host is loopback, where `http://127.0.0.1:8080` is a normal local instance and
passes without comment.

## Credentials

Two forms, and they are mutually exclusive:

```sh
NTFY_TOKEN=tk_…                    # an access token

NTFY_USERNAME=publisher            # or basic auth, both together
NTFY_PASSWORD=…
```

Basic auth exists here because `ntfy user add` produces a username and a password
rather than a token, so requiring a token would mean a detour through the token API
for every self-hosted instance.

Setting `NTFY_TOKEN` alongside `NTFY_USERNAME`/`NTFY_PASSWORD` is **refused at
startup** rather than resolved by a precedence rule: which credential is in force
must never be ambiguous. Setting only one of the basic-auth pair is refused for the
same reason.

No credentials at all is a supported state, not an error. An open instance allows
publishing and subscribing anonymously, and refusing to work without credentials
would be wrong for a large share of deployments. The one shape that earns a warning
is anonymous **writes against the public ntfy.sh**, where knowing a topic name is
the whole of the access control.

`NTFY_TOKEN` and `NTFY_PASSWORD` are deleted from `process.env` as soon as they have
been read, before any other branch runs, so neither is visible to a child process or
in `/proc/<pid>/environ`.

## Topics

```sh
NTFY_TOPICS=alerts,deploys,backups
```

One variable does two jobs. The **first entry is the default** for any tool called
without a topic, and the **whole list bounds every tool**, read and write alike — a
call naming a topic outside it is refused before any request is made.

The two are deliberately coupled rather than split into a separate default and an
allowlist. A topic name is a bearer credential on ntfy, and someone who sets a
default without a restriction has bought no safety while believing they have.
Coupling them makes both properties arrive together.

Leaving it unset means no default and no restriction: every tool then needs an
explicit topic, and any topic on the instance is reachable.

Entries must be valid ntfy topics — 1 to 64 characters of letters, digits, `-` and
`_`. A bad entry stops the server and is reported **by position, not by value**,
because a stray line in a compose file is exactly what lands in this variable and
stderr is the host's log file.

## TLS

```sh
NTFY_INSECURE_TLS=true
```

Accepts a self-signed certificate. It is scoped to this connection rather than
setting `NODE_TLS_REJECT_UNAUTHORIZED`, so validation stays on for everything else
in the process. Prefer a proper internal CA in the trust store.

## Read-only, and why it defaults to false

```sh
NTFY_READ_ONLY=true    # registers the six read tools and nothing else
```

**It defaults to `false`**, which is the opposite of
[imap-mcp](https://github.com/ni-c/imap-mcp), where the same variable defaults to
`true`. ntfy exists to publish; a read-only default would ship a notification server
that cannot notify, while a mailbox is an irreplaceable archive. Two consequences
follow from that direction:

- **Only the literal string `true` disables the write tools.** `NTFY_READ_ONLY=ture`
  or `=1` leaves them enabled. Because the default is permissive, a typo fails
  **open** here, where in imap-mcp it fails closed.
- **A client that can publish can publish anywhere on the instance** unless you say
  otherwise. Confirmation tokens do not help against that — publishing is not a
  destructive operation. `NTFY_TOPICS` is the control that does.

The recommended shape for anything unattended:

```sh
NTFY_TOPICS=deploys                 # the server can only touch this topic
NTFY_ALLOW_TOOLS=essential          # or:
NTFY_DENY_TOOLS=delete_messages,create_user,delete_user,manage_user_access
```

On a self-hosted instance, also give the server its own ntfy account with
`write-only` access to exactly the topics it needs. That is the control behind the
control: it holds even if the environment is wrong.

<!-- The heading below is fixed: every repository uses "Choosing the tools that
     load", so /guide/configuration#choosing-the-tools-that-load is the same anchor
     everywhere and the README, the FAQ and the tool reference can all link to it.
     Put it directly after the read-only section — they are the same knob family,
     and that adjacency does half the explaining. -->

## Choosing the tools that load

Read-only mode is one cut, along a line this server drew for you.
`NTFY_ALLOW_TOOLS` and `NTFY_DENY_TOOLS` let you draw your own:

```sh
NTFY_ALLOW_TOOLS=essential
NTFY_ALLOW_TOOLS=publish_message,list_messages
NTFY_DENY_TOOLS=delete_*,create_user,manage_user_access
```

Why bother, when all of them work: a model chooses the right tool far more reliably
from a handful than from a long list, and every tool it can see costs context on
every single request. Thirteen tools is the ceiling here, not the floor. If this is
the only MCP server in a session, the full set is fine. If it is one of six, it is
not.

**The syntax.** Comma-separated entries. An entry is either an exact tool name or a
prefix with a trailing `*` — `list_*` matches every tool whose name starts with
`list_`. Entries are trimmed and case-insensitive, empty ones are ignored, and an
empty value counts as unset. Nothing else is a pattern: `*_user` and `list_*_x` are
rejected rather than silently matching nothing.

**`essential`** is a curated preset: `get_server_info`, `check_topic_access`,
`publish_message`, `list_messages`, `get_message` and `update_message`. It is the
end-to-end story of pointing a model at ntfy — find out what the instance supports,
confirm the topic is usable, send, check that it landed, read it in full, correct
it. Four of the six are read tools, so the preset stays a working combination under
`NTFY_READ_ONLY=true` rather than collapsing to something that can only explain why
it cannot publish. It is marked per tool in the
[tool reference](/reference/tools), from the same constant the filter reads, so the
two cannot drift. It composes — naming a tool alongside it puts that one back, and
`NTFY_DENY_TOOLS` takes one away.

**Both together.** `NTFY_ALLOW_TOOLS` decides what is in; `NTFY_DENY_TOOLS` is then
subtracted from the result. With only a deny list, everything else stays.

**A name that matches nothing stops the server**, with the offending entry and the
list of real names. That is deliberate: the alternative is a tool quietly missing
from `tools/list`, and nobody traces an absence back to an environment variable. The
same applies to a pattern that matches no tool.

**With read-only mode**, the write tools are not registered at all, so naming one
explicitly in `NTFY_ALLOW_TOOLS` is an error that says so — rather than calling a
tool unknown when it plainly exists. A _pattern_ that covers write tools is fine and
simply contributes nothing, which is what makes `get_*,delete_*` a usable template
for both kinds of deployment; and `NTFY_ALLOW_TOOLS=essential` narrows to the read
half of the preset.

::: tip It is the same cut, not a second one
A filtered tool is never registered, so it is absent from `tools/list` and unknown to
`tools/call` alike — exactly what `NTFY_READ_ONLY` does to a write tool. There is no
"hidden but callable" state to reason about.
:::
