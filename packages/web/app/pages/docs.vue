<script setup lang="ts">
import { useProjectStore } from '~/stores/project'
import type { Doc, DocKind, DocSummary } from '~/types/doc'
import { buildDocTree, docKindMeta } from '~/types/doc'

const store = useProjectStore()
const { currentProject, currentProjectId } = storeToRefs(store)
const api = useApi()
const toast = useToast()
const route = useRoute()
const router = useRouter()

useHead({ title: 'Docs' })

const docs = ref<DocSummary[]>([])
const archivedDocs = ref<DocSummary[]>([])
const search = ref('')
const selectedId = ref<string | null>(null)
const current = ref<Doc | null>(null)

// Resizable tree column
const treeWidth = useCookie<number>('agents-board.docsTreeWidth', {
  default: () => 288,
  sameSite: 'lax',
  maxAge: 60 * 60 * 24 * 365
})
let resizing = false
let startX = 0
let startWidth = 0
let stopMove: (() => void) | undefined
let stopUp: (() => void) | undefined

function onResizeMove(e: MouseEvent) {
  if (!resizing) return
  const next = startWidth + (e.clientX - startX)
  treeWidth.value = Math.min(Math.max(next, 200), 600)
}
function stopResize() {
  resizing = false
  stopMove?.()
  stopUp?.()
  document.body.style.userSelect = ''
}
function startResize(e: MouseEvent) {
  resizing = true
  startX = e.clientX
  startWidth = treeWidth.value
  document.body.style.userSelect = 'none'
  stopMove = useEventListener(window, 'mousemove', onResizeMove)
  stopUp = useEventListener(window, 'mouseup', stopResize)
  e.preventDefault()
}
onScopeDispose(stopResize)

const tree = computed(() => buildDocTree(docs.value))

const term = computed(() => search.value.trim())

const filteredTree = computed(() => (term.value ? null : tree.value))

const searchResults = ref<DocSummary[]>([])
const searching = ref(false)
const searched = ref(false)

// A monotonic ticket discards out-of-order responses (same guard as search.vue).
let ticket = 0
let selectTicket = 0

async function runDocSearch(value: string, projectId: string) {
  // A debounced call can't be cancelled, so drop it if the term moved on before
  // it fired.
  if (value !== term.value) return
  const mine = ++ticket
  searching.value = true
  try {
    const data = await api<DocSummary[]>('/docs', {
      query: { projectId, q: value }
    })
    if (mine !== ticket) return
    searchResults.value = data
    searched.value = true
  } catch {
    if (mine === ticket) {
      searchResults.value = []
      searched.value = true
    }
  } finally {
    if (mine === ticket) searching.value = false
  }
}

const debouncedDocSearch = useDebounceFn(
  (value: string, projectId: string) => void runDocSearch(value, projectId),
  250
)

watch(term, (value) => {
  const projectId = currentProjectId.value
  if (!value || !projectId) {
    ticket++
    searchResults.value = []
    searching.value = false
    searched.value = false
    return
  }
  searching.value = true
  void debouncedDocSearch(value, projectId)
})

// Switching project must not leave another project's results — or a doc id from
// the old project hanging in the URL — on screen.
watch(currentProjectId, () => {
  search.value = ''
  clearSelection()
})

async function loadDocs() {
  if (!currentProjectId.value) {
    docs.value = []
    archivedDocs.value = []
    return
  }
  [docs.value, archivedDocs.value] = await Promise.all([
    api<DocSummary[]>('/docs', {
      query: { projectId: currentProjectId.value }
    }),
    api<DocSummary[]>('/docs', {
      query: { projectId: currentProjectId.value, archivedOnly: 'true' }
    })
  ])
}

async function restoreDoc(id: string) {
  await api(`/docs/${id}/restore`, { method: 'POST' })
  await loadDocs()
}

const preview = ref<{ title: string, body: string | null } | null>(null)

async function previewDoc(d: DocSummary) {
  try {
    const full = await api<Doc>(`/docs/${d.id}`)
    preview.value = { title: full.title, body: full.bodyMd }
  } catch (e) {
    toast.add({
      title: 'Failed to open the note',
      description: resolveError(e),
      color: 'error'
    })
  }
}

function clearSelection() {
  selectedId.value = null
  current.value = null
  if (route.query.doc) router.replace({ query: {} })
}

async function selectDoc(id: string) {
  const mine = ++selectTicket
  try {
    const doc = await api<Doc>(`/docs/${id}`)
    if (mine !== selectTicket) return
    selectedId.value = id
    current.value = doc
  } catch {
    // Missing/archived id: land on /docs with no selection rather than erroring.
    if (mine === selectTicket) clearSelection()
    return
  }
  if (route.query.doc !== id) router.replace({ query: { doc: id } })
}

