import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { schema } from '@agents-board/db'

import {
  approveUser,
  archiveProject,
  canAccessProject,
  ConflictError,
  createCard,
  createSprint,
  destroyProject,
  getCard,
  getProjectById,
  getProjectBySlug,
  listProjects,
  restoreProject,
  setProjectRepo,
  updateProjectIdentity
} from '../src/index'
import { freshProject, useTestDb } from './helpers'

const ctx = useTestDb()

const has = (list: { id: string }[], id: string) =>
  list.some(p => p.id === id)

describe('archiving projects', () => {
  it('hides an archived project from the default list; archivedOnly/includeArchived reveal it', async () => {
    const project = await freshProject(ctx.db)
    expect(has(await listProjects(ctx.db), project.id)).toBe(true)

    await archiveProject(ctx.db, project.id)
    expect(has(await listProjects(ctx.db), project.id)).toBe(false)
    expect(
      has(await listProjects(ctx.db, { archivedOnly: true }), project.id)
    ).toBe(true)
    expect(
      has(await listProjects(ctx.db, { includeArchived: true }), project.id)
    ).toBe(true)
  })

  it('restores an archived project back into the default list', async () => {
    const project = await freshProject(ctx.db)
    await archiveProject(ctx.db, project.id)
    await restoreProject(ctx.db, project.id)
    expect(has(await listProjects(ctx.db), project.id)).toBe(true)
  })
})

describe('destroying projects', () => {
  it('refuses to destroy with a non-matching slug and deletes nothing', async () => {
    const project = await freshProject(ctx.db)
    await expect(
      destroyProject(ctx.db, project.id, 'definitely-wrong')
    ).rejects.toThrow()
    expect(await getProjectById(ctx.db, project.id)).not.toBeNull()
  })

  it('destroys the project and cascades to its cards when the slug matches', async () => {
    const project = await freshProject(ctx.db)
    const sprint = await createSprint(ctx.db, {
      projectId: project.id,
      name: 'S'
    })
    const card = await createCard(ctx.db, {
      projectId: project.id,
      sprintId: sprint.id,
      title: 'doomed'
    })

    const result = await destroyProject(ctx.db, project.id, project.slug)
    expect(result?.id).toBe(project.id)
    expect(await getProjectById(ctx.db, project.id)).toBeNull()
    expect(await getCard(ctx.db, card.id)).toBeNull()
  })
})

describe('updating project identity', () => {
  it('updates name, slug, or both while keeping the project identity stable', async () => {
    const project = await freshProject(ctx.db)
    const nameOnly = await updateProjectIdentity(ctx.db, {
      id: project.id,
      name: 'Renamed Project'
    })

    expect(nameOnly).toMatchObject({
      id: project.id,
      name: 'Renamed Project',
      slug: project.slug,
      keyPrefix: project.keyPrefix,
      nextKeySeq: project.nextKeySeq
    })
    expect(nameOnly!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      project.updatedAt.getTime()
    )

    const slugOnly = await updateProjectIdentity(ctx.db, {
      id: project.id,
      slug: 'renamed-project'
    })
    expect(slugOnly).toMatchObject({
      id: project.id,
      name: 'Renamed Project',
      slug: 'renamed-project'
    })
    expect(await getProjectBySlug(ctx.db, project.slug)).toBeNull()
    expect(await getProjectBySlug(ctx.db, 'renamed-project')).toMatchObject({
      id: project.id
    })

    const both = await updateProjectIdentity(ctx.db, {
      id: project.id,
      name: 'Final Project',
      slug: 'final-project'
    })
    expect(both).toMatchObject({
      id: project.id,
      name: 'Final Project',
      slug: 'final-project',
      keyPrefix: project.keyPrefix,
      nextKeySeq: project.nextKeySeq
    })
  })

  it('rejects empty and invalid changes before writing', async () => {
    const project = await freshProject(ctx.db)

    await expect(
      updateProjectIdentity(ctx.db, { id: project.id })
    ).rejects.toThrow('At least one of name or slug is required')
    await expect(
      updateProjectIdentity(ctx.db, { id: project.id, name: '' })
    ).rejects.toThrow()
    await expect(
      updateProjectIdentity(ctx.db, { id: project.id, slug: 'Not Valid' })
    ).rejects.toThrow()
    expect(await getProjectById(ctx.db, project.id)).toMatchObject({
      name: project.name,
      slug: project.slug
    })
  })

  it('returns null when the project does not exist', async () => {
    await expect(
      updateProjectIdentity(ctx.db, {
        id: 'prj_missing',
        name: 'Missing Project'
      })
    ).resolves.toBeNull()
  })

  it('rejects slugs used by active or archived projects without changing the name', async () => {
    const target = await freshProject(ctx.db)
    const active = await freshProject(ctx.db)
    const archived = await freshProject(ctx.db)
    await archiveProject(ctx.db, archived.id)

    await expect(
      updateProjectIdentity(ctx.db, {
        id: target.id,
        name: 'Must Not Persist',
        slug: active.slug
      })
    ).rejects.toBeInstanceOf(ConflictError)
    await expect(
      updateProjectIdentity(ctx.db, {
        id: target.id,
        slug: archived.slug
      })
    ).rejects.toBeInstanceOf(ConflictError)
    expect(await getProjectById(ctx.db, target.id)).toMatchObject({
      name: target.name,
      slug: target.slug
    })
  })

  it('preserves card keys and project relations after a rename', async () => {
    const project = await freshProject(ctx.db)
    await setProjectRepo(ctx.db, {
      projectId: project.id,
      provider: 'github',
      repoWebUrl: 'https://github.com/example/stable'
    })
    const userId = `usr_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    await ctx.db.insert(schema.users).values({
      id: userId,
      name: 'Project User',
      email: `${userId}@example.test`
    })
    await approveUser(ctx.db, userId, {
      role: 'user',
      allProjects: false,
      projectIds: [project.id]
    })
    const sprint = await createSprint(ctx.db, {
      projectId: project.id,
      name: 'Stable Sprint'
    })
    const card = await createCard(ctx.db, {
      projectId: project.id,
      sprintId: sprint.id,
      title: 'Stable Card'
    })

    await updateProjectIdentity(ctx.db, {
      id: project.id,
      name: 'Stable Identity',
      slug: 'stable-identity'
    })

    expect(await getCard(ctx.db, card.id)).toMatchObject({
      key: card.key,
      projectId: project.id,
      sprintId: sprint.id
    })
    expect(await getProjectById(ctx.db, project.id)).toMatchObject({
      id: project.id,
      keyPrefix: project.keyPrefix,
      nextKeySeq: project.nextKeySeq + 1,
      repoProvider: 'github',
      repoWebUrl: 'https://github.com/example/stable'
    })
    expect(await canAccessProject(ctx.db, userId, project.id)).toBe(true)

    const nextCard = await createCard(ctx.db, {
      projectId: project.id,
      title: 'Next Stable Card'
    })
    expect(nextCard.key).toBe(`${project.keyPrefix}-2`)
  })
})
