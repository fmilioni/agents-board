<script setup lang="ts">
import { VueDraggable } from 'vue-draggable-plus'

import type { Card, CardClaim, CardStatus } from '~/types/card'

// Draggable list of cards with optional story-envelope grouping, shared by the
// board columns and the Tasks Backlog. Owns the drag wiring (reorder emit) and
// the envelope rendering; the consumer keeps the data and may inject per-card
// controls through the `actions` slot (e.g. the Tasks "Move"/archive menus).
const props = withDefaults(
  defineProps<{
    status: CardStatus
    cards: Card[]
    /** Group child cards under their story (envelope), Jira-style. */
    groupByStory?: boolean
    /** parentKey -> story title, for the envelope headers. */
    parentTitles?: Record<string, string>
    /** parentKey -> the story's own claim, for the envelope reservation hint. */
    parentClaims?: Record<string, CardClaim>
    /** Layout of the draggable container; defaults to the board column flow. */
    listClass?: string
  }>(),
  {
    groupByStory: false,
    parentTitles: () => ({}),
    parentClaims: () => ({}),
    listClass: 'flex flex-col p-2 flex-1 overflow-y-auto overflow-x-hidden'
  }
)

const emit = defineEmits<{
  (e: 'reorder', payload: { status: CardStatus, orderedIds: string[], movedId?: string }): void
}>()

// When grouping by story, keep cards of the same story contiguous and order the
// groups (and standalone cards) by position/priority, so a group interleaves
// with loose cards. Otherwise keep the order the parent gave us.
const orderedCards = computed<Card[]>(() => {
  if (!props.groupByStory) return props.cards
  const clusters = new Map<string, Card[]>()
  for (const c of props.cards) {
    const key = c.parentKey ?? `solo:${c.id}`
    const arr = clusters.get(key) ?? []
    arr.push(c)
    clusters.set(key, arr)
  }
  const blocks = [...clusters.values()].map((cs) => {
    const sorted = [...cs].sort(
      (a, b) => a.position - b.position || b.priority - a.priority
    )
    return {
      cs: sorted,
      pos: Math.min(...sorted.map(c => c.position)),
      prio: Math.max(...sorted.map(c => c.priority))
    }
  })
  blocks.sort((a, b) => a.pos - b.pos || b.prio - a.prio)
  return blocks.flatMap(b => b.cs)
})

const localList = ref<Card[]>([])
watch(orderedCards, next => (localList.value = [...next]), {
  immediate: true,
  deep: true
})

const groupKeyOf = (c?: Card) =>
  props.groupByStory ? (c?.parentKey ?? null) : null
const isGroupStart = (i: number) => {
  const k = groupKeyOf(localList.value[i])
  return k !== null && groupKeyOf(localList.value[i - 1]) !== k
}
const isGroupEnd = (i: number) => {
  const k = groupKeyOf(localList.value[i])
  return k !== null && groupKeyOf(localList.value[i + 1]) !== k
}
const inGroup = (c: Card) => props.groupByStory && !!c.parentKey

// Story collapse (board only). Provided by the board page; absent elsewhere, so
// the toggle doesn't render and every group stays expanded (today's behavior).
const collapse = inject(boardCollapseKey, null)
const collapsible = computed(() => props.groupByStory && !!collapse)
const isCollapsed = (parentKey?: string | null) =>
  !!parentKey && !!collapse?.isCollapsed(parentKey)
// A card sits inside a collapsed story → its tile is hidden (the envelope header
// stays, showing the count). Group-start keeps its row for the header; the other
// children hide the whole row.
const inCollapsedGroup = (c: Card) => inGroup(c) && isCollapsed(c.parentKey)
const isHiddenChild = (i: number, c: Card) =>
  inCollapsedGroup(c) && !isGroupStart(i)

const groupSizes = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  for (const c of localList.value) {
    if (c.parentKey) m[c.parentKey] = (m[c.parentKey] ?? 0) + 1
  }
  return m
})

// Reservation hint per story envelope: the story's OWN claim takes precedence
// over a reserved-children count (the parent renders as an envelope, not a tile,
// so its claim has nowhere else to surface). Keyed by parentKey, computed once.
const groupClaimHints = computed<Record<string, string>>(() => {
  const childCounts = new Map<string, number>()
  for (const c of localList.value) {
    if (c.parentKey && c.claim) {
      childCounts.set(c.parentKey, (childCounts.get(c.parentKey) ?? 0) + 1)
    }
  }
  const keys = new Set([
    ...childCounts.keys(),
    ...Object.keys(props.parentClaims)
  ])
  const hints: Record<string, string> = {}
  for (const key of keys) {
    const own = props.parentClaims[key]
    if (own) {
      hints[key] = formatClaimHint(own)
    } else {
      const n = childCounts.get(key) ?? 0
      hints[key] = n ? `${n} reserved subtask${n > 1 ? 's' : ''}` : ''
    }
  }
  return hints
})

