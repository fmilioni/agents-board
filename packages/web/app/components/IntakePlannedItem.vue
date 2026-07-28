<script setup lang="ts">
import type { IntakeItem } from '~/types/intake'

const props = defineProps<{ item: IntakeItem }>()
defineEmits<{ archive: [], destroy: [] }>()

const keys = computed(() => formatIntakeKeys(props.item.plannedCardKeys))
</script>

<template>
  <div class="group relative rounded-md border border-default px-3 py-2">
    <div class="space-y-1.5 pr-14">
      <AppMarkdown :value="item.bodyMd" :class="PROSE" />
      <div class="flex items-center gap-1.5 text-xs text-muted">
        <UBadge
          :color="item.completed ? 'neutral' : 'success'"
          variant="subtle"
          size="sm"
          :label="item.completed ? 'Completed' : 'Planned'"
        />
        <span>→</span>
        <AppMarkdown :value="keys" />
      </div>
    </div>
    <div
      class="absolute top-2 right-2 flex items-center gap-0.5 rounded-md bg-default/80 backdrop-blur-sm opacity-0 transition group-hover:opacity-100 focus-within:opacity-100"
    >
      <UButton
        icon="i-lucide-archive"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="Archive"
        @click="$emit('archive')"
      />
      <UButton
        icon="i-lucide-trash-2"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="Destroy"
        @click="$emit('destroy')"
      />
    </div>
  </div>
</template>
