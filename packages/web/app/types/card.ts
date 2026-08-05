import type { Card, CardStatus } from '@agents-board/shared'

export type {
  Card,
  CardClaim,
  CardParent,
  CardStatus,
  CardSubtask
} from '@agents-board/shared'

/** A card from `/cards?q=`, plus the matched comment snippet when the hit came from a comment. */
export interface CardSearchResult extends Card {
  matchedComment: { commentId: string, snippet: string } | null
}

// Board columns, in order. `backlog` is intentionally absent: backlog cards
// live on the Tasks page, not in a board column.
export const cardStatusOrder: CardStatus[] = [
  'todo',
  'in_progress',
  'review',
  'done',
  'blocked'
]

// All statuses for status selectors (card detail, etc.), including `backlog`.
export const cardStatusSelectOrder: CardStatus[] = ['backlog', ...cardStatusOrder]

export const cardStatusMeta: Record<
  CardStatus,
  { label: string, color: 'neutral' | 'info' | 'warning' | 'success' | 'error' }
> = {
  backlog: { label: 'Backlog', color: 'neutral' },
  todo: { label: 'To do', color: 'neutral' },
  in_progress: { label: 'In progress', color: 'info' },
  review: { label: 'Review', color: 'warning' },
  done: { label: 'Done', color: 'success' },
  blocked: { label: 'Blocked', color: 'error' }
}
