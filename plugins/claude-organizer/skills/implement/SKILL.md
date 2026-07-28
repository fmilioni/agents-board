---
name: implement
description: Use to EXECUTE cards that already exist on the board in claude-organizer — a task, a story, several stories, or a whole sprint. Trigger the moment you start, resume, or continue work on specific cards ("work CO-42", "implement this story", "run the sprint", "build it now"). Owns the per-card lifecycle (in_progress → implement → review by a fresh subagent → review status → commit) and multi-card runs in two modes — review each card, or run the whole batch autonomously. Commits one per card (after the user approves the review, or directly in an agreed batch run); leaves each card in `review` until the user approves. NEVER assume — any open decision the card doesn't settle goes to the user first. To break a NEW demand into cards, use `plan` instead.
---

# Implementing a card

Execute a card that already exists on the board — a task, a story, or a sprint's cards. Planning produced the card; here you build it and walk it through its lifecycle while keeping the board honest. To break a new demand into cards, use **`plan`** — not this skill.

> **Load the `claude-organizer` skill first.** If it hasn't been loaded in this conversation, invoke it (Skill tool) before anything below — it covers what the board is, the project binding, and the comment/doc conventions this skill relies on. If it's already loaded, just continue.

**Hard rule:** the per-card lifecycle below runs **every card, in order** — trivial or not. Never assume past an open decision; never move a **work** card to `done` without the user's explicit approval. The **one** exception is a **parent story** whose every child is already approved and `done`: closing it is derived bookkeeping, not a work approval — the session that lands the last child closes it automatically (see _Keeping the story in step_). Leaving a card in `review` is the correct resting state, not a defect.

## Never assume — ask the user

Execution constantly hits things the card didn't nail down. **Never guess past one — ask**, before writing code:

- **Ambiguity → a direct question.** **Decision** (more than one defensible path: which helper/library, data shape, where code lives, edge-case behavior) **→ ready-made options** with trade-offs, the recommended one first and labeled `(Recommended)` / `(Recomendado)` in the user's language. Use `AskUserQuestion`, one topic per message; chain unknowns (settle the earlier, it narrows the next).
- **Check first** — the answer may already be in the card's description, its comments, or the docs; don't re-litigate a settled call. **Record** the answer as a comment (and fold it into the description when it changes the spec).
- **A story is decided up front.** Before building a story, read all its cards (description + comments), gather every open decision across them, and clear the batch with the user before any code.

## Running multiple cards — a story, several cards, or a sprint

When the user points you at more than one card (a whole story, several cards or stories, a sprint), settle two things up front, then loop the lifecycle per card:

1. **Ask the run mode** (`AskUserQuestion`, before any code):
   - **Review each card** — stop after each card for the user to validate before the next (commit waits for approval per card; the one-card-at-a-time path in the lifecycle).
   - **Run it all at once (batch)** — execute every card autonomously, leaving each in `review`, and validate the whole batch at the end (commit directly per card).
