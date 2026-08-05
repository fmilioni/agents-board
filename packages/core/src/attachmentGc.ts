import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'

import { type Database, schema } from '@agents-board/db'

import { getSystemSettings } from './authz'

// A scope entering an archive or destroy: the cards (archive/destroy), the doc
// subtree (destroy only) and the inbox items. Reclaim is now pure ref-counting
// over `attachment_links` — no body scan, no owner/archivedAt reasoning. The
// link exists only while a ref exists in a body, so a shared image survives
// until its LAST link is removed, by construction.
interface GcScope {
  projectId: string
  cardIds?: string[]
  docIds?: string[]
  intakeIds?: string[]
}

const uniq = (ids: string[]): string[] => [...new Set(ids)]

// An attachment with no remaining link.
const unreferenced = sql`not exists (select 1 from ${schema.attachmentLinks} where ${schema.attachmentLinks.attachmentId} = ${schema.attachments.id})`

// Edit orphans (a body's ref removed) are reclaimed only after this fixed grace
// window — an undo (re-adding the ref) inside it re-links and clears the clock
// (reconcile), cancelling the sweep. A system constant by decision, no toggle.
export const ORPHAN_GRACE_MINUTES = 60

// Opportunistic, scheduler-less collection of EDIT orphans: hard-deletes the
// attachments whose grace window elapsed and that still have no link (the item
// is alive and cites nothing — there's nothing to restore, unlike an archive
// orphan whose bytes are merely zeroed). Idempotent and concurrency-safe — the
// predicate re-checks live state, so a concurrent undo (clears orphaned_at, adds
// a link) drops the row from the match. Piggybacks on frequent paths (upload,
// archive/destroy) instead of a background job. orphaned_at NULL never matches.
export async function sweepOrphanAttachments(
  db: Database,
  opts: { projectId?: string } = {}
): Promise<void> {
  const conds = [
    sql`${schema.attachments.orphanedAt} < now() - make_interval(mins => ${ORPHAN_GRACE_MINUTES})`,
    unreferenced
  ]
  if (opts.projectId)
    conds.push(eq(schema.attachments.projectId, opts.projectId))
  await db.delete(schema.attachments).where(and(...conds))
}

// The link rows belonging to a scope. A comment has no independent lifecycle —
// it lives and dies with its card — so the scope's cards drag in their comments'
// links too. itemId has no FK, so these rows must be removed explicitly (they'd
// dangle otherwise once the items are gone).
async function scopeLinkConditions(db: Database, scope: GcScope) {
  const cardIds = scope.cardIds ?? []
  const docIds = scope.docIds ?? []
  const intakeIds = scope.intakeIds ?? []
  const conds = []
  if (cardIds.length) {
    conds.push(
      and(
        eq(schema.attachmentLinks.itemType, 'card'),
        inArray(schema.attachmentLinks.itemId, cardIds)
      )
    )
    // Diff images are linked to their card under the 'commit' item type; they
    // share the card's lifecycle, so archive/destroy reclaim them alongside it.
    conds.push(
      and(
        eq(schema.attachmentLinks.itemType, 'commit'),
        inArray(schema.attachmentLinks.itemId, cardIds)
      )
    )
    const commentIds = (
      await db
        .select({ id: schema.comments.id })
        .from(schema.comments)
        .where(inArray(schema.comments.cardId, cardIds))
    ).map(c => c.id)
    if (commentIds.length)
      conds.push(
        and(
          eq(schema.attachmentLinks.itemType, 'comment'),
          inArray(schema.attachmentLinks.itemId, commentIds)
        )
      )
  }
  if (docIds.length)
    conds.push(
      and(
        eq(schema.attachmentLinks.itemType, 'doc'),
        inArray(schema.attachmentLinks.itemId, docIds)
      )
    )
  if (intakeIds.length)
    conds.push(
      and(
        eq(schema.attachmentLinks.itemType, 'inbox'),
        inArray(schema.attachmentLinks.itemId, intakeIds)
      )
    )
  return conds
}

// Removes a scope's links and returns the attachment ids they pointed at — the
// candidates whose remaining link count the caller re-checks to decide reclaim.
async function unlinkScope(db: Database, scope: GcScope): Promise<string[]> {
  const conds = await scopeLinkConditions(db, scope)
  if (!conds.length) return []
  const match = conds.length === 1 ? conds[0] : or(...conds)
  const affected = uniq(
    (
      await db
        .select({ attachmentId: schema.attachmentLinks.attachmentId })
        .from(schema.attachmentLinks)
        .where(match)
    ).map(r => r.attachmentId)
  )
  await db.delete(schema.attachmentLinks).where(match)
  return affected
}

// Archive reclaim: unlink the scope, then zero the bytes of every attachment
// left with no link (row kept — restorable; mirrors the diff drop). A shared
// image cited by an out-of-scope body keeps its link and survives. We do NOT
// stamp `orphanedAt` here: an archive orphan is a restorable byte-null row, not
// a swept one — only an EDIT orphan (CO-296) starts the grace clock. The
// `keepAttachmentsOnArchive` toggle skips the whole thing (links and bytes
// stay), so restore is a no-op for it.
export async function gcAttachmentsOnArchive(
  db: Database,
  scope: GcScope
): Promise<void> {
  // Edit-orphan collection is independent of the keep-on-archive toggle below.
  await sweepOrphanAttachments(db, { projectId: scope.projectId })
  const { keepAttachmentsOnArchive } = await getSystemSettings(db)
  if (keepAttachmentsOnArchive) return
  const affected = await unlinkScope(db, scope)
  if (!affected.length) return
  await db
    .update(schema.attachments)
    .set({ data: null })
    .where(
      and(
        inArray(schema.attachments.id, affected),
        isNotNull(schema.attachments.data),
        unreferenced
      )
    )
}

// Destroy reclaim: unlink the scope, then hard-delete every attachment left with
// no link. Permanent (no restore), so the row goes — not just the bytes — and
// the toggle is ignored. Runs inside the caller's transaction, before the
// entities are deleted, so a surviving out-of-scope link still protects its row.
export async function gcAttachmentsOnDestroy(
  db: Database,
  scope: GcScope
): Promise<void> {
  await sweepOrphanAttachments(db, { projectId: scope.projectId })
  const affected = await unlinkScope(db, scope)
  if (!affected.length) return
  await db
    .delete(schema.attachments)
    .where(and(inArray(schema.attachments.id, affected), unreferenced))
}
