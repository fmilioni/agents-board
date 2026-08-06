---
name: plan
description: "Use to turn a NEW demand — a feature, a change, a fix — into structured work in Agents Board (sprints, stories, cards). Trigger whenever the user describes something new to build before it's broken down, asks to plan or organize work, or asks to CREATE A CARD — card creation ALWAYS runs through this skill, never a direct create_card. Clarifies the demand, optionally researches it, gets the design approved, then writes cards a zero-context agent can execute. This is PLANNING, not execution — do NOT write code here."
---

# Planning a demand into cards

Turn a demand into work that a fresh agent with **zero context** can pick up and build. The artifact is the **cards in Agents Board** — not a spec file, not a message in the chat.

> **Load the `agents-board` skill first** if it isn't loaded in this conversation — it covers the project binding, the board's tools and conventions this skill builds on.

**Hard rule:** do not write code, scaffold, edit files or mutate the board until the user has approved the plan. This holds for every demand — "too simple to plan" is exactly where a wrong assumption gets baked in. The plan can be three sentences, but you present it and get approval.

## Flow

Run in order. Steps 3–6 are the whole point of the skill; none of them is optional, though a small demand passes through them fast.

1. **Understand the demand.** Read what the user wrote and restate the goal in one sentence. If they described **several independent systems** (a chat platform *and* storage *and* billing *and* analytics), stop: propose a sequence and plan **one module at a time**.
2. **Explore what already exists.** Resolve the project (binding first). Then read: `search_docs` for the decisions and module knowledge that touch this area, `search_cards` plus the open `todo`/`backlog` cards for work that overlaps, and the actual code paths involved. Never propose against a blank slate.
   - **Extend, don't stack.** If the demand only extends a card that hasn't started (`todo`/`backlog`), update that card after approval instead of creating a twin. Once a card is `in_progress` it's locked — the demand becomes its own card. Unsure it's the same deliverable? Ask.
