import { defineStore } from 'pinia'

import type { Project } from '@agents-board/shared'

const CURRENT_PROJECT_COOKIE = 'agents-board.currentProjectSlug'

export const useProjectStore = defineStore('project', () => {
  const projects = ref<Project[]>([])
  const loading = ref(true)
  const currentSlug = useCookie<string | null>(CURRENT_PROJECT_COOKIE, {
    default: () => null,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365
  })

  const currentProject = computed<Project | null>(() => {
    if (!currentSlug.value) return projects.value[0] ?? null
    return projects.value.find(p => p.slug === currentSlug.value) ?? null
  })

  const currentProjectId = computed(() => currentProject.value?.id ?? null)

  async function loadProjects() {
    const api = useApi()
    loading.value = true
    try {
      projects.value = await api<Project[]>('/projects')
    } catch {
      // Not authenticated yet (401 before login) or the API is unreachable:
      // leave the list empty instead of throwing, so app boot / the login
      // screen isn't broken. The layout reloads projects once the user is in.
      projects.value = []
    } finally {
      loading.value = false
    }
  }

  function setCurrent(slug: string) {
    if (projects.value.some(p => p.slug === slug)) {
      currentSlug.value = slug
    }
  }

  async function loadAndRepoint() {
    const selectedId = currentProjectId.value
    const selectedSlug = currentSlug.value
    await loadProjects()
    if (currentSlug.value !== selectedSlug) return
    const selected = projects.value.find(project => project.id === selectedId)
    if (selected) {
      currentSlug.value = selected.slug
      return
    }
    if (!currentProject.value && projects.value[0]) {
      setCurrent(projects.value[0].slug)
    }
  }

  async function ensureLoaded() {
    if (projects.value.length === 0) {
      await loadProjects()
    }
  }

  return {
    projects,
    loading,
    currentProject,
    currentProjectId,
    currentSlug,
    loadProjects,
    setCurrent,
    loadAndRepoint,
    ensureLoaded
  }
})
