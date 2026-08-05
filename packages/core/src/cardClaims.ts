import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'

import { type Database, schema } from '@agents-board/db'

import { InputError } from './errors'
import { notify } from './events'

export const claimCardInput = z.object({
  cardId: z.string(),
  ownerToken: z.string().min(1),
  ownerLabel: z.string().max(200).nullable().optional()
})
export type ClaimCardInput = z.infer<typeof claimCardInput>

export const releaseCardInput = z.object({
  cardId: z.string(),
  ownerToken: z.string().min(1)
})
export type ReleaseCardInput = z.infer<typeof releaseCardInput>

type ClaimRow = typeof schema.cardClaims.$inferSelect

// Accepts the top-level db or a transaction handle, so the auto-release rule can
// run inside the reorder transaction and reuse this one helper.
type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

// Surfaced claim (no token). `claimedAt` is a `Date` here; the API serializes it
// to the ISO `string` of the wire `CardClaim`, like every other timestamp.
export interface ClaimView {
  ownerLabel: string | null
  claimedAt: Date
}

function toClaim(row: ClaimRow): ClaimView {
  return { ownerLabel: row.ownerLabel, claimedAt: row.claimedAt }
}

async function loadCard(db: Database, cardId: string) {
  const [card] = await db
    .select({
      id: schema.cards.id,
      projectId: schema.cards.projectId,
      key: schema.cards.key
    })
    .from(schema.cards)
    .where(eq(schema.cards.id, cardId))
    .limit(1)
  return card ?? null
}

export async function getClaim(db: Database, cardId: string) {
  const [row] = await db
    .select()
    .from(schema.cardClaims)
    .where(eq(schema.cardClaims.cardId, cardId))
    .limit(1)
  return row ?? null
}

/** Claim state (label + since-when, no token) for a batch of cards. */
export async function claimsByCardIds(db: Database, cardIds: string[]) {
  const map = new Map<string, ClaimView>()
  if (cardIds.length === 0) return map
  const rows = await db
    .select()
    .from(schema.cardClaims)
    .where(inArray(schema.cardClaims.cardId, cardIds))
  for (const r of rows) map.set(r.cardId, toClaim(r))
  return map
}

async function notifyChanged(
  db: Database,
  cards: { id: string, projectId: string, key: string }[]
) {
  await Promise.all(
    cards.map(c =>
      notify(db, {
        type: 'card.changed',
        projectId: c.projectId,
        cardId: c.id,
        cardKey: c.key
      })
    )
  )
}

interface ClaimResult {
  ok: boolean
  conflict: boolean
  claim: ClaimView | null
  cascaded: { key: string }[]
}

/**
 * Reserve a card for `ownerToken`. Advisory: nothing is locked, this only
 * signals intent. A story (parent) also reserves its not-yet-started children
 * (the ones still in the first board column) that aren't already claimed by
 * someone else — claims held by others are left untouched (no stealing; take-over
 * is the explicit path). Re-claiming with the same token just refreshes the
 * label. A card already held by a *different* token returns `conflict` without
 * changing anything.
 */
export async function claimCard(
  db: Database,
  input: ClaimCardInput
): Promise<ClaimResult> {
  const { cardId, ownerToken, ownerLabel = null } = claimCardInput.parse(input)
  const card = await loadCard(db, cardId)
  if (!card) throw new InputError(`Card ${cardId} not found`)

  const outcome = await db.transaction(async (tx) => {
    // Guarded upsert: on a conflict the DO UPDATE only fires when WE already own
    // the row (`setWhere` token match), so a claim held by a different token is
    // left untouched — the read-back below then reports the conflict. Keeps the
    // ownership guard sound even against a concurrent claim.
    await tx
      .insert(schema.cardClaims)
      .values({ cardId, ownerToken, ownerLabel })
      .onConflictDoUpdate({
        target: schema.cardClaims.cardId,
        set: { ownerLabel },
        setWhere: eq(schema.cardClaims.ownerToken, ownerToken)
      })
    const [after] = await tx
      .select()
      .from(schema.cardClaims)
      .where(eq(schema.cardClaims.cardId, cardId))
      .limit(1)
    if (!after || after.ownerToken !== ownerToken) {
      return { conflict: true as const, claim: after ? toClaim(after) : null }
    }

    const children = await tx
      .select({ id: schema.cards.id, key: schema.cards.key })
      .from(schema.cards)
      .where(
        and(
          eq(schema.cards.parentId, cardId),
          eq(schema.cards.status, 'todo')
        )
      )
    if (children.length === 0) {
      return { conflict: false as const, claim: toClaim(after), cascaded: [] }
    }

    await tx
      .insert(schema.cardClaims)
      .values(children.map(c => ({ cardId: c.id, ownerToken, ownerLabel })))
      .onConflictDoNothing()

    const held = await tx
      .select({ cardId: schema.cardClaims.cardId })
      .from(schema.cardClaims)
      .where(
        and(
          inArray(schema.cardClaims.cardId, children.map(c => c.id)),
          eq(schema.cardClaims.ownerToken, ownerToken)
        )
      )
    const heldIds = new Set(held.map(h => h.cardId))
    return {
      conflict: false as const,
      claim: toClaim(after),
      cascaded: children.filter(c => heldIds.has(c.id))
    }
  })

  if (outcome.conflict) {
    return { ok: false, conflict: true, claim: outcome.claim, cascaded: [] }
  }

  await notifyChanged(db, [
    card,
    ...outcome.cascaded.map(c => ({ id: c.id, projectId: card.projectId, key: c.key }))
  ])
  return {
    ok: true,
    conflict: false,
    claim: outcome.claim,
    cascaded: outcome.cascaded.map(c => ({ key: c.key }))
  }
}

