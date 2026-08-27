# ntfy-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/ntfy-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/ntfy-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40ni-c%2Fntfy-mcp)](https://www.npmjs.com/package/@ni-c/ntfy-mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40ni-c%2Fntfy-mcp)](https://www.npmjs.com/package/@ni-c/ntfy-mcp)
[![node](https://img.shields.io/node/v/%40ni-c%2Fntfy-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/%40ni-c%2Fntfy-mcp)](LICENSE)
[![docs](https://img.shields.io/badge/docs-ntfy--mcp.ni--c.de-informational)](https://ntfy-mcp.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[ntfy](https://ntfy.sh), the pub-sub notification service that sends push messages
to your phone with an HTTP request and nothing else.

Lets MCP clients like Claude Code, Claude Desktop or Codex send you notifications,
read back what was sent, revise a notification in place while a job runs, and — with
an admin account — create accounts and grant or revoke their access to topics, which
otherwise means the `ntfy` command line on the server.

Thirteen tools is the ceiling, not the floor: `NTFY_ALLOW_TOOLS=essential` registers
a curated six instead, and a model picks the right tool far more reliably from six
than from thirteen — see [choosing which tools load](#choosing-which-tools-load).

## Requirements

- Node.js ≥ 22
- A reachable **ntfy** server. Credentials are optional: an instance that allows
  anonymous access needs none.

## Configuration

| Variable            | Required | Description                                                                                                                                                   |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NTFY_URL`          | yes      | Base URL, e.g. `https://ntfy.example.net`. There is deliberately no default — `https://ntfy.sh` would make a misconfiguration publish to the public internet. |
| `NTFY_TOKEN`        | no       | Access token (`tk_…`). Mutually exclusive with the two below.                                                                                                 |
| `NTFY_USERNAME`     | no       | Basic-auth user. Must be set together with `NTFY_PASSWORD`.                                                                                                   |
| `NTFY_PASSWORD`     | no       | Basic-auth password.                                                                                                                                          |
| `NTFY_TOPICS`       | no       | Comma-separated topics this server may use. The first is the default when a tool omits one, and the list restricts every tool, read and write.                |
| `NTFY_READ_ONLY`    | no       | Exactly `true` registers only the six read tools. Default `false`.                                                                                            |
| `NTFY_ALLOW_TOOLS`  | no       | Comma-separated tool names, `list_*` prefixes, or `essential` for a curated preset                                                                            |
| `NTFY_DENY_TOOLS`   | no       | Same syntax; removed from whatever `NTFY_ALLOW_TOOLS` left                                                                                                    |
| `NTFY_INSECURE_TLS` | no       | `true` accepts self-signed certificates (scoped to this connection)                                                                                           |

Setting `NTFY_TOKEN` together with `NTFY_USERNAME`/`NTFY_PASSWORD` is refused at
startup rather than resolved by a precedence rule: which credential is in force must
never be ambiguous.

> **Use `https://`.** Over plain http the credentials travel unencrypted — basic
> auth is base64, not encryption — and the server prints a warning unless the host is
> local. For self-signed certificates prefer a proper internal CA over
> `NTFY_INSECURE_TLS`.

Without configuration the server still starts and lists its tools (so registries and
inspectors can introspect it), but every call fails with setup instructions instead
of reaching the API.

### Writes are on by default

`NTFY_READ_ONLY` defaults to `false`. ntfy exists to publish, and a read-only default
would ship a notification server that cannot notify — this is the opposite of
[imap-mcp](https://github.com/ni-c/imap-mcp), where the same variable defaults to
`true` because a mailbox is an irreplaceable archive.

Two consequences worth knowing:

- **Only the literal string `true` disables the write tools.** `NTFY_READ_ONLY=ture`
  or `=1` leaves them enabled. Because the default is permissive, a typo fails open
  here, where in imap-mcp it failed closed.
- **A client that can publish can publish anywhere on the instance** unless you say
  otherwise. Confirmation tokens do not help against that — publishing is not a
  destructive operation. `NTFY_TOPICS` is the control that does.

The recommended shape for anything unattended:

```sh
NTFY_TOPICS=deploys                 # the server can only touch this topic
NTFY_ALLOW_TOOLS=essential          # or:
NTFY_DENY_TOOLS=delete_messages,create_user,delete_user,manage_user_access
```

On a self-hosted instance, also give the server its own ntfy account with `write-only`
access to exactly the topics it needs.

### Choosing which tools load

`NTFY_ALLOW_TOOLS` and `NTFY_DENY_TOOLS` take comma-separated tool names; a trailing
`*` matches a whole family. `essential` is a curated preset — `get_server_info`,
`check_topic_access`, `publish_message`, `list_messages`, `get_message` and
`update_message` — marked as such in the
[tool reference](https://ntfy-mcp.ni-c.de/reference/tools). Four of the six are read
tools, so the preset stays useful under `NTFY_READ_ONLY=true`.

```sh
NTFY_ALLOW_TOOLS=essential
NTFY_ALLOW_TOOLS=publish_message,list_messages
NTFY_DENY_TOOLS=delete_*,create_user,manage_user_access
```

An entry that matches no tool aborts startup and names it, so a typo cannot silently
hide a tool — an absent tool is not something anyone traces back to an environment
variable. A filtered tool is never registered, so it is absent from `tools/list` and
unknown to `tools/call` alike, exactly like a write tool under `NTFY_READ_ONLY`.

If you run several of these servers at once, [mcp-hub](https://mcp-hub.ni-c.de) is
the other answer — its `/hub` endpoint replaces every server's tools with six
meta-tools.

## Installation

### Claude Code

```sh
claude mcp add ntfy-mcp -- npx -y @ni-c/ntfy-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "ntfy-mcp": {
      "command": "npx",
      "args": ["-y", "@ni-c/ntfy-mcp"],
      "env": {
        "NTFY_URL": "https://ntfy.example.net",
        "NTFY_TOKEN": "…",
        "NTFY_TOPICS": "deploys"
      }
    }
  }
}
```

### Codex

```toml
[mcp_servers.ntfy-mcp]
command = "npx"
args = ["-y", "@ni-c/ntfy-mcp"]
env = { NTFY_URL = "https://ntfy.example.net", NTFY_TOKEN = "…", NTFY_TOPICS = "deploys" }
```

## Tools

`*` marks the `essential` preset.

| Tool                   | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `list_messages` *      | Poll the cached messages of one or more topics, with filters, and get a cursor for the next call |
| `get_message` *        | One message in full, including its action buttons and attachment                                 |
| `check_topic_access` * | Whether the credentials may subscribe to a topic — see the note below                            |
| `get_server_info` *    | Health, capabilities, usage, and whether the admin tools are worth trying                        |
| `get_account`          | Identity, role, limits and usage of the configured credentials                                   |
| `list_users`           | Every account and its per-topic grants (admin)                                                   |
| `publish_message` *    | Send a notification to one or more topics                                                        |
| `update_message` *     | Revise a notification in place, so a progress report stays one notification                      |
| `mark_messages_read`   | Clear notifications on subscribers' devices                                                      |
| `delete_messages`      | Delete notifications and cancel scheduled ones (confirmation required)                           |
| `create_user`          | Create a non-admin account (admin)                                                               |
| `delete_user`          | Remove an account and its grants (admin, confirmation required)                                  |
| `manage_user_access`   | Grant, deny or revoke access to a topic or pattern (admin, confirmation required)                |

### Two things about ntfy that surprise people

**Read and write are granted separately per topic.** A write-only publishing token
cannot poll the very topic it publishes to, and that is a correct configuration
rather than a fault. `check_topic_access` tests the _read_ side only, so a denial
there does not mean publishing will fail — the tool says so in its result.

**There is no way to list the topics on a server.** A topic exists because someone
published to it, and on an open instance its name is the whole of the access control.
Treat topic names as secrets; `get_account` and `list_users` are the only places
existing ones show up.

### Not implemented, on purpose

- **Sending email or placing a phone call** from a published message. ntfy supports
  both; an MCP tool that mails an arbitrary address on model output is a spam relay
  driven by injectable content, and `call` places a real, billable call.
- **Creating, reading or exchanging an access token.** Every such endpoint hands back
  a live credential, which would then live in the conversation transcript.
- **Streaming subscriptions** (`/sse`, `/ws`, `/raw`). A tool call is
  request/response under a timeout; `list_messages` returns the same data, bounded.
- **Attachment upload.** Either base64 through the model's context or a local
  filesystem surface this server has no business having. `attach` covers the real case
  by URL.
- Reservations, billing, web push, email and phone verification, and the Matrix
  gateway.

## Safety

- **Destructive tools are two-step.** `delete_messages`, `delete_user` and
  `manage_user_access` return a short-lived confirmation token bound to a fingerprint
  of the exact target; only a second call carrying that token performs the operation.
  A confirmation for one target cannot execute another, a longer list, or — for
  `manage_user_access` — the same three arguments in a different order.
- **Confirmation prompts never quote content from ntfy.** They name the topic, the
  count or the username and nothing else, because that text is read by a model.
- **Returned content is marked as untrusted data**, because it is: everything in a
  notification was written by whoever could publish to the topic.
- **Access tokens are stripped from `get_account`.** ntfy returns every token of the
  account in plaintext there.
- **Caller-supplied URLs must be `http` or `https`.** `click`, `icon`, `attach` and
  action-button URLs are opened by the recipient's device, not by the server, and
  ntfy stores whatever it is given — including a `javascript:` URL.
- **Every field a publisher controls is bounded.** ntfy caps the message body at 4096
  bytes but not the title or the tag list, so those are capped here.
- `NTFY_READ_ONLY=true` does not register the write tools at all, and `NTFY_DENY_TOOLS`
  cuts finer along the same line — a filtered tool is never built, not refused at call
  time.

## Releasing

1. Add the CHANGELOG entry and bump `package.json`.
2. `npm run lint && npm run typecheck && npm run build && npm run test:coverage`
3. Commit, then push a signed tag: `git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin main vX.Y.Z`

## License

MIT © Willi Thiel
