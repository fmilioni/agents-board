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
let pendingLoad: Promise<Project[]> | null = null

globals.useCookie = () => cookie
globals.useApi = () => async () =>
  pendingLoad ?? response.map(project => ({ ...project }))

const { useProjectStore } = await import('../app/stores/project')

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
    await store.loadProjects()
    assert.equal(store.currentProjectId, active.id)

    response = [
      project(active.id, 'renamed-project', 'Renamed Project'),
      other
    ]
    await store.loadAndRepoint()
    assert.equal(store.currentProjectId, active.id)
    assert.equal(store.currentProject?.name, 'Renamed Project')
    assert.equal(store.currentProject?.slug, 'renamed-project')
    assert.equal(cookie.value, 'renamed-project')

    response = [
      project(active.id, 'renamed-project', 'Renamed Project'),
      project(other.id, 'changed-other', 'Changed Other')
    ]
    await store.loadAndRepoint()
    assert.equal(store.currentProjectId, active.id)
    assert.equal(cookie.value, 'renamed-project')

    let finishLoad!: (projects: Project[]) => void
    pendingLoad = new Promise((resolve) => {
      finishLoad = resolve
    })
    const reconciling = store.loadAndRepoint()
    store.setCurrent('changed-other')
    finishLoad(response)
    await reconciling
    pendingLoad = null
    assert.equal(store.currentProjectId, other.id)
    assert.equal(cookie.value, 'changed-other')
    store.setCurrent('renamed-project')

    const reloaded = freshStore(cookie.value)
    await reloaded.ensureLoaded()
    assert.equal(reloaded.currentProjectId, active.id)
    assert.equal(reloaded.currentProject?.slug, 'renamed-project')

    response = [project(other.id, 'changed-other', 'Changed Other')]
    await reloaded.loadAndRepoint()
    assert.equal(reloaded.currentProjectId, other.id)
    assert.equal(cookie.value, 'changed-other')
  })
})
