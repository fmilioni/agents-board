import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { schema } from '@claude-organizer/db'

import {
  addComment,
  addTagToCard,
  createAttachment,
  createCard,
  createDoc,
  createIntakeItem,
  createProject,
  createSprint,
  createTag,
  exportProject,
  getAttachment,
  importBackup,
  listAttachments,
  serializeBackup,
  setIncludeAttachmentsInBackup,
  updateCard
} from '../src/index'
import { freshProject, useTestDb } from './helpers'

// Isolated DB: these tests flip the global `includeAttachmentsInBackup` toggle — see
// attachment-gc.test.ts.
const ctx = useTestDb({ isolated: true })

async function seedProject() {
  const project = await freshProject(ctx.db)
  const sprint = await createSprint(ctx.db, {
    projectId: project.id,
    name: 'S1'
  })
  const card = await createCard(ctx.db, {
    projectId: project.id,
    sprintId: sprint.id,
    title: 'Card A'
  })
  const tag = await createTag(ctx.db, { projectId: project.id, name: 'area' })
  await addTagToCard(ctx.db, card.id, tag.id)
  await addComment(ctx.db, { cardId: card.id, author: 'user', bodyMd: 'hi' })
  return { project, card }
}

const cardsOf = (projectId: string) =>
  ctx.db.select().from(schema.cards).where(eq(schema.cards.projectId, projectId))

