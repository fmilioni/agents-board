<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

// Multiple root nodes (dropdown + two teleported modals), so a `class` from the
// parent has no single root to inherit onto — forward attrs to the trigger.
defineOptions({ inheritAttrs: false })

// Kebab menu with Archive (soft-delete) + Destroy (hard-delete), each behind a
// confirmation modal. The parent owns what happens after success (navigate /
// clear selection / reload), so this only performs the API call and emits.
const props = withDefaults(
  defineProps<{
    kind: 'card' | 'sprint' | 'doc'
    entityId: string
    entityLabel: string
    /** How many children get hard-deleted along with this entity (cascade). */
    cascadeCount?: number
    /** Singular noun for the cascade children, e.g. "card", "sub-task". */
    cascadeNoun?: string
    cascadeNounPlural?: string
    size?: 'xs' | 'sm' | 'md'
    /** Show the Archive action — set false for an already-archived entity. */
    canArchive?: boolean
    /** Extra menu groups shown above Archive/Destroy (e.g. move actions). */
    extraSections?: DropdownMenuItem[][]
  }>(),
  { cascadeCount: 0, cascadeNoun: 'item', size: 'sm', canArchive: true }
)

const emit = defineEmits<{ archived: [], destroyed: [] }>()

const api = useApi()

const KIND_LABEL = { card: 'card', sprint: 'sprint', doc: 'doc' } as const
// card → /cards, sprint → /sprints, doc → /docs
const basePath = computed(() => `/${props.kind}s`)

const archiveOpen = ref(false)
const destroyOpen = ref(false)
const archiving = ref(false)
const destroying = ref(false)

const items = computed<DropdownMenuItem[][]>(() => {
  const own: DropdownMenuItem[] = []
  if (props.canArchive) {
    own.push({
      label: 'Archive',
      icon: 'i-lucide-archive',
      onSelect: () => {
        archiveOpen.value = true
      }
    })
  }
  own.push({
    label: 'Destroy',
    icon: 'i-lucide-trash-2',
    color: 'error',
    onSelect: () => {
      destroyOpen.value = true
    }
  })
  return [...(props.extraSections ?? []), own]
})

const cascadeText = computed(() => {
  const n = props.cascadeCount
  if (!n) return ''
  const noun
    = n === 1 ? props.cascadeNoun : (props.cascadeNounPlural ?? `${props.cascadeNoun}s`)
  return ` and ${n} ${noun}`
})

async function confirmArchive() {
  archiving.value = true
  try {
    await api(`${basePath.value}/${props.entityId}/archive`, { method: 'POST' })
    archiveOpen.value = false
    emit('archived')
  } finally {
    archiving.value = false
  }
}

async function confirmDestroy() {
  destroying.value = true
  try {
    await api(`${basePath.value}/${props.entityId}`, { method: 'DELETE' })
    destroyOpen.value = false
    emit('destroyed')
  } finally {
    destroying.value = false
  }
}
</script>

<template>
  <UDropdownMenu :items="items" :modal="false" :content="{ align: 'end' }">
    <UButton
      v-bind="$attrs"
      icon="i-lucide-ellipsis-vertical"
      color="neutral"
      variant="ghost"
      :size="size"
      aria-label="More actions"
    />
  </UDropdownMenu>

  <UModal v-model:open="archiveOpen" :title="`Archive ${KIND_LABEL[kind]}?`">
    <template #body>
      <p class="text-sm text-muted">
        <span class="font-medium text-default">{{ entityLabel }}</span>
        will be hidden from view, but you can restore it later.
      </p>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" label="Cancel" @click="() => { archiveOpen = false }" />
        <UButton
          color="primary"
          icon="i-lucide-archive"
          label="Archive"
          :loading="archiving"
          @click="confirmArchive"
        />
      </div>
    </template>
  </UModal>

  <UModal v-model:open="destroyOpen" :title="`Destroy ${KIND_LABEL[kind]}?`">
    <template #body>
      <p class="text-sm text-muted">
        This will permanently delete
        <span class="font-medium text-default">{{ entityLabel }}</span>{{ cascadeText }}.
        <strong class="text-error">This can't be undone.</strong>
      </p>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" label="Cancel" @click="() => { destroyOpen = false }" />
        <UButton
          color="error"
          icon="i-lucide-trash-2"
          label="Destroy"
          :loading="destroying"
          @click="confirmDestroy"
        />
      </div>
    </template>
  </UModal>
</template>
