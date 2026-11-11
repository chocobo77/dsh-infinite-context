/**
 * Fold evidence: a deterministic, zero-LLM audit of what a fold summary kept.
 *
 * The research (KEEP-Bench) says compaction fails on EVIDENCE STRUCTURE, not
 * on answering questions: summaries drop the exact paths, error strings, exit
 * codes and numeric constants that a resume needs, and nothing in the loop
 * notices — the deviation EMA measures the summary's SIZE, not its
 * fidelity. This module closes that gap cheaply: extract the region's load-
 * bearing anchors mechanically (the same signal-line detection the tool
 * archive already uses), subtract whatever the summary already carries, and
 * hand back the few MISSING lines so the fold can re-attach them verbatim.
 * No model call, no judgment — a floor under fold quality that is auditable
 * in the ledger (`evidence:missing=n`).
 *
 * @module dsh-infinite-context/fold-evidence
 */

import { isSignalLine } from './absorb.ts'

/** One anchor line the summary lost. */
export interface EvidenceAnchor {
  /** Where it came from (for the ledger and the section label). */
  readonly kind: 'path' | 'ref' | 'error'
  /** The exact text to re-attach. */
  readonly text: string
}

/** Bounds for the audit. Safety ceilings, not tuning points. */
export interface EvidenceOptions {
  /** Max anchors kept (deduped, in region order). Default 16. */
  readonly maxAnchors?: number
  /** Longest anchor kept — a whole multi-line blob is not one anchor. Default 200. */
  readonly maxAnchorChars?: number
  /** Paths shorter than this are noise, not anchors. Default 5. */
  readonly minPathChars?: number
}

export const DEFAULT_EVIDENCE_OPTIONS = {
  maxAnchors: 16,
  maxAnchorChars: 200,
  minPathChars: 5,
} as const

/** Resolve one bound defensively: non-finite input falls back to the default
 * (callers derive budgets from arithmetic, and NaN must never mean "unbounded"
 * — that silently breaks the bounded-work promise). */
function intOption(value: number | undefined, fallback: number, min: number): number {
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(min, base)
}

/** Message surface the extractor needs. */
export interface EvidenceMessage {
  readonly role: string
  readonly source?: { kind?: string } | null
  /** The flat text of the message (caller serializes once). */
  readonly text: string
}

/** One path segment: letters/digits/dot/dash/underscore — deliberately NOT
 * separators, so every `/` or `\` in the pattern has exactly one parse (a
 * class that also contained separators backtracks quadratically over long
 * separator-only runs, e.g. minified output). */
const PATH_SEG = '[\\p{L}\\p{N}.\\-_]'
/**
 * A file path with a real extension, Windows or POSIX, ASCII or CJK
 * (sessions here are frequently Chinese — `D:\代码\模块.ts` must anchor like
 * an English path does). The `(?!\w)` guard stops `app.tsbuildinfo` from
 * yielding the half-extension `app.tsbuil`; template literals
 * (`src/${file}.ts`) are deliberately NOT paths. A URL may match its
 * path-like tail (`github.com/foo/bar.ts`) — accepted noise: containment
 * keeps it on the "kept" side, and the anchor is at most one re-attached line.
 */
const PATH_RE = new RegExp(
  `(?:[A-Za-z]:\\\\|\\./|~/|/)?(?:${PATH_SEG}+[\\\\/])+${PATH_SEG}+\\.\\w{1,6}(?!\\w)`,
  'gu',
)
/** Archive refs are lifelines: they are the read-back handles for folded bulk. */
const REF_RE = /\b(?:fl|tr)_[0-9a-f]{6,16}\b/g

/** Case/code-point-insensitive containment used for the "already kept" test. */
function keptIn(summaryLower: string, anchor: string): boolean {
  return summaryLower.includes(anchor.toLowerCase())
}

/**
 * Extract the load-bearing anchors from a folded region. Paths come from
 * every message (a decision naming a file survives in prose too); archive
 * refs and error/signal lines come from tool output, where they cluster.
 * @param messages - the region's messages with their flat text.
 * @param options - the audit bounds.
 * @returns the anchors, deduped, in first-seen order.
 */
