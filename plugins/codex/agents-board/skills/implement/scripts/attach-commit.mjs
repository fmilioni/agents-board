#!/usr/bin/env node
// Capture a commit's diff and attach it to its card via the REST API.
//
//   node scripts/attach-commit.mjs <sha> [AB-N]
//   pnpm attach-commit <sha> [AB-N]
//
// The card key is parsed from the commit message (`feat(...): … (AB-12)`) unless
// passed explicitly. The diff goes straight from `git` to the API over HTTP — it
// never passes through an AI context (no MCP, no tokens spent reading it).
//
// Zero dependencies: standalone Node 18+ (global fetch). A Python twin lives at
// scripts/attach-commit.py for machines without Node. Keep the two in sync.
//
// Config: AB_API_URL (default http://127.0.0.1:4400).

import { execFileSync } from 'node:child_process'

// Windows' cp1252 console can't encode the ✓/✗/→ glyphs; force UTF-8 so the
// final log doesn't crash after the POST already succeeded.
process.stdout.setDefaultEncoding?.('utf8')
process.stderr.setDefaultEncoding?.('utf8')

const API_URL = (process.env.AB_API_URL || 'http://127.0.0.1:4400').replace(/\/$/, '')

// Card-scoped token minted by the MCP (issue_commit_token); only needed when the
// API has auth on. Absent in sem-auth mode — then no extra header is sent.
const COMMIT_TOKEN = process.env.AB_COMMIT_TOKEN

function withToken(headers = {}) {
  return COMMIT_TOKEN
    ? { ...headers, 'X-AB-Commit-Token': COMMIT_TOKEN }
    : headers
}

// Files whose body is noise: store the header + a note instead of the patch.
const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'bun.lockb'
])
// Per-file line cap; beyond it the patch is truncated with a note.
const MAX_LINES_PER_FILE = 1000

// Raster images are captured as before/after attachments and rendered in the web
// diff (CO-392); other binaries keep the plain note. Mirrors the attachment
// allow-list in @agents-board/shared.
const IMAGE_EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}
// Skip the upload above this and keep the binary note; aligned with the API's
// 10 MB upload ceiling so we never ship a blob the server would reject.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function imageMime(path) {
  return IMAGE_EXT_MIME[(path.split('.').pop() || '').toLowerCase()] || null
}

// The sentinel that replaces `Binary files … differ` so the web can render the
// image. Must match buildDiffImageSentinel / DIFF_IMAGE_SENTINEL_PREFIX in
// @agents-board/shared (a side is omitted when absent).
function imageSentinel(oldId, newId) {
  let line = '# image'
  if (oldId) line += ` old=${oldId}`
  if (newId) line += ` new=${newId}`
  return line
}

// Binary-safe git read (no utf8 decode); null when the path is absent at that ref
// (an added file has no parent blob; a deleted file has none at the commit).
// stderr is ignored — a missing blob is an expected miss, not an error to print.
function gitBlob(args) {
  try {
    return execFileSync('git', args, {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

// Upload one image side to the CO-393 endpoint; returns its att id, or null when
// the blob is missing/over the cap, OR the upload errored — a per-image failure
// degrades to the plain binary note for that section, never discarding the whole
// diff (the diff POST below stays the hard gate on a down API).
async function uploadImage(buf, path, key) {
  if (!buf || !buf.length || buf.length > MAX_IMAGE_BYTES) return null
  const mime = imageMime(path)
  if (!mime) return null
  const form = new FormData()
  form.append('file', new Blob([buf], { type: mime }), path.split('/').pop() || 'image')
  try {
    const res = await fetch(
      `${API_URL}/cards/${encodeURIComponent(key)}/commit-images`,
      { method: 'POST', headers: withToken(), body: form }
    )
    return res.ok ? (await res.json()).id : null
  } catch {
    return null
  }
}

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })
  } catch (err) {
    fail(`git ${args.join(' ')} failed: ${err.message.split('\n')[0]}`)
  }
}

// `AB-12`, `ABC-7` — an uppercase prefix, a dash, digits. We prefer the last
// match on the subject line (the project convention puts the card's own key at
// the end of the subject), then fall back to the whole message.
const KEY_RE = /\b([A-Z][A-Z0-9]*-\d+)\b/g

