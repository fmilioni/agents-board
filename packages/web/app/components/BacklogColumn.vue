<script setup lang="ts">
import type { Card, CardClaim, CardStatus } from '~/types/card'

// The Tasks Backlog peek. Reuses CardDraggableList so backlog cards group under
// their story envelope exactly like the status columns (CO-414); the list owns
// the drag wiring and the collapse toggle, emitting `reorder`.
defineProps<{
  cards: Card[]
  closable?: boolean
  groupByStory?: boolean
  parentTitles?: Record<string, string>
  parentClaims?: Record<string, CardClaim>
}>()

const emit = defineEmits<{
  (e: 'card-moved-to-backlog', cardId: string): void
  (e: 'close'): void
}>()

function onReorder(p: { status: CardStatus, orderedIds: string[], movedId?: string }) {
  // A movedId means a card was dropped into the backlog from another column —
  // park it (status `backlog`, no sprint) via the page. An internal reorder (no
  // movedId) is visual-only, matching the pre-envelope backlog behavior.
  if (p.movedId) emit('card-moved-to-backlog', p.movedId)
}
</script>

<template>
  <div
    class="flex flex-col bg-elevated/20 rounded-lg border border-dashed border-default overflow-hidden h-full"
    style="flex: 1 1 0; min-width: 200px;"
  >
    <div
      class="flex items-center justify-between px-3 py-2 border-b border-default border-dashed shrink-0"
    >
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-inbox" class="text-muted size-4" />
        <span class="text-sm font-semibold text-muted">Backlog</span>
        <span class="text-xs text-muted">{{ cards.length }}</span>
      </div>
      <UButton
        v-if="closable"
        icon="i-lucide-x"
        size="xs"
        color="neutral"
        variant="ghost"
        @click="emit('close')"
      />
    </div>

    <CardDraggableList
      status="backlog"
      :cards="cards"
      :group-by-story="groupByStory"
      :parent-titles="parentTitles"
      :parent-claims="parentClaims"
      @reorder="onReorder"
    />
  </div>
</template>
