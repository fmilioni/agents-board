import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  notInArray,
  or,
  type SQL,
  sql
} from 'drizzle-orm'
import { z } from 'zod'

import { createId, type Database, schema } from '@agents-board/db'

import { archivedCondition, type ArchiveFilter } from './archive'
import { gcAttachmentsOnArchive, gcAttachmentsOnDestroy } from './attachmentGc'
import { reconcileAttachmentLinks, relinkCardsAndComments } from './attachmentLinks'
import { getSystemSettings } from './authz'
import { listBlockedBy, listBlocking, pendingBlockerCounts } from './blockers'
import { claimsByCardIds, getClaim, releaseClaimOnDone } from './cardClaims'
import { relinkCommitImages } from './cardCommits'
import { applyChunks, backfillChunks, embed, embedChunks } from './embedding'
import { InputError } from './errors'
import { notify } from './events'
import { pruneIntakeForDestroyedCards, syncIntakeForCard } from './intake'
import { paginate } from './pagination'
import { excludedTsQuery, hybridOrder, LEXICAL_POOL, orTsQuery, toVectorParam, vectorK } from './search'
import { listCardTags, tagsByCardIds } from './tags'

const cardStatus = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked'
])

export const createCardInput = z.object({
  projectId: z.string(),
  sprintId: z.string().optional(),
  title: z.string().min(1).max(200),
  summary: z.string().max(200).optional(),
  descriptionMd: z.string().optional(),
  status: cardStatus.optional(),
  priority: z.number().int().min(0).max(10).optional(),
  dueDate: z.coerce.date().optional(),
  parentId: z.string().optional(),
  tagIds: z.array(z.string()).optional()
})
export type CreateCardInput = z.infer<typeof createCardInput>

export const updateCardInput = z.object({
  id: z.string(),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(200).nullable().optional(),
  descriptionMd: z.string().optional(),
  status: cardStatus.optional(),
  priority: z.number().int().min(0).max(10).optional(),
  position: z.number().int().min(0).optional(),
  dueDate: z.coerce.date().nullable().optional(),
  sprintId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional()
})
export type UpdateCardInput = z.infer<typeof updateCardInput>

export const reorderCardsInput = z.object({
  orderedIds: z.array(z.string()),
  moved: z
    .object({
      id: z.string(),
      status: cardStatus,
      sprintId: z.string().nullable().optional()
    })
    .optional()
})
export type ReorderCardsInput = z.infer<typeof reorderCardsInput>

export type CardStatus = z.infer<typeof cardStatus>

/**
 * Shared filter shape for focused reads — reused by `listCards` and
 * `searchCards` (see CO-222/CO-216 coordination) so the two never diverge.
 * `status` takes a single value (back-compat) or a list; `activeOnly` is the
 * ergonomic shortcut for "everything but done/backlog". `limit`/`offset` page
 * the result — no default here (callers/the MCP layer set a safe cap; the web
 * board needs the full set, so the core stays uncapped).
 */
export interface CardFilters extends ArchiveFilter {
  sprintId?: string | null
  /**
   * Restrict to a set of sprints (e.g. every active sprint of a project — the
   * multi-active board of CO-399). Takes precedence over `sprintId`; an empty
   * array matches no card. Ignored when `backlogOnly` is set.
   */
  sprintIds?: string[]
  status?: CardStatus | CardStatus[]
  activeOnly?: boolean
  tag?: string
  backlogOnly?: boolean
  limit?: number
  offset?: number
}

export interface ListCardsFilters extends CardFilters {
  projectId: string
}

const cardSummaryColumns = {
  id: schema.cards.id,
  projectId: schema.cards.projectId,
  sprintId: schema.cards.sprintId,
  parentId: schema.cards.parentId,
  key: schema.cards.key,
  title: schema.cards.title,
  summary: schema.cards.summary,
  status: schema.cards.status,
  priority: schema.cards.priority,
  dueDate: schema.cards.dueDate,
  position: schema.cards.position,
  createdAt: schema.cards.createdAt,
  updatedAt: schema.cards.updatedAt,
  doneAt: schema.cards.doneAt
}

// Allow-list, not a bare select: searchTsv (or any future column) can't leak
// into get_card or a card mutation return.
const cardDetailColumns = {
  ...cardSummaryColumns,
  descriptionMd: schema.cards.descriptionMd
}

