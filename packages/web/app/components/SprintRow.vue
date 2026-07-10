<script setup lang="ts">
import type { CardStatus } from '~/types/card'
import { cardStatusMeta, cardStatusOrder } from '~/types/card'
import type { Sprint } from '~/types/sprint'

defineProps<{
  sprint: Sprint
  stats: { total: number, counts: Record<CardStatus, number> }
  formatDate: (iso: string | null) => string
}>()

defineEmits<{
  (e: 'start' | 'complete' | 'deactivate' | 'reopen' | 'archived' | 'destroyed'): void
}>()
</script>

<template>
  <div class="border border-default rounded-md p-4 hover:border-primary/40 transition">
    <div class="flex items-start justify-between gap-4 mb-2">
      <NuxtLink
        :to="`/sprints/${sprint.id}`"
        class="min-w-0 flex-1 block hover:underline decoration-primary/40 underline-offset-2"
      >
        <h3 class="font-semibold text-base leading-snug truncate">
          {{ sprint.name }}
        </h3>
        <p v-if="sprint.goal" class="text-sm text-muted mt-0.5 line-clamp-2">
          {{ sprint.goal }}
        </p>
      </NuxtLink>
      <div class="flex items-center gap-1 shrink-0">
        <UButton
          v-if="sprint.status === 'planned'"
          icon="i-lucide-play"
          size="xs"
          color="primary"
          variant="soft"
          label="Start"
          @click="$emit('start')"
        />
        <UButton
          v-if="sprint.status === 'active'"
          icon="i-lucide-pause"
          size="xs"
          color="neutral"
          variant="soft"
          label="Deactivate"
          @click="$emit('deactivate')"
        />
        <UButton
          v-if="sprint.status === 'active'"
          icon="i-lucide-check"
          size="xs"
          color="success"
          variant="soft"
          label="Complete"
          @click="$emit('complete')"
        />
        <UButton
          v-if="sprint.status === 'completed' || sprint.status === 'cancelled'"
          icon="i-lucide-rotate-ccw"
          size="xs"
          color="neutral"
          variant="soft"
          label="Reopen"
          @click="$emit('reopen')"
        />
        <ArchiveDestroyMenu
          kind="sprint"
          :entity-id="sprint.id"
          :entity-label="sprint.name"
          :cascade-count="stats.total"
          cascade-noun="card"
          size="xs"
          @archived="$emit('archived')"
          @destroyed="$emit('destroyed')"
        />
      </div>
    </div>

    <div class="flex items-center gap-2 flex-wrap text-xs">
      <UBadge
        v-for="status in cardStatusOrder"
        :key="status"
        :color="cardStatusMeta[status].color"
        variant="subtle"
        size="xs"
      >
        {{ cardStatusMeta[status].label }}: {{ stats.counts[status] }}
      </UBadge>
      <span class="text-muted">total: {{ stats.total }}</span>
    </div>

    <div
      v-if="sprint.startsAt || sprint.endsAt"
      class="flex items-center gap-3 mt-2 text-xs text-muted/80"
    >
      <span v-if="sprint.startsAt">
        start: {{ formatDate(sprint.startsAt) }}
      </span>
      <span v-if="sprint.endsAt">end: {{ formatDate(sprint.endsAt) }}</span>
    </div>
  </div>
</template>
