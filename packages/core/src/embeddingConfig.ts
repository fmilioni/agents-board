import { eq, sql } from 'drizzle-orm'

import { type Database, schema } from '@agents-board/db'
import type { EmbeddingConfig, EmbeddingDtype } from '@agents-board/shared'
import { EMBEDDING_DTYPES, resolveEmbeddingConfig } from '@agents-board/shared'

import { getSystemSettings } from './authz'

/**
 * The embedding config the process should run with: the persisted DB choice wins
 * over `EMBEDDING_MODEL`, which wins over the default. Resolved with a db handle
 * (the embedding service reads it at boot/reload; the apply reads it to decide a
 * dim reconcile) — `embed()` itself is a process-global HTTP client with no db.
 */
export async function resolveEffectiveEmbeddingConfig(
  db: Database
): Promise<EmbeddingConfig> {
  const { embeddingModel, embeddingDtype } = await getSystemSettings(db)
  return resolveEmbeddingConfig(undefined, embeddingModel, embeddingDtype)
}

/**
 * Record the model/dim/dtype a long-lived process actually loaded, so the live
 * status can tell whether it still matches the persisted choice (it can't reset
 * its own singleton mid-run). Call after priming, once per boot.
 */
export async function recordRuntimeEmbeddingConfig(
  db: Database,
  service: string,
  cfg: EmbeddingConfig
): Promise<void> {
  // A disabled config loads no pipeline, so the dtype it would have used is moot
  // — record null to match `model`, keeping serviceDtype honest about "no model".
  const dtype = cfg.model ? cfg.dtype : null
  await db
    .insert(schema.embeddingRuntime)
    .values({ service, model: cfg.model, dim: cfg.dim, dtype })
    .onConflictDoUpdate({
      target: schema.embeddingRuntime.service,
      set: { model: cfg.model, dim: cfg.dim, dtype, updatedAt: sql`now()` }
    })
}

/** The model/dim/dtype a process last recorded loading, or null if it never recorded. */
export async function getRuntimeEmbeddingConfig(
  db: Database,
  service: string
): Promise<{ model: string | null, dim: number, dtype: EmbeddingDtype | null } | null> {
  const [row] = await db
    .select({
      model: schema.embeddingRuntime.model,
      dim: schema.embeddingRuntime.dim,
      dtype: schema.embeddingRuntime.dtype
    })
    .from(schema.embeddingRuntime)
    .where(eq(schema.embeddingRuntime.service, service))
    .limit(1)
  if (!row) return null
  // The column is plain `text`; coerce an out-of-list value (stale/out-of-band
  // writer) to null rather than surfacing a bogus serviceDtype past the resolver.
  const dtype = (EMBEDDING_DTYPES as readonly string[]).includes(row.dtype ?? '')
    ? (row.dtype as EmbeddingDtype)
    : null
  return { ...row, dtype }
}

/** Drop a process's marker on graceful shutdown, so a decommissioned process
 * doesn't leave a stale row flagging a restart forever. */
export async function clearRuntimeEmbeddingConfig(
  db: Database,
  service: string
): Promise<void> {
  await db.delete(schema.embeddingRuntime).where(eq(schema.embeddingRuntime.service, service))
}
