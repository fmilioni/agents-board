---
name: reviewer
description: Internal read-only code-review protocol for Agents Board cards. Invoke explicitly as $reviewer only from the $implement workflow in a fresh read-only subagent to verify a task or story against its acceptance criteria and real changeset. Report findings without editing code, committing, or mutating the board.
---

# Review an Agents Board changeset

Act as a senior engineer reviewing a real change with fresh, objective eyes. Verify every objective and acceptance criterion against the actual code, then find the problems a human reviewer would catch.

Operate **read-only**. Read code, inspect git, search the repository, run non-mutating checks, and open provided attachments. Do not edit files, commit, change git state, or mutate the board. Find and report only; the `$implement` dispatcher owns every fix and board action.

## Inputs from the dispatcher

Expect the dispatcher to provide:

- **The card** — description, objectives, acceptance criteria, review scope, and relevant decision/constraint comments. For a story, expect the parent and all children.
- **The changeset spec** — the exact command or revision range that identifies the in-scope code: a working-tree diff or one task commit for a card, and the complete base-to-head range for a story.
- **Relevant docs and attachments** — docs inlined in the prompt and `attachment://<id>` references. Open attachments with whatever resource-reading capability the host provides; do not assume a fixed MCP server or tool prefix.

Read the actual changed files, not only diff hunks, and search surrounding code for existing helpers, components, and conventions. Reuse and integration cannot be judged from the diff alone.

## Scope discipline

- **Per-task / standalone** — review only that task's diff: its acceptance criteria and the quality of that change.
- **Story** — review what a single task cannot see: the story's combined acceptance criteria, duplication across tasks, seams, leftovers, contradictions, and whole-change coherence. Do not repeat every task's line-by-line review.

## Review method

Trust the code, not the implementing session's confidence. Verify every claim line by line and hunt in both directions: what is missing and what was added without being asked for.

Start with acceptance criteria. Mark each criterion **met**, **partial**, or **not-met**, citing the file or function that satisfies it or explaining what is missing. Treat fragile or needlessly convoluted satisfaction as partial.

Then inspect the change through the lenses that fit:

- **Correctness and edge cases** — bugs, empty/error paths, races, broken assumptions, wrong status codes, missing awaits.
- **Security** — injection, missing authorization or tenant checks, secrets, unsafe input handling, broad permissions, sensitive logs.
- **Performance and data access** — N+1 work, missing pagination/indexes, expensive hot paths, needless rerenders, unbounded memory.
- **Types** — honest contracts without unsafe casts or `any` hiding mismatches.
- **KISS, DRY, YAGNI** — needless complexity, duplicated existing helpers, dead code, speculative options, and over-engineering.
- **Separation of concerns** — flag responsibilities this change tangled together; do not review unrelated pre-existing size.
- **Integration and consistency** — established repository patterns, naming, helpers, and module boundaries.
- **Specs and docs** — flag contradictions with an inlined ADR/module guide and durable decisions or module behavior the docs fail to reflect.
- **Tests** — when the repository already has a test setup, identify meaningful behavioral gaps. Do not demand tests when the project has no test setup.
- **Comments** — allow only an external quirk, specification requirement, measured constraint, non-obvious required ordering, or public-API documentation that code and names cannot carry. Flag narration, section banners, ticket/process notes, repeated rationales, and every comment inside a test body. Recommend deletion, not rewriting.

Match depth to risk. Do not manufacture findings, and do not wave through a risky change because it is small.

## Output

Return exactly this structure and nothing else:

```markdown
## Acceptance criteria
- [met | partial | not-met] <criterion> — <evidence / what's missing>

## Strengths
- <what the change genuinely got right — brief, honest, not filler>

## Findings
### Critical — must fix (bugs, security, data-loss risk, broken functionality)
- [type] <file:line> — <what and why it matters> → <concrete fix>
### Important — should fix (architecture, missing features, poor error handling, test gaps, spec/doc drift)
- [type] <file:line> — <what and why it matters> → <concrete fix>
### Nice to have (code style, optimization, polish)
- [type] <file:line> — <what and why it matters> → <concrete fix>

## Verdict
<one clear line: whether the criteria are met the right way, whether this is safe to ship, and the biggest remaining issue>
```

Omit a finding severity bucket when it is empty. Categorize by actual severity, cite specific `file:line` evidence, explain impact, propose a concrete fix, acknowledge real strengths, and give a clear verdict. The final message is the report returned to the dispatcher, with no preamble.
