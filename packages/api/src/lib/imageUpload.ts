import type { FastifyRequest } from 'fastify'
import sharp from 'sharp'

import { createAttachment, InputError } from '@agents-board/core'
import type { Database } from '@agents-board/db'
import { ATTACHMENT_MIME_TYPES } from '@agents-board/shared'

// Accept ceiling before optimization; the route's multipart fileSize limit
// mirrors the elevated bodyLimit the backup import uses.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
// Above this the model gains nothing from the extra pixels and the bytes just
// pile up; the longest edge is clamped here.
const MAX_EDGE = 1568
const WEBP_QUALITY = 80

interface ParsedUpload {
  file?: { mime: string, filename: string | null, data: Buffer }
  fields: Record<string, string>
}

// Stream the multipart body once, in part order, so field/file ordering doesn't
// matter; keep only the first file and drain any extras.
export async function readUpload(req: FastifyRequest): Promise<ParsedUpload> {
  const fields: Record<string, string> = {}
  let file: ParsedUpload['file']
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const data = await part.toBuffer()
      if (!file) file = { mime: part.mimetype, filename: part.filename ?? null, data }
    } else {
      fields[part.fieldname] = String(part.value)
    }
  }
  return { file, fields }
}

async function optimize(input: Buffer, mime: string) {
  // Animated GIFs keep their frames as an animated WebP; everything else is a
  // single frame. `.rotate()` bakes EXIF orientation in before sharp drops all
  // metadata (the default — no `.withMetadata()`), so the image stays upright
  // without leaking EXIF.
  const pipeline = sharp(input, { animated: mime === 'image/gif', failOn: 'none' })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

// Reads the multipart upload, validates the mime, optimizes via sharp and stores
// it as a (born-orphan) attachment for the project. Translates the multipart
// failure modes to InputError (→ 400). Shared by the markdown-attachment upload
// and the diff-image capture endpoint.
export async function storeImageUpload(
  db: Database,
  req: FastifyRequest,
  projectId: string
) {
  let upload: ParsedUpload
  try {
    upload = await readUpload(req)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new InputError('Image exceeds the 10 MB upload limit')
    }
    // Any other `FST_*` (wrong content-type, too many parts/files…) is a
    // malformed request from the client → 400, not a server fault.
    if (typeof code === 'string' && code.startsWith('FST_')) {
      throw new InputError((err as Error).message)
    }
    throw err
  }

  const file = upload.file
  if (!file) throw new InputError('No image file in the upload')
  if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.mime)) {
    throw new InputError(
      `Unsupported image type "${file.mime}". Allowed: ${ATTACHMENT_MIME_TYPES.join(', ')}.`
    )
  }

  let optimized
  try {
    optimized = await optimize(file.data, file.mime)
  } catch {
    throw new InputError('The file is not a valid image or could not be processed')
  }

  return createAttachment(db, {
    projectId,
    mime: 'image/webp',
    data: new Uint8Array(optimized.data),
    width: optimized.width,
    height: optimized.height,
    filename: file.filename,
    description: upload.fields.description ?? null
  })
}
