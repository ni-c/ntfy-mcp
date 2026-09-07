# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [0.3.0] - 2026-09-07

### Added

- The server introduces itself in full. `title`, `description`, `websiteUrl` and
  `icons` now travel with `name` and `version`, so a client that shows a server
  to a person has something to show. All four were already in `server.json` for
  the registry and reached no client at all; a test compares the two so they
  cannot drift.
- An OpenSSF Scorecard run, weekly and on every push to `main`, reporting into
  the Security tab next to CodeQL and Trivy. The badge is the second in the row.
- `actions/dependency-review-action` on every pull request. `npm audit` checks
  the tree as it is; this checks the change, so a vulnerable dependency is
  answered on the pull request rather than after it is merged.

### Changed

- Source maps are no longer published in the npm tarball. Node reads them only
  under `--enable-source-maps`, which nothing here sets, and the maps pointed at
  a `src/` this package does not ship — so a stack trace under that flag named a
  file nobody could open. `dist/**/*.js` is unchanged; the package is about a
  fifth smaller.
- The loopback check behind the plain-HTTP warning comes from
  `mcp-internal-hosts` instead of a copy in `config.ts`. Same classifier the
  rest of the family uses, same behaviour — one fewer place to keep 25 lines of
  hand-written IPv6 normalisation correct.
- `NTFY_URL` is stored as `origin + pathname` rather than as the environment
  string. A query or a fragment can no longer be glued in front of every path
  the server builds, and what was dropped is named on the startup line.
- `time` is optional in a message view, with `time_unavailable` beside it when
  ntfy's timestamp is missing or outside the range `Date` can hold. Reporting
  the absence beats inventing a timestamp, and both beat the `RangeError` that
  used to take the whole listing with it.
- `NTFY_TOPICS` accepts at most 256 entries. The list is walked once per access
  grant when `list_users` projects them, so a longer one is a cost on every call
  rather than a restriction.

### Security

- **mcp-approval 0.8.2.** A sealed dialog answer is single-use since 0.8.1: the same `requestState` presented again within its lifetime used to be accepted again, and with a resource key that is the same every time — a whole stream, a fixed set of targets — every replay landed. npm users on `^0.8.0` already had the fix; the Docker image is built from the lockfile and carried 0.8.0 until this release.
- **Approval keys bound to positions.** `manage_user_access` is confirmed on (username, topic, action) and `update_message` on (topic, message id), and in both the vocabularies overlap: a username is a legal topic name, a twelve-character message id is one too. A key built from a _sorted_ set of those parts would let a token issued for "grant alice read_only on topic deploy" also confirm "grant deploy read_only on topic alice", and a token for revising message `a…` on topic `b…` also confirm the pair the other way round. This server never had that bug — it carried its own positional `tupleResourceKey` — but the local copy is gone: both tools now build their keys with `orderedResourceKey` from mcp-approval 0.8.2, which prefixes every part with its index before fingerprinting. `create_user` and `delete_user` and `delete_messages` stay on `setResourceKey`, where a single value or a genuine set is what is confirmed.
- **The credential can no longer reach the model.** A credential travels in an `Authorization` header, and the HTTP layer's refusal of a malformed header value **quotes the value** — verified on undici 8.10 and on Node's global `fetch`. That refusal is an ordinary rejected promise, which a tool handler turns into a tool result, so an `NTFY_TOKEN` with a line break in the middle of it — a wrapped paste, or `$(cat token)` of a wrapped file — put the whole token in the model's context. Both halves are closed: `loadConfig` refuses a credential that cannot travel in a header at startup, naming the variable, the length and the _position_ of the offending character and never the value; and every request checks the header before sending, which also covers a `Config` built without `loadConfig`.
- **`update_message` binds the content it will write.** The confirmation used to be keyed on the topic and the notification id alone, deliberately, so that fixing a typo did not need a second dialog. The gap that left is between the two legs of the fallback token: the first call is answered with a token bound to (topic, id), and the second presents it with whatever content it likes — and the tool carries the whole content schema, `actions` included, where an `http` button fires from the recipient's device with a method, headers and body chosen by the caller. A confirmation obtained for a corrected typo could be redeemed for a call that added a button. The content is now part of the key, and the dialog names the fields it will replace through `details`, so the caller's text appears on its own labelled line instead of inside this server's sentence. `create_user` binds its `tier` the same way.
- **Nothing ntfy sends is trusted for its shape.** Every response used to be a TypeScript cast — `JSON.parse(...) as NtfyMessage` — and an exported interface with a docblock on every field reads like a check without being one. A `time` that is a word or `1e999` answered `RangeError: Invalid time value` out of `toISOString()`, and `tags: 7` answered `tags.slice is not a function`; both were thrown from inside a `map` over a listing, so one message made every other message in the answer unreachable. An `id`, `title` or `priority` of the wrong type broke the tool's own `outputSchema` instead, which the SDK refuses as `Output validation error` for the whole call. A new `boundary.ts` reads each field for what it is, and each caller decides per field: omit it, skip the entry and count it, or say in a sentence that it was unusable — never widen the schema. A property test drives every read tool from arbitrary JSON, including the `1e999` that only exists in the serialised text.
- **Control characters and lone surrogates are removed from everything reported.** There was no cleaner at all: the per-field cap bounded length and nothing else, so an escape sequence in a notification title — which anybody who knows a topic name can publish — was a terminal control sequence in the host's log file and in whatever renders the result, and a lone surrogate survived `JSON.stringify` as an escape only to raise `UnicodeEncodeError` in a client encoding the result to UTF-8. A cut can produce one on its own by landing between the halves of a pair, so every cut is followed by `toWellFormed()`. Applied to titles, bodies, tags, action buttons, usernames, grant patterns, token labels and the `get_server_info` sections; tab, line feed and carriage return are kept, because those are content.
- **A refused login is not sent again straight away.** ntfy keeps a failed-authentication limiter **per visitor address** — `authLimiter` in `server/visitor.go`, spent by `maybeAuthenticate` in `server/server_auth.go` on every 401 it answers — and once its budget is gone the instance answers `42909` to _every_ request from that address, healthy traffic included. Every read tool here is annotated read-only, idempotent and cheap and answers a wrong credential with "check NTFY_TOKEN", which is exactly what a model retries; `check_topic_access` alone could spend ten of the thirty tokens in one call. A 401 is now remembered for ten seconds and repeated from memory with a note saying when the next real attempt is possible. Only a 401: a 403 is ntfy saying the account exists and may not have this topic, which costs the limiter nothing and is the per-topic answer `check_topic_access` exists to report.
- **`mcp-publisher` is pinned and its checksum verified.** Both jobs that publish to the MCP registry hold `id-token: write` and fetched the binary from `releases/latest/download`, piped straight into `tar` — whatever the upstream served that day, executed with the OIDC token available. Pinned to `v1.8.1` and checked against the sha256 that release published.
- **The runtime image no longer ships yarn or corepack.** npm had been removed by hand; the other two package managers the base image carries had not, which is easy to miss because nothing references them.