/**
 * Release a card's claim — owner only (token must match). A story also releases
 * the children claims held by the **same** token. Releasing an unclaimed card is
 * a no-op. A token mismatch returns `conflict`.
 */
export async function releaseCard(
  db: Database,
  input: ReleaseCardInput
): Promise<ClaimResult> {
  const { cardId, ownerToken } = releaseCardInput.parse(input)
  const card = await loadCard(db, cardId)
  if (!card) throw new InputError(`Card ${cardId} not found`)

  const existing = await getClaim(db, cardId)
  if (!existing) return { ok: true, conflict: false, claim: null, cascaded: [] }
  if (existing.ownerToken !== ownerToken) {
    return { ok: false, conflict: true, claim: toClaim(existing), cascaded: [] }
  }

  const cascaded = await db.transaction(async (tx) => {
    const children = await tx
      .select({ id: schema.cards.id, key: schema.cards.key })
      .from(schema.cards)
      .innerJoin(
        schema.cardClaims,
        eq(schema.cardClaims.cardId, schema.cards.id)
      )
      .where(
        and(
          eq(schema.cards.parentId, cardId),
          eq(schema.cardClaims.ownerToken, ownerToken)
        )
      )
    const ids = [cardId, ...children.map(c => c.id)]
    await tx.delete(schema.cardClaims).where(
      and(
        inArray(schema.cardClaims.cardId, ids),
        eq(schema.cardClaims.ownerToken, ownerToken)
      )
    )
    return children
  })

  await notifyChanged(db, [
    card,
    ...cascaded.map(c => ({ id: c.id, projectId: card.projectId, key: c.key }))
  ])
  return { ok: true, conflict: false, claim: null, cascaded: cascaded.map(c => ({ key: c.key })) }
}

/**
 * Transfer a card's claim to `ownerToken`, replacing whoever held it (used after
 * the user confirms a take-over in the skill). A story also transfers its
 * not-yet-started children and any already-claimed child to the new token.
 */
export async function takeOverCard(
  db: Database,
  input: ClaimCardInput
): Promise<ClaimResult> {
  const { cardId, ownerToken, ownerLabel = null } = claimCardInput.parse(input)
  const card = await loadCard(db, cardId)
  if (!card) throw new InputError(`Card ${cardId} not found`)

  const cascaded = await db.transaction(async (tx) => {
    await tx
      .insert(schema.cardClaims)
      .values({ cardId, ownerToken, ownerLabel })
      .onConflictDoUpdate({
        target: schema.cardClaims.cardId,
        set: { ownerToken, ownerLabel, claimedAt: sql`now()` }
      })

    const children = await tx
      .select({
        id: schema.cards.id,
        key: schema.cards.key,
        status: schema.cards.status,
        claimed: schema.cardClaims.cardId
      })
      .from(schema.cards)
      .leftJoin(
        schema.cardClaims,
        eq(schema.cardClaims.cardId, schema.cards.id)
      )
      .where(eq(schema.cards.parentId, cardId))
    const targets = children.filter(
      c => c.status === 'todo' || c.claimed != null
    )
    if (targets.length > 0) {
      await tx
        .insert(schema.cardClaims)
        .values(targets.map(t => ({ cardId: t.id, ownerToken, ownerLabel })))
        .onConflictDoUpdate({
          target: schema.cardClaims.cardId,
          set: { ownerToken, ownerLabel, claimedAt: sql`now()` }
        })
    }
    return targets
  })

  await notifyChanged(db, [
    card,
    ...cascaded.map(c => ({ id: c.id, projectId: card.projectId, key: c.key }))
  ])
  const claim = await getClaim(db, cardId)
  return {
    ok: true,
    conflict: false,
    claim: claim ? toClaim(claim) : null,
    cascaded: cascaded.map(c => ({ key: c.key }))
  }
}

/**
 * Drop a card's claim because it reached `done` — authoritative, no token check
 * (completion releases the reservation). Called from the status-change paths;
 * pass a transaction handle to run it within the caller's transaction.
 */
export async function releaseClaimOnDone(db: DbOrTx, cardId: string) {
  await db.delete(schema.cardClaims).where(eq(schema.cardClaims.cardId, cardId))
}
