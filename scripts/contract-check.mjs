#!/usr/bin/env node
/**
 * Host-contract and redaction regression check — plain `node --test`, no vitest.
 *
 * WHY this file exists: the repo deliberately carries no unit-test suite
 * (see docs/wiki/05-running.md), but two classes of SILENT regression were
 * measured in the wild, and neither one throws:
 *   1. a host event shape read one level off — `tool/result`'s error flag
 *      lives at `data.message.isError`; reading `data.isError` pinned the
 *      fold-timing `recentErrors` signal to 0 for the plugin's whole life;
 *   2. credential-shaped text crossing the redaction line into artifacts
 *      that are re-injected into every later request.
 * These assertions run against the COMPILED module (dist/), so they check
 * what actually ships:
 *   npm run build && npm run test:contract
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const dist = new URL('../dist/', import.meta.url)
if (!existsSync(new URL('redact.js', dist)) || !existsSync(new URL('event-shapes.js', dist))) {
  console.error('dist/ missing — run `npm run build` first (this check tests the shipped module).')
  process.exit(2)
}
const { isToolResultError } = await import(new URL('event-shapes.js', dist))
const { redactCredentials } = await import(new URL('redact.js', dist))

test('tool/result error flag: message.isError, never data.isError', () => {
  assert.equal(isToolResultError({ message: { isError: true } }), true)
  assert.equal(isToolResultError({ isError: true }), false, 'pins the exact past bug: a top-level isError is NOT the host shape')
  assert.equal(isToolResultError({ message: { content: [] } }), false)
  assert.equal(isToolResultError(undefined), false)
  assert.equal(isToolResultError(null), false)
})

const redaction = [
  // Qualified key names with underscore joins: the class the old \b missed.
  ['OPENAI_API_KEY=sk-proj-abcdefghijklmnop', 'OPENAI_API_KEY=[REDACTED]'],
  ['CLIENT_SECRET=hunter22xx', 'CLIENT_SECRET=[REDACTED]'],
  ['ANTHROPIC_AUTH_TOKEN=abc123def456', 'ANTHROPIC_AUTH_TOKEN=[REDACTED]'],
  ['export MY_PASSWORD=correcthorse', 'export MY_PASSWORD=[REDACTED]'],
  ['"token": "abcd1234efgh"', '"token": [REDACTED]'], // the quoted value goes whole: the marker keeps nothing
  // Plain and spaced forms still work.
  ['password = hunter2', 'password = [REDACTED]'],
  ['x-api-key: abcdef012345', 'x-api-key: [REDACTED]'],
  // CJK forms.
  ['密码：correcthorse', '密码：[REDACTED]'],
  // URL / DSN userinfo: password masked, scheme+user kept, port-only URLs untouched.
  ['postgres://admin:p@ssw0rd@db.internal:5432/app', 'postgres://admin:[REDACTED]@db.internal:5432/app'],
  ['http://localhost:8080/api/v1', 'http://localhost:8080/api/v1'],
  // Port + query/fragment containing `@`: the port must NOT be eaten as a
  // password — the userinfo value excludes `/ ? #` for exactly this.
  ['http://example.com:8080/callback?email=a@b.com', 'http://example.com:8080/callback?email=a@b.com'],
  ['http://host:3000/status?user=joe@corp', 'http://host:3000/status?user=joe@corp'],
  ['http://h:9090/x#frag@tag', 'http://h:9090/x#frag@tag'],
  // A DSN with port AND path and a real password still redacts.
  ['redis://user:pa:ss@host:6379/0', 'redis://user:[REDACTED]@host:6379/0'],
  // Well-known shapes.
  ['key sk-abcdefghijklmnopqrstuvwx', 'key [REDACTED]'],
  ['AIzaSyD-abcdefghijklmnopqrstuvwxyz12345', '[REDACTED]'],
  ['https://hooks.slack.com/services/EXAMPLE-FAKE/NOT-A-REAL-WEBHOOK', '[REDACTED]'],
]
for (const [input, expected] of redaction) {
  test(`redacts: ${input.slice(0, 40)}`, () => {
    assert.equal(redactCredentials(input), expected)
  })
}

test('idempotent: already-redacted text passes through unchanged', () => {
  const once = redactCredentials('OPENAI_API_KEY=sk-proj-abcdefghijklmnop and 密码：correcthorse')
  assert.equal(redactCredentials(once), once)
})

test('leaves ordinary prose alone', () => {
  const prose = 'The token is expired, best_token_count = 5; see http://host:3000/status'
  assert.equal(redactCredentials(prose), prose)
})

/* -------------------------------------------------------------------------- */
/*  Reasoning-parameter refusals (issue #2 — 安装插件后，dsh无法使用)           */
/*                                                                            */
/*  A gateway that maps an OpenAI-compatible body onto Anthropic's schema      */
/*  answers `thinking: { type: 'enabled' }` (the deepseek/zai reasoning        */
/*  dialect sends no budget) with a serde refusal naming `budget_tokens`.      */
/*  Resending that body can never succeed, so the plugin must classify it as   */
/*  a configuration refusal: long fold cooldown, and no invented thinking      */
/*  level on the next compaction call. These pin the wording, because the      */
/*  failure is silent for the planner if the pattern drifts.                   */
/* -------------------------------------------------------------------------- */

