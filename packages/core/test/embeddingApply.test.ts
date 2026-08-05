import { beforeEach, describe, expect, it, vi } from 'vitest'

// Record the ordering of reconcile / reload / backfill. backfillDoc/Card/Comment
// all funnel through the `backfillChunks` primitive in `../src/embedding`, so
// mocking that module intercepts the reload push and every backfill; reconcile is
// mocked separately (in `@agents-board/db`) so it records its call without
// rewriting the `vector(N)` column for real.
const { calls, reloadMock } = vi.hoisted(() => ({
  calls: [] as string[],
  reloadMock: vi.fn(async () => {
    return true
  })
}))

vi.mock('@agents-board/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@agents-board/db')>()
  return {
    ...real,
    reconcileEmbeddingDim: vi.fn(async () => {
      calls.push('reconcile')
    })
  }
})

vi.mock('../src/embedding', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/embedding')>()
  return {
    ...real,
    reloadEmbeddingService: vi.fn(async () => {
      calls.push('reload')
      return reloadMock()
    }),
    backfillChunks: vi.fn(async () => {
      calls.push('backfill')
      return 0
    })
  }
})

import { type Database, reconcileEmbeddingDim } from '@agents-board/db'

import {
  applyEmbeddingConfig,
  getEmbeddingStatus,
  getSystemSettings,
  setEmbeddingDtype,
  setEmbeddingModel
} from '../src/index'
import { useTestDb } from './helpers'

const ctx = useTestDb()

async function settle(db: Database) {
  for (let i = 0; i < 200; i++) {
    const s = await getEmbeddingStatus(db)
    if (s.state === 'done' || s.state === 'error') return s
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('apply did not settle')
}

beforeEach(async () => {
  calls.length = 0
  reloadMock.mockClear()
  await setEmbeddingModel(ctx.db, null)
  await setEmbeddingDtype(ctx.db, null)
})

describe('applyEmbeddingConfig', () => {
  // Tests run with EMBEDDING_MODEL=none, so the baseline is disabled; enabling a
  // model at the baseline dim (384) backfills without a reconcile (dim unchanged)
  // and must push the reload before the backfill so the re-embed uses the new model.
  it('enabling a model backfills without reconciling, reload before backfill', async () => {
    await applyEmbeddingConfig(ctx.db, { model: 'Xenova/multilingual-e5-small' })
    await settle(ctx.db)

    expect(reloadMock).toHaveBeenCalledOnce()
    expect(calls).not.toContain('reconcile')
    expect(calls[0]).toBe('reload')
    expect(calls.indexOf('reload')).toBeLessThan(calls.indexOf('backfill'))
  })

  it('a dtype-only change reloads without reconciling or backfilling', async () => {
    // Persisted model stays null (the default small); only the dtype moves.
    const status = await applyEmbeddingConfig(ctx.db, { dtype: 'fp16' })

    expect(calls).toEqual(['reload'])
    expect(status.state).toBe('done')
    expect(status.dtype).toBe('fp16')
    expect(status.dimChanged).toBe(false)
    expect((await getSystemSettings(ctx.db)).embeddingDtype).toBe('fp16')
  })

  it('a model change with a different dim reconciles, reloads, then backfills', async () => {
    await applyEmbeddingConfig(ctx.db, { model: 'Xenova/multilingual-e5-base' })
    await settle(ctx.db)

    expect(calls).toContain('reconcile')
    expect(calls).toContain('backfill')
    expect(calls.indexOf('reconcile')).toBeLessThan(calls.indexOf('reload'))
    expect(calls.indexOf('reload')).toBeLessThan(calls.indexOf('backfill'))
  })

  it('an invalid dtype fails atomically and leaves the persisted choice untouched', async () => {
    await setEmbeddingDtype(ctx.db, 'q8')
    await expect(applyEmbeddingConfig(ctx.db, { dtype: 'int4' })).rejects.toThrow()
    expect((await getSystemSettings(ctx.db)).embeddingDtype).toBe('q8')
  })

  it('rolls back both model and dtype when the reconcile fails mid-apply', async () => {
    await setEmbeddingModel(ctx.db, 'Xenova/multilingual-e5-small')
    await setEmbeddingDtype(ctx.db, 'q8')
    vi.mocked(reconcileEmbeddingDim).mockRejectedValueOnce(new Error('reconcile boom'))

    await expect(
      applyEmbeddingConfig(ctx.db, { model: 'Xenova/multilingual-e5-base', dtype: 'fp16' })
    ).rejects.toThrow('reconcile boom')

    const settings = await getSystemSettings(ctx.db)
    expect(settings.embeddingModel).toBe('Xenova/multilingual-e5-small')
    expect(settings.embeddingDtype).toBe('q8')
  })
})
