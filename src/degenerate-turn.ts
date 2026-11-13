/**
 * Degenerate-turn invisible retry (upstream billion-context #821, absorbed at
 * the engine layer): a turn that ENDS normally but whose final assistant
 * message carries no visible output — reasoning blocks only, or empty
 * content — is a lost turn: the model burned tokens, produced nothing, and
 * the loop closed as completed. Upstream retries such a turn once, silently.
 *
 * The engine-layer equivalent: when the host fires `agent/turn-stopping`
 * (pre-close, serial), the driver inspects the turn's last assistant message
 * and, if degenerate, splices ONE corrective step into the inbox — the turn
 * continues, the model produces real output, and the user never had to
 * intervene. Not byte-invisible (the nudge is a durable user-role message),
 * but behaviorally equivalent: no user action, no lost turn.
 *
 * @module dsh-infinite-context/degenerate-turn
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'

/** Consecutive degenerate turns the retry will serve before standing down (safety bound). */
export const DEGENERATE_RETRY_MAX_STREAK = 3

/**
 * Whether the final assistant content of a completed turn is degenerate:
 * no tool call AND no non-empty text — the turn visibly did nothing.
 * Reasoning-only counts (thinking without an answer); a single character of
 * text does not (that is output, however weak — judging quality is not this
 * module's job).
 */
export function isDegenerateAssistantContent(content: readonly ContentBlock[]): boolean {
  for (const block of content) {
    if (block.type === 'tool-call') return false
    if (block.type === 'text' && block.text.trim().length > 0) return false
  }
  return true
}

/**
 * The corrective step: state what happened, demand real output. Deliberately
 * short — the model does not need the failure theory, it needs the turn back.
 */
export function degenerateRetryNudge(): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: '[Harness check — that reply had no visible output]. '
        + 'Your previous message ended the turn with reasoning only and no answer. '
        + 'Continue now: write the actual response as text, or call a tool. Do not end the turn empty again.',
    }],
    source: { kind: 'plugin:dsh-infinite-context' } as never,
  })
}
