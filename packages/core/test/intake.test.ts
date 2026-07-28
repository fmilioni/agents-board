import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { schema } from '@claude-organizer/db'

import {
  archiveCard,
  archiveIntakeItem,
  archiveSprint,
  completeSprint,
  createCard,
  createIntakeItem,
  createSprint,
  destroyCard,
  listIntakeItems,
  markIntakePlanned,
  reopenSprint,
  restoreCard,
  restoreIntakeItem,
  restoreSprint,
  startSprint,
  syncIntakeForCard,
  updateCard,
  updateIntakeItem
} from '../src/index'
import { freshProject, useTestDb } from './helpers'

const ctx = useTestDb()

async function plannedItemWithCards(projectId: string, titles: string[]) {
  const cards = await Promise.all(
    titles.map(title => createCard(ctx.db, { projectId, title }))
  )
  const item = await createIntakeItem(ctx.db, { projectId, bodyMd: 'demand' })
  await markIntakePlanned(ctx.db, item.id, cards.map(c => c.key))
  return { item, cards }
}

async function completedFlag(projectId: string, itemId: string) {
  const items = await listIntakeItems(ctx.db, projectId)
  return items.find(i => i.id === itemId)?.completed
}

describe('editing a demand', () => {
  it('rewrites the body', async () => {
    const project = await freshProject(ctx.db)
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: 'rough note'
    })
    const updated = await updateIntakeItem(ctx.db, {
      id: item.id,
      bodyMd: 'sharpened note'
    })
    expect(updated?.bodyMd).toBe('sharpened note')
  })

  it('returns null for an id that does not exist', async () => {
    const updated = await updateIntakeItem(ctx.db, {
      id: 'itk_missing',
      bodyMd: 'x'
    })
    expect(updated).toBeNull()
  })

  it('keeps the status a planned demand already had', async () => {
    const project = await freshProject(ctx.db)
    const { item } = await plannedItemWithCards(project.id, ['a'])
    const updated = await updateIntakeItem(ctx.db, {
      id: item.id,
      bodyMd: 'more context'
    })
    expect(updated?.status).toBe('planned')
  })

  it('edits an archived demand without reviving it', async () => {
    const project = await freshProject(ctx.db)
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: 'discarded'
    })
    await archiveIntakeItem(ctx.db, item.id)
    const updated = await updateIntakeItem(ctx.db, {
      id: item.id,
      bodyMd: 'discarded, with a note on why'
    })
    expect(updated?.status).toBe('archived')
    expect(updated?.archivedAt).not.toBeNull()
  })
})

describe('correcting the planned keys', () => {
  it('replaces the whole key set when planned again', async () => {
    const project = await freshProject(ctx.db)
    const { item } = await plannedItemWithCards(project.id, ['a', 'b'])
    const right = await createCard(ctx.db, {
      projectId: project.id,
      title: 'the card it really became'
    })
    const updated = await markIntakePlanned(ctx.db, item.id, [right.key])
    expect(updated?.plannedCardKeys).toBe(right.key)
  })

  it('re-derives completed from the cards it now points at', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['shipped'])
    await updateCard(ctx.db, { id: cards[0]!.id, status: 'done' })
    expect(await completedFlag(project.id, item.id)).toBe(true)

    const stillOpen = await createCard(ctx.db, {
      projectId: project.id,
      title: 'the card it really became'
    })
    await markIntakePlanned(ctx.db, item.id, [stillOpen.key])
    expect(await completedFlag(project.id, item.id)).toBe(false)
  })
})

describe('restoring an archived demand', () => {
  it('lands on planned when it carries card keys', async () => {
    const project = await freshProject(ctx.db)
    const { item } = await plannedItemWithCards(project.id, ['a'])
    await archiveIntakeItem(ctx.db, item.id)
    const restored = await restoreIntakeItem(ctx.db, item.id)
    expect(restored?.status).toBe('planned')
    expect(restored?.archivedAt).toBeNull()
  })

  it('lands on pending when it carries none', async () => {
    const project = await freshProject(ctx.db)
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: 'never planned'
    })
    await archiveIntakeItem(ctx.db, item.id)
    const restored = await restoreIntakeItem(ctx.db, item.id)
    expect(restored?.status).toBe('pending')
    expect(restored?.archivedAt).toBeNull()
  })

  it('returns null for an id that does not exist', async () => {
    expect(await restoreIntakeItem(ctx.db, 'itk_missing')).toBeNull()
  })

  it('lands on pending when every card it points at is archived', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a', 'b'])
    for (const c of cards) await archiveCard(ctx.db, c.id)

    const restored = await restoreIntakeItem(ctx.db, item.id)

    expect(restored?.status).toBe('pending')
    expect(restored?.plannedCardKeys).toBe(cards.map(c => c.key).join(','))
  })

  it('is not archived again by the next card event', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a'])
    await archiveCard(ctx.db, cards[0]!.id)
    await restoreIntakeItem(ctx.db, item.id)

    await syncIntakeForCard(ctx.db, project.id, cards[0]!.key)

    const [row] = await ctx.db
      .select()
      .from(schema.intakeItems)
      .where(eq(schema.intakeItems.id, item.id))
    expect(row?.status).toBe('pending')
  })

  it('lands on pending when its card is alive but its sprint is archived', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 's' })
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'in an archived sprint',
      sprintId: sprint.id
    })
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: 'demand'
    })
    await markIntakePlanned(ctx.db, item.id, [card.key])
    await archiveSprint(ctx.db, sprint.id)

    const restored = await restoreIntakeItem(ctx.db, item.id)

    expect(restored?.status).toBe('pending')
  })

  it('is promoted back to planned when one of its cards returns', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a'])
    await archiveCard(ctx.db, cards[0]!.id)
    await restoreIntakeItem(ctx.db, item.id)

    await restoreCard(ctx.db, cards[0]!.id)

    const [row] = await ctx.db
      .select()
      .from(schema.intakeItems)
      .where(eq(schema.intakeItems.id, item.id))
    expect(row?.status).toBe('planned')
  })
})

