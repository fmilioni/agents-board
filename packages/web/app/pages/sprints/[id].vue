<script setup lang="ts">
import type { Card, CardStatus } from '~/types/card'
import type { Sprint } from '~/types/sprint'

const route = useRoute()
const router = useRouter()
const api = useApi()
const sprintId = computed(() => String(route.params.id))

const sprint = ref<Sprint | null>(null)
const cards = ref<Card[]>([])

useHead({ title: () => sprint.value?.name ?? 'Sprint' })
const backlogCards = ref<Card[]>([])
const archivedCards = ref<Card[]>([])
const archivedExpanded = ref(false)
const error = ref<unknown>(null)

const { editing, saving, justSaved } = useSprintInlineEdit(sprint, (updated) => {
  sprint.value = updated
})

const showBacklog = computed(
  () => sprint.value?.status === 'planned' || sprint.value?.status === 'active'
)

async function loadSprint() {
  try {
    sprint.value = await api<Sprint>(`/sprints/${sprintId.value}`)
  } catch (err) {
    error.value = err
    sprint.value = null
  }
}

async function loadCards() {
  if (!sprint.value) {
    cards.value = []
    backlogCards.value = []
    archivedCards.value = []
    return
  }
  const projectId = sprint.value.projectId
  const sprintIdLocal = sprint.value.id
  const fetchArchived = api<Card[]>('/cards', {
    query: { projectId, sprintId: sprintIdLocal, archivedOnly: 'true' }
  })
  if (showBacklog.value) {
    const [sprintList, backlogList, archivedList] = await Promise.all([
      api<Card[]>('/cards', {
        query: { projectId, sprintId: sprintIdLocal }
      }),
      api<Card[]>('/cards', {
        query: { projectId, backlogOnly: 'true', status: 'backlog' }
      }),
      fetchArchived
    ])
    cards.value = sprintList
    backlogCards.value = backlogList
    archivedCards.value = archivedList
  } else {
    const [sprintList, archivedList] = await Promise.all([
      api<Card[]>('/cards', {
        query: { projectId, sprintId: sprintIdLocal }
      }),
      fetchArchived
    ])
    cards.value = sprintList
    backlogCards.value = []
    archivedCards.value = archivedList
  }
}

useProjectData(
  () => sprint.value?.projectId ?? null,
  async () => {
    await loadSprint()
    await loadCards()
  },
  {
    watch: sprintId,
    onEvent: (event) => {
      if (event.type === 'card.changed' || event.type === 'card.deleted') {
        loadCards()
      } else if (
        event.type === 'sprint.deleted'
        && event.sprintId === sprintId.value
      ) {
        // the sprint being viewed was destroyed — leave the dead page.
        navigateTo('/sprints')
      } else if (
        event.type === 'sprint.changed'
        && event.sprintId === sprintId.value
      ) {
        loadSprint()
      } else if (event.type === 'project.changed') {
        loadCards()
      }
    }
  }
)

const selectedTagIds = ref<string[]>([])

// Cards for the columns; story envelopes and grouping live in <BoardColumns>.
// Only the tag filter is applied here.
const filteredCards = computed(() => {
  if (!selectedTagIds.value.length) return cards.value
  const sel = new Set(selectedTagIds.value)
  return cards.value.filter(c => c.tags?.some(t => sel.has(t.id)))
})

async function onReorder({
  status,
  orderedIds,
  movedId
}: { status: CardStatus, orderedIds: string[], movedId?: string }) {
  if (!sprint.value) return
  const sprintIdLocal = sprint.value.id
  let moved: { id: string, status: CardStatus, sprintId?: string | null } | undefined
  if (movedId) {
    const fromBacklogIdx = backlogCards.value.findIndex(c => c.id === movedId)
    if (fromBacklogIdx !== -1) {
      // dropped from the backlog peek → attach to this sprint
      const card = backlogCards.value[fromBacklogIdx]
      if (card) {
        backlogCards.value.splice(fromBacklogIdx, 1)
        cards.value.push({ ...card, status, sprintId: sprintIdLocal })
      }
      moved = { id: movedId, status, sprintId: sprintIdLocal }
    } else {
      const c = cards.value.find(x => x.id === movedId)
      if (c) c.status = status
      moved = { id: movedId, status }
    }
  }
  orderedIds.forEach((id, i) => {
    const c = cards.value.find(x => x.id === id)
    if (c) c.position = i
  })
  try {
    await api('/cards/reorder', { method: 'POST', body: { orderedIds, moved } })
  } catch (err) {
    console.error('Failed to reorder, reloading', err)
    await loadCards()
  }
}

async function onMoveToBacklog(cardId: string) {
  const idx = cards.value.findIndex(c => c.id === cardId)
  if (idx === -1) return
  const card = cards.value[idx]
  if (!card) return
  cards.value.splice(idx, 1)
  backlogCards.value.push({ ...card, sprintId: null })
  try {
    await api(`/cards/${cardId}`, {
      method: 'PATCH',
      body: { sprintId: null }
    })
  } catch (err) {
    console.error('Failed to move card to backlog, reloading', err)
    await loadCards()
  }
}

const statusBadgeColor = computed(() => {
  if (!sprint.value) return 'neutral'
  return (
    {
      planned: 'neutral',
      active: 'info',
      completed: 'success',
      cancelled: 'error'
    } as const
  )[sprint.value.status]
})

async function startSprint() {
  if (!sprint.value) return
  await api(`/sprints/${sprint.value.id}/start`, { method: 'POST' })
  await loadSprint()
}

async function completeSprint() {
  if (!sprint.value) return
  await api(`/sprints/${sprint.value.id}/complete`, { method: 'POST' })
  await loadSprint()
}

