import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  archiveDoc,
  createDoc,
  destroyDoc,
  getDoc,
  listDocs,
  restoreDoc,
  searchDocs,
  updateDoc
} from '@agents-board/core'
import type { Database } from '@agents-board/db'

import { attachmentsForItem } from '../attachments'
import { asJson, pageEnvelope, pageInputs } from './index'

const docKind = z.enum(['module', 'adr', 'guide', 'note'])

type DocAckRow = {
  id: string
  title: string
  kind: string
  parentId: string | null
}
function docAck(
  doc: DocAckRow | null | undefined,
  ...extra: Array<'parentId'>
) {
  if (!doc) return null
  const ack: Record<string, unknown> = {
    id: doc.id,
    title: doc.title,
    kind: doc.kind
  }
  for (const f of extra) ack[f] = doc[f]
  return ack
}

export function registerDocTools(server: McpServer, db: Database) {
  server.registerTool(
    'list_docs',
    {
      description:
        'List project docs (modules, ADRs, guides, notes). Returns metadata (id/title/kind/parentId) WITHOUT bodyMd. Use read_doc for full content. Optionally filter by kind. Pages with limit/offset; response is { docs, hasMore, offset }. Archived docs (and their descendants) are hidden by default.',
      inputSchema: {
        projectId: z.string(),
        kind: docKind.optional(),
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived docs (and their subtree) alongside active ones.'),
        archivedOnly: z
          .boolean()
          .optional()
          .describe('Return ONLY archived docs.'),
        ...pageInputs
      }
    },
    async ({ projectId, kind, includeArchived, archivedOnly, limit, offset }) => {
      const rows = await listDocs(
        db,
        projectId,
        kind,
        { includeArchived, archivedOnly },
        limit + 1,
        offset
      )
      return asJson(pageEnvelope('docs', rows, limit, offset))
    }
  )

  server.registerTool(
    'read_doc',
    {
      description: 'Read a single doc by id, including full bodyMd (markdown).',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => {
      const doc = await getDoc(db, id)
      if (!doc) return asJson(doc)
      const attachments = await attachmentsForItem(db, 'doc', doc.id)
      return asJson({ ...doc, attachments })
    }
  )

  server.registerTool(
    'search_docs',
    {
      description:
        'Hybrid semantic search over a project\'s docs (title/summary/body): lexical full-text (Postgres tsvector) fused with embedding similarity by RRF, so it ranks by MEANING — a conceptual / natural-language query matches the right doc even when the wording differs, and synonyms/typos still hit (falls back to lexical-only when embeddings are unavailable). Web-style queries (quoted phrases, OR, -exclude) and substring/trigram matching still work. Archived docs (and their subtree) are excluded by default — set includeArchived to search them too. Returns metadata WITHOUT bodyMd; use read_doc for full content. Pages with limit/offset; response is { docs, hasMore, offset }.',
      inputSchema: {
        projectId: z.string(),
        query: z.string().min(1),
        includeArchived: z
          .boolean()
          .optional()
          .describe('Search archived docs (and their subtree) too; off by default.'),
        ...pageInputs
      }
    },
    async ({ projectId, query, includeArchived, limit, offset }) => {
      const rows = await searchDocs(db, projectId, query, {
        includeArchived,
        limit: limit + 1,
        offset
      })
      return asJson(pageEnvelope('docs', rows, limit, offset))
    }
  )

  server.registerTool(
    'write_doc',
    {
      description:
        'Create a new doc, or update an existing one if `id` is provided. Use `kind` to classify: module (a code domain/area), adr (architecture decision record), guide (how-to), note (anything else). `parentId` nests the doc under another. `summary` (one-line description shown in lists/search) and `bodyMd` (the markdown content) are REQUIRED when creating (no `id`), optional on update.',
      inputSchema: {
        id: z.string().optional(),
        projectId: z.string().optional(),
        parentId: z.string().nullable().optional(),
        title: z.string().min(1).max(200).optional(),
        summary: z
          .string()
          .max(200)
          .optional()
          .describe(
            'One-line summary shown in doc lists/search. REQUIRED on creation (no `id`) — blank/whitespace is rejected; optional on update (omit to leave it untouched).'
          ),
        bodyMd: z.string().optional(),
        kind: docKind.optional()
      }
    },
    async (input) => {
      if (input.id) {
        return asJson(
          docAck(
            await updateDoc(db, {
              id: input.id,
              title: input.title,
              summary: input.summary,
              bodyMd: input.bodyMd,
              kind: input.kind,
              parentId: input.parentId
            }),
            'parentId'
          )
        )
      }
      if (!input.projectId || !input.title) {
        throw new Error('projectId and title are required to create a doc')
      }
      const summary = input.summary?.trim()
      if (!summary) {
        throw new Error(
          'summary is required when creating a doc (no `id`): a one-line description shown in doc lists/search. It stays optional on update.'
        )
      }
      const bodyMd = input.bodyMd?.trim()
      if (!bodyMd) {
        throw new Error(
          'bodyMd is required when creating a doc (no `id`): the markdown content of the doc. It stays optional on update.'
        )
      }
      return asJson(
        docAck(
          await createDoc(db, {
            projectId: input.projectId,
            parentId: input.parentId,
            title: input.title,
            summary,
            bodyMd,
            kind: input.kind
          }),
          'parentId'
        )
      )
    }
  )

  server.registerTool(
    'archive_doc',
    {
      description:
        'Archive a doc (soft-delete): it (and its subtree) disappears from list_docs but is kept and can be restored. Shows up with archivedOnly=true.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(docAck(await archiveDoc(db, id)))
  )

  server.registerTool(
    'restore_doc',
    {
      description: 'Restore (unarchive) a previously archived doc.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(docAck(await restoreDoc(db, id)))
  )

  server.registerTool(
    'destroy_doc',
    {
      description:
        'Permanently delete a doc and its children (hard-delete via cascade, IRREVERSIBLE). To merely hide a doc, use archive_doc instead.',
      inputSchema: { id: z.string() }
    },
    async ({ id }) => asJson(await destroyDoc(db, id))
  )
}
