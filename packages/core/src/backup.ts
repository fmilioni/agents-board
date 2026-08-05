import { gunzipSync, gzipSync } from 'node:zlib'

import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'

import { createId, type Database, schema } from '@agents-board/db'
import {
  type AttachmentRow,
  BACKUP_FORMAT_VERSION,
  type BackupEnvelope,
  type BackupScope,
  type CardCommitRow,
  type CardRow,
  type CommentRow,
  type DocRow,
  type IntakeItemRow,
  type ProjectRow,
  type RoadmapRow,
  type SprintRow,
  type TagRow
} from '@agents-board/shared'

import { reconcileAttachmentLinks } from './attachmentLinks'
import { rewriteAttachmentIds } from './attachments'
import { getSystemSettings } from './authz'
import { commitImageLinkBody } from './cardCommits'
import { InputError } from './errors'

// Project-domain tables, parents before children (FK-safe order for the
// importer, CO-142). The coverage test asserts every schema table sits in
// exactly one of BACKUP_TABLE_NAMES or NON_BACKUP_TABLE_NAMES — the "nothing
// left behind" guarantee.
export const BACKUP_TABLE_NAMES = [
  'projects',
  'roadmaps',
  'sprints',
  'cards',
  'comments',
  'docs',
  'tags',
  'card_tags',
  'card_blockers',
  'card_commits',
  'intake_items',
  'attachments'
] as const

// Identity/system tables deliberately kept OUT of project backups: a backup
// imports as a brand-new copy, so duplicating users/sessions or system config
// would be wrong. Listed (not just omitted) so the coverage test forces a
// conscious choice for every future table. `attachment_links` is a derived
// index of the markdown — rebuilt from the imported bodies, never exported. The
// `*_chunks` tables are likewise derived (semantic vectors rebuilt by the
// embedding backfill from each entity's body), so they stay out too.
export const NON_BACKUP_TABLE_NAMES = [
  'users',
  'sessions',
  'accounts',
  'verifications',
  'oauth_applications',
  'oauth_access_tokens',
  'oauth_consents',
  'user_authz',
  'user_project_access',
  'card_claims',
  'system_settings',
  'embedding_runtime',
  'attachment_links',
  'doc_chunks',
  'card_chunks',
  'comment_chunks'
] as const

function envelope(
  scope: BackupScope,
  projectIds: string[],
  data: Record<string, unknown[]>
): BackupEnvelope {
  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    scope,
    projectIds,
    data
  }
}

const emptyData = (): Record<string, unknown[]> =>
  Object.fromEntries(BACKUP_TABLE_NAMES.map(name => [name, []]))

type RawAttachment = typeof schema.attachments.$inferSelect

// bytea can't ride in JSON, so the bytes are base64-encoded into the envelope
// (createdAt stays a Date — JSON.stringify renders it ISO like every other row).
// includeData OFF drops the `data` field entirely (metadata-only), keeping the
// envelope small; the importer tolerates the missing field.
function serializeAttachments(
  rows: RawAttachment[],
  includeData: boolean
): unknown[] {
  return rows.map(({ data, ...meta }) =>
    includeData
      ? { ...meta, data: data ? Buffer.from(data).toString('base64') : null }
      : meta
  )
}

export async function exportAll(db: Database): Promise<BackupEnvelope> {
  const { includeAttachmentsInBackup } = await getSystemSettings(db)
  const [
    projects,
    roadmaps,
    sprints,
    cards,
    comments,
    docs,
    tags,
    cardTags,
    cardBlockers,
    cardCommits,
    intakeItems,
    attachments
  ] = await Promise.all([
    db.select().from(schema.projects),
    db.select().from(schema.roadmaps),
    db.select().from(schema.sprints),
    db.select().from(schema.cards),
    db.select().from(schema.comments),
    db.select().from(schema.docs),
    db.select().from(schema.tags),
    db.select().from(schema.cardTags),
    db.select().from(schema.cardBlockers),
    db.select().from(schema.cardCommits),
    db.select().from(schema.intakeItems),
    db.select().from(schema.attachments)
  ])
  return envelope(
    'all',
    projects.map(p => p.id),
    {
      projects,
      roadmaps,
      sprints,
      cards,
      comments,
      docs,
      tags,
      card_tags: cardTags,
      card_blockers: cardBlockers,
      card_commits: cardCommits,
      intake_items: intakeItems,
      attachments: serializeAttachments(attachments, includeAttachmentsInBackup)
    }
  )
}