// `doneAt` write for a status change: stamp `now()` on the transition INTO `done`
// (a card already in `done` keeps its original stamp — re-entering `done` only
// re-stamps because leaving cleared it first); any other status clears it. The
// `cards.status` reference resolves to the row's pre-update value (SQL evaluates
// SET right-hand sides against the old row).
function doneAtWrite(status: CardStatus): SQL {
  return status === 'done'
    ? sql`case when ${schema.cards.status} <> 'done' then now() else ${schema.cards.doneAt} end`
    : sql`null`
}

/** Text embedded for a card — key + title + summary + description (e5 `passage:`). */
function cardContentText(c: {
  key: string
  title: string
  summary?: string | null
  descriptionMd?: string | null
}): string {
  return [c.key, c.title, c.summary, c.descriptionMd].filter(Boolean).join('\n')
}

function statusCondition(filters: CardFilters): SQL | undefined {
  if (filters.activeOnly) {
    return notInArray(schema.cards.status, ['done', 'backlog'])
  }
  if (Array.isArray(filters.status)) {
    return filters.status.length
      ? inArray(schema.cards.status, filters.status)
      : undefined
  }
  if (filters.status) return eq(schema.cards.status, filters.status)
  return undefined
}

function tagCondition(db: Database, tag: string | undefined): SQL | undefined {
  if (!tag) return undefined
  const cardIds = db
    .select({ id: schema.cardTags.cardId })
    .from(schema.cardTags)
    .innerJoin(schema.tags, eq(schema.cardTags.tagId, schema.tags.id))
    .where(or(eq(schema.tags.id, tag), eq(schema.tags.name, tag)))
  return inArray(schema.cards.id, cardIds)
}

function cardFilterConditions(
  db: Database,
  projectId: string,
  filters: CardFilters
): SQL[] {
  const conditions: SQL[] = [eq(schema.cards.projectId, projectId)]
  if (filters.backlogOnly) {
    conditions.push(isNull(schema.cards.sprintId))
  } else if (filters.sprintIds !== undefined) {
    conditions.push(
      filters.sprintIds.length
        ? inArray(schema.cards.sprintId, filters.sprintIds)
        : sql`false`
    )
  } else if (filters.sprintId !== undefined) {
    conditions.push(
      filters.sprintId === null
        ? isNull(schema.cards.sprintId)
        : eq(schema.cards.sprintId, filters.sprintId)
    )
  }
  const status = statusCondition(filters)
  if (status) conditions.push(status)
  const tag = tagCondition(db, filters.tag)
  if (tag) conditions.push(tag)
  const archived = archivedCondition(schema.cards.archivedAt, filters)
  if (archived) conditions.push(archived)
  return conditions
}

/** Attach tags, subtask counts, parent key, blocker count and claim to card rows. */
export async function enrichCardRows<
  T extends { id: string, parentId: string | null }
>(db: Database, rows: T[]) {
  const ids = rows.map(r => r.id)
  const [tagMap, counts, parentKeys, blockerCounts, claimMap] = await Promise.all([
    tagsByCardIds(db, ids),
    subtaskCounts(db, ids),
    parentKeysFor(db, rows),
    pendingBlockerCounts(db, ids),
    claimsByCardIds(db, ids)
  ])
  return rows.map(r => ({
    ...r,
    tags: tagMap.get(r.id) ?? [],
    subtaskCount: counts.get(r.id)?.total ?? 0,
    subtaskDone: counts.get(r.id)?.done ?? 0,
    parentKey: r.parentId ? (parentKeys.get(r.parentId) ?? null) : null,
    blockedByPending: blockerCounts.get(r.id) ?? 0,
    claim: claimMap.get(r.id) ?? null
  }))
}

export async function listCards(db: Database, filters: ListCardsFilters) {
  const conditions = cardFilterConditions(db, filters.projectId, filters)
  let query = db
    .select(cardSummaryColumns)
    .from(schema.cards)
    .where(and(...conditions))
    .orderBy(asc(schema.cards.position), desc(schema.cards.createdAt))
    .$dynamic()
  if (filters.limit !== undefined) query = query.limit(filters.limit)
  if (filters.offset !== undefined) query = query.offset(filters.offset)
  const rows = await query
  return enrichCardRows(db, rows)
}

export interface MatchedComment {
  commentId: string
  snippet: string
}

// Snippet feeds <AppMarkdown>, so HTML highlight tags would render raw — use markdown bold.
const SNIPPET_OPTS = 'StartSel=**,StopSel=**,MaxFragments=1,MaxWords=24,MinWords=6,ShortWord=2'

/**
 * Enrich card rows and attach each card's best-matching comment snippet. The
 * lexical snippet (ts_headline highlight) wins; for a card matched only via a
 * comment's vector (`param` given, no lexical comment hit) the nearest comment by
 * cosine distance supplies the snippet, so a semantic comment match still shows one.
 */