// SortableJS has already updated `localList` (v-model) by the time these fire,
// so it reflects the dropped order. `@add` = a card came from another column
// (carries the moved id so the page can apply status/sprint); `@update` = a
// reorder within this list. Either way we hand the page the new order.
function onAdd(event: { data: Card }) {
  emit('reorder', {
    status: props.status,
    orderedIds: localList.value.map(c => c.id),
    movedId: event.data?.id
  })
}
function onUpdate() {
  emit('reorder', {
    status: props.status,
    orderedIds: localList.value.map(c => c.id)
  })
}
</script>

<template>
  <VueDraggable
    v-model="localList"
    :animation="150"
    group="cards"
    ghost-class="opacity-40"
    filter=".co-collapsed-head"
    :prevent-on-filter="false"
    :class="listClass"
    @add="onAdd"
    @update="onUpdate"
  >
    <div
      v-for="(card, i) in localList"
      v-show="!isHiddenChild(i, card)"
      :key="card.id"
      class="cursor-grab active:cursor-grabbing min-w-0 shrink-0"
      :class="[
        i > 0 && (!inGroup(card) || isGroupStart(i)) ? 'mt-2' : '',
        inGroup(card) && 'bg-elevated/40 border-x border-default',
        inGroup(card) && isGroupStart(i) && 'border-t rounded-t-lg',
        inGroup(card) && isGroupEnd(i) && 'border-b rounded-b-lg',
        // A collapsed head is the only visible row of its group, so close the box.
        // `co-collapsed-head` is SortableJS's drag filter: a collapsed group can't
        // be dragged by its head (expand it to reorder) — its hidden children keep
        // their positions, so moving just the head would be ambiguous.
        inGroup(card) && isGroupStart(i) && isCollapsed(card.parentKey)
          && 'border-b rounded-b-lg co-collapsed-head'
      ]"
    >
      <!-- Story envelope: a tinted rail spans the group; the header sits on the
           first child and each inner card keeps a margin, so the children read as
           nested inside the envelope. One model item per draggable. -->
      <div
        v-if="isGroupStart(i)"
        class="flex items-center gap-1.5 px-2.5 pt-2 text-xs"
        :class="isCollapsed(card.parentKey) ? 'pb-2' : 'pb-1'"
      >
        <button
          v-if="collapsible"
          type="button"
          class="flex items-center text-muted hover:text-default shrink-0"
          :aria-label="isCollapsed(card.parentKey) ? 'Expand tasks' : 'Collapse tasks'"
          @click.stop.prevent="collapse?.toggle(card.parentKey!)"
          @mousedown.stop
        >
          <UIcon
            :name="isCollapsed(card.parentKey) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
            class="size-3.5"
          />
        </button>
        <NuxtLink
          :to="`/cards/${card.parentKey}`"
          class="flex items-center gap-1.5 min-w-0 flex-1 hover:underline decoration-primary/40 underline-offset-2"
          @mousedown.stop
        >
          <UIcon name="i-lucide-layers" class="size-3.5 text-primary shrink-0" />
          <span class="font-mono font-bold text-default shrink-0 whitespace-nowrap">{{ card.parentKey }}</span>
          <span class="text-muted truncate min-w-0">{{ parentTitles[card.parentKey ?? ''] ?? '' }}</span>
          <span
            v-if="isCollapsed(card.parentKey)"
            class="text-muted shrink-0 whitespace-nowrap"
          >
            · {{ groupSizes[card.parentKey ?? ''] ?? 0 }}
            {{ (groupSizes[card.parentKey ?? ''] ?? 0) === 1 ? 'task' : 'tasks' }}
          </span>
        </NuxtLink>
        <UTooltip
          v-if="groupClaimHints[card.parentKey ?? '']"
          :text="groupClaimHints[card.parentKey ?? '']"
        >
          <span
            class="flex items-center text-warning shrink-0"
            @mousedown.stop
          >
            <UIcon name="i-lucide-hourglass" class="size-3" />
          </span>
        </UTooltip>
      </div>

      <CardTile
        v-if="!inCollapsedGroup(card)"
        :card="card"
        :show-parent-key="!groupByStory"
        :class="inGroup(card) && 'mx-1.5 mb-1.5'"
      >
        <template v-if="$slots.actions" #actions>
          <slot name="actions" :card="card" />
        </template>
      </CardTile>
    </div>
  </VueDraggable>
</template>
