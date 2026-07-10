<script setup lang="ts">
import type { AdminUser, UserRole } from '@claude-organizer/shared'

import { useProjectStore } from '~/stores/project'

definePageMeta({ middleware: 'admin' })
useHead({ title: 'Users' })

const api = useApi()
const toast = useToast()
const store = useProjectStore()
const { projects } = storeToRefs(store)
const { user: currentUser } = useAuth()

const users = ref<AdminUser[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    users.value = await api<AdminUser[]>('/admin/users')
  } finally {
    loading.value = false
  }
}
onMounted(load)

const adminCount = computed(
  () => users.value.filter(u => u.role === 'admin').length
)
const isSelf = (u: AdminUser) => currentUser.value?.id === u.id
// The last admin can't be removed (would lock everyone out of the admin surface);
// you can't remove yourself (auto-lockout). The API enforces both too.
const isLastAdmin = (u: AdminUser) => u.role === 'admin' && adminCount.value <= 1

const roleItems = [
  { label: 'User', value: 'user' as UserRole },
  { label: 'Administrator', value: 'admin' as UserRole }
]
const scopeItems = [
  { label: 'All projects (including future ones)', value: 'all' },
  { label: 'Select projects', value: 'subset' }
]

const approving = ref<AdminUser | null>(null)
const role = ref<UserRole>('user')
const scope = ref<'all' | 'subset'>('all')
const selectedProjects = ref<string[]>([])
const saving = ref(false)
const error = ref<string | null>(null)

// Map to {id,name} so USelectMenu doesn't pick up Project.description (nullable,
// which its item type rejects) as the item description.
const projectItems = computed(() =>
  projects.value.map(p => ({ id: p.id, name: p.name }))
)

const showProjectPicker = computed(
  () => role.value === 'user' && scope.value === 'subset'
)

function openApprove(u: AdminUser) {
  approving.value = u
  role.value = 'user'
  scope.value = 'all'
  selectedProjects.value = []
  error.value = null
}

async function confirmApprove() {
  if (!approving.value) return
  saving.value = true
  error.value = null
  try {
    const allProjects = role.value === 'admin' || scope.value === 'all'
    await api(`/admin/users/${approving.value.id}/approve`, {
      method: 'POST',
      body: {
        role: role.value,
        allProjects,
        projectIds: allProjects ? [] : selectedProjects.value
      }
    })
    approving.value = null
    await load()
  } catch (e) {
    error.value = resolveError(e)
  } finally {
    saving.value = false
  }
}

// Both "Reject" (pending) and "Remove" (approved) open this confirm and hit the
// same hard delete — only the row's button label differs.
const removing = ref<AdminUser | null>(null)
const deleting = ref(false)
async function confirmRemove() {
  if (!removing.value) return
  deleting.value = true
  try {
    await api(`/admin/users/${removing.value.id}`, { method: 'DELETE' })
    await load()
    removing.value = null
  } catch (e) {
    toast.add({
      title: 'Failed to remove user',
      description: resolveError(e),
      color: 'error'
    })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="admin-users">
    <template #header>
      <UDashboardNavbar title="Users">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UIcon name="i-lucide-users" class="text-primary" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="max-w-2xl mx-auto w-full space-y-4">
        <p class="text-sm text-muted">
          All users in the system. Approve pending users by setting a role and
          projects; remove an account to revoke access (deletes it for good — the
          person's comments stay but show with no author).
        </p>

        <div
          v-if="!loading && users.length === 0"
          class="text-sm text-muted border border-default rounded-lg p-8 text-center"
        >
          No users.
        </div>

        <ul v-else class="space-y-2">
          <li
            v-for="u in users"
            :key="u.id"
            class="flex items-center gap-3 border border-default rounded-lg p-3"
          >
            <UAvatar :src="u.image ?? undefined" :alt="u.name" size="md" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium truncate">
                {{ u.name }}
              </p>
              <p class="text-xs text-muted truncate">
                {{ u.email }}
              </p>
            </div>

            <div class="flex items-center gap-1.5 shrink-0">
              <UBadge
                v-if="u.role === 'admin'"
                color="primary"
                variant="subtle"
                size="sm"
                label="Administrator"
              />
              <UBadge
                v-if="u.status === 'pending'"
                color="warning"
                variant="subtle"
                size="sm"
                label="Pending"
              />
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <UButton
                v-if="u.status === 'pending'"
                size="sm"
                color="primary"
                variant="subtle"
                label="Approve"
                @click="openApprove(u)"
              />
              <UButton
                v-if="u.status === 'pending'"
                size="sm"
                color="error"
                variant="ghost"
                label="Reject"
                @click="() => { removing = u }"
              />
              <UButton
                v-else-if="!isSelf(u)"
                size="sm"
                color="error"
                variant="ghost"
                label="Remove"
                :disabled="isLastAdmin(u)"
                :title="isLastAdmin(u) ? 'Cannot remove the last administrator' : undefined"
                @click="() => { removing = u }"
              />
            </div>
          </li>
        </ul>
      </div>
    </template>
  </UDashboardPanel>

  <UModal
    :open="approving !== null"
    title="Approve user"
    :description="approving?.email"
    @update:open="(o: boolean) => { if (!o) approving = null }"
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="Role">
          <USelectMenu
            v-model="role"
            :items="roleItems"
            value-key="value"
            label-key="label"
          />
        </UFormField>

        <UFormField v-if="role === 'user'" label="Project access">
          <USelectMenu
            v-model="scope"
            :items="scopeItems"
            value-key="value"
            label-key="label"
          />
        </UFormField>

        <UFormField v-if="showProjectPicker" label="Projects">
          <USelectMenu
            v-model="selectedProjects"
            :items="projectItems"
            multiple
            value-key="id"
            label-key="name"
            placeholder="Select projects"
          />
        </UFormField>

        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          :title="error"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" label="Cancel" @click="() => { approving = null }" />
        <UButton
          color="primary"
          label="Approve"
          :loading="saving"
          :disabled="showProjectPicker && selectedProjects.length === 0"
          @click="confirmApprove"
        />
      </div>
    </template>
  </UModal>

  <UModal
    :open="removing !== null"
    title="Remove user?"
    @update:open="(o: boolean) => { if (!o) removing = null }"
  >
    <template #body>
      <p class="text-sm text-muted">
        The account of
        <span class="font-medium text-default">{{ removing?.name }}</span>
        will be permanently deleted. Any comments they left stay but show with
        no author.
        <strong class="text-error">This can't be undone.</strong>
      </p>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton variant="ghost" label="Cancel" @click="() => { removing = null }" />
        <UButton
          color="error"
          icon="i-lucide-trash-2"
          label="Remove"
          :loading="deleting"
          @click="confirmRemove"
        />
      </div>
    </template>
  </UModal>
</template>
