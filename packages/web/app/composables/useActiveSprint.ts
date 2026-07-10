import type { MaybeRefOrGetter } from 'vue'

import type { Sprint } from '~/types/sprint'

/**
 * The active sprints of a project. A project may have several active at once
 * (CO-399), so this resolves to a list (empty when none / no project).
 */
export function useActiveSprint(projectId: MaybeRefOrGetter<string | null>) {
  const api = useApi()
  const id = computed(() => toValue(projectId))

  return useAsyncData<Sprint[]>(
    () => `active-sprints:${id.value ?? 'none'}`,
    () => {
      if (!id.value) return Promise.resolve([])
      return api<Sprint[]>('/sprints/active', {
        query: { projectId: id.value }
      })
    },
    { watch: [id], default: () => [] }
  )
}