async function withMatchedComments<T extends { id: string, parentId: string | null }>(
  db: Database,
  rows: T[],
  tsQuery: SQL,
  param?: string
) {
  const ids = rows.map(r => r.id)
  const [enriched, lexicalSnippets] = await Promise.all([
    enrichCardRows(db, rows),
    matchedCommentSnippets(db, ids, tsQuery)
  ])
  let vectorSnippets = new Map<string, MatchedComment>()
  if (param) {
    const need = ids.filter(id => !lexicalSnippets.has(id))
    vectorSnippets = await nearestCommentSnippets(db, need, param, tsQuery)
  }
  return enriched.map(c => ({
    ...c,
    matchedComment: lexicalSnippets.get(c.id) ?? vectorSnippets.get(c.id) ?? null
  }))
}

/**
 * When the whole trimmed query is a card-key reference — a full key (`AB-375`,
 * case-insensitive) or a bare number (`375`, resolved via the project's
 * keyPrefix) — return that card's id IF it still passes the active search
 * filters, so the caller can pin it first. A partial number (`37`) resolves to
 * `<prefix>-37`, never `AB-375`; any query with text past the key matches
 * neither pattern and yields no pin.
 */
async function exactKeyMatchId(
  db: Database,
  projectId: string,
  q: string,
  filters: CardFilters
): Promise<string | null> {
  let key: string | null = null
  if (/^[a-z0-9]+-\d+$/i.test(q)) {
    key = q
  } else if (/^\d+$/.test(q)) {
    const [project] = await db
      .select({ keyPrefix: schema.projects.keyPrefix })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1)
    if (!project) return null
    key = `${project.keyPrefix}-${q}`
  }
  if (!key) return null
  const conditions = cardFilterConditions(db, projectId, filters)
  conditions.push(ilike(schema.cards.key, key))
  const [row] = await db
    .select({ id: schema.cards.id })
    .from(schema.cards)
    .where(and(...conditions))
    .limit(1)
  return row?.id ?? null
}

/**
 * Prepend the exact-key match (deduping it from wherever else it ranked), then
 * paginate the full ordered id list and load the page rows in order. The pin is
 * applied AFTER ordering and BEFORE pagination, so it only ever lands on the
 * first page.
 */
async function pinnedPage(
  db: Database,
  orderedIds: string[],
  pinnedId: string | null,
  filters: CardFilters,
  tsQuery: SQL,
  param?: string
) {
  const ids = pinnedId
    ? [pinnedId, ...orderedIds.filter(id => id !== pinnedId)]
    : orderedIds
  const start = filters.offset ?? 0
  const pageIds = ids.slice(start, start + (filters.limit ?? 50))
  if (pageIds.length === 0) return []
  const rows = await db
    .select(cardSummaryColumns)
    .from(schema.cards)
    .where(inArray(schema.cards.id, pageIds))
  const byId = new Map(rows.map(r => [r.id, r]))
  const orderedRows = pageIds
    .map(id => byId.get(id))
    .filter((row): row is (typeof rows)[number] => row !== undefined)
  return withMatchedComments(db, orderedRows, tsQuery, param)
}

/**
 * Hybrid search over cards AND their comments. The lexical ranking (card/comment
 * FTS + substring/typo + `-exclude`, unchanged from CO-239) is fused by RRF with a
 * vector KNN — a card's vector distance OR its nearest comment's, whichever is
 * closer. A card surfaces by its own semantic signal or any comment's; the matched
 * comment snippet (lexical) is kept. Degrades to lexical-only when the query can't
 * be embedded. Reuses the focused-read filters (status/sprint/tag/archived).
 * Read-only — it never marks comments as read.
 */
