---
name: agents-board
description: "How to use Agents Board — the project board (cards, sprints, backlog, comments, docs, inbox) exposed through the connected board tools. Use whenever you read or write anything on the board: finding the project, looking up what to work on, searching cards/docs semantically, moving a card through its statuses, commenting, capturing an inbox demand, or writing project docs. To break a NEW demand into cards, use the `plan` skill."
---

# Agents Board

Agents Board is a Jira-style board exposed through the connected board tools: a project's **cards**, **sprints**, **backlog**, **comments**, **docs** and **inbox**. It is the source of truth for what to work on and why — a fresh session starts blank, and the board is how continuity survives.

**This skill covers the board, not how you write code.** It tells you how to read the board, keep it honest, and hand work back to the user for approval. *How* you implement — which workflow, subagents, worktrees, reviews or other skills you use — is the user's call, not this skill's.

Two things live outside it:

- **the `plan` skill** — turning a new demand into sprints/stories/cards. **All card creation goes through it**, not an ad-hoc `create_card`.
- **Implementation** — whatever the user's own workflow is. Just keep the board in step (see _Working a card_).

## Find the project

Every tool takes an explicit `projectId`. Get it without scanning:

1. **Read the repo binding** — `.agents-board.local.md` first, then `AGENTS.md` (accept `CLAUDE.local.md` / `CLAUDE.md` as legacy locations). It carries `projectId`, `keyPrefix` (cards are `<KEY>-N`), `slug` and the auth flag. If it exists, use `projectId` directly — **don't call `list_projects`**.
2. **Only if there's no binding**, call `list_projects`, match the project whose `slug` fits this repo, and **write the binding** so the next session starts direct: a binding safe to commit goes in `AGENTS.md`, a personal / open-source / multi-board one in a gitignored `.agents-board.local.md`. If nothing matches, ask before creating a project.

**Several hosts may be connected at once** — each has its own tools and its own projects. Run the lookup on the host whose project `slug` matches this repo and never mix entities from two hosts in one operation; don't assume a fixed tool prefix.

## Reading the board

Reach for the cheapest read that answers the question:

- **Snapshots (no tool call)** — the read-only resources `agents-board://projects`, `agents-board://project/<slug>/board` (active sprints, grouped by status), `agents-board://project/<slug>/backlog` and `agents-board://card/<KEY>`.
- **Scan** — `list_cards` (filter by `sprintId`, `status` or a list of statuses, `activeOnly`, `tag`, `backlogOnly`; paged). Rows carry `summary` but not the full body.
- **Detail** — `get_card_by_key(<KEY>-N)` / `get_card(crd_…)` for one card with `descriptionMd`, its commits and its attachments; `get_cards([...])` to batch-read up to 50 refs (ids and keys mixed) after a search.
- **Search by meaning** — `search_cards` and `search_docs` are **hybrid semantic search** (lexical full-text fused with embeddings). Ask in natural language, in any language, with the words you'd actually use — "onde tratamos expiração de sessão" finds the card even when it says "token TTL". `search_cards` also matches **comment bodies** and returns the matched snippet. Quoted phrases, `OR` and `-exclude` still work. Reach for search before assuming something isn't tracked.
- **Images** — cards, comments, docs and inbox items carry an `attachments` array. Open one with the host's resource-reading capability at `attachment://<att_id>` when the image matters; a markdown link in a body is not "seen".

**Orienting at the start of a session:** the active sprint board + unhandled comments + the pending inbox is usually the whole answer. `get_active_sprint` returns an **array** — a project can have several active sprints at once.

## Working a card

You don't need this skill's permission to write code, but the board must reflect reality. The contract is short:

