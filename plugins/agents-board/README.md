# agents-board (plugin)

One plugin package, one set of skills, both hosts. Codex reads `.codex-plugin/plugin.json`, Claude Code reads `.claude-plugin/plugin.json` + `.mcp.json`, and both load the same host-neutral `skills/`.

- **`agents-board`** — how to use the board: find the project, read cards/sprints/backlog, search cards and docs semantically, move a card through its statuses, comment, write docs, work the inbox, attach a diff or an image.
- **`plan`** — turn a new demand into sprints, stories and cards: clarify, optionally research, get the design approved, then write cards a zero-context agent can execute.

**The plugin does not dictate how you write code.** There is no implementation or review workflow here — use whatever skills, subagents or process you prefer. The only contract is the board one: move the card to `in_progress`, land it in `review` with a test-plan comment, and let the user approve before `done` (see the `agents-board` skill).

`scripts/` ships the three helpers that push data to the API outside the AI context: `attach-commit`, `attach-worktree-diff` and `attach-image` (each with a `.py` twin for hosts without Node).

## Installation

**Codex** — add this repository as a marketplace, then install:

```bash
codex plugin marketplace add fmilioni/agents-board
codex plugin add agents-board@agents-board
```

Start a new Codex task afterwards so the bundled skills and MCP tools load.

**Claude Code** — the same repository, through the plugin marketplace:

```
/plugin marketplace add fmilioni/agents-board
/plugin install agents-board@agents-board
```

For local development, `claude --plugin-dir plugins/agents-board` loads it directly (there is no `--plugin` flag). If you enable it mid-session, run `/reload-plugins`.

## The MCP server

Both manifests register an `agents-board` MCP client over Streamable HTTP; the **server** has to be running. Default `http://127.0.0.1:4402/mcp` — start the stack from this monorepo:

```bash
docker compose up -d --build
```

For a remote board, point Claude Code at it with `AB_MCP_URL` (the bundled `.mcp.json` reads it), and set `AB_API_URL` so the helper scripts hit the matching API host:

```bash
AB_MCP_URL=https://mcp.example.com/mcp AB_API_URL=https://api.example.com claude
```

Codex takes a second named server instead:

```bash
codex mcp add agents-board-remote --url https://mcp.example.com/mcp
```

Use a name other than `agents-board` — that one belongs to the bundled local connection. Each host keeps its own OAuth session and its own projects, and the skills never mix entities from two hosts.