3. **First clarification round — remove the doubts you already have.** Make it unambiguous *what* is being built: goal, scope, constraints, acceptance. Two things to resolve, both with the user (see _Never decide alone_): **ambiguities** (what they actually want) and **missing pieces** (a brief is almost always incomplete — it asks for login but never says which hash, asks for a list but never says empty/error states). Hunt the gaps; don't fill them silently.
4. **Offer research — never run it unannounced.** See _Research is an offer_. Ask whether to dig deeper, say what each option would answer and whether you think it's worth it, and run only what the user picks.
5. **Second clarification round — only what the research opened.** Research routinely surfaces a fork that didn't exist before ("this library needs a background worker — where does it run?"). Take those back to the user the same way, with a recommended default. Don't re-ask what round 1 already settled.
6. **Present the design for approval.** Lay out what will be built, section by section: a direct demand in a few sentences, a complex one in ~200–300 words. Where there's a real fork, give 2–3 approaches with trade-offs, your **recommendation and why**. Include the proposed card breakdown in one line each. Revise until the user approves — only then create anything.
7. **Create the cards** — see _Writing a card_, _Sizing a card_ and _Where the work lives_.
8. **Self-review** the cards with fresh eyes and fix inline — see _Self-review_.
9. **Hand off.** Present the final set (each key + one line, grouped by story). Execution is the user's workflow, whatever it is; the board contract for it lives in the `agents-board` skill — move the card to `in_progress`, land it in `review` with a test-plan comment, and `done` only on the user's approval.
10. **Close the inbox loop.** For every inbox demand you planned, `mark_inbox_planned(id, cardKeys[])` (a discarded one isn't marked — ask the user to `archive_inbox` or `destroy_inbox`). Then re-check `list_inbox` **fresh** — the user may have dropped something while you planned; offer once to plan what isn't covered.

## Never decide alone

Every ambiguity or open choice goes to the **user**. This is the core of planning: a decision settled here is baked into the card, so nobody re-asks it at execution time.

- **Ambiguity → a direct question. Decision** (more than one defensible path: runtime, library, auth model, data shape, storage, UX affordance) **→ ready-made options**, never "what do you think?".
- **Always present a default.** The recommended option comes **first** and is labeled `(Recommended)` in the user's language (`(Recomendado)`), with the reason in a few words. The user should be able to answer by picking, not by researching.
- **One question at a time**, through the host's normal user-input channel; use structured choices when the host offers them. **Chain** the unknowns — settle the earlier one, it narrows the next.
- **Check what's already settled first** — an ADR, an existing card, the demand's own text. Don't re-litigate a decision the project already made.
- **Stop at the choices that shape the card** (the *what*). A decision internal to the build (which helper, how to name a local) belongs to whoever executes it — unless it constrains another card.

## Research is an offer

Sometimes knowledge alone can't produce good options, and planning on guesswork produces cards that get rewritten. **Offer research, then respect the answer.** Never disappear into a research spiral the user didn't ask for, and never skip the offer just because you feel confident.

Make the offer concrete — what each option would answer, and whether you think it's worth it here:

- **Stack / library** — which library or service, its API surface, versions, limits, free tier, how it's wired in. Backed by the docs MCPs available in this session, then the web.
- **Domain** — how this class of feature actually works: the rules, the standard flows, the edge cases and terminology practitioners expect. Useful when the demand is in a domain the project hasn't touched.
- **Codebase** — a deeper read of the modules involved before deciding where the work goes. Cheap; often the highest-value option.
- **None** — enough is known; go straight to the design. Recommend this openly when it's true.

Then:

- **Timebox it and report compactly** — what you found, what it changes about the plan, the sources (web links, board-doc links, file paths). Not a literature review.
- **Feed it back into step 5** — every fork the research opened becomes a question with a recommended default.
- **Record what outlives the planning after approval.** Queue a durable finding (a library comparison, a protocol constraint, a domain rule the whole project will live with), then create or update its doc alongside the approved cards — an `adr` for the decision, a `note`/`guide` for the knowledge. The cards link to it instead of restating it.

## Record what's decided

A decision that lives only in the chat is gone next session.

- **Every decision the user settles goes into the card it concerns** — its **Decisions** section, or the story body for a story-wide call — *before* you create it.
- **A durable / architectural decision also becomes an `adr` doc** (Context · Decision · Consequences, terse, with the *why*) when it shapes the system beyond this one card. Prefer updating an existing doc over adding a near-duplicate.
- **Link each card to the spec that governs it.** When an ADR or module doc constrains the card, cite it as `[Doc title](/docs?doc=<id>)` so the executor reads the constraint instead of re-deriving — or violating — it.

## Writing a card

**The test: could a fresh agent, with no memory of this conversation, execute this card from its contents plus the docs it links?** If not, it's underspecified. Write the sections that fit the card — a two-line fix doesn't need ten headings, and a card that needs all of them is probably two cards. The card is content **for the user**, so its headings and prose are written in the **user's language**; the names below are the roles they play.

- **Objective** — what and why, in a couple of sentences.
- **Context** — what someone who has never seen this area needs to know to start. **Link, don't restate:** an existing doc, module or ADR is referenced (`[Doc title](/docs?doc=<id>)`), never copied.
- **Technical scope** — the real files and modules the work touches, by path, and the new ones it creates. Name the actual endpoint, table, column, component or event — vagueness here is what makes an executor guess.
- **Expected behavior** — including the states everyone forgets: empty, loading, error, permission denied, concurrent edit.
- **Decisions** — each one settled during clarification, one line, with the *why*.
- **Acceptance criteria** — concrete and testable ("the filter clears without a page reload", not "add validation"). **Plain bullets (`- `), never `- [ ]`** — criteria are conditions, not steps the user ticks off (see the task-list rule in the `agents-board` skill).
- **Tests** — what to cover and at which level (unit / integration / e2e), the file that holds them, and the command that runs them.
- **How to verify** — the manual path: what to open, what to do, what to expect. This is the seed of the test-plan comment posted when the card hits `review`.
- **References** — docs, related card keys in full (`AB-53, AB-54`), and images embedded as `![specific description](/attachments/att_…)`.
- **Out of scope** — what this card deliberately does *not* do, when someone might reasonably assume otherwise.

**Code in a card: enough to pin the contract, never the implementation.** A type, an interface, a JSON payload, a SQL column, a function signature, the exact line to change, a CLI command — all welcome when they remove ambiguity. A finished component or a full function body is not: the executor writes the code, and a card that pre-writes it goes stale the moment reality differs.

**DRY across the set.** Shared context lives in **one** place — the story body — and its children point at it. Two cards repeating the same three paragraphs is a bug in the plan, not thoroughness. **YAGNI**: a card that doesn't serve the stated goal doesn't get created.

## Sizing a card

Cards that run for hours are a planning failure: they lose the executor's context, resist review, and can't be validated in one pass.

- **One card = one deliverable that can be verified on its own** — roughly one focused session and one commit.
- **Split when** the card crosses several unrelated layers, its acceptance criteria fall into two groups that could ship separately, or you catch yourself writing "and then". Three to eight acceptance criteria is a healthy band; fifteen means split.
- **Don't fragment either.** A step that can't be demonstrated by itself ("create the type", "add the import") is not a card — fold it into the deliverable it belongs to.
- **Order the split by dependency**, and make the first card the one that unblocks the rest.

## Where the work lives

A card needs no sprint to be worked. Three independent calls:

- **Sprint or not** — a large cohesive effort worth isolating → its own **sprint**; a small one-off → **standalone card(s)**; fits something already underway → an **active sprint** (a project can have several — ask which when more than one could fit).
- **Story or not** — a feature that splits into several testable deliverables → **story + child cards**; one coherent deliverable → **one card**.
- **Now or later** — ready to work → `todo`; parked for later → `backlog`.

Suggest a placement and say why; don't silently pick.

## Card mechanics

- **Create in dependency order** so a card's real key exists before another references it. Wire hard dependencies with `add_blocker`.
- **Sprint state** — create a new sprint as `planned`, with a concise name and an outcome-focused `goal`; call `start_sprint` only when the approved plan says work starts now. Cards ready to execute enter as `todo`; deferred cards enter as `backlog`.
- **`summary`** — required, one line (~100 chars), what the card is about, no noise.
- **`priority`** — the card's **value**, 0–10, on every card: 8–10 core, 4–7 supporting, 1–3 polish. Spread them; don't stamp the same number everywhere.
- **Tag every card** — area/layer (`web`, `api`, `mcp`) or type (`bug`). No fitting tag → propose one and ask before creating it.
- **Title by content alone** — no positional prefix (`T1`, `AB-46.1`); the board numbers and groups for you.
- **A story's body describes the story** — goal, scope, shared context, decisions. It does **not** list its tasks; the tasks are the child cards (`parentId`).
- **Never restate parent or blocker metadata in a body** — they're native fields the board renders. No `Parent:` / `Blocked by:` / `Pai:` / `Bloqueado por:` in any form or language.
- **Carry images into the card.** An image that arrived with the demand (an inbox screenshot, a mockup) is opened at `attachment://<id>` with the host's resource-reading capability, then embedded by reference: `![specific description](/attachments/<id>)`. An image only on disk is uploaded first with the plugin's `scripts/attach-image.mjs` (see the `agents-board` skill) — the bytes never enter your context.
- **`reorder_cards` at the end** — for each affected board list/column, fetch its current order, splice the new cards into the approved execution order (each story followed by its children), and pass the **complete** `orderedIds`. A partial list resets those cards to positions `0..N` and can collide with existing cards.

## Self-review

Read the cards back as if someone else wrote them, and fix every issue inline — adjust, split, merge, drop. Light for one card; thorough for a large set.

- **Coverage** — every part of the demand maps to a card; nothing silently dropped.
- **Self-sufficiency** — each card passes the zero-context test, links its docs, and stays a testable deliverable rather than a micro-step.
- **Sizing** — no card that would run for hours; no card too thin to verify.
- **Pending decisions** — no open choice slipped through; no placeholder, no vague acceptance criterion, no reference to a card that doesn't exist.
- **Consistency** — the cards don't contradict each other, dependency order holds, and the terms line up (a `customer` table in one card and `client` in another is a bug).
- **DRY / YAGNI** — no context copied between siblings that belongs in the story; no card that doesn't serve the goal.
