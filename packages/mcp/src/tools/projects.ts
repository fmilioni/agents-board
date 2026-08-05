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
        'List all projects tracked by agents-board. Pages with limit/offset; response is { projects, hasMore, offset }. Archived projects are hidden by default.',
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
      description: 'Get a project by its slug.',
      inputSchema: { slug: z.string().describe('Project slug (e.g. \'my-app\')') }
    },
    async ({ slug }) => asJson(await getProjectBySlug(db, slug))
  )

  server.registerTool(
    'create_project',
    {
      description:
        'Create a new project workspace. keyPrefix becomes the prefix for card keys (e.g. \'AB\' produces AB-1, AB-2). If omitted, derived from the slug.',
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
        'Administratively update a project name, slug, or both. The project id, key prefix, existing card keys, grants, repository, and relationships remain unchanged.',
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
        'Change the keyPrefix of a project. Existing card keys are NOT renamed - only new cards use the new prefix.',
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
        'Archive a project (soft, reversible). It disappears from list_projects by default and can be restored.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(projectAck(await archiveProject(db, id)))
  )

  server.registerTool(
    'restore_project',
    {
      description: 'Restore a previously archived project.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(projectAck(await restoreProject(db, id)))
  )

  server.registerTool(
    'destroy_project',
    {
      description:
        'DESTRUCTIVE & IRREVERSIBLE: permanently delete a project and EVERYTHING under it (sprints, cards, docs, tags, comments). Requires `confirmSlug` to equal the project slug; otherwise nothing is deleted.',
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
        'Set (or clear) the project\'s source repository so commit hashes link to the provider\'s commit page. Pass `provider` (github|gitlab) + `repoWebUrl` (e.g. https://github.com/owner/repo), or null on both to clear. The skill calls this after detecting the git remote.',
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
