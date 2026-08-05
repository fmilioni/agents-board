import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { type Database, schema } from '@agents-board/db'

import { InputError } from './errors'
import { notify } from './events'

const refColumns = {
  id: schema.cards.id,
  key: schema.cards.key,
  title: schema.cards.title,
  status: schema.cards.status
}

async function notifyCardChanged(db: Database, cardId: string) {
  const [card] = await db
    .select({ projectId: schema.cards.projectId, key: schema.cards.key })
    .from(schema.cards)
    .where(eq(schema.cards.id, cardId))
    .limit(1)
  if (card) {
    await notify(db, {
      type: 'card.changed',
      projectId: card.projectId,
      cardId,
      cardKey: card.key
    })
  }
}

/** Cards that block `cardId` (its blockers — "blocked by"). */
export async function listBlockedBy(db: Database, cardId: string) {
  return db
    .select(refColumns)
    .from(schema.cardBlockers)
    .innerJoin(
      schema.cards,
      eq(schema.cardBlockers.blockerCardId, schema.cards.id)
    )
    .where(eq(schema.cardBlockers.blockedCardId, cardId))
    .orderBy(asc(schema.cards.key))
}

/** Cards that `cardId` blocks (its dependents — "blocking"). */
export async function listBlocking(db: Database, cardId: string) {
  return db
    .select(refColumns)
    .from(schema.cardBlockers)
    .innerJoin(
      schema.cards,
      eq(schema.cardBlockers.blockedCardId, schema.cards.id)
    )
    .where(eq(schema.cardBlockers.blockerCardId, cardId))
    .orderBy(asc(schema.cards.key))
}

export async function addBlocker(
  db: Database,
  blockedCardId: string,
  blockerCardId: string
) {
  if (blockedCardId === blockerCardId) {
    throw new InputError('A card cannot block itself')
  }
  await db
    .insert(schema.cardBlockers)
    .values({ blockedCardId, blockerCardId })
    .onConflictDoNothing()
  await Promise.all([
    notifyCardChanged(db, blockedCardId),
    notifyCardChanged(db, blockerCardId)
  ])
  return listBlockedBy(db, blockedCardId)
}

export async function removeBlocker(
  db: Database,
  blockedCardId: string,
  blockerCardId: string
) {
  await db
    .delete(schema.cardBlockers)
    .where(
      and(
        eq(schema.cardBlockers.blockedCardId, blockedCardId),
        eq(schema.cardBlockers.blockerCardId, blockerCardId)
      )
    )
  await Promise.all([
    notifyCardChanged(db, blockedCardId),
    notifyCardChanged(db, blockerCardId)
  ])
  return listBlockedBy(db, blockedCardId)
}

/**
 * For each card id, how many of its blockers are still pending — neither `done`
 * nor `review`. A blocker in `review` counts as satisfied: its work is built and
 * only awaits final validation, so it no longer blocks dependents (a batch run
 * leaves cards in `review`, never `done`, and would otherwise stall).
 */
export async function pendingBlockerCounts(db: Database, cardIds: string[]) {
  const map = new Map<string, number>()
  if (cardIds.length === 0) return map
  const rows = await db
    .select({
      blockedCardId: schema.cardBlockers.blockedCardId,
      pending: sql<number>`count(*) filter (where ${schema.cards.status} not in ('done', 'review'))::int`
    })
    .from(schema.cardBlockers)
    .innerJoin(
      schema.cards,
      eq(schema.cardBlockers.blockerCardId, schema.cards.id)
    )
    .where(inArray(schema.cardBlockers.blockedCardId, cardIds))
    .groupBy(schema.cardBlockers.blockedCardId)
  for (const r of rows) map.set(r.blockedCardId, r.pending)
  return map
}
