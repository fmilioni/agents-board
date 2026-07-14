import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/embedding', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/embedding')>()),
  embed: vi.fn(async () => null),
  embedMany: vi.fn(async () => null),
  embedChunks: vi.fn(async () => null)
}))

import {
  backfillDocEmbeddings,
  createDoc,
  embed,
  embedChunks,
  searchDocs,
  updateDoc
} from '../src/index'
import { freshProject, useTestDb } from './helpers'

const ctx = useTestDb()
const mockedEmbed = vi.mocked(embed)
const mockedEmbedChunks = vi.mocked(embedChunks)

// A 384-dim (the column dimension) unit basis vector — one concept per axis, so
// cosine distance is 0 to itself and 1 to any other basis. Lets a test place docs
// and a query in a controlled vector space without loading the real model.
function basis(axis: number): number[] {
  const v = Array(384).fill(0)
  v[axis] = 1
  return v
}

function vecLiteral(axis: number): string {
  return `[${basis(axis).join(',')}]`
}

// Seed a single chunk vector for a doc (search reads the chunk tables now).
async function seedEmbedding(id: string, axis: number) {
  await ctx.db.execute(
    sql`insert into doc_chunks (doc_id, idx, embedding) values (${id}, 0, ${vecLiteral(axis)}::vector)`
  )
}

