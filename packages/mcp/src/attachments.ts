import { type AttachmentItemType, listAttachmentsByItems } from '@agents-board/core'
import type { Database } from '@agents-board/db'

type AttachmentLinkRow = Awaited<ReturnType<typeof listAttachmentsByItems>>[number]

// Stable resource URI the agent reads via ReadMcpResource; shares the `<id>` with
// the HTTP serve path (CO-258), so the same image has one identity across both.
export function attachmentUri(id: string): string {
  return `attachment://${id}`
}

function toRef(a: AttachmentLinkRow) {
  return {
    id: a.id,
    uri: attachmentUri(a.id),
    mime: a.mime,
    width: a.width,
    height: a.height,
    description: a.description
  }
}

// The `attachments` array for a single item (a card, a doc) — the images its body
// references, via the link index.
export async function attachmentsForItem(
  db: Database,
  itemType: AttachmentItemType,
  itemId: string
) {
  const rows = await listAttachmentsByItems(db, itemType, [itemId])
  return rows.map(toRef)
}

// One query for a whole list of same-type items (comments, inbox items), grouped
// back by itemId — avoids an N+1 over the list.
export async function attachmentsByItem(
  db: Database,
  itemType: AttachmentItemType,
  itemIds: string[]
): Promise<Map<string, ReturnType<typeof toRef>[]>> {
  const rows = await listAttachmentsByItems(db, itemType, itemIds)
  const byItem = new Map<string, ReturnType<typeof toRef>[]>()
  for (const a of rows) {
    const list = byItem.get(a.itemId) ?? []
    list.push(toRef(a))
    byItem.set(a.itemId, list)
  }
  return byItem
}