export async function searchCards(
  db: Database,
  projectId: string,
  query: string,
  filters: CardFilters = {}
) {
  // Without this, an empty query degenerates into ILIKE '%%' (matches every card).
  const q = query.trim()
  if (!q) return []
  // OR-recall between terms: a card matches on ANY term, not all of them.
  const tsQuery = orTsQuery(q)
  // `-exclude` guard on the card's own text, across every recall branch. No-op
  // without negation.
  const excluded = excludedTsQuery(q)
  const term = `%${q}%`
  const cardRank = sql<number>`ts_rank(${schema.cards.searchTsv}, ${tsQuery})`
  const commentRank = sql<number>`coalesce((
    select max(ts_rank(c.body_tsv, ${tsQuery}))
    from comments c
    where c.card_id = ${schema.cards.id} and c.body_tsv @@ ${tsQuery}
  ), 0)`
  const trgmSim = sql<number>`greatest(
    word_similarity(${q}, ${schema.cards.title}),
    word_similarity(${q}, coalesce(${schema.cards.summary}, '')),
    word_similarity(${q}, coalesce(${schema.cards.descriptionMd}, ''))
  )`
  // Full-text rank (best of card / comment) is the primary sort; trigram is only
  // a tie-breaker, so a real full-text hit never loses to a pure typo match.
  const rank = sql<number>`greatest(${cardRank}, ${commentRank})`

  const match = or(
    sql`${schema.cards.searchTsv} @@ ${tsQuery}`,
    sql`exists (
      select 1 from comments c
      where c.card_id = ${schema.cards.id} and c.body_tsv @@ ${tsQuery}
    )`,
    ilike(schema.cards.title, term),
    ilike(schema.cards.summary, term),
    ilike(schema.cards.key, term),
    ilike(schema.cards.descriptionMd, term),
    sql`${q} <% ${schema.cards.title}`,
    sql`${q} <% coalesce(${schema.cards.summary}, '')`,
    sql`${q} <% coalesce(${schema.cards.descriptionMd}, '')`
  )

  const notExcluded = sql`not (${schema.cards.searchTsv} @@ ${excluded})`
  const lexicalConditions = cardFilterConditions(db, projectId, filters)
  if (match) lexicalConditions.push(match)
  lexicalConditions.push(notExcluded)
  const lexicalOrder = [desc(rank), desc(trgmSim), desc(schema.cards.updatedAt)]

  const [queryVec, pinnedId] = await Promise.all([
    embed(q, 'query'),
    exactKeyMatchId(db, projectId, q, filters)
  ])
  // Lexical-only (model off/unavailable): the original ranking, with the
  // exact-key pin applied before pagination.
  if (!queryVec) {
    const start = filters.offset ?? 0
    const lexRows = await db
      .select({ id: schema.cards.id })
      .from(schema.cards)
      .where(and(...lexicalConditions))
      .orderBy(...lexicalOrder)
      .limit(start + (filters.limit ?? 50) + 1)
    return pinnedPage(db, lexRows.map(r => r.id), pinnedId, filters, tsQuery)
  }

  // Hybrid: bounded lexical pool ⊕ vector top-K (card OR comment KNN), fused by RRF.
  const lexRows = await db
    .select({ id: schema.cards.id })
    .from(schema.cards)
    .where(and(...lexicalConditions))
    .orderBy(...lexicalOrder)
    .limit(LEXICAL_POOL)

  const param = toVectorParam(queryVec)
  const vectorConditions = cardFilterConditions(db, projectId, filters)
  vectorConditions.push(notExcluded)
  vectorConditions.push(sql`(
    exists (select 1 from card_chunks cc where cc.card_id = ${schema.cards.id})
    or exists (
      select 1 from comment_chunks cm
      join comments c on c.id = cm.comment_id
      where c.card_id = ${schema.cards.id}
    )
  )`)
  // Best (smallest) cosine distance over the card's own chunks OR any of its
  // comments' chunks — coalesce a missing side to 2 (max) so it never wins.
  const dist = sql<number>`least(
    coalesce((
      select min(cc.embedding <=> ${param}::vector)
      from card_chunks cc where cc.card_id = ${schema.cards.id}
    ), 2),
    coalesce((
      select min(cm.embedding <=> ${param}::vector)
      from comment_chunks cm
      join comments c on c.id = cm.comment_id
      where c.card_id = ${schema.cards.id}
    ), 2)
  )`
  const vecRows = await db
    .select({ id: schema.cards.id })
    .from(schema.cards)
    .where(and(...vectorConditions))
    .orderBy(dist)
    .limit(vectorK())

  const ordered = hybridOrder(
    lexRows.map(r => r.id),
    vecRows.map(r => r.id)
  )
  return pinnedPage(db, ordered, pinnedId, filters, tsQuery, param)
}

/** Best-ranked matching comment per card, with a highlighted snippet. */
async function matchedCommentSnippets(
  db: Database,
  cardIds: string[],
  tsQuery: SQL
): Promise<Map<string, MatchedComment>> {
  const map = new Map<string, MatchedComment>()
  if (cardIds.length === 0) return map
  const rows = await db
    .select({
      cardId: schema.comments.cardId,
      id: schema.comments.id,
      snippet: sql<string>`ts_headline('simple', ${schema.comments.bodyMd}, ${tsQuery}, ${SNIPPET_OPTS})`
    })
    .from(schema.comments)
    .where(
      and(
        inArray(schema.comments.cardId, cardIds),
        sql`${schema.comments.bodyTsv} @@ ${tsQuery}`
      )
    )
    .orderBy(desc(sql`ts_rank(${schema.comments.bodyTsv}, ${tsQuery})`))
  for (const r of rows) {
    if (!map.has(r.cardId)) {
      map.set(r.cardId, { commentId: r.id, snippet: r.snippet })
    }
  }
  return map
}

