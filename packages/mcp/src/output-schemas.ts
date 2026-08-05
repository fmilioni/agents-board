import { z } from 'zod'

import type { toolContracts } from './tool-contracts'

const cardStatus = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked'
])
const sprintStatus = z.enum(['planned', 'active', 'completed', 'cancelled'])
const docKind = z.enum(['module', 'adr', 'guide', 'note'])
const intakeStatus = z.enum(['pending', 'planned', 'archived'])
const commentAuthor = z.enum(['ai', 'user'])
const commentAiStatus = z.enum(['unread', 'read', 'handled'])
const repoProvider = z.enum(['github', 'gitlab'])

const attachment = z.object({
  id: z.string(),
  uri: z.string(),
  mime: z.string(),
  width: z.number(),
  height: z.number(),
  description: z.string().nullable()
}).strict()

const tag = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  color: z.string()
}).strict()

const tagRow = tag.extend({ createdAt: z.string() }).strict()

const cardReference = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  status: cardStatus
}).strict()

const cardClaim = z.object({
  ownerLabel: z.string().nullable(),
  claimedAt: z.string()
}).strict()

const cardScan = z.object({
  id: z.string(),
  sprintId: z.string().nullable(),
  parentId: z.string().nullable(),
  key: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  status: cardStatus,
  priority: z.number(),
  dueDate: z.string().nullable(),
  doneAt: z.string().nullable(),
  tags: z.array(tag),
  subtaskCount: z.number(),
  subtaskDone: z.number(),
  parentKey: z.string().nullable(),
  blockedByPending: z.number(),
  claim: cardClaim.nullable()
}).strict()

const cardRow = z.object({
  id: z.string(),
  projectId: z.string(),
  sprintId: z.string().nullable(),
  parentId: z.string().nullable(),
  key: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  descriptionMd: z.string().nullable(),
  status: cardStatus,
  priority: z.number(),
  dueDate: z.string().nullable(),
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  doneAt: z.string().nullable()
}).strict()

const cardBatch = cardRow.extend({
  tags: z.array(tag),
  subtaskCount: z.number(),
  subtaskDone: z.number(),
  parentKey: z.string().nullable(),
  blockedByPending: z.number(),
  claim: cardClaim.nullable()
}).strict()

const cardSubtask = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  status: cardStatus,
  priority: z.number(),
  tags: z.array(tag)
}).strict()

const commitMetadata = z.object({
  id: z.string(),
  sha: z.string(),
  message: z.string(),
  stat: z.string().nullable(),
  committedAt: z.string().nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string()
}).strict()

const cardDetail = cardRow.extend({
  tags: z.array(tag),
  subtasks: z.array(cardSubtask),
  parent: cardReference.nullable(),
  blockedBy: z.array(cardReference),
  blocking: z.array(cardReference),
  claim: cardClaim.nullable(),
  commits: z.array(commitMetadata),
  attachments: z.array(attachment)
}).strict()

const commit = commitMetadata.extend({
  cardId: z.string(),
  diff: z.string().nullable()
}).strict()

const cardAck = z.object({
  id: z.string(),
  key: z.string(),
  status: cardStatus
}).strict()
const cardSprintAck = cardAck.extend({ sprintId: z.string().nullable() }).strict()
const reorderedCard = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string()
}).strict()

const project = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  keyPrefix: z.string(),
  nextKeySeq: z.number(),
  repoProvider: repoProvider.nullable(),
  repoWebUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable()
}).strict()

const projectAck = z.object({
  id: z.string(),
  slug: z.string(),
  keyPrefix: z.string()
}).strict()
const projectRepoAck = projectAck.extend({
  repoProvider: repoProvider.nullable(),
  repoWebUrl: z.string().nullable()
}).strict()

const sprint = z.object({
  id: z.string(),
  projectId: z.string(),
  roadmapId: z.string().nullable(),
  name: z.string(),
  goal: z.string().nullable(),
  status: sprintStatus,
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable()
}).strict()

const sprintAck = z.object({
  id: z.string(),
  name: z.string(),
  status: sprintStatus
}).strict()

const comment = z.object({
  id: z.string(),
  cardId: z.string(),
  author: commentAuthor,
  userId: z.string().nullable(),
  bodyMd: z.string(),
  aiStatus: commentAiStatus,
  createdAt: z.string(),
  authorName: z.string().nullable(),
  authorImage: z.string().nullable(),
  attachments: z.array(attachment)
}).strict()

const unhandledComment = z.object({
  id: z.string(),
  cardId: z.string(),
  author: z.literal('user'),
  aiStatus: z.enum(['unread', 'read']),
  bodyMd: z.string(),
  createdAt: z.string(),
  cardTitle: z.string()
}).strict()

const commentAck = z.object({
  id: z.string(),
  cardId: z.string(),
  createdAt: z.string()
}).strict()

const docSummary = z.object({
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  summary: z.string().nullable(),
  kind: docKind,
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string()
}).strict()

const doc = docSummary.extend({
  bodyMd: z.string().nullable(),
  attachments: z.array(attachment)
}).strict()

