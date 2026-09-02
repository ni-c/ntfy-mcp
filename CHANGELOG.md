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

- Every tool declares an `outputSchema` and answers with `structuredContent`
  beside the text block. A client no longer has to parse prose to use a result.

  The four tools that report what someone else wrote — `list_messages`,
  `get_message`, `get_account`, `list_users` — carry `untrusted: true` and
  `source: "ntfy"` as fields of the object as well as in the text. A client
  that reads the structured half and ignores the text would otherwise receive a
  publisher's title and body with no framing at all, and the framing is the
  guard. `get_server_info` does not carry the marker: its sections are the
  instance's own configuration and counters.

  What this server builds is described exactly; what it passes on from ntfy is
  declared as an object with no fixed shape. The SDK validates every result
  against the schema before it goes out, so a schema stricter than the data
  would turn an upstream release that adds a field into a tool that fails
  outright rather than one that reports a field nobody expected.

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

- `manage_user_access` reports the `action` it was asked for on every outcome,
  not only on `revoke`. Granting and revoking answered in two different shapes
  before; the shape is now one.

- `get_account` against an ntfy that answers with something other than a JSON
  object returns `{}` rather than that value. An allowlist keeps nothing it does
  not understand, and passing the value back forwarded exactly the shape the
  allowlist exists to filter.

- The two-call `confirm_token` prompt is an error result. The operation was
  asked for and did not happen, and a tool that declares an output schema may
  not answer without `structuredContent` unless the result is an error. The
  text is unchanged and still carries the token.

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

- stdio is served through `serveStdio`, so the connection's era is negotiated
  on the opening exchange rather than assumed. A client that pins the
  `2026-07-28` era is served it; until now its `server/discover` probe was
  answered with "Method not found" and only `2025-11-25` was on offer. A client
  that speaks the older era sees no change — it is still pinned to one instance
  for the life of the connection, exactly as a hand-wired
  `StdioServerTransport` served it.

### Security

- **`NTFY_TOPICS` now bounds the access tools, which it had only claimed to.**
  `manage_user_access` passed its `topic` argument straight into the request
  body, so `topic: "*"` handed an account permanent read-write access to every
  topic on the instance — from a server the operator had restricted to one. A
  grant pattern is now resolved against the list, and where the list is set a
  wildcard is refused outright: a pattern also covers topics that do not exist
  yet, and no finite allowlist covers that. The refusal happens before the
  approval dialog, so a pattern that will not be accepted never becomes a
  question somebody might tick.

  `list_users` had the same hole from the other side. `GET /v1/users` is the one
  endpoint on ntfy that answers "which topics exist here", for every account at
  once, and its grant patterns were forwarded verbatim — so a server restricted
  to `alerts` was handing back the names of every other topic on the box, and a
  topic name on ntfy is a bearer credential. Grants are now restated against the
  allowed topics: a wildcard grant appears once per allowed topic it covers, one
  that covers none of them is dropped, and the account itself is still listed.
  The tool's own `topic` filter is resolved against the list too.

- **`update_message` now asks a person.** From ntfy 2.16 an update replaces the
  notification **on the subscribers' devices**, so the text they were shown
  survives nowhere but this server's cache — and the tool carries the whole
  content schema, `actions` included, where an `http` button fires from the
  recipient's phone with a method, headers and body the caller chose. One
  unguarded call could turn a delivered alert into a button that calls
  something. It is gated exactly like `delete_messages`, on a fingerprint of
  `(topic, sequence_id)`.

  The new content is deliberately **not** part of that fingerprint. What is
  confirmed is the notification; binding the text would ask again for every
  corrected typo while proving nothing, since the replacement is only reachable
  through the same tool call.

  Publishing stays unguarded, and the argument for that now stops where it
  should. Sending a notification destroys nothing; replacing one that people
  already have does.

- **`get_account` answers from an allowlist instead of a denylist.** It removed
  the access token values and `sync_topic` and spread the rest, which meant
  `phone_numbers`, the `billing` block with its Stripe identifiers, and the
  `reservations` and `subscriptions` arrays — each a list of topic names — all
  reached the transcript, while the README listed those very features under "not
  implemented, on purpose". The tool now projects `username`, `role`, `tier`,
  `limits`, `stats`, `language` and each token's `label`, `last_access` and
  `expires`, and drops everything else. A field a newer or forked ntfy adds is
  dropped without an edit here, which is the property a denylist cannot have.

- **`NTFY_READ_ONLY` accepts `1` and `yes`, in any case.** It compared against
  the literal string `true`, so `NTFY_READ_ONLY=1` registered every write tool
  while the operator believed the server was read-only — and said nothing,
  because nothing is printed for a variable that parsed to false. A switch that
  _adds_ a protection is now parsed generously; `NTFY_INSECURE_TLS`, which
  _removes_ one, still takes nothing but the exact word. A genuine typo such as
  `=ture` still fails open, because the default is `false`.

- **The residual risk that an approval proves binding and not freshness** is
  now written down rather than implied. The sealed state carries no nonce, so a
  retried leg can run an approved operation twice; every guarded tool here is
  idempotent in effect, and `publish_message` — the one operation that genuinely
  acts twice — is unguarded and has no idempotency key on ntfy's side. See
  `SECURITY.md`.

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

- A duplicated comment block in `manage_user_access` — the paragraph explaining
  why its resource key is a tuple appeared twice.

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
