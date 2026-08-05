import { sql } from 'drizzle-orm'

import type { Database } from '@agents-board/db'
import type { AbEvent } from '@agents-board/shared'

export type { AbEvent } from '@agents-board/shared'

export const EVENT_CHANNEL = 'ab_events'

export async function notify(db: Database, event: AbEvent): Promise<void> {
  const payload = JSON.stringify(event)
  await db.execute(
    sql`SELECT pg_notify(${EVENT_CHANNEL}, ${payload})`
  )
}
