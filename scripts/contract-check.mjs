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
if (!existsSync(new URL('redact.js', dist))) {
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
