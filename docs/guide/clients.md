# Connecting clients

## Claude Code

```sh
claude mcp add ntfy-mcp -- npx -y @ni-c/ntfy-mcp
```

That registers the server with whatever `NTFY_*` variables the shell already has.
To pin them to this server instead:

```sh
claude mcp add ntfy-mcp -s user \
  -e NTFY_URL=https://ntfy.example.net \
  -e NTFY_TOKEN=tk_… \
  -e NTFY_TOPICS=alerts \
  -- npx -y @ni-c/ntfy-mcp
```

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ntfy-mcp": {
      "command": "npx",
      "args": ["-y", "@ni-c/ntfy-mcp"],
      "env": {
        "NTFY_URL": "https://ntfy.example.net",
        "NTFY_TOKEN": "…",
        "NTFY_TOPICS": "deploys"
      }
    }
  }
}
```

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.ntfy-mcp]
command = "npx"
args = ["-y", "@ni-c/ntfy-mcp"]
env = { NTFY_URL = "https://ntfy.example.net", NTFY_TOKEN = "…", NTFY_TOPICS = "deploys" }
```

## MCP Inspector

Useful for reading the tool schemas and calling tools by hand — including against a
local instance on loopback, where plain `http` is accepted without a warning:

```sh
NTFY_URL=http://127.0.0.1:8080 NTFY_TOPICS=alerts \
  npx @modelcontextprotocol/inspector npx -y @ni-c/ntfy-mcp
```

## Docker

```sh
docker run -i --rm \
  -e NTFY_URL=https://ntfy.example.net -e NTFY_TOPICS=alerts \
  ghcr.io/ni-c/ntfy-mcp
```

As an MCP client entry:

```json
{
  "mcpServers": {
    "ntfy-mcp": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "NTFY_URL=https://ntfy.example.net",
        "-e", "NTFY_TOPICS=alerts",
        "ghcr.io/ni-c/ntfy-mcp"
      ]
    }
  }
}
```

The image is multi-arch (amd64 and arm64), published with an SBOM and build
provenance, and runs as the unprivileged `node` user with no npm in the runtime
layer. It speaks stdio only, so it needs `-i` and exposes no port.

<!-- "Through mcp-hub" goes here: after Docker, the last "how you actually run it"
     section. It is a peer of the other clients, never ranked above them.

     The third paragraph is the one that matters and must not be cut. It is the
     only place the two filters sit side by side, and "allowTools": ["essential"]
     in mcp.json — which does nothing — is exactly the mistake this section exists
     to prevent. -->

## Through mcp-hub

[mcp-hub](https://mcp-hub.ni-c.de) serves many stdio MCP servers from one container
behind a single HTTPS endpoint, so ntfy-mcp can be reached from clients that cannot
spawn a local process — ChatGPT connectors, Claude on the web, Cursor — without a
container, a hostname and an OAuth stack of its own.

Its `/config/mcp.json` uses Claude Code's format, so the entry is the one you
already have:

```json
{
  "mcpServers": {
    "ntfy-mcp": {
      "command": "npx",
      "args": ["-y", "@ni-c/ntfy-mcp"],
      "env": {
        "NTFY_URL": "https://ntfy.example.net",
        "NTFY_TOKEN": "…",
        "NTFY_TOPICS": "alerts",
        "NTFY_ALLOW_TOOLS": "essential"
      },
      "denyTools": ["delete_messages"]
    }
  }
}
```

`allowTools` and `denyTools` are the hub's **own** per-server filter and take exact
tool names or `list_*` prefixes — the same syntax as the two environment variables,
so a list moves between them verbatim. What does **not** move is `essential`: that
preset is an ntfy-mcp feature and belongs in `env` as shown.
`"allowTools": ["essential"]` would be a name the hub cannot resolve.

The two compose, and it is worth knowing which does what: the server registers what
its environment variables allow, and the hub exposes what its arrays allow.
Filtering in the server is the tighter of the two — the tool is never built.

Register `https://your-host/ntfy-mcp/mcp` as a connector and you get this server
alone. Register the hub's `/hub` endpoint instead and you reach _every_ server
behind it through six meta-tools, which is the answer worth having once you run
several of these at once.
