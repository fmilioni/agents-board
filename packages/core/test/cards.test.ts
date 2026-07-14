import { describe, expect, it } from 'vitest'

import {
  addTagToCard,
  createCard,
  createSprint,
  createTag,
  getCard,
  getCardsByIds,
  listCards,
  moveCardToBacklog,
  moveCardToSprint,
  reorderCards,
  updateCard
} from '../src/index'
import { freshProject, uniqueKeyPrefix, useTestDb } from './helpers'

const ctx = useTestDb()

describe('card key generation', () => {
  it('assigns sequential keys per project prefix', async () => {
    const project = await freshProject(ctx.db, 'CO')
    const a = await createCard(ctx.db, { projectId: project.id, title: 'first' })
    const b = await createCard(ctx.db, { projectId: project.id, title: 'second' })
    expect(a.key).toBe('CO-1')
    expect(b.key).toBe('CO-2')
  })

  it('is atomic under concurrency: no duplicates, contiguous sequence', async () => {
    const project = await freshProject(ctx.db, 'AT')
    const n = 25
    const cards = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        createCard(ctx.db, { projectId: project.id, title: `c${i}` })
      )
    )
    const nums = cards
      .map(c => Number(c.key.split('-')[1]))
      .sort((x, y) => x - y)
    expect(new Set(cards.map(c => c.key)).size).toBe(n)
    expect(nums).toEqual(Array.from({ length: n }, (_, i) => i + 1))
  })

  it('keeps a separate sequence per project', async () => {
    const p1 = await freshProject(ctx.db, 'AA')
    const p2 = await freshProject(ctx.db, 'BB')
    const c1 = await createCard(ctx.db, { projectId: p1.id, title: 'x' })
    const c2 = await createCard(ctx.db, { projectId: p2.id, title: 'y' })
    expect(c1.key).toBe('AA-1')
    expect(c2.key).toBe('BB-1')
  })
})

describe('moving cards between backlog and sprint', () => {
  it('moves a backlog card into a sprint and back', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, {
      projectId: project.id,
      name: 'S1'
    })
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'movable'
    })
    expect(card.sprintId).toBeNull()

    const moved = await moveCardToSprint(ctx.db, card.id, sprint.id)
    expect(moved?.sprintId).toBe(sprint.id)

    const back = await moveCardToBacklog(ctx.db, card.id)
    expect(back?.sprintId).toBeNull()
  })

  it('changes status', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'status'
    })

    await updateCard(ctx.db, { id: card.id, status: 'in_progress' })
    const reloaded = await getCard(ctx.db, card.id)
    expect(reloaded?.status).toBe('in_progress')
  })
})

describe('filtering cards by multiple sprints (CO-399)', () => {
  it('lists cards of several sprints at once via sprintIds', async () => {
    const project = await freshProject(ctx.db)
    const s1 = await createSprint(ctx.db, { projectId: project.id, name: 'S1' })
    const s2 = await createSprint(ctx.db, { projectId: project.id, name: 'S2' })
    const s3 = await createSprint(ctx.db, { projectId: project.id, name: 'S3' })
    const c1 = await createCard(ctx.db, {
      projectId: project.id,
      title: 'in s1',
      sprintId: s1.id
    })
    const c2 = await createCard(ctx.db, {
      projectId: project.id,
      title: 'in s2',
      sprintId: s2.id
    })
    await createCard(ctx.db, {
      projectId: project.id,
      title: 'in s3',
      sprintId: s3.id
    })
    await createCard(ctx.db, { projectId: project.id, title: 'loose' })

    const cards = await listCards(ctx.db, {
      projectId: project.id,
      sprintIds: [s1.id, s2.id]
    })
    expect(cards.map(c => c.id).sort()).toEqual([c1.id, c2.id].sort())
  })

  it('matches no card when sprintIds is empty', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, {
      projectId: project.id,
      name: 'S'
    })
    await createCard(ctx.db, {
      projectId: project.id,
      title: 'x',
      sprintId: sprint.id
    })

    const cards = await listCards(ctx.db, {
      projectId: project.id,
      sprintIds: []
    })
    expect(cards).toEqual([])
  })
})

