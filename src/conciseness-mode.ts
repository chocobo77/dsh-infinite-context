/**
 * Local-model conciseness mode.
 *
 * WHY this exists: a local model on a private route answers through the same
 * agent loop as an online model, but its per-turn verbosity costs far more
 * relative to its value — every "让我先看看…" narration sentence is re-sent as
 * input on every subsequent request (and re-paid after each cache expiry). The
 * measured pattern in this workspace was ≈76:1 input:output, with a large share
 * of the input being the model's own accumulated narration.
 *
 * WHY a directive message and not a system-prompt change: the `llm/stream`
 * waterfall hands a loop-built request in DEEP-FROZEN form (mutation throws) —
 * listeners may read it, never rewrite it. `GenerateOptions.system` is for
 * one-shot callers only; on the loop path the system prompt is the leading
 * system-role message INSIDE `options.messages`. The supported place to add
 * per-turn text is therefore the `agent/pre-step` decision's message list —
 * the same mechanism the RAG injection already uses.
 *
 * IDEMPOTENCE: `agent/pre-step` runs on every step, and an injected message
 * becomes part of the session log. Blind re-injection would add a copy of the
 * directive every step — the exact bloat this mode exists to prevent. So the
 * directive is injected only when it is NOT already on the surface (checked by
 * {@link hasConciseDirective}); after compaction drops it, it is re-injected.
 *
 * @module dsh-infinite-context/conciseness-mode
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/**
 * Marker embedded in the directive message and used to detect it on the
 * surface. ASCII, single-line, and specific enough that ordinary conversation
 * (or a tool result quoting this source) cannot produce it by accident.
 */
export const CONCISE_DIRECTIVE_MARKER = 'scope="dsh-infinite-context:concise"'

/**
 * Default directive. Deliberately short (≈60 tokens) and imperative: it names
 * the three habits that inflate a local-model turn — inter-call narration,
 * one-call-per-step, and scattered explanation.
 */
export const DEFAULT_CONCISE_DIRECTIVE =
  '本地模型运行中，请压缩输出：工具调用之间不要写任何说明文字，直接连续发起调用；'
  + '相互独立的调用合并到同一回合并行发出；不要复述文件内容或工具输出；'
  + '所有解释、结论与总结集中写在最终答复里。'

/** Wrap the bare directive text in its detectable envelope. */
export function buildConciseDirective(directive: string): string {
  return `<runtime_directive ${CONCISE_DIRECTIVE_MARKER}>\n${directive}\n</runtime_directive>`
}

/** Create the user-role message carrying the conciseness directive. */
export function createConciseMessage(directive: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: buildConciseDirective(directive) }],
    source: { kind: 'plugin:dsh-infinite-context' } as any,
  })
}

/**
 * Whether the directive is already present in the given surface texts.
 * Callers pass the text of every message in the request; a match means the
 * directive is still on the surface and must NOT be injected again.
 */
export function hasConciseDirective(surfaceTexts: readonly string[]): boolean {
  return surfaceTexts.some(text => text.includes(CONCISE_DIRECTIVE_MARKER))
}
