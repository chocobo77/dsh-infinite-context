/**
 * Shared string utilities used across the plugin.
 *
 * @module dsh-infinite-context/strings
 */

/** Collapse text to a single line (≤80 chars) for compact display. */
export function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed
}