describe('default status by sprint membership', () => {
  it('a card with no sprint lands in the backlog status', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'parked'
    })
    expect(card.sprintId).toBeNull()
    expect(card.status).toBe('backlog')
  })

  it('a card created straight into a sprint starts in todo', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, {
      projectId: project.id,
      name: 'S'
    })
    const card = await createCard(ctx.db, {
      projectId: project.id,
      sprintId: sprint.id,
      title: 'committed'
    })
    expect(card.status).toBe('todo')
  })

  it('an explicit status always wins over the default', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'explicit',
      status: 'in_progress'
    })
    expect(card.status).toBe('in_progress')
  })

  it('moves backlog -> todo and back without a sprint', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'promote'
    })
    expect(card.status).toBe('backlog')

    const promoted = await updateCard(ctx.db, { id: card.id, status: 'todo' })
    expect(promoted?.status).toBe('todo')
    expect(promoted?.sprintId).toBeNull()

    const back = await updateCard(ctx.db, { id: card.id, status: 'backlog' })
    expect(back?.status).toBe('backlog')
    expect(back?.sprintId).toBeNull()
  })
})

describe('reordering cards', () => {
  it('persists position from the given order', async () => {
    const project = await freshProject(ctx.db)
    const a = await createCard(ctx.db, { projectId: project.id, title: 'a' })
    const b = await createCard(ctx.db, { projectId: project.id, title: 'b' })
    const c = await createCard(ctx.db, { projectId: project.id, title: 'c' })

    await reorderCards(ctx.db, { orderedIds: [c.id, a.id, b.id] })

    expect((await getCard(ctx.db, c.id))?.position).toBe(0)
    expect((await getCard(ctx.db, a.id))?.position).toBe(1)
    expect((await getCard(ctx.db, b.id))?.position).toBe(2)
  })

  it('applies a moved card status and sprint within the reorder', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, {
      projectId: project.id,
      name: 'S'
    })
    const card = await createCard(ctx.db, { projectId: project.id, title: 'x' })
    expect(card.status).toBe('backlog')

    await reorderCards(ctx.db, {
      orderedIds: [card.id],
      moved: { id: card.id, status: 'todo', sprintId: sprint.id }
    })

    const reloaded = await getCard(ctx.db, card.id)
    expect(reloaded?.status).toBe('todo')
    expect(reloaded?.sprintId).toBe(sprint.id)
    expect(reloaded?.position).toBe(0)
  })
})

describe('doneAt timestamp', () => {
  it('stamps doneAt entering done (updateCard) and clears it on leaving', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'd',
      status: 'todo'
    })
    expect(card.doneAt ?? null).toBeNull()

    const done = await updateCard(ctx.db, { id: card.id, status: 'done' })
    expect(done?.doneAt).toBeInstanceOf(Date)

    const reopened = await updateCard(ctx.db, { id: card.id, status: 'in_progress' })
    expect(reopened?.doneAt ?? null).toBeNull()
  })

  it('preserves the stamp while done, re-stamps after leaving and returning', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'd',
      status: 'todo'
    })
    const done = await updateCard(ctx.db, { id: card.id, status: 'done' })
    const first = done?.doneAt as Date
    expect(first).toBeInstanceOf(Date)

    await updateCard(ctx.db, { id: card.id, title: 'renamed' })
    expect((await getCard(ctx.db, card.id))?.doneAt?.getTime()).toBe(first.getTime())

    await updateCard(ctx.db, { id: card.id, status: 'done' })
    expect((await getCard(ctx.db, card.id))?.doneAt?.getTime()).toBe(first.getTime())

    await updateCard(ctx.db, { id: card.id, status: 'todo' })
    expect((await getCard(ctx.db, card.id))?.doneAt ?? null).toBeNull()
    const again = await updateCard(ctx.db, { id: card.id, status: 'done' })
    expect(again?.doneAt).toBeInstanceOf(Date)
  })

  it('stamps doneAt when a card is created straight into done', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'born-done',
      status: 'done'
    })
    expect(card.doneAt).toBeInstanceOf(Date)
  })

  it('stamps and clears doneAt when reorderCards moves a card in and out of done', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'r',
      status: 'todo'
    })
    await reorderCards(ctx.db, {
      orderedIds: [card.id],
      moved: { id: card.id, status: 'done' }
    })
    expect((await getCard(ctx.db, card.id))?.doneAt).toBeInstanceOf(Date)

    await reorderCards(ctx.db, {
      orderedIds: [card.id],
      moved: { id: card.id, status: 'todo' }
    })
    expect((await getCard(ctx.db, card.id))?.doneAt ?? null).toBeNull()
  })
})

