/**
 * Defensive readers for host event payload shapes — contract pins.
 *
 * WHY: the host's `tool/result` frame carries the tool error flag at
 * `data.message.isError` (the frozen ToolResultMessage), NOT at `data.isError`.
 * Reading the wrong level never throws — it silently degrades whatever signal
 * depends on it to a constant (here: the fold-timing `recentErrors` signal sat
 * at 0 for the plugin's whole life, so folds got MORE aggressive during an
 * error storm, not less). A helper that proves each hop keeps call sites
 * honest, and `scripts/contract-check.mjs` (node --test against `dist/`)
 * pins the shape so a host change fails loudly in the check instead of
 * silently zeroing a signal.
 * @module dsh-infinite-context/event-shapes
 */

/**
 * True when one `tool/result` event payload carries the tool's error flag.
 * Unknown / malformed payloads read as false: the signal is a heuristic input,
 * and an absent flag must not invent an error the host did not report.
 */
export function isToolResultError(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const message = (data as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return false
  return (message as { isError?: unknown }).isError === true
}
