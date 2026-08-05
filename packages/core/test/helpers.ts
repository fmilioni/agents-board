import { randomUUID } from 'node:crypto'

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, inject } from 'vitest'

import { createDb, type Database } from '@agents-board/db'

import { createProject } from '../src/index'

export interface TestDb {
  db: Database
}

/**
 * Provisions a database of its own for the current test file — cloned from the
 * suite's already-migrated template — and closes the connection afterwards.
 * Call at the top level of a test file.
 *
 * A database per file (never a shared one) is what keeps db-wide state safe:
 * the by-project isolation the tests rely on doesn't cover a global singleton
 * (`system_settings`) or a global sweep (the embedding backfill), so files
 * touching those would race across Vitest's parallel workers.
 */
export function useTestDb(): TestDb {
  const ctx: TestDb = {} as TestDb
  let close: (() => Promise<void>) | undefined

  beforeAll(async () => {
    const baseUrl = inject('databaseUrl')
    const name = `test_${randomUUID().replace(/-/g, '').slice(0, 20)}`

    const admin = createDb({ url: baseUrl, max: 1 })
    try {
      await admin.db.execute(
        sql.raw(`CREATE DATABASE ${name} TEMPLATE ${inject('templateDb')}`)
      )
    } finally {
      await admin.close()
    }

    const url = new URL(baseUrl)
    url.pathname = `/${name}`
    const conn = createDb({ url: url.toString() })
    ctx.db = conn.db
    close = conn.close
  })

  afterAll(async () => {
    // A failed CREATE DATABASE leaves nothing to close — and swallowing it here
    // as `close is not a function` would bury the real Postgres error.
    await close?.()
  })

  return ctx
}

/**
 * Create an isolated project so each test operates in its own namespace.
 * The slug uses a random UUID so the projects a file creates never collide.
 */
export function freshProject(db: Database, keyPrefix = 'AB') {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  return createProject(db, {
    name: `Test Project ${suffix}`,
    slug: `test-${suffix}`,
    keyPrefix
  })
}

/**
 * A unique key prefix. Card keys are unique only per project
 * (`cards_project_key_uk`), but `getCardByKey` / `attachCardCommit` resolve a
 * card BY KEY alone — so `AB-1` is ambiguous across the several default-prefix
 * projects a single file creates. Tests that go through those paths must use
 * this, or the lookup may hit another test's same-key card.
 */
export function uniqueKeyPrefix() {
  return `T${randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()}`
}
