import type { AuthCapabilities, SessionUser } from '@agents-board/shared'

export function useAuth() {
  const api = useApi()
  const user = useState<SessionUser | null>('auth.user', () => null)
  const loaded = useState('auth.loaded', () => false)
  const capabilities = useState<AuthCapabilities | null>(
    'auth.capabilities',
    () => null
  )

  async function fetchSession() {
    user.value = await api<SessionUser | null>('/auth/me')
    loaded.value = true
    return user.value
  }

  // Cached for the app's lifetime; a hard reload resets useState and refetches.
  async function ensureSession() {
    if (!loaded.value) await fetchSession()
    return user.value
  }

  function fetchCapabilities() {
    return api<AuthCapabilities>('/auth/capabilities')
  }

  async function ensureCapabilities() {
    if (!capabilities.value) capabilities.value = await fetchCapabilities()
    return capabilities.value
  }

  const isApproved = computed(() => user.value?.status === 'approved')
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function signUpEmail(input: {
    name: string
    email: string
    password: string
  }) {
    await api('/api/auth/sign-up/email', { method: 'POST', body: input })
    await fetchSession()
  }

  async function signInEmail(input: { email: string, password: string }) {
    await api('/api/auth/sign-in/email', { method: 'POST', body: input })
    await fetchSession()
  }

  // callbackURL is where better-auth lands after GitHub returns; defaults to the
  // app home, but an MCP OAuth flow overrides it with the authorize URL to resume.
  async function signInGithub(callbackURL = `${window.location.origin}/`) {
    const { url } = await api<{ url: string }>('/api/auth/sign-in/social', {
      method: 'POST',
      body: { provider: 'github', callbackURL }
    })
    if (!url) throw new Error('GitHub is unavailable right now')
    window.location.href = url
  }

  async function signOut() {
    // Empty `body` forces Content-Type: application/json — the API's Fastify
    // content-type parser 415s a bodyless POST (defaults to text/plain).
    await api('/api/auth/sign-out', { method: 'POST', body: {} })
    user.value = null
  }

  return {
    user,
    capabilities,
    isApproved,
    isAdmin,
    ensureSession,
    fetchSession,
    fetchCapabilities,
    ensureCapabilities,
    signUpEmail,
    signInEmail,
    signInGithub,
    signOut
  }
}
