import { Marked, type Tokens } from 'marked'

// One Marked instance per key prefix, memoized. Each instance has an inline
// extension that turns card keys (e.g. AB-40) into internal links. marked never
// runs inline tokenizers inside code spans/blocks, so keys in `code` stay
// literal — satisfying the "don't link inside code" requirement for free.
const cache = new Map<string, Marked>()

// Replicate the safeguards marked's default `link` renderer applies, since
// overriding `link` drops them — without these a `"` in href/title would break
// out of the attribute into the v-html sink.
const ESCAPE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;'
}
function escapeHtml(value: string): string {
  return value.replace(ESCAPE_RE, c => ESCAPE_MAP[c] ?? c)
}
function cleanUrl(href: string): string | null {
  try {
    return encodeURI(href).replace(/%25/g, '%')
  } catch {
    return null
  }
}

// Render-time state for interactive task lists: `interactive` swaps the disabled
// checkbox for a clickable one stamped with a sequential `data-task-index` that
// AppMarkdown maps back to the Nth task marker in the source. parse() runs
// synchronously (async:false), so one shared slot is safe — no interleaving.
const activeRender = { interactive: false, taskIndex: 0 }

function build(keyPrefix: string | null): Marked {
  const m = new Marked({ breaks: true, gfm: true })
  m.use({
    renderer: {
      link(token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens)
        const href = cleanUrl(token.href)
        if (href === null) return text
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
        // Only real markdown links reach here (card keys use their own renderer
        // below), so external = href that isn't an in-app `/...` path → new tab,
        // keeping the SPA from being navigated away.
        const attrs = href.startsWith('/') ? '' : ' target="_blank" rel="noopener noreferrer"'
        return `<a href="${href}"${title}${attrs}>${text}</a>`
      },
      checkbox({ checked }: Tokens.Checkbox) {
        if (!activeRender.interactive) {
          return `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `
        }
        const index = activeRender.taskIndex++
        return `<input type="checkbox" data-task-index="${index}"${checked ? ' checked' : ''}> `
      }
    }
  })
  if (keyPrefix) {
    const startRe = new RegExp(`${keyPrefix}-\\d`)
    const tokenRe = new RegExp(`^${keyPrefix}-\\d+\\b`)
    m.use({
      extensions: [
        {
          name: 'cardKey',
          level: 'inline',
          start(src: string) {
            const i = src.search(startRe)
            return i < 0 ? undefined : i
          },
          tokenizer(src: string) {
            const match = tokenRe.exec(src)
            if (!match) return undefined
            return { type: 'cardKey', raw: match[0], text: match[0] }
          },
          renderer(token) {
            const key = (token as unknown as { text: string }).text
            return `<a href="/cards/${key}" class="text-primary font-medium hover:underline">${key}</a>`
          }
        }
      ]
    })
  }
  return m
}

// Inline auto-link for plain-text fields (title/summary): escape HTML and turn
// card keys into links, WITHOUT interpreting markdown.
export function linkifyKeys(text: string, keyPrefix: string | null): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  if (!keyPrefix) return escaped
  const re = new RegExp(`\\b(${keyPrefix}-\\d+)\\b`, 'g')
  return escaped.replace(
    re,
    '<a href="/cards/$1" class="text-primary font-medium hover:underline">$1</a>'
  )
}

export function renderCardMarkdown(
  value: string,
  keyPrefix: string | null,
  interactive = false
): string {
  const cacheKey = keyPrefix ?? ''
  let m = cache.get(cacheKey)
  if (!m) {
    m = build(keyPrefix)
    cache.set(cacheKey, m)
  }
  activeRender.interactive = interactive
  activeRender.taskIndex = 0
  return m.parse(value, { async: false }) as string
}

// Flip the Nth task-list marker (`- [ ]` ↔ `- [x]`) in the source, counting in
// document order. The predicate MUST match exactly what marked emits a checkbox
// token for, or the index diverges and the wrong box flips: bullet (`-*+`) AND
// ordered (`1.`/`1)`) lists, inside blockquotes (`>`) too, and — mirroring
// marked's `listIsTask` (`/^\[[ xX]\] +\S/`) — only when content follows the
// box (lookahead, so the content isn't consumed by the replace). The fence
// guard skips `- [ ]` lines in code blocks, which marked doesn't tokenize.
const TASK_LINE_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?= +\S)/
const FENCE_RE = /^\s*(```|~~~)/

export function toggleTaskMarker(markdown: string, index: number): string {
  const lines = markdown.split('\n')
  let inFence = false
  let seen = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = TASK_LINE_RE.exec(line)
    if (!match) continue
    seen++
    if (seen === index) {
      const checked = match[2] !== ' '
      lines[i] = line.replace(TASK_LINE_RE, `$1[${checked ? ' ' : 'x'}]`)
      break
    }
  }
  return lines.join('\n')
}