async function deactivateSprint() {
  if (!sprint.value) return
  await api(`/sprints/${sprint.value.id}/deactivate`, { method: 'POST' })
  await loadSprint()
}

function onSprintRemoved() {
  router.push('/sprints')
}

// Real history back when we got here from somewhere in the app; otherwise (a
// direct load / refresh) fall back to the sprints list so we never leave it.
function goBack() {
  if (window.history.state?.back) router.back()
  else router.push('/sprints')
}

async function restoreCard(cardId: string) {
  await api(`/cards/${cardId}/restore`, { method: 'POST' })
  await loadCards()
}
</script>

<template>
  <UDashboardPanel
    id="sprint-detail"
    :ui="{ body: 'flex flex-col gap-4 sm:gap-6 flex-1 overflow-hidden p-4 sm:p-6' }"
  >
    <template #header>
      <UDashboardNavbar
        :title="sprint?.name ?? 'Sprint'"
        :ui="{ left: 'flex-1 min-w-0', title: 'flex-1 min-w-0' }"
      >
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            @click="goBack"
          />
        </template>
        <template v-if="sprint" #title>
          <UInput
            v-model="editing.name"
            variant="ghost"
            size="lg"
            placeholder="Sprint name"
            class="w-full [&_input]:text-lg! [&_input]:font-semibold! [&_input]:px-0!"
          />
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
          <UBadge v-if="sprint" :color="statusBadgeColor" variant="subtle">
            {{ sprint.status }}
          </UBadge>
          <UButton
            v-if="sprint?.status === 'planned'"
            icon="i-lucide-play"
            size="sm"
            color="primary"
            variant="soft"
            label="Start"
            class="ml-2"
            @click="startSprint"
          />
          <UButton
            v-if="sprint?.status === 'active'"
            icon="i-lucide-pause"
            size="sm"
            color="neutral"
            variant="soft"
            label="Deactivate"
            class="ml-2"
            @click="deactivateSprint"
          />
          <UButton
            v-if="sprint?.status === 'active'"
            icon="i-lucide-check"
            size="sm"
            color="success"
            variant="soft"
            label="Complete"
            class="ml-2"
            @click="completeSprint"
          />
          <ArchiveDestroyMenu
            v-if="sprint"
            kind="sprint"
            :entity-id="sprint.id"
            :entity-label="sprint.name"
            :cascade-count="cards.length"
            cascade-noun="card"
            class="ml-1"
            @archived="onSprintRemoved"
            @destroyed="onSprintRemoved"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="error" class="text-error py-12 text-center">
        Sprint not found.
      </div>
      <template v-else-if="sprint">
        <UTextarea
          v-model="editing.goal"
          variant="ghost"
          :rows="1"
          autoresize
          placeholder="Add a goal for this sprint…"
          class="w-full shrink-0"
          :ui="{ base: 'text-sm text-muted !px-0 resize-none' }"
        />
        <div class="flex items-center justify-end gap-2 shrink-0">
          <BoardTagFilter
            v-model="selectedTagIds"
            :project-id="sprint.projectId"
          />
        </div>
        <BoardColumns
          :cards="filteredCards"
          :backlog="showBacklog ? backlogCards : null"
          :backlog-closable="sprint.status === 'active'"
          :backlog-start-expanded="sprint.status === 'planned'"
          @reorder="onReorder"
          @move-to-backlog="onMoveToBacklog"
        >
          <template #trailing>
            <template v-if="archivedCards.length">
              <CollapsedColumn
                v-if="!archivedExpanded"
                icon="i-lucide-archive"
                label="Archived"
                :count="archivedCards.length"
                @expand="archivedExpanded = true"
              />
              <div
                v-else
                class="flex flex-col bg-elevated/20 rounded-lg border border-dashed border-default overflow-hidden h-full"
                style="flex: 1 1 0; min-width: 200px;"
              >
                <div
                  class="flex items-center justify-between px-3 py-2 border-b border-default border-dashed shrink-0"
                >
                  <div class="flex items-center gap-2">
                    <UIcon name="i-lucide-archive" class="text-muted size-4" />
                    <span class="text-sm font-semibold text-muted">Archived</span>
                    <span class="text-xs text-muted">{{ archivedCards.length }}</span>
                  </div>
                  <UButton
                    icon="i-lucide-x"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    @click="archivedExpanded = false"
                  />
                </div>
                <div
                  class="flex flex-col gap-2 p-2 flex-1 overflow-y-auto overflow-x-hidden"
                >
                  <div
                    v-for="card in archivedCards"
                    :key="card.id"
                    class="min-w-0 shrink-0 bg-default border border-default rounded-md px-2.5 py-2"
                  >
                    <NuxtLink
                      :to="`/cards/${card.key}`"
                      class="text-sm leading-snug wrap-break-word min-w-0 hover:underline decoration-primary/40 underline-offset-2"
                    >
                      <span class="font-mono font-bold text-default mr-1.5">{{ card.key }}</span>
                      <span class="font-medium">{{ card.title }}</span>
                    </NuxtLink>
                    <p
                      v-if="card.summary"
                      class="text-xs text-muted leading-snug line-clamp-2 mt-1"
                    >
                      {{ card.summary }}
                    </p>
                    <div class="mt-2 flex justify-end">
                      <UButton
                        icon="i-lucide-archive-restore"
                        size="xs"
                        color="neutral"
                        variant="soft"
                        label="Restore"
                        @click="restoreCard(card.id)"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </template>
        </BoardColumns>
      </template>
    </template>
  </UDashboardPanel>
</template>