// Deep-link: `/docs?doc=<id>` pre-selects the doc (on mount and on internal-href
// navigation). selectDoc re-syncs the query only when it differs, so no loop.
watch(
  () => route.query.doc,
  (value) => {
    const id = Array.isArray(value) ? value[0] : value
    if (id) {
      if (id !== selectedId.value) void selectDoc(id)
    } else if (selectedId.value) {
      selectedId.value = null
      current.value = null
    }
  },
  { immediate: true }
)

useProjectData(currentProjectId, loadDocs, {
  onEvent: (event) => {
    if (event.type === 'doc.changed') {
      loadDocs()
      if (event.docId === selectedId.value) {
        // refresh selected if it still exists
        api<Doc>(`/docs/${event.docId}`)
          .then((d) => {
            current.value = d
          })
          .catch(() => {
            clearSelection()
          })
      }
    } else if (event.type === 'doc.deleted') {
      loadDocs()
      if (event.docId === selectedId.value) {
        clearSelection()
      }
    }
  }
})

const { editing, saving, justSaved, save } = useAutoSave<
  Doc,
  'title' | 'summary' | 'bodyMd'
>(current, {
  resource: 'docs',
  fields: [
    { key: 'title', mode: 'required' },
    { key: 'summary', mode: 'nullable' },
    'bodyMd'
  ],
  onSaved: (updated) => {
    current.value = updated
    const listed = docs.value.find(d => d.id === updated.id)
    if (listed) {
      listed.title = updated.title
      listed.summary = updated.summary
      listed.kind = updated.kind
    }
  }
})

function setKind(kind: DocKind) {
  save({ kind })
}

const createOpen = ref(false)
const newDoc = reactive({
  title: '',
  kind: 'note' as DocKind,
  parentId: null as string | null
})
const kindOptions = (Object.keys(docKindMeta) as DocKind[]).map(k => ({
  label: docKindMeta[k].label,
  value: k
}))
const parentOptions = computed(() => [
  { label: '— none (top level) —', value: null as string | null },
  ...docs.value.map(d => ({ label: d.title, value: d.id as string | null }))
])

async function createDoc() {
  if (!currentProjectId.value || !newDoc.title.trim()) return
  const created = await api<Doc>('/docs', {
    method: 'POST',
    body: {
      projectId: currentProjectId.value,
      title: newDoc.title,
      kind: newDoc.kind,
      parentId: newDoc.parentId
    }
  })
  newDoc.title = ''
  newDoc.kind = 'note'
  newDoc.parentId = null
  createOpen.value = false
  await loadDocs()
  await selectDoc(created.id)
}

