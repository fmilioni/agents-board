---
name: plan
description: Use to turn a NEW demand — a feature, a change, a fix — into structured work in claude-organizer (sprints, stories, tasks). Trigger whenever the user describes something new to build before it's broken down, asks to plan/organize work, or asks to CREATE A CARD — card creation ALWAYS runs through this skill, never a direct create_card. This is PLANNING, not execution — do NOT write code here.
---

# Planning a demand into cards

Turn a demand into well-formed work through dialogue with the user, then materialize it as **cards in claude-organizer**. The artifact is the cards in the MCP — not a spec file. Execution happens afterwards, card by card, via **`$implement`**.

> **Load `$claude-organizer` first.** If it has not been loaded in this conversation, invoke `$claude-organizer` before anything below — it covers what the board is, the project binding, and the comment/doc conventions this skill relies on. If it is already loaded, continue.

**Hard rule:** do NOT write code, scaffold, or edit files until the user has approved the plan. Holds for every demand — "too simple to plan" is exactly where a wrong assumption gets baked in. The plan can be short, but you must present it and get approval.

## Flow

Run in order; the never-assume, approval and self-review steps are not optional.

1. **Understand the demand.** If the user describes **several independent systems** (e.g. a chat platform + storage + billing + analytics), stop and tell them to plan **one module at a time** — propose a sequence and start with the first. Don't try to plan all of them at once.
2. **Explore the context.** Find the project (binding in `.claude-organizer.local.md` or `AGENTS.md`; accept legacy `CLAUDE.local.md` / `CLAUDE.md`; use `list_projects` only if missing). Then read what's relevant: `search_docs` / docs tree for decisions and module knowledge, `search_cards` and the `todo`/`backlog` cards, and project files. Know where this demand fits and what already exists before proposing anything.
   - **Extend, don't stack.** If the demand only **extends a not-yet-started card** (`todo`/`backlog`), update that card (after approval) instead of creating a duplicate. Once a card is `in_progress` it's locked → the demand becomes its own card. Unsure it's the same deliverable? Ask.
3. **Remove every doubt.** Make it unambiguous *what* is being built — goal, scope, constraints, acceptance criteria. Two things to resolve, both **with the user** (see _Never decide alone_):
   - **Ambiguities** — what the user actually wants.
   - **Missing pieces** — a brief is almost always incomplete (asks for login but never says which hash; asks for a list but never says empty/error states). **Hunt the gaps and raise them** — don't fill them silently.
4. **Present the design for approval.** Once doubts are gone, lay out what will be built — section by section, organized. A direct demand: a few sentences. A complex one: ~200–300 words. Where there's a real fork, offer 2–3 approaches with their trade-offs, your **recommendation and why**. Be ready to go back and refine any section that doesn't land. Revise until the user approves — only then create anything.
5. **Create the cards** (see _Writing a card_ and _Card mechanics_). Break the work into **deliverable, testable cards** and pick the shape: a **single card**, a **story + tasks**, or a **sprint + stories + tasks** — by size and cohesion (see _Where the work lives_); suggest one and say why.
6. **Self-review** the cards with fresh eyes (see _Self-review_); fix inline.
7. **Present the final set** — each card's key + one line, grouped by story — for a last look, then hand off: execution proceeds via **`$implement`**, card by card, with the user validating each.
8. **Close the inbox loop.** If you planned demands from the inbox, call `mark_inbox_planned(id, cardKeys[])` for each (a discarded demand isn't marked — drop it, asking the user to `archive_inbox` or `destroy_inbox`). Then **re-check `list_inbox` (pending) fresh** — the user may have dropped something while you planned; if a pending demand isn't covered, offer once to plan it now.

## Never decide alone

Any ambiguity or open choice goes to the **user** — never pick one silently. This is the core of planning.

- **Ambiguity → a direct question.** **Decision** (more than one defensible path: runtime, library, auth model, hashing, storage…) **→ ready-made options**, never "what do you think?": each option concrete, with its trade-offs.
- Ask through the host's normal user-input channel: **one question at a time**, the **recommended option first** with `(Recommended)` in its label (in the user's language, e.g. `(Recomendado)`), with 2–3 concrete options when useful. Use structured choices when the host provides them; otherwise ask directly in conversation.
- **Chain** the unknowns — settle the earlier one first; it narrows the next.
- **Research** when knowledge alone won't yield good options (which library, its free tier, trade-offs), then present what you found.
- Before asking, **check what's already settled** (a doc decision, an existing card, the demand's text) — don't re-litigate it.
- Stop at the choices that shape the **card** (the *what*). Decisions internal to the build belong to `$implement`, not here.

## Record what's decided — card always, docs when durable

Don't let a decision live only in the chat — it's gone next session.

