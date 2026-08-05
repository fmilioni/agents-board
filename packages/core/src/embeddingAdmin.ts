import type { Database } from '@agents-board/db'
import { reconcileEmbeddingDim } from '@agents-board/db'
import type { EmbeddingRuntimeState, EmbeddingRuntimeStatus } from '@agents-board/shared'
import { EMBEDDING_RUNTIME_SERVICE } from '@agents-board/shared'

import { getSystemSettings, setEmbeddingDtype, setEmbeddingModel } from './authz'
import { backfillCardEmbeddings } from './cards'
import { backfillCommentEmbeddings } from './comments'
import { backfillDocEmbeddings } from './docs'
import { reloadEmbeddingService } from './embedding'
import { getRuntimeEmbeddingConfig, resolveEffectiveEmbeddingConfig } from './embeddingConfig'
import { ConflictError } from './errors'

interface ApplyProgress {
  state: Exclude<EmbeddingRuntimeState, 'idle'>
  dimChanged: boolean
  backfill: { docs: number, cards: number, comments: number }
  error: string | null
}

// Per-process: the progress of the last/ongoing apply. Null ⇒ no apply ran this
// process lifetime (idle). Ephemeral by design — a restart resets it; the backfill
// is idempotent, so a lost status never corrupts data (CO-250 decision).
let progress: ApplyProgress | null = null

function isApplying(): boolean {
  return progress?.state === 'reconciling' || progress?.state === 'backfilling'
}

/**
 * Effective embedding config (live from the DB) plus the progress of the last
 * model swap in this process. The model/dim always reflect the persisted choice,
 * so the status is correct even after a restart cleared `progress`.
 *
 * `serviceModel` is what the embedding service recorded loading — it converges on
 * `model` automatically (the apply pushes a `/reload`), so a transient mismatch
 * just means the reload is still settling, not that anything needs a restart.
 */
export async function getEmbeddingStatus(db: Database): Promise<EmbeddingRuntimeStatus> {
  const cfg = await resolveEffectiveEmbeddingConfig(db)
  const service = await getRuntimeEmbeddingConfig(db, EMBEDDING_RUNTIME_SERVICE)
  return {
    state: progress?.state ?? 'idle',
    model: cfg.model,
    dim: cfg.dim,
    enabled: cfg.model !== null,
    dimChanged: progress?.dimChanged ?? false,
    serviceModel: service?.model ?? null,
    dtype: cfg.dtype,
    serviceDtype: service?.dtype ?? null,
    backfill: progress?.backfill ?? { docs: 0, cards: 0, comments: 0 },
    error: progress?.error ?? null
  }
}

export interface EmbeddingConfigChange {
  /** Omit to leave the persisted model untouched; `null` unsets it. */
  model?: string | null
  /** Omit to leave the persisted dtype untouched; `null` unsets it. */
  dtype?: string | null
}

/**
 * Apply a model and/or dtype change: persist (validated) → reconcile the live
 * pgvector dim only when it actually changed → push a `/reload` to the embedding
 * service and wait for it to settle → backfill (background) only when the model
 * changed. The reload BEFORE the backfill guarantees the re-embed runs on the NEW
 * model; a pull/notify would race it. The service-side dispose frees the old
 * pipeline on the swap — nothing to reset in-process or restart manually.
 *
 * Lazy on dtype: a dtype-only change keeps the dim and the vector space, so it
 * skips the reconcile AND the backfill — existing vectors stay valid (the e5
 * quantization error is negligible) — and only triggers the service reload.
 */
export async function applyEmbeddingConfig(
  db: Database,
  change: EmbeddingConfigChange
): Promise<EmbeddingRuntimeStatus> {
  if (isApplying()) {
    throw new ConflictError('An embedding model change is already in progress')
  }
  // Claim the slot synchronously, before the first await — otherwise two
  // concurrent calls both pass the guard and race the persist/reconcile.
  const slot: ApplyProgress = {
    state: 'reconciling',
    dimChanged: false,
    backfill: { docs: 0, cards: 0, comments: 0 },
    error: null
  }
  progress = slot

  let prevModel: string | null = null
  let prevDtype: string | null = null
  let modelPersisted = false
  let dtypePersisted = false
  let modelChanged: boolean
  try {
    const settings = await getSystemSettings(db)
    prevModel = settings.embeddingModel
    prevDtype = settings.embeddingDtype
    const prev = await resolveEffectiveEmbeddingConfig(db)
    if (change.model !== undefined) {
      await setEmbeddingModel(db, change.model) // validates → InputError
      modelPersisted = true
    }
    if (change.dtype !== undefined) {
      await setEmbeddingDtype(db, change.dtype) // validates → InputError
      dtypePersisted = true
    }
    const next = await resolveEffectiveEmbeddingConfig(db)
    slot.dimChanged = prev.dim !== next.dim
    modelChanged = prev.model !== next.model

    // A dim change (model swap) recreates the column; a dtype-only change keeps
    // the dim, so the reconcile would be a no-op — skip it to stay lazy.
    if (slot.dimChanged) await reconcileEmbeddingDim(db)
  } catch (err) {
    // Restore the prior choice when we'd already persisted (reconcile failed):
    // otherwise the persisted choice and the live column dim drift apart and the
    // next boot would embed the new dim into the old column. Best-effort.
    if (modelPersisted) await setEmbeddingModel(db, prevModel).catch(() => {})
    if (dtypePersisted) await setEmbeddingDtype(db, prevDtype).catch(() => {})
    progress = null
    throw err
  }

  // Best-effort: if the service is unreachable the persisted choice still wins —
  // the service loads it on its next boot/reload — so a miss must not abort the
  // apply. Awaited so a backfill below embeds in the new model, not the old.
  await reloadEmbeddingService()

  // Backfill only when the vector space changed (a model swap). A dtype-only
  // change leaves existing vectors valid — no re-embed.
  if (modelChanged) {
    slot.state = 'backfilling'
    void runBackfill(db, slot)
  } else {
    slot.state = 'done'
  }
  return getEmbeddingStatus(db)
}

async function runBackfill(db: Database, p: ApplyProgress): Promise<void> {
  try {
    p.backfill.docs = await backfillDocEmbeddings(db)
    p.backfill.cards = await backfillCardEmbeddings(db)
    p.backfill.comments = await backfillCommentEmbeddings(db)
    p.state = 'done'
  } catch (err) {
    p.state = 'error'
    p.error = err instanceof Error ? err.message : String(err)
  }
}
