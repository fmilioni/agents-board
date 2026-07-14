// Shared by the preview (AppMarkdown) and the editor (MarkdownEditor's image node
// view): both hold the portable relative `/attachments/att_X` and both need the
// absolute, auth-aware (signed) src the browser can actually load.

// `gone` (bytes reclaimed, 410) and `missing` (row gone, 404) get a placeholder;
// `unresolved` is transient (network, minting failed), so the image is left alone
// rather than mislabeled as deleted.
export type AttachmentImageResolution
  = | { status: 'ok', url: string }
    | { status: 'gone' | 'missing' }
    | { status: 'unresolved' }

const ATTACHMENT_ID = /att_[0-9a-z]{12}/

/** The attachment this src points at, or `null` when it's an external image. */
export function attachmentIdFrom(stored: string): string | null {
  return ATTACHMENT_ID.exec(stored)?.[0] ?? null
}

/**
 * Resolve a stored attachment src for display. A failed `<img>` load hides the HTTP
 * status, so the serve URL is probed with a HEAD (Fastify answers the GET route's HEAD
 * with the same status and no body, so the bytes still load only once, via the `<img>`).
 */
export async function resolveAttachmentImage(
  stored: string,
  resolveDisplaySrc: (stored: string) => Promise<string>
): Promise<AttachmentImageResolution> {
  // An external image is nobody's attachment: there's nothing to mint, and probing it
  // cross-origin would only fail CORS (and leak credentials) — hand it over untouched.
  if (!attachmentIdFrom(stored)) return { status: 'ok', url: stored }
  let url: string
  try {
    url = await resolveDisplaySrc(stored)
  } catch (err) {
    // The url-minting endpoint 404s when the row is gone; anything else is transient.
    return (err as { statusCode?: number }).statusCode === 404
      ? { status: 'missing' }
      : { status: 'unresolved' }
  }
  let res: Response
  try {
    res = await fetch(url, { method: 'HEAD', credentials: 'include' })
  } catch {
    return { status: 'unresolved' }
  }
  if (res.ok) return { status: 'ok', url }
  if (res.status === 410) return { status: 'gone' }
  if (res.status === 404) return { status: 'missing' }
  return { status: 'unresolved' }
}

// lucide image-off, inlined: the @nuxt/icon runtime doesn't render into DOM built by
// hand (v-html'd preview, ProseMirror node view), so the placeholder can't use <UIcon>.
const IMAGE_OFF_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="22" y1="2" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" x2="6" y1="13.5" y2="21"/><line x1="18" x2="21" y1="12" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/></svg>'

const PLACEHOLDER_LABEL = {
  gone: 'Image removed during attachment cleanup',
  missing: 'Image not found'
}

export function makeAttachmentPlaceholder(kind: 'gone' | 'missing'): HTMLElement {
  const span = document.createElement('span')
  span.className
    = 'inline-flex items-center gap-1.5 align-middle rounded-md border border-dashed border-default bg-elevated px-2 py-1 text-sm text-muted'
  const icon = document.createElement('span')
  icon.className = 'shrink-0'
  icon.innerHTML = IMAGE_OFF_SVG
  const label = document.createElement('span')
  label.textContent = PLACEHOLDER_LABEL[kind]
  span.append(icon, label)
  return span
}
