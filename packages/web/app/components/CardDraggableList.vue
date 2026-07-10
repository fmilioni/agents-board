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

// The complete order (source of truth), synced from the data.
const fullList = ref<Card[]>([])
watch(orderedCards, next => (fullList.value = [...next]), {
  immediate: true,
  deep: true
})

const groupKeyOf = (c?: Card) =>
  props.groupByStory ? (c?.parentKey ?? null) : null

// Story collapse (board only). Provided by the board page; absent elsewhere, so
// the toggle doesn't render and every group stays expanded (today's behavior).
const collapse = inject(boardCollapseKey, null)
const collapsible = computed(() => props.groupByStory && !!collapse)
const isCollapsed = (parentKey?: string | null) =>
  !!parentKey && !!collapse?.isCollapsed(parentKey)

// A collapsed story keeps only its FIRST child in the draggable list (that row
// renders the envelope header, its own tile hidden); the remaining children are
// pulled OUT of the list entirely — not merely hidden — so a drop can never land
// between them. Map: head card id → its hidden siblings, in order, re-glued right
// after the head when the full order is rebuilt on reorder.
const hiddenAfterHead = computed<Map<string, Card[]>>(() => {
  const m = new Map<string, Card[]>()
  if (!collapsible.value) return m
  const headByKey = new Map<string, string>()
  for (const c of fullList.value) {
    const key = c.parentKey
    if (!key || !isCollapsed(key)) continue
    const head = headByKey.get(key)
    if (head === undefined) {
      headByKey.set(key, c.id)
      m.set(c.id, [])
    } else {
      m.get(head)!.push(c)
    }
  }
  return m
})
const hiddenIds = computed(() => {
  const s = new Set<string>()
  for (const kids of hiddenAfterHead.value.values()) {
    for (const c of kids) s.add(c.id)
  }
  return s
})

// The draggable v-model: the full order minus each collapsed story's pulled-out
// children (only the head remains). SortableJS mutates THIS ref on drag; the
// hidden children are spliced back in on reorder, so nothing can drop among them.
const visibleList = ref<Card[]>([])
watch(
  [fullList, hiddenIds],
  () => {
    visibleList.value = fullList.value.filter(c => !hiddenIds.value.has(c.id))
  },
  { immediate: true }
)

const isGroupStart = (i: number) => {
  const k = groupKeyOf(visibleList.value[i])
  return k !== null && groupKeyOf(visibleList.value[i - 1]) !== k
}
const isGroupEnd = (i: number) => {
  const k = groupKeyOf(visibleList.value[i])
  return k !== null && groupKeyOf(visibleList.value[i + 1]) !== k
}
const inGroup = (c: Card) => props.groupByStory && !!c.parentKey
// A collapsed story's head keeps its row (for the envelope header) but hides its
// own CardTile; the header's count stands in for the pulled-out children.
const inCollapsedGroup = (c: Card) => inGroup(c) && isCollapsed(c.parentKey)

// Total children per story, from the FULL list, so a collapsed head's "N tasks"
// count includes the children pulled out of the visible list.
const groupSizes = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  for (const c of fullList.value) {
    if (c.parentKey) m[c.parentKey] = (m[c.parentKey] ?? 0) + 1
  }
  return m
})

// Reservation hint per story envelope: the story's OWN claim takes precedence
// over a reserved-children count (the parent renders as an envelope, not a tile,
// so its claim has nowhere else to surface). Keyed by parentKey, computed once.
const groupClaimHints = computed<Record<string, string>>(() => {
  const childCounts = new Map<string, number>()
  for (const c of fullList.value) {
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

// SortableJS has already updated `visibleList` (v-model) by the time the reorder
// handlers fire. Rebuild the complete order by re-inserting each collapsed head's
// pulled-out children right after it, so the page gets the full order to persist.
function fullOrder(): Card[] {
  const out: Card[] = []
  for (const c of visibleList.value) {
    out.push(c)
    const kids = hiddenAfterHead.value.get(c.id)
    if (kids) out.push(...kids)
  }
  return out
}
function onAdd(event: { data: Card }) {
  emit('reorder', {
    status: props.status,
    orderedIds: fullOrder().map(c => c.id),
    movedId: event.data?.id
  })
}
function onUpdate() {
  emit('reorder', {
    status: props.status,
    orderedIds: fullOrder().map(c => c.id)
  })
}
</script>

<template>
  <VueDraggable
    v-model="visibleList"
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
      v-for="(card, i) in visibleList"
      :key="card.id"
      class="cursor-grab active:cursor-grabbing min-w-0 shrink-0"
      :class="[
        i > 0 && (!inGroup(card) || isGroupStart(i)) ? 'mt-2' : '',
        inGroup(card) && 'bg-elevated/40 border-x border-default',
        inGroup(card) && isGroupStart(i) && 'border-t rounded-t-lg',
        inGroup(card) && isGroupEnd(i) && 'border-b rounded-b-lg',
        // A collapsed head is alone in the visible list (its children are pulled
        // out), so it's already a closed box via group-start+end. `co-collapsed-head`
        // is SortableJS's drag filter: the head itself isn't draggable (expand the
        // story to reorder it).
        inGroup(card) && isGroupStart(i) && isCollapsed(card.parentKey)
          && 'co-collapsed-head'
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
