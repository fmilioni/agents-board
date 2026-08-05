import { type MaybeRefOrGetter, toValue } from 'vue'

import type { AbSocketMessage } from '@agents-board/shared'

export type { AbEvent, AbSocketMessage } from '@agents-board/shared'

export function useProjectEvents(
  projectId: MaybeRefOrGetter<string | null | undefined>,
  handler: (event: AbSocketMessage) => void
) {
  if (import.meta.server) return

  const config = useRuntimeConfig()
  const apiUrl = config.public.apiUrl as string

  const url = () => {
    const id = toValue(projectId)
    if (!id) return undefined
    return apiUrl.replace(/^http/, 'ws') + `/ws/projects/${id}`
  }

  useWebSocket(url, {
    autoReconnect: { delay: 2000 },
    onMessage: (_ws, e) => {
      let message: AbSocketMessage | undefined
      try {
        message = JSON.parse(e.data) as AbSocketMessage
      } catch {
        return
      }
      handler(message)
    }
  })
}
