import type { Database } from '@agents-board/db'

import { chunkText } from './chunking'

export type EmbeddingKind = 'query' | 'passage'

// The dedicated embedding service holds the model; this module is a thin HTTP
// client. `null` on any failure (service down, timeout, disabled) so callers fall
// back to lexical search — the same invariant as when the model failed to load.
// Env is read per call (not captured at import) so deploys/tests don't need a
// reload to change it.
async function requestEmbed(
  texts: string[],
  kind: EmbeddingKind
): Promise<number[][] | null> {
  const serviceUrl = process.env.EMBEDDING_SERVICE_URL?.trim()
  // Deploy-level disable: `EMBEDDING_MODEL=none` means the client never calls the
  // service (a runtime "none" set via the UI is handled service-side instead).
  const deployDisabled = process.env.EMBEDDING_MODEL?.trim() === 'none'
  if (deployDisabled || !serviceUrl) return null
  // Generous: covers a still-warming service and large backfill batches; a true
  // hang still falls back to lexical instead of stalling the caller forever.
  const timeoutMs = Number(process.env.EMBEDDING_TIMEOUT_MS ?? 30_000)
  try {
    const res = await fetch(`${serviceUrl}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts, kind }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { vectors?: number[][] | null }
    return data.vectors ?? null
  } catch (err) {
    console.error('[embedding] service request failed; falling back to lexical', err)
    return null
  }
}

/**
 * Embed many texts in one pass (the e5 prefix is applied service-side per `kind`).
 * Returns the unit-normalized vectors, or `null` when embeddings are
 * disabled/unavailable so callers fall back to lexical search.
 */
export async function embedMany(
  texts: string[],
  kind: EmbeddingKind
): Promise<number[][] | null> {
  if (texts.length === 0) return []
  return requestEmbed(texts, kind)
}

/** Embed a single text; `null` when embeddings are disabled/unavailable. */
export async function embed(
  text: string,
  kind: EmbeddingKind
): Promise<number[] | null> {
  const vectors = await embedMany([text], kind)
  return vectors ? (vectors[0] ?? null) : null
}

/**
 * Ask the embedding service to re-resolve the persisted config and reload its
 * pipeline (disposing the old one). Awaited by the apply so the subsequent
 * backfill embeds in the new model. Best-effort: returns `false` (never throws)
 * when the service is unreachable — the persisted choice still wins and the
 * service converges on its next boot/reload. The reload load can be slow (cold
 * download), so the timeout is generous.
 */
export async function reloadEmbeddingService(): Promise<boolean> {
  const serviceUrl = process.env.EMBEDDING_SERVICE_URL?.trim()
  if (!serviceUrl) return false
  const timeoutMs = Number(process.env.EMBEDDING_RELOAD_TIMEOUT_MS ?? 300_000)
  try {
    const res = await fetch(`${serviceUrl}/reload`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.ok
  } catch (err) {
    console.error('[embedding] service reload failed; it will converge on the persisted model', err)
    return false
  }
}

/**
 * Split content into windows and embed each as a `passage`. Returns one vector
 * per chunk (short content ⇒ a single chunk), `[]` when the content is empty, or
 * `null` when embeddings are disabled/unavailable so callers keep existing chunks
 * (a transient failure must not wipe valid vectors).
 */
export async function embedChunks(text: string): Promise<number[][] | null> {
  const chunks = chunkText(text)
  if (chunks.length === 0) return []
  return embedMany(chunks, 'passage')
}

type ChunkRows = Array<{ idx: number, embedding: number[] }>

/**
 * Persist a freshly-embedded chunk set to an entity's chunk table, honoring the
 * write invariant: `null` (embeddings off or a transient failure) keeps the
 * existing chunks untouched — never wipe valid vectors; otherwise the entity ends
 * up with exactly this version's chunks (an empty set just clears).
 *
 * Upsert-then-truncate rather than delete-then-insert: the backfill may be inserting
 * this same entity's chunks right now, and rows it commits after our delete already
 * read them would collide with a plain insert — killing the *editor's* write. Writing
 * by `(owner, idx)` and then dropping the tail beyond this version's last chunk lands
 * the same final state under every interleaving, so the editor always wins.
 * `upsert` + `truncateFrom` are the table-specific writes, run on the transaction.
 */
export async function applyChunks(
  db: Database,
  vectors: number[][] | null,
  truncateFrom: (tx: Database, fromIdx: number) => Promise<unknown>,
  upsert: (tx: Database, rows: ChunkRows) => Promise<unknown>
): Promise<void> {
  if (vectors === null) return
  await db.transaction(async (tx) => {
    if (vectors.length) {
      await upsert(tx, vectors.map((embedding, idx) => ({ idx, embedding })))
    }
    await truncateFrom(tx, vectors.length)
  })
}

/**
 * The two ways a concurrent change makes a chunk insert impossible: the rows already
 * exist (`unique_violation` — someone re-chunked the entity) or the owner is gone
 * (`foreign_key_violation` — it was deleted). Drizzle wraps the driver error, so the
 * code is looked for down the `cause` chain.
 */
function isConcurrencyConflict(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code
    if (code === '23505' || code === '23503') return true
  }
  return false
}

/**
 * Generic chunk backfill loop shared by the docs/cards/comments verticals. Pages
 * (by `id` keyset) over entities with NO chunks yet, embeds each into its windows
 * (via the caller-supplied `embedFn`, normally `embedChunks`), and stores them.
 * Idempotent across runs (it only sees entities still missing chunks); stops early
 * (returning the count so far) the moment an embed yields `null` — embeddings are
 * disabled/unavailable, so there's no point scanning the rest. The caller supplies
 * the table-specific fetch (ordered by `id`, filtered `id > afterId`) and store;
 * `embedFn` is a parameter (not called inline) so a test can substitute it.
 *
 * The keyset cursor (not a bare re-query of the candidate set) is what guarantees
 * termination: a row whose content embeds to `[]` (empty/whitespace-only) stores
 * nothing and stays in the candidate set, so re-querying it would loop forever —
 * advancing `afterId` past each batch steps over it instead.
 *
 * Embedding an entity is a slow network call, and the rest of the system stays free to
 * rewrite or delete it meanwhile — that version is newer, so it owns the chunks and the
 * backfill yields (uncounted, nothing written) instead of dying. Two ways to detect it,
 * because a rewrite doesn't always leave rows to collide with: `currentText` re-reads
 * the entity and yields when the content moved on or it's gone (a rewrite to blank
 * stores no chunks at all, so it would never collide), and a conflict from `store`
 * covers the change landing inside that last window — a unique violation rolls the whole
 * INSERT statement back on the shared `(owner, idx)` PK, never leaving a mixed set.
 */
export async function backfillChunks(
  batchSize: number,
  fetchBatch: (limit: number, afterId: string | null) => Promise<Array<{ id: string, text: string }>>,
  embedFn: (text: string) => Promise<number[][] | null>,
  store: (id: string, vectors: number[][]) => Promise<unknown>,
  currentText: (id: string) => Promise<string | null>
): Promise<number> {
  let total = 0
  let afterId: string | null = null
  for (;;) {
    const rows = await fetchBatch(batchSize, afterId)
    if (rows.length === 0) break
    for (const row of rows) {
      const vectors = await embedFn(row.text)
      if (vectors === null) return total
      if (!vectors.length) continue
      if (await currentText(row.id) !== row.text) continue
      try {
        await store(row.id, vectors)
        total++
      } catch (err) {
        if (!isConcurrencyConflict(err)) throw err
      }
    }
    afterId = rows[rows.length - 1]!.id
    if (rows.length < batchSize) break
  }
  return total
}
