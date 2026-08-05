import { describe, expect, it } from 'vitest'

import { WORKING_TREE_SHA } from '@agents-board/shared'

import { attachCardCommit, createCard, listCardCommits } from '../src/index'
import { freshProject, uniqueKeyPrefix, useTestDb } from './helpers'

const ctx = useTestDb()

describe('listCardCommits ordering', () => {
  it('lists real commits oldest→newest with the working-tree sentinel last', async () => {
    // attachCardCommit resolves the card by key alone — a unique prefix keeps
    // this card's key unambiguous (see `uniqueKeyPrefix`).
    const project = await freshProject(ctx.db, uniqueKeyPrefix())
    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'Card'
    })

    // Attach out of chronological order to prove the ordering comes from the
    // query, not insertion order.
    await attachCardCommit(ctx.db, {
      cardKey: card.key,
      sha: 'newer567',
      message: 'newer commit',
      committedAt: '2026-02-01T00:00:00.000Z'
    })
    await attachCardCommit(ctx.db, {
      cardKey: card.key,
      sha: 'older123',
      message: 'older commit',
      committedAt: '2026-01-01T00:00:00.000Z'
    })
    // Attach the sentinel last: a real-commit attach prunes any sentinel, but a
    // sentinel attach leaves the real commits, so all rows coexist here.
    await attachCardCommit(ctx.db, {
      cardKey: card.key,
      sha: WORKING_TREE_SHA,
      message: 'uncommitted',
      committedAt: null
    })

    const commits = await listCardCommits(ctx.db, card.id)
    expect(commits.map(c => c.sha)).toEqual([
      'older123',
      'newer567',
      WORKING_TREE_SHA
    ])
  })
})
