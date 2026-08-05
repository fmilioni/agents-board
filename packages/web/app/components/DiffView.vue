<script setup lang="ts">
// Renders a unified diff GitHub-style: one block per file (path on the left,
// +adds / −dels on the right), a line-number gutter (old | new) per row, the
// git noise (mode/index/---/+++) stripped and @@ shown only as a subtle hunk
// separator. Nuxt UI has no diff component and marked can't colorize a patch,
// so we parse it ourselves. Lines pruned by the capture script
// (lockfiles/truncated/binary) surface as a muted note on the file block.
import { diffWordsWithSpace } from 'diff'

import { parseDiffImageSentinel } from '@agents-board/shared'

import { diffFileSignatures } from '~/utils/diffFiles'

const props = defineProps<{ diff: string, cardId: string, sha: string }>()

const { isViewed, setViewed, reconcile } = useViewedFiles()

// Same split/path logic as `files`, so signatures align by index — index i's
// hash fingerprints file i's diff and keys its persisted "viewed" flag.
const signatures = computed(() => diffFileSignatures(props.diff))

// UI collapse is the viewed flag by default, but the header click can override
// it per render so a viewed file can be re-opened without losing the mark. Reset
// on diff change — overrides are index-keyed and would mis-apply to a file that
// shifted position when the same instance gets a new diff.
const collapseOverride = ref<Record<number, boolean>>({})

// Byte size of each image file's representative image (new side, else old),
// reported by DiffImage once resolved — shown in the file header. Survives a
// collapse, so the size stays visible after the block is folded.
const imageSizes = ref<Record<number, number>>({})

watch(
  signatures,
  (sigs) => {
    reconcile(props.cardId, props.sha, sigs)
    collapseOverride.value = {}
    imageSizes.value = {}
  },
  { immediate: true }
)

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fileViewed(i: number): boolean {
  const sig = signatures.value[i]
  return sig ? isViewed(props.cardId, props.sha, sig.path, sig.hash) : false
}

function isCollapsed(i: number): boolean {
  return collapseOverride.value[i] ?? fileViewed(i)
}

const headerEls: (HTMLElement | null)[] = []

function scrollParent(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement
  while (p) {
    const oy = getComputedStyle(p).overflowY
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) {
      return p
    }
    p = p.parentElement
  }
  return null
}

// Collapsing/expanding a file changes its height, so the pinned header would
// jump as content reflows. Keep the toggled file's header at the same viewport
// Y by compensating the scroll for how far it moved after the DOM settles.
async function preserveHeaderPosition(i: number, mutate: () => void) {
  const el = headerEls[i]
  const before = el?.getBoundingClientRect().top ?? 0
  mutate()
  await nextTick()
  if (!el) return
  const delta = el.getBoundingClientRect().top - before
  if (!delta) return
  const sp = scrollParent(el)
  if (sp) sp.scrollTop += delta
  else window.scrollBy(0, delta)
}

function toggleCollapse(i: number) {
  preserveHeaderPosition(i, () => {
    collapseOverride.value[i] = !isCollapsed(i)
  })
}
function toggleViewed(i: number, viewed: boolean) {
  const sig = signatures.value[i]
  if (!sig) return
  preserveHeaderPosition(i, () => {
    setViewed(props.cardId, props.sha, sig.path, sig.hash, viewed)
    collapseOverride.value[i] = viewed
  })
}

type LineKind = 'add' | 'del' | 'context' | 'hunk'
interface Seg {
  text: string
  changed: boolean
}
interface DiffLine {
  kind: LineKind
  text: string
  oldNo: number | null
  newNo: number | null
  segs?: Seg[]
}
interface DiffFile {
  path: string
  additions: number
  deletions: number
  note: string | null
  // Each side is null when absent: added → no old, deleted → no new.
  image: { old: string | null, new: string | null } | null
  lines: DiffLine[]
}

// Git metadata lines we don't surface (the file block header replaces them).
const META_PREFIXES = [
  'index ',
  'new file',
  'deleted file',
  'old mode',
  'new mode',
  'rename ',
  'copy ',
  'similarity ',
  'dissimilarity '
]

