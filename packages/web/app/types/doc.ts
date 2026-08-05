import type { DocKind, DocSummary } from '@agents-board/shared'

export type { Doc, DocKind, DocSummary } from '@agents-board/shared'

/** Front-only tree node built from a flat list of docs. */
export interface DocNode extends DocSummary {
  children: DocNode[]
}

export const docKindMeta: Record<
  DocKind,
  { label: string, icon: string, color: 'primary' | 'info' | 'warning' | 'neutral' }
> = {
  module: { label: 'Module', icon: 'i-lucide-box', color: 'primary' },
  adr: { label: 'ADR', icon: 'i-lucide-gavel', color: 'warning' },
  guide: { label: 'Guide', icon: 'i-lucide-compass', color: 'info' },
  note: { label: 'Note', icon: 'i-lucide-sticky-note', color: 'neutral' }
}

export function buildDocTree(docs: DocSummary[]): DocNode[] {
  const byId = new Map<string, DocNode>()
  for (const d of docs) byId.set(d.id, { ...d, children: [] })
  const roots: DocNode[] = []
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortNodes = (nodes: DocNode[]) => {
    nodes.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
    for (const n of nodes) sortNodes(n.children)
  }
  sortNodes(roots)
  return roots
}
