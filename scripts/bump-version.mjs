#!/usr/bin/env node
// Single command to set the SAME version everywhere it lives in the monorepo,
// so nothing drifts. Usage: pnpm bump <version>   (e.g. pnpm bump 0.3.0)
//
// Touches only JSON: every workspace package.json (root + packages/*) and the
// plugin manifests (Claude + Codex plugin.json, plus the Claude marketplace).
// The Codex marketplace points at the plugin manifest and carries no version.
// The MCP server version is
// NOT duplicated here — it derives from its own package.json at build time
// (see packages/mcp/src/create-server.ts), so bumping the JSON covers it too.
//
// Idempotent: only rewrites a file when its version actually changes.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const version = process.argv[2]
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/
if (!version || !SEMVER.test(version)) {
  console.error('Usage: pnpm bump <version>   (e.g. pnpm bump 0.3.0)')
  process.exit(1)
}

let changed = 0

// Read a JSON file, let `mutate` patch it, and write back only if it changed
// (preserving 2-space indent + trailing newline for a clean diff). Missing
// files are skipped silently — not every checkout has every manifest.
function patchJson(relPath, mutate) {
  const file = join(root, relPath)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const data = JSON.parse(raw)
  mutate(data)
  const next = `${JSON.stringify(data, null, 2)}\n`
  if (next !== raw) {
    writeFileSync(file, next)
    console.log(`  updated ${relPath}`)
    changed++
  }
}

const setVersion = (data) => {
  data.version = version
}

console.log(`Setting version to ${version}…`)

// Workspace packages: root + packages/* (matches pnpm-workspace.yaml).
patchJson('package.json', setVersion)
for (const name of readdirSync(join(root, 'packages'))) {
  patchJson(join('packages', name, 'package.json'), setVersion)
}

// Plugin manifests.
patchJson('plugins/claude-code/agents-board/.claude-plugin/plugin.json', setVersion)
patchJson('plugins/codex/agents-board/.codex-plugin/plugin.json', setVersion)
patchJson('.claude-plugin/marketplace.json', (data) => {
  for (const plugin of data.plugins ?? []) plugin.version = version
})

console.log(
  changed
    ? `Done — ${changed} file(s) updated to ${version}.`
    : `Already at ${version} — nothing to change.`
)