const docAck = z.object({
  id: z.string(),
  title: z.string(),
  kind: docKind
}).strict()
const docParentAck = docAck.extend({ parentId: z.string().nullable() }).strict()

const intakeItem = z.object({
  id: z.string(),
  projectId: z.string(),
  bodyMd: z.string(),
  status: intakeStatus,
  plannedCardKeys: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  completed: z.boolean(),
  attachments: z.array(attachment)
}).strict()

const intakeAck = z.object({
  id: z.string(),
  status: intakeStatus,
  plannedCardKeys: z.string().nullable()
}).strict()

const claimResult = z.object({
  ok: z.boolean(),
  conflict: z.boolean(),
  claim: cardClaim.nullable(),
  cascaded: z.array(z.object({ key: z.string() }).strict())
}).strict()

const notFoundCard = z.object({
  error: z.literal('not_found'),
  cardKey: z.string()
}).strict()

const tagNotFound = z.object({ error: z.literal('not_found') }).strict()

const commitToken = z.object({
  cardKey: z.string(),
  token: z.string(),
  expiresAt: z.string()
}).strict()

const uploadToken = z.object({
  projectId: z.string(),
  token: z.string(),
  expiresAt: z.string()
}).strict()

function page(key: string, item: z.ZodType) {
  return z.object({
    [key]: z.array(item),
    hasMore: z.boolean(),
    offset: z.number()
  }).strict()
}

export const toolOutputSchemas = {
  add_blocker: z.array(cardReference),
  remove_blocker: z.array(cardReference),
  claim_task: z.union([claimResult, notFoundCard]),
  release_task: z.union([claimResult, notFoundCard]),
  take_over_task: z.union([claimResult, notFoundCard]),
  list_cards: page('cards', cardScan),
  search_cards: page(
    'cards',
    cardScan.extend({
      matchedComment: z.object({
        commentId: z.string(),
        snippet: z.string()
      }).strict().nullable()
    }).strict()
  ),
  get_card: cardDetail.nullable(),
  get_card_by_key: cardDetail.nullable(),
  get_cards: z.array(cardBatch),
  get_commit_diff: commit.nullable(),
  create_card: cardSprintAck.nullable(),
  update_card: cardAck.nullable(),
  set_card_status: cardAck.nullable(),
  reorder_cards: reorderedCard.nullable(),
  move_card_to_backlog: cardSprintAck.nullable(),
  move_card_to_sprint: cardSprintAck.nullable(),
  archive_card: cardAck.nullable(),
  restore_card: cardAck.nullable(),
  destroy_card: reorderedCard.nullable(),
  list_comments: page('comments', comment),
  list_unhandled_comments: page('comments', unhandledComment),
  add_comment: commentAck.nullable(),
  update_comment: commentAck.nullable(),
  mark_comments_handled: z.object({ updated: z.number() }).strict(),
  delete_comment: commentAck.nullable(),
  issue_commit_token: commitToken,
  list_docs: page('docs', docSummary),
  read_doc: doc.nullable(),
  search_docs: page('docs', docSummary),
  write_doc: docParentAck.nullable(),
  archive_doc: docAck.nullable(),
  restore_doc: docAck.nullable(),
  destroy_doc: z.object({ id: z.string(), projectId: z.string() }).strict().nullable(),
  create_inbox: intakeAck.nullable(),
  list_inbox: page('items', intakeItem),
  update_inbox: intakeAck.nullable(),
  mark_inbox_planned: intakeAck.nullable(),
  archive_inbox: intakeAck.nullable(),
  restore_inbox: intakeAck.nullable(),
  destroy_inbox: intakeAck.nullable(),
  list_projects: page('projects', project),
  get_project: project.nullable(),
  create_project: projectAck.nullable(),
  update_project: project.nullable(),
  update_project_key_prefix: projectAck.nullable(),
  archive_project: projectAck.nullable(),
  restore_project: projectAck.nullable(),
  destroy_project: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string()
  }).strict().nullable(),
  set_project_repo: projectRepoAck.nullable(),
  list_sprints: page('sprints', sprint),
  get_active_sprint: z.array(sprint),
  create_sprint: sprintAck.nullable(),
  update_sprint: sprintAck.nullable(),
  start_sprint: sprintAck.nullable(),
  complete_sprint: sprintAck.nullable(),
  deactivate_sprint: sprintAck.nullable(),
  reopen_sprint: sprintAck.nullable(),
  archive_sprint: sprintAck.nullable(),
  restore_sprint: sprintAck.nullable(),
  destroy_sprint: z.object({ id: z.string(), projectId: z.string() }).strict().nullable(),
  list_tags: page('tags', tag),
  create_tag: tagRow,
  update_tag: tagRow.nullable(),
  delete_tag: z.union([tagRow, tagNotFound]),
  add_tag_to_card: z.array(tag),
  remove_tag_from_card: z.array(tag),
  issue_upload_token: uploadToken
} as const satisfies Record<keyof typeof toolContracts, z.ZodType>

export function outputSchemaFor(name: keyof typeof toolOutputSchemas) {
  return z.object({ value: toolOutputSchemas[name] }).strict()
}