async function chunkCount(docId: string): Promise<number> {
  const rows = (await ctx.db.execute(
    sql`select count(*)::int as n from doc_chunks where doc_id = ${docId}`
  )) as unknown as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

async function chunkVector(docId: string, idx: number): Promise<string | null> {
  const rows = (await ctx.db.execute(
    sql`select embedding::text as v from doc_chunks where doc_id = ${docId} and idx = ${idx}`
  )) as unknown as Array<{ v: string }>
  return rows[0]?.v ?? null
}

beforeEach(() => {
  mockedEmbed.mockReset()
  mockedEmbed.mockResolvedValue(null) // default: search query falls back to lexical
  mockedEmbedChunks.mockReset()
  mockedEmbedChunks.mockResolvedValue(null) // default: writes store no chunks
})

describe('docs semantic search', () => {
  it('recovers a doc with no lexical overlap via the vector signal', async () => {
    const project = await freshProject(ctx.db)
    const fiscal = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'Pipeline de emissão fiscal NFC-e',
      bodyMd: 'gera o QR Code e o XML'
    })
    const other = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'Arquitetura do monorepo',
      bodyMd: 'camadas e pacotes'
    })
    await seedEmbedding(fiscal!.id, 0)
    await seedEmbedding(other!.id, 1)

    // "DANFCE PDF" shares no token with either doc — lexical recall is empty;
    // only the vector signal (query embedded near the fiscal doc) recovers it.
    mockedEmbed.mockResolvedValueOnce(basis(0))
    const results = await searchDocs(ctx.db, project.id, 'DANFCE PDF')
    expect(results.map(d => d.id)).toContain(fiscal!.id)
    expect(results[0]?.id).toBe(fiscal!.id)
  })

  it('finds a doc via a non-first (tail) chunk — the part a single vector truncated', async () => {
    const project = await freshProject(ctx.db)
    const long = await createDoc(ctx.db, { projectId: project.id, title: 'longo', bodyMd: 'corpo' })
    const other = await createDoc(ctx.db, { projectId: project.id, title: 'outro', bodyMd: 'corpo' })
    // `long` has a head chunk (axis 0) and a tail chunk (axis 1); `other` sits on axis 2.
    await ctx.db.execute(sql`insert into doc_chunks (doc_id, idx, embedding) values
      (${long!.id}, 0, ${vecLiteral(0)}::vector), (${long!.id}, 1, ${vecLiteral(1)}::vector)`)
    await seedEmbedding(other!.id, 2)

    // The query lands on axis 1 — only the TAIL chunk of `long` is near it. Without
    // min-over-chunks (e.g. matching only the head) `long` would not surface.
    mockedEmbed.mockResolvedValueOnce(basis(1))
    const results = await searchDocs(ctx.db, project.id, 'DANFCE PDF')
    expect(results.map(d => d.id)).toContain(long!.id)
    expect(results[0]?.id).toBe(long!.id)
  })

  it('keeps an exact lexical hit on top after fusion (no regression)', async () => {
    const project = await freshProject(ctx.db)
    const fiscal = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'Pipeline de emissão fiscal',
      bodyMd: 'conteúdo'
    })
    const arch = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'Arquitetura do monorepo',
      bodyMd: 'conteúdo'
    })
    await seedEmbedding(fiscal!.id, 0)
    await seedEmbedding(arch!.id, 1)

    // Query matches "Arquitetura" lexically, but is embedded near the fiscal doc.
    // RRF must still rank the lexical hit first (lexical rank + vector rank beats
    // a vector-only hit).
    mockedEmbed.mockResolvedValueOnce(basis(0))
    const results = await searchDocs(ctx.db, project.id, 'Arquitetura')
    expect(results[0]?.id).toBe(arch!.id)
  })

  it('falls back to lexical-only when the query cannot be embedded', async () => {
    const project = await freshProject(ctx.db)
    const arch = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'Arquitetura do monorepo',
      bodyMd: 'conteúdo'
    })
    await seedEmbedding(arch!.id, 1)

    // embed() returns null (default) — no vector branch, pure lexical.
    const results = await searchDocs(ctx.db, project.id, 'Arquitetura')
    expect(results.map(d => d.id)).toEqual([arch!.id])
  })

  it('chunks title+summary+body as a passage on create', async () => {
    mockedEmbedChunks.mockResolvedValue([basis(0)])
    const project = await freshProject(ctx.db)
    const doc = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'T',
      summary: 'S',
      bodyMd: 'B'
    })
    expect(mockedEmbedChunks).toHaveBeenCalledWith('T\nS\nB')
    expect(await chunkCount(doc!.id)).toBe(1)
  })

  it('persists one chunk row per returned vector', async () => {
    mockedEmbedChunks.mockResolvedValue([basis(0), basis(1), basis(2)])
    const project = await freshProject(ctx.db)
    const doc = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'longo',
      bodyMd: 'corpo extenso'
    })
    expect(await chunkCount(doc!.id)).toBe(3)
    const rows = (await ctx.db.execute(
      sql`select idx from doc_chunks where doc_id = ${doc!.id} order by idx`
    )) as unknown as Array<{ idx: number }>
    expect(rows.map(r => r.idx)).toEqual([0, 1, 2])
  })

  it('re-chunks on a content edit but not on a metadata-only edit', async () => {
    mockedEmbedChunks.mockResolvedValue([basis(0)])
    const project = await freshProject(ctx.db)
    const doc = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'Original',
      bodyMd: 'corpo'
    })
    mockedEmbedChunks.mockClear()

    await updateDoc(ctx.db, { id: doc!.id, position: 3 })
    expect(mockedEmbedChunks).not.toHaveBeenCalled()

    await updateDoc(ctx.db, { id: doc!.id, title: 'Editado' })
    expect(mockedEmbedChunks).toHaveBeenCalledTimes(1)
  })

  it('regenerates chunks on edit without leaving orphans from the prior version', async () => {
    mockedEmbedChunks.mockResolvedValue([basis(0), basis(1), basis(2)])
    const project = await freshProject(ctx.db)
    const doc = await createDoc(ctx.db, { projectId: project.id, title: 'v1', bodyMd: 'longo' })
    expect(await chunkCount(doc!.id)).toBe(3)

    mockedEmbedChunks.mockResolvedValue([basis(5)]) // shorter content → fewer chunks
    await updateDoc(ctx.db, { id: doc!.id, bodyMd: 'curto' })
    expect(await chunkCount(doc!.id)).toBe(1)
    // The write overwrites idx 0 in place (upsert), so a kept row must carry the NEW
    // vector — a chunk count alone wouldn't catch the edit silently keeping the old one.
    expect(await chunkVector(doc!.id, 0)).toBe(vecLiteral(5))
  })

  it('clears every chunk when an edit blanks the content', async () => {
    mockedEmbedChunks.mockResolvedValue([basis(0), basis(1)])
    const project = await freshProject(ctx.db)
    const doc = await createDoc(ctx.db, { projectId: project.id, title: 'v1', bodyMd: 'corpo' })
    expect(await chunkCount(doc!.id)).toBe(2)

    mockedEmbedChunks.mockResolvedValue([]) // nothing left to embed
    await updateDoc(ctx.db, { id: doc!.id, bodyMd: '' })
    expect(await chunkCount(doc!.id)).toBe(0)
  })

  it('keeps existing chunks when a re-embed fails (null does not wipe vectors)', async () => {
    mockedEmbedChunks.mockResolvedValue([basis(0), basis(1)])
    const project = await freshProject(ctx.db)
    const doc = await createDoc(ctx.db, { projectId: project.id, title: 'ok', bodyMd: 'corpo' })
    expect(await chunkCount(doc!.id)).toBe(2)

    mockedEmbedChunks.mockResolvedValue(null) // transient failure / model off
    await updateDoc(ctx.db, { id: doc!.id, title: 'editado' })
    expect(await chunkCount(doc!.id)).toBe(2)
  })

  it('backfills chunks for docs missing them, idempotently', async () => {
    const project = await freshProject(ctx.db)
    // created under the null default -> no chunks
    const doc = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'sem chunk',
      bodyMd: 'corpo'
    })
    expect(await chunkCount(doc!.id)).toBe(0)

    mockedEmbedChunks.mockResolvedValue([basis(0)])
    const count = await backfillDocEmbeddings(ctx.db, 10)
    // Loose count: the backfill is db-wide, so it also sweeps what the other tests in
    // this file left un-chunked.
    expect(count).toBeGreaterThanOrEqual(1)
    expect(await chunkCount(doc!.id)).toBe(1)

    // Idempotent: the doc already has chunks, so a second run leaves it at one
    // (it's excluded by `not exists`) — no duplicates.
    await backfillDocEmbeddings(ctx.db, 10)
    expect(await chunkCount(doc!.id)).toBe(1)
  })
})
