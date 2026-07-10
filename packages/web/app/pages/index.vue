<script setup lang="ts">
import { useProjectStore } from '~/stores/project'
import type { Card, CardStatus } from '~/types/card'
import { cardStatusMeta, cardStatusOrder } from '~/types/card'
import type { Sprint } from '~/types/sprint'

const store = useProjectStore()
const { projects, currentProject, currentProjectId } = storeToRefs(store)
const api = useApi()

useHead({ title: 'Home' })

const { data: activeSprints, refresh: refreshSprint } = useActiveSprint(
  () => currentProjectId.value
)

const { sprintCards, looseCards, cards: boardCards, load: loadCards }
  = useBoardCards(currentProjectId, activeSprints)
const sprints = ref<Sprint[]>([])

async function loadDashboard() {
  const projectId = currentProjectId.value
  const [sprintList] = await Promise.all([
    projectId
      ? api<Sprint[]>('/sprints', { query: { projectId } })
      : Promise.resolve<Sprint[]>([]),
    loadCards()
  ])
  sprints.value = sprintList
}

useProjectData(currentProjectId, loadDashboard, {
  watch: [currentProjectId, activeSprints],
  onEvent: (event) => {
    if (event.type === 'sprint.changed' || event.type === 'sprint.deleted') {
      refreshSprint()
    } else if (
      event.type === 'card.changed'
      || event.type === 'card.deleted'
    ) {
      loadDashboard()
    } else if (
      event.type === 'project.changed'
      || event.type === 'project.deleted'
    ) {
      // a project was renamed, archived or destroyed — reload the list (the store
      // falls back to another project if the current one is gone) and the stats.
      store.loadAndRepoint()
      loadDashboard()
    }
  }
})

const statusCounts = computed<Record<CardStatus, number>>(() => {
  const counts: Record<CardStatus, number> = {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    blocked: 0
  }
  for (const c of sprintCards.value) counts[c.status]++
  return counts
})

const totalSprintCards = computed(() => sprintCards.value.length)
const doneSprintCards = computed(() => statusCounts.value.done)
const sprintProgress = computed(() =>
  totalSprintCards.value
    ? Math.round((doneSprintCards.value / totalSprintCards.value) * 100)
    : 0
)

const sprintsByStatus = computed(() => ({
  active: sprints.value.filter(s => s.status === 'active').length,
  planned: sprints.value.filter(s => s.status === 'planned').length,
  completed: sprints.value.filter(s => s.status === 'completed').length
}))

const stats = computed<{ label: string, value: string | number, icon: string }[]>(
  () => [
    { label: 'Projects', value: projects.value.length, icon: 'i-lucide-folders' },
    { label: 'Sprints', value: sprints.value.length, icon: 'i-lucide-timer' },
    {
      label: 'Tasks in sprint',
      value: totalSprintCards.value,
      icon: 'i-lucide-list-checks'
    },
    {
      label: 'Completion',
      value: `${sprintProgress.value}%`,
      icon: 'i-lucide-circle-check-big'
    }
  ]
)

const HOME_LIST_LIMIT = 5

// review/to-do read the full board scope (`boardCards`); backlog reads only the
// sprint-less cards — matching where each list's "View more" leads (board vs Tasks).
const cardLists = computed(() => {
  const byStatus = (cards: Card[], status: CardStatus) =>
    cards.filter(c => c.status === status)
  const sections = [
    {
      key: 'review',
      icon: 'i-lucide-eye',
      cards: byStatus(boardCards.value, 'review'),
      to: '/board',
      empty: 'Nothing in review.'
    },
    {
      key: 'todo',
      icon: 'i-lucide-circle-dashed',
      cards: byStatus(boardCards.value, 'todo'),
      to: '/board',
      empty: 'Nothing to do.'
    },
    {
      key: 'backlog',
      icon: 'i-lucide-inbox',
      cards: byStatus(looseCards.value, 'backlog'),
      to: '/tasks',
      empty: 'Backlog is empty.'
    }
  ] as const
  return sections.map(s => ({
    ...s,
    label: cardStatusMeta[s.key].label,
    color: cardStatusMeta[s.key].color,
    total: s.cards.length,
    items: s.cards.slice(0, HOME_LIST_LIMIT)
  }))
})
</script>

