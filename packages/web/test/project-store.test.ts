import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'

import type { Project } from '@agents-board/shared'

const globals = globalThis as Record<string, unknown>
globals.ref = ref
globals.computed = computed

const cookie = ref<string | null>('active-project')
let response: Project[] = []
const pendingLoads: Array<Promise<Project[]>> = []
let websocketOptions: {
  onMessage: (
    socket: unknown,
    message: { data: string }
  ) => Promise<void>
} | undefined
let websocketUrl: (() => string | undefined) | undefined

globals.useCookie = () => cookie
globals.useApi = () => async () => {
  const pending = pendingLoads.shift()
  return pending ?? response.map(project => ({ ...project }))
}
globals.useRuntimeConfig = () => ({ public: { apiUrl: 'http://api.test' } })
globals.useWebSocket = (
  url: () => string | undefined,
  options: typeof websocketOptions
) => {
  websocketUrl = url
  websocketOptions = options
}

const { useProjectStore } = await import('../app/stores/project')
const { useProjectIdentityEvents } = await import(
  '../app/composables/useProjectIdentityEvents'
)

function project(id: string, slug: string, name: string): Project {
  return {
    id,
    slug,
    name,
    description: null,
    keyPrefix: id.toUpperCase(),
    nextKeySeq: 1,
    repoProvider: null,
    repoWebUrl: null,
    createdAt: '2026-08-05T12:00:00.000Z',
    updatedAt: '2026-08-05T12:00:00.000Z',
    archivedAt: null
  }
}

function freshStore(initialCookie: string | null = 'active-project') {
  cookie.value = initialCookie
  setActivePinia(createPinia())
  return useProjectStore()
}

describe('project store reconciliation', () => {
  it('keeps selection by stable id across rename, other updates, reload, and removal', async () => {
    const active = project('prj_active', 'active-project', 'Active Project')
    const other = project('prj_other', 'other-project', 'Other Project')
    response = [active, other]
    const store = freshStore()
    useProjectIdentityEvents()
    assert.equal(websocketUrl!(), undefined)
    await store.loadProjects()
    assert.equal(websocketUrl!(), 'ws://api.test/ws/projects')
    assert.equal(store.currentProjectId, active.id)

    response = [
      project(active.id, 'renamed-project', 'Renamed Project'),
      other
    ]
    await websocketOptions!.onMessage({}, {
      data: JSON.stringify({
        type: 'projects.ready'
      })
    })
    assert.equal(store.currentProjectId, active.id)
    assert.equal(store.currentProject?.name, 'Renamed Project')
    assert.equal(store.currentProject?.slug, 'renamed-project')
    assert.equal(cookie.value, 'renamed-project')

    response = [
      project(active.id, 'renamed-project', 'Renamed Project'),
      project(other.id, 'changed-other', 'Changed Other')
    ]
    await websocketOptions!.onMessage({}, {
      data: JSON.stringify({
        type: 'project.changed',
        projectId: other.id
      })
    })
    assert.equal(store.currentProjectId, active.id)
    assert.equal(cookie.value, 'renamed-project')

    let finishStale!: (projects: Project[]) => void
    let finishLatest!: (projects: Project[]) => void
    pendingLoads.push(
      new Promise((resolve) => {
        finishStale = resolve
      }),
      new Promise((resolve) => {
        finishLatest = resolve
      })
    )
    const firstEvent = websocketOptions!.onMessage({}, {
      data: JSON.stringify({
        type: 'project.changed',
        projectId: active.id
      })
    })
    const secondEvent = websocketOptions!.onMessage({}, {
      data: JSON.stringify({
        type: 'project.changed',
        projectId: other.id
      })
    })
    assert.equal(pendingLoads.length, 1)
    finishStale([
      project(active.id, 'stale-project', 'Stale Project'),
      project(other.id, 'changed-other', 'Changed Other')
    ])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(pendingLoads.length, 0)
    finishLatest([
      project(active.id, 'latest-project', 'Latest Project'),
      project(other.id, 'changed-other', 'Changed Other')
    ])
    await Promise.all([firstEvent, secondEvent])
    assert.equal(store.currentProjectId, active.id)
    assert.equal(store.currentProject?.slug, 'latest-project')
    assert.equal(cookie.value, 'latest-project')

    response = [
      project(active.id, 'latest-project', 'Latest Project'),
      project(other.id, 'changed-other', 'Changed Other')
    ]
    let finishLoad!: (projects: Project[]) => void
    pendingLoads.push(
      new Promise((resolve) => {
        finishLoad = resolve
      })
    )
    const reconciling = websocketOptions!.onMessage({}, {
      data: JSON.stringify({
        type: 'project.changed',
        projectId: active.id
      })
    })
    await Promise.resolve()
    assert.equal(websocketUrl!(), 'ws://api.test/ws/projects')
    store.setCurrent('changed-other')
    finishLoad(response)
    await reconciling
    assert.equal(store.currentProjectId, other.id)
    assert.equal(cookie.value, 'changed-other')
    store.setCurrent('latest-project')

    const reloaded = freshStore(cookie.value)
    await reloaded.ensureLoaded()
    assert.equal(reloaded.currentProjectId, active.id)
    assert.equal(reloaded.currentProject?.slug, 'latest-project')

    response = [project(other.id, 'changed-other', 'Changed Other')]
    await reloaded.loadAndRepoint()
    assert.equal(reloaded.currentProjectId, other.id)
    assert.equal(cookie.value, 'changed-other')
  })
})