describe('listCards focused filters', () => {
  it('filters by a list of statuses', async () => {
    const project = await freshProject(ctx.db)
    await createCard(ctx.db, { projectId: project.id, title: 'a', status: 'todo' })
    await createCard(ctx.db, { projectId: project.id, title: 'b', status: 'in_progress' })
    await createCard(ctx.db, { projectId: project.id, title: 'c', status: 'done' })
    await createCard(ctx.db, { projectId: project.id, title: 'd', status: 'backlog' })

    const rows = await listCards(ctx.db, {
      projectId: project.id,
      status: ['todo', 'in_progress']
    })
    expect(rows.map(r => r.status).sort()).toEqual(['in_progress', 'todo'])
  })

  it('keeps the single-status filter working (back-compat)', async () => {
    const project = await freshProject(ctx.db)
    await createCard(ctx.db, { projectId: project.id, title: 'a', status: 'todo' })
    await createCard(ctx.db, { projectId: project.id, title: 'b', status: 'done' })

    const rows = await listCards(ctx.db, { projectId: project.id, status: 'done' })
    expect(rows.map(r => r.title)).toEqual(['b'])
  })

  it('activeOnly excludes done and backlog', async () => {
    const project = await freshProject(ctx.db)
    await createCard(ctx.db, { projectId: project.id, title: 'a', status: 'todo' })
    await createCard(ctx.db, { projectId: project.id, title: 'c', status: 'done' })
    await createCard(ctx.db, { projectId: project.id, title: 'd', status: 'backlog' })

    const rows = await listCards(ctx.db, { projectId: project.id, activeOnly: true })
    expect(rows.map(r => r.title)).toEqual(['a'])
  })

  it('filters by tag, resolved by id or name', async () => {
    const project = await freshProject(ctx.db)
    const tagged = await createCard(ctx.db, {
      projectId: project.id,
      title: 'tagged'
    })
    await createCard(ctx.db, { projectId: project.id, title: 'untagged' })
    const tag = await createTag(ctx.db, {
      projectId: project.id,
      name: 'bug',
      color: '#ef4444'
    })
    await addTagToCard(ctx.db, tagged.id, tag!.id)

    const byId = await listCards(ctx.db, { projectId: project.id, tag: tag!.id })
    expect(byId.map(r => r.title)).toEqual(['tagged'])
    const byName = await listCards(ctx.db, { projectId: project.id, tag: 'bug' })
    expect(byName.map(r => r.title)).toEqual(['tagged'])
  })

  it('caps with limit and pages with disjoint offset windows', async () => {
    const project = await freshProject(ctx.db)
    for (let i = 0; i < 5; i++) {
      await createCard(ctx.db, { projectId: project.id, title: `card-${i}` })
    }
    expect(await listCards(ctx.db, { projectId: project.id })).toHaveLength(5)

    const firstTwo = await listCards(ctx.db, { projectId: project.id, limit: 2 })
    expect(firstTwo).toHaveLength(2)

    const nextTwo = await listCards(ctx.db, {
      projectId: project.id,
      limit: 2,
      offset: 2
    })
    expect(nextTwo).toHaveLength(2)
    const seen = new Set(firstTwo.map(r => r.id))
    expect(nextTwo.every(r => !seen.has(r.id))).toBe(true)
  })
})

