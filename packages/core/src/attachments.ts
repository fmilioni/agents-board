import { desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { createId, type Database, schema } from '@agents-board/db'
import { ATTACHMENT_MIME_TYPES } from '@agents-board/shared'

import { sweepOrphanAttachments } from './attachmentGc'

export const createAttachmentInput = z.object({
  projectId: z.string(),
  mime: z.enum(ATTACHMENT_MIME_TYPES),
  data: z.instanceof(Uint8Array),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  filename: z.string().nullish(),
  description: z.string().nullish()
})
export type CreateAttachmentInput = z.infer<typeof createAttachmentInput>

// Metadata projection — never selects `data`, so list/create payloads stay
// lean; only getAttachment pulls the bytes (the serve path needs them).
const attachmentColumns = {
  id: schema.attachments.id,
  projectId: schema.attachments.projectId,
  mime: schema.attachments.mime,
  filename: schema.attachments.filename,
  byteSize: schema.attachments.byteSize,
  width: schema.attachments.width,
  height: schema.attachments.height,
  description: schema.attachments.description,
  createdAt: schema.attachments.createdAt
}

export async function createAttachment(db: Database, input: CreateAttachmentInput) {
  const parsed = createAttachmentInput.parse(input)
  const data = Buffer.isBuffer(parsed.data) ? parsed.data : Buffer.from(parsed.data)
  const [row] = await db
    .insert(schema.attachments)
    .values({
      id: createId('att'),
      projectId: parsed.projectId,
      mime: parsed.mime,
      filename: parsed.filename ?? null,
      byteSize: data.length,
      width: parsed.width,
      height: parsed.height,
      description: parsed.description ?? null,
      data,
      // Born orphan: the upload precedes the body that references it. Saving the
      // body reconciles a link and clears this; an abandoned upload is swept once
      // the grace window (= the tmp attachment's lifetime) elapses.
      orphanedAt: sql`now()`
    })
    .returning(attachmentColumns)
  // Piggyback the scheduler-less orphan sweep on uploads (a frequent path).
  await sweepOrphanAttachments(db, { projectId: parsed.projectId })
  return row!
}

export async function getAttachment(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, id))
    .limit(1)
  return row ?? null
}

// Metadata only — no bytes. The serve path needs `getAttachment` (with `data`);
// an existence check (e.g. before minting a serve URL) takes this lean read.
export async function getAttachmentMeta(db: Database, id: string) {
  const [row] = await db
    .select(attachmentColumns)
    .from(schema.attachments)
    .where(eq(schema.attachments.id, id))
    .limit(1)
  return row ?? null
}

export async function listAttachments(
  db: Database,
  options: { projectId: string }
) {
  return db
    .select(attachmentColumns)
    .from(schema.attachments)
    .where(eq(schema.attachments.projectId, options.projectId))
    .orderBy(desc(schema.attachments.createdAt))
}

// Attachment ids embedded in entity bodies as `![alt](…att_X…)`. The id token
// is the rewrite key, not the URL wrapper — so it's format-independent.
const attachmentIdToken = /att_[0-9a-z]{12}/g

// Single-pass swap of `att_` tokens via the id-map: an unmapped token is left
// intact, and a freshly-mapped id can't be re-matched by a later replacement.
export function rewriteAttachmentIds(
  body: string | null | undefined,
  idMap: Record<string, string>
): string | null {
  if (!body) return body ?? null
  return body.replace(attachmentIdToken, token => idMap[token] ?? token)
}

export function attachmentIdsInBody(body: string | null | undefined): string[] {
  if (!body) return []
  return [...new Set(body.match(attachmentIdToken) ?? [])]
}
