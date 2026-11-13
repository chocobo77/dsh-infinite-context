/**
 * Bench replay CLI: run archived sessions back through a summarization
 * prompt against a LOCAL model, land each summary through the deterministic
 * commit layer, score model vs extractive vs raw-truncation baselines, and
 * write results.json + report.md.
 *
 * Usage:
 *   npx tsx bench/replay.ts --session <id|path> --endpoint <url> --model <name>
 *     [--regions 10] [--target 25000] [--timeout 900000] [--out <dir>] [--no-judge]
 *
 * The judge is the SAME local model (self-judging bias — treat judge columns
 * as directional, the anchor-coverage columns as the hard numbers).
 *
 * @module dsh-infinite-context/bench-replay
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { resolveSessionFile, importSessionRegions } from './import-session.ts'
import { chatCompletion, judgeSummary, type ChatMessage } from './llm-client.ts'
import { baselineSummaries, commitSummaryLayer, scoreVariant, regionMaxTokens, serializeRegionText, type VariantScore } from './score.ts'

const CHECKPOINT_PROMPT = [
  'Summarize the folded conversation segment as a working checkpoint for resuming this work later.',
  'Use EXACTLY these section headings, in this order, each with concise "-" bullets:',
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
  'Preserve EXACT file paths, archive refs, error strings, and numeric facts verbatim — they are anchors a later resume depends on.',
  'Aim for roughly one third of the input size. Omit a section only when the segment has nothing for it.',
].join('\n')

interface Args {
  session?: string
  endpoint?: string
  model?: string
  regions: number
  target: number
  timeout: number
  out?: string
  judge: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { regions: 10, target: 25_000, timeout: 900_000, judge: true }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!
    const value = argv[i + 1]
    switch (key) {
      case '--session': args.session = value; i++; break
      case '--endpoint': args.endpoint = value; i++; break
      case '--model': args.model = value; i++; break
      case '--regions': args.regions = Number(value); i++; break
      case '--target': args.target = Number(value); i++; break
      case '--timeout': args.timeout = Number(value); i++; break
      case '--out': args.out = value; i++; break
      case '--no-judge': args.judge = false; break
      default: throw new Error(`unknown argument: ${key}`)
    }
  }
  if (args.session === undefined) throw new Error('--session <id|path> is required')
  if (args.endpoint === undefined) throw new Error('--endpoint <url> is required (OpenAI-compatible base, e.g. http://127.0.0.1:8080)')
  if (args.model === undefined) throw new Error('--model <name> is required')
  return args
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const sessionId = args.session!
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const sessionFile = resolveSessionFile(home, sessionId)
  const regions = importSessionRegions(sessionFile, { targetTokens: args.target })
  const selected = regions.slice(0, args.regions)
  console.log(`session: ${sessionFile}`)
  console.log(`imported ${regions.length} regions, replaying first ${selected.length}`)
  const outDir = args.out ?? join('bench-results', `${args.session}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(outDir, { recursive: true })

  const scores: VariantScore[] = []
  for (const region of selected) {
    const regionText = serializeRegionText(region)
    const baselines = baselineSummaries(region)
    const variants: { variant: VariantScore['variant']; text: string }[] = []

    // Model variant: real summary through the deterministic commit layer.
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: CHECKPOINT_PROMPT },
        { role: 'user', content: `Folded conversation segment:\n\n${regionText}` },
      ]
      const result = await chatCompletion({
        endpoint: args.endpoint!, model: args.model!, messages, timeoutMs: args.timeout,
        maxTokens: regionMaxTokens(region),
      })
      const committed = commitSummaryLayer(region, result.text)
      variants.push({ variant: 'model', text: committed.text })
      console.log(`region ${region.index}: model summary ${committed.summaryChars} chars `
        + `(evidence missing ${committed.evidenceMissing}${committed.evidenceTruncated ? ', pool truncated' : ''})`)
    } catch (error: unknown) {
      console.log(`region ${region.index}: model call failed: ${error instanceof Error ? error.message : String(error)}`)
      scores.push({
        variant: 'model', regionIndex: region.index, regionTokens: region.tokens, summaryChars: 0,
        anchorTotal: 0, anchorMissing: 0, missingRate: 1, evidenceTruncated: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    variants.push({ variant: 'extractive', text: baselines.extractive })
    variants.push({ variant: 'raw-truncation', text: baselines.rawTruncation })
    for (const { variant, text } of variants) {
      const score = scoreVariant(region, variant, text)
      if (args.judge) {
        try {
          scores.push({ ...score, judge: await judgeSummary({
            endpoint: args.endpoint!, model: args.model!, timeoutMs: args.timeout,
            regionText, summary: text,
          }) })
        } catch (error: unknown) {
          scores.push({ ...score, error: `judge failed: ${error instanceof Error ? error.message : String(error)}` })
        }
      } else {
        scores.push(score)
      }
    }
  }

  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ session: args.session, scores }, null, 2))
  const lines: string[] = [
    `# Replay report — session ${args.session}`,
    '',
    `endpoint ${args.endpoint} / model ${args.model} / ${selected.length} regions / judge ${args.judge ? 'on (self-judging bias)' : 'off'}`,
    '',
    '| variant | regions | mean anchor missing rate | mean faithfulness | mean coverage | mean summary chars |',
    '|---|---|---|---|---|---|',
  ]
  for (const variant of ['model', 'extractive', 'raw-truncation'] as const) {
    const rows = scores.filter(score => score.variant === variant && score.error === undefined)
    const judged = rows.filter(row => row.judge !== undefined)
    lines.push(`| ${variant} | ${rows.length} | ${mean(rows.map(row => row.missingRate)).toFixed(3)} `
      + `| ${judged.length === 0 ? '-' : mean(judged.map(row => row.judge!.faithfulness)).toFixed(2)} `
      + `| ${judged.length === 0 ? '-' : mean(judged.map(row => row.judge!.coverage)).toFixed(2)} `
      + `| ${Math.round(mean(rows.map(row => row.summaryChars)))} |`)
  }
  lines.push('', '## Per-region detail', '')
  for (const score of scores) {
    lines.push(`- region ${score.regionIndex} **${score.variant}**: missing ${score.anchorMissing}/${score.anchorTotal} anchors `
      + `(${(score.missingRate * 100).toFixed(0)}%), ${score.summaryChars} chars`
      + (score.judge === undefined ? '' : `, judge f${score.judge.faithfulness}/c${score.judge.coverage} — ${score.judge.notes}`)
      + (score.error === undefined ? '' : ` — ERROR: ${score.error}`))
  }
  writeFileSync(join(outDir, 'report.md'), lines.join('\n') + '\n')
  console.log(`\nreport: ${join(outDir, 'report.md')}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
