---
name: claude-organizer
description: Entry point for a project tracked in claude-organizer. Explains the board, routes work to the planning or implementation skill, and records a project binding so future sessions start without listing projects. Use before $plan or $implement when working with a claude-organizer board.
---

# claude-organizer

claude-organizer is a Jira-style board exposed through the connected organizer tools: a project's **cards** (tasks), **sprints**, **backlog**, **comments** and **docs**. It is the source of truth for what to work on and why — not your memory. A fresh session starts blank; this is how continuity survives across sessions.

This skill only tells you **which skill to use** and **how to find the project**. The real workflow lives in the phase skills below — switch to one instead of working from memory.

**Task lists are interactive — reach for them on purpose, not for every list.** Card descriptions and doc bodies render GitHub-style task lists (`- [ ]` / `- [x]`) as **clickable** checkboxes: the user ticks them off directly and it's saved. Use them only for **manual steps the user actually has to carry out and tick off** as they go:

- **Test-plan / QA steps** — the steps to verify a card, ticked as each one passes (the primary case).
- **Manual runbooks** — release/deploy/rollback, data migration, env setup, onboarding.

**The single test: would the user physically click this checkbox to mark it done?** If yes → task list. If it's anything else — prose, a non-actionable list, a spec the system or the AI satisfies — use **plain bullets** (`- `), never `- [ ]`. When unsure, it's a plain bullet.

Don't use them for prose or non-actionable lists, or to track real units of work — that's what cards and sub-tasks are for. In particular, **acceptance criteria and definition-of-done are NEVER task lists**: they are specs/conditions (descriptions of *what must be true*), not steps the user carries out — a clickable checkbox there is wrong, since it invites the user to "complete" a spec by ticking it. Reserve `- [ ]` for runbooks and QA test-plans the user actually walks through.

## The inbox holds demands — not the debt you just created

The inbox is for **demands not yet planned**: a passing idea, something to revisit, a finding that genuinely belongs to other work. It is **not** a queue for what the current change left half-done. A gap your own change opened — a state nothing renders, a caller you didn't update, a rule only half-applied — is **finished in that change**, not parked here, even when it falls outside the card's stated scope. `$implement` carries the three tests that decide this at the review gate; when none of them says defer, you fix it and move on.

## Before adding to the inbox — check it isn't already tracked

Before you create an inbox item — whether **you** decided to on your own (`create_inbox`) or you're about to **suggest** one to the user — first confirm the same thing isn't **already on the board or already queued**:

- **Search the board** — `search_cards`, and scan the open `backlog` / `todo` / `review` cards. If a card already covers it, it's planned — don't re-add it as a "new" demand; point the user at the existing card.
- **Scan the pending inbox** — `list_inbox`. If the demand is already sitting there, don't drop a second copy.

Only create the inbox item when nothing already covers it. When the check matches an existing card or inbox item, say which one — instead of silently creating a duplicate. This guards both phase skills: `$plan` (don't park what's already planned) and `$implement` (don't inbox a deferred finding that's already a card).

## The skills — pick by what the user asks

- **`$plan`** — a **new demand** (feature, change, fix) to break into work. Turns it into sprints/stories/tasks. **All card creation goes through here** — never `create_card` ad-hoc.
- **`$implement`** — **execute a card that already exists** (a task, a story, or a sprint's cards). Owns the per-card lifecycle and fires a fresh-subagent review before each card is committed.

## Find the project — binding first, `list_projects` only if missing

Every tool takes an explicit `projectId`. Get it without scanning:

1. **Check `.claude-organizer.local.md` first, then `AGENTS.md`** for the board binding (`projectId`, `keyPrefix`, `slug`, auth flag). For compatibility, also accept an existing `CLAUDE.local.md` or `CLAUDE.md` binding as legacy input. If a binding exists, use the `projectId` directly — **don't call `list_projects`**.
2. **Only if no binding exists**, call `list_projects`, match the project whose `slug` fits this repo, then **write the binding in the neutral/Codex-first location** (next section). If none matches, ask the user before creating one.

**Multiple hosts:** you may have more than one organizer host connected at once — each has its own tools and projects. Run the lookup on the **right host** (the one whose project `slug` matches this repo) and never mix hosts in a single operation; do not depend on a fixed tool prefix. If unsure which host a repo belongs to, ask.

## Record the binding so the next session starts direct

When you had to discover the project (no binding found), persist it so it never needs discovery again. Write a stanza with: **`slug`**, **`keyPrefix`** (cards are `<KEY>-N`), **`projectId`**, and the **auth (diff-capture) flag**.

- **Which file:** a binding safe to share with the repository → `AGENTS.md` (committed). A personal, open-source, or multi-board binding that must stay local → `.claude-organizer.local.md` (gitignored). Treat `CLAUDE.md` and `CLAUDE.local.md` as read-only legacy binding locations; write new bindings to the neutral/Codex-first files. When ambiguous, ask.

## Auth flag — record ON the first time an attach fails

The diff-capture scripts (run by `$implement` — `attach-commit` / `attach-worktree-diff`) post a card's diff to the API. If one fails with a **401 (authorization)**, this deployment has auth **ON**: the scripts need a card-scoped token (`issue_commit_token(<KEY-N>)` minted and passed as `AB_COMMIT_TOKEN`; mechanics live in `$implement`). **Set `auth: ON` in the binding** the first time you hit this, so future sessions pass the token up front instead of failing.
