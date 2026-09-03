import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
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
const iso = (ms) => new Date(ms).toISOString().slice(11, 23) + 'Z'

// 1) full turn-33 tool/call
console.log('=== TURN 33 FULL tool/call ===')
for (const r of rows) {
  if (r.type === 'tool/call' && r.data?.turn === 33) console.log(iso(r.time), JSON.stringify(r))
}
// 2) last events of turn 32 (what was interrupted before)
console.log('=== TURN 32 TAIL (last 25 events) ===')
let t32 = rows.filter(r => r.data?.turn === 32 || r.data?.turn === 31)
for (const r of t32.slice(-25)) {
  const type = r.type || 'raw'
  const s = JSON.stringify(r)
  console.log(iso(r.time ?? r.time0), type, s.length > 330 ? s.slice(0, 330) + '…' : s)
}
// 3) abort/stop/cancel/error markers across whole file
console.log('=== ABORT/STOP/CANCEL/ERROR markers (last 30) ===')
const re = /abort|Abort|stop|Stop|cancel|Cancel|interrupt|Interrupt|error|Error|EMPTY|TRANSPORT|timeout|failed|FAILED/i
let n = 0
for (const r of rows) {
  const s = JSON.stringify(r)
  if (re.test(s) && !s.includes('reasoning')) { n++; if (n <= 30) console.log(iso(r.time ?? r.time0), r.type || 'raw', s.slice(0, 300)) }
}
console.log('MARKER_COUNT', n)
