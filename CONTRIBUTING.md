# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/ntfy-mcp.git && cd ntfy-mcp
npm install
npm run lint && npm run typecheck && npm run build && npm test
```

## Running the integration suite

The unit tests stub `fetch`, so they check that this server does what its author
believed ntfy does. The integration suite checks what ntfy does. It spawns the
built server over stdio against a throwaway ntfy in Docker and calls **every
tool in the catalogue** — publishing, deleting and rewriting the authorization
model included — so the backend has to be one nobody's phone is subscribed to:
`test/integration/compose.yml` binds to `127.0.0.1` only, and the harness
refuses any backend URL that is not on this machine.

```sh
npm run build     # the suite runs dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration
docker compose -f test/integration/compose.yml down -v
```

The compose file creates its own admin account, because ntfy has no endpoint
that creates the first one — `ntfy user add` is a CLI command, and it refuses
until the server has started once and created the user database. So the server
is started in the background, the database is waited for, and the account is
added against the running instance, which needs no restart.

**Pin the version deliberately.** Updating and deleting notifications arrived in
ntfy **2.16.0**. Against anything older the three tools that use them do not
fail loudly: `delete_messages` and `mark_messages_read` report `ok: false` per
id inside a result that is not an error, and `update_message` quietly publishes
a second notification instead of revising the first. CI runs the suite against
the pinned image on every pull request and against `binwiederhier/ntfy:v2`
weekly, which is where a change like that shows up.

Three things the suite pins that a stub could not have told anyone:

- `DELETE /{topic}/{id}` **publishes a `message_delete` event and removes
  nothing.** The original stays in the cache until it expires, so `get_message`
  still finds it. "Deleted" means subscribers were told to drop their copy.
- `mark_messages_read` is the same shape with a `message_clear` event.
- `/v1/version` really is admin-only — 401 unauthenticated and for a non-admin
  — while `/v1/config` really is public, which is what makes `get_server_info`
  worth calling before the credentials are right.

For poking at a single tool by hand, the MCP inspector against the same stack is
still the quickest thing:

```sh
docker compose -f test/integration/compose.yml up -d --wait
NTFY_URL=http://127.0.0.1:8099 NTFY_USERNAME=integration \
  NTFY_PASSWORD=integration-not-a-secret NTFY_TOPICS=integration-topic \
  npx @modelcontextprotocol/inspector node dist/index.js
```

Please do not develop against an instance anyone relies on — these tools publish
real notifications to real devices, and `manage_user_access` rewrites the
authorization model of the whole server.

## Testing

Vitest. The server is driven in-process over an in-memory MCP transport with `fetch`
stubbed — see `test/harness.ts`, which is where a new test should start.

ntfy publishes no OpenAPI specification, so behaviour its documentation leaves open
was checked against a real 2.27.0 instance. Where a test encodes such a fact the
comment says so and names the version; if you find one of them is no longer true,
please say which version you checked.

`npm run typecheck` is separate from `npm run build`: the build compiles only `src/`
into `dist/`, and vitest transpiles `test/` without typechecking it. The typecheck
covers both.

Coverage thresholds are set just under the measured values. If a change pushes a
number below one of them, write the missing test — do not lower the threshold.

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change. For a
  security fix, check that it really does fail against the old code and say so in the
  commit.
- **Comments** explain constraints the code cannot show — not what the next line does.
  Most comments in this repository exist because something surprising turned out to be
  true about ntfy.
- **Security-sensitive areas** — config parsing, confirmation tokens, anything that
  builds a request URL, anything that puts upstream content into a result — please
  describe the attack you are defending against, or the one your change might open, in
  the pull request text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing. It runs oxlint (type-aware, so it needs the
  `tsconfig.test.json` project) and prettier, which also validates the YAML, JSON and
  Markdown files.

CI runs lint, typecheck, build and the test suite on Node 22 and 24 with coverage
thresholds, plus `npm audit`. CodeQL runs once the repository is public.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/ntfy-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/ntfy-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/ntfy-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
