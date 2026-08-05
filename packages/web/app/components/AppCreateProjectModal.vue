<script setup lang="ts">
import type { Project } from '@agents-board/shared'

import { useProjectStore } from '~/stores/project'

// Reusable "create project" modal. The parent controls visibility via
// v-model:open; on success it reloads projects, selects the new one and emits
// `created` so the parent can react (e.g. navigate home after onboarding).
const open = defineModel<boolean>('open', { default: false })

// `dismissible: false` turns this into a forced first-run modal (no overlay/Esc
// close, no X, no Cancel) — used by onboarding when there's no project yet.
withDefaults(
  defineProps<{
    dismissible?: boolean
    description?: string
  }>(),
  { dismissible: true, description: '' }
)

const emit = defineEmits<{ created: [project: Project] }>()

const store = useProjectStore()
const api = useApi()

const form = reactive({
  name: '',
  slug: '',
  description: '',
  keyPrefix: ''
})

function derivePrefixFromSlug(slug: string): string {
  const words = slug.toLowerCase().split(/[-_\s]+/).filter(Boolean)
  let prefix = ''
  if (words.length === 0) return ''
  if (words.length === 1) {
    prefix = (words[0] ?? '').replace(/[^a-z0-9]/g, '').slice(0, 4)
  } else {
    prefix = words
      .slice(0, 4)
      .map(w => w.replace(/[^a-z0-9]/g, '').charAt(0))
      .filter(Boolean)
      .join('')
  }
  return prefix.toUpperCase()
}

watch(
  () => form.slug,
  (newSlug, oldSlug) => {
    const previousAuto = derivePrefixFromSlug(oldSlug ?? '')
    if (!form.keyPrefix || form.keyPrefix === previousAuto) {
      form.keyPrefix = derivePrefixFromSlug(newSlug)
    }
  }
)

function reset() {
  form.name = ''
  form.slug = ''
  form.description = ''
  form.keyPrefix = ''
}

async function submit() {
  const body: Record<string, string> = {
    name: form.name,
    slug: form.slug
  }
  if (form.description) body.description = form.description
  if (form.keyPrefix) body.keyPrefix = form.keyPrefix
  const project = await api<Project>('/projects', { method: 'POST', body })
  await store.loadProjects()
  store.setCurrent(project.slug)
  open.value = false
  reset()
  emit('created', project)
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Create project"
    :description="description || undefined"
    :dismissible="dismissible"
    :close="dismissible"
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="Name">
          <UInput v-model="form.name" />
        </UFormField>
        <UFormField label="Slug" hint="lowercase, hyphens">
          <UInput v-model="form.slug" />
        </UFormField>
        <UFormField
          label="Key prefix"
          hint="Used in card keys (e.g. AB-1)"
        >
          <UInput v-model="form.keyPrefix" placeholder="AB" />
        </UFormField>
        <UFormField label="Description">
          <UTextarea v-model="form.description" :rows="3" />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          v-if="dismissible"
          variant="ghost"
          label="Cancel"
          @click="() => { open = false }"
        />
        <UButton
          color="primary"
          icon="i-lucide-plus"
          label="Create"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
