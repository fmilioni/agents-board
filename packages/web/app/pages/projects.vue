<script setup lang="ts">
import type { Project } from '@agents-board/shared'

import { useProjectStore } from '~/stores/project'

definePageMeta({ middleware: 'admin-or-open' })
useHead({ title: 'Projects' })

const store = useProjectStore()
const { projects, currentProjectId } = storeToRefs(store)
const api = useApi()
const toast = useToast()
const download = useApiDownload()

const archivedProjects = ref<Project[]>([])

async function loadArchivedProjects() {
  archivedProjects.value = await api<Project[]>('/projects', {
    query: { archivedOnly: 'true' }
  })
}

async function refreshProjectLists() {
  await Promise.all([store.loadAndRepoint(), loadArchivedProjects()])
}

useProjectData(currentProjectId, refreshProjectLists, {
  watch: [currentProjectId],
  onEvent: (event) => {
    if (
      event.type === 'project.changed'
      || event.type === 'project.deleted'
    ) {
      refreshProjectLists()
    }
  }
})

const createOpen = ref(false)

async function archiveProject(id: string) {
  try {
    await api(`/projects/${id}/archive`, { method: 'POST' })
    await refreshProjectLists()
  } catch (e) {
    toast.add({
      title: 'Failed to archive project',
      description: resolveError(e),
      color: 'error'
    })
  }
}

async function restoreProject(id: string) {
  try {
    await api(`/projects/${id}/restore`, { method: 'POST' })
    await refreshProjectLists()
  } catch (e) {
    toast.add({
      title: 'Failed to restore project',
      description: resolveError(e),
      color: 'error'
    })
  }
}

const destroyOpen = ref(false)
const destroyTarget = ref<Project | null>(null)
const destroyConfirm = ref('')

const destroyArmed = computed(
  () => !!destroyTarget.value && destroyConfirm.value === destroyTarget.value.slug
)

function openDestroy(project: Project) {
  destroyTarget.value = project
  destroyConfirm.value = ''
  destroyOpen.value = true
}

async function confirmDestroy() {
  const target = destroyTarget.value
  if (!target || !destroyArmed.value) return
  try {
    await api(`/projects/${target.id}`, {
      method: 'DELETE',
      body: { confirmSlug: destroyConfirm.value }
    })
    destroyOpen.value = false
    destroyTarget.value = null
    destroyConfirm.value = ''
    await refreshProjectLists()
  } catch (e) {
    toast.add({
      title: 'Failed to destroy project',
      description: resolveError(e),
      color: 'error'
    })
  }
}

