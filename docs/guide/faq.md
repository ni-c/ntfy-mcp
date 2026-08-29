# FAQ & troubleshooting

## check_topic_access says no, but publishing works anyway

Both answers are correct. **ntfy grants read and write separately per topic**, and
the endpoint behind `check_topic_access` (`/{topic}/auth`) tests the **read** side
only. A write-only publishing token is refused there and can still publish perfectly
well — that is a correct configuration rather than a fault, and it is the single most
common source of confusion with ntfy.

The tool says as much in its own result: a 401 or 403 comes back with a note that
publishing may still work. If you want a token that passes the check, grant it
`read-write` on the topic — but a publisher does not need read access, and not
giving it any is the better shape.

## How do I list the topics on the server?

You cannot, and neither can anything else. **ntfy has no topic enumeration API.** A
topic exists because someone published to it, and on an instance with the default
access rules its name is the whole of the access control — so a list endpoint would
be a list of credentials.

The practical consequences:

- You either know the name or you find it in `get_account` (the topics the account
  is subscribed to) or `list_users` (every account and its per-topic grants, admin
  only).
- An empty `list_messages` result usually means "nothing recent on this topic", not
  "no such topic". Retention is whatever the instance configures — 12 hours by
  default.
- Treat topic names as secrets. `NTFY_TOPICS` keeps them out of the tool arguments
  entirely, because its first entry is the default for any tool called without one.

## Every call fails with setup instructions

`NTFY_URL` is unset. The server starts and lists its tools without it on purpose, so
registries and inspectors can introspect it; every call then returns the missing
configuration instead of reaching the API. There is no default URL — see
[the instance URL](/guide/configuration#the-instance-url).

## The server refuses to start

Four things are fatal at startup, and each names itself on stderr:

- `NTFY_TOKEN` set together with `NTFY_USERNAME`/`NTFY_PASSWORD`, or only one half
  of that pair. Which credential is in force must never be ambiguous, so this is not
  resolved by a precedence rule.
- `NTFY_URL` that does not parse, uses a scheme other than `http`/`https`, or carries
  credentials in the URL. The value is not echoed back — a mis-pasted token is
  exactly the kind of thing that lands in `NTFY_URL`, and that line is a log line.
- An `NTFY_TOPICS` entry that is not a valid topic. Reported by position rather than
  by value, for the same reason.
- An `NTFY_ALLOW_TOOLS`/`NTFY_DENY_TOOLS` entry that matches no tool, or a filter
  combination that would leave the tool list empty.

## Publishing failed with "attachments not allowed"

The message body was over 4096 bytes. ntfy treats an oversized body as an attachment
upload, so its error (`40014`) is about attachments and says nothing about size.
`publish_message` enforces the limit itself and reports the actual byte count, but a
message that reaches ntfy from somewhere else will come back with the confusing form.

The limit is in bytes, not characters: accented letters, CJK and emoji each count for
more than one.

## I published to three topics and only some arrived

Check the `ok` field of each entry in the result rather than assuming the call
succeeded as a whole. **ntfy has no multi-topic publish**, so `publish_message` sends
one request per topic and reports each outcome separately — a rejection on one topic
does not discard the ones that succeeded. Polling is the other way round:
`list_messages` takes several topics in one request.

## I cannot update a notification I published

`update_message` needs the `sequence_id` that `publish_message` returned, and the
sequence id only exists for **cached** messages. One published with `cache: false`
reaches the clients connected at that moment and nothing else, so it cannot be
updated or deleted afterwards.

`cache` and `firebase` are booleans in this server and strings in ntfy's JSON body,
which wants the literal `"no"` and silently ignores `false`. The mapping happens
here, so `false` is the right thing to pass.

## get_server_info reports "version" as unavailable

That section needs an admin account, so its absence is normal for a non-admin token
rather than an error. Each section is fetched independently and one that fails does
not fail the call. The same object reports `admin_tools_available`, which answers
"should I even try `list_users`, `create_user` and the access tools?" from one cheap
call instead of after a confusing 401.

<!-- Keep this entry, and keep it last. "A tool is missing" is the one question the
     tool filter creates, and the answer people reach for first — a bug — is the
     wrong one. -->

## One tool I expected is missing

Something narrowed the list. In order of likelihood:

- `NTFY_READ_ONLY` is set, and it is a write tool.
- `NTFY_ALLOW_TOOLS` is set and does not name it — it is an allow list, so anything
  not named is out. `NTFY_ALLOW_TOOLS=essential` is six tools, not thirteen.
- `NTFY_DENY_TOOLS` names it, possibly through a prefix such as `delete_*`.

A filtered tool is not registered at all, so it is missing from `tools/list` and
answers `tools/call` with "tool not found" — the same as a write tool under
read-only. There is no state where it is hidden but still callable.

What it is _not_ is a typo in one of those variables: an entry that matches no tool
stops the server at startup and says which entry it was. See
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).
