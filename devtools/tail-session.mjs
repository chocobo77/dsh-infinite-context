import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const tailN = Number(process.argv[3] || 60)
const raw = fs.readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const frames = []
let idx = 0
while (idx < raw.length) {
  const p = raw.indexOf(magic, idx)
  if (p === -1) break
  frames.push(p)
  idx = p + 4
}
const parts = []
for (let f = 0; f < frames.length; f++) {
  const start = frames[f]
  const end = f + 1 < frames.length ? frames[f + 1] : raw.length
  try { parts.push(zlib.zstdDecompressSync(raw.subarray(start, end))) }
  catch (e) { console.log('FRAME', f, 'DECODE_ERR', e.code) }
}
const text = Buffer.concat(parts).toString('utf8')
const lines = text.split('\n').filter(Boolean)
const rows = []
for (const l of lines) { try { rows.push(JSON.parse(l)) } catch { } }

const ts = (r) => {
  for (const k of ['time', 'ts', 'timestamp', 'createdAt', 'at']) {
    const v = r[k]
    if (typeof v === 'number') return new Date(v).toISOString().slice(11, 19)
    if (typeof v === 'string' && !isNaN(Date.parse(v))) return new Date(v).toISOString().slice(11, 19)
  }
  return '??:??:??'
}

console.log('TOTAL_ROWS', rows.length)
console.log('=== LAST', tailN, 'ROWS ===')
for (const r of rows.slice(-tailN)) {
  const t = r.type || (r.event ? 'event:' + r.event : 'raw')
  const s = JSON.stringify(r)
  const short = s.length > 320 ? s.slice(0, 320) + '…' : s
  console.log(ts(r), t, short)
}
console.log('=== ERROR/MARKER MATCHES (last 25) ===')
const markers = /EMPTY_RESPONSE|TRANSPORT|error|Error|abort|Abort|interrupt|Interrupt|overflow|overflow|crash|ECONN|socket|timeout|Insufficient|429|5[0-9][0-9]|context-overflow/i
let m = 0
for (const r of rows.slice(-400)) {
  const s = JSON.stringify(r)
  if (markers.test(s)) {
    m++
    if (m <= 25) console.log(ts(r), (r.type || 'raw'), s.slice(0, 420))
  }
}
console.log('MARKER_TOTAL_IN_LAST_400', m)
