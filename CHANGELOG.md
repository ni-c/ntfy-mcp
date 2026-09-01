# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

### Added

- Tools that need a confirmation now **ask the user**, on clients that can show
  a prompt. The two-call `confirm_token` remains for clients that cannot, so
  nothing that works today stops working — but where a person can be asked, one
  is, instead of a token that only proves the same call was made twice.

- **`create_user` now asks too.** It destroys nothing, which is why it was not
  guarded and why `destructiveHint` cannot say what is wrong with it: bringing an
  account into existence is a change to who may reach this instance. It is the
  mirror image of `delete_user`, which was guarded from the start, and its own
  annotation had claimed "which is why it is guarded" while it was not.

  The **password stays out of it** — out of the prompt, which is read back by a
  person and by a model, and out of the token's binding. A consequence worth
  knowing: on the fallback path a token issued for one password works with
  another, because what the approval is about is the account name.

  Publishing deliberately stays unguarded. Sending a notification destroys
  nothing and reaches people who cannot un-receive it — an outbound effect, not a
  destructive one. `NTFY_TOPICS` is the control for that.

- `ELICITATION` switches the dialog off — `false` sends a client that could have
  been asked down the two-call-token path instead. For a scheduled job or a test
  harness, where a dialog is the wrong shape rather than an unwanted one.

  It does **not** remove the guard: there is no setting in which a guarded call
  goes unannounced. Two deliberate rough edges come with it. The variable is
  **not prefixed**, so one `export ELICITATION=false` reaches every MCP server in
  the environment — which is why a server started with it off prints a line
  saying so, and why the fallback text names the server instead of blaming a
  client that was working fine. And a value that is neither `true` nor `false`
  **stops the server**: it is the only variable here that defaults to _on_, so
  failing open on a typo would leave the dialog running while the operator
  believed it was off. It is read after `NTFY_TOKEN` and `NTFY_PASSWORD` are
  wiped from the environment, so that exit cannot leave a credential behind.

- A `docs/guide/approval.md` page.

### Changed

- Runs on **MCP SDK 2.0**. Existing clients see the same protocol revision they
  always did; the change is the package layout behind it, and it is what lets
  the dialog above work on both protocol eras from one code path — including
  behind a stateless gateway, where the older mechanism silently fell back to
  the weaker token for every client.

- The linter is **oxlint** instead of eslint plus typescript-eslint, which
  lifts the TypeScript ceiling: typescript-eslint pins `typescript` below 6.1,
  so this repository was held on TypeScript 6 by its linter rather than by its
  code.

- The tool filter, the confirmation store and the documentation-asset generator
  now come from **`mcp-tool-allowlist`**, **`mcp-approval`** and
  **`svg-asset-set`** rather than from copies kept here — 740 fewer lines, and
  one place to fix each. None of them has a runtime dependency of its own.

### Fixed

- Confirmation tokens are compared with a **constant-time** comparison. The
  copy in this repository used `!==`, which leaks through timing how much of a
  guess was right. Reaching a token still requires having received it in a
  previous tool result, so this closes a margin rather than a hole.

- A `confirm_token` that does not match is now refused with the reason —
  invalid, expired, or issued for different arguments — instead of being
  answered with a fresh prompt. The second is self-healing when a token merely
  expired and silent when the token was issued for something else, which is the
  case the binding exists to catch.

- An entry in `NTFY_ALLOW_TOOLS` that is not tool-name-shaped is now
  **redacted** in the error rather than quoted back. `NTFY_TOKEN` and
  `NTFY_ALLOW_TOOLS` are adjacent lines in every compose file, and a paste into
  the wrong one used to print the credential into the client's log.

## [Unreleased]

## [0.1.0] - 2026-08-29

### Added

- Initial release: an MCP server for [ntfy](https://ntfy.sh), covering
  publishing, reading the message cache, and user and topic-access
  administration.
- A multi-architecture container image at `ghcr.io/ni-c/ntfy-mcp`
  (amd64 and arm64), published with an SBOM and build provenance. It runs as
  an unprivileged user with no npm in the runtime layer and speaks stdio
  only, so it needs `-i` and exposes no port.
- Thirteen tools. Six read: `list_messages`, `get_message`,
  `check_topic_access`, `get_server_info`, `get_account`, `list_users`. Seven
  write: `publish_message`, `update_message`, `mark_messages_read`,
  `delete_messages`, `create_user`, `delete_user`, `manage_user_access`.
- `NTFY_ALLOW_TOOLS` and `NTFY_DENY_TOOLS` narrow the tool list by name or by a
  trailing-`*` prefix, and `NTFY_ALLOW_TOOLS=essential` selects a curated six
  that cover publishing and verifying end to end.
- `NTFY_TOPICS` names the topics the server may touch. The first entry is the
  default when a tool omits one, which keeps a topic name — a bearer secret on a
  public instance — out of the tool arguments; the list also bounds every read
  and write tool.
- Basic authentication (`NTFY_USERNAME` / `NTFY_PASSWORD`) alongside access
  tokens (`NTFY_TOKEN`), because `ntfy user add` produces a username and
  password rather than a token. Setting both forms is refused at startup rather
  than resolved by a precedence rule.

### Security

- `NTFY_READ_ONLY` defaults to `false`, unlike the same variable in
  [imap-mcp](https://github.com/ni-c/imap-mcp), where it defaults to `true`.
  ntfy exists to publish; a read-only default would ship a notification server
  that cannot notify. Because of that direction, only the literal string `true`
  disables the write tools — a typo leaves them enabled. The destructive tools
  are gated behind confirmation tokens and ntfy's own permissions instead, and
  `NTFY_ALLOW_TOOLS=essential` or a `NTFY_DENY_TOOLS` list is the recommended
  hardening.
- `delete_messages`, `delete_user` and `manage_user_access` require a
  server-generated confirmation token bound to a fingerprint of the exact
  target, so a confirmation for one target cannot execute another or a longer
  list.
- Access tokens are removed from `get_account` output. ntfy returns every token
  of the account in plaintext there, which would otherwise put a live credential
  into the conversation transcript. The account's `sync_topic` is removed for the
  same reason — a topic name is a bearer secret.
- `click`, `icon`, `attach` and every action button URL are restricted to
  `http:` and `https:`. ntfy stores whatever it is given, and these URLs are
  opened by the recipient's device rather than by the server.
- Publishing cannot send email or place a phone call, and no tool creates,
  reads or exchanges an ntfy access token.

<!-- #endregion changelog -->
