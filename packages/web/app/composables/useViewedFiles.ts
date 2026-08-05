import type { DiffFileSignature } from '~/utils/diffFiles'

// Per-browser "viewed" state for diff files (no backend; works auth on or off).
// Bounded on two axes so localStorage can't grow without limit: at most
// MAX_CARDS cards are kept (LRU by last touch), and a file entry only counts as
// viewed while its stored hash matches the current diff (a changed file drops to
// unviewed and reconcile() prunes the dead entry).
const STORAGE_KEY = 'agents-board:diff-viewed'
const MAX_CARDS = 40

interface CardEntry {
  t: number
  files: Record<string, string>
}
interface Store {
  cards: Record<string, CardEntry>
}

const fileKey = (sha: string, path: string) => `${sha}\n${path}`

// Rebuild a record dropping keys matching `drop` — Object spread avoids the
// dynamic `delete` the linter forbids and keeps the reactive ref clean.
function without(
  rec: Record<string, string>,
  drop: (key: string) => boolean
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const k of Object.keys(rec)) if (!drop(k)) next[k] = rec[k]!
  return next
}

let store: ReturnType<typeof useLocalStorage<Store>> | undefined

function useStore() {
  store ??= useLocalStorage<Store>(STORAGE_KEY, { cards: {} })
  return store
}

function prune(state: Store) {
  const ids = Object.keys(state.cards)
  if (ids.length <= MAX_CARDS) return
  const keep = ids
    .sort((a, b) => (state.cards[a]!.t) - (state.cards[b]!.t))
    .slice(ids.length - MAX_CARDS)
  const next: Record<string, CardEntry> = {}
  for (const id of keep) next[id] = state.cards[id]!
  state.cards = next
}

function touch(state: Store, cardId: string): CardEntry {
  const entry = state.cards[cardId] ?? { t: 0, files: {} }
  entry.t = import.meta.client ? Date.now() : 0
  state.cards[cardId] = entry
  return entry
}

export function useViewedFiles() {
  const state = useStore()

  function isViewed(cardId: string, sha: string, path: string, hash: string) {
    return state.value.cards[cardId]?.files[fileKey(sha, path)] === hash
  }

  function setViewed(
    cardId: string,
    sha: string,
    path: string,
    hash: string,
    viewed: boolean
  ) {
    const entry = touch(state.value, cardId)
    const key = fileKey(sha, path)
    if (viewed) entry.files[key] = hash
    else entry.files = without(entry.files, k => k === key)
    prune(state.value)
  }

  function countViewed(cardId: string, sha: string, sigs: DiffFileSignature[]) {
    return sigs.reduce(
      (n, s) => n + (isViewed(cardId, sha, s.path, s.hash) ? 1 : 0),
      0
    )
  }

  // Drop entries for this commit whose file no longer exists in the diff or whose
  // content changed — keeps a card's stored set from accumulating dead files.
  function reconcile(cardId: string, sha: string, sigs: DiffFileSignature[]) {
    const entry = state.value.cards[cardId]
    if (!entry) return
    const live = new Map(sigs.map(s => [s.path, s.hash]))
    const stale = (key: string) =>
      key.startsWith(`${sha}\n`)
      && live.get(key.slice(sha.length + 1)) !== entry.files[key]
    if (Object.keys(entry.files).some(stale)) {
      entry.files = without(entry.files, stale)
    }
  }

  return { isViewed, setViewed, countViewed, reconcile }
}
