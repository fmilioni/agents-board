import type {
  CardStatus,
  CommentAiStatus,
  CommentAuthor,
  DocKind,
  IntakeStatus,
  RepoProvider,
  SprintStatus,
  UserRole,
  UserStatus
} from './enums'

/*
 * Persisted-row types, in API wire form: timestamps are ISO `string`s (what the
 * REST API serializes and the UI receives), not `Date`s.
 *
 * These mirror the Drizzle schema column-for-column and are kept in lockstep by
 * a compile-time conformance check in @agents-board/db (src/conformance.ts):
 * adding, renaming or retyping a column there breaks `pnpm typecheck` until the
 * matching field here is updated. The DTOs below build on these rows.
 */

export interface CardRow {
  id: string
  projectId: string
  sprintId: string | null
  parentId: string | null
  key: string
  title: string
  summary: string | null
  descriptionMd: string | null
  status: CardStatus
  priority: number
  dueDate: string | null
  position: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  doneAt: string | null
}

export interface SprintRow {
  id: string
  projectId: string
  roadmapId: string | null
  name: string
  goal: string | null
  status: SprintStatus
  startsAt: string | null
  endsAt: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface CommentRow {
  id: string
  cardId: string
  author: CommentAuthor
  userId: string | null
  bodyMd: string
  aiStatus: CommentAiStatus
  createdAt: string
}

export interface CardCommitRow {
  id: string
  cardId: string
  sha: string
  message: string
  stat: string | null
  diff: string | null
  committedAt: string | null
  authorName: string | null
  createdAt: string
}

export interface CardClaimRow {
  cardId: string
  ownerToken: string
  ownerLabel: string | null
  claimedAt: string
}

export interface DocRow {
  id: string
  projectId: string
  parentId: string | null
  title: string
  summary: string | null
  bodyMd: string | null
  kind: DocKind
  position: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface ProjectRow {
  id: string
  slug: string
  name: string
  description: string | null
  keyPrefix: string
  nextKeySeq: number
  repoProvider: RepoProvider | null
  repoWebUrl: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface TagRow {
  id: string
  projectId: string
  name: string
  color: string
  createdAt: string
}

export interface RoadmapRow {
  id: string
  projectId: string
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface IntakeItemRow {
  id: string
  projectId: string
  bodyMd: string
  status: IntakeStatus
  plannedCardKeys: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

/**
 * Attachment metadata in wire form. The `bytea` `data` column is deliberately
 * absent: bytes never travel in JSON payloads (images are served over a URL),
 * so — like the generated tsv/embedding columns — `data` is out of the API
 * contract and excluded from the schema conformance check.
 */
export interface AttachmentRow {
  id: string
  projectId: string
  mime: string
  filename: string | null
  byteSize: number
  width: number
  height: number
  description: string | null
  createdAt: string
}

export interface UserAuthzRow {
  userId: string
  role: UserRole
  status: UserStatus
  allProjects: boolean
  createdAt: string
  updatedAt: string
}

export interface UserProjectAccessRow {
  userId: string
  projectId: string
  createdAt: string
}

export interface SystemSettingsRow {
  id: string
  authEnabled: boolean
  keepDiffsOnArchive: boolean
  embeddingModel: string | null
  embeddingDtype: string | null
  includeAttachmentsInBackup: boolean
  keepAttachmentsOnArchive: boolean
  hideLooseDoneEnabled: boolean
  hideLooseDoneAfterDays: number
  createdAt: string
  updatedAt: string
}

/* ---- API DTOs: what the REST endpoints return and the UI consumes ---- */

export type Project = ProjectRow
export type Roadmap = RoadmapRow
export type CardCommit = CardCommitRow

/**
 * Comment as returned by the API. `authorName`/`authorImage` are joined from the
 * `user` author's identity (null for `ai` comments and for legacy `user`
 * comments with no `userId`); the UI falls back to a generic label when absent.
 */
export interface Comment extends CommentRow {
  authorName: string | null
  authorImage: string | null
}

/**
 * Intake item as returned by the API. `completed` is derived at read time for
 * planned items: true when ≥1 referenced card is non-archived and all
 * non-archived referenced cards are `done` (archived/destroyed cards ignored).
 */
export interface IntakeItem extends IntakeItemRow {
  completed?: boolean
}

/** Tag as embedded in cards or listed for a project (createdAt not surfaced). */
export interface Tag {
  id: string
  projectId: string
  name: string
  color: string
}

/** Sprint as returned by the API. `archivedAt` is optional: list endpoints may omit it. */
export interface Sprint extends Omit<SprintRow, 'archivedAt'> {
  archivedAt?: string | null
}

export interface CardSubtask {
  id: string
  key: string
  title: string
  status: CardStatus
  priority: number
  tags: Tag[]
}

export interface CardParent {
  id: string
  key: string
  title: string
  status: CardStatus
}

/**
 * Advisory claim as surfaced on card reads — the opaque `ownerToken` is never
 * exposed, only who holds it (`ownerLabel`, null for a generic/no-auth session)
 * and since when. Ownership is enforced at claim/release/take-over time.
 */
export interface CardClaim {
  ownerLabel: string | null
  claimedAt: string
}

/**
 * Card as returned by the API. List endpoints omit `descriptionMd`/`archivedAt`;
 * detail endpoints add joins (tags, subtasks, parent, blockers). Hence those
 * fields are optional here.
 */
export interface Card extends Omit<CardRow, 'descriptionMd' | 'archivedAt'> {
  descriptionMd?: string | null
  archivedAt?: string | null
  tags?: Tag[]
  parentKey?: string | null
  subtaskCount?: number
  subtaskDone?: number
  subtasks?: CardSubtask[]
  parent?: CardParent | null
  blockedBy?: CardParent[]
  blocking?: CardParent[]
  blockedByPending?: number
  claim?: CardClaim | null
}

/** Doc list item: no body, `archivedAt` optional (list endpoints omit it). */
export interface DocSummary extends Omit<DocRow, 'bodyMd' | 'archivedAt'> {
  archivedAt?: string | null
}

/** Full doc, including the markdown body. */
export interface Doc extends DocSummary {
  bodyMd: string | null
}