/**
 * Nearest comment per card by cosine distance to the query vector, with a snippet.
 * Used for cards matched only via a comment's semantic signal (no lexical comment
 * hit) — `ts_headline` then returns the comment's leading fragment (no highlight).
 */
async function nearestCommentSnippets(
  db: Database,
  cardIds: string[],
  param: string,
  tsQuery: SQL
): Promise<Map<string, MatchedComment>> {
  const map = new Map<string, MatchedComment>()
  if (cardIds.length === 0) return map
  const rows = await db
    .selectDistinctOn([schema.comments.cardId], {
      cardId: schema.comments.cardId,
      id: schema.comments.id,
      snippet: sql<string>`ts_headline('simple', ${schema.comments.bodyMd}, ${tsQuery}, ${SNIPPET_OPTS})`
    })
    .from(schema.comments)
    .where(
      and(
        inArray(schema.comments.cardId, cardIds),
        sql`exists (select 1 from comment_chunks cm where cm.comment_id = ${schema.comments.id})`
      )
    )
    .orderBy(
      schema.comments.cardId,
      sql`(select min(cm.embedding <=> ${param}::vector) from comment_chunks cm where cm.comment_id = ${schema.comments.id})`
    )
  for (const r of rows) {
    map.set(r.cardId, { commentId: r.id, snippet: r.snippet })
  }
  return map
}

const cardContentColumns = {
  id: schema.cards.id,
  key: schema.cards.key,
  title: schema.cards.title,
  summary: schema.cards.summary,
  descriptionMd: schema.cards.descriptionMd
}

/** Backfill chunks for cards that have none yet. See `backfillChunks`. */
export function backfillCardEmbeddings(db: Database, batchSize = 50): Promise<number> {
  return backfillChunks(
    batchSize,
    async (limit, afterId) => {
      const rows = await db
        .select(cardContentColumns)
        .from(schema.cards)
        .where(
          and(
            sql`not exists (select 1 from card_chunks where card_id = ${schema.cards.id})`,
            afterId ? gt(schema.cards.id, afterId) : undefined
          )
        )
        .orderBy(asc(schema.cards.id))
        .limit(limit)
      return rows.map(r => ({ id: r.id, text: cardContentText(r) }))
    },
    embedChunks,
    (id, vectors) =>
      db.insert(schema.cardChunks).values(vectors.map((embedding, idx) => ({ cardId: id, idx, embedding }))),
    async (id) => {
      const [row] = await db.select(cardContentColumns).from(schema.cards).where(eq(schema.cards.id, id))
      return row ? cardContentText(row) : null
    }
  )
}

export async function getCard(db: Database, id: string) {
  const [row] = await db
    .select(cardDetailColumns)
    .from(schema.cards)
    .where(eq(schema.cards.id, id))
    .limit(1)
  if (!row) return null
  return enrichCard(db, row)
}

export async function getCardByKey(db: Database, key: string) {
  const [row] = await db
    .select(cardDetailColumns)
    .from(schema.cards)
    .where(eq(schema.cards.key, key))
    .limit(1)
  if (!row) return null
  return enrichCard(db, row)
}

/**
 * Batch read of full cards (with `descriptionMd`) by id or key — a ref matches
 * either column, so callers can mix `crd_*` ids and `CO-*` keys freely (the two
 * prefixes never collide). Reuses `enrichCardRows`, so it's one round of
 * relation queries for the whole batch instead of N× `getCard`.
 */
export async function getCardsByIds(
  db: Database,
  refs: string[],
  offset?: number
) {
  if (refs.length === 0) return []
  const rows = await paginate(
    db
      .select(cardDetailColumns)
      .from(schema.cards)
      .where(or(inArray(schema.cards.id, refs), inArray(schema.cards.key, refs)))
      .orderBy(asc(schema.cards.position), desc(schema.cards.createdAt))
      .$dynamic(),
    undefined,
    offset
  )
  return enrichCardRows(db, rows)
}

