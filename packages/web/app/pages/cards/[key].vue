<script setup lang="ts">
import { buildCommitUrl, WORKING_TREE_SHA } from '@agents-board/shared'

import type { Card, CardStatus } from '~/types/card'
import { cardStatusMeta, cardStatusSelectOrder } from '~/types/card'
import type { CardCommit } from '~/types/cardCommit'
import type { Comment } from '~/types/comment'
import type { Sprint } from '~/types/sprint'
import type { Tag } from '~/types/tag'
import { diffFileSignatures } from '~/utils/diffFiles'

const route = useRoute()
const router = useRouter()
const api = useApi()
const toast = useToast()
const cardKey = computed(() => String(route.params.key))

useHead({ title: cardKey })

function goBack() {
  router.back()
}

const card = ref<Card | null>(null)
const comments = ref<Comment[]>([])
const commits = ref<CardCommit[]>([])
const sprints = ref<Sprint[]>([])
const allCards = ref<Card[]>([])
const cardLoading = ref(true)
const cardError = ref<unknown>(null)

async function fetchCard(): Promise<Card | null> {
  try {
    return await api<Card>(`/cards/by-key/${cardKey.value}`)
  } catch (err) {
    cardError.value = err
    return null
  }
}

async function fetchComments(cardId: string) {
  return api<Comment[]>(`/cards/${cardId}/comments`, {
    query: { advanceToRead: 'false' }
  })
}

async function fetchCommits(cardId: string) {
  return api<CardCommit[]>(`/cards/${cardId}/commits`)
}

async function fetchSprints(projectId: string) {
  return api<Sprint[]>('/sprints', { query: { projectId } })
}

async function fetchProjectCards(projectId: string) {
  return api<Card[]>('/cards', { query: { projectId } })
}

// Initial load: full state replacement, toggles loading. The editable buffer
// follows the card via useAutoSave's smart-sync (below).
async function loadCard() {
  cardLoading.value = true
  cardError.value = null
  const fresh = await fetchCard()
  card.value = fresh
  if (fresh) {
    [comments.value, commits.value, sprints.value, allCards.value]
      = await Promise.all([
        fetchComments(fresh.id),
        fetchCommits(fresh.id),
        fetchSprints(fresh.projectId),
        fetchProjectCards(fresh.projectId)
      ])
  }
  cardLoading.value = false
}

// Silent refresh: swap in the fresh card without the loading flag; the buffer
// follows via useAutoSave's smart-sync (no mid-edit clobber).
async function refreshCard() {
  const fresh = await fetchCard()
  if (!fresh) return
  card.value = fresh
}

async function refreshComments() {
  if (!card.value) return
  comments.value = await fetchComments(card.value.id)
}

async function refreshCommits() {
  if (!card.value) return
  commits.value = await fetchCommits(card.value.id)
}

useProjectData(() => card.value?.projectId ?? null, loadCard, {
  watch: cardKey,
  onEvent: (event) => {
    if (!card.value) return
    if (
      (event.type === 'card.changed' || event.type === 'card.deleted')
      && event.cardId === card.value.id
    ) {
      refreshCard()
    } else if (
      (event.type === 'comment.added'
        || event.type === 'comment.updated'
        || event.type === 'comment.deleted'
        || event.type === 'comment.read'
        || event.type === 'comment.handled')
      && event.cardId === card.value.id
    ) {
      refreshComments()
    } else if (
      event.type === 'commit.changed'
      && event.cardId === card.value.id
    ) {
      refreshCommits()
    } else if (event.type === 'project.changed') {
      refreshCard()
    }
  }
})

const { editing, saving, justSaved, save } = useAutoSave<
  Card,
  'title' | 'summary' | 'descriptionMd'
>(card, {
  resource: 'cards',
  fields: [
    { key: 'title', mode: 'required' },
    { key: 'summary', mode: 'nullable' },
    'descriptionMd'
  ],
  onSaved: (updated) => {
    card.value = card.value ? { ...card.value, ...updated } : updated
  }
})