const files = computed<DiffFile[]>(() => {
  const out: DiffFile[] = []
  let cur: DiffFile | null = null
  let oldNo = 0
  let newNo = 0
  const flush = () => {
    if (cur) {
      annotateIntraline(cur.lines)
      out.push(cur)
    }
  }
  for (const raw of props.diff.replace(/\n$/, '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flush()
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/)
      cur = {
        path: m ? m[2]! : raw.slice('diff --git '.length),
        additions: 0,
        deletions: 0,
        note: null,
        image: null,
        lines: []
      }
      oldNo = 0
      newNo = 0
      continue
    }
    if (!cur) continue
    if (raw.startsWith('+++ b/')) {
      cur.path = raw.slice('+++ b/'.length)
      continue
    }
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) continue
    if (META_PREFIXES.some(p => raw.startsWith(p))) continue
    if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) {
      cur.note = 'Binary file — diff not shown'
      continue
    }
    // Notes the capture script wrote in place of a pruned/truncated body; an
    // image sentinel is parsed out instead of shown as a note.
    if (raw.startsWith('# ')) {
      const refs = parseDiffImageSentinel(raw)
      if (refs) cur.image = { old: refs.old ?? null, new: refs.new ?? null }
      else cur.note = raw.slice(2)
      continue
    }
    if (raw.startsWith('@@')) {
      const hm = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (hm) {
        oldNo = Number(hm[1])
        newNo = Number(hm[2])
      }
      cur.lines.push({ kind: 'hunk', text: raw, oldNo: null, newNo: null })
      continue
    }
    if (raw.startsWith('+')) {
      cur.additions++
      cur.lines.push({ kind: 'add', text: raw, oldNo: null, newNo })
      newNo++
      continue
    }
    if (raw.startsWith('-')) {
      cur.deletions++
      cur.lines.push({ kind: 'del', text: raw, oldNo, newNo: null })
      oldNo++
      continue
    }
    cur.lines.push({ kind: 'context', text: raw, oldNo, newNo })
    oldNo++
    newNo++
  }
  flush()
  return out
})

const rowClass: Record<Exclude<LineKind, 'hunk'>, string> = {
  add: 'bg-success/10 text-success',
  del: 'bg-error/10 text-error',
  context: 'text-dimmed'
}

// The changed slice within a modified line gets a stronger patch over the row
// tint — semantic tokens, so dark/light contrast adapts on its own.
const segClass: Record<'add' | 'del', string> = {
  add: 'rounded-[2px] bg-success/30',
  del: 'rounded-[2px] bg-error/30'
}

// A contiguous run of `-` immediately followed by a run of `+` is a modify
// block: pair them by index and mark, within each line, only the tokens that
// actually changed. Lines with no counterpart (pure add/del, or the overflow
// beyond the shorter run) stay fully tinted.
function annotateIntraline(lines: DiffLine[]): void {
  let i = 0
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++
      continue
    }
    let d = i
    while (d < lines.length && lines[d]!.kind === 'del') d++
    let a = d
    while (a < lines.length && lines[a]!.kind === 'add') a++
    const pairs = Math.min(d - i, a - d)
    for (let k = 0; k < pairs; k++) {
      const del = lines[i + k]!
      const add = lines[d + k]!
      const segs = intralineSegs(del.text, add.text)
      if (segs) {
        del.segs = segs[0]
        add.segs = segs[1]
      }
    }
    i = a
  }
}

// Word-level diff of two modified lines (markers stripped, then re-added as a
// plain leading seg). Returns null when there's nothing useful to highlight —
// no shared token, or no change — so the line stays a plain full-line tint.
function intralineSegs(delText: string, addText: string): [Seg[], Seg[]] | null {
  const changes = diffWordsWithSpace(delText.slice(1), addText.slice(1))
  const hasCommon = changes.some(c => !c.added && !c.removed)
  const hasChange = changes.some(c => c.added || c.removed)
  if (!hasCommon || !hasChange) return null
  const delSegs: Seg[] = [{ text: delText.slice(0, 1), changed: false }]
  const addSegs: Seg[] = [{ text: addText.slice(0, 1), changed: false }]
  for (const c of changes) {
    if (c.added) addSegs.push({ text: c.value, changed: true })
    else if (c.removed) delSegs.push({ text: c.value, changed: true })
    else {
      delSegs.push({ text: c.value, changed: false })
      addSegs.push({ text: c.value, changed: false })
    }
  }
  return [delSegs, addSegs]
}

// The trailing context after `@@ -a,b +c,d @@` (often a function signature); the
// line numbers themselves live in the gutter, so the raw `@@` is hidden.
function hunkContext(text: string): string {
  return text.match(/^@@ .*? @@ ?(.*)$/)?.[1] ?? ''
}
</script>

