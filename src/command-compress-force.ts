/**
 * Human-facing `/compress-force` command: force one plugin fold NOW through
 * the full segmented pipeline (chunked summarization, segment window clip,
 * LLM merge rounds, extractive degradation) — NOT the base compaction
 * transaction the `/compact` command rides. Use it when `/compact` reports
 * `could not produce a useful summary`: the base path is a single
 * transaction with no degradation, while this command bypasses every pacing,
 * selection and size gate and can complete at 100% of the model window.
 * @module dsh-infinite-context/command-compress-force
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinitionId, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'command-compress-force'
export const inject = ['commands', 'memoryContext']

const USAGE = 'Usage: /compress-force (no arguments)'

async function executeForceCompact(
  ctx: Context,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE }
  const engine = ctx.memoryContext.compactionEngine
  if (engine == null) {
    return { kind: 'error', text: 'Force compression unavailable: the memory-compaction engine is not loaded.' }
  }
  const sessionId = String(invocation.agent.session.id)
  const attached = engine.agentFor(sessionId) ?? invocation.agent
  try {
    const result = await engine.foldNow(attached, invocation.signal, true)
    if (result === null) {
      return { kind: 'error', text: 'No compactable history yet — nothing to fold.' }
    }
    return {
      kind: 'success',
      text: `Forced fold committed: ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens) folded, originals archived (fl_ refs on the surface).`,
      sourceEventSeq: result.summarySeq,
    }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Force compression cancelled.' }
    const brief = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `Force compression failed: ${brief.slice(0, 200)} The attempt is visible in the plugin ledger (fold_check).` }
  }
}

/**
 * Register `/compress-force` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the memory context.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeForceCompact(ctx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      // definitionId is an opaque registry key (host-side "no validation is
      // performed"); the nominal brand is bypassed here because dsh-brand is
      // a transitive host dependency, not one of this plugin's peers.
      definitionId: 'dsh-infinite-context/command-compress-force' as CommandDefinitionId,
      name: 'compress-force',
      description: 'Force one plugin fold NOW (segmented pipeline; works even at 100% of the model window)',
      handler,
    })
  }, 'command-compress-force lifecycle')
}