export async function createCard(db: Database, input: CreateCardInput) {
  const parsed = createCardInput.parse(input)
  if (parsed.parentId) {
    await assertParentIsTopLevel(db, parsed.parentId)
  }
  const row = await db.transaction(async (tx) => {
    const [project] = await tx
      .update(schema.projects)
      .set({ nextKeySeq: sql`${schema.projects.nextKeySeq} + 1` })
      .where(eq(schema.projects.id, parsed.projectId))
      .returning({
        keyPrefix: schema.projects.keyPrefix,
        nextSeq: schema.projects.nextKeySeq
      })
    if (!project) {
      throw new InputError(`Project ${parsed.projectId} not found`)
    }
    const cardKey = `${project.keyPrefix}-${project.nextSeq - 1}`
    const [created] = await tx
      .insert(schema.cards)
      .values({
        id: createId('crd'),
        projectId: parsed.projectId,
        sprintId: parsed.sprintId,
        parentId: parsed.parentId,
        key: cardKey,
        title: parsed.title,
        summary: parsed.summary,
        descriptionMd: parsed.descriptionMd,
        // A card with no sprint lands in the backlog (its own status); one
        // created straight into a sprint starts on the board instead.
        status: parsed.status ?? (parsed.sprintId ? 'todo' : 'backlog'),
        // Keep the "a done card carries a doneAt" invariant the auto-hide relies
        // on even for the rare card created straight into done.
        doneAt: parsed.status === 'done' ? sql`now()` : null,
        priority: parsed.priority ?? 0,
        dueDate: parsed.dueDate
      })
      .returning(cardDetailColumns)
    if (created) {
      await reconcileAttachmentLinks(tx, 'card', created.id, parsed.descriptionMd)
      if (parsed.tagIds?.length) {
        const wanted = [...new Set(parsed.tagIds)]
        const found = await tx
          .select({ id: schema.tags.id })
          .from(schema.tags)
          .where(
            and(
              eq(schema.tags.projectId, parsed.projectId),
              inArray(schema.tags.id, wanted)
            )
          )
        // throw inside the txn rolls back the card too — no half-tagged card.
        if (found.length !== wanted.length) {
          const ok = new Set(found.map(t => t.id))
          const missing = wanted.filter(id => !ok.has(id))
          throw new InputError(
            `tagIds not found in project ${parsed.projectId}: ${missing.join(', ')}`
          )
        }
        await tx
          .insert(schema.cardTags)
          .values(wanted.map(tagId => ({ cardId: created.id, tagId })))
          .onConflictDoNothing()
      }
    }
    return created
  })
  if (row) {
    // Chunk after insert: the content text includes the key, generated in the txn.
    await writeCardChunks(db, row.id, await embedChunks(cardContentText(row)))
    await notify(db, {
      type: 'card.changed',
      projectId: row.projectId,
      cardId: row.id,
      cardKey: row.key
    })
  }
  return row
}

/** Replace a card's chunk rows with `vectors` (no-op when embeddings are off). */
function writeCardChunks(db: Database, cardId: string, vectors: number[][] | null) {
  return applyChunks(
    db,
    vectors,
    (tx, fromIdx) =>
      tx
        .delete(schema.cardChunks)
        .where(and(eq(schema.cardChunks.cardId, cardId), gte(schema.cardChunks.idx, fromIdx))),
    (tx, rows) =>
      tx
        .insert(schema.cardChunks)
        .values(rows.map(r => ({ cardId, idx: r.idx, embedding: r.embedding })))
        .onConflictDoUpdate({
          target: [schema.cardChunks.cardId, schema.cardChunks.idx],
          set: { embedding: sql`excluded.embedding` }
        })
  )
}

export async function updateCard(db: Database, input: UpdateCardInput) {
  const parsed = updateCardInput.parse(input)
  const { id, ...rest } = parsed
  if (rest.parentId != null) {
    await assertValidParent(db, id, rest.parentId)
  }
  const [row] = await db.transaction(async (tx) => {
    const set: Record<string, unknown> = { ...rest, updatedAt: sql`now()` }
    if (rest.status !== undefined) set.doneAt = doneAtWrite(rest.status)
    const updated = await tx
      .update(schema.cards)
      .set(set)
      .where(eq(schema.cards.id, id))
      .returning(cardDetailColumns)
    // Auto-release the claim atomically with the status write (a done card never
    // stays reserved), mirroring the reorder path.
    if (updated[0] && rest.status === 'done') {
      await releaseClaimOnDone(tx, updated[0].id)
    }
    if (updated[0] && rest.descriptionMd !== undefined)
      await reconcileAttachmentLinks(tx, 'card', updated[0].id, rest.descriptionMd)
    return updated
  })
  if (row) {
    // Re-chunk only when an embedded field changed; a transient failure (null)
    // keeps the valid vectors — handled inside writeCardChunks.
    if (rest.title !== undefined || rest.summary !== undefined || rest.descriptionMd !== undefined) {
      await writeCardChunks(db, row.id, await embedChunks(cardContentText(row)))
    }
    await notify(db, {
      type: 'card.changed',
      projectId: row.projectId,
      cardId: row.id,
      cardKey: row.key
    })
  }
  return row ?? null
}

