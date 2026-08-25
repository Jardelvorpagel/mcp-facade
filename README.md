# mcp-facade

A generic MCP facade: one stdio process sits in front of an upstream MCP server
and exposes only a configured subset of its tools — with compacted schemas —
plus three meta-tools (`discover`, `describe`, `call`) that keep the rest of the
catalog reachable on demand.

## Why

Every tool an MCP server exposes is injected into the model's context as a JSON
schema on **every request**. A fat server with 40 tools can cost tens of
thousands of tokens per session before any work happens — most of it for tools
you never call.

The facade flips the economics: you pay full schema tokens only for the tools
you actually use (listed in `used`), compacted to their essentials. Everything
else stays discoverable through the meta-tools, which cost three small schemas
total.

## What it does

- Runs as a stdio MCP server: `bun run facade.ts --server <name>`. One process
  per upstream server.
- Reads `facade.servers.json` (next to `facade.ts`) and picks the `<name>` entry.
- On the first `tools/list`, fetches the upstream catalog and caches it to disk
  (`~/.omp/agent/mcp-facade/catalogs/<name>.json`, 7-day TTL). The upstream
  connection is lazy — nothing connects until first use.
- Serves each `used` tool with a compacted schema:
  - every `description` string (tool-level and inside the JSON schema) is cut to
    its first sentence, max 140 chars;
  - `$comment`, `examples`, and `default` keys are dropped recursively;
  - structure (types, properties, required, enums) is left intact;
  - tool names are lowercased; lookup is case-insensitive.
- Always appends the three meta-tools (see below).
- If the catalog can't be fetched at `tools/list` time, it degrades to serving
  the meta-tools only and logs the reason to stderr.
- Forwards calls to the upstream. For HTTP upstreams with a `credentialId`, a
  401/unauthorized/expired-token error triggers one token force-refresh and a
  single retry.

## The meta-tools

| Tool | Purpose |
| --- | --- |
| `discover` | Keyword-search the full upstream catalog (name + description, substring, max 10 hits). Returns `name — one-line description` lines. |
| `describe` | Return the **full original** schema and documentation for one tool, by lowercase name. Use before calling an unfamiliar tool. |
| `call` | Call any upstream tool by name with an `args` object, including tools not in `used`. |

Typical agent flow: `discover "worklog"` → `describe addworklog` →
`call { tool: "addworklog", args: { ... } }`.

## Requirements

- [Bun](https://bun.sh) (the facade runs TypeScript directly).
- For OAuth-protected HTTP upstreams: the OMP `omp` CLI installed at `~/.bun/bin/omp`, with the credential already authorized. The facade fetches tokens via `omp token <credentialId>` (and `omp token --force-refresh <credentialId>` on retry). Secrets are never stored in the config.
- For stdio upstreams that need env vars (API keys, tokens): an existing Claude
  host config at `~/.claude.json` holding that server's `env` block (see
  `envFrom` below).

## Install

```sh
bun install
cp facade.servers.example.json facade.servers.json   # then edit
```

`facade.servers.json` is gitignored — it may contain local paths.

## Configuration

`facade.servers.json` maps a server name to its upstream and used-tools list:

```jsonc
{
  "<name>": {
    "upstream": {
      // HTTP upstream (Streamable HTTP transport):
      "url": "https://mcp.example.com/v1/mcp",
      "credentialId": "mcp_oauth:profile:default:https://mcp.example.com/v1/mcp" // optional

      // …or stdio upstream:
      // "command": "/usr/local/bin/npx",
      // "args": ["-y", "@example/mcp-server"],
      // "envFrom": "claude:<server-name>",  // optional: pull env from ~/.claude.json mcpServers.<server-name>.env
      // "env": { "EXTRA": "value" }          // optional: merged on top
    },
    "used": ["tool_one", "tool_two"]  // exposed directly; everything else via meta-tools
  }
}
```

Notes:

- `used` entries are matched case-insensitively and served lowercased.
- `envFrom` currently only supports the `claude:<name>` prefix.
- An empty `used` list is valid: the facade then exposes only the meta-tools.

## Registering with a host

Point your host's MCP config at the facade, one entry per upstream:

```jsonc
{
  "mcpServers": {
    "acme": {
      "command": "/path/to/bun",
      "args": ["run", "/path/to/mcp-facade/facade.ts", "--server", "acme-http"]
    }
  }
}
```

## ⚠️ stdout is protocol

The stdio transport owns stdout. **Never** write logs, diagnostics, or debug
output to stdout — anything on stdout corrupts the JSON-RPC stream and wedges
the host. The facade logs only to stderr (`console.error`); keep it that way in
any fork.

## Limitations

- Hardcoded paths: catalog cache at `~/.omp/agent/mcp-facade/catalogs/`, OMP
  binary at `~/.bun/bin/omp`, `envFrom` reads `~/.claude.json` only.
- Catalog is fetched with a single `listTools` call — no pagination, no
  `tools/list_changed` handling. Restart the facade (or wait out the 7-day TTL)
  to pick up upstream tool changes.
- `discover` is a simple substring match, capped at 10 results.
- One retry on auth failure; other upstream errors propagate as-is.
- No support for upstream prompts, resources, or sampling — tools only.
