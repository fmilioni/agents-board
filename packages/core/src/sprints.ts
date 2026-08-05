import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'

import { createId, type Database, schema } from '@agents-board/db'

import { archivedCondition, type ArchiveFilter } from './archive'
import { gcAttachmentsOnArchive, gcAttachmentsOnDestroy } from './attachmentGc'
import { relinkCardsAndComments } from './attachmentLinks'
import { getSystemSettings } from './authz'
import { relinkCommitImages } from './cardCommits'
import { notify } from './events'
import { syncIntakeForSprint } from './intake'
import { paginate } from './pagination'

export const createSprintInput = z.object({
  projectId: z.string(),
  roadmapId: z.string().optional(),
  name: z.string().min(1).max(120),
  goal: z.string().max(500).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional()
})
export type CreateSprintInput = z.infer<typeof createSprintInput>

export const updateSprintInput = z.object({
  id: z.string(),
  name: z.string().min(1).max(120).optional(),
  goal: z.string().max(500).nullable().optional()
})
export type UpdateSprintInput = z.infer<typeof updateSprintInput>

const sprintColumns = {
  id: schema.sprints.id,
  projectId: schema.sprints.projectId,
  roadmapId: schema.sprints.roadmapId,
  name: schema.sprints.name,
  goal: schema.sprints.goal,
  status: schema.sprints.status,
  startsAt: schema.sprints.startsAt,
  endsAt: schema.sprints.endsAt,
  createdAt: schema.sprints.createdAt,
  updatedAt: schema.sprints.updatedAt,
  archivedAt: schema.sprints.archivedAt
}

export async function listSprints(
  db: Database,
  projectId: string,
  filter?: ArchiveFilter,
  limit?: number,
  offset?: number
) {
  const conditions = [eq(schema.sprints.projectId, projectId)]
  const archived = archivedCondition(schema.sprints.archivedAt, filter)
  if (archived) conditions.push(archived)
  return paginate(
    db
      .select(sprintColumns)
      .from(schema.sprints)
      .where(and(...conditions))
      .orderBy(schema.sprints.createdAt)
      .$dynamic(),
    limit,
    offset
  )
}

/**
 * All active sprints of a project (a project may have several at once — the
 * single-active invariant was dropped in CO-399). Ordered stably by start date
 * then creation so the board and any consumer render them in a consistent order.
 */
export async function getActiveSprints(db: Database, projectId: string) {
  return db
    .select(sprintColumns)
    .from(schema.sprints)
    .where(
      and(
        eq(schema.sprints.projectId, projectId),
        eq(schema.sprints.status, 'active'),
        isNull(schema.sprints.archivedAt)
      )
    )
    .orderBy(schema.sprints.startsAt, schema.sprints.createdAt)
}

export async function getSprint(db: Database, id: string) {
  const [row] = await db
    .select(sprintColumns)
    .from(schema.sprints)
    .where(eq(schema.sprints.id, id))
    .limit(1)
  return row ?? null
}

export async function createSprint(db: Database, input: CreateSprintInput) {
  const parsed = createSprintInput.parse(input)
  const [row] = await db
    .insert(schema.sprints)
    .values({
      id: createId('spr'),
      projectId: parsed.projectId,
      roadmapId: parsed.roadmapId,
      name: parsed.name,
      goal: parsed.goal,
      startsAt: parsed.startsAt,
      endsAt: parsed.endsAt,
      status: 'planned'
    })
    .returning(sprintColumns)
  if (row) {
    await notify(db, {
      type: 'sprint.changed',
      projectId: row.projectId,
      sprintId: row.id
    })
  }
  return row
}

export async function updateSprint(db: Database, input: UpdateSprintInput) {
  const parsed = updateSprintInput.parse(input)
  const { id, ...rest } = parsed
  const [row] = await db
    .update(schema.sprints)
    .set({ ...rest, updatedAt: sql`now()` })
    .where(eq(schema.sprints.id, id))
    .returning(sprintColumns)
  if (row) {
    await notify(db, {
      type: 'sprint.changed',
      projectId: row.projectId,
      sprintId: row.id
    })
  }
  return row ?? null
}

// --- Archive / restore / destroy ---

export async function archiveSprint(db: Database, id: string) {
  const [row] = await db
    .update(schema.sprints)
    .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(schema.sprints.id, id))
    .returning(sprintColumns)
  if (row) {
    // Default: drop the diffs of every commit on this sprint's cards (the cards
    // stay active; only the heavy blobs go) — re-run attach-commit to restore.
    // With keepDiffsOnArchive on, the blobs are preserved.
    const sprintCardIds = (
      await db
        .select({ id: schema.cards.id })
        .from(schema.cards)
        .where(eq(schema.cards.sprintId, id))
    ).map(c => c.id)

    const { keepDiffsOnArchive } = await getSystemSettings(db)
    if (!keepDiffsOnArchive && sprintCardIds.length) {
      await db
        .update(schema.cardCommits)
        .set({ diff: null })
        .where(inArray(schema.cardCommits.cardId, sprintCardIds))
    }
    await gcAttachmentsOnArchive(db, {
      projectId: row.projectId,
      cardIds: sprintCardIds
    })
    await syncIntakeForSprint(db, row.projectId, row.id)
    await notify(db, {
      type: 'sprint.changed',
      projectId: row.projectId,
      sprintId: row.id
    })
  }
  return row ?? null
}

