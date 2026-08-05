import { customType } from 'drizzle-orm/pg-core'

import { DEFAULT_EMBEDDING_DIM } from '@agents-board/shared'

/** Postgres `tsvector` column for full-text search (docs, cards, comments). */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  }
})

/** Postgres `bytea` column for raw binary blobs (attachment bytes). */
export const bytea = customType<{ data: Buffer, driverData: Buffer }>({
  dataType() {
    return 'bytea'
  }
})

/**
 * pgvector `vector(N)` column for semantic search embeddings. Stored/read as a
 * JS `number[]`; the driver bridges to pgvector's `[1,2,3]` text literal. The
 * declared dimension is the baseline (default model); the live column dimension
 * is reconciled to the configured model by `reconcileEmbeddingDim` at migrate.
 */
export const vector = customType<{
  data: number[]
  driverData: string
  config: { dimensions: number }
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? DEFAULT_EMBEDDING_DIM})`
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value) as number[]
  }
})
