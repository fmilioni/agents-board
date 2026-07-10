import type { InjectionKey } from 'vue'

/**
 * Board-only story-collapse controller, provided by the board page so a
 * `CardDraggableList` deep in the column tree can offer a collapse toggle on
 * story envelopes without threading a prop through every layer. Unset elsewhere
 * (Tasks backlog, sprint detail) → no toggle, lists behave as before.
 */
export interface BoardCollapseController {
  isCollapsed: (parentKey: string) => boolean
  toggle: (parentKey: string) => void
}

export const boardCollapseKey: InjectionKey<BoardCollapseController>
  = Symbol('boardCollapse')
