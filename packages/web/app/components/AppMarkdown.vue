<script setup lang="ts">
import { useProjectStore } from '~/stores/project'

const props = withDefaults(
  defineProps<{
    value: string | null | undefined
    interactive?: boolean // render task-list checkboxes clickable + emit toggles
  }>(),
  { interactive: false }
)

const emit = defineEmits<{
  (e: 'update:value', value: string): void
}>()

const store = useProjectStore()
const router = useRouter()
const { resolveDisplaySrc } = useAttachments()

const root = ref<HTMLElement | null>(null)

const html = computed(() => {
  if (!props.value) return ''
  const rendered = renderCardMarkdown(
    props.value,
    store.currentProject?.keyPrefix ?? null,
    props.interactive
  )
  // Park the relative attachment src in data-att-src so the browser doesn't
  // eagerly fetch `/attachments/...` against the web origin (a guaranteed 404,
  // cross-origin); resolveImages sets the real signed src after mount.
  return rendered.replaceAll('src="/attachments/', 'data-att-src="/attachments/')
})

// v-html rebuilds the DOM on change, so we re-run on every html update.
async function resolveImages() {
  const el = root.value
  if (!el) return
  await Promise.all(
    Array.from(el.querySelectorAll<HTMLImageElement>('img[data-att-src]')).map(async (img) => {
      const raw = img.dataset.attSrc
      if (!raw) return
      const resolved = await resolveAttachmentImage(raw, resolveDisplaySrc)
      if (resolved.status === 'ok') img.src = resolved.url
      else if (resolved.status !== 'unresolved') {
        img.replaceWith(makeAttachmentPlaceholder(resolved.status))
      }
    })
  )
}

watch(html, () => nextTick(resolveImages))
onMounted(resolveImages)

// Make internal links (e.g. the auto-linked card keys) navigate via the router
// instead of doing a full page reload. External links keep default behavior.
function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (props.interactive && props.value != null) {
    const box = target.closest<HTMLInputElement>(
      'input[type="checkbox"][data-task-index]'
    )
    if (box) {
      // preventDefault keeps the DOM in sync with the source: the re-render off
      // the emitted value owns the checked state, not the native toggle.
      e.preventDefault()
      const index = Number(box.dataset.taskIndex)
      if (Number.isInteger(index)) {
        emit('update:value', toggleTaskMarker(props.value, index))
      }
      return
    }
  }
  const anchor = target.closest('a')
  if (!anchor) return
  const href = anchor.getAttribute('href')
  if (href && href.startsWith('/')) {
    e.preventDefault()
    router.push(href)
  }
}
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- markdown rendered from trusted card/doc content via marked -->
  <div ref="root" @click="onClick" v-html="html" />
</template>
