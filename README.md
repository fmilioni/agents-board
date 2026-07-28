<div align="center">

# Claude Organizer

### A "Jira" for Claude Code — your agent's project board, exposed over MCP.

Claude Organizer gives Claude Code a real project-management system — cards, sprints, comments and docs — as **queryable state over MCP**, instead of spec Markdown files that grow without bound and go stale. A clean Nuxt UI mirrors the same board for humans, in real time.

It ships as a **Claude Code plugin** (three skills + the MCP server), backed by a pnpm monorepo you run with Docker — one command delivers the skills *and* registers the MCP, no `claude mcp add`.

<br/>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Node](https://img.shields.io/badge/node-%E2%89%A524-43853d) ![pnpm](https://img.shields.io/badge/pnpm-9-f69220) ![Docker](https://img.shields.io/badge/Docker-compose-2496ed) ![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-8a63d2)

<br/>

<img src="docs/screenshots/board.png" alt="Claude Organizer board — a sprint with cards across To do / In progress / Review / Done" width="100%"/>

</div>

> [!WARNING]
> **Early stage — not yet stable.** Claude Organizer is under active development and not production-stable yet. Right now we're focused on **stabilizing the skills** (the `plan` / `implement` workflow the agent runs), so their behavior and the tool surface may still change between versions. Expect breaking changes — so keep the plugin's **auto-update off** (toggle it under `/plugin` → Marketplaces) and upgrade deliberately.

---

## Why

A long-running coding agent has no memory between sessions. The usual fix — piling plans and decisions into ever-growing `.md` files — rots fast: the files drift from reality, contradict each other, and bloat the context window.

Claude Organizer flips that. **What** to do (the active sprint, cards, backlog, comments, decisions, docs) lives in a database the AI queries on demand through MCP tools, and edits as work progresses. The agent orients itself at the start of every session by reading the board — not by re-reading stale prose. You watch the same board, drag cards, and leave comments the agent reads back.

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
git clone https://github.com/fmilioni/claude-organizer.git
cd claude-organizer
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
POSTGRES_DB=organizer
POSTGRES_PORT=5544                       # host port (in-container is 5432)
API_PORT=4400
NUXT_PUBLIC_API_URL=http://127.0.0.1:4400
# MCP_HTTP_PORT=4402                      # MCP port (Streamable HTTP at /mcp)
# MCP_PUBLIC_URL=http://127.0.0.1:4402    # public URL clients reach the MCP at
```

Migrations run automatically before the API and MCP start, and a one-shot `backfill` then (re)builds the semantic-search vectors for any content missing them — so upgrading is just `docker compose up -d --build`, no manual step. The embedding model loads in its own `embedding` service; the API and MCP call it over HTTP and fall back to lexical search if it's down. Postgres data persists under `./docker/data/postgres`. Out of the box the board is **open** (no login) — see [Authentication](#authentication) to turn sign-in on.

### 2. Install the plugin

The plugin delivers the **skills** *and* registers the **MCP** — no `claude mcp add` needed.

From a clone:

```bash
claude --plugin-dir plugins/claude-organizer
```

Or via the marketplace:

```text
/plugin marketplace add fmilioni/claude-organizer
/plugin install claude-organizer@claude-organizer
```

The `claude-organizer` tools appear automatically, pointing at local Docker (`http://127.0.0.1:4402/mcp`). Local Docker needs nothing more; to reach another host, see the next section.

### 3. Configure the MCP for a remote host

Local Docker is the default — nothing to do: the bundled plugin already registers a `claude-organizer` server at `http://127.0.0.1:4402/mcp`.

**Repoint the bundled entry with `CO_MCP_URL`.** To make the **primary** board live on another machine — sharing one board across several computers — just export `CO_MCP_URL` before starting Claude Code; the plugin's `claude-organizer` server uses it instead of `http://127.0.0.1:4402/mcp`, keeping the same tool prefix. Reach it over a stable hostname (a Tailscale MagicDNS name like `host.tailnet.ts.net`, a LAN host, or a remote domain). Pair it with **`CO_API_URL`** (default `http://127.0.0.1:4400`) pointed at the same host — the helper scripts (`attach-commit` / `attach-worktree-diff` / `attach-image`) post to the API directly, so without it they'd hit the client machine's own `localhost` and fail:

```bash
export CO_MCP_URL=http://host.tailnet.ts.net:4402/mcp
export CO_API_URL=http://host.tailnet.ts.net:4400
```

**Or register an additional named server.** To run another board *alongside* the bundled one, register it as an **additional** server with a name **other than `claude-organizer`** (that one is the plugin's — reusing it clashes):

```bash
claude mcp add --transport http -s user claude-organizer-remote https://mcp.<domain>/mcp
```

Each server gets its own tool prefix (the bundled plugin board is `mcp__plugin_claude-organizer_claude-organizer__*`; this added one is `mcp__claude-organizer-remote__*`), OAuth session and projects; the skills pick the one whose project matches the repo and never mix them. `-s user` makes it available across all repos — to bind **a single project** to a specific server instead, scope it to the repo with `-s project` (a shared `.mcp.json` committed in the repo) or `-s local` (only you, only this repo).

## Usage

**You drive everything through one entry point** — the main `claude-organizer` command — and it routes to plan / implement for you:

```text
/claude-organizer:claude-organizer plan github authentication
/claude-organizer:claude-organizer implement task CO-123
/claude-organizer:claude-organizer run story CO-127 all at once
```

Pass it your intent in plain language (any language) and it picks the right skill. The three skills behind it:

| Skill | What it does | Triggers when… |
| --- | --- | --- |
| **`claude-organizer`** | The entry point: what the board is, which skill to use, and binding the repo to its project (record `projectId` + auth flag in `CLAUDE.md`). | you reference the board — *"let's continue", "what's next?"* |
| **`plan`** | Turn a fuzzy new demand into structured work (sprint → stories → tasks), get the design approved, then create the cards. | you describe something new to build, before it's broken down. |
| **`implement`** | Execute existing cards through their lifecycle (`in_progress` → implement → review → commit), single-card or a multi-card run (story/sprint) in two modes — review each card, or run the whole batch autonomously. Fires a fresh-subagent review before each card closes. | you start/resume work on a specific card or ask to run a story/sprint — *"work CO-42", "run the sprint"*. |

For a multi-card run, `implement` asks how to drive it: **review each card** (stop for your validation between cards) or **run it all at once** (execute the batch autonomously). In both modes it commits one-per-card on the git flow you agree, runs the review gate (and a story-level review when a story's last child finishes), and leaves each card in `review` for your final validation — it never merges on its own (no PR unless you ask). The review itself runs in a read-only **`reviewer`** subagent dispatched by `implement`.

### Inbox

Got an idea mid-flight but don't want to plan it yet? Drop it in the **inbox** — a one-line demand captured without breaking it into cards. The agent reads pending inbox items when it orients and offers to plan them; the `plan` skill turns a demand into the right sprint/stories/tasks and marks it planned. It keeps raw intake out of the board until it's actually structured work.

## Authentication

Auth is built on [better-auth](https://better-auth.com) and is **off by default** — the open board above, no login, an open MCP the plugin connects to as-is. Turn it on from the **first-boot setup** on the login screen; the first account becomes the **admin**, and after that sign-in is required.

- **Methods** — email+password is the zero-config base; **GitHub OAuth** is optional and only appears when `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are set (callback `https://api.<domain>/api/auth/callback/github`). No host is forced to register an OAuth app.
- **Access** — users get **roles** and **per-project access**; admins manage who can see what.
- **MCP** — with auth on, `/mcp` is an OAuth 2.1 resource server and the plugin obtains a bearer automatically (so `CO_MCP_URL` is still all you set). With auth off, `/mcp` is open, mirroring the open board.

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

With auth on, Claude Code runs the OAuth flow by opening a browser and waiting on a **local loopback callback** (`http://localhost:<random-port>/…`). In a terminal-only environment that stalls — no browser opens (Claude Code prints the URL instead — open it yourself), and the loopback redirect must be able to reach back into the box (WSL2 forwards `localhost` by default; over SSH, forward the port with `ssh -L <port>:localhost:<port> …`). Keep one host throughout — don't mix `localhost` and `127.0.0.1`, or the login won't stick.

**The reliable escape hatch:** auth is **off by default** and an open board needs no login at all. For a local/WSL dev box, leave auth off and skip the loopback flow entirely; turn auth on where a browser-reachable login exists — e.g. a remote deployment behind the reverse proxy, reached over normal `https://`. The loopback dance is Claude Code's MCP client plus your box's networking; Claude Organizer is a standard OAuth 2.1 resource server and can't shortcut it server-side.

## Architecture

```text
Claude Code ──HTTP──▶ MCP (:4402/mcp) ─┐
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
