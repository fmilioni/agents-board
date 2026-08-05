import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { createId, type Database, schema } from '@agents-board/db'
import { REPO_PROVIDERS } from '@agents-board/shared'

import { archivedCondition, type ArchiveFilter } from './archive'
import { ConflictError, InputError } from './errors'
import { notify } from './events'
import { derivePrefixFromSlug, isValidKeyPrefix } from './keys'

const projectName = z.string().min(1).max(120)
const projectSlug = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens only')

export const createProjectInput = z.object({
  name: projectName,
  slug: projectSlug,
  description: z.string().max(2000).optional(),
  keyPrefix: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]{0,9}$/, 'uppercase letters and digits, starting with a letter')
    .optional()
})
export type CreateProjectInput = z.infer<typeof createProjectInput>

export const updateProjectIdentityInput = z
  .object({
    id: z.string(),
    name: projectName.optional(),
    slug: projectSlug.optional()
  })
  .refine(input => input.name !== undefined || input.slug !== undefined, {
    message: 'At least one of name or slug is required'
  })
export type UpdateProjectIdentityInput = z.infer<
  typeof updateProjectIdentityInput
>

const projectColumns = {
  id: schema.projects.id,
  slug: schema.projects.slug,
  name: schema.projects.name,
  description: schema.projects.description,
  keyPrefix: schema.projects.keyPrefix,
  nextKeySeq: schema.projects.nextKeySeq,
  repoProvider: schema.projects.repoProvider,
  repoWebUrl: schema.projects.repoWebUrl,
  createdAt: schema.projects.createdAt,
  updatedAt: schema.projects.updatedAt,
  archivedAt: schema.projects.archivedAt
}

export async function createProject(db: Database, input: CreateProjectInput) {
  const parsed = createProjectInput.parse(input)
  const keyPrefix = parsed.keyPrefix ?? derivePrefixFromSlug(parsed.slug)
  const [row] = await db
    .insert(schema.projects)
    .values({
      id: createId('prj'),
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description,
      keyPrefix,
      nextKeySeq: 1
    })
    .returning()
  if (row) await notify(db, { type: 'project.changed', projectId: row.id })
  return row
}

export async function listProjects(db: Database, filter?: ArchiveFilter) {
  const archived = archivedCondition(schema.projects.archivedAt, filter)
  const base = db.select(projectColumns).from(schema.projects)
  const rows = archived
    ? await base.where(archived).orderBy(schema.projects.createdAt)
    : await base.orderBy(schema.projects.createdAt)
  return rows
}

export async function archiveProject(db: Database, id: string) {
  const [row] = await db
    .update(schema.projects)
    .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(schema.projects.id, id))
    .returning()
  if (row) await notify(db, { type: 'project.changed', projectId: row.id })
  return row ?? null
}

export async function restoreProject(db: Database, id: string) {
  const [row] = await db
    .update(schema.projects)
    .set({ archivedAt: null, updatedAt: sql`now()` })
    .where(eq(schema.projects.id, id))
    .returning()
  if (row) await notify(db, { type: 'project.changed', projectId: row.id })
  return row ?? null
}

/**
 * Hard-delete a project and everything under it. Sprints, cards, docs, tags and
 * roadmaps reference the project with `onDelete: cascade` (comments, card_tags
 * and blockers cascade from cards), so a single delete removes the whole tree.
 * Irreversible — guarded by `confirmSlug`, which must equal the project's slug.
 */
export async function destroyProject(
  db: Database,
  id: string,
  confirmSlug: string
) {
  const project = await getProjectById(db, id)
  if (!project) return null
  if (confirmSlug !== project.slug) {
    throw new InputError(
      `Slug confirmation does not match. Type "${project.slug}" to destroy this project.`
    )
  }
  await db.delete(schema.projects).where(eq(schema.projects.id, id))
  await notify(db, { type: 'project.deleted', projectId: id })
  return { id: project.id, slug: project.slug, name: project.name }
}

export async function getProjectBySlug(db: Database, slug: string) {
  const [row] = await db
    .select(projectColumns)
    .from(schema.projects)
    .where(eq(schema.projects.slug, slug))
    .limit(1)
  return row ?? null
}

export async function getProjectById(db: Database, id: string) {
  const [row] = await db
    .select(projectColumns)
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .limit(1)
  return row ?? null
}

function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === '23505') return true
  }
  return false
}

export async function updateProjectIdentity(
  db: Database,
  input: UpdateProjectIdentityInput
) {
  const parsed = updateProjectIdentityInput.parse(input)
  try {
    const [row] = await db
      .update(schema.projects)
      .set({
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.slug !== undefined ? { slug: parsed.slug } : {}),
        updatedAt: sql`now()`
      })
      .where(eq(schema.projects.id, parsed.id))
      .returning()
    if (row) await notify(db, { type: 'project.changed', projectId: row.id })
    return row ?? null
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('Project slug is already in use')
    }
    throw error
  }
}

export async function updateProjectKeyPrefix(
  db: Database,
  projectId: string,
  newPrefix: string
) {
  if (!isValidKeyPrefix(newPrefix)) {
    throw new InputError(
      'Invalid keyPrefix. Use uppercase letters/digits, starting with a letter, max 10 chars.'
    )
  }
  const [row] = await db
    .update(schema.projects)
    .set({ keyPrefix: newPrefix, updatedAt: sql`now()` })
    .where(eq(schema.projects.id, projectId))
    .returning()
  if (row) await notify(db, { type: 'project.changed', projectId: row.id })
  return row ?? null
}

export const setProjectRepoInput = z.object({
  projectId: z.string(),
  provider: z.enum(REPO_PROVIDERS).nullable(),
  repoWebUrl: z
    .url()
    .transform(u => u.replace(/\.git$/, '').replace(/\/+$/, ''))
    .nullable()
})
export type SetProjectRepoInput = z.input<typeof setProjectRepoInput>

/**
 * Point a project at its source repository (or clear it with nulls) so the web
 * can link a commit hash to the provider's commit page. The agents-board
 * skill detects the git remote and calls this; there is no manual edit UI yet.
 */
export async function setProjectRepo(db: Database, input: SetProjectRepoInput) {
  const parsed = setProjectRepoInput.parse(input)
  const [row] = await db
    .update(schema.projects)
    .set({
      repoProvider: parsed.provider,
      repoWebUrl: parsed.repoWebUrl,
      updatedAt: sql`now()`
    })
    .where(eq(schema.projects.id, parsed.projectId))
    .returning()
  if (row) await notify(db, { type: 'project.changed', projectId: row.id })
  return row ?? null
}
