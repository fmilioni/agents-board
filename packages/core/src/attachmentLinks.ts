import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import { type Database, schema } from '@agents-board/db'
import type { AttachmentOwnerType } from '@agents-board/shared'

import { attachmentIdsInBody } from './attachments'

// item_type reuses the attachment owner types (card|comment|doc|inbox).
export type AttachmentItemType = AttachmentOwnerType

// The attachments referenced in a set of same-type items' bodies, via the link
// index. One query for a whole list (a comment/inbox page) instead of N; each row
// carries its `itemId` so the caller can group them back. Metadata only — no bytes.
export async function listAttachmentsByItems(
  db: Database,
  itemType: AttachmentItemType,
  itemIds: string[]
) {
  if (!itemIds.length) return []
  return db
    .select({
      itemId: schema.attachmentLinks.itemId,
      id: schema.attachments.id,
      mime: schema.attachments.mime,
      width: schema.attachments.width,
      height: schema.attachments.height,
      description: schema.attachments.description
    })
    .from(schema.attachmentLinks)
    .innerJoin(
      schema.attachments,
      eq(schema.attachmentLinks.attachmentId, schema.attachments.id)
    )
    .where(
      and(
        eq(schema.attachmentLinks.itemType, itemType),
        inArray(schema.attachmentLinks.itemId, itemIds)
      )
    )
    .orderBy(desc(schema.attachments.createdAt))
}

// Reconciles the derived link index for one item against its markdown: the body
// is the source of truth, so we insert the tokens it now cites and delete the
// links whose token left the body. Idempotent — same body twice is a no-op. Runs
// in the caller's transaction (pass the tx) so a link never diverges from the
// persisted body. Also the basis for the backup rebuild on import.
export async function reconcileAttachmentLinks(
  db: Database,
  itemType: AttachmentItemType,
  itemId: string,
  bodyMd: string | null | undefined
): Promise<void> {
  const desired = new Set(attachmentIdsInBody(bodyMd))
  const existing = new Set(
    (
      await db
        .select({ attachmentId: schema.attachmentLinks.attachmentId })
        .from(schema.attachmentLinks)
        .where(
          and(
            eq(schema.attachmentLinks.itemType, itemType),
            eq(schema.attachmentLinks.itemId, itemId)
          )
        )
    ).map(r => r.attachmentId)
  )

  const toAdd = [...desired].filter(id => !existing.has(id))
  const toRemove = [...existing].filter(id => !desired.has(id))
  if (!toAdd.length && !toRemove.length) return

  if (toAdd.length) {
    // FK-safe: only link tokens that resolve to a real attachment (a dangling
    // ref — e.g. pasted markdown citing a foreign id — would trip the FK).
    const valid = (
      await db
        .select({ id: schema.attachments.id })
        .from(schema.attachments)
        .where(inArray(schema.attachments.id, toAdd))
    ).map(r => r.id)
    if (valid.length)
      await db
        .insert(schema.attachmentLinks)
        .values(valid.map(attachmentId => ({ attachmentId, itemType, itemId })))
        .onConflictDoNothing()
  }

  if (toRemove.length)
    await db
      .delete(schema.attachmentLinks)
      .where(
        and(
          eq(schema.attachmentLinks.itemType, itemType),
          eq(schema.attachmentLinks.itemId, itemId),
          inArray(schema.attachmentLinks.attachmentId, toRemove)
        )
      )

  await refreshOrphanedAt(db, [...new Set([...toAdd, ...toRemove])])
}

// Re-establishes links for a set of cards (and their comments) from the current
// bodies. Archive removes the scope's links directly (not via reconcile), so on
// restore the derived index would stay stale — and could later collect an
// attachment the restored card still references. Idempotent: a no-op when the
// links are already present (e.g. the keep-on-archive toggle never removed them).
export async function relinkCardsAndComments(
  db: Database,
  cardIds: string[]
): Promise<void> {
  if (!cardIds.length) return
  const cards = await db
    .select({ id: schema.cards.id, body: schema.cards.descriptionMd })
    .from(schema.cards)
    .where(inArray(schema.cards.id, cardIds))
  for (const c of cards) await reconcileAttachmentLinks(db, 'card', c.id, c.body)
  const comments = await db
    .select({ id: schema.comments.id, body: schema.comments.bodyMd })
    .from(schema.comments)
    .where(inArray(schema.comments.cardId, cardIds))
  for (const cm of comments)
    await reconcileAttachmentLinks(db, 'comment', cm.id, cm.body)
}

// Re-derives `orphaned_at` from the actual current link count for the touched
// attachments (not from toAdd/toRemove), so it's correct under concurrency: a
// row that just hit 0 links and has no clock yet starts it; one that has links
// again clears it (an undo inside the grace window cancels the sweep).
async function refreshOrphanedAt(
  db: Database,
  attachmentIds: string[]
): Promise<void> {
  if (!attachmentIds.length) return
  const hasLink = sql`exists (select 1 from ${schema.attachmentLinks} where ${schema.attachmentLinks.attachmentId} = ${schema.attachments.id})`
  await db
    .update(schema.attachments)
    .set({ orphanedAt: sql`now()` })
    .where(
      and(
        inArray(schema.attachments.id, attachmentIds),
        isNull(schema.attachments.orphanedAt),
        sql`not ${hasLink}`
      )
    )
  await db
    .update(schema.attachments)
    .set({ orphanedAt: null })
    .where(
      and(
        inArray(schema.attachments.id, attachmentIds),
        isNotNull(schema.attachments.orphanedAt),
        hasLink
      )
    )
}