<template>
  <div class="space-y-3">
    <div
      v-for="(file, fi) in files"
      :key="fi"
      class="rounded-md border border-default"
    >
      <!-- -top-6 tucks the pinned header under the sticky navbar (cancels the
        panel body's top padding) so scrolled code hides behind it, not above. -->
      <div
        :ref="(el) => { headerEls[fi] = el as HTMLElement | null }"
        class="sticky -top-6 z-10 flex items-center justify-between gap-3 px-3 py-1.5 bg-elevated border-b border-default rounded-t-md"
        :class="{ 'border-b-0 rounded-b-md': isCollapsed(fi) }"
      >
        <button
          type="button"
          class="flex items-center gap-2 min-w-0 text-left cursor-pointer"
          @click="toggleCollapse(fi)"
        >
          <UIcon
            :name="isCollapsed(fi) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
            class="shrink-0 text-muted size-3.5"
          />
          <span class="font-mono text-xs break-all">{{ file.path }}</span>
        </button>
        <span class="flex items-center gap-2 shrink-0 font-mono text-xs">
          <span
            v-if="file.additions"
            class="text-success bg-success/10 rounded px-1"
          >+{{ file.additions }}</span>
          <span
            v-if="file.deletions"
            class="text-error bg-error/10 rounded px-1"
          >-{{ file.deletions }}</span>
          <span
            v-if="imageSizes[fi] != null"
            class="text-muted"
          >{{ humanBytes(imageSizes[fi]!) }}</span>
          <button
            type="button"
            class="flex items-center gap-1.5 -my-1 px-1.5 py-1 rounded-md cursor-pointer text-muted hover:bg-default hover:text-default transition-colors"
            @click="toggleViewed(fi, !fileViewed(fi))"
          >
            <UIcon
              :name="fileViewed(fi) ? 'i-lucide-square-check' : 'i-lucide-square'"
              class="size-4 shrink-0"
              :class="fileViewed(fi) ? 'text-primary' : 'text-dimmed'"
            />
            <span class="leading-none">Viewed</span>
          </button>
        </span>
      </div>

      <div v-if="!isCollapsed(fi)" class="overflow-hidden rounded-b-md">
        <div
          v-if="file.image"
          class="flex flex-wrap items-start justify-center gap-4 p-4"
        >
          <DiffImage
            v-if="file.image.old"
            :id="file.image.old"
            :label="file.image.new ? 'Before' : 'Deleted'"
            @loaded="!file.image.new && (imageSizes[fi] = $event.bytes)"
          />
          <DiffImage
            v-if="file.image.new"
            :id="file.image.new"
            :label="file.image.old ? 'After' : 'Added'"
            @loaded="imageSizes[fi] = $event.bytes"
          />
        </div>
        <div
          v-else-if="file.lines.length"
          class="text-xs font-mono leading-relaxed"
        >
          <template v-for="(line, li) in file.lines" :key="li">
            <div
              v-if="line.kind === 'hunk'"
              class="px-3 py-0.5 bg-elevated/40 text-muted text-[11px] truncate border-t border-default first:border-t-0"
              v-text="hunkContext(line.text)"
            />
            <div v-else class="flex" :class="rowClass[line.kind]">
              <span
                class="shrink-0 w-9 px-1 text-right text-muted/40 select-none tabular-nums"
              >{{ line.oldNo ?? "" }}</span>
              <span
                class="shrink-0 w-9 px-1 text-right text-muted/40 select-none tabular-nums border-r border-default"
              >{{ line.newNo ?? "" }}</span>
              <span
                v-if="line.segs"
                class="flex-1 min-w-0 whitespace-pre-wrap break-all pl-2 pr-3"
              ><span
                v-for="(seg, si) in line.segs"
                :key="si"
                :class="seg.changed ? segClass[line.kind as 'add' | 'del'] : undefined"
                v-text="seg.text"
              /></span>
              <span
                v-else
                class="flex-1 min-w-0 whitespace-pre-wrap break-all pl-2 pr-3"
                v-text="line.text || ' '"
              />
            </div>
          </template>
        </div>

        <div
          v-if="file.note"
          class="px-3 py-1.5 text-xs text-muted italic"
          v-text="file.note"
        />
      </div>
    </div>
  </div>
</template>
