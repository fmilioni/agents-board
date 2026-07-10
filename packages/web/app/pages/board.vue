<script setup lang="ts">
import { useProjectStore } from '~/stores/project'
import type { Card, CardStatus } from '~/types/card'

const store = useProjectStore()
const { currentProject, currentProjectId } = storeToRefs(store)
const api = useApi()
const { capabilities, ensureCapabilities } = useAuth()

useHead({ title: 'Board' })
onMounted(() => {
  ensureCapabilities()
})

const { data: activeSprints, refresh: refreshSprint } = useActiveSprint(
  () => currentProjectId.value
)

// A project may have several active sprints (CO-399). The inline goal editor
// only makes sense for a single one, so it's wired to that lone active sprint
// (null with 0 or N, hidden in the template).
const singleActiveSprint = computed(() =>
  activeSprints.value.length === 1 ? (activeSprints.value[0] ?? null) : null
)

const { editing, saving, justSaved } = useSprintInlineEdit(
  singleActiveSprint,
  (updated) => {
    activeSprints.value = activeSprints.value.map(s =>
      s.id === updated.id ? updated : s
    )
  }
)

// Story-collapse toggle on the board's story envelopes (persisted per project).
provide(boardCollapseKey, useCollapsedStories(currentProjectId))

const { cards, load: loadCards } = useBoardCards(currentProjectId, activeSprints)
const selectedTagIds = ref<string[]>([])
// The sprint filter focuses a single active sprint by id; `all` shows every
// active sprint's cards plus the loose ones (default).
const sprintFilter = ref<string>('all')
const showHidden = ref(false)

const sprintFilterOptions = computed<{ value: string, label: string }[]>(() => [
  { value: 'all', label: 'All sprints' },
  ...activeSprints.value.map(s => ({ value: s.id, label: s.name }))
])

// If the focused sprint stops being active (deactivated/completed elsewhere),
// fall back to "All" so the board doesn't silently show nothing.
watch(activeSprints, (list) => {
  if (
    sprintFilter.value !== 'all'
    && !list.some(s => s.id === sprintFilter.value)
  ) {
    sprintFilter.value = 'all'
  }
})

useProjectData(currentProjectId, loadCards, {
  watch: [currentProjectId, activeSprints],
  onEvent: (event) => {
    if (event.type === 'card.changed' || event.type === 'card.deleted') {
      loadCards()
    } else if (
      event.type === 'sprint.changed'
      || event.type === 'sprint.deleted'
    ) {
      refreshSprint()
    } else if (event.type === 'project.changed') {
      loadCards()
    }
  }
})

const DAY_MS = 86_400_000

// Status-column cards: everything but `backlog` (shown only in the peek below),
// narrowed by the sprint and tag filters.
const filteredCards = computed(() => {
  let list = cards.value.filter(c => c.status !== 'backlog')
  if (sprintFilter.value !== 'all') {
    list = list.filter(c => c.sprintId === sprintFilter.value)
  }
  if (selectedTagIds.value.length) {
    const sel = new Set(selectedTagIds.value)
    list = list.filter(c => c.tags?.some(t => sel.has(t.id)))
  }
  return list
})

// Ids of cards that parent another shown card — i.e. story envelopes. They give
// the group its title in <BoardColumns>, so hiding one (it's a loose done card
// too) would strip the name off a group whose children are still on the board.
const storyParentIds = computed(
  () =>
    new Set(
      filteredCards.value
        .map(c => c.parentId)
        .filter((id): id is string => !!id)
    )
)

// A loose (sprint-less, parent-less) done card past the configured age drops off
// the board — view only, it stays active and visible to search/MCP. Sprint cards,
// story sub-tasks, story envelopes and active loose cards are never affected.
// `days = 0` hides it as soon as it's done.
function isStaleLooseDone(c: Card): boolean {
  if (!capabilities.value?.hideLooseDoneEnabled) return false
  if (storyParentIds.value.has(c.id)) return false
  if (c.sprintId || c.parentId || c.status !== 'done' || !c.doneAt) return false
  const days = capabilities.value.hideLooseDoneAfterDays
  return Date.now() - new Date(c.doneAt).getTime() >= days * DAY_MS
}

// Stale loose done cards among those that pass the other filters — so the toggle
// count matches exactly what "Show hidden" reveals.
const hiddenCount = computed(
  () => filteredCards.value.filter(isStaleLooseDone).length
)

