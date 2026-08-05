<script setup lang="ts">
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui'

import { useProjectStore } from '~/stores/project'

const store = useProjectStore()
const { projects } = storeToRefs(store)
const { user, isAdmin, capabilities, signOut } = useAuth()
useProjectIdentityEvents()

// Load projects here (not only in the boot plugin): the layout renders only for
// authenticated pages, so by now the session cookie exists and /projects is
// authorized. Idempotent — a no-op if the boot plugin already loaded them.
store.ensureLoaded()

const version = useRuntimeConfig().public.appVersion

// First load follows the OS (preference stays 'system' until an explicit pick);
// @nuxt/ui ships @nuxtjs/color-mode, so the value/preference persist on their own.
const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')
const themeLabel = computed(() => (isDark.value ? 'Light mode' : 'Dark mode'))
const themeIcon = computed(() => (isDark.value ? 'i-lucide-sun' : 'i-lucide-moon'))
function toggleTheme() {
  colorMode.preference = isDark.value ? 'light' : 'dark'
}

// Admin, or sem-auth mode (an open board has no admin to gate). The same gate the
// settings page applies to system actions — here it drives both project creation
// and whether the system-config section is visible at all.
const adminOrOpenMode = computed(
  () => isAdmin.value || !(capabilities.value?.authEnabled ?? true)
)

// First-run onboarding: with no project there's nothing to do, so we force the
// create-project modal (non-dismissable) — but only for someone who can create.
const onboardingOpen = ref(false)
watch(
  [projects, adminOrOpenMode],
  ([list, adminOrOpen]) => {
    onboardingOpen.value = list.length === 0 && adminOrOpen
  },
  { immediate: true }
)

// A scoped user with no accessible projects: nothing to show and nothing to
// create — point them at their admin instead of an empty app.
const noProjectsForUser = computed(
  () => projects.value.length === 0 && !adminOrOpenMode.value
)

function onProjectCreated() {
  navigateTo('/')
}

const projectLinks = computed<NavigationMenuItem[]>(() => [
  { label: 'Home', icon: 'i-lucide-home', to: '/' },
  { label: 'Inbox', icon: 'i-lucide-inbox', to: '/inbox' },
  { label: 'Board', icon: 'i-lucide-kanban', to: '/board' },
  { label: 'Sprints', icon: 'i-lucide-timer', to: '/sprints' },
  { label: 'Tasks', icon: 'i-lucide-list-todo', to: '/tasks' },
  { label: 'Docs', icon: 'i-lucide-book', to: '/docs' }
])

const systemLinks = computed<NavigationMenuItem[]>(() => [
  { label: 'Projects', icon: 'i-lucide-folders', to: '/projects' },
  ...(isAdmin.value
    ? [{ label: 'Users', icon: 'i-lucide-users', to: '/admin/users' }]
    : []),
  { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' },
  // No-auth mode has no user menu, so the theme toggle rides the system menu here
  // (open mode always renders it); logged in, the toggle lives in the user menu.
  ...(!user.value
    ? [{ label: themeLabel.value, icon: themeIcon.value, onSelect: () => toggleTheme() }]
    : [])
])

const accountItems = computed<DropdownMenuItem[][]>(() => [
  [{ label: user.value?.email ?? '', type: 'label' }],
  [{
    label: themeLabel.value,
    icon: themeIcon.value,
    // preventDefault keeps the menu open so you can see the theme flip.
    onSelect: (e: Event) => {
      e.preventDefault()
      toggleTheme()
    }
  }],
  [{ label: 'Log out', icon: 'i-lucide-log-out', onSelect: onLogout }]
])

async function onLogout() {
  await signOut()
  await navigateTo('/login')
}
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar
      collapsible
      resizable
      class="bg-elevated/25"
      :ui="{ footer: 'flex-col items-stretch gap-2 lg:border-t lg:border-default' }"
    >
      <template #header="{ collapsed }">
        <AppProjectSwitcher :collapsed="collapsed" />
      </template>

      <template #default="{ collapsed }">
        <UDashboardSearchButton
          :collapsed="collapsed"
          label="Search cards…"
          class="bg-transparent ring-default"
        />
        <UNavigationMenu
          :items="projectLinks"
          orientation="vertical"
          :collapsed="collapsed"
          tooltip
        />
      </template>

      <template #footer="{ collapsed }">
        <UNavigationMenu
          v-if="adminOrOpenMode"
          :items="systemLinks"
          orientation="vertical"
          :collapsed="collapsed"
          tooltip
        />

        <UDropdownMenu
          v-if="user"
          :items="accountItems"
          :content="{ align: 'center', collisionPadding: 12 }"
          :ui="{ content: collapsed ? 'w-48' : 'w-(--reka-dropdown-menu-trigger-width)' }"
        >
          <UButton
            color="neutral"
            variant="ghost"
            block
            :square="collapsed"
            :avatar="{ src: user.image ?? undefined, alt: user.name, icon: 'i-lucide-user' }"
            :label="collapsed ? undefined : user.name"
            :trailing-icon="collapsed ? undefined : 'i-lucide-chevrons-up-down'"
            class="data-[state=open]:bg-elevated"
            :ui="{ trailingIcon: 'text-dimmed' }"
          />
        </UDropdownMenu>

        <span v-if="!collapsed" class="block w-full text-center text-xs text-muted">v{{ version }}</span>
      </template>
    </UDashboardSidebar>

    <AppSearchModal />

    <div
      v-if="noProjectsForUser"
      class="flex-1 flex items-center justify-center p-8"
    >
      <div class="text-center max-w-sm">
        <UIcon name="i-lucide-folder-lock" class="size-8 text-muted mx-auto" />
        <p class="text-sm font-medium mt-2">
          No projects yet
        </p>
        <p class="text-sm text-muted mt-1">
          You don't have access to any project yet. Ask an administrator to
          grant you access.
        </p>
      </div>
    </div>
    <slot v-else />

    <AppCreateProjectModal
      v-model:open="onboardingOpen"
      :dismissible="false"
      description="Create your first project to get started."
      @created="onProjectCreated"
    />
  </UDashboardGroup>
</template>
