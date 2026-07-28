#!/usr/bin/env node
// Upload an image to a project and print the markdown that references it.
//
//   node scripts/attach-image.mjs <file> <projectId> [alt text]
//   pnpm attach-image <file> <projectId> [alt text]
//
// The bytes go straight from disk to the API over HTTP — they never pass through
// an AI context. What comes back is the attachment id and a `![alt](/attachments/att_X)`
// to paste into a card, doc, comment or inbox body; saving that body is what
// links the attachment (an upload nobody references is swept after the grace
// window).
//
// Zero dependencies: standalone Node 18+ (global fetch). A Python twin lives at
// scripts/attach-image.py for machines without Node. Keep the two in sync.
//
// Config: CO_API_URL (default http://127.0.0.1:4400), CO_UPLOAD_TOKEN (only with
// auth on — mint it with the MCP's issue_upload_token).

import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

const API_URL = (process.env.CO_API_URL || 'http://127.0.0.1:4400').replace(/\/$/, '')
const UPLOAD_TOKEN = process.env.CO_UPLOAD_TOKEN

// Mirrors ATTACHMENT_MIME_TYPES in @claude-organizer/shared.
const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}
// The API's own ceiling; failing here says so instead of spending the upload.
const MAX_BYTES = 10 * 1024 * 1024

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function main() {
  const [file, projectId, ...altParts] = process.argv.slice(2)
  if (!file || !projectId) {
    fail('usage: attach-image <file> <projectId> [alt text]')
  }

  let size
  try {
    const stat = statSync(file)
    if (!stat.isFile()) fail(`${file} is not a file`)
    size = stat.size
  } catch {
    fail(`no such file: ${file}`)
  }

  const ext = extname(file).slice(1).toLowerCase()
  const mime = EXT_MIME[ext]
  if (!mime) {
    fail(
      `unsupported image type "${ext || basename(file)}". Allowed: ${Object.keys(EXT_MIME).join(', ')}.`
    )
  }
  if (size > MAX_BYTES) {
    fail(`${humanBytes(size)} exceeds the ${humanBytes(MAX_BYTES)} upload limit`)
  }

  const form = new FormData()
  form.append('file', new Blob([readFileSync(file)], { type: mime }), basename(file))

  const res = await fetch(
    `${API_URL}/attachments?projectId=${encodeURIComponent(projectId)}`,
    {
      method: 'POST',
      headers: UPLOAD_TOKEN ? { 'X-CO-Upload-Token': UPLOAD_TOKEN } : {},
      body: form
    }
  ).catch((err) => {
    fail(`could not reach the API at ${API_URL} (${err.message}). Is it running?`)
  })

  if (res.status === 401) {
    fail(
      'API responded 401: auth is on and no valid upload token was sent. Mint one with issue_upload_token(<projectId>) and re-run with CO_UPLOAD_TOKEN=<token>.'
    )
  }
  if (!res.ok) {
    fail(`API responded ${res.status}: ${await res.text()}`)
  }

  const { id, url, width, height } = await res.json()
  const alt = altParts.join(' ').trim()
  if (!alt) {
    console.error(
      '! no alt text given — search finds an image by its description, so pass one'
    )
  }
  console.log(`✓ ${id} — ${width}×${height}, ${humanBytes(size)} read from disk`)
  console.log(`![${alt}](${url})`)
}

main().catch(err => fail(err.message))
