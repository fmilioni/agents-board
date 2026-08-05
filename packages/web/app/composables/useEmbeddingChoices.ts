import { EMBEDDING_DTYPES, EMBEDDING_MODELS } from '@agents-board/shared'

// Human labels for the quantization variants so the picker conveys the
// quality/memory trade-off (fp32 = highest precision/most memory → q8 = lowest
// precision/least memory). Falls back to the raw id for an unmapped dtype.
const DTYPE_LABELS: Record<string, string> = {
  fp32: 'fp32 — full precision · best quality, highest memory usage',
  fp16: 'fp16 — half precision · balanced',
  q8: 'q8 — 8-bit quantized · lowest memory usage (default)'
}

// Select items for the embedding model + dtype pickers, built from the shared
// registry so the config (settings) and setup (login) screens never drift.
export function useEmbeddingChoices() {
  const modelItems = [
    ...Object.entries(EMBEDDING_MODELS).map(([id, info]) => ({
      label: `${id} (${info.dim}d)`,
      value: id
    })),
    { label: 'Disabled — lexical search only', value: 'none' }
  ]
  const dtypeItems = EMBEDDING_DTYPES.map(dtype => ({
    label: DTYPE_LABELS[dtype] ?? dtype,
    value: dtype
  }))
  return { modelItems, dtypeItems }
}
