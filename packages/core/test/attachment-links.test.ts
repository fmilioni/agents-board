import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { schema } from '@claude-organizer/db'

import {
  addComment,
  archiveCard,
  archiveIntakeItem,
  archiveSprint,
  createAttachment,
  createCard,
  createDoc,
  createIntakeItem,
  createSprint,
  listAttachmentsByItems,
  reconcileAttachmentLinks,
  reopenSprint,
  restoreCard,
  restoreIntakeItem,
  restoreSprint,
  setKeepAttachmentsOnArchive,
  updateCard,
  updateComment,
  updateDoc,
  updateIntakeItem
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

const linkCount = async (attId: string) =>
  (
    await ctx.db
      .select()
      .from(schema.attachmentLinks)
      .where(eq(schema.attachmentLinks.attachmentId, attId))
  ).length

const orphanedAt = async (attId: string) =>
  (
    await ctx.db
      .select({ o: schema.attachments.orphanedAt })
      .from(schema.attachments)
      .where(eq(schema.attachments.id, attId))
  )[0]?.o ?? null

describe('reconcileAttachmentLinks via write paths', () => {
  it('links a card body, unlinks + stamps orphanedAt on removal, clears on re-add', async () => {
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'C',
      descriptionMd: ref(att.id)
    })
    expect(await linkCount(att.id)).toBe(1)
    expect(await orphanedAt(att.id)).toBeNull()

    await updateCard(ctx.db, { id: card.id, descriptionMd: 'no image' })
    expect(await linkCount(att.id)).toBe(0)
    expect(await orphanedAt(att.id)).not.toBeNull()

    await updateCard(ctx.db, { id: card.id, descriptionMd: ref(att.id) })
    expect(await linkCount(att.id)).toBe(1)
    expect(await orphanedAt(att.id)).toBeNull()
  })

  it('links a comment body and unlinks on edit', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, { projectId: project.id, title: 'C' })
    const att = await mkAtt(project.id)
    const comment = await addComment(ctx.db, {
      cardId: card.id,
      author: 'user',
      bodyMd: ref(att.id)
    })
    expect(await linkCount(att.id)).toBe(1)

    await updateComment(ctx.db, { id: comment!.id, bodyMd: 'gone' })
    expect(await linkCount(att.id)).toBe(0)
    expect(await orphanedAt(att.id)).not.toBeNull()
  })

  it('links a doc body and unlinks on edit', async () => {
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const doc = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'D',
      bodyMd: ref(att.id)
    })
    expect(await linkCount(att.id)).toBe(1)

    await updateDoc(ctx.db, { id: doc!.id, bodyMd: 'gone' })
    expect(await linkCount(att.id)).toBe(0)
    expect(await orphanedAt(att.id)).not.toBeNull()
  })

  it('links an inbox body and unlinks on edit', async () => {
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: ref(att.id)
    })
    expect(await linkCount(att.id)).toBe(1)

    await updateIntakeItem(ctx.db, { id: item!.id, bodyMd: 'gone' })
    expect(await linkCount(att.id)).toBe(0)
    expect(await orphanedAt(att.id)).not.toBeNull()
  })

  it('an image shared by two cards keeps a link until the last reference leaves', async () => {
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const a = await createCard(ctx.db, {
      projectId: project.id,
      title: 'A',
      descriptionMd: ref(att.id)
    })
    const b = await createCard(ctx.db, {
      projectId: project.id,
      title: 'B',
      descriptionMd: ref(att.id)
    })
    expect(await linkCount(att.id)).toBe(2)

    await updateCard(ctx.db, { id: a.id, descriptionMd: 'gone' })
    expect(await linkCount(att.id)).toBe(1)
    expect(await orphanedAt(att.id)).toBeNull()

    await updateCard(ctx.db, { id: b.id, descriptionMd: 'gone' })
    expect(await linkCount(att.id)).toBe(0)
    expect(await orphanedAt(att.id)).not.toBeNull()
  })

  it('is idempotent — reconciling the same body twice changes nothing', async () => {
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'C',
      descriptionMd: ref(att.id)
    })
    await reconcileAttachmentLinks(ctx.db, 'card', card.id, ref(att.id))
    await reconcileAttachmentLinks(ctx.db, 'card', card.id, ref(att.id))
    expect(await linkCount(att.id)).toBe(1)
    expect(await orphanedAt(att.id)).toBeNull()
  })

  it('inbox→card reuse: copying the body links the new card without re-upload', async () => {
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: ref(att.id)
    })
    // The plan conversion copies the inbox body into the new card verbatim.
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'From inbox',
      descriptionMd: ref(att.id)
    })
    expect(await linkCount(att.id)).toBe(2)
    expect(await orphanedAt(att.id)).toBeNull()
    expect(item).not.toBeNull()
    expect(card.id).toBeTruthy()
  })

  it('restore re-links the card so a shared image is not later collected (no drift)', async () => {
    await setKeepAttachmentsOnArchive(ctx.db, false)
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const a = await createCard(ctx.db, {
      projectId: project.id,
      title: 'A',
      descriptionMd: ref(att.id)
    })
    const b = await createCard(ctx.db, {
      projectId: project.id,
      title: 'B',
      descriptionMd: ref(att.id)
    })
    expect(await linkCount(att.id)).toBe(2)

    await archiveCard(ctx.db, a.id)
    expect(await linkCount(att.id)).toBe(1)

    await restoreCard(ctx.db, a.id)
    expect(await linkCount(att.id)).toBe(2)

    // B drops its ref; A (restored) still cites the image, so it must survive.
    await updateCard(ctx.db, { id: b.id, descriptionMd: 'gone' })
    expect(await linkCount(att.id)).toBe(1)
    expect(await orphanedAt(att.id)).toBeNull()
  })

  it('restore re-links a sprint card so a shared image is not later collected', async () => {
    await setKeepAttachmentsOnArchive(ctx.db, false)
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const att = await mkAtt(project.id)
    await createCard(ctx.db, {
      projectId: project.id,
      sprintId: sprint.id,
      title: 'C',
      descriptionMd: ref(att.id)
    })
    const outsider = await createCard(ctx.db, {
      projectId: project.id,
      title: 'O',
      descriptionMd: ref(att.id)
    })
    expect(await linkCount(att.id)).toBe(2)

    await archiveSprint(ctx.db, sprint.id)
    expect(await linkCount(att.id)).toBe(1)
    await restoreSprint(ctx.db, sprint.id)
    expect(await linkCount(att.id)).toBe(2)

    await updateCard(ctx.db, { id: outsider.id, descriptionMd: 'gone' })
    expect(await linkCount(att.id)).toBe(1)
    expect(await orphanedAt(att.id)).toBeNull()
  })

  it('reopen re-links a sprint card (un-archive path) so the index does not drift', async () => {
    await setKeepAttachmentsOnArchive(ctx.db, false)
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const att = await mkAtt(project.id)
    await createCard(ctx.db, {
      projectId: project.id,
      sprintId: sprint.id,
      title: 'C',
      descriptionMd: ref(att.id)
    })
    const outsider = await createCard(ctx.db, {
      projectId: project.id,
      title: 'O',
      descriptionMd: ref(att.id)
    })
    expect(await linkCount(att.id)).toBe(2)

    await archiveSprint(ctx.db, sprint.id)
    expect(await linkCount(att.id)).toBe(1)
    await reopenSprint(ctx.db, sprint.id)
    expect(await linkCount(att.id)).toBe(2)

    await updateCard(ctx.db, { id: outsider.id, descriptionMd: 'gone' })
    expect(await linkCount(att.id)).toBe(1)
    expect(await orphanedAt(att.id)).toBeNull()
  })

  it('restore re-links an inbox item so a shared image is not later collected', async () => {
    await setKeepAttachmentsOnArchive(ctx.db, false)
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: ref(att.id)
    })
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'C',
      descriptionMd: ref(att.id)
    })
    expect(await linkCount(att.id)).toBe(2)

    await archiveIntakeItem(ctx.db, item.id)
    expect(await linkCount(att.id)).toBe(1)
    await restoreIntakeItem(ctx.db, item.id)
    expect(await linkCount(att.id)).toBe(2)

    await updateCard(ctx.db, { id: card.id, descriptionMd: 'gone' })
    expect(await linkCount(att.id)).toBe(1)
    expect(await orphanedAt(att.id)).toBeNull()
  })

  it('skips a dangling token that resolves to no attachment (FK-safe)', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'C',
      descriptionMd: ref('att_000000000000')
    })
    const links = await ctx.db
      .select()
      .from(schema.attachmentLinks)
      .where(eq(schema.attachmentLinks.itemId, card.id))
    expect(links).toHaveLength(0)
  })
})

describe('listAttachmentsByItems (MCP array by link)', () => {
  it('returns images referenced in an item body, nothing for an item that references none', async () => {
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const withImg = await createCard(ctx.db, {
      projectId: project.id,
      title: 'A',
      descriptionMd: ref(att.id)
    })
    const without = await createCard(ctx.db, { projectId: project.id, title: 'B' })

    const rows = await listAttachmentsByItems(ctx.db, 'card', [
      withImg.id,
      without.id
    ])
    expect(rows.map(r => r.id)).toEqual([att.id])
    expect(rows[0]!.itemId).toBe(withImg.id)
  })

  it('lists an image referenced by two items under each item', async () => {
    const project = await freshProject(ctx.db)
    const att = await mkAtt(project.id)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'C',
      descriptionMd: ref(att.id)
    })
    const doc = await createDoc(ctx.db, {
      projectId: project.id,
      title: 'D',
      bodyMd: ref(att.id)
    })

    const forCard = await listAttachmentsByItems(ctx.db, 'card', [card.id])
    const forDoc = await listAttachmentsByItems(ctx.db, 'doc', [doc!.id])
    expect(forCard.map(r => r.id)).toEqual([att.id])
    expect(forDoc.map(r => r.id)).toEqual([att.id])
  })
})
