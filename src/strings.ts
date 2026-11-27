/**
 * Shared string utilities used across the plugin.
 *
 * @module dsh-infinite-context/strings
 */

/** Collapse text to a single line (≤80 chars) for compact display. */
export function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= 80) return collapsed
  // Clip by code points (the rest of the plugin does): a raw UTF-16 slice can
  // split a surrogate pair and end the label in a lone half character.
  return `${Array.from(collapsed).slice(0, 79).join('')}…`
}
