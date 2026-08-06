---
name: agents-board
description: Entry point for a project tracked in agents-board (the `mcp__agents-board__*` tools). Explains what the board is, routes to the right phase skill, and records the project binding in CLAUDE.md so future sessions start without listing projects. Read this to know WHICH skill to use; the actual workflow lives in that skill.
---

# agents-board

agents-board is a "Jira for Claude Code" exposed over MCP: a project's **cards** (tasks), **sprints**, **backlog**, **comments** and **docs**. It is the source of truth for what to work on and why — not your memory. A fresh session starts blank; this is how continuity survives across sessions.

This skill only tells you **which skill to use** and **how to find the project**. The real workflow lives in the phase skills below — switch to one instead of working from memory.

**Task lists are interactive — reach for them on purpose, not for every list.** Card descriptions and doc bodies render GitHub-style task lists (`- [ ]` / `- [x]`) as **clickable** checkboxes whose state is saved. Use them only for concrete verification or runbook steps with a real completion state:

- **Test-plan / QA steps** — the steps to verify a card, marked as each one passes (the primary case).
- **Manual runbooks** — release/deploy/rollback, data migration, env setup, onboarding.

**The single test: does each item represent an action whose done/pending state matters?** If yes → task list. If it's anything else — prose, a non-actionable list, a spec the system or the AI satisfies — use **plain bullets** (`- `), never `- [ ]`. When unsure, it's a plain bullet.

**The marker must tell the truth at creation time.** Use `- [x]` for a check the agent already executed successfully and `- [ ]` only for a step that is still pending. Never present a completed automated check as unchecked for the user to repeat. If one line mixes completed and pending work, split it into separate items so each checkbox has one truthful state.

Don't use them for prose or non-actionable lists, or to track real units of work — that's what cards and sub-tasks are for. In particular, **acceptance criteria and definition-of-done are NEVER task lists**: they are specs/conditions (descriptions of *what must be true*), not steps someone carries out — a clickable checkbox there is wrong, since it invites the user to "complete" a spec by ticking it. Reserve task-list markers for concrete runbook and QA test-plan actions.

## The inbox holds demands — not the debt you just created

The inbox is for **demands not yet planned**: a passing idea, something to revisit, a finding that genuinely belongs to other work. It is **not** a queue for what the current change left half-done. A gap your own change opened — a state nothing renders, a caller you didn't update, a rule only half-applied — is **finished in that change**, not parked here, even when it falls outside the card's stated scope. `implement` carries the three tests that decide this at the review gate; when none of them says defer, you fix it and move on.

## Before adding to the inbox — check it isn't already tracked

Before you create an inbox item — whether **you** decided to on your own (`create_inbox`) or you're about to **suggest** one to the user — first confirm the same thing isn't **already on the board or already queued**:

- **Search the board** — `search_cards`, and scan the open `backlog` / `todo` / `review` cards. If a card already covers it, it's planned — don't re-add it as a "new" demand; point the user at the existing card.
- **Scan the pending inbox** — `list_inbox`. If the demand is already sitting there, don't drop a second copy.

Only create the inbox item when nothing already covers it. When the check matches an existing card or inbox item, say which one — instead of silently creating a duplicate. This guards both phase skills: `plan` (don't park what's already planned) and `implement` (don't inbox a deferred finding that's already a card).

## The skills — pick by what the user asks

- **`plan`** — a **new demand** (feature, change, fix) to break into work. Turns it into sprints/stories/tasks. **All card creation goes through here** — never `create_card` ad-hoc.
- **`implement`** — **execute a card that already exists** (a task, a story, or a sprint's cards). Runs guided or autopilot execution: standalone cards get a fresh-agent review, story children normally share a story-level review, and isolated units may run concurrently in worktrees.

## Find the project — binding first, `list_projects` only if missing

Every tool takes an explicit `projectId`. Get it without scanning:

1. **Check `CLAUDE.md` / `CLAUDE.local.md`** for the board binding (`projectId`, `keyPrefix`, `slug`, auth flag). If it's there, use the `projectId` directly — **don't call `list_projects`**.
2. **Only if no binding exists**, call `list_projects`, match the project whose `slug` fits this repo, then **write the binding** (next section). If none matches, ask the user before creating one.

**Multiple hosts:** you may have more than one organizer host connected at once — each is a **separate MCP server** with its own tool prefix and its own projects. Run the lookup on the **right server** (the one whose project `slug` matches this repo) and never mix hosts in a single operation; if unsure which host a repo belongs to, ask.

## Record the binding so the next session starts direct

When you had to discover the project (no binding found), persist it so it never needs discovery again. Write a stanza with: **`slug`**, **`keyPrefix`** (cards are `<KEY>-N`), **`projectId`**, and the **auth (diff-capture) flag**.

- **Which file:** solo/private repo → `CLAUDE.md` (committed). Open-source or multi-board repo (committing *your* board id is wrong) → `CLAUDE.local.md` (gitignored). When ambiguous, ask.

## Auth flag — record ON the first time an attach fails

The diff-capture scripts (run by `implement` — `attach-commit` / `attach-worktree-diff`) post a card's diff to the API. If one fails with a **401 (authorization)**, this deployment has auth **ON**: the scripts need a card-scoped token (`issue_commit_token(<KEY-N>)` minted and passed as `AB_COMMIT_TOKEN`; mechanics live in `implement`). **Set `auth: ON` in the binding** the first time you hit this, so future sessions pass the token up front instead of failing.