2. **Agree the git flow** for the run — unless `CLAUDE.md` already defines one (then follow it, don't ask). In batch mode the options matter most: one PR for everything, straight commits, or a stack of branches (see _Git flow_).
3. **Track the run with a tasklist** (`TaskCreate` / `TaskUpdate`) mirroring the cards in execution order — in **both** modes, so you and the user always see where the run is. Update each item as its card moves (`in_progress` → `review` → `done`).
4. **Loop the lifecycle** per card, in order; respect blockers (don't start a card whose blocker isn't `done`). The **story-level review fires in both modes**, as soon as a story's **last card is committed** — before you open the PR or ask for the run's approval, so the merge decision knows what it found (see _The story review_).

## Git flow — agree before you start

Get the git flow straight **before writing code**. If the repo's `CLAUDE.md` already defines one, follow it — don't ask. Otherwise **ask** (ready-made options + a recommendation), scaled to the run:

- **A single card** → its own branch (branch + PR) **or** commits straight on the current branch / `main` / `master`.
- **A story, several stories, or a sprint** → **one branch + one PR for the whole run**, **straight commits** on the current branch / `main` / `master`, or a **stack of branches** (one per card or per story).

Mirror what the user already does; factor in parallel work / worktrees for scopes worked in parallel. **The agreed flow is your standing authorization to commit** (see the lifecycle).

**Worktree?** Use `.claude/worktrees/<branch>` (fixed path — don't ask where). First ensure `.claude/worktrees/` is in `.gitignore`; after creating it, install the project's deps (a fresh worktree has none) before any typecheck/lint/build; remove it (`git worktree remove`) when done.

## The lifecycle — every card, in order

1. **`in_progress` + claim.** Re-read the current board first (priorities/comments may have changed). `set_card_status(id, "in_progress")` before a line of code, and `claim_task(<key>, <sessionToken>, <label>)` to reserve it (`label` = the user's full name from auth / `git config user.name`; one token reused all run). **Starting a story:** claim **all** its children (signals the whole story is being worked) but move **only the current child** to `in_progress` — each child's claim is then released individually as that child is committed (step 8). A claim **conflict** (held by another session) → stop and ask before `take_over_task`. Finally, **does this card have a `parent`?** `get_card` / `get_card_by_key` always tells you — check it on **every** card, including a lone task you were pointed at directly, and drive the story from it (see _Keeping the story in step_).
2. **Read this card's comments** — `list_comments(cardId)`, every card, even if read before (new context may have landed). Reading advances `unread → read`; once you've **acted** on a comment, `mark_comments_handled([...])`. A story's comments don't cover its children — read each.
3. **Read the relevant docs** — `list_docs` / `search_docs`, then read what bears on this card's area (the `module` you'll touch, an `adr`/`note` that constrains it). Docs are the project's memory — read them so your work keeps the established decisions and patterns consistent. **Docs are the source of truth:** if your change would **contradict a documented decision (an ADR) or convention**, don't diverge silently — either comply, or raise **superseding that doc** with the user (a conscious spec change) before building.
4. **Implement** — clean code, and **write no comments** (the bar is below). Stay in scope. Open any image the card carries (`ReadMcpResource attachment://<id>`) before building — a markdown link isn't "seen". Hit a doubt → stop and ask (step _Never assume_). Then **self-review your own diff** with fresh eyes (acceptance criteria, YAGNI, naming, **comment-noise**, that checks exercise behavior) and fix the easy misses inline — this doesn't replace the review gate.
   - **The bar** — the code, the types, the names and the test names carry the intent. A comment is justified only when it points at something **outside the diff** that a reader cannot recover from them, and only these five: an external bug/quirk being worked around, a spec/protocol/API requirement, a measured constraint, an ordering that looks removable and isn't, or a public-API doc. **The list is closed** — a rationale that fits none of them isn't written. If it can be reconstructed by reading the code, don't write it. Touching existing code, **delete** comments that fail this bar — don't leave one because "someone might've meant it".
   - **Never** restate what the code says (`const total = a + b`), banner a section (`// state`, `// helpers`), note "added for X" / a ticket ref, **meta-comment** the process or these rules (`// the comment lives here`, `// no comments here`), or write **relative to the change** (`// now it's blue`, `// no longer X`) — code only knows its current state, so a diff-relative note is a lie by the next commit.
   - **No comments inside a test body** — the `it(...)` title *is* the explanation; if the intent needs explaining, **rename the test**.
   - **One rationale, one place** — never repeat in a test, or in another file, a *why* that already lives at the source.
5. **Comment the signal** — `add_comment` for decisions+why, scope changes, deviations, edge cases. Skip noise (the plan, narration, "typecheck passed").
6. **Review gate — a fresh subagent** (see _Dispatching the reviewer_). Run it over the working-tree diff so fixes fold into one clean commit. **Fix every finding here — that's the default**; severity ranks the list, it never authorizes dropping one. Re-review non-trivial fixes.
   - **A finding goes to the inbox only when it fails one of three tests:** it needs a **decision that isn't yours to take**; it reaches a **module or system this card has no business touching**; or fixing it would **grow the diff past what the user approved**. Nothing else defers.
   - **A gap this card itself opened is never inboxed** — this rule **beats all three tests**. If your change created the state, the same change closes it, **even when the fix lands in another module or outside the card's stated scope**, and the card comment says why it went in. A new state with nothing rendering or consuming it is half-done work, not a backlog item.
   - **"Outside the card's declared scope" is not, on its own, a reason to defer** — it's a reason to explain the detour in the comment.
   - When you do inbox one: run the dedup check from the `claude-organizer` skill first (search the board + pending inbox) and reference an existing card/item instead of duplicating, then flag it in the final overview — never drop it silently.
7. **Hand off to `review`.** `set_card_status(id, "review")` and post **one** test-plan comment (what to open, do, expect; what you already checked). **Keep the claim** — the card's work isn't locked in until it's committed, so it's released at step 8, not here. Card has a parent → re-derive the story (see _Keeping the story in step_).
8. **Commit, then release — timing depends on the run mode.** Committing a story's **last** card is what makes its full changeset reviewable: run the **story review right there**, before the PR / the approval request (see _The story review_). Whenever this lands a child in `done`, re-derive the story (see _Keeping the story in step_) — and if it was the story's last open child, **you own the close**.
   - **Review-each-card mode (and any single card):** **do not commit until the user approves the review.** Attach the **working-tree** diff (`attach-worktree-diff <CO-N>`) so the card in `review` shows the pending change; wait for the user's go-ahead, then commit **one per card** (message in English with the key, e.g. `feat(tags): … (CO-4)`) + `attach-commit <sha>` (replaces the preview), **release the claim** (`release_task(<key>, <sessionToken>)`), and move the card to `done` (or open a PR — see _End of run_).
   - **Batch mode (run-it-all-at-once):** the agreed git flow is your authorization — commit each card **before starting the next** (so its working-tree diff stays isolated for that card's review gate), **one per card**, + `attach-commit <sha>`, then **release the claim** (`release_task(<key>, <sessionToken>)`), leave the card in `review`, update the tasklist, and **continue to the next**. The whole batch is approved together at the end of the run.
   - **Auth on:** each attach needs its **own** token, so the review-each-card path mints **two** (`issue_commit_token(<key>)` for `attach-worktree-diff`, then a fresh one for `attach-commit`); batch mints one per card. See _Diff capture_.

## Keeping the story in step

**A card with a `parent` drives its story — always, even when the user pointed you at that one task alone.** Nothing else updates the story (the board derives no status of its own) and its drift is invisible — a story renders as an **envelope** around its children, so its own status shows nowhere on the kanban. Skipping this on a lone task is how a story ends up sitting in `todo` with every child `done`.

**Re-check the board, never your session's memory.** A story's tasks may run in **different Claude Code sessions** (and machines), so the session finishing its card can't assume what the siblings did. Whenever you move a child (to `in_progress`, `review` or `done`), **re-fetch the parent** (`get_card` / `get_card_by_key` on it) and read the children's **real current status** — then put the story where those children say it belongs. Read the rows in order and take the **first** that matches, so every combination lands somewhere:

| The children — **active** ones only, on the board | The story |
| --- | --- |
| every one `done` | `done` — but only through the close below |
| every one in `review` or `done` | `review` |
| any one in `in_progress`, `review` or `done` | `in_progress` |
| none of the above (all `todo` / `backlog` / `blocked`) | `todo` |

**Ignore archived children** — an archived task is cancelled, not pending; counting it would leave the story un-closable forever. A **`blocked`** child counts as neither started nor finished: it can't satisfy the `review`/`done` rows, so it holds the story open. A child that moves **backwards** (a reopened task) drags the story back by the same rows — including all the way to `todo` when nothing is under way anymore.

### The story review — fires at the last commit, not at the close

The story review's input is the **complete changeset**, and that exists the moment the story's **last card is committed** — not when the story closes. Run it there:

- **Run the pass** — **one story-level reviewer pass** over the **whole story changeset** (`git diff <base>...HEAD`, every child committed) for the cross-cutting issues a single task can't see (one concept implemented two ways across tasks, duplication, coherence as a PR). The `reviewer` agent reads code + git from the context you curate, so it doesn't matter which session wrote each task.
- **Then dispose of the findings** — the review-gate rules (step 6) apply here too, and a story is where a state-with-nothing-consuming-it is likeliest to appear: **fix by default** (a new commit on the story, attached like any other), and a gap the story itself opened is fixed, never offered. Only for what fails one of the three tests, offer **per finding**: **send it to the inbox** (run the `claude-organizer` dedup-check first — search the board + pending inbox; reference an existing card/item instead of duplicating) or **create a follow-up card**.
- **Single-session run (the common case): only then open the PR / ask for approval**, presenting what the review found together with the request — the user decides the merge knowing it. Never the reverse: an approval asked before the pass makes the merge decision blind to the only findings that see the story whole.
- **Multi-session story:** when the children ran in other sessions/machines, the session that lands the last child is the **first** that can assemble the whole changeset — there the pass at the close is the only possible moment. Before reviewing, ensure every child's commit is present and reachable from `HEAD` (`git fetch`, then pull/merge the shared run branch). If the commits can't be assembled locally, you **can't** run a faithful story review — surface that to the user and **don't auto-close**.

**Whoever lands the last child owns the close.** When you move a child to `done` and the re-query shows **every sibling is already `done`** (you just closed the last open one), you take over closing the story — even if this session never touched the other tasks. Here the review is a **confirmation gate, not discovery**: a pass already run over this exact changeset stands — **don't re-run it**. Re-run only when the changeset moved since — a child was reopened and re-committed, or a new commit landed on the story (including a non-trivial fix of your own).

- **Clean review → move the story to `done` automatically**, no extra question. This is the lone `done` not gated on a fresh approval: each child was already approved before its own `done`, so closing the derived parent is bookkeeping, not a work decision (the hard rule's exception).
- **Review with findings → move the story back to `in_progress`** (it's sitting in `review`, so this *is* a transition) — the one case where the table above doesn't apply: every child is `done`, but the story doesn't close until the findings are resolved.

This holds in **both run modes** — review-each-card commits each child as the user approves it, batch commits each child before the next; either way the pass fires at the story's last commit and the story closes once its final child reaches `done` **and that review is clean**, whichever session gets there.

## Dispatching the reviewer

Spawn the **`claude-organizer:reviewer`** agent (`Agent` tool) — it's read-only by construction (no board tools, no Edit/Write), so it reads code + git and reports; **you** dispose of its findings. You have board access, so curate into its prompt everything it needs:

- **The card** — description and **acceptance criteria**, the **scope** (per-task / story / standalone), and the **relevant comments** (the decisions/constraints that bear on the review — you filter junk from signal). For a story, inline the parent + all children.
- **The changeset spec** — how to see exactly the in-scope code (it runs git itself): per-task → that task's working-tree diff (`git diff`) or commit (`git show <sha>`); story → `git diff <base>...HEAD`.
- **Relevant docs and image refs** — inline the pertinent docs; for images pass the MCP server name + `attachment://<id>`.

It returns a structured report (acceptance criteria met/partial/not-met, typed findings by severity, a verdict). **Dispose of the findings by the review-gate rules** (step 6): fix by default, inbox only what fails one of the three tests, never a gap this card itself opened. Surface a real trade-off to the user; nothing is dropped on severity.

## End of run

After the cards are built and sitting in `review`:

1. **Overview** — what landed, and **especially** the out-of-scope items pushed to the inbox, so nothing gets lost.
2. **Docs** — the moment a **durable decision** was made (more than one defensible path, affects the build beyond one card — **including a decision the user settled mid-run**), a **convention** emerged or changed, or **long-lived module knowledge** surfaced, create/update the doc: an `adr` (Context · Decision · Consequences, with the *why*) / `guide` / `module` / `note`. **Module-doc coverage:** if you **created or materially changed a code area that has no `module` doc**, write/update its module doc so the system's spec stays complete. Prefer updating an existing doc over a duplicate; reference docs as `[Doc title](/docs?doc=<id>)`. (Per-card decisions are already recorded as comments via _Never assume_ — this is the durable, cross-cutting layer on top.)
3. **Close by the git flow used.** Every story in the run already had its **story review** at its last card's commit (step 8) — **ask for approval / open the PR with those findings in hand**, presenting them alongside the request, never after. Then, for any card still awaiting approval (a batch run leaves them all in `review`), wait for the user's affirmative ("approved", "you can merge", "go ahead", "continue"), then: committed straight on the current branch / `main` → move the approved cards to `done`; committed on a branch → offer to open a **PR** (one PR for a single run branch, or one per branch for a stack; title a conventional-commit with the key, body in English; merging is the user's call — see `CLAUDE.md`). Until the user approves, cards stay in `review`. Each card that lands in `done` here re-derives its story (see _Keeping the story in step_) — a batch run closes its children in this step, so this is where its stories close too, the close merely **confirming** the review already run unless the changeset moved since.
4. **Close the tasklist** — mark each item done as its card lands, so the final state is visible.
5. **Re-check `list_inbox` (pending) fresh** — the user may have dropped demands while you worked. If any aren't covered, suggest planning them (they can open a fresh session for clean context on a big run).

## Diff capture

Two scripts ship **inside this skill** — call them by absolute path under this skill's directory (the `pnpm` shortcuts exist **only** in the claude-organizer dev repo). Use the `.mjs` on any host with Node 18+; a `.py` twin sits next to each for hosts without Node. Both POST the diff to the API outside your context — **never read or paste the diff**.

- **`attach-worktree-diff.mjs <CO-N>`** — the **review preview before any commit**: attaches the working-tree diff so the user sees the pending change while the card sits in `review`. The card key is **required** (there's no commit to read it from). Used in the one-card-at-a-time path, where the commit waits for approval.
- **`attach-commit.mjs <sha> [CO-N]`** — after a commit lands: attaches the clean per-card commit diff (replaces any worktree preview). The commit **`<sha>` is required**; the card key is **optional** — the script parses it from the commit message (`… (CO-N)`), so pass `[CO-N]` only if the message doesn't carry it. Used the moment you commit — directly in a batch run, or after approval in the one-card path.

```bash
# card key is the CO-N key (e.g. CO-42); sha is the commit hash you just created
node "<this skill's directory>/scripts/attach-worktree-diff.mjs" CO-42
node "<this skill's directory>/scripts/attach-commit.mjs" <sha>
# auth on → prefix the same command with the card-scoped token:
CO_COMMIT_TOKEN=<token> node "<this skill's directory>/scripts/attach-commit.mjs" <sha>
```

**Auth flag** — read it from the project's `CLAUDE.md`. Auth **on** → mint `issue_commit_token(<CO-N>)` and pass `CO_COMMIT_TOKEN=<token>` (one per attach). Auth **off / no flag** → run tokenless. If an attach returns **401**, auth is actually on: record the flag in `CLAUDE.md`, then retry with a token.

## Attaching an image

A screenshot you produced (a UI check, a failing state, a chart) becomes an attachment through **`attach-image.mjs <file> <projectId> [alt]`**. It sits in the plugin's own `scripts/` directory rather than this skill's, so `plan` reaches the same script — hence the `../../` below. It uploads from disk and prints the `att_` id and a `![alt](/attachments/att_…)`; **the bytes never enter your context**, the same reason the diff scripts exist. A `.py` twin sits next to it for hosts without Node.

```bash
node "<this skill's directory>/../../scripts/attach-image.mjs" shot.png prj_xxx "board with the story collapsed"
# auth on → mint issue_upload_token(<projectId>) first:
CO_UPLOAD_TOKEN=<token> node "<this skill's directory>/../../scripts/attach-image.mjs" shot.png prj_xxx "…"
```

Paste that markdown into the card, comment, doc or inbox body — **saving the body is what links the attachment**; an upload nobody references is swept after the grace window. The `alt` is what search finds it by, so describe what the image *shows*, not "screenshot".