function parseKey(message) {
  const subject = message.split('\n', 1)[0]
  const onSubject = [...subject.matchAll(KEY_RE)].map(m => m[1])
  if (onSubject.length) return onSubject[onSubject.length - 1]
  const anywhere = [...message.matchAll(KEY_RE)].map(m => m[1])
  return anywhere.length ? anywhere[0] : null
}

function isIgnored(path) {
  const base = path.split('/').pop() || ''
  if (LOCKFILES.has(base)) return true
  if (/\.min\.[^.]+$/.test(base)) return true
  if (path.startsWith('dist/') || path.includes('/dist/')) return true
  return false
}

function sectionPath(lines) {
  for (const l of lines) if (l.startsWith('+++ b/')) return l.slice(6)
  for (const l of lines) if (l.startsWith('--- a/')) return l.slice(6)
  const m = lines[0].match(/^diff --git a\/(.+) b\/(.+)$/)
  return m ? m[2] : ''
}

// Capture an image binary section: upload its old/new blobs and replace the
// binary marker (and any GIT binary patch body) with the image sentinel. Falls
// back to the original lines (plain note) when neither side could be uploaded.
async function captureImageSection(lines, path, key, sha) {
  const oldId = await uploadImage(gitBlob(['show', `${sha}^:${path}`]), path, key)
  const newId = await uploadImage(gitBlob(['show', `${sha}:${path}`]), path, key)
  if (!oldId && !newId) return lines.join('\n')
  const binIdx = lines.findIndex(
    l => /^Binary files .* differ$/.test(l) || l.startsWith('GIT binary patch')
  )
  const head = binIdx >= 0 ? lines.slice(0, binIdx) : lines
  return [...head, imageSentinel(oldId, newId)].join('\n')
}

// Split the unified patch per file and apply the safeguards.
async function pruneDiff(patch, key, sha) {
  if (!patch.trim()) return ''
  const sections = []
  let current = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current)
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) sections.push(current)

  return (await Promise.all(sections
    .map(async (lines) => {
      const path = sectionPath(lines)
      const isBinary = lines.some(
        l => /^Binary files .* differ$/.test(l) || l.startsWith('GIT binary patch')
      )
      if (isBinary) {
        if (!isIgnored(path) && imageMime(path)) {
          return captureImageSection(lines, path, key, sha)
        }
        return lines.join('\n')
      }
      if (isIgnored(path)) {
        return `${lines[0]}\n# diff omitted (lockfile/generated)`
      }
      if (lines.length > MAX_LINES_PER_FILE) {
        const omitted = lines.length - MAX_LINES_PER_FILE
        return (
          lines.slice(0, MAX_LINES_PER_FILE).join('\n')
          + `\n# ... (truncated: ${omitted} lines omitted)`
        )
      }
      return lines.join('\n')
    }))).join('\n')
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function main() {
  const [shaArg, keyArg] = process.argv.slice(2)
  if (!shaArg) {
    fail('usage: attach-commit <sha> [AB-N]')
  }

  // Validate the sha and normalise it to the full hash.
  const sha = git(['rev-parse', '--verify', `${shaArg}^{commit}`]).trim()

  const message = git(['show', '-s', '--format=%B', sha]).replace(/\n+$/, '')
  const committedAt = git(['show', '-s', '--format=%cI', sha]).trim()
  const authorName = git(['show', '-s', '--format=%an', sha]).trim()

  const key = keyArg || parseKey(message)
  if (!key) {
    fail(
      `no card key found in the message of ${sha.slice(0, 8)}; pass one explicitly: attach-commit ${shaArg} AB-N`
    )
  }

  const stat = git(['show', sha, '--stat', '--format=']).replace(/^\n+/, '').replace(/\n+$/, '')
  const rawDiff = git(['show', sha, '--format=', '--patch'])
  const diff = await pruneDiff(rawDiff, key, sha)

  const fileCount = (rawDiff.match(/^diff --git /gm) || []).length

  const res = await fetch(`${API_URL}/cards/${encodeURIComponent(key)}/commits`, {
    method: 'POST',
    headers: withToken({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sha, message, stat, diff, committedAt, authorName })
  }).catch((err) => {
    fail(`could not reach the API at ${API_URL} (${err.message}). Is it running?`)
  })

  if (!res.ok) {
    const body = await res.text()
    fail(`API responded ${res.status}: ${body}`)
  }

  console.log(
    `✓ ${key} ${sha.slice(0, 8)} — ${fileCount} file(s), ${humanBytes(Buffer.byteLength(diff, 'utf8'))} diff → attached`
  )
}

main()
