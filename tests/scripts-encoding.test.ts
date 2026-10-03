import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

function scriptBytes(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL('../scripts/' + name, import.meta.url)))
}

// The installer scripts have encoding requirements that are easy to break with
// an innocent text edit, and the breakage is silent until someone runs them.
describe('installer script encoding', () => {
  it('keeps the UTF-8 BOM on the PowerShell installer', () => {
    // Windows PowerShell 5.1 — the interpreter the .bat invokes, and there is
    // no pwsh 7 on this machine — decodes a BOM-less .ps1 as ANSI/GBK. The
    // Chinese comments then become mojibake and the whole script fails to
    // parse (28 syntax errors), so the BOM is load-bearing, not cosmetic.
    expect(scriptBytes('install-dsh-plugin.ps1').subarray(0, 3).equals(UTF8_BOM)).toBe(true)
  })

  it('keeps the batch installer in the encoding cmd expects', () => {
    const bytes = scriptBytes('install-dsh-plugin.bat')
    expect(bytes.subarray(0, 3).equals(UTF8_BOM)).toBe(false)
    // cmd renders the GBK Chinese under chcp 936; a UTF-8 re-save would
    // garble every message, so strict UTF-8 decoding must fail.
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow()
  })
})
