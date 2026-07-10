<script setup lang="ts">
import { useProjectStore } from '~/stores/project'
import type { Card, CardStatus } from '~/types/card'
import type { Sprint } from '~/types/sprint'

const store = useProjectStore()
const { currentProject, currentProjectId } = storeToRefs(store)
const api = useApi()

useHead({ title: 'Sprints' })

const sprints = ref<Sprint[]>([])
const archivedSprints = ref<Sprint[]>([])
const cards = ref<Card[]>([])

async function loadSprints() {
  if (!currentProjectId.value) {
    sprints.value = []
    archivedSprints.value = []
    return
  }
  const [active, archived] = await Promise.all([
    api<Sprint[]>('/sprints', { query: { projectId: currentProjectId.value } }),
    api<Sprint[]>('/sprints', {
      query: { projectId: currentProjectId.value, archivedOnly: 'true' }
    })
  ])
  sprints.value = active
  archivedSprints.value = [...archived].sort(byRecencyDesc)
}

function sprintRecency(s: Sprint): string {
  // archivedAt stays out of the chain: archiving is usually batched (near-equal
  // timestamps), so a sprint without endsAt would jump to the top. createdAt
  // reflects the sprint's real age.
  return s.endsAt ?? s.createdAt
}
function byRecencyDesc(a: Sprint, b: Sprint): number {
  return sprintRecency(b).localeCompare(sprintRecency(a))
}

async function loadCards() {
  if (!currentProjectId.value) {
    cards.value = []
    return
  }
  cards.value = await api<Card[]>('/cards', {
    query: { projectId: currentProjectId.value }
  })
}

async function reloadAll() {
  await Promise.all([loadSprints(), loadCards()])
}

useProjectData(currentProjectId, reloadAll, {
  onEvent: (event) => {
    if (event.type === 'sprint.changed' || event.type === 'sprint.deleted') {
      loadSprints()
    } else if (event.type === 'card.changed' || event.type === 'card.deleted') {
      loadCards()
    }
  }
})

const sections = computed(() => {
  const groups: Record<Sprint['status'], Sprint[]> = {
    active: [],
    planned: [],
    completed: [],
    cancelled: []
  }
  for (const s of sprints.value) groups[s.status].push(s)
  return [
    { key: 'active', label: 'Active', items: groups.active },
    { key: 'planned', label: 'Planned', items: groups.planned },
    { key: 'completed', label: 'Completed', items: [...groups.completed].sort(byRecencyDesc) }
  ]
})

function statsFor(sprintId: string) {
  const list = cards.value.filter(c => c.sprintId === sprintId)
  const counts: Record<CardStatus, number> = {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    blocked: 0
  }
  for (const c of list) counts[c.status]++
  return { total: list.length, counts }
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString()
}

async function startSprint(id: string) {
  await api(`/sprints/${id}/start`, { method: 'POST' })
  await loadSprints()
}

async function completeSprint(id: string) {
  await api(`/sprints/${id}/complete`, { method: 'POST' })
  await loadSprints()
}

async function deactivateSprint(id: string) {
  await api(`/sprints/${id}/deactivate`, { method: 'POST' })
  await loadSprints()
}

async function restoreSprint(id: string) {
  await api(`/sprints/${id}/restore`, { method: 'POST' })
  await loadSprints()
}

async function reopenSprint(id: string) {
  await api(`/sprints/${id}/reopen`, { method: 'POST' })
  await loadSprints()
}

function formatStatus(status: Sprint['status']) {
  return { active: 'Active', planned: 'Planned', completed: 'Completed', cancelled: 'Cancelled' }[
    status
  ]
}

const createOpen = ref(false)
const newSprint = reactive({ name: '', goal: '' })
async function createSprint() {
  if (!currentProjectId.value || !newSprint.name.trim()) return
  await api('/sprints', {
    method: 'POST',
    body: {
      projectId: currentProjectId.value,
      name: newSprint.name,
      goal: newSprint.goal || undefined
    }
  })
  newSprint.name = ''
  newSprint.goal = ''
  createOpen.value = false
  await loadSprints()
}
</script>

