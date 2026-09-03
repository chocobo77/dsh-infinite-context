import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const fromEpoch = Number(process.argv[3])  // inclusive
const toEpoch = Number(process.argv[4])    // inclusive
const raw = fs.readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const frames = []
let idx = 0
while (idx < raw.length) { const p = raw.indexOf(magic, idx); if (p === -1) break; frames.push(p); idx = p + 4 }
const parts = []
for (let f = 0; f < frames.length; f++) {
  const start = frames[f]; const end = f + 1 < frames.length ? frames[f + 1] : raw.length
  try { parts.push(zlib.zstdDecompressSync(raw.subarray(start, end))) } catch (e) { console.log('FRAME', f, 'DECODE_ERR', e.code) }
}
const rows = []
for (const l of Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)) { try { rows.push(JSON.parse(l)) } catch { } }

const t = (r) => {
  const v = r.time ?? r.time0 ?? r.ts
  return typeof v === 'number' ? v : undefined
}
const iso = (ms) => new Date(ms).toISOString().slice(11, 19) + 'Z'

// 1) rows in window
console.log('=== WINDOW', new Date(fromEpoch).toISOString(), '..', new Date(toEpoch).toISOString(), '===')
let inWin = 0
for (const r of rows) {
  const ms = t(r); if (ms === undefined || ms < fromEpoch || ms > toEpoch) continue
  inWin++
  const type = r.type || (r.event ? 'event:' + r.event : 'raw')
  const s = JSON.stringify(r)
  if (s.includes('继续') || /error|abort|Abort|interrupt|cancel|stop|finished|ended|EMPTY|TRANSPORT|429|5\d\d|timedout|timeout/i.test(s) || /user-message|user\/|turn\b/.test(type)) {
    console.log(iso(ms), type, s.length > 400 ? s.slice(0, 400) + '…' : s)
  }
}
console.log('ROWS_IN_WINDOW', inWin)
