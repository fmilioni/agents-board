# Claude Organizer

"Jira for Claude Code": project management exposed over MCP. The AI uses the system to organize its own development (auto-inception). **International** product.

## Skills

Three skills drive the work (packaged in `plugins/claude-organizer`):

- **`claude-organizer`** — the entry point: what the board is, which skill to use, and how to bind the repo to its project (record `projectId` + the auth flag in `CLAUDE.md`).
- **`plan`** — turn a new demand into sprints/histories/tasks (auto-triggers when you describe something to build). All card creation goes through here.
- **`implement`** — execute existing cards through a mandatory per-card lifecycle (in_progress → implement → review → commit), single-card or as a multi-card run (story/sprint) in two modes — review each card, or run the whole batch autonomously. It fires a fresh-subagent review (the `reviewer` agent) before each card closes, and a story-level review when a story's last child finishes. Auto-triggers when you start building a specific card.

The review runs in a read-only **`reviewer`** subagent dispatched by `implement` (there is no separate review skill). The "never assume — resolve open decisions" doctrine is carried **inline** in `plan` and `implement`, so each skill is self-contained.

Let the skills drive. **What** to do (active sprint, cards, backlog, comments, docs) is the source of truth and lives **in the MCP**, not here — query it via `mcp__claude-organizer__*`. Don't duplicate state into this file.

### Bind this repo to your board (local, not committed)

This is an **open-source** repo — every clone tracks its own work on its **own** claude-organizer board, so the project↔MCP binding is deliberately **not** committed here. Put yours in a **non-committed** `CLAUDE.local.md` at the repo root (auto-loaded alongside this file, and gitignored), for example:

```
This project in the MCP:

- **slug**: `<your-slug>`
- **keyPrefix**: `<KEY>` (cards are `<KEY>-1`, `<KEY>-2`…)
- **projectId**: `<your-project-id>`

Auth (diff capture) is **ON / OFF** in this deployment.
```

Wherever the rules below show `CO-N` (or a `(CO-…)` suffix), substitute your own `keyPrefix`.

## Knowledge lives in the docs, not here

Architecture, data model, decisions (ADRs), code/UI patterns and per-module details live in the project's **docs** (`list_docs` / `read_doc`, grouped under Modules / Decisions / Guides / Notes). Read there before reinventing or re-deciding. Keep this file lean — it holds only the project-wide rules and overrides below, and points to the docs for the rest.

## Project rules (overrides)

- **Language**: write **skills and code in English** (the product is international). Content authored for the user — **tasks, comments and docs** — follows the user's language.
- **Commits**: one commit per card/task, **only after the user confirms** it works; the message is written **in English** and references the key (e.g. `feat(tags): … (<KEY>-4)`). After committing, attach its diff to the card with `pnpm attach-commit <sha>` (captured outside the AI context — never read or paste the diff).
- **PRs**: written **in English** (title *and* body, same as commits — only tasks/comments/docs follow the user's language). Write the **title as a conventional-commit** (`feat(scope): … (<KEY>-N)`); PRs are **squash-merged**, so the title becomes the commit message. The body summarizes the work — **no "Generated with Claude Code" footer**.
  - **Merging is the user's call.** By default the AI opens the PR and **stops**; the user merges. Any deployment-specific merge governance (branch protection, the exact merge command, who may override it) lives in your `CLAUDE.local.md`.
- **Auth (diff capture)**: whether auth is ON or OFF depends on your deployment — declare it in your `CLAUDE.local.md` (see above). When auth is **ON**, the `attach-commit` / `attach-worktree-diff` scripts need a card-scoped token: mint `issue_commit_token(<KEY-N>)` and pass it as `CO_COMMIT_TOKEN=<token> pnpm attach-… <arg>` (one token per attach). When **OFF**, run the `pnpm attach-…` scripts without a token.
  - **Run from the repo root.** `attach-commit` / `attach-worktree-diff` are **root** `package.json` scripts. If the shell's cwd drifted into a package (e.g. a prior `cd packages/core`), `pnpm attach-…` fails with *"Command not found"* (pnpm looks in that package) and the bundled `node …/scripts/*.mjs` path breaks too (it's relative to root). So `cd` back to the repo root first, or prefix the command with the absolute root path — then run `CO_COMMIT_TOKEN=<token> pnpm attach-commit <sha>` / `pnpm attach-worktree-diff <KEY-N>`.
- **Versioning**: every version (each `package.json`, the plugin manifests and the MCP server) stays in sync — to set it, run `pnpm bump <version>` (the unified bump script); never edit version fields by hand.
- **Nuxt / Nuxt UI work**: any time you touch a Nuxt UI item (a component, composable, icon, theming) or Nuxt itself, **invoke the `nuxt-ui` skill first** — it's the entry point for how we build UIs here. Back it with the MCPs: `nuxt-ui-remote` (Nuxt UI components/composables/icons/examples) and `nuxt-remote` (Nuxt framework docs/modules). Always confirm a component's props/slots via the MCP before using a new one.
- **Gotchas** (detailed in the docs): relative TS imports have **no `.js`** extension; markdown via `<AppMarkdown>` (never `@nuxtjs/mdc`).

## Day to day

To test a **new version of api / web / mcp / embedding**, rebuild and restart them in Docker — preferred, since it mirrors how they actually run (notably the MCP over HTTP, the same transport the plugin connects to):

```bash
docker compose up -d --build   # rebuild + restart api(4400) web(4401) mcp(4402) embedding(4403)
```

The embedding model runs in its own service (`embedding`, port 4403); api/mcp are thin HTTP clients via `EMBEDDING_SERVICE_URL`. With the service down or still warming, search degrades gracefully to lexical-only.

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

## After restarting Claude Code

The `claude-organizer` MCP loads automatically from the **bundled plugin** (its `.mcp.json`) — that's the primary board; point it at a remote host by exporting `CO_MCP_URL`. Postgres must be UP. If a new MCP tool doesn't show up, the process started with the old code — restart Claude Code again.