/**
 * Persist a column's order: write `position = index` for `orderedIds`. If a card
 * changed columns (`moved`), apply its new status (and sprintId when provided)
 * in the same transaction. Emits a single card.changed (for the moved card, or
 * the first reordered one) so other clients refresh.
 */
export async function reorderCards(db: Database, input: ReorderCardsInput) {
  const { orderedIds, moved } = reorderCardsInput.parse(input)
  const row = await db.transaction(async (tx) => {
    if (moved) {
      const set: Record<string, unknown> = {
        status: moved.status,
        updatedAt: sql`now()`,
        doneAt: doneAtWrite(moved.status)
      }
      if (moved.sprintId !== undefined) set.sprintId = moved.sprintId
      await tx.update(schema.cards).set(set).where(eq(schema.cards.id, moved.id))
      if (moved.status === 'done') await releaseClaimOnDone(tx, moved.id)
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(schema.cards)
        .set({ position: i })
        .where(eq(schema.cards.id, orderedIds[i]!))
    }
    const probeId = moved?.id ?? orderedIds[0]
    if (!probeId) return null
    const [c] = await tx
      .select({
        id: schema.cards.id,
        projectId: schema.cards.projectId,
        key: schema.cards.key
      })
      .from(schema.cards)
      .where(eq(schema.cards.id, probeId))
      .limit(1)
    return c ?? null
  })
  if (row) {
    await notify(db, {
      type: 'card.changed',
      projectId: row.projectId,
      cardId: row.id,
      cardKey: row.key
    })
  }
  return row
}

export async function moveCardToBacklog(db: Database, cardId: string) {
  return updateCard(db, { id: cardId, sprintId: null })
}

export async function moveCardToSprint(
  db: Database,
  cardId: string,
  sprintId: string
) {
  return updateCard(db, { id: cardId, sprintId })
}

// --- Archive / restore / destroy ---

export async function archiveCard(db: Database, id: string) {
  const [row] = await db
    .update(schema.cards)
    .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(schema.cards.id, id))
    .returning(cardDetailColumns)
  if (row) {
    // Default: free the heavy diff blobs, keep the commit metadata (hash,
    // message, stat…); restoring does NOT bring the diff back — re-run
    // attach-commit. With keepDiffsOnArchive on, the blobs are preserved.
    const { keepDiffsOnArchive } = await getSystemSettings(db)
    if (!keepDiffsOnArchive) {
      await db
        .update(schema.cardCommits)
        .set({ diff: null })
        .where(eq(schema.cardCommits.cardId, id))
    }
    await gcAttachmentsOnArchive(db, { projectId: row.projectId, cardIds: [id] })
    await syncIntakeForCard(db, row.projectId, row.key)
    await notify(db, {
      type: 'card.changed',
      projectId: row.projectId,
      cardId: row.id,
      cardKey: row.key
    })
  }
  return row ?? null
}

export async function restoreCard(db: Database, id: string) {
  const [row] = await db
    .update(schema.cards)
    .set({ archivedAt: null, updatedAt: sql`now()` })
    .where(eq(schema.cards.id, id))
    .returning(cardDetailColumns)
  if (row) {
    // Archive removed this card's links; re-establish them from the live body so
    // the derived index doesn't drift (and the sweep can't collect an image the
    // restored card still references). Bytes stay null — restore never recovers them.
    await relinkCardsAndComments(db, [id])
    await relinkCommitImages(db, [id])
    await syncIntakeForCard(db, row.projectId, row.key)
    await notify(db, {
      type: 'card.changed',
      projectId: row.projectId,
      cardId: row.id,
      cardKey: row.key
    })
  }
  return row ?? null
}

/**
 * Hard-delete a card. Comments, tags and blocker links cascade via FK.
 * Sub-tasks reference their parent with `set null`, so they are deleted
 * explicitly here (hierarchy is one level deep).
 */
