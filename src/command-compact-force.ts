/**
 * Human-facing `/compact-force` command: force one plugin fold NOW through
 * the full segmented pipeline (chunked summarization, segment window clip,
 * LLM merge rounds, extractive degradation) — NOT the base compaction
 * transaction the `/compact` command rides. Use it when `/compact` reports
 * `could not produce a useful summary`: the base path is a single
 * transaction with no degradation, while this command bypasses every pacing,
 * selection and size gate and can complete at 100% of the model window.
 * The host's turn contract decides the lane: open turn → the fold runs now;
 * idle session → it is queued in the KV and fires at the next pre-step
 * (see `requestForcedFold`).
 * @module dsh-infinite-context/command-compact-force
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinitionId, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'command-compact-force'
export const inject = ['commands', 'memoryContext']

const USAGE = 'Usage: /compact-force (no arguments)'

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
    const outcome = await engine.requestForcedFold(attached, invocation.signal)
    if (outcome.lane === 'queued') {
      return {
        kind: 'success',
        text: 'Forced fold queued: the session is idle, so the host only admits compaction inside a turn. It runs at the next agent step, before the next model request — same segmented pipeline, tail-retaining, fl_-reversible. The queue survives restarts; press again to re-arm.',
      }
    }
    const result = outcome.result
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
 * The web "/" menu renders HOST plugin rows raw (bare name + description, no
 * icon): restyling is builtins-only (dsh-client-ui-commands HOST_FACES, gated
 * by builtinCommandName), and a client contribution sharing a host command's
 * name throws at candidate synthesis ("collides with a host command"). This
 * plugin therefore ships a client half (`client/compact-force.js`) that
 * contributes the fully styled `compact-force` row, and hides the host row
 * from list() so the menu shows exactly one row. list() is display-facing
 * only — find()/execute() still resolve the definition, so the contribution
 * (ctx.remote.commands.execute('/compact-force')) and any host-path caller
 * keep working. Shadowing the instance property is safe because @Remote
 * markers store method NAMES (resolved on the instance per call), and no
 * cleanup is owed: disposing this fiber also unregisters the command, so a
 * lingering hidden name would be hiding nothing.
 * @param ctx - context carrying the command registry.
 */
const hiddenRowRegistries = new WeakMap<object, Context['commands']['list']>()

function hideHostRow(ctx: Context): void {
  const registry = ctx.commands
  const original = hiddenRowRegistries.get(registry) ?? registry.list.bind(registry)
  hiddenRowRegistries.set(registry, original)
  registry.list = (agent) => original(agent).filter((descriptor) => descriptor.name !== 'compact-force')
}

/**
 * Register `/compact-force` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the memory context.
 */
export function apply(ctx: Context): void {
  hideHostRow(ctx)
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
      definitionId: 'dsh-infinite-context/command-compact-force' as CommandDefinitionId,
      name: 'compact-force',
      description: 'Force one plugin fold NOW (segmented pipeline; works even at 100% of the model window)',
      handler,
    })
  }, 'command-compact-force lifecycle')
}
