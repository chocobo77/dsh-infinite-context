/**
 * dsh-infinite-context — a DeepSeek Harness plugin for "infinite context"
 * through multi-tier memory management.
 *
 * Three `cordis.yml` entries make up the plugin:
 *   - `memory-context`  (this package `./memory-context`): the persistent
 *     multi-tier store + embedder + vector index + budget + forgetting.
 *   - `memory-compaction` (this package `./memory-compaction`): the compaction
 *     engine that persists summaries, injects retrieved memories, compresses
 *     history, sanitizes tool outputs, and applies fallback truncation.
 *   - `memory-tools`    (this package `./tools`): manual tools.
 *
 * New modules added for the four governance strategies:
 *   - `OutputSanitizer`: sanitizes tool results (web_search, code_exec, JSON).
 *   - `VectorRetriever`: wraps memoryContext for RAG ingestion/retrieval.
 *   - `HistoryCompressor`: inlined in memory-compaction.ts (needs DSH imports).
 *
 * @module dsh-infinite-context
 */

export type * from './types.ts'
export * from './core.ts'
export { MemoryContext } from './memory-context.ts'
export { MemoryCompactionEngine, HistoryCompressor } from './memory-compaction.ts'
export * from './config.ts'
export { sanitizeToolResult } from './OutputSanitizer.ts'
export type { SanitizerConfig } from './OutputSanitizer.ts'
export { VectorRetriever } from './VectorRetriever.ts'
export type { VectorRetrieverConfig } from './VectorRetriever.ts'
export { apply as toolsApply, name as toolsName, inject as toolsInject } from './tools.ts'

/**
 * Plugin entry face for the BARE package loader row (`name: dsh-infinite-context`
 * in the bundle patch). The browser graph (dsh-client-modules) turns only
 * packages mounted under their exact package name into `__DSH_BOOT__` rows —
 * `exactPackageSpecifier` classifies every subpath entry (`…/memory-context`)
 * as host-only — so this dual-face package needs a root row to activate its
 * client half (`client/compact-force.js`, the styled /compact-force menu row).
 * Host behavior deliberately stays empty: every host face is mounted by its
 * own subpath entry with its own config, and a no-op apply keeps the fiber
 * alive (client-modules skips entries without one) without double-registering
 * anything. (dshmarket is the shipped precedent: bare `name: 'dshmarket'`
 * patch entry + root apply.)
 */
export const name = 'dsh-infinite-context'
export const inject = []

/** No-op host face: see the entry-face note above. */
export function apply(): void {}