<template>
  <UDashboardPanel id="sprints">
    <template #header>
      <UDashboardNavbar title="Sprints">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UIcon name="i-lucide-timer" class="text-primary" />
        </template>
        <template #right>
          <UButton
            v-if="currentProject"
            icon="i-lucide-plus"
            color="primary"
            label="New sprint"
            @click="() => { createOpen = true }"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="!currentProject" class="text-center text-muted py-12">
        Pick a project in the sidebar.
      </div>

      <div v-else class="space-y-8 w-full">
        <section v-for="section in sections" :key="section.key">
          <h2 class="text-xs font-semibold text-muted uppercase tracking-wide mb-3 flex items-center gap-2">
            {{ section.label }}
            <span class="text-default">({{ section.items.length }})</span>
          </h2>

          <div
            v-if="!section.items.length"
            class="text-sm text-muted/60 italic"
          >
            <template v-if="section.key === 'active'">
              No active sprint. Start one from the Planned list below.
            </template>
            <template v-else-if="section.key === 'planned'">
              No planned sprints. Create one with the button above.
            </template>
            <template v-else>
              No completed sprints yet.
            </template>
          </div>

          <div v-else class="space-y-3">
            <SprintRow
              v-for="s in section.items"
              :key="s.id"
              :sprint="s"
              :stats="statsFor(s.id)"
              :format-date="formatDate"
              @start="startSprint(s.id)"
              @complete="completeSprint(s.id)"
              @deactivate="deactivateSprint(s.id)"
              @reopen="reopenSprint(s.id)"
              @archived="loadSprints()"
              @destroyed="reloadAll()"
            />
          </div>
        </section>

        <ArchivedDisclosure :count="archivedSprints.length" label="Archived">
          <div class="space-y-2">
            <div
              v-for="s in archivedSprints"
              :key="s.id"
              class="border border-dashed border-default rounded-md px-4 py-3 flex items-center justify-between gap-3"
            >
              <NuxtLink
                :to="`/sprints/${s.id}`"
                class="min-w-0 flex-1 hover:underline decoration-primary/40 underline-offset-2"
              >
                <h3 class="font-semibold text-sm truncate">{{ s.name }}</h3>
                <p class="text-xs text-muted">{{ formatStatus(s.status) }}</p>
              </NuxtLink>
              <div class="flex items-center gap-1 shrink-0">
                <UButton
                  icon="i-lucide-rotate-ccw"
                  size="xs"
                  color="neutral"
                  variant="soft"
                  label="Reopen"
                  @click="reopenSprint(s.id)"
                />
                <UButton
                  icon="i-lucide-archive-restore"
                  size="xs"
                  color="neutral"
                  variant="soft"
                  label="Restore"
                  @click="restoreSprint(s.id)"
                />
                <ArchiveDestroyMenu
                  kind="sprint"
                  :entity-id="s.id"
                  :entity-label="s.name"
                  :cascade-count="statsFor(s.id).total"
                  cascade-noun="card"
                  :can-archive="false"
                  size="xs"
                  @destroyed="reloadAll()"
                />
              </div>
            </div>
          </div>
        </ArchivedDisclosure>
      </div>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="createOpen" title="Create sprint">
    <template #body>
      <div class="space-y-4">
        <UFormField label="Name" required>
          <UInput v-model="newSprint.name" placeholder="Phase 3 - Roadmaps" />
        </UFormField>
        <UFormField
          label="Goal"
          hint="Optional summary of what this sprint aims to achieve"
        >
          <UTextarea v-model="newSprint.goal" :rows="3" />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" label="Cancel" @click="() => { createOpen = false }" />
        <UButton
          color="primary"
          label="Create"
          :disabled="!newSprint.name.trim()"
          @click="createSprint"
        />
      </div>
    </template>
  </UModal>
</template>