const dueDateInput = computed({
  get: () => (card.value?.dueDate ? card.value.dueDate.slice(0, 10) : ''),
  set: (val) => {
    save({ dueDate: val ? new Date(val).toISOString() : null })
  }
})

const statusOptions = cardStatusSelectOrder.map(s => ({
  label: cardStatusMeta[s].label,
  value: s,
  color: cardStatusMeta[s].color
}))

const priorityOptions = Array.from({ length: 11 }, (_, i) => ({
  label: i === 0 ? '0 (none)' : `P${i}`,
  value: i
}))

const sprintOptions = computed(() => {
  const list = sprints.value ?? []
  const currentId = card.value?.sprintId ?? null
  // Only active/planned sprints are assignable. Keep the card's current sprint
  // even if completed/cancelled, so the selector still shows its actual value
  // (without offering finalized sprints as options for other cards).
  const selectable = list.filter(
    s =>
      s.status === 'active' || s.status === 'planned' || s.id === currentId
  )
  return [
    { label: 'None', value: null as string | null },
    ...selectable.map(s => ({
      label: `${s.name}${s.status === 'active' ? ' (active)' : ''}`,
      value: s.id as string | null
    }))
  ]
})

// Story (parent): top-level cards, excluding this one.
const storyOptions = computed(() => {
  const list = allCards.value.filter(
    c => !c.parentId && c.id !== card.value?.id
  )
  return [
    { label: 'None', value: null as string | null },
    ...list.map(c => ({
      label: `${c.key} · ${c.title}`,
      value: c.id as string | null
    }))
  ]
})

// Candidates to become sub-tasks: free cards (no parent, no children), != current.
const subtaskCandidateOptions = computed(() =>
  allCards.value
    .filter(c => c.id !== card.value?.id && !c.parentId && !c.subtaskCount)
    .map(c => ({ value: c.id, label: `${c.key} · ${c.title}` }))
)

async function refreshProjectCards() {
  if (card.value) {
    allCards.value = await fetchProjectCards(card.value.projectId)
  }
}

// Bumped after each add to remount the select, resetting its internal state
// (otherwise it keeps showing the picked id after the card leaves the list).
const subtaskSelectKey = ref(0)
function onAddSubtask(v: string | undefined) {
  subtaskSelectKey.value++
  if (v) addSubtask(v)
}

async function addSubtask(childId: string) {
  if (!card.value) return
  await api(`/cards/${childId}`, {
    method: 'PATCH',
    body: { parentId: card.value.id }
  })
  await Promise.all([refreshCard(), refreshProjectCards()])
}

async function detachSubtask(childId: string) {
  await api(`/cards/${childId}`, { method: 'PATCH', body: { parentId: null } })
  await Promise.all([refreshCard(), refreshProjectCards()])
}

const blockerSelectKey = ref(0)
function onAddBlocker(v: string | undefined) {
  blockerSelectKey.value++
  if (v) addBlocker(v)
}

async function addBlocker(blockerId: string) {
  if (!card.value) return
  await api(`/cards/${card.value.id}/blockers/${blockerId}`, {
    method: 'POST'
  })
  await refreshCard()
}

async function removeBlocker(blockerId: string) {
  if (!card.value) return
  await api(`/cards/${card.value.id}/blockers/${blockerId}`, {
    method: 'DELETE'
  })
  await refreshCard()
}

const blockerCandidateOptions = computed(() => {
  const blockedIds = new Set((card.value?.blockedBy ?? []).map(c => c.id))
  return allCards.value
    .filter(c => c.id !== card.value?.id && !blockedIds.has(c.id))
    .map(c => ({ value: c.id, label: `${c.key} · ${c.title}` }))
})

const newComment = ref('')
const submittingComment = ref(false)