1. **Before the first line of code** — re-read the card, then `claim_task(<KEY>-N, <sessionToken>, <label>)` to signal you're on it (advisory only; `label` = the user's name from auth or `git config user.name`; reuse one token for the whole session). A claim held by **another** session comes back `{ ok:false, conflict:true }` — stop and ask the user before `take_over_task`; do not change its status. Once the claim succeeds, `set_card_status(id, "in_progress")`. Claiming a **story** also reserves its unstarted children.
2. **Read before building** — the card's `descriptionMd`, its `list_comments(cardId)` (every time — new context may have landed), and the docs that bear on the area (`search_docs` / `list_docs` → `read_doc`). **Docs are the source of truth**: if your change would contradict a documented decision, either comply or raise superseding that doc with the user — never diverge silently.
3. **Don't assume past an open decision.** If the card doesn't settle something, ask the user — a direct question for an ambiguity, ready-made options (recommended one first) for a real fork. Check the card, its comments and the docs first; don't re-litigate what's already settled. Record the answer as a comment.
4. **Comment the signal** — `add_comment` for decisions and their *why*, scope changes, deviations, edge cases discovered. Skip narration ("starting now", "typecheck passed").
5. **Hand off to `review`** — `set_card_status(id, "review")` plus **one test-plan comment** (below). This is the correct resting state.
6. **`done` only after the user approves.** Never close a work card on your own. A **parent story** is the one exception: when every child is approved and `done`, closing the story is bookkeeping — do it automatically.
7. **Release the claim** when the card's work is locked in (`release_task(<KEY>-N, <sessionToken>)`); moving a card to `done` releases it anyway.

**A card with a `parent` drives its story.** The board derives no status of its own, and a story renders as an envelope around its children, so its drift is invisible. Whenever you move a child, **re-fetch the parent** and read its children's real current status on the board (never your session's memory — siblings may run in other sessions), then take the **first** matching row:

| The children — **active** ones only (ignore archived) | The story |
| --- | --- |
| every one `done` | `done` |
| every one in `review` or `done` | `review` |
| any one in `in_progress`, `review` or `done` | `in_progress` |
| none of the above (all `todo` / `backlog` / `blocked`) | `todo` |

A `blocked` child holds the story open; a reopened child drags the story backwards by the same rows.

### The test-plan comment

When a card reaches `review`, post **one** comment telling the user how to verify it — this is what turns the acceptance criteria into something they can actually check off, and it's how they decide between approve and reject.

Write it as a **task list** (`- [ ]` / `- [x]` — clickable and persisted), one item per concrete step: what to open, what to do, what to expect. **The markers must tell the truth when you post it:** anything you already ran successfully is `- [x]`; only genuinely pending steps are `- [ ]`. Never make the user repeat a check you already did. If one line mixes done and pending work, split it in two.

```md
- [x] `pnpm test` passes (23 novos casos em `tag-filter.test.ts`)
- [ ] Abrir o board e filtrar pela tag `api` — só os cards com a tag aparecem
- [ ] Limpar o filtro — a lista volta completa, sem recarregar a página
```

Cover every acceptance criterion, plus what you checked yourself. Content follows the user's language.

### Task lists — only for steps with a real done state

Card descriptions, comments and doc bodies render `- [ ]` / `- [x]` as **clickable** checkboxes whose state is saved. **The test: does each item represent an action whose done/pending state matters?** If yes (a QA/test-plan step, a manual runbook — deploy, rollback, migration, env setup) → task list. Anything else → plain bullets (`- `).

In particular, **acceptance criteria and definition-of-done are never task lists**: they're conditions describing what must be true, not steps someone carries out — a checkbox there invites the user to "complete" a spec by ticking it. When unsure, it's a plain bullet.

## Comments

- `list_comments(cardId)` reads a card's thread and advances the user's `unread` comments to `read`.
- `list_unhandled_comments(projectId)` is the project-wide queue of what the user wrote and you haven't closed out — worth a look when you orient.
- **`mark_comments_handled([...])` means you acted**, not that you read it. Call it once the request is addressed, the fix applied, the question answered.
- `add_comment` / `update_comment` / `delete_comment` for the rest. Comments follow the user's language.

## Docs — the project's durable memory

`list_docs` (metadata, no body) → `read_doc(id)` for the content; `search_docs` for semantic lookup; `write_doc` to create (or update, by passing `id`). Four kinds: **`module`** (a code domain/area), **`adr`** (a decision: Context · Decision · Consequences, with the *why*), **`guide`** (how-to), **`note`**. `parentId` nests them.

Write or update a doc when:

- A **durable decision** was made — more than one defensible path, and it shapes the build beyond one card (a library, a data-model call, an auth approach, a convention) → an `adr`.
- A **convention** emerged or changed, or **long-lived module knowledge** surfaced.
- You **created or materially changed a code area with no `module` doc** — write it, so the spec stays complete.

Always **prefer updating an existing doc to creating a near-duplicate**, and reference a doc as a link — `[Doc title](/docs?doc=<id>)`, never a bare id. Keep docs terse: they're read by agents with no context, and they rot when they narrate.

