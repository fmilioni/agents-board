# agents-board (Codex plugin)

The Codex package bundles three user-facing workflows, one internal review skill, and an MCP connection:

- **`$agents-board`** — orient on the board, resolve the repository binding, and route to the right workflow.
- **`$plan`** — turn a new demand into sprints, stories, and tasks.
- **`$implement`** — execute existing cards through their required lifecycle.
- **`$reviewer`** — internal, explicit-only review protocol loaded by a fresh read-only subagent from `$implement`.

## Installation

From the repository root, add the repository marketplace and install the plugin:

```bash
codex plugin marketplace add fmilioni/agents-board
codex plugin add agents-board@agents-board
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
codex mcp add agents-board-remote --url https://mcp.example.com/mcp
```

Use a server name other than `agents-board`; that name belongs to the bundled local connection. Each host keeps its own OAuth session and projects, and the skills must never mix entities from different hosts.
