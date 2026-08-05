import { type MaybeRefOrGetter, toValue, watch, type WatchSource } from 'vue'

import type { AbSocketMessage } from '@agents-board/shared'

interface UseProjectDataOptions {
  /**
   * Reactive source(s) whose change re-runs `load` (and which run it once on
   * mount). Defaults to `projectId` — pass a route param (e.g. a card key) for
   * detail screens whose load is keyed by the route, not the project.
   */
  watch?: WatchSource | WatchSource[]
  /** React to the project's realtime events (reload, refresh the selection, …). */
  onEvent?: (event: AbSocketMessage) => void
}

/**
 * The "load + react to project + live updates" wiring every list/detail screen
 * repeats: (re)load when a key changes (immediately on mount) and subscribe to
 * the project's realtime events. The page says WHAT to load (`load`) and which
 * events matter (`onEvent`); this owns the watch, the subscription and its
 * cleanup. See module "Real-time: pg_notify → WebSocket".
 */
export function useProjectData(
  projectId: MaybeRefOrGetter<string | null | undefined>,
  load: () => void | Promise<void>,
  options: UseProjectDataOptions = {}
) {
  const sources: WatchSource[] = options.watch
    ? (Array.isArray(options.watch) ? options.watch : [options.watch])
    : [() => toValue(projectId)]

  watch(
    sources,
    () => {
      void load()
    },
    { immediate: true }
  )

  if (options.onEvent) useProjectEvents(projectId, options.onEvent)
}
