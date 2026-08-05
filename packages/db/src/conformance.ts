/**
 * Compile-time conformance between the Drizzle schema and the API wire types in
 * @agents-board/shared. If a column is added, renamed or retyped, one of the
 * asserts below stops compiling and `pnpm typecheck` fails until the matching
 * field in shared is updated. Pure types — this module emits nothing at runtime.
 */
import type { InferSelectModel } from 'drizzle-orm'

import type {
  AttachmentOwnerType,
  AttachmentRow,
  CardClaimRow,
  CardCommitRow,
  CardRow,
  CardStatus,
  CommentAiStatus,
  CommentAuthor,
  CommentRow,
  DocKind,
  DocRow,
  IntakeItemRow,
  IntakeStatus,
  ProjectRow,
  RepoProvider,
  RoadmapRow,
  SprintRow,
  SprintStatus,
  SystemSettingsRow,
  TagRow,
  UserAuthzRow,
  UserProjectAccessRow,
  UserRole,
  UserStatus
} from '@agents-board/shared'

import {
  attachmentOwnerTypeEnum,
  attachments,
  cardClaims,
  cardCommits,
  cards,
  cardStatusEnum,
  commentAiStatusEnum,
  commentAuthorEnum,
  comments,
  docKindEnum,
  docs,
  intakeItems,
  intakeStatusEnum,
  projects,
  repoProviderEnum,
  roadmaps,
  sprints,
  sprintStatusEnum,
  systemSettings,
  tags,
  userAuthz,
  userProjectAccess,
  userRoleEnum,
  userStatusEnum
} from './schema/index'

/** Drizzle row (Date columns) → its JSON wire form (ISO strings). */
type Wire<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
      ? string | null
      : T[K];
}

type Equal<A, B>
  = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Assert<T extends true> = T

/**
 * Every entry must stay `true`. A mismatch makes the corresponding `Assert`
 * fail its `extends true` constraint, breaking the build. Exported so it counts
 * as used. The generated full-text search columns (`searchTsv` on cards,
 * `bodyTsv` on comments/docs) are not part of the API contract, so they are
 * excluded. Semantic vectors live in the separate `*_chunks` tables (no wire type).
 */
export type SchemaConformance = [
  Assert<Equal<AttachmentRow, Wire<Omit<InferSelectModel<typeof attachments>, 'data' | 'orphanedAt'>>>>,
  Assert<Equal<CardRow, Wire<Omit<InferSelectModel<typeof cards>, 'searchTsv'>>>>,
  Assert<Equal<SprintRow, Wire<InferSelectModel<typeof sprints>>>>,
  Assert<Equal<CommentRow, Wire<Omit<InferSelectModel<typeof comments>, 'bodyTsv'>>>>,
  Assert<Equal<CardCommitRow, Wire<InferSelectModel<typeof cardCommits>>>>,
  Assert<Equal<CardClaimRow, Wire<InferSelectModel<typeof cardClaims>>>>,
  Assert<Equal<DocRow, Wire<Omit<InferSelectModel<typeof docs>, 'bodyTsv'>>>>,
  Assert<Equal<ProjectRow, Wire<InferSelectModel<typeof projects>>>>,
  Assert<Equal<TagRow, Wire<InferSelectModel<typeof tags>>>>,
  Assert<Equal<RoadmapRow, Wire<InferSelectModel<typeof roadmaps>>>>,
  Assert<Equal<IntakeItemRow, Wire<InferSelectModel<typeof intakeItems>>>>,
  Assert<Equal<UserAuthzRow, Wire<InferSelectModel<typeof userAuthz>>>>,
  Assert<
    Equal<UserProjectAccessRow, Wire<InferSelectModel<typeof userProjectAccess>>>
  >,
  Assert<Equal<SystemSettingsRow, Wire<InferSelectModel<typeof systemSettings>>>>,
  Assert<Equal<CardStatus, (typeof cardStatusEnum.enumValues)[number]>>,
  Assert<Equal<SprintStatus, (typeof sprintStatusEnum.enumValues)[number]>>,
  Assert<Equal<CommentAuthor, (typeof commentAuthorEnum.enumValues)[number]>>,
  Assert<Equal<CommentAiStatus, (typeof commentAiStatusEnum.enumValues)[number]>>,
  Assert<Equal<DocKind, (typeof docKindEnum.enumValues)[number]>>,
  Assert<Equal<RepoProvider, (typeof repoProviderEnum.enumValues)[number]>>,
  Assert<Equal<IntakeStatus, (typeof intakeStatusEnum.enumValues)[number]>>,
  Assert<Equal<UserRole, (typeof userRoleEnum.enumValues)[number]>>,
  Assert<Equal<UserStatus, (typeof userStatusEnum.enumValues)[number]>>,
  Assert<Equal<AttachmentOwnerType, (typeof attachmentOwnerTypeEnum.enumValues)[number]>>
]