export function extractAnchors(
  messages: readonly EvidenceMessage[],
  options: EvidenceOptions = {},
): EvidenceAnchor[] {
  const maxAnchors = intOption(options.maxAnchors, DEFAULT_EVIDENCE_OPTIONS.maxAnchors, 0)
  const maxAnchorChars = intOption(options.maxAnchorChars, DEFAULT_EVIDENCE_OPTIONS.maxAnchorChars, 20)
  const minPathChars = intOption(options.minPathChars, DEFAULT_EVIDENCE_OPTIONS.minPathChars, 1)
  // The collected POOL generously exceeds the final cap (the gap filter
  // re-caps), but it is a hard bound: push never exceeds it, every loop
  // breaks on it. A caller that needs to know the pool was exhausted (so the
  // audit can report truncation honestly) uses anchorsPoolCapped().
  const poolCap = maxAnchors * 4
  const anchors: EvidenceAnchor[] = []
  const seen = new Set<string>()
  const push = (kind: EvidenceAnchor['kind'], text: string): void => {
    if (anchors.length >= poolCap) return
    const trimmed = text.trim()
    if (trimmed.length === 0 || trimmed.length > maxAnchorChars) return
    // Lines that open with `#` are headings/anchors of the SUMMARY's own
    // structure; re-attaching one verbatim would inject a second arbitrary
    // heading into the checkpoint (task-state parser contract).
    if (trimmed.startsWith('#')) return
    const key = kind + '\u0000' + trimmed.toLowerCase()
    if (seen.has(key)) return
    if (kind === 'path' && trimmed.length < minPathChars) return
    seen.add(key)
    anchors.push({ kind, text: trimmed })
  }
  for (const message of messages) {
    const text = message.text
    if (text.length === 0) continue
    // Archive refs wherever they appear (the fold's own header, expand stubs).
    const refs = text.match(REF_RE)
    if (refs !== null) for (const ref of refs) push('ref', ref)
    // Paths wherever they appear (user instructions and checkpoints name them).
    const paths = text.match(PATH_RE)
    if (paths !== null) for (const path of paths) push('path', path)
    // Error/signal lines: only from tool output, where they are the payload.
    const isTool = message.role === 'tool' || message.source?.kind === 'tool'
    if (isTool) {
      for (const line of text.split(/\r?\n/)) {
        if (anchors.length >= poolCap) break
        const trimmed = line.trim()
        if (trimmed.length > 0 && isSignalLine(trimmed)) push('error', trimmed)
      }
    }
    if (anchors.length >= poolCap) break
  }
  return anchors
}

/**
 * Whether `extractAnchors` ran out of pool under these options — the audit
 * then knows its missing-list may understate the region's true losses.
 * @param anchors - the anchors extracted.
 * @param options - the options extraction ran under.
 * @returns true when the pool cap was reached.
 */
export function anchorsPoolCapped(
  anchors: readonly EvidenceAnchor[],
  options: EvidenceOptions = {},
): boolean {
  const maxAnchors = intOption(options.maxAnchors, DEFAULT_EVIDENCE_OPTIONS.maxAnchors, 0)
  return anchors.length >= maxAnchors * 4
}

/** The budgeted result of an audit: the missing lines plus what was dropped. */
export interface EvidenceAudit {
  readonly missing: readonly EvidenceAnchor[]
  /** True when the cap forced some missing anchors to be dropped (ledger hint). */
  readonly truncated: boolean
}

/**
 * Which anchors did NOT survive into the summary text. Containment is
 * case-insensitive substring over the whole summary — deliberately generous:
 * an anchor the model reworded INTO the text counts as kept, only lines fully
 * gone are gaps.
 * @param anchors - the region's extracted anchors.
 * @param summaryText - the produced checkpoint text.
 * @param options - the audit bounds (maxAnchors caps the RESULT list).
 * @returns the missing anchors (deduped, region order) and the truncation flag.
 */