export async function restoreSprint(db: Database, id: string) {
  const [row] = await db
    .update(schema.sprints)
    .set({ archivedAt: null, updatedAt: sql`now()` })
    .where(eq(schema.sprints.id, id))
    .returning(sprintColumns)
  if (row) {
    // Re-link the sprint's cards (archive unlinked them) so the derived index
    // doesn't drift — same reason as restoreCard.
    const sprintCardIds = (
      await db
        .select({ id: schema.cards.id })
        .from(schema.cards)
        .where(eq(schema.cards.sprintId, id))
    ).map(c => c.id)
    await relinkCardsAndComments(db, sprintCardIds)
    await relinkCommitImages(db, sprintCardIds)
    await syncIntakeForSprint(db, row.projectId, row.id)
    await notify(db, {
      type: 'sprint.changed',
      projectId: row.projectId,
      sprintId: row.id
    })
  }
  return row ?? null
}

/**
 * Hard-delete a sprint and its cards. The `cards.sprintId` FK is `set null`,
 * so cards are deleted explicitly (their comments/tags/blockers cascade).
 */
export async function destroySprint(db: Database, id: string) {
  const row = await db.transaction(async (tx) => {
    const [sprint] = await tx
      .select({ id: schema.sprints.id, projectId: schema.sprints.projectId })
      .from(schema.sprints)
      .where(eq(schema.sprints.id, id))
      .limit(1)
    if (!sprint) return null
    const sprintCards = await tx
      .select({ id: schema.cards.id })
      .from(schema.cards)
      .where(eq(schema.cards.sprintId, id))
    await gcAttachmentsOnDestroy(tx, {
      projectId: sprint.projectId,
      cardIds: sprintCards.map(c => c.id)
    })
    await tx.delete(schema.cards).where(eq(schema.cards.sprintId, id))
    await tx.delete(schema.sprints).where(eq(schema.sprints.id, id))
    return sprint
  })
  if (row) {
    await notify(db, {
      type: 'sprint.deleted',
      projectId: row.projectId,
      sprintId: row.id
    })
  }
  return row ?? null
}

export async function startSprint(db: Database, sprintId: string) {
  const row = await db.transaction(async (tx) => {
    const [sprint] = await tx
      .select()
      .from(schema.sprints)
      .where(eq(schema.sprints.id, sprintId))
      .limit(1)
    if (!sprint) return null

    // Starting a sprint no longer touches the others — a project may have
    // several active at once (CO-399).
    const [activated] = await tx
      .update(schema.sprints)
      .set({
        status: 'active',
        startsAt: sql`COALESCE(${schema.sprints.startsAt}, now())`,
        updatedAt: sql`now()`
      })
      .where(eq(schema.sprints.id, sprintId))
      .returning(sprintColumns)
    return activated ?? null
  })
  if (row) {
    await notify(db, {
      type: 'sprint.changed',
      projectId: row.projectId,
      sprintId: row.id
    })
  }
  return row
}

/**
 * Reopen a completed (or archived) sprint back to `planned` so work can resume
 * or missing cards can be added. Clears `endsAt` and unarchives it in one move.
 * Never activates — reopening goes to `planned` and the user starts it
 * explicitly (a project may then hold several active sprints; CO-399).
 */
export async function reopenSprint(db: Database, sprintId: string) {
  const [row] = await db
    .update(schema.sprints)
    .set({
      status: 'planned',
      endsAt: null,
      archivedAt: null,
      updatedAt: sql`now()`
    })
    .where(eq(schema.sprints.id, sprintId))
    .returning(sprintColumns)
  if (row) {
    // Reopen un-archives (archivedAt → null), so re-link the cards just like
    // restoreSprint — archiveSprint unlinked them and the index would drift.
    const sprintCardIds = (
      await db
        .select({ id: schema.cards.id })
        .from(schema.cards)
        .where(eq(schema.cards.sprintId, sprintId))
    ).map(c => c.id)
    await relinkCardsAndComments(db, sprintCardIds)
    await relinkCommitImages(db, sprintCardIds)
    await syncIntakeForSprint(db, row.projectId, row.id)
    await notify(db, {
      type: 'sprint.changed',
      projectId: row.projectId,
      sprintId: row.id
    })
  }
  return row ?? null
}

/**
 * Move an ACTIVE sprint back to `planned` — the inverse of starting it, without
 * completing it. The cards stay assigned (`sprintId` untouched); the sprint just
 * stops counting as active, so it drops off the board (which shows only active
 * sprints). Nothing is concluded: `endsAt` is left alone, and `startsAt` is
 * preserved so restarting keeps its original start. Distinct from `reopenSprint`
 * (completed/archived → planned, unarchives + relinks) and `completeSprint`.
 * No-op (returns null) unless the sprint is currently active.
 */
export async function deactivateSprint(db: Database, sprintId: string) {
  const [row] = await db
    .update(schema.sprints)
    .set({ status: 'planned', updatedAt: sql`now()` })
    .where(
      and(
        eq(schema.sprints.id, sprintId),
        eq(schema.sprints.status, 'active')
      )
    )
    .returning(sprintColumns)
  if (row) {
    await notify(db, {
      type: 'sprint.changed',
      projectId: row.projectId,
      sprintId: row.id
    })
  }
  return row ?? null
}

export async function completeSprint(db: Database, sprintId: string) {
  const [row] = await db
    .update(schema.sprints)
    .set({
      status: 'completed',
      endsAt: sql`COALESCE(${schema.sprints.endsAt}, now())`,
      updatedAt: sql`now()`
    })
    .where(eq(schema.sprints.id, sprintId))
    .returning(sprintColumns)
  if (row) {
    await notify(db, {
      type: 'sprint.changed',
      projectId: row.projectId,
      sprintId: row.id
    })
  }
  return row ?? null
}
