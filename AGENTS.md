# Agents Board

Project management for coding agents, exposed over MCP. Codex and Claude Code can use the system to organize their own development (auto-inception). **International** product.

## Skills

Two skills ship from a **single** host-neutral package, `plugins/agents-board` — Codex reads `.codex-plugin/plugin.json`, Claude Code reads `.claude-plugin/plugin.json` + `.mcp.json`, both load the same `skills/`:

- **`agents-board`** — how to use the board: bind the repo to its project (record `projectId` + the auth flag in `.agents-board.local.md`), read and search it, keep a card's status honest, comment, write docs, work the inbox, attach diffs and images.
- **`plan`** — turn a new demand into sprints/stories/cards: clarify, offer research, clarify again, get approval, then write cards a zero-context agent can execute. All card creation goes through here.

**The plugin deliberately stops at the board's edge.** It ships no implementation, review, worktree or orchestration workflow — how code gets written is the user's process, with whatever skills they prefer. A change to a skill must not smuggle one back in.

Let the skills drive. **What** to do (active sprint, cards, backlog, comments, docs) is the source of truth and lives **in the MCP**, not here — query it through the Agents Board MCP tools. Don't duplicate state into this file.

### Bind this repo to your board (local, not committed)

This is an **open-source** repo — every clone tracks its own work on its **own Agents Board instance**, so the project↔MCP binding is deliberately **not** committed here. Put yours in a gitignored `.agents-board.local.md` at the repo root. The coding agent must read it when it exists. For example:

```md
This project in the MCP:

- **slug**: `<your-slug>`
- **keyPrefix**: `<KEY>` (cards are `<KEY>-1`, `<KEY>-2`…)
- **projectId**: `<your-project-id>`

Auth (diff capture) is **ON / OFF** in this deployment.
```

Wherever the rules below show `<KEY>-N` (or a `(<KEY>-…)` suffix), substitute your own `keyPrefix`.

## Knowledge lives in the docs, not here

Architecture, data model, decisions (ADRs), code/UI patterns and per-module details live in the project's **docs** (`list_docs` / `read_doc`, grouped under Modules / Decisions / Guides / Notes). Read there before reinventing or re-deciding. Keep this file lean — it holds only the project-wide rules and overrides below, and points to the docs for the rest.

## Project rules (overrides)

- **Language**: write **skills and code in English** (the product is international). Content authored for the user — **tasks, comments and docs** — follows the user's language.
- **Code comments**: the default is **none** — the code, the types, the names and the test names carry the intent. A comment is justified only when it points at something **outside the diff** that a reader cannot recover from them, and only these five: an external bug/quirk being worked around, a spec/protocol/API requirement, a measured constraint, an ordering that looks removable and isn't, or a public-API doc. **The list is closed.** Never restate what the code says, banner a section (`// state`, `// helpers`), note a ticket ref, or write relative to the change (`// now it's blue`) — code only knows its current state. **No comments inside a test body**: the `it(...)` title *is* the explanation; if the intent needs explaining, rename the test. One rationale, one place. Touching existing code, delete the comments that fail this bar.
- **Commits**: one commit per card/task, **only after the user confirms** it works; the message is written **in English** and references the key (e.g. `feat(tags): … (<KEY>-4)`). After committing, attach its diff to the card with `pnpm attach-commit <sha>` (captured outside the AI context — never read or paste the diff).
- **PRs**: written **in English** (title *and* body, same as commits — only tasks/comments/docs follow the user's language). Write the **title as a conventional commit** (`feat(scope): … (<KEY>-N)`); PRs are **squash-merged**, so the title becomes the commit message. The body summarizes the work — **no "Generated with Codex" footer**.
  - **Merging is the user's call.** By default Codex opens the PR and **stops**; the user merges. Any deployment-specific merge governance (branch protection, the exact merge command, who may override it) lives in `.agents-board.local.md`.
- **Auth (diff capture)**: whether auth is ON or OFF depends on your deployment — declare it in `.agents-board.local.md` (see above). When auth is **ON**, the `attach-commit` / `attach-worktree-diff` scripts need a card-scoped token: mint `issue_commit_token(<KEY-N>)` and pass it as `AB_COMMIT_TOKEN=<token> pnpm attach-… <arg>` (one token per attach). When **OFF**, run the `pnpm attach-…` scripts without a token.
  - **Run from the repo root.** `attach-commit` / `attach-worktree-diff` are **root** `package.json` scripts. If the shell's cwd drifted into a package (e.g. a prior `cd packages/core`), `pnpm attach-…` fails with *"Command not found"* (pnpm looks in that package) and the bundled `node …/scripts/*.mjs` path breaks too (it's relative to root). Return to the repo root first, or prefix the command with the absolute root path — then run `AB_COMMIT_TOKEN=<token> pnpm attach-commit <sha>` / `pnpm attach-worktree-diff <KEY-N>`.
- **Versioning**: every version (each `package.json`, the plugin manifests and the MCP server) stays in sync — to set it, run `pnpm bump <version>` (the unified bump script); never edit version fields by hand.
- **Nuxt / Nuxt UI work**: any time you touch a Nuxt UI item (a component, composable, icon, theming) or Nuxt itself, **invoke the `nuxt-ui` skill first** — it's the entry point for how we build UIs here. Back it with the MCPs: `nuxt-ui-remote` (Nuxt UI components/composables/icons/examples) and `nuxt-remote` (Nuxt framework docs/modules). Always confirm a component's props/slots through the MCP before using a new one.
- **Gotchas** (detailed in the docs): relative TypeScript imports have **no `.js`** extension; render Markdown through `<AppMarkdown>` (never `@nuxtjs/mdc`).

## Day to day

To test a **new version of api / web / mcp / embedding**, rebuild and restart them in Docker — preferred, since it mirrors how they actually run (notably the MCP over HTTP, the same transport the plugin connects to):

```bash
docker compose up -d --build   # rebuild + restart api(4400) web(4401) mcp(4402) embedding(4403)
```

The embedding model runs in its own service (`embedding`, port 4403); api/mcp are thin HTTP clients through `EMBEDDING_SERVICE_URL`. With the service down or still warming, search degrades gracefully to lexical-only.

`pnpm dev:*` still works for fast local iteration:

```bash
pnpm db:up         # Postgres (after reboot)
pnpm dev:api       # http://127.0.0.1:4400
pnpm dev:web       # http://127.0.0.1:4401
pnpm dev:mcp       # http://127.0.0.1:4402/mcp
pnpm dev:embedding # http://127.0.0.1:4403 (semantic search; without it, search is lexical-only)
pnpm typecheck     # all packages (root -r)
pnpm lint          # all packages (root -r)
pnpm db:generate   # after schema changes
pnpm db:migrate    # apply
```

Always run `pnpm typecheck` **and** `pnpm lint` from the **repo root** (the `-r` scripts hit every package) before closing a card — never scope them to a single package. A story routinely edits more than one package, and a per-package check silently goes stale the moment another package is touched.

## After restarting Codex

The `agents-board` MCP loads automatically from the **bundled plugin** and points at local Docker (`http://127.0.0.1:4402/mcp`) — that's the primary board. For a remote host, register an additional named server with `codex mcp add <name> --url <url>` and set `AB_API_URL` for the diff/image helper scripts. Postgres must be UP. If a new MCP tool doesn't show up, start a new Codex task after rebuilding/restarting the relevant process.
