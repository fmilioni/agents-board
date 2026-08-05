import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { sql } from 'drizzle-orm'

import { createDb, runMigrations } from '@agents-board/db'

let container: StartedPostgreSqlContainer

const TEMPLATE_DB = 'ab_test_template'

// Spins one ephemeral Postgres for the whole suite and migrates a single
// template database on it. Each test file then clones that template into a
// database of its own (see `useTestDb`), so the migrations run once per suite
// instead of once per file. The container URL and the template name reach the
// tests via `provide`/`inject`.
export default async function setup({
  provide
}: {
  provide: (key: 'databaseUrl' | 'templateDb', value: string) => void
}) {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start()
  const url = container.getConnectionUri()

  const admin = createDb({ url, max: 1 })
  try {
    await admin.db.execute(sql.raw(`CREATE DATABASE ${TEMPLATE_DB}`))

    const templateUrl = new URL(url)
    templateUrl.pathname = `/${TEMPLATE_DB}`
    const template = createDb({ url: templateUrl.toString(), max: 1 })
    try {
      await runMigrations(template.db)
    } finally {
      await template.close()
    }

    // Postgres refuses to clone a database that has a connection open, and every
    // test file clones this one — a single stray connection would fail the whole
    // suite. Sealing it (as `template0` is sealed) makes the server reject the
    // connection instead of relying on nobody opening one.
    await admin.db.execute(
      sql.raw(
        `ALTER DATABASE ${TEMPLATE_DB} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`
      )
    )
  } finally {
    await admin.close()
  }

  provide('databaseUrl', url)
  provide('templateDb', TEMPLATE_DB)

  return async () => {
    await container.stop()
  }
}

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string
    templateDb: string
  }
}
