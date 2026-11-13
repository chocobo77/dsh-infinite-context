/**
 * Bench scoring: the DETERMINISTIC commit layer (budget clip, user-instruction
 * digest, fold-evidence re-attachment) replicated from the engine's
 * postSummarize so a replayed summary lands exactly like a production fold,
 * plus the two scoring tracks — anchor coverage (same口径 as the production
 * `evidence:missing=` ledger signal) and the optional LLM judge.
 *
 * All imports are src modules with no host-package value dependencies, so the
 * bench runs under plain tsx without the vitest aliases.
 *
 * @module dsh-infinite-context/bench-score
 */

import { summaryCharBudget } from '../src/compaction-governance.ts'
import { SUMMARY_OUTPUT_SHARE } from '../src/compaction-policy.ts'
import {
  DEFAULT_EVIDENCE_OPTIONS,
  anchorsPoolCapped,
  auditEvidence,
  evidenceSectionCeiling,
  extractAnchors,
  fitEvidenceOptions,
  renderEvidenceSection,
} from '../src/fold-evidence.ts'
import { extractiveSummary } from '../src/extractive-summary.ts'
import type { ImportedMessage, ImportedRegion } from './import-session.ts'

/** Flatten one imported message to its text, the way the meter does. */
export function messageText(message: ImportedMessage): string {
  return (message.content as readonly { type?: string; text?: string }[])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
}

/** Role-marker serialization of a region (mirrors the summarization prompt body). */
export function serializeRegionText(region: ImportedRegion): string {
  return region.messages
    .map((message, i) => {
      const text = messageText(message)
      const body = text.length > 16_000
        ? `${text.slice(0, 16_000)}\n…[truncated: ${text.length - 16_000} more chars]`
        : text
      return `[${i}] ${message.role}: ${body}`
    })
    .join('\n')
}

/** The completion-token ceiling for one region's summary (budget chars ≈ /4 tokens). */
export function regionMaxTokens(region: ImportedRegion): number {
  return Math.min(16_384, Math.max(2_048, Math.round(summaryCharBudget(region.tokens, SUMMARY_OUTPUT_SHARE) / 4)))
}

const EVIDENCE_SHARE = 0.25

export interface CommittedSummary {
  /** digest + clipped summary + evidence section, the durable fold text. */
  readonly text: string
  readonly summaryChars: number
  readonly evidenceMissing: number
  readonly evidenceTruncated: boolean
}

/**
 * Apply the deterministic commit layer to a raw model summary. Mirrors the
 * engine's postSummarize order: budget clip → digest → evidence audit with
 * the same 25% budget cap and re-tighten pass.
 */
export function commitSummaryLayer(region: ImportedRegion, rawText: string): CommittedSummary {
  const maxChars = summaryCharBudget(region.tokens, SUMMARY_OUTPUT_SHARE)
  let summary = rawText.trim()
  const clip = (value: string, budget: number): string =>
    value.length > budget ? value.slice(0, Math.max(0, budget - 14)) + '\n…[truncated]' : value
  summary = clip(summary, maxChars)
  // User-instructions digest: the deterministic floor under whatever the
  // summarizer decided to keep (same -12 / 300-char rules as the engine).
  const digestLines = region.messages
    .filter(message => message.role === 'user')
    .map(message => messageText(message).trim())
    .filter(value => value.length > 0)
    .slice(-12)
    .map(value => `- ${value.length > 300 ? `${value.slice(0, 300)}…` : value}`)
  const digest = digestLines.length === 0
    ? ''
    : `## 折叠区用户指令 / User instructions in the folded range\n${digestLines.join('\n')}`
  // Evidence audit against EVERYTHING the fold lands, digest included.
  const evidenceOptions = fitEvidenceOptions({}, Math.floor(maxChars * EVIDENCE_SHARE))
  const anchors = extractAnchors(
    region.messages.map(message => ({ role: message.role, source: null, text: messageText(message) })),
    evidenceOptions,
  )
  const poolCapped = anchorsPoolCapped(anchors, evidenceOptions)
  const auditDomain = digest.length > 0 ? `${summary}\n\n${digest}` : summary
  let audit = auditEvidence(anchors, auditDomain, evidenceOptions, poolCapped)
  let candidate = renderEvidenceSection(audit)
  if (candidate.length > 0 && summary.length + candidate.length + 2 > maxChars) {
    summary = clip(summary, Math.max(0, maxChars - evidenceSectionCeiling(evidenceOptions) - 2))
    const tightened = digest.length > 0 ? `${summary}\n\n${digest}` : summary
    audit = auditEvidence(anchors, tightened, evidenceOptions, poolCapped)
    candidate = renderEvidenceSection(audit)
  }
  const text = [digest, summary, candidate].filter(Boolean).join('\n\n')
  return {
    text,
    summaryChars: summary.length,
    evidenceMissing: audit.missing.length,
    evidenceTruncated: audit.truncated,
  }
}

export interface VariantScore {
  readonly variant: 'model' | 'extractive' | 'raw-truncation'
  readonly regionIndex: number
  readonly regionTokens: number
  readonly summaryChars: number
  /** Anchors extracted from the region (production口径, ≤ 16). */
  readonly anchorTotal: number
  readonly anchorMissing: number
  readonly missingRate: number
  readonly evidenceTruncated: boolean
  readonly judge?: { readonly faithfulness: number; readonly coverage: number; readonly notes: string }
  readonly error?: string
}

/** Deterministic score of one final summary text against its region. */
export function scoreVariant(region: ImportedRegion, variant: VariantScore['variant'], text: string): VariantScore {
  // Scored against the FULL deduped anchor pool (≤ 4×maxAnchors) — broader
  // than the commit's budget-capped audit, so this measures true coverage of
  // every load-bearing anchor, not just what the evidence section could hold.
  const anchors = extractAnchors(
    region.messages.map(message => ({ role: message.role, source: null, text: messageText(message) })),
    DEFAULT_EVIDENCE_OPTIONS,
  )
  const poolCapped = anchorsPoolCapped(anchors, DEFAULT_EVIDENCE_OPTIONS)
  const audit = auditEvidence(anchors, text, DEFAULT_EVIDENCE_OPTIONS, poolCapped)
  return {
    variant,
    regionIndex: region.index,
    regionTokens: region.tokens,
    summaryChars: text.length,
    anchorTotal: anchors.length,
    anchorMissing: audit.missing.length,
    missingRate: anchors.length === 0 ? 0 : audit.missing.length / anchors.length,
    evidenceTruncated: audit.truncated,
  }
}

/** Deterministic baselines for one region: production's extractive path + raw truncation. */
export function baselineSummaries(region: ImportedRegion): { extractive: string; rawTruncation: string } {
  const serialized = serializeRegionText(region)
  const maxChars = summaryCharBudget(region.tokens, SUMMARY_OUTPUT_SHARE)
  const extractive = extractiveSummary(
    region.messages.map(message => ({ role: message.role, text: messageText(message) })),
    { reason: 'bench baseline' },
  )
  return {
    extractive,
    rawTruncation: serialized.length > maxChars
      ? serialized.slice(0, maxChars) + '\n…[truncated]'
      : serialized,
  }
}