async function submitComment() {
  if (!card.value || !newComment.value.trim()) return
  submittingComment.value = true
  try {
    await api<Comment>(`/cards/${card.value.id}/comments`, {
      method: 'POST',
      body: { author: 'user', bodyMd: newComment.value }
    })
    newComment.value = ''
    await refreshComments()
  } finally {
    submittingComment.value = false
  }
}

const commentToDelete = ref<Comment | null>(null)
const deletingComment = ref(false)
const deleteCommentOpen = computed({
  get: () => commentToDelete.value !== null,
  set: (open) => {
    if (!open) commentToDelete.value = null
  }
})

async function confirmDeleteComment() {
  if (!commentToDelete.value) return
  deletingComment.value = true
  try {
    await api(`/comments/${commentToDelete.value.id}`, { method: 'DELETE' })
    await refreshComments()
    commentToDelete.value = null
  } finally {
    deletingComment.value = false
  }
}

// Inline edit: the pencil swaps a comment's rendered markdown for a textarea
// holding its current bodyMd. The buffer is independent of comments.value, so a
// silent refresh (e.g. real-time) doesn't clobber what's being typed.
const editingCommentId = ref<string | null>(null)
const editingCommentBody = ref('')
const savingCommentEdit = ref(false)

function startEditComment(c: Comment) {
  editingCommentId.value = c.id
  editingCommentBody.value = c.bodyMd
}

function cancelEditComment() {
  editingCommentId.value = null
  editingCommentBody.value = ''
}

async function saveEditComment() {
  const id = editingCommentId.value
  if (!id || !editingCommentBody.value.trim()) return
  savingCommentEdit.value = true
  try {
    await api(`/comments/${id}`, {
      method: 'PATCH',
      body: { bodyMd: editingCommentBody.value }
    })
    await refreshComments()
    cancelEditComment()
  } finally {
    savingCommentEdit.value = false
  }
}

// On failure the source stays untouched, so AppMarkdown re-renders the original
// checkbox state — a failed toggle never leaves the UI inconsistent.
async function toggleCommentTask(id: string, bodyMd: string) {
  try {
    await api(`/comments/${id}`, { method: 'PATCH', body: { bodyMd } })
    await refreshComments()
  } catch (e) {
    toast.add({ title: 'Failed to update comment', description: resolveError(e), color: 'error' })
  }
}

function onTagsChange(tags: Tag[]) {
  if (card.value) card.value = { ...card.value, tags }
}

const meta = computed(() =>
  card.value ? cardStatusMeta[card.value.status] : null
)

function authorLabel(c: Comment) {
  if (c.author === 'ai') return 'Agent'
  return c.authorName ?? 'User'
}

const aiStatusBadge = {
  unread: { label: 'unread by AI', color: 'warning', ring: 'ring-1 ring-warning/60' },
  read: { label: 'read by AI', color: 'neutral', ring: '' },
  handled: { label: 'handled by AI', color: 'success', ring: '' }
} as const

function commentBadge(c: Comment) {
  if (c.author !== 'user') return null
  return aiStatusBadge[c.aiStatus]
}

function commentInitials(name: string | null | undefined) {
  if (!name) return undefined
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase() ?? '')
    .join('')
  return initials || undefined
}

function commentAvatar(c: Comment) {
  if (c.author === 'ai') {
    return {
      icon: 'i-lucide-bot',
      alt: 'Agent',
      ui: { root: 'bg-primary/15 text-primary' }
    }
  }
  const initials = commentInitials(c.authorName)
  return {
    src: c.authorImage ?? undefined,
    text: initials,
    icon: initials ? undefined : 'i-lucide-user',
    alt: c.authorName ?? undefined,
    ui: { root: 'bg-warning/15 text-warning' }
  }
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleString()
}

