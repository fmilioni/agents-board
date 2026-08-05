import { relations } from 'drizzle-orm'
import { index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

import { DEFAULT_EMBEDDING_DIM } from '@agents-board/shared'

import { cards } from './cards'
import { vector } from './columns'
import { comments } from './comments'
import { docs } from './docs'

// One semantic vector per content window (N per entity). Derived data rebuilt by
// the backfill from the owner's body — kept out of backups and the API contract;
// see ADR "Chunking: tabelas de chunk por entidade". The HNSW index on `embedding`
// is hand-added in custom migration SQL (drizzle doesn't emit it).

export const docChunks = pgTable(
  'doc_chunks',
  {
    docId: text('doc_id')
      .notNull()
      .references(() => docs.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    embedding: vector('embedding', { dimensions: DEFAULT_EMBEDDING_DIM }).notNull()
  },
  t => [
    primaryKey({ columns: [t.docId, t.idx] }),
    index('doc_chunks_doc_idx').on(t.docId)
  ]
)

export const cardChunks = pgTable(
  'card_chunks',
  {
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    embedding: vector('embedding', { dimensions: DEFAULT_EMBEDDING_DIM }).notNull()
  },
  t => [
    primaryKey({ columns: [t.cardId, t.idx] }),
    index('card_chunks_card_idx').on(t.cardId)
  ]
)

export const commentChunks = pgTable(
  'comment_chunks',
  {
    commentId: text('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    embedding: vector('embedding', { dimensions: DEFAULT_EMBEDDING_DIM }).notNull()
  },
  t => [
    primaryKey({ columns: [t.commentId, t.idx] }),
    index('comment_chunks_comment_idx').on(t.commentId)
  ]
)

export const docChunksRelations = relations(docChunks, ({ one }) => ({
  doc: one(docs, { fields: [docChunks.docId], references: [docs.id] })
}))

export const cardChunksRelations = relations(cardChunks, ({ one }) => ({
  card: one(cards, { fields: [cardChunks.cardId], references: [cards.id] })
}))

export const commentChunksRelations = relations(commentChunks, ({ one }) => ({
  comment: one(comments, { fields: [commentChunks.commentId], references: [comments.id] })
}))