// Descendants hard-deleted along with the current doc (children cascade in DB).
const currentDescendantCount = computed(() => {
  if (!current.value) return 0
  const childrenOf = new Map<string | null, string[]>()
  for (const d of docs.value) {
    const arr = childrenOf.get(d.parentId) ?? []
    arr.push(d.id)
    childrenOf.set(d.parentId, arr)
  }
  let count = 0
  const stack = [...(childrenOf.get(current.value.id) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    count++
    const kids = childrenOf.get(id)
    if (kids) stack.push(...kids)
  }
  return count
})

async function onDocRemoved() {
  clearSelection()
  await loadDocs()
}
</script>

<template>
  <UDashboardPanel
    id="docs"
    :ui="{ body: 'flex flex-row flex-1 overflow-hidden gap-0 sm:gap-0 p-0 sm:p-0' }"
  >
    <template #header>
      <UDashboardNavbar title="Docs">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UIcon name="i-lucide-book" class="text-primary" />
        </template>
        <template #right>
          <span
            v-if="saving"
            class="text-xs text-muted flex items-center gap-1"
          >
            <UIcon name="i-lucide-loader-2" class="animate-spin" /> Saving…
          </span>
          <span
            v-else-if="justSaved"
            class="text-xs text-muted flex items-center gap-1"
          >
            <UIcon name="i-lucide-check" /> Saved
          </span>
          <UButton
            v-if="currentProject"
            icon="i-lucide-plus"
            color="primary"
            label="New doc"
            @click="() => { createOpen = true }"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="!currentProject" class="text-center text-muted py-12 w-full">
        Pick a project in the sidebar.
      </div>

      <template v-else>
        <!-- Tree sidebar -->
        <div
          class="shrink-0 border-e border-default flex flex-col overflow-hidden"
          :style="{ width: `${treeWidth}px` }"
        >
          <div class="p-2 border-b border-default">
            <UInput
              v-model="search"
              icon="i-lucide-search"
              placeholder="Search docs…"
              size="sm"
              class="w-full"
              :loading="searching"
            />
          </div>
          <div class="flex-1 overflow-y-auto p-2">
            <div v-if="!docs.length" class="text-sm text-muted/60 italic p-2">
              No docs yet.
            </div>
            <template v-else-if="filteredTree">
              <DocTreeNode
                v-for="node in filteredTree"
                :key="node.id"
                :node="node"
                :selected-id="selectedId"
                :depth="0"
                @select="selectDoc"
              />
            </template>
            <template v-else>
              <p
                v-if="searched && !searching && !searchResults.length"
                class="text-sm text-muted/60 italic p-2"
              >
                No docs match "{{ term }}".
              </p>
              <button
                v-for="d in searchResults"
                :key="d.id"
                type="button"
                class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-elevated/50"
                :class="selectedId === d.id ? 'bg-elevated font-medium' : ''"
                @click="selectDoc(d.id)"
              >
                <UIcon
                  :name="docKindMeta[d.kind].icon"
                  class="size-4 shrink-0"
                  :class="`text-${docKindMeta[d.kind].color}`"
                />
                <span class="truncate">{{ d.title }}</span>
              </button>
            </template>
          </div>

          <div
            v-if="archivedDocs.length"
            class="border-t border-default p-2 shrink-0"
          >
            <ArchivedDisclosure :count="archivedDocs.length">
              <div class="space-y-0.5">
                <div
                  v-for="d in archivedDocs"
                  :key="d.id"
                  class="flex items-center gap-2 px-2 py-1 rounded-md text-sm hover:bg-elevated/50"
                >
                  <button
                    type="button"
                    class="flex items-center gap-2 min-w-0 flex-1 cursor-pointer text-left"
                    @click="previewDoc(d)"
                  >
                    <UIcon
                      :name="docKindMeta[d.kind].icon"
                      class="size-4 shrink-0 text-muted"
                    />
                    <span class="truncate text-muted">{{ d.title }}</span>
                  </button>
                  <UButton
                    icon="i-lucide-archive-restore"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    aria-label="Restore"
                    @click="restoreDoc(d.id)"
                  />
                </div>
              </div>
            </ArchivedDisclosure>
          </div>
        </div>

        <!-- Resize handle -->
        <div
          class="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/40 active:bg-primary/60 transition-colors"
          @mousedown="startResize"
        />

        <!-- Editor -->
        <div class="flex-1 overflow-y-auto p-4 sm:p-6 min-w-0">
          <div
            v-if="!current"
            class="text-muted text-center py-12"
          >
            Select a doc on the left, or create a new one.
          </div>

          <div v-else class="max-w-5xl mx-auto space-y-4">
            <div class="flex items-center gap-2">
              <InlineEditable
                :key="current.id"
                v-model="editing.title"
                type="text"
                size="xl"
                class="flex-1"
                input-class="[&_input]:!text-xl [&_input]:!font-bold"
                preview-class="text-xl font-bold"
                placeholder="Untitled"
              />
              <ArchiveDestroyMenu
                kind="doc"
                :entity-id="current.id"
                :entity-label="current.title || 'this doc'"
                :cascade-count="currentDescendantCount"
                cascade-noun="child doc"
                cascade-noun-plural="child docs"
                @archived="onDocRemoved"
                @destroyed="onDocRemoved"
              />
            </div>

            <div class="flex items-center gap-1.5">
              <UButton
                v-for="opt in kindOptions"
                :key="opt.value"
                size="xs"
                :color="current.kind === opt.value ? docKindMeta[opt.value].color : 'neutral'"
                :variant="current.kind === opt.value ? 'subtle' : 'ghost'"
                :icon="docKindMeta[opt.value].icon"
                :label="opt.label"
                @click="setKind(opt.value)"
              />
            </div>

            <InlineEditable
              :key="current.id"
              v-model="editing.summary"
              type="multiline"
              :rows="2"
              bordered
              preview-class="text-sm text-muted"
              placeholder="One-line summary (shown in lists)"
              editor-placeholder="One-line summary (shown in lists)"
            />

            <InlineEditable
              :key="current.id"
              v-model="editing.bodyMd"
              type="markdown"
              bordered
              interactive
              min-height="400px"
              placeholder="Write documentation… (markdown supported)"
              editor-placeholder="Write documentation… (markdown supported)"
            />
          </div>
        </div>
      </template>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="createOpen" title="Create doc">
    <template #body>
      <div class="space-y-4">
        <UFormField label="Title" required>
          <UInput v-model="newDoc.title" placeholder="Architecture overview" />
        </UFormField>
        <UFormField label="Kind">
          <USelectMenu
            v-model="newDoc.kind"
            :items="kindOptions"
            value-key="value"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Parent" hint="Nest under another doc (optional)">
          <USelectMenu
            v-model="newDoc.parentId"
            :items="parentOptions"
            value-key="value"
            class="w-full"
          />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" label="Cancel" @click="() => { createOpen = false }" />
        <UButton
          color="primary"
          label="Create"
          :disabled="!newDoc.title.trim()"
          @click="createDoc"
        />
      </div>
    </template>
  </UModal>

  <ArchivedPreviewModal
    :open="!!preview"
    :title="preview?.title"
    :body="preview?.body"
    @update:open="(v) => { if (!v) preview = null }"
  />
</template>