// Each commit's diff starts collapsed; clicking the header toggles it.
const expandedCommits = ref(new Set<string>())
function toggleCommit(id: string) {
  const next = new Set(expandedCommits.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedCommits.value = next
}
function shortSha(sha: string) {
  return sha.slice(0, 8)
}
// The pending working-tree diff rides on `card_commits` under a sentinel sha
// (CO-136); it shows as "uncommitted" until the real commit replaces it.
function isWorking(sha: string) {
  return sha === WORKING_TREE_SHA
}
function commitSubject(message: string) {
  return message.split('\n', 1)[0] ?? ''
}
// Parse the last line of `git --stat` ("N files changed, X insertions(+), Y
// deletions(-)") into counts for the GitHub-style badges on the collapsed row.
function parseStat(stat: string | null) {
  const lines = (stat ?? '').trim().split('\n')
  const last = lines[lines.length - 1] ?? ''
  const num = (re: RegExp) => Number(last.match(re)?.[1] ?? 0)
  return {
    files: num(/(\d+) files? changed/),
    additions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/)
  }
}
const commitStats = computed(() =>
  Object.fromEntries(commits.value.map(c => [c.id, parseStat(c.stat)]))
)

const { countViewed } = useViewedFiles()
const commitFiles = computed(() =>
  Object.fromEntries(
    commits.value.map(c => [c.id, diffFileSignatures(c.diff ?? '')])
  )
)
function viewedCount(c: CardCommit) {
  return card.value
    ? countViewed(card.value.id, c.sha, commitFiles.value[c.id] ?? [])
    : 0
}

const projectStore = useProjectStore()
const cardProject = computed(
  () => projectStore.projects.find(p => p.id === card.value?.projectId) ?? null
)
// The hash links to the provider's commit page when the project has a repo
// configured (the skill sets it); buildCommitUrl returns null otherwise.
function commitUrl(sha: string) {
  return buildCommitUrl(
    cardProject.value?.repoProvider ?? null,
    cardProject.value?.repoWebUrl ?? null,
    sha
  )
}
// mdi glyph for the configured provider — monochrome (currentColor), so it
// follows the link color and stays visible in dark mode.
const providerIcon = computed(() =>
  cardProject.value?.repoProvider === 'gitlab'
    ? 'i-mdi-gitlab'
    : 'i-mdi-github'
)
</script>

