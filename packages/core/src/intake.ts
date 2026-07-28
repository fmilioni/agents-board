import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { z } from 'zod'

import { createId, type Database, schema } from '@claude-organizer/db'
import {
  type CardStatus,
  INTAKE_STATUSES,
  type IntakeStatus
} from '@claude-organizer/shared'

import { gcAttachmentsOnArchive, gcAttachmentsOnDestroy } from './attachmentGc'
import { reconcileAttachmentLinks } from './attachmentLinks'
import { notify } from './events'
import { paginate } from './pagination'

export const createIntakeItemInput = z.object({
  projectId: z.string(),
  bodyMd: z.string().min(1)
})
export type CreateIntakeItemInput = z.infer<typeof createIntakeItemInput>

export const updateIntakeItemInput = z.object({
  id: z.string(),
  bodyMd: z.string().min(1)
})
export type UpdateIntakeItemInput = z.infer<typeof updateIntakeItemInput>

export const intakeStatus = z.enum(INTAKE_STATUSES)

const intakeColumns = {
  id: schema.intakeItems.id,
  projectId: schema.intakeItems.projectId,
  bodyMd: schema.intakeItems.bodyMd,
  status: schema.intakeItems.status,
  plannedCardKeys: schema.intakeItems.plannedCardKeys,
  createdAt: schema.intakeItems.createdAt,
  updatedAt: schema.intakeItems.updatedAt,
  archivedAt: schema.intakeItems.archivedAt
}

async function notifyChanged(db: Database, row: { id: string, projectId: string }) {
  await notify(db, {
    type: 'inbox.changed',
    projectId: row.projectId,
    intakeId: row.id
  })
}

export function parseCardKeys(csv: string | null): string[] {
  return (csv ?? '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)
}

interface CardState {
  status: CardStatus
  archived: boolean
}

/** Resolve card keys → their live status/archived, scoped to the project. */
export async function cardStatesByKeys(
  db: Database,
  projectId: string,
  keys: string[]
): Promise<Map<string, CardState>> {
  const map = new Map<string, CardState>()
  if (keys.length === 0) return map
  const rows = await db
    .select({
      key: schema.cards.key,
      status: schema.cards.status,
      archivedAt: schema.cards.archivedAt,
      sprintArchivedAt: schema.sprints.archivedAt
    })
    .from(schema.cards)
    .leftJoin(schema.sprints, eq(schema.cards.sprintId, schema.sprints.id))
    .where(
      and(eq(schema.cards.projectId, projectId), inArray(schema.cards.key, keys))
    )
  for (const r of rows) {
    map.set(r.key, {
      status: r.status,
      archived: r.archivedAt !== null || r.sprintArchivedAt !== null
    })
  }
  return map
}

/** Completed = ≥1 referenced card is non-archived and all such are `done`. */
function deriveCompleted(
  plannedCardKeys: string | null,
  states: Map<string, CardState>
): boolean {
  const active = parseCardKeys(plannedCardKeys)
    .map(k => states.get(k))
    .filter((c): c is CardState => c !== undefined && !c.archived)
  return active.length > 0 && active.every(c => c.status === 'done')
}

export async function listIntakeItems(
  db: Database,
  projectId: string,
  options: { status?: IntakeStatus, limit?: number, offset?: number } = {}
) {
  const conditions = [eq(schema.intakeItems.projectId, projectId)]
  if (options.status) {
    conditions.push(eq(schema.intakeItems.status, options.status))
  }
  const items = await paginate(
    db
      .select(intakeColumns)
      .from(schema.intakeItems)
      .where(and(...conditions))
      .orderBy(desc(schema.intakeItems.createdAt))
      .$dynamic(),
    options.limit,
    options.offset
  )

  const keys = [...new Set(items.flatMap(i => parseCardKeys(i.plannedCardKeys)))]
  const states = await cardStatesByKeys(db, projectId, keys)
  return items.map(item => ({
    ...item,
    completed: deriveCompleted(item.plannedCardKeys, states)
  }))
}

export async function createIntakeItem(db: Database, input: CreateIntakeItemInput) {
  const parsed = createIntakeItemInput.parse(input)
  const [row] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.intakeItems)
      .values({
        id: createId('itk'),
        projectId: parsed.projectId,
        bodyMd: parsed.bodyMd
      })
      .returning(intakeColumns)
    if (inserted[0])
      await reconcileAttachmentLinks(tx, 'inbox', inserted[0].id, parsed.bodyMd)
    return inserted
  })
  if (row) await notifyChanged(db, row)
  return row
}