describe('importBackup — restore as new', () => {
  it('recreates a project with fresh ids but preserved keys', async () => {
    const { project, card } = await seedProject()
    const env = await exportProject(ctx.db, project.id)

    const { projectIds } = await importBackup(ctx.db, serializeBackup(env))
    expect(projectIds).toHaveLength(1)
    const newId = projectIds[0]!
    expect(newId).not.toBe(project.id)

    const imported = await cardsOf(newId)
    expect(imported.map(c => c.key)).toContain(card.key)
    expect(imported.every(c => c.id !== card.id)).toBe(true)

    const [newProject] = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, newId))
    const [orig] = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id))
    expect(newProject!.nextKeySeq).toBe(orig!.nextKeySeq)
  })

  it('deterministically suffixes a colliding slug/keyPrefix', async () => {
    const { project } = await seedProject()
    const env = await exportProject(ctx.db, project.id)
    const gz = serializeBackup(env)

    const first = await importBackup(ctx.db, gz)
    const second = await importBackup(ctx.db, gz)

    const [p1] = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, first.projectIds[0]!))
    const [p2] = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, second.projectIds[0]!))
    expect(p2!.slug).not.toBe(p1!.slug)
    expect(p2!.keyPrefix).not.toBe(p1!.keyPrefix)
  })

  it('suffixes only the field that collides, leaving the free one untouched', async () => {
    const { project } = await seedProject()
    const blocker = await freshProject(ctx.db, 'ZZ')

    const slugClash = await exportProject(ctx.db, project.id)
    const a = slugClash.data.projects![0] as { slug: string, keyPrefix: string }
    a.slug = blocker.slug
    a.keyPrefix = 'QQ'
    const r1 = await importBackup(ctx.db, serializeBackup(slugClash))
    const [imp1] = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, r1.projectIds[0]!))
    expect(imp1!.slug).not.toBe(blocker.slug)
    expect(imp1!.keyPrefix).toBe('QQ')

    const prefixClash = await exportProject(ctx.db, project.id)
    const b = prefixClash.data.projects![0] as { slug: string, keyPrefix: string }
    b.slug = 'a-free-and-unused-slug'
    b.keyPrefix = blocker.keyPrefix
    const r2 = await importBackup(ctx.db, serializeBackup(prefixClash))
    const [imp2] = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, r2.projectIds[0]!))
    expect(imp2!.slug).toBe('a-free-and-unused-slug')
    expect(imp2!.keyPrefix).not.toBe(blocker.keyPrefix)
  })

  it('caps a suffixed slug at 60 chars on collision', async () => {
    const longSlug = 'a'.repeat(60)
    await createProject(ctx.db, {
      name: 'Long',
      slug: longSlug,
      keyPrefix: 'LS'
    })
    const { project } = await seedProject()
    const env = await exportProject(ctx.db, project.id)
    const p = env.data.projects![0] as { slug: string, keyPrefix: string }
    p.slug = longSlug
    p.keyPrefix = 'XY'
    const { projectIds } = await importBackup(ctx.db, serializeBackup(env))
    const [imp] = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectIds[0]!))
    expect(imp!.slug).not.toBe(longSlug)
    expect(imp!.slug.length).toBeLessThanOrEqual(60)
  })

  it('clamps an over-long slug/keyPrefix even without a collision', async () => {
    const { project } = await seedProject()
    const env = await exportProject(ctx.db, project.id)
    const p = env.data.projects![0] as { slug: string, keyPrefix: string }
    p.slug = 'b'.repeat(80)
    p.keyPrefix = 'C'.repeat(15)
    const { projectIds } = await importBackup(ctx.db, serializeBackup(env))
    const [imp] = await ctx.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectIds[0]!))
    expect(imp!.slug.length).toBeLessThanOrEqual(60)
    expect(imp!.keyPrefix.length).toBeLessThanOrEqual(10)
  })

  it('migrates a v0 backup (no intake_items) up to the current format', async () => {
    const { project } = await seedProject()
    const env = await exportProject(ctx.db, project.id)

    const { intake_items, ...dataWithoutIntake } = env.data
    void intake_items
    const v0 = serializeBackup({
      version: 0,
      exportedAt: env.exportedAt,
      scope: 'project',
      projectIds: env.projectIds,
      data: dataWithoutIntake
    })

    const { projectIds } = await importBackup(ctx.db, v0)
    expect(projectIds).toHaveLength(1)
  })

  it('migrates a v2 backup (attachments still carrying owner) by ignoring the owner', async () => {
    const project = await freshProject(ctx.db)
    const card = await createCard(ctx.db, { projectId: project.id, title: 'C' })
    const att = await createAttachment(ctx.db, {
      projectId: project.id,
      mime: 'image/png',
      data: Buffer.from('x'),
      width: 1,
      height: 1
    })
    await updateCard(ctx.db, {
      id: card.id,
      descriptionMd: `![p](/attachments/${att.id})`
    })
    const env = await exportProject(ctx.db, project.id)
    // Forge a v2 envelope: older servers still wrote ownerType/ownerId on each row.
    const attachments = (env.data.attachments as Record<string, unknown>[]).map(
      a => ({ ...a, ownerType: 'card', ownerId: card.id })
    )
    const v2 = serializeBackup({
      ...env,
      version: 2,
      data: { ...env.data, attachments }
    })

    const { projectIds } = await importBackup(ctx.db, v2)
    const list = await listAttachments(ctx.db, { projectId: projectIds[0]! })
    expect(list).toHaveLength(1)
    const restored = (await getAttachment(ctx.db, list[0]!.id))!
    expect(restored.orphanedAt).toBeNull()
  })

  it('rejects a backup from a newer format version', async () => {
    const { project } = await seedProject()
    const env = await exportProject(ctx.db, project.id)
    const future = serializeBackup({ ...env, version: 999 })

    await expect(importBackup(ctx.db, future)).rejects.toThrow()
  })

  it('round-trips an attachment with bytes and rebuilds its link (toggle ON)', async () => {
    await setIncludeAttachmentsInBackup(ctx.db, true)
    const { project, card } = await seedProject()
    const bytes = Buffer.from('hello-bytes', 'utf8')
    const att = await createAttachment(ctx.db, {
      projectId: project.id,
      mime: 'image/png',
      data: bytes,
      width: 3,
      height: 3
    })
    await updateCard(ctx.db, {
      id: card.id,
      descriptionMd: `see ![pic](/attachments/${att.id})`
    })

    const env = await exportProject(ctx.db, project.id)
    const { projectIds } = await importBackup(ctx.db, serializeBackup(env))
    const newId = projectIds[0]!

    const list = await listAttachments(ctx.db, { projectId: newId })
    expect(list).toHaveLength(1)
    const restored = (await getAttachment(ctx.db, list[0]!.id))!
    expect(restored.data).toEqual(bytes)
    // Referenced in the imported card body → its link is rebuilt, not orphaned.
    expect(restored.orphanedAt).toBeNull()
  })

  it('rewrites att_ refs in card/doc/comment/inbox bodies to the new ids', async () => {
    const project = await freshProject(ctx.db)
    const att = await createAttachment(ctx.db, {
      projectId: project.id,
      mime: 'image/png',
      data: Buffer.from('img', 'utf8'),
      width: 1,
      height: 1
    })
    const stranger = 'att_zzzzzzzzzzzz'
    const ref = (id: string) => `before ![pic](/attachments/${id}) after`

    const card = await createCard(ctx.db, {
      projectId: project.id,
      title: 'Card A',
      descriptionMd: `${ref(att.id)} and ${ref(stranger)}`
    })
    await addComment(ctx.db, {
      cardId: card.id,
      author: 'user',
      bodyMd: ref(att.id)
    })
    await createDoc(ctx.db, {
      projectId: project.id,
      title: 'Doc A',
      bodyMd: ref(att.id)
    })
    await createIntakeItem(ctx.db, { projectId: project.id, bodyMd: ref(att.id) })

    const env = await exportProject(ctx.db, project.id)
    const { projectIds } = await importBackup(ctx.db, serializeBackup(env))
    const newId = projectIds[0]!

    const [newAtt] = await listAttachments(ctx.db, { projectId: newId })
    expect(newAtt!.id).not.toBe(att.id)

    const [newCard] = await ctx.db
      .select()
      .from(schema.cards)
      .where(eq(schema.cards.projectId, newId))
    const [newComment] = await ctx.db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.cardId, newCard!.id))
    const [newDoc] = await ctx.db
      .select()
      .from(schema.docs)
      .where(eq(schema.docs.projectId, newId))
    const [newIntake] = await ctx.db
      .select()
      .from(schema.intakeItems)
      .where(eq(schema.intakeItems.projectId, newId))

    for (const body of [
      newCard!.descriptionMd!,
      newComment!.bodyMd,
      newDoc!.bodyMd!,
      newIntake!.bodyMd
    ]) {
      expect(body).toContain(newAtt!.id)
      expect(body).not.toContain(att.id)
    }
    expect(newCard!.descriptionMd).toContain(stranger)
  })

  it('rebuilds the link index and recomputes orphaned_at on import', async () => {
    const project = await freshProject(ctx.db)
    const referenced = await createAttachment(ctx.db, {
      projectId: project.id,
      mime: 'image/png',
      data: Buffer.from('img'),
      width: 1,
      height: 1,
      description: 'referenced'
    })
    await createAttachment(ctx.db, {
      projectId: project.id,
      mime: 'image/png',
      data: Buffer.from('img'),
      width: 1,
      height: 1,
      description: 'orphan'
    })
    await createCard(ctx.db, {
      projectId: project.id,
      title: 'Card A',
      descriptionMd: `![pic](/attachments/${referenced.id})`
    })

    const env = await exportProject(ctx.db, project.id)
    const { projectIds } = await importBackup(ctx.db, serializeBackup(env))
    const newAtts = await listAttachments(ctx.db, { projectId: projectIds[0]! })

    const newReferenced = newAtts.find(a => a.description === 'referenced')!
    const newOrphan = newAtts.find(a => a.description === 'orphan')!

    const links = async (id: string) =>
      (
        await ctx.db
          .select()
          .from(schema.attachmentLinks)
          .where(eq(schema.attachmentLinks.attachmentId, id))
      ).length
    const orphanedAt = async (id: string) =>
      (
        await ctx.db
          .select({ o: schema.attachments.orphanedAt })
          .from(schema.attachments)
          .where(eq(schema.attachments.id, id))
      )[0]?.o ?? null

    // The referenced image got its link rebuilt and is not orphaned…
    expect(await links(newReferenced.id)).toBe(1)
    expect(await orphanedAt(newReferenced.id)).toBeNull()
    // …while the unreferenced one has no link and its grace clock started.
    expect(await links(newOrphan.id)).toBe(0)
    expect(await orphanedAt(newOrphan.id)).not.toBeNull()
  })

  it('leaves bodies untouched when the backup has no attachments', async () => {
    const project = await freshProject(ctx.db)
    const body = 'a stray att_abcdef012345 token, no real attachment'
    await createCard(ctx.db, {
      projectId: project.id,
      title: 'Card A',
      descriptionMd: body
    })

    const env = await exportProject(ctx.db, project.id)
    const { projectIds } = await importBackup(ctx.db, serializeBackup(env))

    const [newCard] = await ctx.db
      .select()
      .from(schema.cards)
      .where(eq(schema.cards.projectId, projectIds[0]!))
    expect(newCard!.descriptionMd).toBe(body)
  })

  it('omits bytes when the backup toggle is OFF (metadata-only attachment)', async () => {
    const { project } = await seedProject()
    await createAttachment(ctx.db, {
      projectId: project.id,
      mime: 'image/png',
      data: Buffer.from('dropped', 'utf8'),
      width: 2,
      height: 2
    })

    // The toggle is a global singleton shared across parallel test files; reset
    // it in finally so a failed assertion can't leak OFF into other exports.
    await setIncludeAttachmentsInBackup(ctx.db, false)
    try {
      const env = await exportProject(ctx.db, project.id)
      expect(env.data.attachments[0]).not.toHaveProperty('data')

      const { projectIds } = await importBackup(ctx.db, serializeBackup(env))
      const list = await listAttachments(ctx.db, { projectId: projectIds[0]! })
      expect(list).toHaveLength(1)
      const restored = (await getAttachment(ctx.db, list[0]!.id))!
      expect(restored.data).toBeNull()
    } finally {
      await setIncludeAttachmentsInBackup(ctx.db, true)
    }
  })
})
