/**
 * Bench corpus importer: turn one archived DSH session log into scoring
 * regions. Parses `~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd`
 * (node:zlib zstd — no new dependency), keeps only the CONVERSATION the model
 * produced or consumed (user-authored messages, assistant messages, tool
 * results — injected artifacts like runtime-context snapshots and plugin
 * splices are excluded so scoring judges real content, not our own echoes),
 * then chunks it into regions whose token mass matches production fold
 * regions (~22-35k).
 *
 * @module dsh-infinite-context/bench-import-session
 */

import { zstdDecompressSync } from 'node:zlib'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { estimateContentTokens } from '../src/token-budget.ts'

/** One conversation message reconstructed from the session log. */
export interface ImportedMessage {
  readonly role: 'user' | 'assistant' | 'tool'
  /** The durable content blocks, as logged. */
  readonly content: readonly unknown[]
  /** Plugin meter tokens for the message (estimateContentTokens). */
  readonly tokens: number
}

/** One scoring region: a contiguous slice of the conversation. */
export interface ImportedRegion {
  readonly index: number
  readonly messages: readonly ImportedMessage[]
  readonly tokens: number
}

export interface RegionChunkOptions {
  /** Target region token mass (default 25k). */
  readonly targetTokens?: number
  /** Regions below this are dropped as unrepresentative (default 15k). */
  readonly minTokens?: number
  /** Hard ceiling: adding a message past this closes the region (default 35k). */
  readonly maxTokens?: number
}

const DEFAULT_CHUNK: Required<RegionChunkOptions> = { targetTokens: 25_000, minTokens: 15_000, maxTokens: 35_000 }

/** Locate one session's log under `<home>/sessions/<workspace>/session-<id>/`. */
export function resolveSessionFile(home: string, sessionId: string): string {
  if (sessionId.includes('/') || sessionId.includes('\\')) {
    if (!existsSync(sessionId)) throw new Error(`session file not found: ${sessionId}`)
    return sessionId
  }
  const sessionsRoot = join(home, 'sessions')
  if (!existsSync(sessionsRoot)) throw new Error(`no sessions directory under ${home}`)
  // Directories carry the FULL uuid (session-<uuid>); a caller may pass any
  // unambiguous prefix of it, so match by prefix and refuse ambiguity.
  let found: string | undefined
  for (const workspace of readdirSync(sessionsRoot)) {
    for (const entry of readdirSync(join(sessionsRoot, workspace))) {
      if (!entry.startsWith(`session-${sessionId}`)) continue
      const candidate = join(sessionsRoot, workspace, entry, 'session.v4.jsonl.zstd')
      if (!existsSync(candidate)) continue
      if (found !== undefined && found !== candidate) {
        throw new Error(`session prefix "${sessionId}" matches multiple logs: ${found} and ${candidate}`)
      }
      found = candidate
    }
  }
  if (found === undefined) throw new Error(`session "${sessionId}" not found under ${sessionsRoot}`)
  return found
}

function messageTokens(content: readonly unknown[]): number {
  return estimateContentTokens(content)
}

/**
 * Rebuild the conversation from one session log, in log order.
 * Injected user-role artifacts (runtime-context, plugin splices, task-state,
 * agent instructions) are dropped: only `source.kind === 'user'` survives.
 */
export function importSession(zstdPath: string): ImportedMessage[] {
  const raw = zstdDecompressSync(readFileSync(zstdPath)).toString('utf8')
  const out: ImportedMessage[] = []
  for (const line of raw.split('\n')) {
    let event: {
      type?: string
      data?: {
        source?: { kind?: string }
        content?: unknown[]
        message?: { content?: unknown[] }
      }
    }
    try { event = JSON.parse(line) } catch { continue }
    const data = event.data
    if (data === undefined) continue
    if (event.type === 'user/message') {
      if (data.source?.kind !== 'user') continue
      const content = data.content ?? []
      if (content.length > 0) out.push({ role: 'user', content, tokens: messageTokens(content) })
    } else if (event.type === 'assistant/message') {
      const content = data.message?.content ?? []
      if (content.length > 0) out.push({ role: 'assistant', content, tokens: messageTokens(content) })
    } else if (event.type === 'tool/result') {
      const content = data.content ?? []
      if (content.length > 0) out.push({ role: 'tool', content, tokens: messageTokens(content) })
    }
  }
  return out
}

/**
 * Chunk the conversation into contiguous scoring regions. A region closes at
 * `targetTokens`, or earlier when one more message would blow `maxTokens`;
 * trailing mass below `minTokens` is dropped.
 */
export function chunkRegions(messages: readonly ImportedMessage[], options: RegionChunkOptions = {}): ImportedRegion[] {
  const o = { ...DEFAULT_CHUNK, ...options }
  const regions: ImportedRegion[] = []
  let current: ImportedMessage[] = []
  let currentTokens = 0
  const close = (): void => {
    if (currentTokens >= o.minTokens) {
      regions.push({ index: regions.length, messages: current, tokens: currentTokens })
    }
    current = []
    currentTokens = 0
  }
  for (const message of messages) {
    if (currentTokens > 0 && currentTokens + message.tokens > o.maxTokens) close()
    current.push(message)
    currentTokens += message.tokens
    if (currentTokens >= o.targetTokens) close()
  }
  close()
  return regions
}

/** Import + chunk in one call. */
export function importSessionRegions(zstdPath: string, options: RegionChunkOptions = {}): ImportedRegion[] {
  return chunkRegions(importSession(zstdPath), options)
}