export async function updateIntakeItem(db: Database, input: UpdateIntakeItemInput) {
  const parsed = updateIntakeItemInput.parse(input)
  const [row] = await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.intakeItems)
      .set({ bodyMd: parsed.bodyMd, updatedAt: sql`now()` })
      .where(eq(schema.intakeItems.id, parsed.id))
      .returning(intakeColumns)
    if (updated[0])
      await reconcileAttachmentLinks(tx, 'inbox', updated[0].id, parsed.bodyMd)
    return updated
  })
  if (row) await notifyChanged(db, row)
  return row ?? null
}

export async function markIntakePlanned(
  db: Database,
  id: string,
  cardKeys: string[]
) {
  const keys = cardKeys.filter(Boolean).join(',')
  const [row] = await db
    .update(schema.intakeItems)
    .set({
      status: 'planned',
      plannedCardKeys: keys || null,
      archivedAt: null,
      updatedAt: sql`now()`
    })
    .where(eq(schema.intakeItems.id, id))
    .returning(intakeColumns)
  if (row) await notifyChanged(db, row)
  return row ?? null
}

export async function archiveIntakeItem(db: Database, id: string) {
  const [row] = await db
    .update(schema.intakeItems)
    .set({ status: 'archived', archivedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(schema.intakeItems.id, id))
    .returning(intakeColumns)
  if (row) {
    await gcAttachmentsOnArchive(db, { projectId: row.projectId, intakeIds: [id] })
    await notifyChanged(db, row)
  }
  return row ?? null
}

/**
 * Bring an archived demand back, in the status its cards justify: `planned`
 * only while at least one referenced card is still active, `pending` otherwise.
 * The keys are kept either way.
 */
export async function restoreIntakeItem(db: Database, id: string) {
  const [current] = await db
    .select()
    .from(schema.intakeItems)
    .where(eq(schema.intakeItems.id, id))
    .limit(1)
  if (!current) return null
  const nextStatus = (await hasActiveCard(db, current)) ? 'planned' : 'pending'
  const [row] = await db
    .update(schema.intakeItems)
    .set({ status: nextStatus, archivedAt: null, updatedAt: sql`now()` })
    .where(eq(schema.intakeItems.id, id))
    .returning(intakeColumns)
  if (row) {
    // Archive unlinked this item; re-establish its links so the index doesn't drift.
    await reconcileAttachmentLinks(db, 'inbox', id, current.bodyMd)
    await notifyChanged(db, row)
  }
  return row ?? null
}

function hasActive(keys: string[], states: Map<string, CardState>): boolean {
  return keys.some((k) => {
    const state = states.get(k)
    return state !== undefined && !state.archived
  })
}

async function hasActiveCard(
  db: Database,
  item: { projectId: string, plannedCardKeys: string | null }
): Promise<boolean> {
  const keys = parseCardKeys(item.plannedCardKeys)
  if (keys.length === 0) return false
  return hasActive(keys, await cardStatesByKeys(db, item.projectId, keys))
}

/** Intake items referencing any of `keys`, whatever status they sit in. */
async function findIntakeItemsByCardKeys(
  db: Database,
  projectId: string,
  keys: string[]
) {
  const keySet = new Set(keys)
  const items = await db
    .select()
    .from(schema.intakeItems)
    .where(
      and(
        eq(schema.intakeItems.projectId, projectId),
        isNotNull(schema.intakeItems.plannedCardKeys)
      )
    )
  return items.filter(i =>
    parseCardKeys(i.plannedCardKeys).some(k => keySet.has(k))
  )
}

/**
 * Cascade a card's archive/restore onto the items referencing it: an item with
 * no active (non-archived) card left is archived; one that regains an active
 * card is restored. Idempotent — only writes when the derived state differs.
 */
export async function syncIntakeForCard(
  db: Database,
  projectId: string,
  key: string
) {
  const items = await findIntakeItemsByCardKeys(db, projectId, [key])
  await rederiveIntakeItems(db, projectId, items)
}

// The sprint's cards are NOT archived; intake activeness derives from the
// sprint (cardStatesByKeys), so the cascade must be re-run explicitly.
export async function syncIntakeForSprint(
  db: Database,
  projectId: string,
  sprintId: string
) {
  const cards = await db
    .select({ key: schema.cards.key })
    .from(schema.cards)
    .where(eq(schema.cards.sprintId, sprintId))
  const keys = cards.map(c => c.key)
  if (keys.length === 0) return
  const items = await findIntakeItemsByCardKeys(db, projectId, keys)
  await rederiveIntakeItems(db, projectId, items)
}

async function rederiveIntakeItems(
  db: Database,
  projectId: string,
  items: { id: string, plannedCardKeys: string | null, status: IntakeStatus }[]
) {
  const allKeys = [
    ...new Set(items.flatMap(i => parseCardKeys(i.plannedCardKeys)))
  ]
  const states = await cardStatesByKeys(db, projectId, allKeys)
  for (const item of items) {
    const keys = parseCardKeys(item.plannedCardKeys)
    const active = hasActive(keys, states)
    if (!active && item.status === 'planned') {
      await archiveIntakeItem(db, item.id)
    } else if (active && item.status === 'archived') {
      await restoreIntakeItem(db, item.id)
    } else if (active && item.status === 'pending') {
      await markIntakePlanned(db, item.id, keys)
    }
  }
}

/**
 * Prune destroyed card keys from referencing items: an item left with no keys
 * is destroyed; otherwise the CSV is rewritten and its archived/planned state
 * re-derived from the remaining cards (keeps "planned ⟺ an active card" true).
 * A `pending` demand is exempt from both — it is waiting to be planned, not
 * living off those cards, so it only loses the keys that went with them.
 */
export async function pruneIntakeForDestroyedCards(
  db: Database,
  projectId: string,
  keys: string[]
) {
  const removed = new Set(keys)
  const items = await findIntakeItemsByCardKeys(db, projectId, keys)
  for (const item of items) {
    const remaining = parseCardKeys(item.plannedCardKeys).filter(
      k => !removed.has(k)
    )
    if (remaining.length === 0 && item.status !== 'pending') {
      await destroyIntakeItem(db, item.id)
      continue
    }
    const states = await cardStatesByKeys(db, projectId, remaining)
    const set: Record<string, unknown> = {
      plannedCardKeys: remaining.join(',') || null,
      updatedAt: sql`now()`
    }
    if (item.status !== 'pending') {
      if (hasActive(remaining, states)) {
        set.status = 'planned'
        set.archivedAt = null
      } else if (item.status !== 'archived') {
        set.status = 'archived'
        set.archivedAt = sql`now()`
      }
    }
    await db
      .update(schema.intakeItems)
      .set(set)
      .where(eq(schema.intakeItems.id, item.id))
    await notifyChanged(db, item)
  }
}

export async function destroyIntakeItem(db: Database, id: string) {
  const row = await db.transaction(async (tx) => {
    const [item] = await tx
      .select({ projectId: schema.intakeItems.projectId })
      .from(schema.intakeItems)
      .where(eq(schema.intakeItems.id, id))
      .limit(1)
    if (!item) return null
    await gcAttachmentsOnDestroy(tx, { projectId: item.projectId, intakeIds: [id] })
    const [deleted] = await tx
      .delete(schema.intakeItems)
      .where(eq(schema.intakeItems.id, id))
      .returning(intakeColumns)
    return deleted ?? null
  })
  if (row) {
    await notify(db, {
      type: 'inbox.deleted',
      projectId: row.projectId,
      intakeId: row.id
    })
  }
  return row ?? null
}