const importing = ref(false)
const importError = ref<string | null>(null)
const imported = ref<Project[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

async function onImportFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  importing.value = true
  importError.value = null
  imported.value = []
  try {
    const buf = await file.arrayBuffer()
    const { projectIds } = await api<{ projectIds: string[] }>('/import', {
      method: 'POST',
      body: buf,
      headers: { 'Content-Type': 'application/gzip' }
    })
    await refreshProjectLists()
    const byId = new Map(store.projects.map(p => [p.id, p]))
    imported.value = projectIds.map(id => byId.get(id)).filter(Boolean) as Project[]
  } catch (err) {
    importError.value = resolveError(err)
  } finally {
    importing.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

function openProject(slug: string) {
  store.setCurrent(slug)
  navigateTo('/board')
}
</script>

<template>
  <UDashboardPanel id="projects">
    <template #header>
      <UDashboardNavbar title="Projects">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UIcon name="i-lucide-folders" class="text-primary" />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-download"
            label="Export all"
            color="neutral"
            variant="ghost"
            @click="download('/export')"
          />
          <UButton
            icon="i-lucide-upload"
            label="Import"
            color="neutral"
            variant="ghost"
            :loading="importing"
            @click="fileInput?.click()"
          />
          <input
            ref="fileInput"
            type="file"
            accept=".gz,application/gzip"
            aria-label="Import a backup file"
            class="hidden"
            @change="onImportFile"
          >
          <UButton
            icon="i-lucide-plus"
            label="New project"
            color="primary"
            @click="() => { createOpen = true }"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="max-w-2xl mx-auto w-full space-y-4">
        <div
          v-if="imported.length"
          class="space-y-1.5 border border-default rounded-lg p-3"
        >
          <div class="flex items-center gap-2 text-sm text-success">
            <UIcon name="i-lucide-check-circle" />
            <span>Imported {{ imported.length }} project{{ imported.length === 1 ? "" : "s" }} as new.</span>
          </div>
          <div
            v-for="p in imported"
            :key="p.id"
            class="flex items-center gap-2 text-sm pl-6"
          >
            <span class="flex-1 truncate text-muted">{{ p.name }} ({{ p.slug }})</span>
            <UButton
              size="xs"
              color="primary"
              variant="subtle"
              label="Open"
              @click="openProject(p.slug)"
            />
          </div>
        </div>

        <UAlert
          v-if="importError"
          color="error"
          variant="soft"
          icon="i-lucide-alert-triangle"
          :title="importError"
        />

        <div
          v-if="projects.length === 0"
          class="text-sm text-muted border border-default rounded-lg p-8 text-center"
        >
          No projects yet.
        </div>

        <ul v-else class="space-y-2">
          <li
            v-for="p in projects"
            :key="p.id"
            class="flex items-center gap-3 border border-default rounded-lg p-3"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm truncate">{{ p.name }}</span>
                <UBadge
                  v-if="p.id === currentProjectId"
                  size="xs"
                  variant="subtle"
                  color="primary"
                  label="current"
                />
              </div>
              <p class="text-xs text-muted font-mono truncate">
                {{ p.slug }}
              </p>
            </div>
            <UButton
              icon="i-lucide-download"
              size="xs"
              color="neutral"
              variant="ghost"
              label="Export"
              @click="download(`/projects/${p.id}/export`)"
            />
            <UButton
              icon="i-lucide-archive"
              size="xs"
              color="neutral"
              variant="ghost"
              label="Archive"
              @click="archiveProject(p.id)"
            />
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              color="error"
              variant="ghost"
              label="Destroy"
              @click="openDestroy(p)"
            />
          </li>
        </ul>

        <ArchivedDisclosure
          v-if="archivedProjects.length"
          :count="archivedProjects.length"
          label="Archived projects"
        >
          <div class="space-y-2">
            <div
              v-for="p in archivedProjects"
              :key="p.id"
              class="flex items-center gap-3 border border-dashed border-default rounded-lg p-3"
            >
              <div class="flex-1 min-w-0">
                <span class="font-medium text-sm text-muted">{{ p.name }}</span>
                <span class="text-xs text-muted font-mono ml-2">{{ p.slug }}</span>
              </div>
              <UButton
                icon="i-lucide-archive-restore"
                size="xs"
                color="neutral"
                variant="soft"
                label="Restore"
                @click="restoreProject(p.id)"
              />
              <UButton
                icon="i-lucide-trash-2"
                size="xs"
                color="error"
                variant="ghost"
                label="Destroy"
                @click="openDestroy(p)"
              />
            </div>
          </div>
        </ArchivedDisclosure>
      </div>
    </template>
  </UDashboardPanel>

  <AppCreateProjectModal v-model:open="createOpen" />

  <UModal
    v-model:open="destroyOpen"
    :title="`Destroy ${destroyTarget?.name ?? 'project'}`"
  >
    <template #body>
      <div class="space-y-3">
        <p class="text-sm">
          This permanently deletes
          <strong>{{ destroyTarget?.name }}</strong> and everything in it —
          sprints, cards, docs, tags and comments. This cannot be undone.
        </p>
        <UFormField
          :label="`Type the slug to confirm: ${destroyTarget?.slug ?? ''}`"
        >
          <UInput
            v-model="destroyConfirm"
            :placeholder="destroyTarget?.slug"
            autocomplete="off"
          />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" label="Cancel" @click="() => { destroyOpen = false }" />
        <UButton
          color="error"
          label="Destroy"
          :disabled="!destroyArmed"
          @click="confirmDestroy"
        />
      </div>
    </template>
  </UModal>
</template>
