import type { MaybeRefOrGetter } from 'vue'

// Per-browser "collapsed story" state for the board, keyed by project (no
// backend — a pure view preference, works auth on or off). Mirrors
// useViewedFiles: a module singleton over localStorage, bounded by pruning a
// project's entry once nothing is collapsed so the map can't grow forever.
const STORAGE_KEY = 'co:board-collapsed-stories'

interface Store {
  // projectId → collapsed story parentKeys (e.g. "CO-42")
  projects: Record<string, string[]>
}

let store: ReturnType<typeof useLocalStorage<Store>> | undefined

function useStore() {
  store ??= useLocalStorage<Store>(STORAGE_KEY, { projects: {} })
  return store
}

export function useCollapsedStories(
  projectId: MaybeRefOrGetter<string | null | undefined>
) {
  const state = useStore()
  const pid = computed(() => toValue(projectId) ?? null)

  const collapsed = computed(
    () => new Set(pid.value ? (state.value.projects[pid.value] ?? []) : [])
  )

  function isCollapsed(parentKey: string) {
    return collapsed.value.has(parentKey)
  }

  function toggle(parentKey: string) {
    const id = pid.value
    if (!id) return
    const next = new Set(state.value.projects[id] ?? [])
    if (next.has(parentKey)) next.delete(parentKey)
    else next.add(parentKey)
    // Rebuild the map; drop this project's entry when nothing is collapsed so it
    // can't grow forever (Object spread avoids the linter's dynamic `delete`).
    const projects: Record<string, string[]> = {}
    for (const key of Object.keys(state.value.projects)) {
      if (key !== id) projects[key] = state.value.projects[key]!
    }
    if (next.size) projects[id] = [...next]
    state.value.projects = projects
  }

  return { isCollapsed, toggle }
}