<template>
  <UDashboardPanel id="card-detail">
    <template #header>
      <UDashboardNavbar :title="card?.key ?? cardKey">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            @click="goBack"
          />
        </template>
        <template v-if="card" #title>
          <div class="flex items-center gap-1.5 min-w-0 font-mono">
            <NuxtLink
              v-if="card.parent"
              :to="`/cards/${card.parent.key}`"
              class="shrink-0 text-muted hover:text-default transition"
              :title="card.parent.title"
            >
              {{ card.parent.key }}
            </NuxtLink>
            <span v-if="card.parent" class="shrink-0 text-muted">/</span>
            <span class="truncate font-bold">{{ card.key }}</span>
          </div>
        </template>
        <template #right>
          <UBadge v-if="meta" :color="meta.color" variant="subtle">
            {{ meta.label }}
          </UBadge>
          <span
            v-if="saving"
            class="text-xs text-muted ml-2 flex items-center gap-1"
          >
            <UIcon name="i-lucide-loader-2" class="animate-spin" /> Saving…
          </span>
          <span
            v-else-if="justSaved"
            class="text-xs text-muted ml-2 flex items-center gap-1 transition-opacity"
          >
            <UIcon name="i-lucide-check" /> Saved
          </span>
          <ArchiveDestroyMenu
            v-if="card"
            kind="card"
            :entity-id="card.id"
            :entity-label="card.key"
            :cascade-count="card.subtasks?.length ?? 0"
            cascade-noun="sub-task"
            class="ml-1"
            @archived="goBack"
            @destroyed="goBack"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="cardLoading" class="text-muted py-12 text-center">
        Loading…
      </div>
      <div v-else-if="cardError" class="text-error py-12 text-center">
        Error loading card.
      </div>
      <div v-else-if="!card" class="text-muted py-12 text-center">
        Card <strong>{{ cardKey }}</strong> not found.
      </div>

      <div
        v-else
        class="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 max-w-6xl mx-auto w-full"
      >
        <main class="space-y-6 min-w-0">
          <section>
            <div class="flex items-baseline gap-2">
              <span class="font-mono font-bold text-default text-lg">
                {{ card.key }}
              </span>
              <InlineEditable
                :key="cardKey"
                v-model="editing.title"
                type="text"
                size="lg"
                class="flex-1"
                input-class="[&_input]:!text-lg [&_input]:!font-semibold"
                preview-class="text-lg font-semibold"
                placeholder="Untitled"
              />
            </div>
          </section>

          <section>
            <label class="text-xs font-semibold text-muted uppercase tracking-wide block mb-1.5">
              Summary
            </label>
            <InlineEditable
              :key="cardKey"
              v-model="editing.summary"
              type="multiline"
              :rows="2"
              bordered
              preview-class="text-sm"
              placeholder="No summary. Click to edit."
              editor-placeholder="One-sentence summary that appears in the board preview"
            />
          </section>

          <section>
            <label class="text-xs font-semibold text-muted uppercase tracking-wide block mb-1.5">
              Description
            </label>
            <InlineEditable
              :key="cardKey"
              v-model="editing.descriptionMd"
              type="markdown"
              bordered
              interactive
              min-height="200px"
              placeholder="No description. Click to edit."
              editor-placeholder="Write a description… (markdown supported)"
            />
          </section>

          <section v-if="commits.length">
            <h2 class="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
              Changes
              <span class="text-default ml-1">({{ commits.length }})</span>
            </h2>
            <ul class="space-y-2">
              <li
                v-for="c in commits"
                :key="c.id"
                class="border border-default rounded-md"
              >
                <div
                  role="button"
                  tabindex="0"
                  class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-elevated/50 transition cursor-pointer rounded-t-md"
                  :class="{ 'rounded-b-md': !expandedCommits.has(c.id) }"
                  @click="toggleCommit(c.id)"
                  @keydown.enter.prevent="toggleCommit(c.id)"
                  @keydown.space.prevent="toggleCommit(c.id)"
                >
                  <UIcon
                    :name="expandedCommits.has(c.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                    class="shrink-0 text-muted"
                  />
                  <UBadge
                    v-if="isWorking(c.sha)"
                    color="warning"
                    variant="subtle"
                    size="sm"
                    label="uncommitted"
                    class="shrink-0"
                  />
                  <a
                    v-else-if="commitUrl(c.sha)"
                    :href="commitUrl(c.sha)!"
                    target="_blank"
                    rel="noopener"
                    class="font-mono text-xs font-semibold text-primary shrink-0 inline-flex items-center gap-1 hover:underline"
                    :title="`Open commit on ${cardProject?.repoProvider}`"
                    @click.stop
                  >
                    {{ shortSha(c.sha) }}
                    <UIcon :name="providerIcon" class="size-3.5" />
                  </a>
                  <span
                    v-else
                    class="font-mono text-xs font-semibold text-primary shrink-0"
                  >{{ shortSha(c.sha) }}</span>
                  <span class="min-w-0 flex-1 truncate text-sm">
                    {{ commitSubject(c.message) }}
                  </span>
                  <span class="hidden sm:flex items-center gap-1.5 shrink-0 font-mono text-xs">
                    <span
                      v-if="commitFiles[c.id]?.length"
                      class="text-muted/70"
                    >
                      {{ viewedCount(c) }} of {{ commitFiles[c.id]?.length }} {{ commitFiles[c.id]?.length === 1 ? "file" : "files" }} viewed
                    </span>
                    <span v-else-if="commitStats[c.id]?.files" class="text-muted/70">
                      {{ commitStats[c.id]?.files }} {{ commitStats[c.id]?.files === 1 ? "file" : "files" }}
                    </span>
                    <span
                      v-if="commitStats[c.id]?.additions"
                      class="text-success bg-success/10 rounded px-1"
                    >+{{ commitStats[c.id]?.additions }}</span>
                    <span
                      v-if="commitStats[c.id]?.deletions"
                      class="text-error bg-error/10 rounded px-1"
                    >-{{ commitStats[c.id]?.deletions }}</span>
                  </span>
                  <span
                    v-if="c.committedAt"
                    class="text-xs text-muted/70 shrink-0"
                  >
                    {{ formatDate(c.committedAt) }}
                  </span>
                </div>
                <div
                  v-if="expandedCommits.has(c.id)"
                  class="border-t border-default p-3"
                >
                  <DiffView
                    v-if="c.diff"
                    :diff="c.diff"
                    :card-id="card.id"
                    :sha="c.sha"
                  />
                  <p v-else-if="isWorking(c.sha)" class="text-xs text-muted italic">
                    Working-tree diff not stored. Re-run attach-worktree-diff to
                    see the uncommitted changes.
                  </p>
                  <p v-else class="text-xs text-muted italic">
                    Diff not stored (cleared when the card or sprint was archived).
                    {{ commitUrl(c.sha) ? "Open it on the provider via the hash above" : "Re-run attach-commit" }} to see the changes.
                  </p>
                </div>
              </li>
            </ul>
          </section>

          <section v-if="!card.parentId">
            <h2 class="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
              Sub-tasks
              <span v-if="card.subtasks?.length" class="text-default ml-1">
                ({{ card.subtasks.filter((s) => s.status === "done").length }}/{{
                  card.subtasks.length
                }})
              </span>
            </h2>
            <ul v-if="card.subtasks?.length" class="space-y-1.5 mb-3">
              <li
                v-for="s in card.subtasks"
                :key="s.id"
                class="flex items-center gap-2 border border-default rounded-md px-2.5 py-1.5"
              >
                <UBadge
                  :color="cardStatusMeta[s.status].color"
                  variant="subtle"
                  size="xs"
                  class="shrink-0"
                >
                  {{ cardStatusMeta[s.status].label }}
                </UBadge>
                <NuxtLink
                  :to="`/cards/${s.key}`"
                  class="min-w-0 flex-1 truncate text-sm hover:underline"
                >
                  <span class="font-mono font-bold mr-1.5">{{ s.key }}</span>{{ s.title }}
                </NuxtLink>
                <div v-if="s.tags.length" class="flex items-center gap-1 shrink-0">
                  <TagBadge
                    v-for="t in s.tags"
                    :key="t.id"
                    :tag="t"
                    size="xs"
                  />
                </div>
                <UButton
                  icon="i-lucide-x"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  class="shrink-0"
                  aria-label="Detach sub-task"
                  @click="detachSubtask(s.id)"
                />
              </li>
            </ul>
            <USelectMenu
              :key="subtaskSelectKey"
              :items="subtaskCandidateOptions"
              :model-value="undefined"
              value-key="value"
              label-key="label"
              placeholder="+ Add card as sub-task"
              :search-input="{ placeholder: 'Search cards…' }"
              icon="i-lucide-plus"
              class="w-full"
              @update:model-value="onAddSubtask"
            />
          </section>

          <section>
            <h2 class="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
              Blocked by
              <span v-if="card.blockedBy?.length" class="text-default ml-1">
                ({{ card.blockedBy.length }})
              </span>
            </h2>
            <ul v-if="card.blockedBy?.length" class="space-y-1.5 mb-3">
              <li
                v-for="b in card.blockedBy"
                :key="b.id"
                class="flex items-center gap-2 border border-default rounded-md px-2.5 py-1.5"
              >
                <UBadge
                  :color="cardStatusMeta[b.status].color"
                  variant="subtle"
                  size="xs"
                  class="shrink-0"
                >
                  {{ cardStatusMeta[b.status].label }}
                </UBadge>
                <NuxtLink
                  :to="`/cards/${b.key}`"
                  class="min-w-0 flex-1 truncate text-sm hover:underline"
                >
                  <span class="font-mono font-bold mr-1.5">{{ b.key }}</span>{{ b.title }}
                </NuxtLink>
                <UButton
                  icon="i-lucide-x"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  class="shrink-0"
                  aria-label="Remove blocker"
                  @click="removeBlocker(b.id)"
                />
              </li>
            </ul>
            <USelectMenu
              :key="blockerSelectKey"
              :items="blockerCandidateOptions"
              :model-value="undefined"
              value-key="value"
              label-key="label"
              placeholder="+ Mark as blocked by…"
              :search-input="{ placeholder: 'Search cards…' }"
              icon="i-lucide-ban"
              class="w-full"
              @update:model-value="onAddBlocker"
            />
          </section>

          <section v-if="card.blocking?.length">
            <h2 class="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
              Blocking
              <span class="text-default ml-1">({{ card.blocking.length }})</span>
            </h2>
            <ul class="space-y-1.5">
              <li
                v-for="b in card.blocking"
                :key="b.id"
                class="flex items-center gap-2 border border-default rounded-md px-2.5 py-1.5"
              >
                <UBadge
                  :color="cardStatusMeta[b.status].color"
                  variant="subtle"
                  size="xs"
                  class="shrink-0"
                >
                  {{ cardStatusMeta[b.status].label }}
                </UBadge>
                <NuxtLink
                  :to="`/cards/${b.key}`"
                  class="min-w-0 flex-1 truncate text-sm hover:underline"
                >
                  <span class="font-mono font-bold mr-1.5">{{ b.key }}</span>{{ b.title }}
                </NuxtLink>
              </li>
            </ul>
          </section>

          <section>
            <h2 class="text-xs font-semibold text-muted uppercase tracking-wide mb-3">
              Comments
              <span class="text-default ml-1">({{ comments?.length ?? 0 }})</span>
            </h2>

            <div v-if="!comments?.length" class="text-sm text-muted/60 italic py-4">
              No comments yet.
            </div>

            <ul v-else class="space-y-3">
              <li
                v-for="c in comments"
                :key="c.id"
                class="border border-default rounded-md p-3"
                :class="commentBadge(c)?.ring"
              >
                <div class="flex items-center justify-between gap-2 mb-1.5">
                  <div class="flex items-center gap-2">
                    <UAvatar v-bind="commentAvatar(c)" size="xs" />
                    <span class="text-sm font-medium">{{ authorLabel(c) }}</span>
                    <UBadge
                      v-if="commentBadge(c)"
                      size="xs"
                      :color="commentBadge(c)!.color"
                      variant="subtle"
                    >
                      {{ commentBadge(c)!.label }}
                    </UBadge>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <span class="text-xs text-muted/70">{{ formatDate(c.createdAt) }}</span>
                    <UButton
                      v-if="editingCommentId !== c.id"
                      icon="i-lucide-pencil"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      aria-label="Edit comment"
                      @click="startEditComment(c)"
                    />
                    <UButton
                      v-if="editingCommentId !== c.id"
                      icon="i-lucide-trash-2"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      aria-label="Remove comment"
                      @click="() => { commentToDelete = c }"
                    />
                  </div>
                </div>
                <div v-if="editingCommentId === c.id" class="space-y-2">
                  <MarkdownEditor
                    v-model="editingCommentBody"
                    autofocus
                    placeholder="Edit the comment… (markdown supported)"
                  />
                  <div class="flex justify-end gap-2">
                    <UButton
                      size="xs"
                      variant="ghost"
                      label="Cancel"
                      :disabled="savingCommentEdit"
                      @click="cancelEditComment"
                    />
                    <UButton
                      size="xs"
                      color="primary"
                      label="Save"
                      icon="i-lucide-check"
                      :loading="savingCommentEdit"
                      :disabled="!editingCommentBody.trim()"
                      @click="saveEditComment"
                    />
                  </div>
                </div>
                <AppMarkdown
                  v-else
                  :value="c.bodyMd"
                  :class="PROSE"
                  interactive
                  @update:value="(v) => toggleCommentTask(c.id, v)"
                />
              </li>
            </ul>

            <form class="mt-4 space-y-2" @submit.prevent="submitComment">
              <MarkdownEditor
                v-model="newComment"
                placeholder="Write a comment for Agent… (markdown supported)"
              />
              <div class="flex justify-end">
                <UButton
                  type="submit"
                  color="primary"
                  :loading="submittingComment"
                  :disabled="!newComment.trim()"
                  icon="i-lucide-send"
                  label="Send"
                />
              </div>
            </form>
          </section>
        </main>

        <aside class="space-y-4">
          <div class="border border-default rounded-md p-3 space-y-3">
            <div>
              <label class="text-xs font-semibold text-muted uppercase tracking-wide block mb-1.5">
                Status
              </label>
              <USelectMenu
                :model-value="card.status"
                :items="statusOptions"
                value-key="value"
                class="w-full"
                @update:model-value="(v: CardStatus) => save({ status: v })"
              />
            </div>

            <div>
              <label class="text-xs font-semibold text-muted uppercase tracking-wide block mb-1.5">
                Priority
              </label>
              <USelectMenu
                :model-value="card.priority"
                :items="priorityOptions"
                value-key="value"
                class="w-full"
                @update:model-value="(v: number) => save({ priority: v })"
              />
            </div>

            <div>
              <label class="text-xs font-semibold text-muted uppercase tracking-wide block mb-1.5">
                Sprint
              </label>
              <USelectMenu
                :model-value="card.sprintId"
                :items="sprintOptions"
                value-key="value"
                class="w-full"
                @update:model-value="(v: string | null) => save({ sprintId: v })"
              />
            </div>

            <div v-if="!card.subtasks?.length">
              <label class="text-xs font-semibold text-muted uppercase tracking-wide block mb-1.5">
                Story
              </label>
              <USelectMenu
                :model-value="card.parentId ?? null"
                :items="storyOptions"
                value-key="value"
                class="w-full"
                @update:model-value="(v: string | null) => save({ parentId: v })"
              />
            </div>

            <div>
              <label class="text-xs font-semibold text-muted uppercase tracking-wide block mb-1.5">
                Due date
              </label>
              <UInput
                v-model="dueDateInput"
                type="date"
                class="w-full"
              />
            </div>

            <div>
              <label class="text-xs font-semibold text-muted uppercase tracking-wide block mb-1.5">
                Tags
              </label>
              <TagSelector
                :card-id="card.id"
                :project-id="card.projectId"
                :model-value="card.tags ?? []"
                @update:model-value="onTagsChange"
              />
            </div>
          </div>

          <div class="border border-default rounded-md p-3 text-xs text-muted space-y-1">
            <div v-if="card.claim" class="flex items-center gap-1.5 text-warning">
              <UIcon name="i-lucide-hourglass" class="size-3.5 shrink-0" />
              <span>{{ formatClaimHint(card.claim) }}</span>
            </div>
            <div>
              <span class="font-semibold">Created</span>: {{ formatDate(card.createdAt) }}
            </div>
            <div>
              <span class="font-semibold">Updated</span>: {{ formatDate(card.updatedAt) }}
            </div>
            <div v-if="card.doneAt">
              <span class="font-semibold">Completed</span>: {{ formatDate(card.doneAt) }}
            </div>
            <div class="font-mono break-all">
              <span class="font-semibold font-sans">ID</span>: {{ card.id }}
            </div>
          </div>
        </aside>
      </div>
    </template>
  </UDashboardPanel>

  <UModal v-model:open="deleteCommentOpen" title="Remove comment">
    <template #body>
      <p class="text-sm text-muted">
        This action can't be undone. The comment will be permanently removed.
      </p>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          variant="ghost"
          label="Cancel"
          @click="() => { commentToDelete = null }"
        />
        <UButton
          color="error"
          label="Remove"
          :loading="deletingComment"
          @click="confirmDeleteComment"
        />
      </div>
    </template>
  </UModal>
</template>
