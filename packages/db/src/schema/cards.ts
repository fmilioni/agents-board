import { relations, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from 'drizzle-orm/pg-core'

import { cardCommits } from './cardCommits'
import { tsvector } from './columns'
import { comments } from './comments'
import { cardStatusEnum } from './enums'
import { projects } from './projects'
import { sprints } from './sprints'
import { cardTags } from './tags'

export const cards = pgTable(
  'cards',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sprintId: text('sprint_id').references(() => sprints.id, {
      onDelete: 'set null'
    }),
    parentId: text('parent_id').references((): AnyPgColumn => cards.id, {
      onDelete: 'set null'
    }),
    key: text('key').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    descriptionMd: text('description_md'),
    status: cardStatusEnum('status').notNull().default('todo'),
    priority: integer('priority').notNull().default(0),
    dueDate: timestamp('due_date', { withTimezone: true }),
    position: integer('position').notNull().default(0),
    // Including `key` is deliberate: searching "AB-42" finds the card itself.
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(key, '') || ' ' || coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(description_md, ''))`
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // Stamped on the transition into `done`, cleared on leaving it — a stable
    // "when completed" that `updatedAt` can't give (it moves on any edit).
    doneAt: timestamp('done_at', { withTimezone: true })
  },
  t => [
    index('cards_project_idx').on(t.projectId),
    index('cards_sprint_idx').on(t.sprintId),
    index('cards_parent_idx').on(t.parentId),
    index('cards_status_idx').on(t.projectId, t.status),
    index('cards_search_tsv_idx').using('gin', t.searchTsv),
    uniqueIndex('cards_project_key_uk').on(t.projectId, t.key)
  ]
)

export const cardsRelations = relations(cards, ({ one, many }) => ({
  project: one(projects, {
    fields: [cards.projectId],
    references: [projects.id]
  }),
  sprint: one(sprints, {
    fields: [cards.sprintId],
    references: [sprints.id]
  }),
  tags: many(cardTags),
  comments: many(comments),
  commits: many(cardCommits)
}))
