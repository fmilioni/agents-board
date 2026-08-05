import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { schema } from '@agents-board/db'

import {
  archiveCard,
  createAttachment,
  createCard,
  getAttachment,
  setKeepAttachmentsOnArchive,
  sweepOrphanAttachments,
  updateCard
} from '../src/index'
import { freshProject, useTestDb } from './helpers'

const ctx = useTestDb()

const ref = (id: string) => `body ![pic](/attachments/${id}) more`

const mkAtt = (projectId: string) =>
  createAttachment(ctx.db, {
    projectId,
    mime: 'image/png',
    data: Buffer.from('img'),
    width: 1,
    height: 1
  })

const exists = async (id: string) => (await getAttachment(ctx.db, id)) != null

const orphanedAt = async (id: string) =>
  (
    await ctx.db
      .select({ o: schema.attachments.orphanedAt })
      .from(schema.attachments)
      .where(eq(schema.attachments.id, id))
  )[0]?.o ?? null

// Push the grace clock past the window without waiting an hour.
const ageOrphan = (id: string) =>
  ctx.db
    .update(schema.attachments)
    .set({ orphanedAt: sql`now() - make_interval(mins => 61)` })
    .where(eq(schema.attachments.id, id))

describe('sweepOrphanAttachments', () => {
  it('collects an edit orphan past the grace window, keeps one inside it', async () => {
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'C',
      descriptionMd: ref(att.id)
    })
    await updateCard(ctx.db, { id: card.id, descriptionMd: 'gone' })
    expect(await orphanedAt(att.id)).not.toBeNull()

    await sweepOrphanAttachments(ctx.db, { projectId: project.id })
    expect(await exists(att.id)).toBe(true)

    await ageOrphan(att.id)
    await sweepOrphanAttachments(ctx.db, { projectId: project.id })
    expect(await exists(att.id)).toBe(false)
  })

  it('an undo inside the window cancels the collection', async () => {
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'C',
      descriptionMd: ref(att.id)
    })
    await updateCard(ctx.db, { id: card.id, descriptionMd: 'gone' })
    await ageOrphan(att.id)
    await updateCard(ctx.db, { id: card.id, descriptionMd: ref(att.id) })
    expect(await orphanedAt(att.id)).toBeNull()

    await sweepOrphanAttachments(ctx.db, { projectId: project.id })
    expect(await exists(att.id)).toBe(true)
  })

  it('never collects an archive orphan (no grace clock — row stays restorable)', async () => {
    await setKeepAttachmentsOnArchive(ctx.db, false)
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'C',
      descriptionMd: ref(att.id)
    })
    await archiveCard(ctx.db, card.id)
    // Archive zeroed the bytes but did NOT stamp orphaned_at, so the sweep can't
    // see it — the row stays (restorable) regardless of how much time passes.
    expect(await orphanedAt(att.id)).toBeNull()
    expect((await getAttachment(ctx.db, att.id))!.data).toBeNull()

    await sweepOrphanAttachments(ctx.db, { projectId: project.id })
    expect(await exists(att.id)).toBe(true)
  })

  it('only sweeps the given project', async () => {
    const p1 = await freshProject(ctx.db)
    const p2 = await freshProject(ctx.db)
    const a1 = await mkAtt(p1.id)
    const a2 = await mkAtt(p2.id)
    const c1 = await createCard(ctx.db, {
      projectId: p1.id,
      title: 'C',
      descriptionMd: ref(a1.id)
    })
    const c2 = await createCard(ctx.db, {
      projectId: p2.id,
      title: 'C',
      descriptionMd: ref(a2.id)
    })
    await updateCard(ctx.db, { id: c1.id, descriptionMd: 'gone' })
    await updateCard(ctx.db, { id: c2.id, descriptionMd: 'gone' })
    await ageOrphan(a1.id)
    await ageOrphan(a2.id)

    await sweepOrphanAttachments(ctx.db, { projectId: p1.id })
    expect(await exists(a1.id)).toBe(false)
    expect(await exists(a2.id)).toBe(true)
  })
})