- **Every decision the user settles goes into the originating card.** Fold each answer into the card it concerns — its **Decisions** section (or the story's body for a story-wide call) — *before* creating it, so the executor reads a card that's already decided. This is also how you save the user's decisions **upfront**: a choice settled during planning is baked into the card, not re-asked at execution time.
- **A durable / architectural decision also becomes an `adr` doc.** When a choice has more than one defensible path and shapes how the system is built **beyond this one card** (a library/runtime, a data-model call, a naming/convention, a security/auth approach), write or update an `adr` (Context · Decision · Consequences, terse, with the *why*) under Decisions — not just the card. Prefer updating an existing doc over a duplicate; reference it as `[Doc title](/docs?doc=<id>)`. Card-local decisions stay only on the card; cross-cutting ones live in the docs so the next demand reuses them instead of re-deciding.
- **Link each card to the spec that governs it.** When an existing ADR or module doc constrains the card, **cite it in the card** (`[Doc title](/docs?doc=<id>)`) — so the work is traceable to its spec and the executor reads the constraint instead of re-deriving (or violating) it.

## Writing a card

Write each card so a fresh agent with **zero chat context** can execute it from its contents alone. Describe **behavior and intent, not code** — never write the implementation (naming a real endpoint/table is fine; function bodies aren't), unless it's a real constraint or an already-diagnosed bug. Use the sections that fit:

- **Objective** — what and why.
- **Acceptance criteria** — how to know it's done (concrete, testable — not "add validation"). Write them as **plain bullets** (`- `), **never** as a task list (`- [ ]`): acceptance criteria are conditions/specs, not manual steps the user ticks off. Checkboxes render as interactive clickable items and are reserved for runbooks / QA test-plans the user actually carries out — see the task-list rule in `$claude-organizer`. The same goes for a **definition-of-done** or any conditions list: plain bullets.
- **Expected behavior**, **Decisions** settled during clarification, and constraints / out-of-scope / references _as needed_.

The test: *could a fresh session build this from the card alone?* If not, it's underspecified — keep refining.

## Where the work lives — card, story, or sprint

A card needs no sprint to be worked. Three independent calls:

- **Sprint or not** — a large, cohesive effort worth isolating → its own **sprint**; a small one-off → **standalone card(s)** on the board; fits something already underway → an **active sprint** (a project can have **several** active at once — pick which one it belongs to, and ask the user when more than one could fit).
- **Story or not** — a feature that splits into several testable deliverables → **story + tasks**; one coherent deliverable → **one card**.
- **Now or later** — worked now → the board; parked → the `backlog`.

When in doubt, suggest a placement and say why; don't silently pick.

## Card mechanics

- **Create in dependency order** so a card's real key exists before another references it. Wire hard dependencies with **blockers**.
- **`summary`** — required, one line (~100 chars), what the card is about, no noise.
- **`priority`** — set it as the card's **value** (0–10) on every card: 8–10 core, 4–7 supporting, 1–3 polish; spread them, don't stamp the same number. (Board order is `position` then `priority`.)
- **Tag every card** — area/layer (`web`, `api`, `mcp`) or type (`bug`). No fitting tag → suggest new one(s) and ask before creating.
- **Title by content alone** — no positional prefix (`T1`, `AB-46.1`); the board numbers and groups for you.
- **Cross-reference by the real key, in full** — `AB-53, AB-54` (auto-links), never a range `AB-53/54` or a positional alias.
- **A story's body describes the story** — goal, scope, decisions. It does **not** list its tasks; the tasks are the child cards (`parentId`).
- **Never restate parent/blocker metadata in the body** — `parentId` and `blockers` are **native fields** the board already renders, so a card/story body must not carry the parent or blocker relationship in **any** form (loose line, header, blockquote, list item): no `Parent:` / `Blocked by:` / `Pai:` / `Bloqueado por:` or equivalent in any language. Parenthood lives in `parentId`; hard dependencies in `blockers`. Citing a related key inline in prose, where genuinely relevant, stays fine — the ban is duplicating the native parent/blocker metadata as a standalone descriptor.
- **Reference a doc as a link** — `[Doc title](/docs?doc=<id>)`, never a bare id.
- **Carry images into the card** — when the demand arrives with an image (inbox screenshot, mockup), open `attachment://<id>` with the host's available resource-reading capability, then embed it in the right card: `![<specific description>](/attachments/<id>)` (reuse the existing `att_…` by reference). The `alt` is what search finds — make it specific. An image that exists only **on disk** (a screenshot you took) is uploaded first with `node "<this skill's directory>/../../scripts/attach-image.mjs" <file> <projectId> [alt]` (a `.py` twin sits next to it), which prints the markdown to embed; the bytes never enter your context. With auth on, mint `issue_upload_token(<projectId>)` and pass it as `AB_UPLOAD_TOKEN`.
- **`reorder_cards` once at the end** — pass every created card id in reading order (each story followed by its children, standalones slotted in) so the board shows execution order.

## Self-review

After creating, read the cards back as if you didn't write them — fix every issue inline (adjust, split, merge, drop), then move on. Light for one card; thorough for a large set. Check:

- **Coverage** — every part of the demand maps to a card; no gap.
- **Self-sufficiency** — each card passes the memoryless-session test and stays a testable deliverable, not a micro-step. No placeholder / vague acceptance / reference to a card that doesn't exist.
- **Pending decisions** — no open choice slipped through unsettled.
- **Consistency** — cards don't contradict each other; dependency order holds; terms line up (a `customer` table in one card and `client` in another is a bug).
- **Scope** — the set actually achieves the user's objective; YAGNI — cut a card that doesn't serve the goal.
