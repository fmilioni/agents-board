<div align="center">

# Agents Board

### A "Jira" for Codex — your agent's project board, exposed over MCP.

Agents Board gives Codex a real project-management system — cards, sprints, comments and docs — as **queryable state over MCP**, instead of spec Markdown files that grow without bound and go stale. A clean Nuxt UI mirrors the same board for humans, in real time.

It ships as a **Codex plugin** (three user-facing skills, an internal reviewer skill, and the MCP server), backed by a pnpm monorepo you run with Docker. Install it once from the repository marketplace and the skills and local MCP connection become available together.

<br/>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Node](https://img.shields.io/badge/node-%E2%89%A524-43853d) ![pnpm](https://img.shields.io/badge/pnpm-9-f69220) ![Docker](https://img.shields.io/badge/Docker-compose-2496ed) ![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-8a63d2)

<br/>

<img src="docs/screenshots/board.png" alt="Agents Board — a sprint with cards across To do / In progress / Review / Done" width="100%"/>

</div>

> [!WARNING]
> **Early stage — not yet stable.** Agents Board is under active development and not production-stable yet. Right now we're focused on **stabilizing the skills** (the `plan` / `implement` workflow the agent runs), so their behavior and the tool surface may still change between versions. Expect breaking changes and upgrade the plugin deliberately through Codex's `/plugins` browser or CLI.

---

## Why

A long-running coding agent has no memory between sessions. The usual fix — piling plans and decisions into ever-growing `.md` files — rots fast: the files drift from reality, contradict each other, and bloat the context window.

Agents Board flips that. **What** to do (the active sprint, cards, backlog, comments, decisions, docs) lives in a database the AI queries on demand through MCP tools, and edits as work progresses. The agent orients itself at the start of every session by reading the board — not by re-reading stale prose. You watch the same board, drag cards, and leave comments the agent reads back.

## Highlights

- 🗂️ **A real board** — projects, sprints, stories and sub-tasks, blockers, tags, priorities. Drag-and-drop UI with live WebSocket updates.
- 🤖 **Built for the agent** — every entity is a typed MCP tool; prefixed IDs (`prj_`, `crd_`, `spr_`…) tell the AI what it's holding at a glance.
- 💬 **Comments as the decision log** — the agent records *why* on the card; you reply, it reads your unread comments back next session.
- 🔗 **Commits attached to cards** — each card keeps the diff that delivered it, captured outside the AI's context (no tokens spent reading patches).
- 📚 **Docs that don't rot** — architecture, ADRs and patterns live as project docs the agent reads before reinventing.
- 🔎 **Search by meaning** — cards, comments and docs are searchable with a hybrid of Postgres full-text and in-process embeddings (a multilingual model in-container, no external API), fused by rank (RRF).

<div align="center">
<table>
<tr>
<td width="50%"><img src="docs/screenshots/card-detail.png" alt="Card detail — description, acceptance criteria, status, sprint, tags and attached commit"/></td>
<td width="50%"><img src="docs/screenshots/card-comments.png" alt="Card comments and attached commit diff, with an unread-by-AI comment from the human"/></td>
</tr>
<tr>
<td align="center"><sub>Card detail — description, acceptance criteria, status & the attached commit.</sub></td>
<td align="center"><sub>The commit diff plus the comment thread — the agent's decision log.</sub></td>
</tr>
</table>
</div>

## Setup

> **Requires** Node 24+, pnpm 9+, and Docker.

### 1. Bring up the stack

Postgres + migrations + API + UI + MCP, in one shot:

```bash
git clone https://github.com/fmilioni/agents-board.git
cd agents-board
cp .env.example .env
docker compose up -d --build
```

| Service | URL |
| --- | --- |
| **Web UI** | http://127.0.0.1:4401 |
| **API** | http://127.0.0.1:4400 |
| **MCP** (Streamable HTTP) | http://127.0.0.1:4402/mcp |
| **Embedding service** | http://127.0.0.1:4403 |

`cp .env.example .env` already ships working defaults for local Docker; the values worth knowing:

```bash
POSTGRES_USER=organizer
POSTGRES_PASSWORD=organizer
AB_POSTGRES_DB=agents_board
POSTGRES_PORT=5544                       # host port (in-container is 5432)
API_PORT=4400
NUXT_PUBLIC_API_URL=http://127.0.0.1:4400
# MCP_HTTP_PORT=4402                      # MCP port (Streamable HTTP at /mcp)
# MCP_PUBLIC_URL=http://127.0.0.1:4402    # public URL clients reach the MCP at
```

Migrations run automatically before the API and MCP start, and a one-shot `backfill` then (re)builds the semantic-search vectors for any content missing them. The embedding model loads in its own `embedding` service; the API and MCP call it over HTTP and fall back to lexical search if it's down. Postgres data persists under `./docker/data/postgres`. Out of the box the board is **open** (no login) — see [Authentication](#authentication) to turn sign-in on.

#### Upgrade from Claude Organizer

The Compose project, images, containers, and default database now use the Agents Board identity. Stop the old Compose project before the first upgrade so its containers release the local ports, then start the new stack:

```bash
docker compose -p claude-organizer down
docker compose up -d --build
```

The `database-rename` one-shot service detects the former default `organizer` database and renames it to `agents_board` before application migrations run. The operation is idempotent and preserves the existing Postgres data directory. Existing local-development environments should also replace `POSTGRES_DB=organizer` with `AB_POSTGRES_DB=agents_board` and update `DATABASE_URL` to end in `/agents_board`. Custom database names are never renamed automatically; set `AB_POSTGRES_DB` and `DATABASE_URL` explicitly for those deployments.

Take a database backup before upgrading. To roll this identity-only release back, stop the new stack, start only its Postgres service, rename the database back, and then start the previous release with its former environment values:

```bash
docker compose down
docker compose up -d postgres
docker compose exec -T postgres psql -U organizer -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'agents_board' AND pid <> pg_backend_pid()"
docker compose exec -T postgres psql -U organizer -d postgres -c "ALTER DATABASE agents_board RENAME TO organizer"
docker compose down
git checkout <previous-release>
docker compose -p claude-organizer up -d --build
```

Restore the backup instead when rolling back across any release that also contains incompatible schema migrations.

Production deployments must keep the production overlay in every lifecycle command. Upgrade with:

```bash
docker compose -p claude-organizer -f docker-compose.yml -f docker-compose.prod.yml down
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

For a production rollback, use the same overlay while renaming the database and when starting the previous release:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres psql -U organizer -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'agents_board' AND pid <> pg_backend_pid()"
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres psql -U organizer -d postgres -c "ALTER DATABASE agents_board RENAME TO organizer"
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
git checkout <previous-release>
docker compose -p claude-organizer -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

### 2. Install the plugin

The plugin delivers the **skills** *and* registers the **MCP**. Add this repository as a Codex marketplace, then install its plugin:

```bash
codex plugin marketplace add fmilioni/agents-board
codex plugin add agents-board@agents-board
```

You can inspect or manage it interactively with `/plugins` in Codex CLI. Start a new Codex task after installation so its bundled skills and tools are loaded. The `agents-board` tools point at local Docker (`http://127.0.0.1:4402/mcp`) by default.

### 3. Configure the MCP for a remote host

Local Docker is the default — nothing to do: the bundled plugin already registers an `agents-board` server at `http://127.0.0.1:4402/mcp`.

To use a board on another machine, register it as an additional named MCP server. Reach it over a stable hostname (a Tailscale MagicDNS name like `host.tailnet.ts.net`, a LAN host, or a remote domain). Pair it with **`AB_API_URL`** (default `http://127.0.0.1:4400`) pointed at the same host — the helper scripts (`attach-commit` / `attach-worktree-diff` / `attach-image`) post to the API directly, so without it they'd hit the client machine's own `localhost` and fail:

```bash
export AB_API_URL=http://host.tailnet.ts.net:4400
codex mcp add agents-board-remote --url http://host.tailnet.ts.net:4402/mcp
```

Use a name **other than `agents-board`** because that name belongs to the bundled plugin. For a repository-scoped connection instead of a user-level one, add it to the trusted project's `.codex/config.toml`:

```toml
[mcp_servers.agents-board-remote]
url = "https://mcp.<domain>/mcp"
```

Each server gets its own tool namespace, OAuth session and projects; the skills pick the one whose project matches the repo and never mix them.

## Usage

**You can drive everything through one entry point** — `$agents-board` — or invoke `$plan` and `$implement` directly:

```text
$agents-board plan GitHub authentication
$plan break GitHub authentication into cards
$implement task AB-123
$implement run story AB-127 all at once
```

Pass it your intent in plain language (any language) and it picks the right workflow. The three user-facing skills are:

| Skill | What it does | Triggers when… |
| --- | --- | --- |
| **`agents-board`** | The entry point: what the board is, which skill to use, and binding the repo to its project (record `projectId` + auth flag in `.agents-board.local.md`). | you reference the board — *"let's continue", "what's next?"* |
| **`plan`** | Turn a fuzzy new demand into structured work (sprint → stories → tasks), get the design approved, then create the cards. | you describe something new to build, before it's broken down. |
| **`implement`** | Execute existing cards through their lifecycle (`in_progress` → implement → review → commit), single-card or a multi-card run (story/sprint) in two modes — review each card, or run the whole batch autonomously. Fires a fresh-subagent review before each card closes. | you start/resume work on a specific card or ask to run a story/sprint — *"work AB-42", "run the sprint"*. |

For a multi-card run, `implement` asks how to drive it: **review each card** (stop for your validation between cards) or **run it all at once** (execute the batch autonomously). In both modes it commits one-per-card on the git flow you agree, runs the review gate (and a story-level review when a story's last child finishes), and leaves each card in `review` for your final validation — it never merges on its own (no PR unless you ask). The review itself runs in a read-only **`reviewer`** subagent dispatched by `implement`.

### Claude Code compatibility

Claude Code remains supported as a legacy client through the same repository: add it with `/plugin marketplace add fmilioni/agents-board`, then `/plugin install agents-board@agents-board`. The tracked `CLAUDE.md` forwards to the shared `AGENTS.md`, so both hosts follow the same repository rules.

### Inbox

Got an idea mid-flight but don't want to plan it yet? Drop it in the **inbox** — a one-line demand captured without breaking it into cards. The agent reads pending inbox items when it orients and offers to plan them; the `plan` skill turns a demand into the right sprint/stories/tasks and marks it planned. It keeps raw intake out of the board until it's actually structured work.

## Authentication

Auth is built on [better-auth](https://better-auth.com) and is **off by default** — the open board above, no login, an open MCP the plugin connects to as-is. Turn it on from the **first-boot setup** on the login screen; the first account becomes the **admin**, and after that sign-in is required.

- **Methods** — email+password is the zero-config base; **GitHub OAuth** is optional and only appears when `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are set (callback `https://api.<domain>/api/auth/callback/github`). No host is forced to register an OAuth app.
- **Access** — users get **roles** and **per-project access**; admins manage who can see what.
- **MCP** — with auth on, `/mcp` is an OAuth 2.1 resource server and the Codex MCP client obtains a bearer automatically. With auth off, `/mcp` is open, mirroring the open board.

Relevant env (see `.env.example`):

| Var | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | Signs sessions/tokens — **required in production**. |
| `BETTER_AUTH_URL` | Public URL of the API (where better-auth is mounted). |
| `AUTH_TRUSTED_ORIGINS` | Origins allowed to call auth (CSRF) — also the API's CORS allow-list. |
| `AUTH_COOKIE_DOMAIN` | Parent domain to share the session cookie across subdomains (remote only). |
| `MCP_ACCESS_TOKEN_TTL` / `MCP_REFRESH_TOKEN_TTL` | Lifetime in seconds of the OAuth tokens the MCP login issues (default 7 days / 30 days). Shorten both when the board is exposed to the internet. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Enable GitHub sign-in. |

> **Local gotcha:** the web (`:4401`) and API (`:4400`) are different origins, and the session cookie is `SameSite=Lax` + host-bound. Locally, reach **both on the same host** — use `127.0.0.1`, not `localhost` — or the cookie won't be sent. Behind the reverse proxy, `AUTH_COOKIE_DOMAIN` removes this constraint across the subdomains.

### Remote deployment (reverse proxy)

A versioned overlay puts the three services behind one TLS edge (**Caddy**, ports 80/443), a subdomain each (`app.`/`api.`/`mcp.<domain>`):

```bash
cp .env.prod.example .env   # set *_DOMAIN, ACME_EMAIL, BETTER_AUTH_SECRET, public URLs
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Point DNS for the three subdomains at the host; Caddy issues/renews TLS (ACME). Set `NUXT_PUBLIC_API_URL=https://api.<domain>` **before** building (it's baked into the SPA) and `AUTH_COOKIE_DOMAIN=<domain>` to share the session cookie. Details: [`deploy/Caddyfile`](deploy/Caddyfile), [`.env.prod.example`](.env.prod.example).

### Signing in from a terminal-only box (WSL, SSH, headless)

With auth on, Codex runs the OAuth flow by opening a browser and waiting on a **local loopback callback** (`http://localhost:<random-port>/…`). In a terminal-only environment that stalls — no browser opens (Codex prints the URL instead — open it yourself), and the loopback redirect must be able to reach back into the box (WSL2 forwards `localhost` by default; over SSH, forward the port with `ssh -L <port>:localhost:<port> …`). Keep one host throughout — don't mix `localhost` and `127.0.0.1`, or the login won't stick.

**The reliable escape hatch:** auth is **off by default** and an open board needs no login at all. For a local/WSL dev box, leave auth off and skip the loopback flow entirely; turn auth on where a browser-reachable login exists — e.g. a remote deployment behind the reverse proxy, reached over normal `https://`. The loopback dance depends on the MCP client and your box's networking; Agents Board is a standard OAuth 2.1 resource server and can't shortcut it server-side.

## Architecture

```text
Codex ───────HTTP──▶ MCP (:4402/mcp) ──┐
                                       ├─▶ core ──▶ Postgres 16
Browser (SPA) ──HTTP──▶ API (:4400) ───┘   (+ WebSocket /ws for real-time)
                            └─ core ──HTTP──▶ Embedding service (:4403) ──▶ model
```

A pnpm monorepo under `packages/`:

| Package | Role |
| --- | --- |
| `shared` | Shared TypeScript types. |
| `db` | Drizzle schema + migrations. |
| `core` | Zod-validated use-cases — the single source of truth. |
| `auth` | better-auth setup (email+password, GitHub, OAuth for the MCP). |
| `mcp` | The MCP server (Streamable HTTP). |
| `api` | Fastify REST + WebSocket. |
| `embedding-service` | Loads the embedding model once and serves it over HTTP (api/mcp are thin clients). |
| `web` | Nuxt 4 SPA (the UI talks only to the API, never the MCP). |

Prefixed nanoid IDs (`prj_`, `crd_`, `spr_`…) let the agent recognize an entity's type from the ID alone.

## Development (without Docker)

```bash
pnpm install
pnpm db:up                       # Postgres on :5544
pnpm db:migrate
pnpm dev:api                     # :4400
pnpm dev:web                     # :4401
pnpm dev:mcp                     # :4402/mcp
pnpm dev:embedding               # :4403 (semantic search; omit for lexical-only)
```

Also handy: `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm db:generate` after schema changes.

## License

[MIT](LICENSE) © Felipe Milioni
