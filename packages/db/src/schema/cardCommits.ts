import { relations, sql } from 'drizzle-orm'
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from 'drizzle-orm/pg-core'

import { cards } from './cards'

// Commits whose message references a card key (`feat(...): … (AB-94)`). The diff
// is captured locally by the CLI script and POSTed here; the server never reads
// the git repo. Unique `(card_id, sha)` is the dedupe key (re-attaching upserts).
export const cardCommits = pgTable(
  'card_commits',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    message: text('message').notNull(),
    stat: text('stat'),
    diff: text('diff'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    authorName: text('author_name'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`)
  },
  t => [
    uniqueIndex('card_commits_card_sha_uk').on(t.cardId, t.sha),
    index('card_commits_committed_idx').on(t.committedAt)
  ]
)

export const cardCommitsRelations = relations(cardCommits, ({ one }) => ({
  card: one(cards, { fields: [cardCommits.cardId], references: [cards.id] })
}))
