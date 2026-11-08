import { describe, expect, it } from 'vitest'
import { REDACTED, redactCredentials } from '../src/redact.ts'
import { isUserAuthored } from '../src/memory-compaction.ts'

describe('redactCredentials', () => {
  it('masks key-value assignments, keeping the key', () => {
    expect(redactCredentials('password=hunter2'))
      .toBe(`password=${REDACTED}`)
    expect(redactCredentials('API_KEY: "sk-1234567890abcdef1234"'))
      .toBe(`API_KEY: ${REDACTED}`)
    expect(redactCredentials('db.passwd = ' + 'a'.repeat(20)))
      .toBe(`db.passwd = ${REDACTED}`)
  })

  it('masks CJK credential labels', () => {
    expect(redactCredentials('密码：960131')).toBe(`密码：${REDACTED}`)
    expect(redactCredentials('访问令牌 = abc123def456')).toBe(`访问令牌 = ${REDACTED}`)
  })

  it('masks the piped sudo password (the production case)', () => {
    const text = "printf '%s\\n' '960131' | sudo -S snap remove --purge core22"
    expect(redactCredentials(text)).not.toContain('960131')
    expect(redactCredentials(text)).toContain('| sudo -S')
  })

  it('masks well-known token shapes', () => {
    expect(redactCredentials('key = sk-abcdefghijklmnopqrstuvwx'))
      .toBe(`key = ${REDACTED}`)
    expect(redactCredentials('Authorization: Bearer abc.def.ghi-jkl_0123456789'))
      .toBe(`Authorization: ${REDACTED}`)
    expect(redactCredentials('github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'))
      .toBe(REDACTED)
  })

  it('masks PEM private-key blocks whole', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\nabc\ndef\n-----END RSA PRIVATE KEY-----'
    expect(redactCredentials(`before ${pem} after`))
      .toBe(`before -----PRIVATE KEY ${REDACTED}----- after`)
  })

  it('leaves ordinary content untouched (conservative by design)', () => {
    const plain = 'sudo snap remove --purge core22\n删除了 3 个 snap\nPASS mark 12 of 20\n密码学导论第 3 章'
    expect(redactCredentials(plain)).toBe(plain)
  })

  it('is idempotent', () => {
    const once = redactCredentials('password=hunter2 and sk-abcdefghijklmnopqrstuvwx')
    expect(redactCredentials(once)).toBe(once)
  })
})

describe('isUserAuthored (digest source filter)', () => {
  it('accepts real user messages and legacy messages without a source', () => {
    expect(isUserAuthored({ source: { kind: 'user' } })).toBe(true)
    expect(isUserAuthored({})).toBe(true)
    expect(isUserAuthored({ source: null })).toBe(true)
  })

  it('rejects injected artifacts quoting user-shaped text', () => {
    // The production case: a fold checkpoint quoting 'This is an automatically
    // generated checkpoint…' carried source kind compact-checkpoint, and the
    // user-instructions digest quoted it as if the user had said it.
    expect(isUserAuthored({ source: { kind: 'compact-checkpoint' } })).toBe(false)
    expect(isUserAuthored({ source: { kind: 'plugin:dsh-infinite-context' } })).toBe(false)
    expect(isUserAuthored({ source: { kind: 'runtime-context' } })).toBe(false)
    expect(isUserAuthored({ source: { kind: 'time-context' } })).toBe(false)
  })
})
