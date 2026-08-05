<script setup lang="ts">
import type { EmbeddingDtype, EmbeddingRuntimeStatus } from '@agents-board/shared'

const api = useApi()
const toast = useToast()

useHead({ title: 'Settings' })

const { isAdmin, capabilities, fetchCapabilities, ensureCapabilities, ensureSession }
  = useAuth()
// Resolve both explicitly rather than leaning on the global middleware's order,
// so `isAdmin` (from the session) is populated when adminOrOpenMode is computed.
onMounted(async () => {
  await Promise.all([ensureCapabilities(), ensureSession()])
  // The GET is admin-only — don't call it for a non-admin (would 403).
  if (adminOrOpenMode.value) await refreshEmbeddingStatus().catch(() => {})
})
const authEnabled = computed(() => capabilities.value?.authEnabled ?? true)
// Admin-only system actions (backup, the auth toggle) are shown to an admin, or
// to anyone while auth is off — an open board has no admin to gate them, and the
// API mirrors this (the gate bypasses in sem-auth mode).
const adminOrOpenMode = computed(() => !authEnabled.value || isAdmin.value)
const togglingAuth = ref(false)
async function toggleAuth(next: boolean) {
  togglingAuth.value = true
  try {
    await api('/admin/settings', {
      method: 'POST',
      body: { authEnabled: next }
    })
    window.location.reload()
  } finally {
    togglingAuth.value = false
  }
}

const keepDiffsOnArchive = computed(
  () => capabilities.value?.keepDiffsOnArchive ?? false
)
const keepAttachmentsOnArchive = computed(
  () => capabilities.value?.keepAttachmentsOnArchive ?? false
)
const includeAttachmentsInBackup = computed(
  () => capabilities.value?.includeAttachmentsInBackup ?? true
)
const togglingDiffs = ref(false)
const togglingImages = ref(false)
const togglingBackup = ref(false)

async function updateSetting(
  body: Record<string, boolean | number>,
  loading: Ref<boolean>,
  failTitle: string
) {
  loading.value = true
  try {
    await api('/admin/settings', { method: 'POST', body })
    capabilities.value = await fetchCapabilities()
  } catch (e) {
    toast.add({ title: failTitle, description: resolveError(e), color: 'error' })
  } finally {
    loading.value = false
  }
}

const archiveFail = 'Failed to update archiving setting'
const toggleKeepDiffs = (next: boolean) =>
  updateSetting({ keepDiffsOnArchive: next }, togglingDiffs, archiveFail)
const toggleKeepImages = (next: boolean) =>
  updateSetting({ keepAttachmentsOnArchive: next }, togglingImages, archiveFail)
const toggleIncludeImages = (next: boolean) =>
  updateSetting(
    { includeAttachmentsInBackup: next },
    togglingBackup,
    'Failed to update backup setting'
  )

const hideLooseDoneEnabled = computed(
  () => capabilities.value?.hideLooseDoneEnabled ?? true
)
const hideLooseDoneAfterDays = computed(
  () => capabilities.value?.hideLooseDoneAfterDays ?? 7
)
const togglingHideLooseDone = ref(false)
const savingHideDays = ref(false)
const boardFail = 'Failed to update board setting'
const toggleHideLooseDone = (next: boolean) =>
  updateSetting({ hideLooseDoneEnabled: next }, togglingHideLooseDone, boardFail)

// Local draft drives the stepper so +/- updates instantly, decoupled from the
// save round-trip (POST + capabilities refetch). Re-syncs if the server value
// changes (reload, another client).
const daysDraft = ref(hideLooseDoneAfterDays.value)
watch(hideLooseDoneAfterDays, (v) => {
  daysDraft.value = v
})
// Debounced so holding the stepper doesn't POST per click. UInputNumber emits
// null when the field is cleared.
const persistHideDays = useDebounceFn((value: number) =>
  updateSetting({ hideLooseDoneAfterDays: value }, savingHideDays, boardFail), 600)
function onHideDaysInput(value: number | null) {
  if (value === null || !Number.isInteger(value) || value < 0) return
  daysDraft.value = value
  if (value !== hideLooseDoneAfterDays.value) persistHideDays(value)
}

const embedding = computed(() => capabilities.value?.embedding ?? null)
const { modelItems: embeddingModelItems, dtypeItems: embeddingDtypeItems }
  = useEmbeddingChoices()
// What the current effective config maps to in the selects (a disabled deployment
// shows as 'none'); used to seed the pickers and to detect a real change.
const currentModelChoice = computed(() =>
  embedding.value ? (embedding.value.enabled ? embedding.value.model : 'none') : null
)
const currentDtype = computed(() => embedding.value?.dtype ?? null)
const selectedModel = ref<string | undefined>(undefined)
const selectedDtype = ref<EmbeddingDtype | undefined>(undefined)
watchEffect(() => {
  if (selectedModel.value === undefined && currentModelChoice.value !== null) {
    selectedModel.value = currentModelChoice.value
  }
  if (selectedDtype.value === undefined && currentDtype.value !== null) {
    selectedDtype.value = currentDtype.value
  }
})

