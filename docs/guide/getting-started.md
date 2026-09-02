# Getting started

## Requirements

- Node.js ≥ 22
- A reachable **ntfy** server. Credentials are optional: an instance that allows
  anonymous access needs none.

## Run it

```sh
NTFY_URL=https://ntfy.example.net NTFY_TOPICS=alerts npx -y @ni-c/ntfy-mcp
```

`NTFY_URL` is the only required variable, and it has no default. `https://ntfy.sh`
would be the obvious one and the worst possible one — a misconfigured server would
publish to the public internet rather than failing.

With credentials:

```sh
NTFY_URL=https://ntfy.example.net \
  NTFY_TOKEN=tk_… \
  NTFY_TOPICS=alerts,deploys \
  npx -y @ni-c/ntfy-mcp
```

Use `NTFY_USERNAME` and `NTFY_PASSWORD` instead where the account has no token —
`ntfy user add` produces a username and a password, not a token. Setting both forms
at once stops the server at startup; see
[Configuration](/guide/configuration#credentials).

Without configuration the server still starts and lists its tools, so registries and
inspectors can introspect it; every call then fails with setup instructions instead
of reaching the API.

## Writes are on

`NTFY_READ_ONLY` defaults to `false`, so the seven write tools are registered. ntfy
exists to publish, and a read-only default would ship a notification server that
cannot notify. Two things follow from that direction, and both are covered under
[Configuration](/guide/configuration#read-only-and-why-it-defaults-to-false).

## The first call worth making

```
Is the ntfy server reachable, and can you post to the alerts topic?
```

`get_server_info` reads `/v1/health`, `/v1/config` and `/v1/stats`, which are public
on a default instance — so it is the one tool that answers before the credentials
are right. It also reports whether the account is an admin, which decides whether
the user and access tools are worth trying at all.

`check_topic_access` then tests the topic. Read its answer carefully: it tests the
**read** side, and a write-only publishing token is denied there while publishing
works perfectly well. That combination is the single most common source of confusion
with ntfy, and the tool says so in its own result.

## Then publish something

```
Send me a notification on the alerts topic when the test suite finishes.
```

Keep the id that comes back. Passing it to `update_message` as `sequence_id` revises
that notification in place instead of sending a second one — and asks you first,
because the revision replaces the message on the devices that already have it.