const columnCards = computed(() =>
  showHidden.value
    ? filteredCards.value
    : filteredCards.value.filter(c => !isStaleLooseDone(c))
)

// The backlog peek: sprint-less cards still in the `backlog` status.
const backlogCards = computed(() =>
  cards.value.filter(c => !c.sprintId && c.status === 'backlog')
)

async function patchCard(cardId: string, body: Record<string, unknown>) {
  try {
    await api(`/cards/${cardId}`, { method: 'PATCH', body })
  } catch (err) {
    console.error('Failed to update card, reloading', err)
    await loadCards()
  }
}

// Column reorder/drop. A dropped card takes the column's status; its sprint
// membership is left untouched (a sprint-less card stays standalone). Positions
// are persisted so the dropped order sticks across reloads.
async function onReorder({
  status,
  orderedIds,
  movedId
}: { status: CardStatus, orderedIds: string[], movedId?: string }) {
  if (movedId) {
    const moved = cards.value.find(c => c.id === movedId)
    if (moved) moved.status = status
  }
  orderedIds.forEach((id, i) => {
    const c = cards.value.find(x => x.id === id)
    if (c) c.position = i
  })
  try {
    await api('/cards/reorder', {
      method: 'POST',
      body: { orderedIds, moved: movedId ? { id: movedId, status } : undefined }
    })
  } catch (err) {
    console.error('Failed to reorder, reloading', err)
    await loadCards()
  }
}

// Dropped into the backlog peek. Parks the card: `backlog` status, no sprint.
async function onMoveToBacklog(cardId: string) {
  const card = cards.value.find(c => c.id === cardId)
  if (!card) return
  card.status = 'backlog'
  card.sprintId = null
  await patchCard(cardId, { status: 'backlog', sprintId: null })
}
</script>

<template>
  <UDashboardPanel
    id="board"
    :ui="{ body: 'flex flex-col gap-4 sm:gap-6 flex-1 overflow-hidden p-4 sm:p-6' }"
  >
    <template #header>
      <UDashboardNavbar title="Board" :ui="{ left: 'flex-1 min-w-0' }">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UIcon name="i-lucide-kanban" class="text-primary" />
        </template>
        <template #right>
          <span
            v-if="saving"
            class="text-xs text-muted mr-2 flex items-center gap-1"
          >
            <UIcon name="i-lucide-loader-2" class="animate-spin" /> Saving…
          </span>
          <span
            v-else-if="justSaved"
            class="text-xs text-muted mr-2 flex items-center gap-1 transition-opacity"
          >
            <UIcon name="i-lucide-check" /> Saved
          </span>
          <UBadge
            v-if="activeSprints.length === 1"
            color="info"
            variant="subtle"
          >
            {{ activeSprints[0]!.name }}
          </UBadge>
          <UBadge
            v-else-if="activeSprints.length > 1"
            color="info"
            variant="subtle"
          >
            {{ activeSprints.length }} active sprints
          </UBadge>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="!currentProject" class="text-center text-muted py-12">
        Pick a project in the sidebar.
      </div>
      <template v-else>
        <UTextarea
          v-if="singleActiveSprint"
          v-model="editing.goal"
          variant="ghost"
          :rows="1"
          autoresize
          placeholder="Add a goal for the active sprint…"
          class="w-full shrink-0"
          :ui="{ base: 'text-sm text-muted !px-0 resize-none' }"
        />
        <div class="flex items-center justify-end gap-2 shrink-0">
          <UButton
            v-if="hiddenCount > 0"
            :label="`Show hidden (${hiddenCount})`"
            :icon="showHidden ? 'i-lucide-eye-off' : 'i-lucide-eye'"
            color="neutral"
            :variant="showHidden ? 'subtle' : 'ghost'"
            @click="showHidden = !showHidden"
          />
          <USelectMenu
            v-if="activeSprints.length"
            :model-value="sprintFilter"
            :items="sprintFilterOptions"
            value-key="value"
            icon="i-lucide-filter"
            class="w-44"
            @update:model-value="(v: string) => (sprintFilter = v)"
          />
          <BoardTagFilter
            v-model="selectedTagIds"
            :project-id="currentProjectId"
          />
        </div>
        <BoardColumns
          :cards="columnCards"
          :backlog="backlogCards"
          @reorder="onReorder"
          @move-to-backlog="onMoveToBacklog"
        />
      </template>
    </template>
  </UDashboardPanel>
</template>