const embeddingStatus = ref<EmbeddingRuntimeStatus | null>(null)
const applyingEmbedding = ref(false)
// Guards the async poll: a refetch resolving after the page unmounts must not
// mutate state (useIntervalFn stops firing on dispose, but an in-flight call
// could still land).
let pollingMounted = true

const embeddingBusy = computed(
  () =>
    embeddingStatus.value?.state === 'reconciling'
    || embeddingStatus.value?.state === 'backfilling'
)
const pendingChange = computed(
  () =>
    (selectedModel.value !== undefined
      && selectedModel.value !== currentModelChoice.value)
    || (selectedDtype.value !== undefined
      && selectedDtype.value !== currentDtype.value)
)
const canApplyEmbedding = computed(
  () => pendingChange.value && !embeddingBusy.value
)

const { pause: stopPolling, resume: startPolling, isActive: polling }
  = useIntervalFn(pollEmbeddingStatus, 1500, { immediate: false })

async function pollEmbeddingStatus() {
  let status: EmbeddingRuntimeStatus
  try {
    status = await api<EmbeddingRuntimeStatus>('/admin/embedding')
  } catch {
    // Transient poll failure: keep the last frame and retry on the next tick,
    // unless the work already finished — stop then so the UI doesn't spin.
    if (!embeddingBusy.value) stopPolling()
    return
  }
  if (!pollingMounted) return
  embeddingStatus.value = status
  if (embeddingBusy.value) return
  stopPolling()
  capabilities.value = await fetchCapabilities()
}

async function refreshEmbeddingStatus() {
  await pollEmbeddingStatus()
  if (pollingMounted && embeddingBusy.value && !polling.value) startPolling()
}

async function applyEmbedding() {
  if (selectedModel.value === undefined && selectedDtype.value === undefined) return
  applyingEmbedding.value = true
  try {
    embeddingStatus.value = await api<EmbeddingRuntimeStatus>('/admin/embedding', {
      method: 'POST',
      body: { model: selectedModel.value, dtype: selectedDtype.value }
    })
    if (embeddingBusy.value) {
      if (!polling.value) startPolling()
    } else {
      capabilities.value = await fetchCapabilities()
    }
  } catch (e) {
    toast.add({
      title: 'Failed to apply embedding model',
      description: resolveError(e),
      color: 'error'
    })
  } finally {
    applyingEmbedding.value = false
  }
}