const { isReasoningConfigRejection, failureCooldownFor, GOV_CONFIG_ERROR_COOLDOWN } =
  await import(new URL('compaction-governance.js', dist))

const issue2Message = 'Invalid JSON data: Failed to deserialize the JSON body into the target type: '
  + 'thinking: missing field `budget_tokens` at line 1 column 473476'

const reasoningRefusals = [
  // The exact report in issue #2 (code INVALID_REQUEST from pi-ai's classifier).
  [issue2Message, 'INVALID_REQUEST'],
  // The same refusal quoted without the code.
  ["thinking: missing field 'budget_tokens'", undefined],
  ['thinking: missing field `budget_tokens`', undefined],
  ['max_tokens must be greater than budget_tokens', 'INVALID_REQUEST'],
  // DSH's own seam refusal.
  ['pi-ai provider "acme" model "acme-large" does not support reasoning effort "high"', 'UNSUPPORTED_REASONING_EFFORT'],
  ['UNSUPPORTED_REASONING_EFFORT', undefined],
  ['the model does not support reasoning', undefined],
]
for (const [message, code] of reasoningRefusals) {
  test(`reasoning refusal recognized: ${message.slice(0, 46)}`, () => {
    assert.equal(isReasoningConfigRejection(message, code), true)
  })
}

const notReasoningRefusals = [
  // Same INVALID_REQUEST code, different body problem: must NOT be treated as
  // a reasoning refusal (the fold must keep trying after a size cap clears).
  ['HTTP 413: request body too large', 'INVALID_REQUEST'],
  ['Failed to buffer the request body: length limit exceeded', 'INVALID_REQUEST'],
  // Transient faults.
  ['429 Too Many Requests: rate limit exceeded', 'RATE_LIMIT'],
  ['upstream stream ended before message_stop', 'TRANSPORT'],
  ['context length exceeded: 210000 tokens > 128000 window', 'CONTEXT_WINDOW_EXCEEDED'],
  ['', undefined],
]
for (const [message, code] of notReasoningRefusals) {
  test(`not a reasoning refusal: ${message.slice(0, 46) || '(empty)'}`, () => {
    assert.equal(isReasoningConfigRejection(message, code), false)
  })
}

test('a reasoning refusal backs the fold lane off with the config cooldown', () => {
  assert.equal(
    failureCooldownFor(0, issue2Message, 3, 'INVALID_REQUEST'),
    GOV_CONFIG_ERROR_COOLDOWN,
    'one refused body must not be retried every few rounds (issue #2 report: dsh unusable)',
  )
  // A transient fault still takes the short cooldown.
  assert.equal(failureCooldownFor(0, '429 rate limit exceeded', 3, 'RATE_LIMIT'), 3)
  // And a longer backoff already in force is never shortened by a later fault.
  assert.equal(failureCooldownFor(GOV_CONFIG_ERROR_COOLDOWN, '429 rate limit exceeded', 3, 'RATE_LIMIT'), GOV_CONFIG_ERROR_COOLDOWN)
})