export async function exportProject(
  db: Database,
  projectId: string
): Promise<BackupEnvelope> {
  const { includeAttachmentsInBackup } = await getSystemSettings(db)
  const projects = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
  if (!projects.length) return envelope('project', [], emptyData())

  const cards = await db
    .select()
    .from(schema.cards)
    .where(eq(schema.cards.projectId, projectId))
  const cardIds = cards.map(c => c.id)
  const ofCards = <T>(query: Promise<T[]>): Promise<T[]> =>
    cardIds.length ? query : Promise.resolve([])

  const [
    roadmaps,
    sprints,
    comments,
    docs,
    tags,
    cardTags,
    cardBlockers,
    cardCommits,
    intakeItems,
    attachments
  ] = await Promise.all([
    db
      .select()
      .from(schema.roadmaps)
      .where(eq(schema.roadmaps.projectId, projectId)),
    db
      .select()
      .from(schema.sprints)
      .where(eq(schema.sprints.projectId, projectId)),
    ofCards(
      db
        .select()
        .from(schema.comments)
        .where(inArray(schema.comments.cardId, cardIds))
    ),
    db.select().from(schema.docs).where(eq(schema.docs.projectId, projectId)),
    db.select().from(schema.tags).where(eq(schema.tags.projectId, projectId)),
    ofCards(
      db
        .select()
        .from(schema.cardTags)
        .where(inArray(schema.cardTags.cardId, cardIds))
    ),
    // Only intra-project blocker edges: both ends must live in this project so
    // the backup stays self-contained (no dangling FK for the importer).
    ofCards(
      db
        .select()
        .from(schema.cardBlockers)
        .where(
          and(
            inArray(schema.cardBlockers.blockedCardId, cardIds),
            inArray(schema.cardBlockers.blockerCardId, cardIds)
          )
        )
    ),
    ofCards(
      db
        .select()
        .from(schema.cardCommits)
        .where(inArray(schema.cardCommits.cardId, cardIds))
    ),
    db
      .select()
      .from(schema.intakeItems)
      .where(eq(schema.intakeItems.projectId, projectId)),
    db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.projectId, projectId))
  ])

  return envelope(
    'project',
    projects.map(p => p.id),
    {
      projects,
      roadmaps,
      sprints,
      cards,
      comments,
      docs,
      tags,
      card_tags: cardTags,
      card_blockers: cardBlockers,
      card_commits: cardCommits,
      intake_items: intakeItems,
      attachments: serializeAttachments(attachments, includeAttachmentsInBackup)
    }
  )
}

export function serializeBackup(env: BackupEnvelope): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(env), 'utf8'))
}

type BackupData = Record<string, unknown[]>

// Migrators that lift an old backup payload to the next format version:
// MIGRATORS[v] turns a v-payload into a (v+1)-payload. Append one per format
// bump; the chain runs them in order so an old backup opens on the current
// server (the central guarantee of CO-140).
const MIGRATORS: Array<(data: BackupData) => BackupData> = [
  // v0 → v1: `intake_items` joined the schema; older backups lack the table.
  data => ({ ...data, intake_items: data.intake_items ?? [] }),
  // v1 → v2: `attachments` joined the schema; older backups lack the table.
  data => ({ ...data, attachments: data.attachments ?? [] }),
  // v2 → v3: the owner-link was dropped (links-only model — CO-310); strip the
  // now-defunct ownerType/ownerId an older envelope still carries on each row.
  data => ({
    ...data,
    attachments: (data.attachments ?? []).map((a) => {
      const row = { ...(a as Record<string, unknown>) }
      delete row.ownerType
      delete row.ownerId
      return row
    })
  })
]

const backupEnvelopeSchema = z
  .object({
    version: z.number().int().nonnegative(),
    exportedAt: z.string(),
    scope: z.enum(['project', 'all']),
    projectIds: z.array(z.string()),
    data: z.record(z.string(), z.array(z.record(z.string(), z.unknown())))
  })
  .strict()

function migrateData(version: number, data: BackupData): BackupData {
  if (version > BACKUP_FORMAT_VERSION) {
    throw new InputError(
      `backup format v${version} is newer than this server (v${BACKUP_FORMAT_VERSION})`
    )
  }
  let out = data
  for (let v = version; v < BACKUP_FORMAT_VERSION; v++) {
    const migrate = MIGRATORS[v]
    if (!migrate) throw new InputError(`no migration path from backup format v${v}`)
    out = migrate(out)
  }
  return out
}

const toDate = (v: string | null | undefined) => (v == null ? null : new Date(v))

export interface ImportResult {
  projectIds: string[]
}

