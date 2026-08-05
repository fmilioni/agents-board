import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { resolveEmbeddingConfig } from '@agents-board/shared'

import { reciprocalRankFusion } from '../src/index'
import { useTestDb } from './helpers'

const ctx = useTestDb()

describe('pgvector foundation', () => {
  it('has the vector extension enabled', async () => {
    const rows = (await ctx.db.execute(
      sql`select extname from pg_extension where extname = 'vector'`
    )) as unknown as Array<{ extname: string }>
    expect(rows.map(r => r.extname)).toContain('vector')
  })

  it('has an embedding vector(384) column on each chunk table', async () => {
    for (const table of ['doc_chunks', 'card_chunks', 'comment_chunks']) {
      const rows = (await ctx.db.execute(sql`
        select a.atttypmod as typmod
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where c.relname = ${table}
          and a.attname = 'embedding'
          and n.nspname = current_schema()
          and a.attnum > 0 and not a.attisdropped
      `)) as unknown as Array<{ typmod: number }>
      expect(rows[0]?.typmod, `${table}.embedding dimension`).toBe(384)
    }
  })

  it('has an hnsw index on each chunk embedding column', async () => {
    const rows = (await ctx.db.execute(sql`
      select indexname from pg_indexes
      where indexname in ('doc_chunks_embedding_idx', 'card_chunks_embedding_idx', 'comment_chunks_embedding_idx')
    `)) as unknown as Array<{ indexname: string }>
    expect(rows.map(r => r.indexname).sort()).toEqual([
      'card_chunks_embedding_idx',
      'comment_chunks_embedding_idx',
      'doc_chunks_embedding_idx'
    ])
  })
})

describe('resolveEmbeddingConfig precedence', () => {
  it('a persisted override wins over EMBEDDING_MODEL', () => {
    const cfg = resolveEmbeddingConfig(
      { EMBEDDING_MODEL: 'Xenova/multilingual-e5-small' },
      'Xenova/multilingual-e5-large'
    )
    expect(cfg).toMatchObject({ model: 'Xenova/multilingual-e5-large', dim: 1024 })
  })

  it('falls back to env when the override is null/empty', () => {
    expect(resolveEmbeddingConfig({ EMBEDDING_MODEL: 'Xenova/multilingual-e5-base' }, null))
      .toMatchObject({ model: 'Xenova/multilingual-e5-base', dim: 768 })
    expect(resolveEmbeddingConfig({ EMBEDDING_MODEL: 'Xenova/multilingual-e5-base' }, '  '))
      .toMatchObject({ model: 'Xenova/multilingual-e5-base', dim: 768 })
  })

  it('a persisted "none" disables embeddings even when env sets a model', () => {
    const cfg = resolveEmbeddingConfig({ EMBEDDING_MODEL: 'Xenova/multilingual-e5-base' }, 'none')
    expect(cfg.model).toBeNull()
    expect(cfg.dim).toBe(384)
  })

  it('falls back to the default model when neither override nor env is set', () => {
    expect(resolveEmbeddingConfig({})).toMatchObject({
      model: 'Xenova/multilingual-e5-small',
      dim: 384
    })
  })
})

describe('resolveEmbeddingConfig dtype precedence', () => {
  it('defaults to q8 when neither override nor env is set', () => {
    expect(resolveEmbeddingConfig({}).dtype).toBe('q8')
  })

  it('reads EMBEDDING_DTYPE from env when no override', () => {
    expect(resolveEmbeddingConfig({ EMBEDDING_DTYPE: 'fp16' }).dtype).toBe('fp16')
  })

  it('a persisted override wins over EMBEDDING_DTYPE', () => {
    expect(resolveEmbeddingConfig({ EMBEDDING_DTYPE: 'fp16' }, null, 'fp32').dtype).toBe('fp32')
  })

  it('falls back to env when the dtype override is empty', () => {
    expect(resolveEmbeddingConfig({ EMBEDDING_DTYPE: 'fp16' }, null, '  ').dtype).toBe('fp16')
  })

  it('keeps a dtype even when embeddings are disabled', () => {
    const cfg = resolveEmbeddingConfig({ EMBEDDING_DTYPE: 'fp32' }, 'none')
    expect(cfg.model).toBeNull()
    expect(cfg.dtype).toBe('fp32')
  })

  it('throws on an unknown dtype', () => {
    expect(() => resolveEmbeddingConfig({ EMBEDDING_DTYPE: 'int4' })).toThrow(/Unknown EMBEDDING_DTYPE/)
    expect(() => resolveEmbeddingConfig({}, null, 'bogus')).toThrow(/Unknown EMBEDDING_DTYPE/)
  })
})

describe('reciprocalRankFusion', () => {
  it('ranks an id that tops both lists first', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['a', 'c', 'd']
    ])
    expect(fused[0]!.id).toBe('a')
  })

  it('includes ids present in only one list', () => {
    const fused = reciprocalRankFusion([['x'], ['y']])
    expect(fused.map(f => f.id).sort()).toEqual(['x', 'y'])
  })

  it('rewards a higher rank (smaller index) with a higher score', () => {
    const [first] = reciprocalRankFusion([['top', 'second']])
    const scores = new Map(reciprocalRankFusion([['top', 'second']]).map(f => [f.id, f.score]))
    expect(first!.id).toBe('top')
    expect(scores.get('top')!).toBeGreaterThan(scores.get('second')!)
  })

  it('returns an empty ranking for no lists', () => {
    expect(reciprocalRankFusion([])).toEqual([])
  })
})
