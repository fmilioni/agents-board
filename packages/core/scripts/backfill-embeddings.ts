import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

import { createDb } from '@agents-board/db'

import {
  backfillCardEmbeddings,
  backfillCommentEmbeddings,
  backfillDocEmbeddings,
  embed,
  resolveEffectiveEmbeddingConfig
} from '../src/index'

try {
  loadEnvFile(resolve(fileURLToPath(import.meta.url), '../../../../.env'))
} catch {
  // env file optional, falls back to process env
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required to backfill embeddings')
  process.exit(1)
}

const { db, close } = createDb({ url, max: 1 })

// A few attempts before declaring the service unreachable: `service_healthy`
// guarantees the model is loaded, so a null here is almost always a transient
// blip (load spike, brief timeout), not a real misconfig — don't abort a
// legitimate backfill over one flaky probe.
async function embeddingsReachable(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await embed('healthcheck', 'query')) return true
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return false
}

try {
  // Distinguish "embeddings off on purpose" from "supposed to work but the service
  // is unreachable" — otherwise both look like a silent "Backfilled 0" success and
  // a misconfig (e.g. missing EMBEDDING_SERVICE_URL) goes unnoticed.
  const cfg = await resolveEffectiveEmbeddingConfig(db)
  const deployDisabled = process.env.EMBEDDING_MODEL?.trim() === 'none'
  if (cfg.model === null || deployDisabled) {
    console.log('Embeddings are disabled (model "none") — nothing to backfill.')
  } else if (!(await embeddingsReachable())) {
    console.error(
      `Embeddings are configured (model "${cfg.model}") but the embedding service did not respond. `
      + 'Is EMBEDDING_SERVICE_URL set and the embedding service running? Aborting without changes.'
    )
    process.exitCode = 1
  } else {
    const docs = await backfillDocEmbeddings(db)
    const cards = await backfillCardEmbeddings(db)
    const comments = await backfillCommentEmbeddings(db)
    console.log(`Backfilled embeddings — docs: ${docs}, cards: ${cards}, comments: ${comments}`)
  }
} catch (err) {
  console.error('Backfill failed:', err)
  process.exitCode = 1
} finally {
  await close()
}
