# claude-organizer plugin

Claude Organizer is Codex-first and keeps a compatible Claude Code package. It bundles three user-facing workflows, one internal review protocol, and an MCP connection:

- **`$claude-organizer`** — orient on the board, resolve the repository binding, and route to the right workflow.
- **`$plan`** — turn a new demand into sprints, stories, and tasks.
- **`$implement`** — execute existing cards through their required lifecycle.
- **`$reviewer`** — internal, explicit-only review protocol loaded by a fresh read-only subagent from `$implement`.

## Codex installation

From the repository root, add the repository marketplace and install the plugin:

```bash
codex plugin marketplace add fmilioni/claude-organizer
codex plugin add claude-organizer@claude-organizer
```

Start a new Codex task after installing or updating so the bundled skills and MCP tools are loaded.

## MCP server

The Codex manifest registers the local Streamable HTTP endpoint at `http://127.0.0.1:4402/mcp`. Run the stack from this monorepo before using the workflows:

```bash
docker compose up -d --build
```

For a remote board, add a second named server and point the helper scripts at the matching API host:

```bash
export AB_API_URL=https://api.example.com
codex mcp add claude-organizer-remote --url https://mcp.example.com/mcp
```

Use a server name other than `claude-organizer`; that name belongs to the bundled local connection. Each host keeps its own OAuth session and projects, and the skills must never mix entities from different hosts.

## Claude Code compatibility

The legacy manifest and MCP configuration remain in the same plugin directory. Install them through Claude Code's marketplace:

```text
/plugin marketplace add fmilioni/claude-organizer
/plugin install claude-organizer@claude-organizer
```

For local development, `claude --plugin-dir plugins/claude-organizer` remains supported. Claude Code can still override its bundled MCP URL with `AB_MCP_URL`; that override is specific to the legacy `.mcp.json` path and does not change the Codex plugin's fixed local connection.
