import type { EmbeddingConfig, EmbeddingDtype } from '@agents-board/shared'
import { DEFAULT_EMBEDDING_DIM, DEFAULT_EMBEDDING_DTYPE } from '@agents-board/shared'

export type EmbeddingKind = 'query' | 'passage'

export type EmbedderState = 'loading' | 'ready' | 'disabled' | 'error'

export interface EmbedderStatus {
  state: EmbedderState
  model: string | null
  dim: number
  dtype: EmbeddingDtype
}

/** Runs the loaded pipeline over already-prefixed texts, returning unit-normalized vectors. */
export type RunFn = (texts: string[]) => Promise<number[][]>

export interface LoadedPipeline {
  run: RunFn
  /** Frees the onnxruntime InferenceSession; called before the reference is dropped. */
  dispose: () => Promise<void> | void
}

export type PipelineLoader = (cfg: EmbeddingConfig) => Promise<LoadedPipeline>

export interface EmbedderOptions {
  resolveConfig: () => Promise<EmbeddingConfig>
  loadPipeline?: PipelineLoader
  /** Called after each successful (re)load with the config the service now serves. */
  onLoaded?: (cfg: EmbeddingConfig) => Promise<void> | void
}

export interface Embedder {
  /** Trigger the initial model load (idempotent). */
  init: () => Promise<void>
  /** Re-resolve the effective config and reload the pipeline (disposing the old). */
  reload: () => Promise<void>
  status: () => EmbedderStatus
  embed: (texts: string[], kind: EmbeddingKind) => Promise<number[][] | null>
}

const defaultLoadPipeline: PipelineLoader = async (cfg) => {
  const { pipeline, env } = await import('@huggingface/transformers')
  // Transformers.js ignores HF_HOME/TRANSFORMERS_CACHE — the weights cache dir is
  // only overridable programmatically. Point it at a stable path (a mounted
  // volume in Docker) so the weights survive a rebuild instead of re-downloading.
  const cacheDir = process.env.EMBEDDING_CACHE_DIR?.trim()
  if (cacheDir) env.cacheDir = cacheDir
  const pipe = await pipeline('feature-extraction', cfg.model!, {
    dtype: cfg.dtype
  } as Record<string, unknown>)
  return {
    run: async (texts) => {
      const out = await pipe(texts, { pooling: 'mean', normalize: true })
      return out.tolist() as number[][]
    },
    dispose: () => pipe.dispose?.()
  }
}

// Connection-level failures (Node socket errnos + postgres.js' own connection
// codes) that mean the DB is transiently unreachable, not that the query/config
// is wrong — these are worth retrying; everything else is not.
const TRANSIENT_DB_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'EPIPE',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECTION_REFUSED',
  'CONNECT_TIMEOUT'
])

// Drizzle wraps the driver error, which wraps the raw socket error — the
// ECONNREFUSED lives a couple `.cause` hops down, so walk the chain.
export function isTransientDbError(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 10; depth++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && TRANSIENT_DB_ERROR_CODES.has(code)) return true
    const message = (cur as { message?: unknown }).message
    if (typeof message === 'string' && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(message)) {
      return true
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

export interface WarmUpOptions {
  sleep?: (ms: number) => Promise<void>
  baseDelayMs?: number
  maxDelayMs?: number
  isTransient?: (err: unknown) => boolean
}

const WARM_UP_BASE_DELAY_MS = 1000
const WARM_UP_MAX_DELAY_MS = 30_000

/**
 * Boot warm-up that survives a transient DB outage. The load reads
 * `system_settings` from Postgres; when that read fails on a connection error
 * (DB still coming up, or bounced after the service was already listening), the
 * load is retried with capped exponential backoff until it converges — instead
 * of getting stuck at `loading` until a manual /reload or a container restart.
 * Best-effort: a non-transient failure (e.g. the model download, which the
 * embedder already swallows to `error`) is left to the lazy path and never
 * retried here, and nothing thrown escapes.
 */
export async function warmUp(embedder: Embedder, opts: WarmUpOptions = {}): Promise<void> {
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const base = opts.baseDelayMs ?? WARM_UP_BASE_DELAY_MS
  const max = opts.maxDelayMs ?? WARM_UP_MAX_DELAY_MS
  const isTransient = opts.isTransient ?? isTransientDbError

  for (let attempt = 0; ; attempt++) {
    try {
      // init() memoizes its promise (a rejection sticks), so a retry has to go
      // through reload() to trigger a fresh resolveConfig + load.
      await (attempt === 0 ? embedder.init() : embedder.reload())
      return
    } catch (err) {
      if (!isTransient(err)) {
        console.error('[embedding-service] model load failed at boot; first embed will retry lazily', err)
        return
      }
      const delay = Math.min(max, base * 2 ** attempt)
      console.warn(`[embedding-service] DB unavailable during warm-up; retrying in ${delay}ms`, err)
      await sleep(delay)
    }
  }
}

export function createEmbedder({
  resolveConfig,
  loadPipeline = defaultLoadPipeline,
  onLoaded
}: EmbedderOptions): Embedder {
  let cfg: EmbeddingConfig | null = null
  let loaded: LoadedPipeline | null = null
  let state: EmbedderState = 'loading'
  let loadingPromise: Promise<void> | null = null
  let reloadInFlight: Promise<void> | null = null

  async function doLoad(): Promise<void> {
    state = 'loading'
    // Dispose the old session BEFORE loading the new one: peak stays at a single
    // model so memory doesn't ratchet up ~2x per swap (the native allocator keeps
    // the peak as RSS). The brief no-model window degrades to lexical (an embed
    // mid-reload just awaits the new load) — the accepted trade-off.
    const previous = loaded
    loaded = null
    if (previous) {
      try {
        await previous.dispose()
      } catch (err) {
        console.error('[embedding-service] disposing the old pipeline failed', err)
      }
    }
    const nextCfg = await resolveConfig()
    let next: LoadedPipeline | null = null
    if (nextCfg.model) {
      try {
        next = await loadPipeline(nextCfg)
      } catch (err) {
        console.error('[embedding-service] model load failed; semantic search off', err)
      }
    }
    cfg = nextCfg
    loaded = next
    state = !nextCfg.model ? 'disabled' : next ? 'ready' : 'error'
    if (state !== 'error') await onLoaded?.(nextCfg)
  }

  function ensureLoaded(): Promise<void> {
    if (!loadingPromise) loadingPromise = doLoad()
    return loadingPromise
  }

  return {
    init: ensureLoaded,
    reload: () => {
      // Coalesce concurrent reloads — never load twice in parallel.
      if (reloadInFlight) return reloadInFlight
      loadingPromise = doLoad()
      reloadInFlight = loadingPromise.finally(() => {
        reloadInFlight = null
      })
      return reloadInFlight
    },
    status: () => ({
      state,
      model: cfg?.model ?? null,
      dim: cfg?.dim ?? DEFAULT_EMBEDDING_DIM,
      dtype: cfg?.dtype ?? DEFAULT_EMBEDDING_DTYPE
    }),
    embed: async (texts, kind) => {
      if (texts.length === 0) return []
      await ensureLoaded()
      if (!loaded) return null
      try {
        const prefixed = cfg?.e5Prefix
          ? texts.map(t => `${kind}: ${t}`)
          : texts
        return await loaded.run(prefixed)
      } catch (err) {
        console.error('[embedding-service] inference failed; caller falls back to lexical', err)
        return null
      }
    }
  }
}
