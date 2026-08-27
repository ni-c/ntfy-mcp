# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/ntfy-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

The credentials this server holds are ntfy credentials, and what they grant depends
entirely on what the ntfy account is allowed to do — so the answer is "as much as you
gave it", and the useful advice is to give it little.

- **A publishing token** can send notifications to the topics it is granted. Those
  notifications reach real devices, so the practical damage is noise, plausible
  phishing in your own alerting channel, and — if the account also has read access —
  a way to move data off the instance by publishing it to a topic somebody else is
  subscribed to.
- **An admin account** can enumerate every account on the instance, create accounts,
  and grant or revoke access to any topic. That is the whole authorization model of
  the ntfy server. Do not give this server an admin account unless you are actually
  using the user and access tools, and prefer a dedicated non-admin account with
  `write-only` access to the topics it needs.

Two ntfy-specific things worth stating plainly:

- **A topic name is a bearer credential.** On an instance with the default
  `auth-default-access`, anyone who knows a topic name can subscribe to it and publish
  to it. Set `NTFY_TOPICS` so this server can only touch the ones you meant, and treat
  the names the way you would treat a password.
- **The write tools are registered by default.** `NTFY_READ_ONLY` defaults to `false`
  because ntfy exists to publish. The residual risk that follows: a prompt-injected
  client can publish what it has just read to another topic on the same instance.
  Confirmation tokens do not help, because publishing is not a destructive operation.
  `NTFY_TOPICS` is the control that does, and an account scoped to those topics is the
  control behind it.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a system whose data you would not put in a model's context.

Destructive operations require a server-generated confirmation token that is bound to
the specific target; a model cannot satisfy that gate on its own. Data returned from
the upstream API is untrusted input: it is marked as such, and confirmation prompts
never quote it.