<template>
  <UDashboardPanel id="home">
    <template #header>
      <UDashboardNavbar title="Home">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UIcon name="i-lucide-home" class="text-primary" />
        </template>
        <template #right>
          <UBadge v-if="currentProject" color="neutral" variant="subtle">
            {{ currentProject.name }}
          </UBadge>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="flex flex-col gap-4 sm:gap-6">
        <div v-if="!currentProject" class="text-center text-muted py-8">
          Pick or create a project in the sidebar.
        </div>
        <template v-else>
          <!-- Stat cards -->
          <div class="rounded-lg border border-default bg-elevated/40 overflow-hidden">
            <div
              class="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-default"
            >
              <div
                v-for="stat in stats"
                :key="stat.label"
                class="flex flex-col gap-2 p-4 sm:p-5"
              >
                <div class="flex items-center gap-2 text-muted">
                  <UIcon :name="stat.icon" class="size-4 shrink-0" />
                  <span class="text-xs font-medium uppercase tracking-wide truncate">
                    {{ stat.label }}
                  </span>
                </div>
                <p class="text-2xl font-semibold tabular-nums text-highlighted">
                  {{ stat.value }}
                </p>
              </div>
            </div>
          </div>

          <div class="grid gap-4 sm:gap-6 lg:grid-cols-3">
            <!-- Active sprint -->
            <UCard class="lg:col-span-2">
              <template #header>
                <div class="flex items-center justify-between gap-2">
                  <span class="font-medium truncate">
                    {{ activeSprints.length === 1 ? activeSprints[0]!.name : 'Active sprints' }}
                  </span>
                  <UBadge
                    v-if="activeSprints.length"
                    color="info"
                    variant="subtle"
                  >
                    {{ activeSprints.length > 1 ? `${activeSprints.length} active` : 'active' }}
                  </UBadge>
                </div>
              </template>

              <div v-if="!activeSprints.length" class="text-sm text-muted py-4 text-center">
                No active sprint. Start one from
                <NuxtLink to="/sprints" class="text-primary hover:underline">Sprints</NuxtLink>.
              </div>

              <div v-else class="space-y-4">
                <div>
                  <div class="flex items-center justify-between text-sm mb-1.5">
                    <span class="text-muted">
                      {{ doneSprintCards }} / {{ totalSprintCards }} done
                    </span>
                    <span class="font-medium tabular-nums">{{ sprintProgress }}%</span>
                  </div>
                  <UProgress
                    :model-value="doneSprintCards"
                    :max="Math.max(totalSprintCards, 1)"
                    color="primary"
                  />
                </div>

                <div class="flex flex-wrap gap-2">
                  <UBadge
                    v-for="status in cardStatusOrder"
                    :key="status"
                    :color="cardStatusMeta[status].color"
                    variant="subtle"
                  >
                    {{ cardStatusMeta[status].label }}: {{ statusCounts[status] }}
                  </UBadge>
                </div>
              </div>
            </UCard>

            <!-- Sprints breakdown -->
            <UCard>
              <template #header>
                <span class="font-medium">Sprints</span>
              </template>
              <dl class="space-y-3">
                <div class="flex items-center justify-between">
                  <dt class="text-sm text-muted flex items-center gap-2">
                    <UIcon name="i-lucide-play" class="text-info" /> Active
                  </dt>
                  <dd class="font-medium tabular-nums">
                    {{ sprintsByStatus.active }}
                  </dd>
                </div>
                <div class="flex items-center justify-between">
                  <dt class="text-sm text-muted flex items-center gap-2">
                    <UIcon name="i-lucide-clock" class="text-muted" /> Planned
                  </dt>
                  <dd class="font-medium tabular-nums">
                    {{ sprintsByStatus.planned }}
                  </dd>
                </div>
                <div class="flex items-center justify-between">
                  <dt class="text-sm text-muted flex items-center gap-2">
                    <UIcon name="i-lucide-check" class="text-success" /> Completed
                  </dt>
                  <dd class="font-medium tabular-nums">
                    {{ sprintsByStatus.completed }}
                  </dd>
                </div>
              </dl>
            </UCard>
          </div>

          <div class="grid gap-4 sm:gap-6 lg:grid-cols-3">
            <UCard v-for="list in cardLists" :key="list.key">
              <template #header>
                <div class="flex items-center justify-between gap-2">
                  <span class="font-medium flex items-center gap-2 min-w-0">
                    <UIcon :name="list.icon" class="text-muted shrink-0" />
                    <span class="truncate">{{ list.label }}</span>
                    <UBadge :color="list.color" variant="subtle" size="sm">
                      {{ list.total }}
                    </UBadge>
                  </span>
                  <UButton
                    :to="list.to"
                    label="View more"
                    trailing-icon="i-lucide-arrow-right"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                  />
                </div>
              </template>

              <div v-if="!list.items.length" class="text-sm text-muted py-2">
                {{ list.empty }}
              </div>
              <ul v-else class="-mx-2">
                <li v-for="card in list.items" :key="card.id">
                  <NuxtLink
                    :to="`/cards/${card.key}`"
                    class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-elevated/60 transition min-w-0"
                  >
                    <span class="font-mono text-xs font-bold text-muted shrink-0">
                      {{ card.key }}
                    </span>
                    <span class="text-sm truncate">{{ card.title }}</span>
                  </NuxtLink>
                </li>
              </ul>
            </UCard>
          </div>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
