// Mirrors core's parseCardKeys, which the web can't import (no server deps here).
export function parseIntakeKeys(csv: string | null | undefined): string[] {
  return (csv ?? '').split(',').map(k => k.trim()).filter(Boolean)
}

export function formatIntakeKeys(csv: string | null | undefined): string {
  return parseIntakeKeys(csv).join(', ')
}
