import { beforeEach, describe, expect, it } from 'vitest'

import {
  addComment,
  archiveCard,
  archiveIntakeItem,
  archiveSprint,
  createAttachment,
  createCard,
  createIntakeItem,
  createSprint,
  getAttachment,
  markIntakePlanned,
  setKeepAttachmentsOnArchive,
  updateCard,
  updateComment,
  updateIntakeItem
} from '../src/index'
import { freshProject, useTestDb } from './helpers'

// Isolated DB: these tests flip the global `keepAttachmentsOnArchive` toggle, which the
// suite's by-project isolation doesn't cover — on the shared one a parallel file reading
// it (the archive GC of commit-images/attachment-sweep) would see this file's value.
const ctx = useTestDb({ isolated: true })

const bytes = () => Buffer.from('img', 'utf8')
const ref = (id: string) => `body ![pic](/attachments/${id}) more`

async function cardWithImage(
  projectId: string,
  opts: { sprintId?: string } = {}
) {
  const card = await createCard(ctx.db, {
    projectId,
    sprintId: opts.sprintId,
    title: 'C'
  })
  const att = await createAttachment(ctx.db, {
    projectId,
    mime: 'image/png',
    data: bytes(),
    width: 1,
    height: 1
  })
  await updateCard(ctx.db, { id: card.id, descriptionMd: ref(att.id) })
  return { card, att }
}

const dataOf = async (id: string) => (await getAttachment(ctx.db, id))!.data

describe('gcAttachmentsOnArchive', () => {
  beforeEach(async () => {
    await setKeepAttachmentsOnArchive(ctx.db, false)
  })

  it('clears bytes when the card owner is archived and nothing else refs it', async () => {
    const project = await freshProject(ctx.db)
    const { card, att } = await cardWithImage(project.id)

    await archiveCard(ctx.db, card.id)

    expect(await dataOf(att.id)).toBeNull()
  })

  it('keeps bytes while an active card still refs them, clears on the last archive', async () => {
    const project = await freshProject(ctx.db)
    const { card: cardA, att } = await cardWithImage(project.id)
    const cardB = await createCard(ctx.db, { projectId: project.id, title: 'B' })
    await updateCard(ctx.db, { id: cardB.id, descriptionMd: ref(att.id) })

    await archiveCard(ctx.db, cardA.id)
    expect(await dataOf(att.id)).not.toBeNull()

    await archiveCard(ctx.db, cardB.id)
    expect(await dataOf(att.id)).toBeNull()
  })

  it('clears a comment-owned image when its card is archived (cascade)', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, { projectId: project.id, title: 'C' })
    const comment = await addComment(ctx.db, {
      cardId: card.id,
      author: 'user',
      bodyMd: 'placeholder'
    })
    const att = await createAttachment(ctx.db, {
      projectId: project.id,
      mime: 'image/png',
      data: bytes(),
      width: 1,
      height: 1
    })
    await updateComment(ctx.db, { id: comment.id, bodyMd: ref(att.id) })

    await archiveCard(ctx.db, card.id)

    expect(await dataOf(att.id)).toBeNull()
  })

  it('never clears when the toggle is ON', async () => {
    const project = await freshProject(ctx.db)
    const { card, att } = await cardWithImage(project.id)

    await setKeepAttachmentsOnArchive(ctx.db, true)
    try {
      await archiveCard(ctx.db, card.id)
      expect(await dataOf(att.id)).not.toBeNull()
    } finally {
      await setKeepAttachmentsOnArchive(ctx.db, false)
    }
  })

  it('aggressively clears a sprint card image with no out-of-scope ref', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const { att } = await cardWithImage(project.id, { sprintId: sprint.id })

    await archiveSprint(ctx.db, sprint.id)

    expect(await dataOf(att.id)).toBeNull()
  })

  it('keeps a sprint card image still referenced by a card outside the sprint', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const { att } = await cardWithImage(project.id, { sprintId: sprint.id })
    const outsider = await createCard(ctx.db, {
      projectId: project.id,
      title: 'Outsider'
    })
    await updateCard(ctx.db, { id: outsider.id, descriptionMd: ref(att.id) })

    await archiveSprint(ctx.db, sprint.id)

    expect(await dataOf(att.id)).not.toBeNull()
  })

  it('clears an inbox-owned image reused by a sprint card when the sprint is archived', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: 'placeholder'
    })
    const att = await createAttachment(ctx.db, {
      projectId: project.id,
      mime: 'image/png',
      data: bytes(),
      width: 1,
      height: 1
    })
    const card = await createCard(ctx.db, {
      projectId: project.id,
      sprintId: sprint.id,
      title: 'C'
    })
    await updateCard(ctx.db, { id: card.id, descriptionMd: ref(att.id) })
    await markIntakePlanned(ctx.db, item.id, [card.key])

    await archiveSprint(ctx.db, sprint.id)

    expect(await dataOf(att.id)).toBeNull()
  })

  it('keeps that inbox image while an active card outside the sprint still refs it', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: 'placeholder'
    })
    const att = await createAttachment(ctx.db, {
      projectId: project.id,
      mime: 'image/png',
      data: bytes(),
      width: 1,
      height: 1
    })
    const sprintCard = await createCard(ctx.db, {
      projectId: project.id,
      sprintId: sprint.id,
      title: 'C'
    })
    await updateCard(ctx.db, { id: sprintCard.id, descriptionMd: ref(att.id) })
    await markIntakePlanned(ctx.db, item.id, [sprintCard.key])
    const outsider = await createCard(ctx.db, {
      projectId: project.id,
      title: 'Outsider'
    })
    await updateCard(ctx.db, { id: outsider.id, descriptionMd: ref(att.id) })

    await archiveSprint(ctx.db, sprint.id)

    expect(await dataOf(att.id)).not.toBeNull()
  })

  it('clears a sprint-card image referenced by an inbox archived in the same cascade', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const { card, att } = await cardWithImage(project.id, { sprintId: sprint.id })
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: ref(att.id)
    })
    await markIntakePlanned(ctx.db, item.id, [card.key])

    await archiveSprint(ctx.db, sprint.id)

    expect(await dataOf(att.id)).toBeNull()
  })

  it('clears an inbox-owned image when the intake item is archived', async () => {
    const project = await freshProject(ctx.db)
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: 'placeholder'
    })
    const att = await createAttachment(ctx.db, {
      projectId: project.id,
      mime: 'image/png',
      data: bytes(),
      width: 1,
      height: 1
    })
    await updateIntakeItem(ctx.db, { id: item.id, bodyMd: ref(att.id) })

    await archiveIntakeItem(ctx.db, item.id)

    expect(await dataOf(att.id)).toBeNull()
  })
})
