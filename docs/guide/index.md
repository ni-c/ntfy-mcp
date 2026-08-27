# What is ntfy-mcp?

An MCP server for [ntfy](https://ntfy.sh), the pub-sub notification service that
sends push messages to your phone with an HTTP request and nothing else.

It lets MCP clients like Claude Code, Claude Desktop or Codex send you
notifications, read back what was sent, revise a notification in place while a job
runs, and — with an admin account — create accounts and grant or revoke their access
to topics, which otherwise means the `ntfy` command line on the server.

## Why

A long-running task that finishes while nobody is watching is the case ntfy exists
for, and it is exactly the case an assistant runs into. The interesting part is not
the first message but the second: `publish_message` returns an id that is also the
notification's sequence id, so `update_message` can revise the same notification
rather than adding another one. A build that reports "running", "tests passed" and
"deployed" stays one entry on the phone.

The other half is administration. ntfy's authorization model — which account may
read or write which topic — is otherwise reachable only through the `ntfy` command
line on the server, and `list_users` answers "who can read topic X" from a client.

## What it is not

- **A mail or telephone gateway.** ntfy can turn a published message into an email
  or a phone call. Neither is exposed here: a tool that mails an arbitrary address
  on model output is a spam relay driven by injectable content, and `call` places a
  real, billable call.
- **A way to obtain credentials.** No tool creates, reads or exchanges an ntfy
  access token, because every such endpoint hands back a live credential that would
  then sit in the conversation transcript.
- **A subscriber.** `/sse`, `/ws` and `/raw` are streams; a tool call is
  request/response under a timeout. `list_messages` returns the same data, bounded.
- **An upload endpoint.** Attachments are attached by URL. The alternative is
  base64 through the model's context or a local filesystem this server has no
  business touching.