## The inbox — demands not yet planned

The inbox holds a raw demand before anyone breaks it into cards: a passing idea, something to revisit, a finding that belongs to other work. `create_inbox` captures one, `list_inbox` lists the pending ones, `update_inbox` sharpens the text, `mark_inbox_planned(id, cardKeys[])` closes the loop once planning turned it into cards, and `archive_inbox` / `destroy_inbox` drop a discarded one.

Two rules keep it useful:

- **It is not a parking lot for what your own change left half-done.** A gap your change opened — a state nothing renders, a caller you didn't update, a rule only half-applied — gets finished in that change, even if it falls slightly outside the card's stated scope. What legitimately defers is what needs a **decision that isn't yours**, reaches a **module this work has no business touching**, or would **grow the diff well past what the user approved**.
- **Check it isn't already tracked** before adding one — whether you decided to on your own or you're about to suggest it. Run `search_cards` and scan the open `backlog`/`todo`/`review` cards, then `list_inbox`. If something already covers it, say which one instead of creating a duplicate.

When you orient at the start of a session and pending demands exist, mention them and offer to plan them with the `plan` skill.

## Board mechanics worth knowing

- **Statuses**: `backlog`, `todo`, `in_progress`, `review`, `done`, `blocked`. A card needs no sprint to be worked; sprint-less cards live in the backlog.
- **Sprints**: `create_sprint` → `start_sprint` (several may be active at once) → `complete_sprint`; `deactivate_sprint` parks an active one back to `planned`, `reopen_sprint` brings a completed one back. `move_card_to_sprint` / `move_card_to_backlog` move cards between them.
- **Order**: the board sorts by `position`, then `priority` (0–10, the card's value). `reorder_cards(orderedIds)` writes `position = index` in one batch. Pass the **complete order of each affected board list/column**, not only the cards you added — a partial list starts again at zero and can collide with existing positions.
- **Blockers**: `add_blocker(cardId, blockerId)` for a hard dependency; the board shows a blocked card as such. Parenthood (`parentId`) and blockers are **native fields** — never restate them in a card body (`Parent:`, `Blocked by:`, in any language). Citing a related key inline in prose is fine.
- **Keys**: cross-reference cards by their full key (`AB-53, AB-54` — they auto-link), never a range or a positional alias.
- **Tags**: `list_tags` / `create_tag` / `add_tag_to_card`. Tag by area or layer; propose a new tag to the user before creating one.
- **Archive vs destroy**: `archive_*` is a reversible soft-delete for cards, sprints, docs, projects and inbox items — prefer it. `destroy_*` is irreversible and cascades (a sprint takes its cards with it).

## Attaching a diff or an image to a card

Three scripts ship in this plugin's `scripts/` directory (a `.py` twin sits next to each `.mjs` for hosts without Node). They POST straight to the API — **the bytes never enter your context**, which is the whole point: never read or paste a diff.

```bash
node "<this skill's directory>/../../scripts/attach-worktree-diff.mjs" AB-42
node "<this skill's directory>/../../scripts/attach-commit.mjs" <sha>
node "<this skill's directory>/../../scripts/attach-image.mjs" shot.png prj_xxx "board with the story collapsed"
```

- **`attach-worktree-diff <KEY>-N`** shows the pending change on a card sitting in `review`, before any commit exists.
- **`attach-commit <sha> [<KEY>-N]`** attaches the commit's diff and replaces any preview. The key is parsed from the commit message (`feat(x): … (AB-42)`); pass it only when the message doesn't carry it.
- **`attach-image <file> <projectId> [alt]`** uploads a screenshot from disk and prints the markdown to paste into a card, comment, doc or inbox body. **Saving the body is what links the attachment** — an upload nobody references gets swept. The `alt` is what search finds it by, so describe what the image *shows*.

**Auth** — read the flag from the project binding. Auth **on**: mint `issue_commit_token(<KEY>-N)` per attach and pass it as `AB_COMMIT_TOKEN=…`, or `issue_upload_token(<projectId>)` as `AB_UPLOAD_TOKEN=…`. Auth **off**: run them bare. A **401** means auth is actually on — record the flag in the binding file, then retry with a token. In this repository the same scripts have `pnpm attach-commit` / `pnpm attach-worktree-diff` / `pnpm attach-image` shortcuts, which only work from the repo root.