describe('getCardsByIds batch read', () => {
  it('returns full cards (with descriptionMd) by id, key, or a mix', async () => {
    // Resolves cards BY KEY, so use a unique prefix — the default 'CO' repeats
    // across the file's projects and would match the wrong cards.
    const project = await freshProject(ctx.db, uniqueKeyPrefix())
    const a = await createCard(ctx.db, {
      projectId: project.id,
      title: 'A',
      descriptionMd: 'body A'
    })
    const b = await createCard(ctx.db, {
      projectId: project.id,
      title: 'B',
      descriptionMd: 'body B'
    })

    const byId = await getCardsByIds(ctx.db, [a.id, b.id])
    expect(byId.map(r => r.title).sort()).toEqual(['A', 'B'])
    expect(byId.find(r => r.id === a.id)?.descriptionMd).toBe('body A')

    const byKey = await getCardsByIds(ctx.db, [a.key, b.key])
    expect(byKey.map(r => r.id).sort()).toEqual([a.id, b.id].sort())

    const mixed = await getCardsByIds(ctx.db, [a.id, b.key])
    expect(mixed).toHaveLength(2)
  })

  it('matches the descriptionMd a single get_card would return', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'detail',
      descriptionMd: '## full body'
    })
    const [batched] = await getCardsByIds(ctx.db, [card.id])
    const single = await getCard(ctx.db, card.id)
    expect(batched?.descriptionMd).toBe(single?.descriptionMd)
    expect(batched?.key).toBe(single?.key)
  })

  it('returns an empty array for no refs', async () => {
    expect(await getCardsByIds(ctx.db, [])).toEqual([])
  })
})

describe('createCard with tagIds', () => {
  it('attaches valid project tags at creation', async () => {
    const project = await freshProject(ctx.db)
    const bug = await createTag(ctx.db, {
      projectId: project.id,
      name: 'bug',
      color: '#ef4444'
    })
    const web = await createTag(ctx.db, {
      projectId: project.id,
      name: 'web',
      color: '#3b82f6'
    })
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'tagged on create',
      tagIds: [bug!.id, web!.id]
    })
    const reloaded = await getCard(ctx.db, card.id)
    expect(reloaded?.tags.map(t => t.name).sort()).toEqual(['bug', 'web'])
    const [listed] = await listCards(ctx.db, { projectId: project.id })
    expect(listed.tags.map(t => t.name).sort()).toEqual(['bug', 'web'])
  })

  it('dedups repeated tagIds into a single association', async () => {
    const project = await freshProject(ctx.db)
    const bug = await createTag(ctx.db, {
      projectId: project.id,
      name: 'bug',
      color: '#ef4444'
    })
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'dup tags',
      tagIds: [bug!.id, bug!.id, bug!.id]
    })
    const reloaded = await getCard(ctx.db, card.id)
    expect(reloaded?.tags.map(t => t.id)).toEqual([bug!.id])
  })

  it('rejects an unknown tagId and creates no card', async () => {
    const project = await freshProject(ctx.db)
    const before = await listCards(ctx.db, { projectId: project.id })
    await expect(
      createCard(ctx.db, {
        projectId: project.id,
        title: 'bad tag',
        tagIds: ['tag_does_not_exist']
      })
    ).rejects.toThrow()
    const after = await listCards(ctx.db, { projectId: project.id })
    expect(after).toHaveLength(before.length)
  })

  it('rejects a tag from another project and creates no card', async () => {
    const a = await freshProject(ctx.db)
    const b = await freshProject(ctx.db)
    const foreign = await createTag(ctx.db, {
      projectId: b.id,
      name: 'foreign',
      color: '#22c55e'
    })
    await expect(
      createCard(ctx.db, {
        projectId: a.id,
        title: 'cross-project tag',
        tagIds: [foreign!.id]
      })
    ).rejects.toThrow()
    expect(await listCards(ctx.db, { projectId: a.id })).toHaveLength(0)
  })

  it('creates an untagged card when tagIds is omitted', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'no tags'
    })
    const reloaded = await getCard(ctx.db, card.id)
    expect(reloaded?.tags).toEqual([])
  })
})
