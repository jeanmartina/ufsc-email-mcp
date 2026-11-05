# Connecting clients

## Claude Code

```sh
claude mcp add imap -s user \
  -e IMAP_HOST=imap.example.net \
  -e IMAP_USER=me@example.net \
  -e IMAP_PASSWORD=… \
  -- npx -y @ni-c/imap-mcp
```

That gives you a read-only server: `IMAP_READ_ONLY` defaults to `true`. Add
`-e IMAP_READ_ONLY=false` for the mailbox write tools.

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "imap": {
      "command": "npx",
      "args": ["-y", "@ni-c/imap-mcp"],
      "env": {
        "IMAP_HOST": "imap.example.net",
        "IMAP_USER": "me@example.net",
        "IMAP_PASSWORD": "…"
      }
    }
  }
}
```

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.imap]
command = "npx"
args = ["-y", "@ni-c/imap-mcp"]
env = { IMAP_HOST = "imap.example.net", IMAP_USER = "me@example.net", IMAP_PASSWORD = "…" }
```

## MCP Inspector

Useful for reading the tool schemas and calling tools by hand:

```sh
IMAP_HOST=imap.example.net IMAP_USER=me@example.net IMAP_PASSWORD=… \
  npx @modelcontextprotocol/inspector npx -y @ni-c/imap-mcp
```

## Docker

The image speaks stdio like the npm package, so `-i` is required and there is no
port to publish:

```sh
docker run --rm -i \
  -e IMAP_HOST=imap.example.net \
  -e IMAP_USER=me@example.net \
  -e IMAP_PASSWORD=… \
  ghcr.io/ni-c/imap-mcp
```

In a client configuration that becomes the command:

```json
{
  "mcpServers": {
    "imap-mcp": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "IMAP_HOST",
        "-e",
        "IMAP_USER",
        "-e",
        "IMAP_PASSWORD",
        "ghcr.io/ni-c/imap-mcp"
      ],
      "env": {
        "IMAP_HOST": "imap.example.net",
        "IMAP_USER": "me@example.net",
        "IMAP_PASSWORD": "…"
      }
    }
  }
}
```

Passing `-e NAME` without a value forwards the variable from the client's
environment instead of baking the password into the argument list, where every
`ps` on the machine can read it.

The container runs as uid 1000 and never writes to the filesystem unless
`IMAP_DOWNLOAD_DIR` is set. If you do set it, the bind-mounted directory has to be
owned by uid 1000 **on the host** — a `chown` inside the Dockerfile only affects
the image layer, not your mount:

```sh
mkdir attachments && sudo chown 1000:1000 attachments
docker run --rm -i \
  -e IMAP_HOST=imap.example.net -e IMAP_USER=me@example.net -e IMAP_PASSWORD=… \
  -e IMAP_DOWNLOAD_DIR=/data -v "$PWD/attachments:/data" \
  ghcr.io/ni-c/imap-mcp
```

<!-- "Through mcp-hub" goes here: after Docker, which is the last "how you actually
     run it" section, and before anything about the artifact (Pinning a version,
     From source, Verifying what you install). It is a peer of the other clients,
     never ranked above them.

     The third paragraph is the one that matters and must not be cut. It is the
     only place the two filters sit side by side, and "allowTools": ["essential"]
     in mcp.json — which does nothing — is exactly the mistake this section exists
     to prevent. -->

## Through mcp-hub

[mcp-hub](https://mcp-hub.ni-c.de) serves many stdio MCP servers from one container
behind a single HTTPS endpoint, so imap-mcp can be reached from clients that cannot
spawn a local process — ChatGPT connectors, Claude on the web, Cursor — without a
container, a hostname and an OAuth stack of its own.

Its `/config/mcp.json` uses Claude Code's format, so the entry is the one you
already have:

```json
{
  "mcpServers": {
    "imap-mcp": {
      "command": "npx",
      "args": ["-y", "@ni-c/imap-mcp"],
      "env": {
        "IMAP_HOST": "imap.example.net",
        "IMAP_USER": "me@example.net",
        "IMAP_PASSWORD": "…",
        "IMAP_ALLOW_TOOLS": "essential"
      },
      "denyTools": ["delete_messages"]
    }
  }
}
```

`allowTools` and `denyTools` are the hub's **own** per-server filter and take exact
tool names or `list_*` prefixes — the same syntax as the two environment variables,
so a list moves between them verbatim. What does **not** move is `essential`: that
preset is an imap-mcp feature and belongs in `env` as shown.
`"allowTools": ["essential"]` would be a name the hub cannot resolve.

The two compose, and it is worth knowing which does what: the server registers what
its environment variables allow, and the hub exposes what its arrays allow.
Filtering in the server is the tighter of the two — the tool is never built.

Register `https://your-host/imap-mcp/mcp` as a connector and you get this server
alone. Register the hub's `/hub` endpoint instead and you reach _every_ server
behind it through six meta-tools, which is the answer worth having once you run
several of these at once.