export function auditEvidence(
  anchors: readonly EvidenceAnchor[],
  summaryText: string,
  options: EvidenceOptions = {},
  poolCapped = false,
): EvidenceAudit {
  const maxAnchors = intOption(options.maxAnchors, DEFAULT_EVIDENCE_OPTIONS.maxAnchors, 0)
  const summaryLower = summaryText.toLowerCase()
  const missing: EvidenceAnchor[] = []
  for (const anchor of anchors) {
    if (keptIn(summaryLower, anchor.text)) continue
    missing.push(anchor)
  }
  // Truncation is honest only when BOTH caps can hide losses: the result cap
  // (missing beyond maxAnchors) and the extraction pool (an exhausted pool
  // plus a FULL missing list means unseen regions may hold more losses).
  const truncated = missing.length > maxAnchors
    || (poolCapped && maxAnchors > 0 && missing.length >= maxAnchors)
  return { missing: missing.slice(0, maxAnchors), truncated }
}

/** The heading of the re-attached section (bilingual, task-state parser-safe:
 * a new `##` heading, not a rename of an existing one). */
export const EVIDENCE_SECTION_HEADING = '## Folded Evidence (verbatim, re-attached)'

/** Worst-case fixed cost of the rendered section: heading + the truncation
 * note (only present when capped, but the ceiling must cover it). */
const SECTION_FIXED_OVERHEAD = EVIDENCE_SECTION_HEADING.length + 1
  + '- (more evidence lost than this cap; see the fl_ archive)\n'.length
/** Worst-case per-anchor render cost: label (`- signal: `) + text + newline. */
const PER_ANCHOR_OVERHEAD = '- signal: '.length + 1

/**
 * Upper bound on `renderEvidenceSection` output length under these options.
 * Lets the fold reserve the evidence share of its budget BEFORE the audit
 * runs, so the section can never push the summary over budget.
 * @param options - the audit bounds.
 * @returns the character ceiling.
 */
export function evidenceSectionCeiling(options: EvidenceOptions = {}): number {
  const maxAnchors = intOption(options.maxAnchors, DEFAULT_EVIDENCE_OPTIONS.maxAnchors, 0)
  if (maxAnchors === 0) return 0 // the section renders empty — reserve nothing
  const maxAnchorChars = intOption(options.maxAnchorChars, DEFAULT_EVIDENCE_OPTIONS.maxAnchorChars, 20)
  return SECTION_FIXED_OVERHEAD + maxAnchors * (PER_ANCHOR_OVERHEAD + maxAnchorChars)
}

/**
 * Shrink `maxAnchors` until the rendered section provably fits `charBudget`.
 * Budget-driven on purpose: a big fold re-attaches up to the cap, a tiny
 * fold re-attaches only the few most load-bearing lines — an evidence
 * section that eats the summary's own budget defeats the fold it audits.
 * @param options - the caller's bounds.
 * @param charBudget - characters the section may take.
 * @returns the options with the budget-fitted `maxAnchors`.
 */
export function fitEvidenceOptions(options: EvidenceOptions = {}, charBudget: number): EvidenceOptions {
  const cap = intOption(options.maxAnchors, DEFAULT_EVIDENCE_OPTIONS.maxAnchors, 0)
  const maxAnchorChars = intOption(options.maxAnchorChars, DEFAULT_EVIDENCE_OPTIONS.maxAnchorChars, 20)
  const budget = Number.isFinite(charBudget) ? charBudget : 0
  const perAnchor = PER_ANCHOR_OVERHEAD + maxAnchorChars
  const fit = Math.floor((budget - SECTION_FIXED_OVERHEAD) / perAnchor)
  return { ...options, maxAnchors: Math.max(0, Math.min(cap, fit)) }
}

/**
 * Render the audit's missing anchors as a verbatim section to append to the
 * summary. It is appended AFTER the model's text and never replaces anything,
 * so a fold's fidelity floor does not depend on what the summarizer chose to
 * keep. Lines are already bounded by the extractor.
 * @param audit - the audit result.
 * @returns the section text, or `''` when nothing is missing.
 */
export function renderEvidenceSection(audit: EvidenceAudit): string {
  if (audit.missing.length === 0) return ''
  const lines = audit.missing.map(anchor => {
    switch (anchor.kind) {
      case 'path': return '- path: ' + anchor.text
      case 'ref': return '- ref: ' + anchor.text
      case 'error': return '- signal: ' + anchor.text
    }
  })
  if (audit.truncated) lines.push('- (more evidence lost than this cap; see the fl_ archive)')
  return EVIDENCE_SECTION_HEADING + '\n' + lines.join('\n')
}
