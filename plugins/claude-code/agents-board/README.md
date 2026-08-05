# agents-board (Claude Code plugin)

Three skills and one reviewer agent:

- **`agents-board`** — how to **operate** the board: orient at the start of a session, keep statuses honest, comment with signal (not noise), docs.
- **`plan`** — turn a **new demand** into sprints/histories/tasks. Triggers automatically when you describe something to build.
- **`implement`** — **execute** existing cards through a guided or autopilot lifecycle. Standalone cards get a fresh-agent review; story children normally share one story-level review, with discretionary earlier passes for risky work. Autopilot delegates isolated units through worktrees and integrates them centrally. Triggers when you start building a specific card.
- **`agents-board:reviewer`** — the Claude Code **agent** used for required standalone, discretionary per-card, and complete story reviews. It may be dispatched by an autopilot executor or by the orchestrator fallback, never as a user-facing skill.

The "never assume — resolve open decisions" doctrine is carried inline in each skill that uses it (`plan` and `implement`).

## Installation

Development (current session):

```bash
claude --plugin-dir plugins/claude-code/agents-board
```

Distribution (marketplace, from this repo):

```
/plugin marketplace add <owner>/<repo>
/plugin install agents-board@agents-board
```

> **There is no `--plugin` flag.** Use `--plugin-dir` (dev) or the marketplace (distribution).

Installing the plugin registers the `agents-board` MCP automatically (bundled `.mcp.json`, HTTP transport) — its tools appear with no `claude mcp add`, named `mcp__plugin_agents-board_agents-board__*` (a plugin-bundled server is `mcp__plugin_<pluginName>_<serverName>__<tool>`). If you enable it mid-session, run `/reload-plugins`.

## The MCP server

The plugin ships the skills **and** registers an MCP client pointing at an HTTP URL — but the MCP **server** must be running somewhere:

- **Local**: run the stack (Postgres + the MCP over Streamable HTTP) from this monorepo via Docker. Default URL `http://127.0.0.1:4402/mcp`; open when auth is off.
- **Remote / VPS**: point the plugin at your host by exporting `AB_MCP_URL` (e.g. `https://mcp.example.com/mcp`). When auth is on, `/mcp` is an OAuth 2.1 resource server and the plugin runs the OAuth flow itself — no token to paste.

```bash
AB_MCP_URL=https://mcp.example.com/mcp claude
```

`AB_MCP_URL` defaults safely: unset, the plugin talks to `http://127.0.0.1:4402/mcp`. See the root `README.md` for the full local/remote setup.

## Two hosts at once (local + company)

`AB_MCP_URL` points the bundled entry at **one** host per session. To use **two simultaneously** — e.g. your local board and a company one — add the second host as its **own** MCP server with a distinct name:

```bash
claude mcp add --transport http -s user agents-board-second https://mcp.company.com/mcp
```

(`-s user` makes it available in every repo, like the bundled entry; omit it to scope it to the current directory — `local`.) Both run side by side: each gets its own tool prefix (the bundled plugin board is `mcp__plugin_agents-board_agents-board__*`; the added one is `mcp__agents-board-second__*`), its own OAuth session (when auth is on, the flow runs per host — no token to paste), and its own set of projects. The skills treat each server as one host and never mix their projects — pick the server whose project matches the repo you're in.
