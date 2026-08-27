# Environment variables

All configuration is by environment variable; there is no config file.

| Variable            | Required | Default   | Description                                                                                   |
| ------------------- | -------- | --------- | --------------------------------------------------------------------------------------------- |
| `NTFY_URL`          | yes      | —         | Base URL of the ntfy instance, e.g. `https://ntfy.example.net`. There is deliberately no default |
| `NTFY_TOKEN`        | no       | —         | Access token (`tk_…`). Mutually exclusive with the two below                                  |
| `NTFY_USERNAME`     | no       | —         | Basic-auth user. Must be set together with `NTFY_PASSWORD`                                    |
| `NTFY_PASSWORD`     | no       | —         | Basic-auth password                                                                           |
| `NTFY_TOPICS`       | no       | —         | Comma-separated topics this server may use. The first is the default when a tool omits one, and the list restricts every tool, read and write |
| `NTFY_READ_ONLY`    | no       | `false`   | Exactly `true` registers only the six read tools. Note the default                            |
| `NTFY_ALLOW_TOOLS`  | no       | —         | Tool names, `list_*` prefixes or `essential`; only these register                             |
| `NTFY_DENY_TOOLS`   | no       | —         | Same syntax; subtracted from whatever the allow list left                                     |
| `NTFY_INSECURE_TLS` | no       | `false`   | `true` accepts self-signed certificates, scoped to this connection                            |

## `NTFY_URL` has no default

`https://ntfy.sh` would be the obvious default and the worst possible one: a server
that was misconfigured, or never configured, would publish to the public internet
rather than failing.

A missing URL is a warning, not a fatal error — the server has to complete the MCP
handshake and answer `tools/list` without it, so registries and sandbox inspectors
can introspect it. Every call then returns setup instructions. A URL that does not
parse, uses a scheme other than `http`/`https`, or carries credentials in the URL
does stop the server; that one could send the credentials to the wrong host.

Use `https://`. Over plain `http` the credentials cross the network unencrypted, and
the server warns unless the host is loopback — `http://127.0.0.1:8080` for a local
instance passes without comment.

## Credentials are optional, and exclusive

An open ntfy instance allows publishing and subscribing without credentials, so
anonymous is a supported state rather than an error.

Where credentials exist there are two forms: an access token in `NTFY_TOKEN`, or
`NTFY_USERNAME` together with `NTFY_PASSWORD`. Basic auth is here because
`ntfy user add` produces a username and a password rather than a token.

::: danger Setting both forms stops the server
`NTFY_TOKEN` alongside `NTFY_USERNAME`/`NTFY_PASSWORD` is refused at startup rather
than resolved by a precedence rule. Which credential is in force must never be
ambiguous. Setting only one half of the basic-auth pair is refused for the same
reason.
:::

`NTFY_TOKEN` and `NTFY_PASSWORD` are read once and then deleted from `process.env`,
before any other branch runs, so neither is visible to a child process or in
`/proc/<pid>/environ`.

## `NTFY_TOPICS` is a default and a fence

```sh
NTFY_TOPICS=alerts,deploys,backups
```

The first entry is the default for any tool called without a topic; the whole list
bounds every tool, read and write. One variable rather than a separate default and
allowlist, because a topic name is a bearer secret on ntfy and someone who sets a
default without a restriction has bought no safety while believing they have.

Unset means no default and no restriction. Every entry must be a valid ntfy topic —
1 to 64 characters of letters, digits, `-` and `_` — and a bad entry stops the
server, reported by **position rather than by value**: a stray line in a compose file
is what lands in this variable, and stderr is the host's log file.

## `NTFY_READ_ONLY` defaults to `false`

Unlike [imap-mcp](https://github.com/ni-c/imap-mcp), where the same variable defaults
to `true`. ntfy exists to publish, and a read-only default would ship a notification
server that cannot notify.

**Only the literal string `true` disables the write tools.** `NTFY_READ_ONLY=ture`
or `=1` leaves them enabled — because the default is permissive, a typo fails open
here. The destructive tools are gated behind confirmation tokens and ntfy's own
permissions instead, and `NTFY_ALLOW_TOOLS=essential` or a `NTFY_DENY_TOOLS` list is
the recommended hardening:

```sh
NTFY_TOPICS=deploys
NTFY_ALLOW_TOOLS=essential          # or:
NTFY_DENY_TOOLS=delete_messages,create_user,delete_user,manage_user_access
```

## Narrowing the tool list

`NTFY_ALLOW_TOOLS` and `NTFY_DENY_TOOLS` are comma-separated. Each entry is either an
exact tool name or a prefix with a single trailing `*`:

| Value                            | Registers                                                       |
| -------------------------------- | --------------------------------------------------------------- |
| `essential`                      | the curated six, marked in the [tool reference](/reference/tools) |
| `publish_message,list_messages`  | exactly those two                                               |
| `list_*`                         | `list_messages`, `list_users`                                   |
| `essential,get_account`          | the preset plus one more                                        |
| `*`                              | everything — the same as leaving it unset                       |

Entries are trimmed and matched case-insensitively; empty entries are ignored, and a
value that is empty or only whitespace counts as unset — `NTFY_ALLOW_TOOLS=` in a
compose file does not mean "allow nothing". `essential` is recognised only in the
allow list.

**An entry that matches no tool aborts startup**, naming the entry and listing the
valid names, as does a malformed pattern such as `*_user` or `list_*_x`. The
alternative — ignoring the entry — leaves a tool missing from `tools/list` with
nothing pointing at the cause. If both lists together remove everything, the server
refuses to start rather than offering an empty tool list.

Under `NTFY_READ_ONLY`, an exact write-tool name in the allow list is an error naming
the read-only setting rather than "unknown tool"; a pattern covering write tools is
accepted and merely contributes nothing, with a warning on stderr. A preset member
that read-only suppresses is dropped silently, because nobody typed it. Deny entries
are exempt throughout: denying an already-suppressed tool is how a defensive list is
written.

## `NTFY_INSECURE_TLS`

`true` accepts a self-signed certificate. It is scoped to this connection rather than
setting `NODE_TLS_REJECT_UNAUTHORIZED`, so certificate validation stays on for
everything else in the process. Prefer a proper internal CA in the trust store.
