import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { createId, type Database, schema } from '@agents-board/db'
import { parseDiffImageSentinel, WORKING_TREE_SHA } from '@agents-board/shared'

import { reconcileAttachmentLinks } from './attachmentLinks'
import { InputError } from './errors'
import { notify } from './events'

// The att ids a set of diffs reference via image sentinels — scoped to the
// sentinel lines so an `att_`-shaped token elsewhere in the patch content can't
// wrongly link an attachment. Joined into a space-separated "body" so it feeds
// straight into reconcileAttachmentLinks (which extracts att tokens from a body).
export function commitImageLinkBody(
  diffs: Array<string | null | undefined>
): string {
  const ids: string[] = []
  for (const diff of diffs) {
    if (!diff) continue
    for (const line of diff.split('\n')) {
      const refs = parseDiffImageSentinel(line)
      if (refs?.old) ids.push(refs.old)
      if (refs?.new) ids.push(refs.new)
    }
  }
  return ids.join(' ')
}

// Re-derives the card's diff-image links from the att ids cited across ALL its
// stored diffs (the diffs are the source of truth, reconciled like a markdown
// body). Run after every diff write/clear so replacing or dropping a diff frees
// the images it no longer references (their ref-count can then reach zero and the
// orphan sweep collects them); a re-capture of the same commit re-links the fresh
// ids. Uses the 'commit' item type, which the body reconcile never touches.
async function reconcileCommitImages(tx: Database, cardId: string): Promise<void> {
  const rows = await tx
    .select({ diff: schema.cardCommits.diff })
    .from(schema.cardCommits)
    .where(eq(schema.cardCommits.cardId, cardId))
  await reconcileAttachmentLinks(
    tx,
    'commit',
    cardId,
    commitImageLinkBody(rows.map(r => r.diff))
  )
}

// Re-establishes the 'commit' links for a set of cards from their kept diffs —
// the restore counterpart to relinkCardsAndComments. Archive unlinked them; with
// keepDiffsOnArchive on the diff (and its sentinel) survives, so the link must be
// rebuilt or the derived index drifts. Bytes stay null when keepAttachmentsOnArchive
// is off (restore never recovers bytes — same as a body image).
export async function relinkCommitImages(
  db: Database,
  cardIds: string[]
): Promise<void> {
  for (const cardId of cardIds) await reconcileCommitImages(db, cardId)
}

// Server-side safeguards. The capture script already prunes lockfiles/binaries
// and truncates huge files, but cap the payload here too so a misbehaving
// client can't store an unbounded blob.
const MAX_DIFF_CHARS = 1_000_000
const MAX_STAT_CHARS = 100_000

export const attachCardCommitInput = z.object({
  // The script knows the card key (parsed from the commit message), not the id.
  cardKey: z.string().min(1),
  sha: z.string().min(1),
  message: z.string().min(1),
  stat: z.string().max(MAX_STAT_CHARS).nullish(),
  diff: z.string().max(MAX_DIFF_CHARS).nullish(),
  // ISO string on the wire (git's `%cI`); stored as a timestamptz `Date`.
  committedAt: z
    .string()
    .nullish()
    .transform(v => (v ? new Date(v) : null)),
  authorName: z.string().nullish()
})
// The function takes the wire input (committedAt as string); `.parse()` yields
// the output shape (committedAt as Date).
export type AttachCardCommitInput = z.input<typeof attachCardCommitInput>

/**
 * Attach (or re-attach) a commit to the card whose key matches `cardKey`.
 * Upserts on `(cardId, sha)` so re-running for the same commit — e.g. after an
 * `amend` — updates the stored diff instead of duplicating it.
 */
export async function attachCardCommit(
  db: Database,
  input: AttachCardCommitInput
) {
  const parsed = attachCardCommitInput.parse(input)
  const [card] = await db
    .select({ id: schema.cards.id, projectId: schema.cards.projectId })
    .from(schema.cards)
    .where(eq(schema.cards.key, parsed.cardKey))
    .limit(1)
  if (!card) {
    throw new InputError(`Card ${parsed.cardKey} not found`)
  }
  const values = {
    message: parsed.message,
    stat: parsed.stat ?? null,
    diff: parsed.diff ?? null,
    committedAt: parsed.committedAt ?? null,
    authorName: parsed.authorName ?? null
  }
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.cardCommits)
      .values({
        id: createId('ccm'),
        cardId: card.id,
        sha: parsed.sha,
        ...values
      })
      .onConflictDoUpdate({
        target: [schema.cardCommits.cardId, schema.cardCommits.sha],
        set: values
      })
      .returning()

    // The guard stops a sentinel upsert from deleting the row it just wrote.
    if (parsed.sha !== WORKING_TREE_SHA) {
      await tx
        .delete(schema.cardCommits)
        .where(
          and(
            eq(schema.cardCommits.cardId, card.id),
            eq(schema.cardCommits.sha, WORKING_TREE_SHA)
          )
        )
    }
    await reconcileCommitImages(tx, card.id)
    return inserted
  })

  if (row) {
    await notify(db, {
      type: 'commit.changed',
      projectId: card.projectId,
      cardId: card.id,
      commitId: row.id
    })
  }
  return row
}

export async function clearWorkingTreeCommit(db: Database, cardKey: string) {
  const [card] = await db
    .select({ id: schema.cards.id, projectId: schema.cards.projectId })
    .from(schema.cards)
    .where(eq(schema.cards.key, cardKey))
    .limit(1)
  if (!card) {
    throw new InputError(`Card ${cardKey} not found`)
  }
  const row = await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(schema.cardCommits)
      .where(
        and(
          eq(schema.cardCommits.cardId, card.id),
          eq(schema.cardCommits.sha, WORKING_TREE_SHA)
        )
      )
      .returning()
    // Dropping the pending diff frees the images only it referenced.
    if (deleted) await reconcileCommitImages(tx, card.id)
    return deleted ?? null
  })
  if (row) {
    await notify(db, {
      type: 'commit.changed',
      projectId: card.projectId,
      cardId: card.id,
      commitId: row.id
    })
  }
  return row
}

export async function listCardCommits(db: Database, cardId: string) {
  return db
    .select()
    .from(schema.cardCommits)
    .where(eq(schema.cardCommits.cardId, cardId))
    .orderBy(
      // Oldest → newest. Explicit NULLS LAST keeps the working-tree sentinel
      // (null committedAt) at the end — it's the newest state of all, after
      // every real commit — independent of the DB's NULLS default.
      sql`${schema.cardCommits.committedAt} asc nulls last`,
      asc(schema.cardCommits.createdAt)
    )
}

/**
 * Fetch a single attached commit by sha — with its (possibly null) diff. When
 * the same sha is attached to several cards, `cardId` narrows it; otherwise the
 * first match is returned (the diff is identical across cards).
 */
export async function getCommitBySha(
  db: Database,
  sha: string,
  cardId?: string
) {
  const [row] = await db
    .select()
    .from(schema.cardCommits)
    .where(
      cardId
        ? and(
            eq(schema.cardCommits.sha, sha),
            eq(schema.cardCommits.cardId, cardId)
          )
        : eq(schema.cardCommits.sha, sha)
    )
    .limit(1)
  return row ?? null
}