### Fixed

- **The result budget measured a string nobody received.** `list_messages` counted a compact `JSON.stringify` of the envelope and then emitted the same value indented, behind a marker sentence — between a fifth and several times larger. The budget now measures the rendering. Three tools had no ceiling at all: `get_server_info` passed four instance documents through whole, `get_account` the `limits`, `stats` and token metadata, and `list_users` an unbounded username and grant list per account, so a single call could answer with several megabytes. Each now has a ceiling of its own that shrinks or reports rather than sending, and the shrinking loop no longer re-serialises the whole envelope once per dropped entry.
- **The status of a response is decided before its body is read.** Both request paths read the body under the _success_ ceiling first, so a reverse proxy answering a 401 with a two-megabyte login page surfaced as "ntfy returned more than 2000000 bytes", thrown as a plain `Error` from inside the reader — no status, so no typed error, so no credential hint, no admin note, and nothing for `check_topic_access` to report per topic. Error bodies now have their own 64 KiB ceiling that cuts instead of refusing.
- **A message from ntfy no longer reaches the model as this server's words.** `get_server_info`'s per-section failures and the per-id results of `publish_message`, `mark_messages_read` and `delete_messages` quoted `error.message` verbatim — which is not always this server's sentence: undici quotes a header value it refuses, and Node's TLS layer quotes the certificate's names, chosen by whatever answered on the port.
- **`check_topic_access` has a budget for the call, not only per request.** Ten topics at the fifteen-second request timeout is two and a half minutes on a tool the annotations call cheap. What is not reached inside thirty seconds is reported as `not_checked` rather than left out — an absent entry reads as an answer.
- **A stream line that is valid JSON but not an object no longer fails the poll.** `null`, `42` and `[1,2]` are all legal NDJSON, and reading `.event` off one threw out of the listing. The same for an error body: reading `.code` off a `null` threw from inside a constructor.
- **Diagnostics no longer echo a value that might be the secret.** `ELICITATION` printed whatever it was given in full, and `NTFY_URL` printed the _scheme_ of a value it refused — a 56-character hexadecimal key with a colon after it is a valid URL whose scheme is the key. Only short, word-shaped values are quoted now; everything else is described by its length.
- **The trailing-slash strip on `NTFY_URL` was quadratic.** `url.replace(/\/+$/, '')` is retried from every position of a run that is not at the end of the string: 122 ms, 577 ms and 2233 ms for 20 000, 40 000 and 80 000 slashes followed by one more character. An index walk replaces it, and a `linear-time` suite now holds every such function at the largest input it can be given.

## [0.2.0] - 2026-09-03

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

- The advertised schemas avoid a spelling that is legal JSON Schema and still
  gets a tool refused, or its constraint silently dropped, by some MCP clients:
  a value that was left untyped is declared as what it really is. What the
  tools accept and return is unchanged; only the way the schema says so is.

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