onUnmounted(() => {
  pollingMounted = false
  stopPolling()
})
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UIcon name="i-lucide-settings" class="text-primary" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="max-w-2xl mx-auto w-full space-y-8">
        <div v-if="adminOrOpenMode">
          <UPageCard
            title="Authentication"
            description="Control who can access the board."
            variant="naked"
            class="mb-4"
          />
          <UPageCard
            variant="subtle"
            :ui="{ container: 'gap-4', wrapper: 'mb-0' }"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium">
                  Require login
                </p>
                <p class="mt-0.5 text-xs text-muted">
                  Require a login to access the board; new users are approved by the admin.
                </p>
              </div>
              <USwitch
                :model-value="authEnabled"
                :loading="togglingAuth"
                class="shrink-0"
                @update:model-value="toggleAuth"
              />
            </div>
          </UPageCard>
        </div>

        <div v-if="adminOrOpenMode">
          <UPageCard
            title="Archiving"
            description="What happens to attached diffs and images when a card or sprint is archived."
            variant="naked"
            class="mb-4"
          />
          <UPageCard
            variant="subtle"
            :ui="{ container: 'gap-4', wrapper: 'mb-0' }"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium">
                  Keep diffs on archive
                </p>
                <p class="mt-0.5 text-xs text-muted">
                  Keep attached diffs when a card or sprint is archived.
                </p>
              </div>
              <USwitch
                :model-value="keepDiffsOnArchive"
                :loading="togglingDiffs"
                class="shrink-0"
                @update:model-value="toggleKeepDiffs"
              />
            </div>
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium">
                  Keep images on archive
                </p>
                <p class="mt-0.5 text-xs text-muted">
                  Keep attached images when a card or sprint is archived.
                </p>
              </div>
              <USwitch
                :model-value="keepAttachmentsOnArchive"
                :loading="togglingImages"
                class="shrink-0"
                @update:model-value="toggleKeepImages"
              />
            </div>
          </UPageCard>
        </div>

        <div v-if="adminOrOpenMode">
          <UPageCard
            title="Backup"
            description="What a backup envelope includes when you export the board."
            variant="naked"
            class="mb-4"
          />
          <UPageCard
            variant="subtle"
            :ui="{ container: 'gap-4', wrapper: 'mb-0' }"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium">
                  Include images in backup
                </p>
                <p class="mt-0.5 text-xs text-muted">
                  Include attached images in a backup envelope.
                </p>
              </div>
              <USwitch
                :model-value="includeAttachmentsInBackup"
                :loading="togglingBackup"
                class="shrink-0"
                @update:model-value="toggleIncludeImages"
              />
            </div>
          </UPageCard>
        </div>

        <div v-if="adminOrOpenMode">
          <UPageCard
            title="Board"
            description="How completed standalone cards behave on the board."
            variant="naked"
            class="mb-4"
          />
          <UPageCard
            variant="subtle"
            :ui="{ container: 'gap-4', wrapper: 'mb-0' }"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium">
                  Auto-hide completed loose cards
                </p>
                <p class="mt-0.5 text-xs text-muted">
                  Hide standalone done cards from the board once they've been completed for a while. They stay active, searchable, and visible to the MCP.
                </p>
              </div>
              <USwitch
                :model-value="hideLooseDoneEnabled"
                :loading="togglingHideLooseDone"
                class="shrink-0"
                @update:model-value="toggleHideLooseDone"
              />
            </div>
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium">
                  Hide after (days)
                </p>
                <p class="mt-0.5 text-xs text-muted">
                  Days a completed card stays on the board before it's hidden (0 = hide immediately).
                </p>
              </div>
              <UInputNumber
                :model-value="daysDraft"
                :min="0"
                :disabled="!hideLooseDoneEnabled"
                class="w-32 shrink-0"
                @update:model-value="onHideDaysInput"
              />
            </div>
          </UPageCard>
        </div>

        <div v-if="adminOrOpenMode">
          <UPageCard
            title="Semantic search"
            description="Choose the embedding model used for semantic search, or turn it off."
            variant="naked"
            class="mb-4"
          />
          <UPageCard
            variant="subtle"
            :ui="{ container: 'gap-4', wrapper: 'mb-0' }"
          >
            <div class="space-y-4">
              <div>
                <p class="text-sm font-medium">
                  Embedding model
                </p>
                <p class="mt-0.5 text-xs text-muted">
                  <template v-if="embedding?.enabled">
                    Current: {{ embedding.model }} · {{ embedding.dim }}d · {{ embedding.dtype }}.
                  </template>
                  <template v-else>
                    Semantic search is off — lexical search only.
                  </template>
                </p>
                <USelectMenu
                  v-model="selectedModel"
                  :items="embeddingModelItems"
                  value-key="value"
                  label-key="label"
                  :disabled="embeddingBusy"
                  class="mt-2 w-full"
                />
              </div>

              <div v-if="selectedModel !== 'none'">
                <p class="text-sm font-medium">
                  Quantization (dtype)
                </p>
                <p class="mt-0.5 text-xs text-muted">
                  Lower precision uses less memory; switching is lazy — existing vectors stay valid, no re-index.
                </p>
                <USelectMenu
                  v-model="selectedDtype"
                  :items="embeddingDtypeItems"
                  value-key="value"
                  label-key="label"
                  :disabled="embeddingBusy"
                  class="mt-2 w-full"
                />
              </div>

              <UAlert
                v-if="pendingChange"
                color="warning"
                variant="soft"
                icon="i-lucide-alert-triangle"
                title="Changing the model can re-index embeddings"
                description="A model with a different dimension drops the existing vectors and rebuilds the index — search stays lexical-only until the backfill finishes."
              />

              <div
                v-if="pendingChange || embeddingStatus"
                class="flex items-center justify-between gap-3"
              >
                <div class="min-w-0 text-xs">
                  <span
                    v-if="embeddingBusy"
                    class="inline-flex items-center gap-1.5 text-muted"
                  >
                    <UIcon name="i-lucide-loader-2" class="animate-spin" />
                    {{ embeddingStatus?.state === "reconciling" ? "Reconciling…" : "Backfilling…" }}
                    ({{ embeddingStatus?.backfill.docs }} docs · {{ embeddingStatus?.backfill.cards }} cards · {{ embeddingStatus?.backfill.comments }} comments)
                  </span>
                  <span
                    v-else-if="embeddingStatus?.state === 'done'"
                    class="inline-flex items-center gap-1.5 text-success"
                  >
                    <UIcon name="i-lucide-check-circle" />
                    Backfilled {{ embeddingStatus.backfill.docs }} docs · {{ embeddingStatus.backfill.cards }} cards · {{ embeddingStatus.backfill.comments }} comments.
                  </span>
                  <span
                    v-else-if="embeddingStatus?.state === 'error'"
                    class="inline-flex items-center gap-1.5 text-error"
                  >
                    <UIcon name="i-lucide-alert-triangle" />
                    {{ embeddingStatus.error }}
                  </span>
                </div>
                <UButton
                  v-if="pendingChange"
                  label="Apply"
                  color="primary"
                  variant="subtle"
                  class="min-w-[120px] justify-center shrink-0"
                  :loading="applyingEmbedding || embeddingBusy"
                  :disabled="!canApplyEmbedding"
                  @click="applyEmbedding"
                />
              </div>
            </div>
          </UPageCard>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
