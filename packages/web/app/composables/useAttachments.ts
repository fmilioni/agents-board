import { useProjectStore } from '~/stores/project'

export function useAttachments() {
  const api = useApi()
  const store = useProjectStore()
  const base = useRuntimeConfig().public.apiUrl

  // The editor only needs the portable `/attachments/att_X` path to insert the
  // image node; the rest of the upload response (id, dims, mime) goes unread.
  async function uploadImage(file: File): Promise<{ url: string }> {
    const projectId = store.currentProject?.id
    if (!projectId) throw new Error('No project selected')
    const form = new FormData()
    form.append('file', file)
    return api<{ url: string }>(`/attachments?projectId=${projectId}`, {
      method: 'POST',
      body: form
    })
  }

  // Stored markdown holds the portable relative path `/attachments/att_X`; the
  // browser needs an absolute, auth-aware src. Mint a serve URL (signed when auth
  // is on, bare path otherwise) and prefix the API origin since web and API are
  // different origins. A src without an attachment id (external image) passes
  // through with no metadata.
  async function resolveDisplay(
    stored: string
  ): Promise<{ url: string, byteSize?: number, width?: number, height?: number }> {
    const id = attachmentIdFrom(stored)
    if (!id) return { url: stored }
    const { url, byteSize, width, height } = await api<{
      url: string
      byteSize?: number
      width?: number
      height?: number
    }>(`/attachments/${id}/url`)
    return { url: `${base}${url}`, byteSize, width, height }
  }

  async function resolveDisplaySrc(stored: string): Promise<string> {
    return (await resolveDisplay(stored)).url
  }

  return { uploadImage, resolveDisplay, resolveDisplaySrc }
}
