# ntfy-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/ntfy-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/ntfy-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40ni-c%2Fntfy-mcp)](https://www.npmjs.com/package/@ni-c/ntfy-mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40ni-c%2Fntfy-mcp)](https://www.npmjs.com/package/@ni-c/ntfy-mcp)
[![node](https://img.shields.io/node/v/%40ni-c%2Fntfy-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/%40ni-c%2Fntfy-mcp)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Fntfy--mcp-blue)](https://github.com/ni-c/ntfy-mcp/pkgs/container/ntfy-mcp)
[![docs](https://img.shields.io/badge/docs-ntfy--mcp.ni--c.de-informational)](https://ntfy-mcp.ni-c.de)
[![HTTP • via mcp-hub](https://img.shields.io/badge/HTTP-via%20mcp--hub-6f42c1)](https://mcp-hub.ni-c.de)
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

<!-- <picture> is resolved against the colour scheme of the page showing it, so GitHub
     picks the variant that matches its own theme toggle. npm strips <picture> and
     <source> when it sanitises the README and keeps the <img>, which is why that
     fallback brings its own dark card instead of relying on a media query.

     The URLs must stay absolute: a relative path is simply invisible on npm. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://ntfy-mcp.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://ntfy-mcp.ni-c.de/architecture-light.svg">
  <img src="https://ntfy-mcp.ni-c.de/architecture.svg" alt="An MCP client speaks stdio to ntfy-mcp, which publishes notifications and polls the message cache over HTTPS against an ntfy server that pushes them to the subscribed devices" width="800">
</picture>

<!-- Recorded with vhs from docs/demo.tape against a throwaway ntfy container, so it
     reproduces without touching a real instance — see the header of that file. -->

![Demo: listing the tools, publishing a notification and revising it in place through the MCP Inspector CLI](https://ntfy-mcp.ni-c.de/demo.gif)

## What makes it different

**A progress report stays one notification.** The id `publish_message` returns is
also the notification's sequence id, and `update_message` replaces its content in
place — subscribers watch one notification change from "building" to "deployed"
instead of collecting five.

**`NTFY_TOPICS` is the fence.** On ntfy a topic name is a bearer credential:
knowing it is often the whole of the access control. One variable names the topics
this server may touch and supplies the default when a tool omits one, so the name
stays out of the tool arguments and out of the model's context.

## Requirements

- Node.js ≥ 22
- A reachable **ntfy** server. Credentials are optional: an instance that allows
  anonymous access needs none.

## Configuration

| Variable            | Required | Description                                                                                                                                                             |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NTFY_URL`          | yes      | Base URL, e.g. `https://ntfy.example.net`. There is deliberately no default — `https://ntfy.sh` would make a misconfiguration publish to the public internet.           |
| `NTFY_TOKEN`        | no       | Access token (`tk_…`). Mutually exclusive with the two below.                                                                                                           |
| `NTFY_USERNAME`     | no       | Basic-auth user. Must be set together with `NTFY_PASSWORD`.                                                                                                             |
| `NTFY_PASSWORD`     | no       | Basic-auth password.                                                                                                                                                    |
| `NTFY_TOPICS`       | no       | Comma-separated topics this server may use. The first is the default when a tool omits one, and the list restricts every tool, read and write — access grants included. |
| `NTFY_READ_ONLY`    | no       | `true`, `1` or `yes` (any case) registers only the six read tools. Default `false`.                                                                                     |
| `NTFY_ALLOW_TOOLS`  | no       | Comma-separated tool names, `list_*` prefixes, or `essential` for a curated preset                                                                                      |
| `NTFY_DENY_TOOLS`   | no       | Same syntax; removed from whatever `NTFY_ALLOW_TOOLS` left                                                                                                              |
| `NTFY_INSECURE_TLS` | no       | `true` accepts self-signed certificates (scoped to this connection)                                                                                                     |

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

- **A typo still fails open.** `true`, `1` and `yes` are all read as read-only, in
  any case — a protection switch is parsed generously on purpose. But
  `NTFY_READ_ONLY=ture` is not any of them, and because the default is permissive it
  leaves the write tools enabled, where in imap-mcp it would fail closed.
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

### Docker

```sh
docker run -i --rm \
  -e NTFY_URL=https://ntfy.example.net -e NTFY_TOPICS=deploys \
  ghcr.io/ni-c/ntfy-mcp
```

### Through mcp-hub

A client that cannot spawn a local process — ChatGPT connectors, Claude on the web,
Cursor, LibreChat — reaches ntfy-mcp through [mcp-hub](https://mcp-hub.ni-c.de): one
container serves many stdio MCP servers over Streamable HTTP, with an OAuth 2.1 login
behind a single password and long-lived tokens for the clients that cannot do OAuth. Its
`/hub` endpoint puts every server behind six meta-tools, so one connector reaches all of
them without N×tool schemas in the model's context, and it speaks both protocol revisions
— a question this server asks travels through it to the person at the far end.

Its `/config/mcp.json` uses Claude Code's format, so the entry is the one you already
have:

```json
{
  "mcpServers": {
    "ntfy-mcp": {
      "command": "npx",
      "args": ["-y", "@ni-c/ntfy-mcp"],
      "env": {
        "NTFY_URL": "https://ntfy.example.net",
        "NTFY_TOKEN": "…",
        "NTFY_TOPICS": "alerts",
        "NTFY_ALLOW_TOOLS": "essential"
      },
      "denyTools": ["delete_messages"]
    }
  }
}
```

`allowTools` and `denyTools` there are the hub's **own** per-server filter, which is not
the same thing as `*_ALLOW_TOOLS` in `env` — the difference, and the mistake it invites,
are in the [client guide](https://ntfy-mcp.ni-c.de/guide/clients#through-mcp-hub).

## Tools

`*` marks the `essential` preset.

| Tool                    | Description                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `list_messages` *       | Poll the cached messages of one or more topics, with filters, and get a cursor for the next call |
| `get_message` *         | One message in full, including its action buttons and attachment                                 |
| `check_topic_access` *  | Whether the credentials may subscribe to a topic — see the note below                            |
| `get_server_info` *     | Health, capabilities, usage, and whether the admin tools are worth trying                        |
| `get_account`           | Identity, role, limits and usage of the configured credentials                                   |
| `list_users`            | Every account and its per-topic grants (admin)                                                   |
| `publish_message` *     | Send a notification to one or more topics                                                        |
| `update_message` *      | Revise a notification in place, so a progress report stays one notification                      |
| `mark_messages_read`    | Clear notifications on subscribers' devices                                                      |
| `delete_messages` 👤    | Delete notifications and cancel scheduled ones                                                   |
| `create_user` 👤        | Create a non-admin account (admin)                                                               |
| `delete_user` 👤        | Remove an account and its grants (admin)                                                         |
| `manage_user_access` 👤 | Grant, deny or revoke access to a topic or pattern (admin)                                       |

👤 asks a person through MCP elicitation · falls back to a two-call
`confirm_token` where the client cannot show a dialog.

### Structured output

Every tool declares an `outputSchema` and answers with `structuredContent`
alongside the text block, so a client can use the result without parsing prose:

```jsonc
{
  "untrusted": true,
  "source": "ntfy",
  "topics": ["alerts"],
  "count": 2,
  "next_since": "TmkVCUCmDdWL",
  "messages": [{ "id": "TmkVCUCmDdWL", "topic": "alerts", "title": "…" }],
}
```

The `untrusted` marker is a field and not only a sentence in the text, because a
client that reads the structured half and ignores the text would otherwise get a
publisher's prose with no framing at all. It is on the four tools that report
what someone else wrote: `list_messages`, `get_message`, `get_account` and
`list_users`. `get_server_info` does not carry it — its sections are the
instance's own configuration and counters.

Fields this server builds are described exactly; documents it merely passes on
from ntfy (`/v1/config`, `/v1/stats`, a publisher's attachment metadata) are
declared as objects with no fixed shape. A schema stricter than the data is not
a better contract: the SDK validates every result against it, so an upstream
release that adds a field would take the tool out entirely rather than show you
one field you did not expect.

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
  gateway. `GET /v1/account` returns several of them anyway; `get_account` drops
  them rather than passing on a payload no tool here uses.

## Not exposed, on purpose

**No topic enumeration** — ntfy has no such API, and neither does anything else. A
topic exists because someone published to it, and on an instance with the default
access rules its name is the whole of the access control, so a list endpoint would
be a list of credentials. `get_account` names the topics the account is subscribed
to and `list_users` the per-topic grants; those are the two honest answers.

## Safety

- **A person is asked, not just told.** Where the client supports MCP elicitation,
  `delete_messages`, `delete_user`, `manage_user_access`, `create_user` and
  `update_message` raise a real dialog that the model cannot answer on its behalf.
  Where it does not, they fall back to a short-lived token bound to a fingerprint of
  the exact target — and say so, rather than implying somebody approved. A
  confirmation for one target cannot execute another, a longer list, or — for
  `manage_user_access` — the same three arguments in a different order. See
  [Asking a person](https://ntfy-mcp.ni-c.de/guide/approval).
- **`NTFY_TOPICS` bounds the access tools too.** `manage_user_access` refuses a
  pattern that reaches past the list, `*` included: a grant is permanent access to
  every topic it covers, and no finite allowlist covers a wildcard. `list_users`
  reports each account's grants against the allowed topics only, because a grant
  pattern is a topic name and a topic name is a bearer credential.
- **Confirmation prompts never quote content from ntfy.** They name the topic, the
  count or the username and nothing else, because that text is read by a model. And
  never the password `create_user` was given: it is a live credential, so it is in
  neither the prompt nor the token's binding.
- **Returned content is marked as untrusted data**, because it is: everything in a
  notification was written by whoever could publish to the topic.
- **`get_account` answers from an allowlist, not a denylist.** It reports the
  identity, role, tier, limits, usage and the _metadata_ of each access token, and
  drops everything else ntfy sends — the token values, which ntfy returns in
  plaintext, but also the phone numbers, the billing identifiers and the
  reservation and subscription topic names. A key a future ntfy adds is dropped
  without an edit here.
- **Caller-supplied URLs must be `http` or `https`.** `click`, `icon`, `attach` and
  action-button URLs are opened by the recipient's device, not by the server, and
  ntfy stores whatever it is given — including a `javascript:` URL.
- **Every field a publisher controls is bounded.** ntfy caps the message body at 4096
  bytes but not the title or the tag list, so those are capped here.
- `NTFY_READ_ONLY=true` does not register the write tools at all, and `NTFY_DENY_TOOLS`
  cuts finer along the same line — a filtered tool is never built, not refused at call
  time.

## Documentation

The full guide, tool reference and security notes live at
**[ntfy-mcp.ni-c.de](https://ntfy-mcp.ni-c.de)** (source in [`docs/`](docs/)).

## Development

```sh
npm install
npm run build
npm run lint && npm run typecheck && npm run test:coverage
```

The architecture diagram and the social card are generated: edit
`docs/assets/architecture.source.svg` or `docs/assets/og.json` and run
`npm run assets`, never the rendered copies under `docs/public/`. CI runs
`npm run assets:check` and fails if they have drifted.

The documentation site has its own manifest, so its toolchain never lands in the
container image or the test matrix:

```sh
cd docs && npm install && npm run build
```

## Releasing

Releases are tag-driven. Bump `package.json`, move the `[Unreleased]` notes in
`CHANGELOG.md` under the new version, commit, then:

```sh
git tag -s vX.Y.Z -m "vX.Y.Z"
git push origin main vX.Y.Z
```

The release workflow publishes to npm via Trusted Publishing (OIDC, with
provenance), pushes the multi-arch container image to GHCR, creates the GitHub
release from the CHANGELOG section, and updates the entry in the official MCP
registry.

## Contributing

Issues, discussions and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). For vulnerabilities please use
[private reporting](https://github.com/ni-c/ntfy-mcp/security/advisories/new)
rather than a public issue; the policy is in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Willi Thiel
