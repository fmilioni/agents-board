import {
  getCommitBySha,
  getProjectBySlug,
  getUserAuthz,
  listAccessibleProjectIds,
  resolveCardsProjectIds,
  resolveCommentsProjectIds,
  resolveEntityProjectId
} from '@claude-organizer/core'
import type { Database } from '@claude-organizer/db'
import type { UserRole, UserStatus } from '@claude-organizer/shared'

// The project scope of an authenticated MCP session — the same model the REST
// auth-enforcement gate applies. `null` means unrestricted (sem-auth mode), so
// callers pass it straight through. `'all'` is admin/allProjects.
export interface McpScope {
  userId: string
  role: UserRole
  status: UserStatus
  projects: 'all' | Set<string>
}

// Project lifecycle = admin surface (mirrors the REST ADMIN_ONLY list). The rest
// of the project-touching tools are allowed for any user with a grant.
const ADMIN_ONLY_TOOLS = new Set([
  'create_project',
  'archive_project',
  'restore_project',
  'destroy_project'
])

export async function resolveMcpScope(
  db: Database,
  userId: string
): Promise<McpScope> {
  const [accessible, authz] = await Promise.all([
    listAccessibleProjectIds(db, userId),
    getUserAuthz(db, userId)
  ])
  const status = authz?.status ?? 'pending'
  return {
    userId,
    role: authz?.role ?? 'user',
    status,
    // Defense in depth: a non-approved account gets an empty scope regardless of
    // role/allProjects, so resource helpers (which don't pass through
    // assertToolAccess) also can't leak. The admin-only branch is guarded too.
    projects:
      status !== 'approved'
        ? new Set<string>()
        : accessible === 'all'
          ? 'all'
          : new Set(accessible)
  }
}

type Input = Record<string, unknown>
type EntityKind = Parameters<typeof resolveEntityProjectId>[1]

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// The project ids a tool call touches, or null when none resolves (deny). Maps
// each tool to the same resolution the REST gate uses per route. Unmapped tools
// fall through to null → fail closed.
async function resolveToolProjectIds(
  db: Database,
  tool: string,
  input: Input
): Promise<string[] | null> {
  const one = (id: string | null | undefined) => (id ? [id] : null)
  const entity = (kind: EntityKind, id: string | undefined) =>
    id ? resolveEntityProjectId(db, kind, id).then(one) : null
  const nonEmpty = (ids: string[]) => (ids.length > 0 ? ids : null)

  switch (tool) {
    case 'list_cards':
    case 'search_cards':
    case 'create_card':
    case 'list_sprints':
    case 'get_active_sprint':
    case 'create_sprint':
    case 'list_tags':
    case 'create_tag':
    case 'list_docs':
    case 'search_docs':
    case 'list_unhandled_comments':
    case 'create_inbox':
    case 'list_inbox':
    case 'update_project_key_prefix':
    case 'set_project_repo':
    case 'issue_upload_token':
      return one(str(input.projectId))

    case 'get_project':
      return one((await getProjectBySlug(db, str(input.slug) ?? ''))?.id)

    case 'get_card':
    case 'update_card':
    case 'set_card_status':
    case 'move_card_to_backlog':
    case 'archive_card':
    case 'restore_card':
    case 'destroy_card':
      return entity('card', str(input.id))

    case 'get_card_by_key':
      return entity('cardKey', str(input.key))

    case 'issue_commit_token':
    case 'claim_task':
    case 'release_task':
    case 'take_over_task':
      return entity('cardKey', str(input.cardKey))

    case 'move_card_to_sprint': {
      const ids = (
        await Promise.all([
          resolveEntityProjectId(db, 'card', str(input.id) ?? ''),
          resolveEntityProjectId(db, 'sprint', str(input.sprintId) ?? '')
        ])
      ).filter((x): x is string => Boolean(x))
      return nonEmpty(ids)
    }

    case 'list_comments':
    case 'add_comment':
    case 'add_tag_to_card':
    case 'remove_tag_from_card':
      return entity('card', str(input.cardId))

    case 'add_blocker':
    case 'remove_blocker':
      return resolveCardsProjectIds(
        db,
        [str(input.cardId), str(input.blockerId)].filter(
          (x): x is string => Boolean(x)
        )
      ).then(nonEmpty)

    case 'reorder_cards':
      return resolveCardsProjectIds(
        db,
        ((input.orderedIds as string[] | undefined) ?? []).filter(Boolean)
      ).then(nonEmpty)

    case 'update_sprint':
    case 'archive_sprint':
    case 'restore_sprint':
    case 'destroy_sprint':
      return entity('sprint', str(input.id))

    case 'start_sprint':
    case 'complete_sprint':
    case 'reopen_sprint':
      return entity('sprint', str(input.sprintId))

    case 'read_doc':
    case 'archive_doc':
    case 'restore_doc':
    case 'destroy_doc':
      return entity('doc', str(input.id))

    case 'write_doc':
      return input.id
        ? entity('doc', str(input.id))
        : one(str(input.projectId))

    case 'update_tag':
      return entity('tag', str(input.id))

    case 'update_comment':
    case 'delete_comment':
      return entity('comment', str(input.id))

    case 'mark_comments_handled':
      return resolveCommentsProjectIds(
        db,
        ((input.commentIds as string[] | undefined) ?? []).filter(Boolean)
      ).then(nonEmpty)

    case 'update_inbox':
    case 'mark_inbox_planned':
    case 'archive_inbox':
    case 'restore_inbox':
    case 'destroy_inbox':
      return entity('intakeItem', str(input.id))

    case 'get_commit_diff': {
      const cardId
        = str(input.cardId)
          ?? (await getCommitBySha(db, str(input.sha) ?? ''))?.cardId
      return entity('card', cardId)
    }

    default:
      return null
  }
}

// Enforce the session's scope before a tool runs. Throws (→ MCP tool error) when
// access is denied. `list_projects` is allowed through and filtered in output.
export async function assertToolAccess(
  db: Database,
  scope: McpScope | null,
  tool: string,
  input: Input
): Promise<void> {
  if (!scope) return
  // Mirrors the REST gate: a non-approved account has no access at all (covers
  // the admin-only branch and the list_projects allow-through below).
  if (scope.status !== 'approved') {
    throw new Error('Forbidden: account is not approved.')
  }
  if (ADMIN_ONLY_TOOLS.has(tool)) {
    if (scope.role !== 'admin') {
      throw new Error(`Forbidden: ${tool} requires the admin role.`)
    }
    return
  }
  if (scope.projects === 'all') return
  if (tool === 'list_projects') return

  const projectIds = await resolveToolProjectIds(db, tool, input)
  if (!projectIds) {
    throw new Error(`Forbidden: no accessible project resolves for ${tool}.`)
  }
  for (const projectId of projectIds) {
    if (!scope.projects.has(projectId)) {
      throw new Error(`Forbidden: no access to project ${projectId}.`)
    }
  }
}

export function canAccessProjectId(
  scope: McpScope | null,
  projectId: string
): boolean {
  return !scope || scope.projects === 'all' || scope.projects.has(projectId)
}

export function filterProjectsByScope<T extends { id: string }>(
  projects: T[],
  scope: McpScope | null
): T[] {
  if (!scope || scope.projects === 'all') return projects
  const allowed = scope.projects
  return projects.filter(p => allowed.has(p.id))
}
