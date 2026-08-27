# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/ntfy-mcp.git && cd ntfy-mcp
npm install
npm run lint && npm run typecheck && npm run build && npm test
```

A disposable ntfy server is one command:

```sh
docker run --rm -p 127.0.0.1:8080:80 binwiederhier/ntfy:latest serve
```

Point `NTFY_URL` at `http://127.0.0.1:8080` and drive the built server with the MCP
inspector. Please do not develop against an instance anyone relies on — these tools
publish real notifications to real devices, and `manage_user_access` rewrites the
authorization model of the whole server.

To exercise the permission behaviour you need more than one account, because ntfy
grants read and write separately:

```sh
docker exec -e NTFY_PASSWORD=… <container> ntfy user add --role=admin devadmin
docker exec -e NTFY_PASSWORD=… <container> ntfy user add devpub
docker exec <container> ntfy access devpub devtopic write-only
```

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
- Run `npm run lint` before pushing. It runs eslint (type-aware, so it needs the
  `tsconfig.test.json` project) and prettier, which also validates the YAML, JSON and
  Markdown files.

CI runs lint, typecheck, build and the test suite on Node 22 and 24 with coverage
thresholds, plus `npm audit`. CodeQL runs once the repository is public.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/ntfy-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/ntfy-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/ntfy-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