export async function destroyCard(db: Database, id: string) {
  const result = await db.transaction(async (tx) => {
    const [card] = await tx
      .select({
        id: schema.cards.id,
        projectId: schema.cards.projectId,
        key: schema.cards.key
      })
      .from(schema.cards)
      .where(eq(schema.cards.id, id))
      .limit(1)
    if (!card) return null
    const subs = await tx
      .select({ id: schema.cards.id, key: schema.cards.key })
      .from(schema.cards)
      .where(eq(schema.cards.parentId, id))
    await gcAttachmentsOnDestroy(tx, {
      projectId: card.projectId,
      cardIds: [card.id, ...subs.map(s => s.id)]
    })
    await tx.delete(schema.cards).where(eq(schema.cards.parentId, id))
    await tx.delete(schema.cards).where(eq(schema.cards.id, id))
    return { card, keys: [card.key, ...subs.map(s => s.key)] }
  })
  if (result) {
    await pruneIntakeForDestroyedCards(db, result.card.projectId, result.keys)
    await notify(db, {
      type: 'card.deleted',
      projectId: result.card.projectId,
      cardId: result.card.id
    })
  }
  return result?.card ?? null
}

// --- Hierarchy (parent story / sub-tasks) ---

const subtaskColumns = {
  id: schema.cards.id,
  key: schema.cards.key,
  title: schema.cards.title,
  status: schema.cards.status,
  priority: schema.cards.priority
}

export async function listSubtasks(db: Database, parentId: string) {
  const rows = await db
    .select(subtaskColumns)
    .from(schema.cards)
    .where(eq(schema.cards.parentId, parentId))
    .orderBy(asc(schema.cards.position), asc(schema.cards.key))
  // Hydrate each subtask's tags in one batch query (no N+1).
  const tagMap = await tagsByCardIds(db, rows.map(r => r.id))
  return rows.map(r => ({ ...r, tags: tagMap.get(r.id) ?? [] }))
}

async function enrichCard<T extends { id: string, parentId: string | null }>(
  db: Database,
  row: T
) {
  const [tags, subtasks, parent, blockedBy, blocking, claim] = await Promise.all([
    listCardTags(db, row.id),
    listSubtasks(db, row.id),
    row.parentId
      ? db
          .select({
            id: schema.cards.id,
            key: schema.cards.key,
            title: schema.cards.title,
            status: schema.cards.status
          })
          .from(schema.cards)
          .where(eq(schema.cards.id, row.parentId))
          .limit(1)
          .then(r => r[0] ?? null)
      : Promise.resolve(null),
    listBlockedBy(db, row.id),
    listBlocking(db, row.id),
    getClaim(db, row.id)
  ])
  return {
    ...row,
    tags,
    subtasks,
    parent,
    blockedBy,
    blocking,
    claim: claim ? { ownerLabel: claim.ownerLabel, claimedAt: claim.claimedAt } : null
  }
}

async function assertParentIsTopLevel(db: Database, parentId: string) {
  const [parent] = await db
    .select({ parentId: schema.cards.parentId })
    .from(schema.cards)
    .where(eq(schema.cards.id, parentId))
    .limit(1)
  if (!parent) throw new InputError(`Parent card ${parentId} not found`)
  if (parent.parentId) {
    throw new InputError('Cannot nest under a card that is already a sub-task')
  }
}

async function assertValidParent(
  db: Database,
  childId: string,
  parentId: string
) {
  if (parentId === childId) {
    throw new InputError('A card cannot be its own parent')
  }
  await assertParentIsTopLevel(db, parentId)
  const [childCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.cards)
    .where(eq(schema.cards.parentId, childId))
  if (childCount && childCount.count > 0) {
    throw new InputError('A card with sub-tasks cannot become a sub-task itself')
  }
}

async function subtaskCounts(db: Database, parentIds: string[]) {
  const map = new Map<string, { total: number, done: number }>()
  if (parentIds.length === 0) return map
  const rows = await db
    .select({
      parentId: schema.cards.parentId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${schema.cards.status} = 'done')::int`
    })
    .from(schema.cards)
    .where(inArray(schema.cards.parentId, parentIds))
    .groupBy(schema.cards.parentId)
  for (const r of rows) {
    if (r.parentId) map.set(r.parentId, { total: r.total, done: r.done })
  }
  return map
}

async function parentKeysFor(
  db: Database,
  rows: { parentId: string | null }[]
) {
  const map = new Map<string, string>()
  const parentIds = [
    ...new Set(
      rows.map(r => r.parentId).filter((p): p is string => p !== null)
    )
  ]
  if (parentIds.length === 0) return map
  const parents = await db
    .select({ id: schema.cards.id, key: schema.cards.key })
    .from(schema.cards)
    .where(inArray(schema.cards.id, parentIds))
  for (const p of parents) map.set(p.id, p.key)
  return map
}