describe('intake completion derived from card status', () => {
  it('is completed when all referenced cards are done', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a', 'b'])
    for (const c of cards) await updateCard(ctx.db, { id: c.id, status: 'done' })
    expect(await completedFlag(project.id, item.id)).toBe(true)
  })

  it('is not completed while any card is still in progress', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a', 'b'])
    await updateCard(ctx.db, { id: cards[0]!.id, status: 'done' })
    await updateCard(ctx.db, { id: cards[1]!.id, status: 'in_progress' })
    expect(await completedFlag(project.id, item.id)).toBe(false)
  })

  it('is not completed when every referenced card is archived', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a', 'b'])
    for (const c of cards) {
      await updateCard(ctx.db, { id: c.id, status: 'done' })
      await archiveCard(ctx.db, c.id)
    }
    expect(await completedFlag(project.id, item.id)).toBe(false)
  })

  it('ignores archived cards and counts only the live ones', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a', 'b'])
    await updateCard(ctx.db, { id: cards[0]!.id, status: 'done' })
    await updateCard(ctx.db, { id: cards[1]!.id, status: 'in_progress' })
    await archiveCard(ctx.db, cards[1]!.id)
    expect(await completedFlag(project.id, item.id)).toBe(true)
  })

  it('ignores destroyed cards when deriving completion', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a', 'b'])
    await updateCard(ctx.db, { id: cards[0]!.id, status: 'done' })
    await destroyCard(ctx.db, cards[1]!.id)
    expect(await completedFlag(project.id, item.id)).toBe(true)
  })
})

async function findItem(projectId: string, itemId: string) {
  const items = await listIntakeItems(ctx.db, projectId)
  return items.find(i => i.id === itemId)
}

describe('intake cascade on card archive/restore/destroy', () => {
  it('survives the destroy of the last card it pointed at', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a'])
    await archiveCard(ctx.db, cards[0]!.id)
    await restoreIntakeItem(ctx.db, item.id)

    await destroyCard(ctx.db, cards[0]!.id)

    const [row] = await ctx.db
      .select()
      .from(schema.intakeItems)
      .where(eq(schema.intakeItems.id, item.id))
    expect(row?.status).toBe('pending')
    expect(row?.plannedCardKeys).toBeNull()
  })

  it('is not archived when a destroy leaves it with inactive keys', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a', 'b'])
    for (const c of cards) await archiveCard(ctx.db, c.id)
    await restoreIntakeItem(ctx.db, item.id)

    await destroyCard(ctx.db, cards[0]!.id)

    const [row] = await ctx.db
      .select()
      .from(schema.intakeItems)
      .where(eq(schema.intakeItems.id, item.id))
    expect(row?.status).toBe('pending')
    expect(row?.archivedAt).toBeNull()
    expect(row?.plannedCardKeys).toBe(cards[1]!.key)
  })

  it('archives the item when its last active card is archived, restores on undo', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a', 'b'])
    await archiveCard(ctx.db, cards[0]!.id)
    expect((await findItem(project.id, item.id))?.status).toBe('planned')
    await archiveCard(ctx.db, cards[1]!.id)
    expect((await findItem(project.id, item.id))?.status).toBe('archived')
    await restoreCard(ctx.db, cards[1]!.id)
    expect((await findItem(project.id, item.id))?.status).toBe('planned')
  })

  it('destroys the item when all its cards are destroyed', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a', 'b'])
    await destroyCard(ctx.db, cards[0]!.id)
    await destroyCard(ctx.db, cards[1]!.id)
    expect(await findItem(project.id, item.id)).toBeUndefined()
  })

  it('prunes the destroyed key and keeps the item planned when others remain', async () => {
    const project = await freshProject(ctx.db)
    const { item, cards } = await plannedItemWithCards(project.id, ['a', 'b'])
    await destroyCard(ctx.db, cards[0]!.id)
    const after = await findItem(project.id, item.id)
    expect(after?.status).toBe('planned')
    expect(after?.plannedCardKeys).toBe(cards[1]!.key)
  })

  it('prunes keys of destroyed subtasks, not just the parent', async () => {
    const project = await freshProject(ctx.db)
    const parent = await createCard(ctx.db, { projectId: project.id, title: 'p' })
    const child = await createCard(ctx.db, {
      projectId: project.id,
      title: 'c',
      parentId: parent.id
    })
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: 'demand'
    })
    await markIntakePlanned(ctx.db, item.id, [parent.key, child.key])
    await destroyCard(ctx.db, parent.id)
    expect(await findItem(project.id, item.id)).toBeUndefined()
  })
})

