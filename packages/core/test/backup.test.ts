import { gunzipSync } from 'node:zlib'

import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { schema } from '@agents-board/db'
import { BACKUP_FORMAT_VERSION } from '@agents-board/shared'

import {
  addBlocker,
  addComment,
  addTagToCard,
  archiveCard,
  BACKUP_TABLE_NAMES,
  createAttachment,
  createCard,
  createDoc,
  createIntakeItem,
  createSprint,
  createTag,
  exportAll,
  exportProject,
  NON_BACKUP_TABLE_NAMES,
  serializeBackup
} from '../src/index'
import { freshProject, useTestDb } from './helpers'

const ctx = useTestDb()

const schemaTableNames = () =>
  Object.values(schema)
    .filter(v => is(v, PgTable))
    .map(t => getTableName(t))

describe('backup coverage', () => {
  it('every schema table is either exported or explicitly excluded', () => {
    expect([...BACKUP_TABLE_NAMES, ...NON_BACKUP_TABLE_NAMES].sort()).toEqual(
      schemaTableNames().sort()
    )
  })

  it('the exported and excluded sets are disjoint', () => {
    const exported = new Set<string>(BACKUP_TABLE_NAMES)
    expect(NON_BACKUP_TABLE_NAMES.some(t => exported.has(t))).toBe(false)
  })
})

async function seedProject(db: typeof ctx.db) {
  const project = await freshProject(db)
  const sprint = await createSprint(db, { projectId: project.id, name: 'S1' })
  const card = await createCard(db, {
    projectId: project.id,
    sprintId: sprint.id,
    title: 'Card A'
  })
  const blocker = await createCard(db, {
    projectId: project.id,
    sprintId: sprint.id,
    title: 'Card B'
  })
  await addBlocker(db, card.id, blocker.id)
  await addComment(db, { cardId: card.id, author: 'user', bodyMd: 'hi' })
  await createDoc(db, { projectId: project.id, title: 'Doc', bodyMd: 'x' })
  await createIntakeItem(db, { projectId: project.id, bodyMd: 'raw demand' })
  await createAttachment(db, {
    projectId: project.id,
    mime: 'image/png',
    data: Buffer.alloc(8, 1),
    width: 4,
    height: 4
  })
  const tag = await createTag(db, { projectId: project.id, name: 'area' })
  await addTagToCard(db, card.id, tag.id)
  // an archived card must still be exported (backup is not filtered by archive)
  const gone = await createCard(db, {
    projectId: project.id,
    sprintId: sprint.id,
    title: 'Archived'
  })
  await archiveCard(db, gone.id)
  return { project, card, gone }
}

describe('exportProject', () => {
  it('serializes the whole project, including archived rows', async () => {
    const { project, card, gone } = await seedProject(ctx.db)
    const env = await exportProject(ctx.db, project.id)

    expect(env.version).toBe(BACKUP_FORMAT_VERSION)
    expect(env.scope).toBe('project')
    expect(env.projectIds).toEqual([project.id])

    const cardIds = (env.data.cards as { id: string }[]).map(c => c.id)
    expect(env.data.projects).toHaveLength(1)
    expect(cardIds).toContain(card.id)
    expect(cardIds).toContain(gone.id)
    expect(env.data.comments.length).toBeGreaterThan(0)
    expect(env.data.docs.length).toBeGreaterThan(0)
    expect(env.data.tags.length).toBeGreaterThan(0)
    expect(env.data.card_tags.length).toBeGreaterThan(0)
    expect(env.data.intake_items.length).toBeGreaterThan(0)
    expect(env.data.card_blockers.length).toBeGreaterThan(0)
    expect(env.data.attachments.length).toBeGreaterThan(0)
  })

  it('scopes to one project — other projects rows do not leak in', async () => {
    const a = await seedProject(ctx.db)
    const b = await seedProject(ctx.db)
    const env = await exportProject(ctx.db, a.project.id)
    const cardIds = (env.data.cards as { id: string }[]).map(c => c.id)
    expect(cardIds).toContain(a.card.id)
    expect(cardIds).not.toContain(b.card.id)
  })

  it('keeps only intra-project blocker edges (no dangling cross-project FK)', async () => {
    const a = await seedProject(ctx.db)
    const b = await seedProject(ctx.db)
    await addBlocker(ctx.db, a.card.id, b.card.id)
    const env = await exportProject(ctx.db, a.project.id)
    const blockers = env.data.card_blockers as {
      blockedCardId: string
      blockerCardId: string
    }[]
    expect(
      blockers.some(e => e.blockerCardId === b.card.id)
    ).toBe(false)
  })

  it('round-trips through gzip back to the same envelope', async () => {
    const { project } = await seedProject(ctx.db)
    const env = await exportProject(ctx.db, project.id)
    const restored = JSON.parse(gunzipSync(serializeBackup(env)).toString('utf8'))
    expect(restored).toEqual(JSON.parse(JSON.stringify(env)))
  })
})

describe('exportAll', () => {
  it('includes every project and all tables', async () => {
    const { project } = await seedProject(ctx.db)
    const env = await exportAll(ctx.db)
    expect(env.scope).toBe('all')
    expect(env.projectIds).toContain(project.id)
    for (const name of BACKUP_TABLE_NAMES) {
      expect(Array.isArray(env.data[name])).toBe(true)
    }
  })
})
