# Tools

Thirteen tools: six read, seven write. The write tools are **not registered** when
`NTFY_READ_ONLY=true` — note that it defaults to `false`, so an unconfigured server
offers all thirteen.

Beyond that, `NTFY_ALLOW_TOOLS` and `NTFY_DENY_TOOLS` narrow the list, and
`NTFY_ALLOW_TOOLS=essential` selects the six marked **essential** below — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

Three tools require a **confirmation token**: `delete_messages`, `delete_user` and
`manage_user_access`. Each is refused on the first call and answered with a
short-lived, single-use token bound to the exact target; a second call carrying that
token performs the operation. See [Security](/guide/security#confirmation-tokens).

Every tool that takes a topic falls back to the first entry of `NTFY_TOPICS` when it
is omitted, and refuses a topic outside that list when it is set.

## At a glance

| Tool                   | Kind  | Preset        | Notes                                        |
| ---------------------- | ----- | ------------- | -------------------------------------------- |
| `list_messages`        | read  | **essential** |                                              |
| `get_message`          | read  | **essential** |                                              |
| `check_topic_access`   | read  | **essential** | tests the read side only                     |
| `get_server_info`      | read  | **essential** | works before the credentials are right       |
| `get_account`          | read  | —             | token values redacted                        |
| `list_users`           | read  | —             | admin                                        |
| `publish_message`      | write | **essential** |                                              |
| `update_message`       | write | **essential** |                                              |
| `mark_messages_read`   | write | —             |                                              |
| `delete_messages`      | write | —             | confirmation token                           |
| `create_user`          | write | —             | admin                                        |
| `delete_user`          | write | —             | admin, confirmation token                    |
| `manage_user_access`   | write | —             | admin, confirmation token                    |

## Read tools

Registered always.

### list_messages

**essential** — Polls the cached messages of one or more topics, oldest first.

Returns a `next_since` cursor: pass it back as `since` to get only what arrived
after this call. Message bodies are shortened here; use `get_message` for one in
full. Entries carrying an `updates` field revise an earlier notification rather than
being new ones.

Retention is whatever the instance configures, 12 hours by default, so an empty
result usually means "nothing recent" rather than "no such topic" — ntfy has no way
to list the topics that exist.

| Parameter   | Type              | Description                                                                                                                    |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `topics`    | string[] (1–10)   | Topics to poll. Defaults to the first `NTFY_TOPICS` entry                                                                      |
| `since`     | string            | `all`, `latest`, `none`, a 12-character message id (exclusive), a Unix timestamp, or a duration such as `24h`. Defaults to `24h` |
| `id`        | string            | Return only the message with this id                                                                                           |
| `title`     | string (≤200)     | Exact-match filter on the title                                                                                                |
| `message`   | string (≤200)     | Exact-match filter on the message body                                                                                         |
| `priority`  | array (1–5)       | Priorities to include — matches **any** of them                                                                                |
| `tags`      | string[] (1–10)   | Tags to filter by — a message must carry **all** of them. The opposite of `priority`                                            |
| `scheduled` | boolean           | Also include delayed messages that have not been delivered yet                                                                 |
| `limit`     | integer (1–200)   | Most recent messages to return. Default 50                                                                                     |

All parameters are optional. The result is framed as untrusted data.

### get_message

**essential** — Fetches a single cached message in full, including the untruncated
body, its action buttons and any attachment. Ids come from `list_messages` or from
the result of `publish_message`.

| Parameter | Type   | Required | Description                                                |
| --------- | ------ | -------- | ---------------------------------------------------------- |
| `id`      | string | yes      | The 12-character message id                                |
| `topic`   | string | no       | Topic to look in. Defaults to the first `NTFY_TOPICS` entry |

A message that is not in the cache is reported as such — it may have expired, or it
was published to another topic.

### check_topic_access

**essential** — Reports whether the configured credentials may **subscribe** to each
topic, without publishing anything.

Read the result carefully: ntfy grants read and write separately, and the endpoint
behind this tool tests the read side only. A write-only publishing token is denied
here and can still publish perfectly well. A 401 or 403 therefore comes back with a
note saying so rather than as a flat failure.

| Parameter | Type            | Required | Description                                             |
| --------- | --------------- | -------- | ------------------------------------------------------- |
| `topics`  | string[] (1–10) | no       | Topics to check. Defaults to the first `NTFY_TOPICS` entry |

The topics are checked sequentially, not in parallel: repeated authentication
failures trip ntfy's own auth rate limit, and a parallel fan-out is the fastest way
to get there.

### get_server_info

**essential** — Health, capabilities and usage of the ntfy instance. Takes no
parameters.

Health, config and stats are public on a default instance, so this is the one tool
that works before the credentials are right — a good first call after setup. Each
section is fetched independently; one that is unavailable is reported as such and
does not fail the call. `version` needs an admin account, so its absence is normal.

The result also carries `admin_tools_available`, `authenticated_as` and
`topics_restricted_to`, which answer "should I try the user and access tools?" and
"which topics may this server touch?" from the same cheap call.

### get_account

Identity, role, tier, limits and current usage of the configured credentials. Takes
no parameters.

**Access token values are redacted** — only their labels and timestamps are shown —
and so is the account's `sync_topic`, because a topic name is a bearer secret. ntfy
returns every token of the account in plaintext here.

### list_users

Every account on the instance with its per-topic grants — the answer to "who can
read or write topic X". Requires an admin account; `get_server_info` reports whether
the current one qualifies.

| Parameter  | Type            | Description                                                        |
| ---------- | --------------- | ------------------------------------------------------------------ |
| `username` | string          | Return only this account                                           |
| `topic`    | string          | Return only accounts with a grant whose pattern matches this topic |
| `limit`    | integer (1–500) | Accounts to return. Default 100                                    |

All three are optional. Only `username`, `role`, `tier` and the grants are returned;
whatever else ntfy sends is dropped rather than forwarded.

## Write tools

Registered unless `NTFY_READ_ONLY=true`.

### publish_message

**essential** — Sends a notification to one or more topics. At least one of
`message` or `title` is required.

ntfy has no multi-topic publish, so this sends **one request per topic** and reports
each outcome separately — check the `ok` field per entry rather than assuming the
whole call worked. A rejection on one topic does not discard the ones that succeeded.

The returned id is also the notification's sequence id: pass it to `update_message`
to revise this notification in place, which is how a progress report stays one
notification instead of five.

| Parameter  | Type              | Description                                                                                     |
| ---------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `topics`   | string[] (1–10)   | Topics to publish to. Defaults to the first `NTFY_TOPICS` entry                                 |
| `message`  | string (≤4096 B)  | The notification body. Counted in bytes, not characters                                         |
| `title`    | string (≤250 B)   | The notification title                                                                          |
| `priority` | number or string  | 1 (min) to 5 (max), or `min`, `low`, `default`, `high`, `max` (`urgent` is accepted for max)     |
| `tags`     | string[] (≤20)    | One tag per entry. A name matching an emoji short code renders as that emoji                    |
| `click`    | string            | URL opened when the notification itself is tapped. `http`/`https` only                          |
| `icon`     | string            | URL of a JPEG or PNG icon. `http`/`https` only                                                  |
| `markdown` | boolean           | Render the message as Markdown in clients that support it                                       |
| `actions`  | array (≤3)        | Action buttons — see below                                                                      |
| `attach`   | string            | URL of a file to attach by reference. `http`/`https` only                                       |
| `filename` | string (≤255)     | Download name for the attachment. No path separators or control characters                      |
| `delay`    | string            | Deliver later: a duration such as `30m`, a Unix timestamp, or `tomorrow, 10am`. 10 seconds to 3 days |
| `cache`    | boolean           | `false` keeps the message out of the server cache                                               |
| `firebase` | boolean           | `false` skips forwarding via Firebase                                                           |

All parameters are optional; the constraint is that `message` or `title` is present.

`cache: false` means the notification reaches only the clients connected at that
moment and can afterwards be neither updated nor deleted. Combining it with `delay`
is refused with an explanation — a delayed message has to exist on the server until
it fires.

`cache` and `firebase` are booleans here and strings in ntfy's JSON body, which
wants the literal `"no"` and silently ignores `false`. The mapping happens in the
server, which is the only shape a model cannot get wrong.

#### Action buttons

Up to three; a fourth is rejected by ntfy. Every action takes a `label` (1–64
characters) and an optional `clear` boolean, plus:

| `action`    | Fields                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------ |
| `view`      | `url` — opens it on the device                                                             |
| `http`      | `url`, `method` (GET, POST, PUT, PATCH, DELETE — **POST by default**), `headers`, `body`   |
| `copy`      | `value` (≤4096 characters) — copies it to the clipboard                                    |
| `broadcast` | `intent`, `extras` — Android only                                                          |

An `http` action fires from the recipient's device, not from the server. `url` must
be `http` or `https` for the same reason.

### update_message

**essential** — Replaces the content of a notification already published, so
subscribers see it change in place instead of receiving another one. At least one
content field is required.

The sequence id is the id returned by `publish_message`, and it only exists for
cached messages: one published with `cache: false` cannot be updated. Only the
fields given are sent. The cache keeps each revision as its own entry pointing back
at the original, which is why `list_messages` shows them with an `updates` field.

| Parameter     | Type   | Required | Description                                                  |
| ------------- | ------ | -------- | ------------------------------------------------------------ |
| `sequence_id` | string | yes      | Id of the notification to revise, from `publish_message`     |
| `topic`       | string | no       | Its topic. Defaults to the first `NTFY_TOPICS` entry         |

Plus the content fields of `publish_message`: `message`, `title`, `priority`,
`tags`, `click`, `icon`, `markdown` and `actions`. The publish-only fields
(`attach`, `filename`, `delay`, `cache`, `firebase`) are not part of an update.

### mark_messages_read

Clears notifications on subscribers' devices. The messages stay in the server cache
and remain readable with `list_messages`.

| Parameter      | Type            | Required | Description                                           |
| -------------- | --------------- | -------- | ----------------------------------------------------- |
| `sequence_ids` | string[] (1–25) | yes      | Ids of the notifications to clear                     |
| `topic`        | string          | no       | Their topic. Defaults to the first `NTFY_TOPICS` entry |

Each id is reported separately, so one failure does not hide the successes.

### delete_messages

**Confirmation token required.** Deletes notifications and cancels scheduled ones
that have not been delivered yet.

| Parameter       | Type            | Required | Description                                            |
| --------------- | --------------- | -------- | ------------------------------------------------------ |
| `sequence_ids`  | string[] (1–25) | yes      | Ids of the notifications to delete                     |
| `topic`         | string          | no       | Their topic. Defaults to the first `NTFY_TOPICS` entry |
| `confirm_token` | string          | no       | The token from this tool's previous, unconfirmed response |

Call once without `confirm_token` to receive the token, then again with it. The
token is bound to a fingerprint of the exact set of ids, so one issued for a single
message cannot execute a longer list.

### create_user

Creates a **non-admin** account on a self-hosted instance. Requires an admin
account. The API cannot create administrators; only the ntfy command line can
(`ntfy user add --role=admin`).

| Parameter  | Type            | Required | Description                                    |
| ---------- | --------------- | -------- | ---------------------------------------------- |
| `username` | string (≤64)    | yes      | The account name                               |
| `password` | string (8–128)  | yes      | Initial password                               |
| `tier`     | string (≤64)    | no       | Tier name, on an instance that defines tiers   |

A new account can reach nothing until `manage_user_access` grants it a topic. Be
aware that a password passed as a tool argument stays in the conversation
transcript — for an account that matters, create it on the server instead. The
password is not echoed back in the result.

### delete_user

**Confirmation token required.** Removes an account and every access grant attached
to it. Requires an admin account.

| Parameter       | Type         | Required | Description                                               |
| --------------- | ------------ | -------- | --------------------------------------------------------- |
| `username`      | string (≤64) | yes      | The account to remove                                     |
| `confirm_token` | string       | no       | The token from this tool's previous, unconfirmed response |

### manage_user_access

**Confirmation token required.** Sets or removes an account's access to a topic or
topic pattern. Requires an admin account.

Destructive in both directions, which is why it is gated: taking access away breaks
a running publisher, and granting it exposes a topic's traffic to another account.

| Parameter       | Type         | Required | Description                                               |
| --------------- | ------------ | -------- | --------------------------------------------------------- |
| `username`      | string (≤64) | yes      | The account to change                                     |
| `topic`         | string (≤64) | yes      | A topic name, or a prefix ending in `*`                   |
| `action`        | enum         | yes      | See below                                                 |
| `confirm_token` | string       | no       | The token from this tool's previous, unconfirmed response |

| `action`     | Effect                                                                     |
| ------------ | -------------------------------------------------------------------------- |
| `read_write` | Read and write the topic                                                   |
| `read_only`  | Subscribe only                                                             |
| `write_only` | Publish only                                                               |
| `deny`       | An explicit refusal — the only way to carve an exception out of a wildcard  |
| `revoke`     | Removes the rule entirely, so a broader wildcard or the server default applies again |

Five unambiguous names rather than ntfy's nine aliases for four permissions (`rw`,
`read-write`, `ro`, `read`, `read-only`, …), which is nine ways for a model to be
almost right. `deny` and `revoke` really are different, and both are needed.

The confirmation token is bound to the three arguments **in order**, because their
vocabularies overlap: a token approved for one account-and-topic pair must not
execute the reverse pair.
