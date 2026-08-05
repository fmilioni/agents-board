#!/usr/bin/env node
// Capture the working-tree (uncommitted) diff and attach it to a card via the
// REST API, so a card in review can show what will land before the commit
// exists.
//
//   node scripts/attach-worktree-diff.mjs <AB-N>
//   pnpm attach-worktree-diff <AB-N>
//
// The card key is required (there is no commit message to parse it from). The
// diff is `git diff HEAD` plus untracked files, posted under a sentinel sha so
// the backend treats it as a pending diff; the real commit (or a clean tree)
// later replaces/clears it. The diff never passes through an AI context.
//
// Zero dependencies: standalone Node 18+ (global fetch). A Python twin lives at
// scripts/attach-worktree-diff.py — keep the two in sync. The diff helpers are
// duplicated from attach-commit.mjs on purpose: each script is standalone and
// directly runnable (the .mjs/.py twins already mirror each other).
//
// Config: AB_API_URL (default http://127.0.0.1:4400).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

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

// Must match WORKING_TREE_SHA in @agents-board/shared.
const WORKING_TREE_SHA = '__working__'

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
// (e.g. an untracked file isn't in HEAD). stderr is ignored — a missing blob is
// an expected miss, not an error to print.
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

// Working-tree file bytes; null when the file is gone (a deleted image).
function readWorktree(path) {
  try {
    return readFileSync(path)
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

// `git diff --no-index` exits 1 when the inputs differ — that's the patch we
// want, on stdout, not a failure.
function gitDiffNoIndex(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })
  } catch (err) {
    if (err.status === 1 && typeof err.stdout === 'string') return err.stdout
    fail(`git ${args.join(' ')} failed: ${(err.message || '').split('\n')[0]}`)
  }
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

// Capture an image binary section: old blob from HEAD, new from the working tree;
// replace the binary marker with the image sentinel. Falls back to the original
// lines (plain note) when neither side could be uploaded.
async function captureImageSection(lines, path, key) {
  const oldId = await uploadImage(gitBlob(['show', `HEAD:${path}`]), path, key)
  const newId = await uploadImage(readWorktree(path), path, key)
  if (!oldId && !newId) return lines.join('\n')
  const binIdx = lines.findIndex(
    l => /^Binary files .* differ$/.test(l) || l.startsWith('GIT binary patch')
  )
  const head = binIdx >= 0 ? lines.slice(0, binIdx) : lines
  return [...head, imageSentinel(oldId, newId)].join('\n')
}

// Split the unified patch per file and apply the safeguards.
async function pruneDiff(patch, key) {
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
          return captureImageSection(lines, path, key)
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

// Summary line counted from the full pre-prune `raw` (tracked + untracked) —
// NOT the displayed (pruned) `diff` — so the badge equals the real commit's
// `git show --stat` once it lands (pruned lockfiles/binaries stay counted), and
// covers untracked files that `git diff HEAD --stat` (tracked only) would miss.
// The web parses only this last line for its file/insertion/deletion badges.
function statSummary(raw) {
  const files = (raw.match(/^diff --git /gm) || []).length
  let add = 0
  let del = 0
  for (const line of raw.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++
    else if (line.startsWith('-') && !line.startsWith('---')) del++
  }
  return `${files} file${files === 1 ? '' : 's'} changed, ${add} insertion${add === 1 ? '' : 's'}(+), ${del} deletion${del === 1 ? '' : 's'}(-)`
}

async function clearPending(key) {
  const res = await fetch(
    `${API_URL}/cards/${encodeURIComponent(key)}/commits/working`,
    { method: 'DELETE', headers: withToken() }
  ).catch((err) => {
    fail(`could not reach the API at ${API_URL} (${err.message}). Is it running?`)
  })
  if (!res.ok) {
    const body = await res.text()
    fail(`API responded ${res.status}: ${body}`)
  }
}

async function main() {
  const key = process.argv[2]
  if (!key) {
    fail('usage: attach-worktree-diff <AB-N>')
  }

  const tracked = git(['diff', 'HEAD'])
  // `core.quotePath=false` keeps non-ASCII / spaced paths raw so they survive
  // as literal argv to `git diff --no-index` below.
  const untracked = git([
    '-c',
    'core.quotePath=false',
    'ls-files',
    '--others',
    '--exclude-standard'
  ])
    .split('\n')
    .filter(Boolean)

  let raw = tracked
  for (const file of untracked) {
    raw += gitDiffNoIndex(['diff', '--no-index', '--', '/dev/null', file])
  }
  const diff = await pruneDiff(raw, key)

  if (!diff.trim()) {
    await clearPending(key)
    console.log(`✓ ${key} — working tree clean, pending diff cleared`)
    return
  }

  const fileCount = (raw.match(/^diff --git /gm) || []).length
  const stat = statSummary(raw)

  const res = await fetch(
    `${API_URL}/cards/${encodeURIComponent(key)}/commits`,
    {
      method: 'POST',
      headers: withToken({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        sha: WORKING_TREE_SHA,
        message: '(uncommitted working tree)',
        stat,
        diff,
        committedAt: null,
        authorName: null
      })
    }
  ).catch((err) => {
    fail(`could not reach the API at ${API_URL} (${err.message}). Is it running?`)
  })

  if (!res.ok) {
    const body = await res.text()
    fail(`API responded ${res.status}: ${body}`)
  }

  console.log(
    `✓ ${key} working tree — ${fileCount} file(s), ${humanBytes(Buffer.byteLength(diff, 'utf8'))} diff → attached (uncommitted)`
  )
}

main()
