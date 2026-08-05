import type { AbSocketMessage } from '@agents-board/shared'

import { useProjectStore } from '~/stores/project'

export function useProjectIdentityEvents() {
  if (import.meta.server) return

  const store = useProjectStore()
  const config = useRuntimeConfig()
  const apiUrl = config.public.apiUrl as string
  const url = () =>
    store.loaded
      ? apiUrl.replace(/^http/, 'ws') + '/ws/projects'
      : undefined
  let reconciliation: Promise<void> | null = null
  let trailing = false

  function reconcile() {
    if (reconciliation) {
      trailing = true
      return reconciliation
    }
    reconciliation = (async () => {
      do {
        trailing = false
        await store.loadAndRepoint()
      } while (trailing)
    })().finally(() => {
      reconciliation = null
    })
    return reconciliation
  }

  useWebSocket(url, {
    autoReconnect: { delay: 2000 },
    onMessage: async (_ws, message) => {
      let event: AbSocketMessage | undefined
      try {
        event = JSON.parse(message.data) as AbSocketMessage
      } catch {
        return
      }
      if (
        event.type === 'project.changed'
        || event.type === 'project.deleted'
        || event.type === 'projects.ready'
      ) {
        await reconcile()
      }
    }
  })
}
