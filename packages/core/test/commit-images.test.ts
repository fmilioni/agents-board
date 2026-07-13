import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { schema } from '@claude-organizer/db'
import {
  buildDiffImageSentinel,
  type DiffImageRefs,
  WORKING_TREE_SHA
} from '@claude-organizer/shared'

import {
  archiveCard,
  attachCardCommit,
  clearWorkingTreeCommit,
  createAttachment,
  createCard,
  destroyCard,
  getAttachment,
  restoreCard,
  setKeepDiffsOnArchive,
  updateCard
} from '../src/index'
import { freshProject, uniqueKeyPrefix, useTestDb } from './helpers'

// Isolated DB: these tests flip the global `keepDiffsOnArchive` toggle, and their archive
// assertions also depend on `keepAttachmentsOnArchive` staying at its default — see
// attachment-gc.test.ts.
const ctx = useTestDb({ isolated: true })

async function image(projectId: string) {
  return createAttachment(ctx.db, {
    projectId,
    mime: 'image/png',
    data: Buffer.from('img', 'utf8'),
    width: 1,
    height: 1
  })
}

const ref = (id: string) => `body ![pic](/attachments/${id})`

// A one-file diff whose binary marker is the image sentinel for the given refs.
function imageDiff(refs: DiffImageRefs) {
  return `diff --git a/logo.png b/logo.png\n${buildDiffImageSentinel(refs)}\n`
}

async function commitLinks(cardId: string, attId: string) {
  const rows = await ctx.db
    .select()
    .from(schema.attachmentLinks)
    .where(
      and(
        eq(schema.attachmentLinks.itemType, 'commit'),
        eq(schema.attachmentLinks.itemId, cardId),
        eq(schema.attachmentLinks.attachmentId, attId)
      )
    )
  return rows.length
}

const exists = async (id: string) => (await getAttachment(ctx.db, id)) != null
async function orphanedAt(id: string) {
  return (await getAttachment(ctx.db, id))?.orphanedAt ?? null
}
async function hasBytes(id: string) {
  return (await getAttachment(ctx.db, id))?.data != null
}

async function cardWithImageCommit(sha = 'abc1234') {
  const project = await freshProject(ctx.db, uniqueKeyPrefix())
  const card = await createCard(ctx.db, { projectId: project.id, title: 'C' })
  const att = await image(project.id) // born orphan
  await attachCardCommit(ctx.db, {
    cardKey: card.key,
    sha,
    message: 'feat: add logo',
    diff: imageDiff({ new: att.id })
  })
  return { project, card, att }
}

describe('commit diff-image links', () => {
  it('links a diff image to its card and clears its orphan clock on diff write', async () => {
    const { card, att } = await cardWithImageCommit()
    expect(await commitLinks(card.id, att.id)).toBe(1)
    expect(await orphanedAt(att.id)).toBeNull()
  })

  it('frees the image when the diff is replaced without it', async () => {
    const { card, att } = await cardWithImageCommit('abc1234')
    // Re-attach the same commit with a diff that no longer cites the image.
    await attachCardCommit(ctx.db, {
      cardKey: card.key,
      sha: 'abc1234',
      message: 'feat: add logo',
      diff: 'diff --git a/readme.md b/readme.md\n+text\n'
    })
    expect(await commitLinks(card.id, att.id)).toBe(0)
    // Back to orphan → eligible for the deferred sweep.
    expect(await orphanedAt(att.id)).not.toBeNull()
  })

  it('frees a pending working-tree image when the diff is cleared', async () => {
    const project = await freshProject(ctx.db, uniqueKeyPrefix())
    const card = await createCard(ctx.db, { projectId: project.id, title: 'C' })
    const att = await image(project.id)
    await attachCardCommit(ctx.db, {
      cardKey: card.key,
      sha: WORKING_TREE_SHA,
      message: '(uncommitted working tree)',
      diff: imageDiff({ old: att.id, new: att.id })
    })
    expect(await commitLinks(card.id, att.id)).toBe(1)

    await clearWorkingTreeCommit(ctx.db, card.key)
    expect(await commitLinks(card.id, att.id)).toBe(0)
  })

  it('hard-deletes the diff images when the card is destroyed', async () => {
    const { card, att } = await cardWithImageCommit()

    await destroyCard(ctx.db, card.id)

    expect(await exists(att.id)).toBe(false)
  })

  it('zeroes the diff image bytes on archive (row kept)', async () => {
    const { card, att } = await cardWithImageCommit()

    await archiveCard(ctx.db, card.id)

    expect(await exists(att.id)).toBe(true) // row kept
    expect(await hasBytes(att.id)).toBe(false) // bytes zeroed
    expect(await commitLinks(card.id, att.id)).toBe(0)
  })

  it('re-derives the commit link on restore when the diff is kept on archive', async () => {
    await setKeepDiffsOnArchive(ctx.db, true)
    try {
      const { card, att } = await cardWithImageCommit()

      // Diff (and its sentinel) is preserved, but the image is unlinked and its
      // bytes zeroed on archive.
      await archiveCard(ctx.db, card.id)
      expect(await commitLinks(card.id, att.id)).toBe(0)

      // restore rebuilds the 'commit' link from the kept diff (bytes stay null).
      await restoreCard(ctx.db, card.id)
      expect(await commitLinks(card.id, att.id)).toBe(1)
    } finally {
      await setKeepDiffsOnArchive(ctx.db, false)
    }
  })

  it('keeps a diff image still cited by the card body when the diff is cleared', async () => {
    const project = await freshProject(ctx.db, uniqueKeyPrefix())
    const card = await createCard(ctx.db, { projectId: project.id, title: 'C' })
    const att = await image(project.id)
    await updateCard(ctx.db, { id: card.id, descriptionMd: ref(att.id) })
    await attachCardCommit(ctx.db, {
      cardKey: card.key,
      sha: WORKING_TREE_SHA,
      message: '(uncommitted working tree)',
      diff: imageDiff({ new: att.id })
    })

    await clearWorkingTreeCommit(ctx.db, card.key)

    // The 'commit' link is gone, but the 'card' body link keeps it alive.
    expect(await commitLinks(card.id, att.id)).toBe(0)
    expect(await exists(att.id)).toBe(true)
    expect(await orphanedAt(att.id)).toBeNull()
  })
})
