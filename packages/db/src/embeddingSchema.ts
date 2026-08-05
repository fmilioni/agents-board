import { eq, sql } from 'drizzle-orm'

import { resolveEmbeddingConfig } from '@agents-board/shared'

import type { Database } from './client'
import { SYSTEM_SETTINGS_ID, systemSettings } from './schema/systemSettings'

const CHUNK_TABLES = ['doc_chunks', 'card_chunks', 'comment_chunks'] as const

/** Live dimension of a table's `embedding` column (pgvector stores it in
 *  `atttypmod`; -1 when unspecified, undefined when the column is absent). */
async function embeddingDim(db: Database, table: string): Promise<number | undefined> {
  const rows = (await db.execute(sql`
    select a.atttypmod as typmod
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = ${table}
      and a.attname = 'embedding'
      and n.nspname = current_schema()
      and a.attnum > 0 and not a.attisdropped
  `)) as unknown as Array<{ typmod: number }>
  return rows[0]?.typmod
}

/**
 * Reconcile the live `vector(N)` embedding storage to the configured model's
 * dimension — the per-chunk tables (doc/card/comment_chunks).
 *
 * The base migration creates them at the baseline (default model) dim; this brings
 * them to whatever `EMBEDDING_MODEL` resolves to. A dim change drops and recreates
 * the column (+ HNSW index), discarding existing embeddings — they belong to a
 * different vector space and must be re-backfilled anyway. A no-op when the dim
 * already matches (the common case, incl. tests and the default).
 *
 * The chunk column is `NOT NULL`, so its rows are truncated before the column is
 * recreated (the rows are derived and the backfill repopulates them).
 */
export async function reconcileEmbeddingDim(db: Database): Promise<void> {
  // Honor the persisted choice (read straight from the table to avoid a core
  // dependency); falls back to env/default when unset or the row doesn't exist.
  const [settings] = await db
    .select({ embeddingModel: systemSettings.embeddingModel })
    .from(systemSettings)
    .where(eq(systemSettings.id, SYSTEM_SETTINGS_ID))
    .limit(1)
  const { dim } = resolveEmbeddingConfig(undefined, settings?.embeddingModel)

  for (const table of CHUNK_TABLES) {
    if ((await embeddingDim(db, table)) === dim) continue
    // Truncate first: the column is NOT NULL, so it can't be re-added onto rows
    // that would violate it; the chunks are derived and the backfill rebuilds them.
    await db.execute(sql.raw(`TRUNCATE TABLE "${table}"`))
    await db.execute(sql.raw(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "embedding"`))
    await db.execute(
      sql.raw(`ALTER TABLE "${table}" ADD COLUMN "embedding" vector(${dim}) NOT NULL`)
    )
    await db.execute(
      sql.raw(
        `CREATE INDEX "${table}_embedding_idx" ON "${table}" USING hnsw ("embedding" vector_cosine_ops)`
      )
    )
  }
}
