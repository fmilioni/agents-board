import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import { createId, type Database, schema } from '@agents-board/db'

import { notify } from './events'
import { paginate } from './pagination'

export interface Tag {
  id: string
  projectId: string
  name: string
  color: string
}

export const createTagInput = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a hex like #ef4444')
    .optional()
})
export type CreateTagInput = z.infer<typeof createTagInput>

export const updateTagInput = z.object({
  id: z.string(),
  name: z.string().min(1).max(50).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a hex like #ef4444')
    .optional()
})
export type UpdateTagInput = z.infer<typeof updateTagInput>

// The `Tag` wire type omits `createdAt`; allow-list keeps it (and any future
// column) out of the listing.
const tagColumns = {
  id: schema.tags.id,
  projectId: schema.tags.projectId,
  name: schema.tags.name,
  color: schema.tags.color
}

export async function listTags(
  db: Database,
  projectId: string,
  limit?: number,
  offset?: number
): Promise<Tag[]> {
  return paginate(
    db
      .select(tagColumns)
      .from(schema.tags)
      .where(eq(schema.tags.projectId, projectId))
      .orderBy(asc(schema.tags.name))
      .$dynamic(),
    limit,
    offset
  )
}

export async function createTag(db: Database, input: CreateTagInput) {
  const parsed = createTagInput.parse(input)
  const [row] = await db
    .insert(schema.tags)
    .values({
      id: createId('tag'),
      projectId: parsed.projectId,
      name: parsed.name,
      color: parsed.color
    })
    .returning()
  if (row) {
    await notify(db, { type: 'project.changed', projectId: row.projectId })
  }
  return row
}

export async function updateTag(db: Database, input: UpdateTagInput) {
  const parsed = updateTagInput.parse(input)
  const { id, ...rest } = parsed
  const [row] = await db
    .update(schema.tags)
    .set(rest)
    .where(eq(schema.tags.id, id))
    .returning()
  if (row) {
    await notify(db, { type: 'project.changed', projectId: row.projectId })
  }
  return row ?? null
}

export async function deleteTag(db: Database, tagId: string) {
  const [row] = await db
    .delete(schema.tags)
    .where(eq(schema.tags.id, tagId))
    .returning()
  if (row) {
    await notify(db, { type: 'project.changed', projectId: row.projectId })
  }
  return row ?? null
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

export async function listCardTags(
  db: Database,
  cardId: string
): Promise<Tag[]> {
  return db
    .select({
      id: schema.tags.id,
      projectId: schema.tags.projectId,
      name: schema.tags.name,
      color: schema.tags.color
    })
    .from(schema.cardTags)
    .innerJoin(schema.tags, eq(schema.cardTags.tagId, schema.tags.id))
    .where(eq(schema.cardTags.cardId, cardId))
    .orderBy(asc(schema.tags.name))
}

export async function addTagToCard(
  db: Database,
  cardId: string,
  tagId: string
) {
  await db
    .insert(schema.cardTags)
    .values({ cardId, tagId })
    .onConflictDoNothing()
  await notifyCardChanged(db, cardId)
  return listCardTags(db, cardId)
}

export async function removeTagFromCard(
  db: Database,
  cardId: string,
  tagId: string
) {
  await db
    .delete(schema.cardTags)
    .where(
      and(
        eq(schema.cardTags.cardId, cardId),
        eq(schema.cardTags.tagId, tagId)
      )
    )
  await notifyCardChanged(db, cardId)
  return listCardTags(db, cardId)
}

/** Map of cardId -> tags, for attaching tags to a batch of cards. */
export async function tagsByCardIds(
  db: Database,
  cardIds: string[]
): Promise<Map<string, Tag[]>> {
  const map = new Map<string, Tag[]>()
  if (cardIds.length === 0) return map
  const rows = await db
    .select({
      cardId: schema.cardTags.cardId,
      id: schema.tags.id,
      projectId: schema.tags.projectId,
      name: schema.tags.name,
      color: schema.tags.color
    })
    .from(schema.cardTags)
    .innerJoin(schema.tags, eq(schema.cardTags.tagId, schema.tags.id))
    .where(inArray(schema.cardTags.cardId, cardIds))
    .orderBy(asc(schema.tags.name))
  for (const { cardId, ...tag } of rows) {
    const arr = map.get(cardId) ?? []
    arr.push(tag)
    map.set(cardId, arr)
  }
  return map
}