async function plannedItemInSprint(projectId: string, sprintId: string) {
  const cards = await Promise.all(
    ['a', 'b'].map(title =>
      createCard(ctx.db, { projectId, title, sprintId })
    )
  )
  const item = await createIntakeItem(ctx.db, { projectId, bodyMd: 'demand' })
  await markIntakePlanned(ctx.db, item.id, cards.map(c => c.key))
  return { item, cards }
}

async function cardArchivedAt(cardId: string) {
  const [row] = await ctx.db
    .select({ archivedAt: schema.cards.archivedAt })
    .from(schema.cards)
    .where(eq(schema.cards.id, cardId))
    .limit(1)
  return row?.archivedAt ?? null
}

describe('intake cascade on sprint archive/restore/reopen', () => {
  it('archives the item when its sprint is archived, without archiving the cards', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const { item, cards } = await plannedItemInSprint(project.id, sprint.id)

    await archiveSprint(ctx.db, sprint.id)
    expect((await findItem(project.id, item.id))?.status).toBe('archived')
    for (const c of cards) expect(await cardArchivedAt(c.id)).toBeNull()
  })

  it('restores the item when the sprint is restored', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const { item } = await plannedItemInSprint(project.id, sprint.id)

    await archiveSprint(ctx.db, sprint.id)
    await restoreSprint(ctx.db, sprint.id)
    expect((await findItem(project.id, item.id))?.status).toBe('planned')
  })

  it('restores the item when the sprint is reopened', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const { item } = await plannedItemInSprint(project.id, sprint.id)

    await archiveSprint(ctx.db, sprint.id)
    await reopenSprint(ctx.db, sprint.id)
    expect((await findItem(project.id, item.id))?.status).toBe('planned')
  })

  it('completing a sprint does not touch the inbox', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const { item } = await plannedItemInSprint(project.id, sprint.id)

    await startSprint(ctx.db, sprint.id)
    await completeSprint(ctx.db, sprint.id)
    expect((await findItem(project.id, item.id))?.status).toBe('planned')
  })

  it('archives a multi-sprint item only when every referenced sprint is archived', async () => {
    const project = await freshProject(ctx.db)
    const s1 = await createSprint(ctx.db, { projectId: project.id, name: 'S1' })
    const s2 = await createSprint(ctx.db, { projectId: project.id, name: 'S2' })
    const c1 = await createCard(ctx.db, {
      projectId: project.id,
      title: 'a',
      sprintId: s1.id
    })
    const c2 = await createCard(ctx.db, {
      projectId: project.id,
      title: 'b',
      sprintId: s2.id
    })
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: 'demand'
    })
    await markIntakePlanned(ctx.db, item.id, [c1.key, c2.key])

    await archiveSprint(ctx.db, s1.id)
    expect((await findItem(project.id, item.id))?.status).toBe('planned')

    await archiveSprint(ctx.db, s2.id)
    expect((await findItem(project.id, item.id))?.status).toBe('archived')
  })

  it('keeps the item planned when an active sprintless card coexists with an archived-sprint card', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, { projectId: project.id, name: 'S' })
    const inSprint = await createCard(ctx.db, {
      projectId: project.id,
      title: 'a',
      sprintId: sprint.id
    })
    const sprintless = await createCard(ctx.db, {
      projectId: project.id,
      title: 'b'
    })
    const item = await createIntakeItem(ctx.db, {
      projectId: project.id,
      bodyMd: 'demand'
    })
    await markIntakePlanned(ctx.db, item.id, [inSprint.key, sprintless.key])

    await archiveSprint(ctx.db, sprint.id)
    expect((await findItem(project.id, item.id))?.status).toBe('planned')
    expect(await cardArchivedAt(sprintless.id)).toBeNull()
  })
})
