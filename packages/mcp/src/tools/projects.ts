import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  archiveProject,
  createProject,
  destroyProject,
  getProjectBySlug,
  listProjects,
  restoreProject,
  setProjectRepo,
  updateProjectIdentity,
  updateProjectKeyPrefix
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { filterProjectsByScope, type McpScope } from '../scope'
import { asJson, pageInputs } from './index'

type ProjectAckRow = {
  id: string
  slug: string
  keyPrefix: string
  repoProvider: string | null
  repoWebUrl: string | null
}
function projectAck(
  p: ProjectAckRow | null | undefined,
  ...extra: Array<'repoProvider' | 'repoWebUrl'>
) {
  if (!p) return null
  const ack: Record<string, unknown> = {
    id: p.id,
    slug: p.slug,
    keyPrefix: p.keyPrefix
  }
  for (const f of extra) ack[f] = p[f]
  return ack
}

export function registerProjectTools(
  server: McpServer,
  db: Database,
  scope: McpScope | null
) {
  server.registerTool(
    'list_projects',
    {
      description:
        'List projects accessible to the current session. Use when a projectId is not already known. Archived projects are hidden unless requested. Paginated response: { projects, hasMore, offset }.',
      inputSchema: {
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived projects alongside active ones.'),
        archivedOnly: z
          .boolean()
          .optional()
          .describe('Return ONLY archived projects.'),
        ...pageInputs
      }
    },
    async ({ includeArchived, archivedOnly, limit, offset }) => {
      // Scope filtering must precede the page (it removes rows the token can't
      // see), so a DB limit/offset would page the wrong set — slice in memory.
      const all = filterProjectsByScope(
        await listProjects(db, { includeArchived, archivedOnly }),
        scope
      )
      const start = offset ?? 0
      return asJson({
        projects: all.slice(start, start + limit),
        hasMore: all.length > start + limit,
        offset: start
      })
    }
  )

  server.registerTool(
    'get_project',
    {
      description: 'Get one project by its human-readable slug.',
      inputSchema: { slug: z.string().describe('Project slug (e.g. \'my-app\')') }
    },
    async ({ slug }) => asJson(await getProjectBySlug(db, slug))
  )

  server.registerTool(
    'create_project',
    {
      description:
        'Create a project workspace. keyPrefix controls new card keys (for example, AB produces AB-1); when omitted, it is derived from the slug.',
      inputSchema: {
        name: z.string().min(1).max(120),
        slug: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-z0-9][a-z0-9-]*$/),
        description: z.string().max(2000).optional(),
        keyPrefix: z
          .string()
          .min(1)
          .max(10)
          .regex(/^[A-Z][A-Z0-9]{0,9}$/)
          .optional()
          .describe('Uppercase letters/digits, starting with a letter. Max 10 chars.')
      }
    },
    async input => asJson(projectAck(await createProject(db, input)))
  )

  server.registerTool(
    'update_project',
    {
      description:
        'Update a project name, slug, or both. Its id, key prefix, existing card keys, access grants, repository, and relationships remain unchanged.',
      inputSchema: z.object({
        id: z.string(),
        name: z.string().min(1).max(120).optional(),
        slug: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .optional()
      }).strict().refine(
        input => input.name !== undefined || input.slug !== undefined,
        { message: 'At least one of name or slug is required' }
      )
    },
    async input => asJson(await updateProjectIdentity(db, input))
  )

  server.registerTool(
    'update_project_key_prefix',
    {
      description:
        'Change the prefix used for new card keys. Existing card keys are never renamed.',
      inputSchema: {
        id: z.string(),
        newPrefix: z
          .string()
          .min(1)
          .max(10)
          .regex(/^[A-Z][A-Z0-9]{0,9}$/)
      }
    },
    async ({ id, newPrefix }) =>
      asJson(projectAck(await updateProjectKeyPrefix(db, id, newPrefix)))
  )

  server.registerTool(
    'archive_project',
    {
      description:
        'Archive a project reversibly. It disappears from normal listings but remains available to restore.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(projectAck(await archiveProject(db, id)))
  )

  server.registerTool(
    'restore_project',
    {
      description: 'Restore an archived project to normal listings.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(projectAck(await restoreProject(db, id)))
  )

  server.registerTool(
    'destroy_project',
    {
      description:
        'Permanently delete a project and all of its sprints, cards, docs, tags, and comments. Irreversible; confirmSlug must exactly match the project slug.',
      inputSchema: {
        id: z.string(),
        confirmSlug: z
          .string()
          .describe('Must equal the project slug to confirm the deletion.')
      }
    },
    async ({ id, confirmSlug }) =>
      asJson(await destroyProject(db, id, confirmSlug))
  )

  server.registerTool(
    'set_project_repo',
    {
      description:
        'Set the GitHub or GitLab repository used to link commit hashes, or clear it by passing null for both fields. repoWebUrl is the browser URL without .git.',
      inputSchema: {
        id: z.string(),
        provider: z.enum(['github', 'gitlab']).nullable(),
        repoWebUrl: z
          .url()
          .nullable()
          .describe('Repo web base, e.g. https://github.com/owner/repo (no .git).')
      }
    },
    async ({ id, provider, repoWebUrl }) =>
      asJson(
        projectAck(
          await setProjectRepo(db, { projectId: id, provider, repoWebUrl }),
          'repoProvider',
          'repoWebUrl'
        )
      )
  )
}