/**
 * Import a backup as a brand-new copy (non-destructive): old internal ids are
 * remapped to fresh ones and FKs reattached, while human keys (`<PREFIX>-N`) and the
 * project's `nextKeySeq` are preserved. A slug/keyPrefix already taken in the
 * destination is deterministically suffixed. Runs the version-migration chain
 * first, so an older backup opens on the current server.
 */
export async function importBackup(
  db: Database,
  gzipped: Buffer | Uint8Array,
  opts: { mode?: 'new' } = {}
): Promise<ImportResult> {
  const mode = opts.mode ?? 'new'
  if (mode !== 'new') throw new InputError(`unsupported import mode: ${mode}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(gunzipSync(gzipped).toString('utf8'))
  } catch {
    throw new InputError('invalid backup file: not a gzipped JSON envelope')
  }

  const env = backupEnvelopeSchema.safeParse(parsed)
  if (!env.success) throw new InputError('invalid backup envelope')

  const data = migrateData(env.data.version, env.data.data)
  const projectIds = await restoreAsNew(db, data)
  return { projectIds }
}

async function restoreAsNew(db: Database, data: BackupData): Promise<string[]> {
  return db.transaction(async (tx) => {
    const P: Record<string, string> = {}
    const R: Record<string, string> = {}
    const S: Record<string, string> = {}
    const T: Record<string, string> = {}
    const C: Record<string, string> = {}
    const D: Record<string, string> = {}
    const CM: Record<string, string> = {}
    const IT: Record<string, string> = {}
    const A: Record<string, string> = {}

    // A slug is unique by constraint; keyPrefix we keep distinct too so future
    // keys stay unambiguous. Each field is suffixed independently — only the one
    // that actually collides moves — checking both the destination DB and the
    // identities allocated earlier in this same run (a scope=all backup can carry
    // projects whose roots collide). Both the base and the suffixed forms are
    // capped to createProject's limits (slug ≤ 60, keyPrefix ≤ 10).
    const takenSlugs = new Set<string>()
    const takenPrefixes = new Set<string>()
    const slugTaken = async (s: string) =>
      takenSlugs.has(s)
      || (
        await tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.slug, s))
          .limit(1)
      ).length > 0
    const prefixTaken = async (k: string) =>
      takenPrefixes.has(k)
      || (
        await tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(eq(schema.projects.keyPrefix, k))
          .limit(1)
      ).length > 0
    async function uniqueIdentity(slug: string, keyPrefix: string) {
      // Clamp the base up front: a backup's text columns carry no length limit,
      // so an over-long identity must be trimmed to createProject's bounds even
      // when it doesn't collide.
      let s = slug.slice(0, 60)
      for (let n = 2; await slugTaken(s); n++) {
        const suffix = `-${n}`
        s = `${slug.slice(0, 60 - suffix.length)}${suffix}`
      }
      let k = keyPrefix.slice(0, 10)
      for (let n = 2; await prefixTaken(k); n++) {
        const suffix = String(n)
        k = `${keyPrefix.slice(0, 10 - suffix.length)}${suffix}`
      }
      takenSlugs.add(s)
      takenPrefixes.add(k)
      return { slug: s, keyPrefix: k }
    }

    const rows = <T2>(key: string) => (data[key] ?? []) as T2[]
    const projectIds: string[] = []

    for (const p of rows<ProjectRow>('projects')) {
      const id = createId('prj')
      P[p.id] = id
      projectIds.push(id)
      const { slug, keyPrefix } = await uniqueIdentity(p.slug, p.keyPrefix)
      await tx.insert(schema.projects).values({
        id,
        slug,
        name: p.name,
        description: p.description,
        keyPrefix,
        nextKeySeq: p.nextKeySeq,
        repoProvider: p.repoProvider,
        repoWebUrl: p.repoWebUrl,
        createdAt: new Date(p.createdAt),
        updatedAt: new Date(p.updatedAt),
        archivedAt: toDate(p.archivedAt)
      })
    }

    for (const r of rows<RoadmapRow>('roadmaps')) {
      const id = createId('rdm')
      R[r.id] = id
      await tx.insert(schema.roadmaps).values({
        id,
        projectId: P[r.projectId]!,
        name: r.name,
        description: r.description,
        createdAt: new Date(r.createdAt),
        updatedAt: new Date(r.updatedAt)
      })
    }

    for (const s of rows<SprintRow>('sprints')) {
      const id = createId('spr')
      S[s.id] = id
      await tx.insert(schema.sprints).values({
        id,
        projectId: P[s.projectId]!,
        roadmapId: s.roadmapId ? R[s.roadmapId]! : null,
        name: s.name,
        goal: s.goal,
        status: s.status,
        startsAt: toDate(s.startsAt),
        endsAt: toDate(s.endsAt),
        createdAt: new Date(s.createdAt),
        updatedAt: new Date(s.updatedAt),
        archivedAt: toDate(s.archivedAt)
      })
    }

    for (const t of rows<TagRow>('tags')) {
      const id = createId('tag')
      T[t.id] = id
      await tx.insert(schema.tags).values({
        id,
        projectId: P[t.projectId]!,
        name: t.name,
        color: t.color,
        createdAt: new Date(t.createdAt)
      })
    }

    const cards = rows<CardRow>('cards')
    for (const c of cards) {
      const id = createId('crd')
      C[c.id] = id
      // parentId reattached in a second pass once every card id exists.
      await tx.insert(schema.cards).values({
        id,
        projectId: P[c.projectId]!,
        sprintId: c.sprintId ? S[c.sprintId]! : null,
        parentId: null,
        key: c.key,
        title: c.title,
        summary: c.summary,
        descriptionMd: c.descriptionMd,
        status: c.status,
        priority: c.priority,
        dueDate: toDate(c.dueDate),
        position: c.position,
        createdAt: new Date(c.createdAt),
        updatedAt: new Date(c.updatedAt),
        archivedAt: toDate(c.archivedAt)
      })
    }
    for (const c of cards) {
      if (c.parentId && C[c.parentId]) {
        await tx
          .update(schema.cards)
          .set({ parentId: C[c.parentId]! })
          .where(eq(schema.cards.id, C[c.id]!))
      }
    }

    for (const cm of rows<CommentRow & { readByAi?: boolean }>('comments')) {
      const id = createId('cmt')
      CM[cm.id] = id
      await tx.insert(schema.comments).values({
        id,
        cardId: C[cm.cardId]!,
        author: cm.author,
        bodyMd: cm.bodyMd,
        // Pre-CO-343 backups carry the legacy `readByAi` boolean, not `aiStatus`.
        aiStatus: cm.aiStatus ?? (cm.readByAi ? 'handled' : 'unread'),
        createdAt: new Date(cm.createdAt)
      })
    }

    const docs = rows<DocRow>('docs')
    for (const d of docs) {
      const id = createId('doc')
      D[d.id] = id
      await tx.insert(schema.docs).values({
        id,
        projectId: P[d.projectId]!,
        parentId: null,
        title: d.title,
        summary: d.summary,
        bodyMd: d.bodyMd,
        kind: d.kind,
        position: d.position,
        createdAt: new Date(d.createdAt),
        updatedAt: new Date(d.updatedAt),
        archivedAt: toDate(d.archivedAt)
      })
    }
    for (const d of docs) {
      if (d.parentId && D[d.parentId]) {
        await tx
          .update(schema.docs)
          .set({ parentId: D[d.parentId]! })
          .where(eq(schema.docs.id, D[d.id]!))
      }
    }

    for (const ct of rows<{ cardId: string, tagId: string }>('card_tags')) {
      if (C[ct.cardId] && T[ct.tagId]) {
        await tx
          .insert(schema.cardTags)
          .values({ cardId: C[ct.cardId]!, tagId: T[ct.tagId]! })
      }
    }

    for (const b of rows<{ blockedCardId: string, blockerCardId: string }>(
      'card_blockers'
    )) {
      if (C[b.blockedCardId] && C[b.blockerCardId]) {
        await tx.insert(schema.cardBlockers).values({
          blockedCardId: C[b.blockedCardId]!,
          blockerCardId: C[b.blockerCardId]!
        })
      }
    }

    for (const cc of rows<CardCommitRow>('card_commits')) {
      await tx.insert(schema.cardCommits).values({
        id: createId('ccm'),
        cardId: C[cc.cardId]!,
        sha: cc.sha,
        message: cc.message,
        stat: cc.stat,
        diff: cc.diff,
        committedAt: toDate(cc.committedAt),
        authorName: cc.authorName,
        createdAt: new Date(cc.createdAt)
      })
    }

    for (const it of rows<IntakeItemRow>('intake_items')) {
      const id = createId('itk')
      IT[it.id] = id
      await tx.insert(schema.intakeItems).values({
        id,
        projectId: P[it.projectId]!,
        bodyMd: it.bodyMd,
        status: it.status,
        plannedCardKeys: it.plannedCardKeys,
        createdAt: new Date(it.createdAt),
        updatedAt: new Date(it.updatedAt),
        archivedAt: toDate(it.archivedAt)
      })
    }

    // Links-only model: an attachment belongs to its project, and where it's
    // referenced is rebuilt below from the rewritten bodies (reconcile) — no owner
    // to remap. `data` rode in as base64 (or is absent when exported with the
    // toggle OFF).
    for (const a of rows<AttachmentRow & { data?: string | null }>(
      'attachments'
    )) {
      const newId = createId('att')
      A[a.id] = newId
      await tx.insert(schema.attachments).values({
        id: newId,
        projectId: P[a.projectId]!,
        mime: a.mime,
        filename: a.filename,
        byteSize: a.byteSize,
        width: a.width,
        height: a.height,
        description: a.description,
        data: typeof a.data === 'string' ? Buffer.from(a.data, 'base64') : null,
        createdAt: new Date(a.createdAt)
      })
    }

    // Bodies were inserted with the old `att_` ids still embedded; now that the
    // attachment id-map exists, rewrite the references so imported images keep
    // resolving (keyed by id token, not URL shape), then rebuild the derived
    // link index (not exported — CO-293) from the rewritten bodies and recompute
    // orphaned_at. Without the rebuild every imported attachment would have no
    // link and look orphaned.
    if (Object.keys(A).length) {
      for (const c of cards) {
        const next = rewriteAttachmentIds(c.descriptionMd, A)
        if (next !== c.descriptionMd) {
          await tx.update(schema.cards)
            .set({ descriptionMd: next })
            .where(eq(schema.cards.id, C[c.id]!))
        }
        await reconcileAttachmentLinks(tx, 'card', C[c.id]!, next)
      }
      for (const d of docs) {
        const next = rewriteAttachmentIds(d.bodyMd, A)
        if (next !== d.bodyMd) {
          await tx.update(schema.docs)
            .set({ bodyMd: next })
            .where(eq(schema.docs.id, D[d.id]!))
        }
        await reconcileAttachmentLinks(tx, 'doc', D[d.id]!, next)
      }
      for (const cm of rows<CommentRow>('comments')) {
        const next = rewriteAttachmentIds(cm.bodyMd, A)
        if (next != null && next !== cm.bodyMd) {
          await tx.update(schema.comments)
            .set({ bodyMd: next })
            .where(eq(schema.comments.id, CM[cm.id]!))
        }
        await reconcileAttachmentLinks(tx, 'comment', CM[cm.id]!, next)
      }
      for (const it of rows<IntakeItemRow>('intake_items')) {
        const next = rewriteAttachmentIds(it.bodyMd, A)
        if (next != null && next !== it.bodyMd) {
          await tx.update(schema.intakeItems)
            .set({ bodyMd: next })
            .where(eq(schema.intakeItems.id, IT[it.id]!))
        }
        await reconcileAttachmentLinks(tx, 'inbox', IT[it.id]!, next)
      }

      // Diff images: a stored diff carries att ids in its image sentinels, so
      // rewrite them like a body and rebuild the per-card 'commit' links from the
      // (rewritten) diffs — otherwise the imported diff images would point at the
      // old ids and, having no link, get swept as orphans.
      for (const c of cards) {
        const ccs = rows<CardCommitRow>('card_commits').filter(
          cc => cc.cardId === c.id
        )
        if (!ccs.length) continue
        const diffs = ccs.map(cc => ({
          sha: cc.sha,
          prev: cc.diff,
          next: rewriteAttachmentIds(cc.diff, A)
        }))
        for (const { sha, prev, next } of diffs) {
          if (next === prev) continue
          await tx.update(schema.cardCommits)
            .set({ diff: next })
            .where(and(
              eq(schema.cardCommits.cardId, C[c.id]!),
              eq(schema.cardCommits.sha, sha)
            ))
        }
        await reconcileAttachmentLinks(
          tx,
          'commit',
          C[c.id]!,
          commitImageLinkBody(diffs.map(d => d.next))
        )
      }

      // Any imported attachment still unreferenced after the rebuild starts its
      // grace clock, so the sweep eventually collects a genuinely orphaned import.
      await tx
        .update(schema.attachments)
        .set({ orphanedAt: sql`now()` })
        .where(
          and(
            inArray(schema.attachments.id, Object.values(A)),
            sql`not exists (select 1 from ${schema.attachmentLinks} where ${schema.attachmentLinks.attachmentId} = ${schema.attachments.id})`
          )
        )
    }

    return projectIds
  })
}
