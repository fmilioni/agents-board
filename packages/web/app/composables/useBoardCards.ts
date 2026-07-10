import type { MaybeRefOrGetter } from 'vue'
import { toValue } from 'vue'

import type { Card } from '~/types/card'
import type { Sprint } from '~/types/sprint'

/**
 * The board-scoped card set the Board and the Home both read: the cards of every
 * active sprint (a project may have several — CO-399) plus every sprint-less card
 * (any status, `backlog` included). `cards` is the concat the columns/lists
 * derive from; `sprintCards`/`looseCards` stay exposed for callers that need a
 * subset (Home derives sprint stats from one and the backlog list from the
 * other). The two are disjoint — sprint cards carry an active sprintId, loose
 * cards have none — so the concat never double-counts.
 */
export function useBoardCards(
  projectId: MaybeRefOrGetter<string | null | undefined>,
  activeSprints: MaybeRefOrGetter<Sprint[] | null | undefined>
) {
  const api = useApi()
  const sprintCards = ref<Card[]>([])
  const looseCards = ref<Card[]>([])

  async function load() {
    const pid = toValue(projectId)
    if (!pid) {
      sprintCards.value = []
      looseCards.value = []
      return
    }
    const sprintIds = (toValue(activeSprints) ?? []).map(s => s.id)
    const [sprintList, looseList] = await Promise.all([
      sprintIds.length
        ? api<Card[]>('/cards', {
            query: { projectId: pid, sprintIds: sprintIds.join(',') }
          })
        : Promise.resolve<Card[]>([]),
      api<Card[]>('/cards', { query: { projectId: pid, backlogOnly: 'true' } })
    ])
    sprintCards.value = sprintList
    looseCards.value = looseList
  }

  const cards = computed(() => [...sprintCards.value, ...looseCards.value])

  return { sprintCards, looseCards, cards, load }
}
