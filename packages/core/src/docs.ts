import { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'

import { createId, type Database, schema } from '@agents-board/db'

import type { ArchiveFilter } from './archive'
import { gcAttachmentsOnDestroy } from './attachmentGc'
import { reconcileAttachmentLinks } from './attachmentLinks'
import { applyChunks, backfillChunks, embed, embedChunks } from './embedding'
import { notify } from './events'
import { paginate } from './pagination'
import { excludedTsQuery, hybridOrder, LEXICAL_POOL, orTsQuery, toVectorParam, vectorK } from './search'

const docKind = z.enum(['module', 'adr', 'guide', 'note'])

export const createDocInput = z.object({
  projectId: z.string(),
  parentId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  summary: z.string().max(200).optional(),
  bodyMd: z.string().optional(),
  kind: docKind.optional(),
  position: z.number().int().min(0).optional()
})
export type CreateDocInput = z.infer<typeof createDocInput>

export const updateDocInput = z.object({
  id: z.string(),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(200).nullable().optional(),
  bodyMd: z.string().nullable().optional(),
  kind: docKind.optional(),
  parentId: z.string().nullable().optional(),
  position: z.number().int().min(0).optional()
})
export type UpdateDocInput = z.infer<typeof updateDocInput>

const docListColumns = {
  id: schema.docs.id,
  projectId: schema.docs.projectId,
  parentId: schema.docs.parentId,
  title: schema.docs.title,
  summary: schema.docs.summary,
  kind: schema.docs.kind,
  position: schema.docs.position,
  createdAt: schema.docs.createdAt,
  updatedAt: schema.docs.updatedAt
}

// Allow-list, not a bare select: bodyTsv can't leak into read_doc or a doc
// mutation return.
const docDetailColumns = {
  ...docListColumns,
  bodyMd: schema.docs.bodyMd
}

export async function listDocs(
  db: Database,
  projectId: string,
  kind?: z.infer<typeof docKind>,
  filter?: ArchiveFilter,
  limit?: number,
  offset?: number
) {
  const conditions = [eq(schema.docs.projectId, projectId)]
  if (kind) conditions.push(eq(schema.docs.kind, kind))
  if (filter?.archivedOnly) {
    conditions.push(isNotNull(schema.docs.archivedAt))
  } else if (!filter?.includeArchived) {
    // Hide archived docs AND their descendants: a child "travels" with an
    // archived parent even though it isn't marked archived itself.
    const hidden = await archivedDocSubtreeIds(db, projectId)
    if (hidden.length > 0) {
      conditions.push(notInArray(schema.docs.id, hidden))
    }
  }
  return paginate(
    db
      .select(docListColumns)
      .from(schema.docs)
      .where(and(...conditions))
      .orderBy(asc(schema.docs.position), asc(schema.docs.title))
      .$dynamic(),
    limit,
    offset
  )
}

/** Ids of every doc that is archived or descends from an archived doc. */
async function archivedDocSubtreeIds(
  db: Database,
  projectId: string
): Promise<string[]> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE archived_tree AS (
      SELECT id FROM docs
      WHERE project_id = ${projectId} AND archived_at IS NOT NULL
      UNION ALL
      SELECT d.id FROM docs d
      JOIN archived_tree a ON d.parent_id = a.id
    )
    SELECT id FROM archived_tree
  `)) as unknown as Array<{ id: string }>
  return rows.map(r => r.id)
}

/** Text embedded for semantic search — title + summary + body (e5 `passage:`). */
function docContentText(d: {
  title: string
  summary?: string | null
  bodyMd?: string | null
}): string {
  return [d.title, d.summary, d.bodyMd].filter(Boolean).join('\n')
}

export async function getDoc(db: Database, id: string) {
  const [row] = await db
    .select(docDetailColumns)
    .from(schema.docs)
    .where(eq(schema.docs.id, id))
    .limit(1)
  return row ?? null
}

export async function createDoc(db: Database, input: CreateDocInput) {
  const parsed = createDocInput.parse(input)
  const vectors = await embedChunks(docContentText(parsed))
  const [row] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.docs)
      .values({
        id: createId('doc'),
        projectId: parsed.projectId,
        parentId: parsed.parentId ?? null,
        title: parsed.title,
        summary: parsed.summary,
        bodyMd: parsed.bodyMd,
        kind: parsed.kind ?? 'note',
        position: parsed.position ?? 0
      })
      .returning(docDetailColumns)
    if (inserted[0])
      await reconcileAttachmentLinks(tx, 'doc', inserted[0].id, parsed.bodyMd)
    return inserted
  })
  if (row) {
    await writeDocChunks(db, row.id, vectors)
    await notify(db, { type: 'doc.changed', projectId: row.projectId, docId: row.id })
  }
  return row
}

/** Replace a doc's chunk rows with `vectors` (no-op when embeddings are off). */
function writeDocChunks(db: Database, docId: string, vectors: number[][] | null) {
  return applyChunks(
    db,
    vectors,
    (tx, fromIdx) =>
      tx
        .delete(schema.docChunks)
        .where(and(eq(schema.docChunks.docId, docId), gte(schema.docChunks.idx, fromIdx))),
    (tx, rows) =>
      tx
        .insert(schema.docChunks)
        .values(rows.map(r => ({ docId, idx: r.idx, embedding: r.embedding })))
        .onConflictDoUpdate({
          target: [schema.docChunks.docId, schema.docChunks.idx],
          set: { embedding: sql`excluded.embedding` }
        })
  )
}

export async function updateDoc(db: Database, input: UpdateDocInput) {
  const parsed = updateDocInput.parse(input)
  const { id, ...rest } = parsed
  const [row] = await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.docs)
      .set({ ...rest, updatedAt: sql`now()` })
      .where(eq(schema.docs.id, id))
      .returning(docDetailColumns)
    if (updated[0] && rest.bodyMd !== undefined)
      await reconcileAttachmentLinks(tx, 'doc', updated[0].id, rest.bodyMd)
    return updated
  })
  if (row) {
    // Re-chunk off the merged row (the patch is partial) only when an embedded
    // field changed; a metadata-only edit keeps the existing chunks. A transient
    // failure (null) keeps the valid vectors — handled inside writeDocChunks.
    if (rest.title !== undefined || rest.summary !== undefined || rest.bodyMd !== undefined) {
      await writeDocChunks(db, id, await embedChunks(docContentText(row)))
    }
    await notify(db, { type: 'doc.changed', projectId: row.projectId, docId: row.id })
  }
  return row ?? null
}

// --- Archive / restore / destroy ---

export async function archiveDoc(db: Database, id: string) {
  const [row] = await db
    .update(schema.docs)
    .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(schema.docs.id, id))
    .returning(docDetailColumns)
  if (row) {
    await notify(db, { type: 'doc.changed', projectId: row.projectId, docId: row.id })
  }
  return row ?? null
}

export async function restoreDoc(db: Database, id: string) {
  const [row] = await db
    .update(schema.docs)
    .set({ archivedAt: null, updatedAt: sql`now()` })
    .where(eq(schema.docs.id, id))
    .returning(docDetailColumns)
  if (row) {
    await notify(db, { type: 'doc.changed', projectId: row.projectId, docId: row.id })
  }
  return row ?? null
}

/** Hard-delete a doc and its descendants (children cascade via FK). */
export async function destroyDoc(db: Database, id: string) {
  const row = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ id: schema.docs.id, projectId: schema.docs.projectId })
      .from(schema.docs)
      .where(eq(schema.docs.id, id))
      .limit(1)
    if (!doc) return null

    // The whole subtree is destroyed by the FK cascade; gather its ids first so
    // the attachment GC can match every doc-owned anexo, not just the root's.
    const docIds: string[] = []
    let frontier = [id]
    while (frontier.length) {
      docIds.push(...frontier)
      const children = await tx
        .select({ id: schema.docs.id })
        .from(schema.docs)
        .where(inArray(schema.docs.parentId, frontier))
      frontier = children.map(c => c.id)
    }
    await gcAttachmentsOnDestroy(tx, { projectId: doc.projectId, docIds })

    await tx.delete(schema.docs).where(eq(schema.docs.id, id))
    return doc
  })
  if (row) {
    await notify(db, {
      type: 'doc.deleted',
      projectId: row.projectId,
      docId: row.id
    })
  }
  return row ?? null
}

/**
 * Hybrid search over docs: the lexical ranking (FTS + substring/typo recall +
 * `-exclude`, unchanged from CO-239) fused by RRF with a vector KNN (cosine) over
 * the doc embedding. A query with no lexical overlap still recovers the doc via
 * the vector signal; exact lexical queries keep their ranking. Degrades to
 * lexical-only when the query can't be embedded (model off/unavailable). Returns
 * the same `docListColumns` rows, paginated.
 */
export async function searchDocs(
  db: Database,
  projectId: string,
  query: string,
  opts: { includeArchived?: boolean, limit?: number, offset?: number } = {}
) {
  const { includeArchived = false, limit, offset } = opts
  // Without this, a whitespace-only query degenerates into ILIKE '%   %' (matches all).
  const q = query.trim()
  if (!q) return []
  // Mirror listDocs: archived docs (and their subtree) are out of search unless
  // the caller opts in — without this they'd leak into every search result.
  const hidden = includeArchived ? [] : await archivedDocSubtreeIds(db, projectId)
  const notArchived = hidden.length > 0 ? notInArray(schema.docs.id, hidden) : undefined
  // OR-recall between terms (a doc matches on ANY term); `-exclude` guard drops
  // negated terms across every recall branch. No-op when the query has no negation.
  const tsQuery = orTsQuery(q)
  const excluded = excludedTsQuery(q)
  const rank = sql<number>`ts_rank(${schema.docs.bodyTsv}, ${tsQuery})`
  // FTS `simple` matches whole tokens only; ILIKE covers substring/prefix and
  // pg_trgm `<%` (word-similarity) covers typos — both over title/summary/body.
  // ts_rank stays primary; the trigram similarity is only a tie-breaker.
  const trgmSim = sql<number>`greatest(
    word_similarity(${q}, ${schema.docs.title}),
    word_similarity(${q}, coalesce(${schema.docs.summary}, '')),
    word_similarity(${q}, coalesce(${schema.docs.bodyMd}, ''))
  )`
  const term = `%${q}%`
  const notExcluded = sql`not (${schema.docs.bodyTsv} @@ ${excluded})`
  const lexicalWhere = and(
    eq(schema.docs.projectId, projectId),
    or(
      sql`${schema.docs.bodyTsv} @@ ${tsQuery}`,
      ilike(schema.docs.title, term),
      ilike(schema.docs.summary, term),
      ilike(schema.docs.bodyMd, term),
      sql`${q} <% ${schema.docs.title}`,
      sql`${q} <% coalesce(${schema.docs.summary}, '')`,
      sql`${q} <% coalesce(${schema.docs.bodyMd}, '')`
    ),
    notExcluded,
    notArchived
  )
  const lexicalOrder = [desc(rank), desc(trgmSim), desc(schema.docs.updatedAt)]

  const queryVec = await embed(q, 'query')
  // Lexical-only fallback (model off/unavailable): keep the original uncapped,
  // directly-paginated contract — no candidate pool, no re-fetch.
  if (!queryVec) {
    return paginate(
      db
        .select(docListColumns)
        .from(schema.docs)
        .where(lexicalWhere)
        .orderBy(...lexicalOrder)
        .$dynamic(),
      limit,
      offset
    )
  }

  // Hybrid: bounded lexical pool ⊕ vector top-K (cosine KNN), fused by RRF.
  const lexicalRows = await db
    .select({ id: schema.docs.id })
    .from(schema.docs)
    .where(lexicalWhere)
    .orderBy(...lexicalOrder)
    .limit(LEXICAL_POOL)
  const param = toVectorParam(queryVec)
  // A doc's vector distance is the MIN over its chunks (long bodies span several);
  // candidates are docs that have at least one chunk.
  const chunkDist = sql`(
    select min(dc.embedding <=> ${param}::vector)
    from doc_chunks dc where dc.doc_id = ${schema.docs.id}
  )`
  const vecRows = await db
    .select({ id: schema.docs.id })
    .from(schema.docs)
    .where(
      and(
        eq(schema.docs.projectId, projectId),
        sql`exists (select 1 from doc_chunks dc where dc.doc_id = ${schema.docs.id})`,
        notExcluded,
        notArchived
      )
    )
    .orderBy(chunkDist)
    .limit(vectorK())

  const ordered = hybridOrder(
    lexicalRows.map(r => r.id),
    vecRows.map(r => r.id)
  )
  const start = offset ?? 0
  const pageIds = limit !== undefined ? ordered.slice(start, start + limit) : ordered.slice(start)
  if (pageIds.length === 0) return []
  const rows = await db
    .select(docListColumns)
    .from(schema.docs)
    .where(inArray(schema.docs.id, pageIds))
  const byId = new Map(rows.map(r => [r.id, r]))
  return pageIds.map(id => byId.get(id)).filter(row => row !== undefined)
}

const docContentColumns = {
  id: schema.docs.id,
  title: schema.docs.title,
  summary: schema.docs.summary,
  bodyMd: schema.docs.bodyMd
}

/** Backfill chunks for docs that have none yet. See `backfillChunks`. */
export function backfillDocEmbeddings(db: Database, batchSize = 50): Promise<number> {
  return backfillChunks(
    batchSize,
    async (limit, afterId) => {
      const rows = await db
        .select(docContentColumns)
        .from(schema.docs)
        .where(
          and(
            sql`not exists (select 1 from doc_chunks where doc_id = ${schema.docs.id})`,
            afterId ? gt(schema.docs.id, afterId) : undefined
          )
        )
        .orderBy(asc(schema.docs.id))
        .limit(limit)
      return rows.map(r => ({ id: r.id, text: docContentText(r) }))
    },
    embedChunks,
    (id, vectors) =>
      db.insert(schema.docChunks).values(vectors.map((embedding, idx) => ({ docId: id, idx, embedding }))),
    async (id) => {
      const [row] = await db.select(docContentColumns).from(schema.docs).where(eq(schema.docs.id, id))
      return row ? docContentText(row) : null
    }
  )
}
