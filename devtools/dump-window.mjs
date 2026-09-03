import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const fromEpoch = Number(process.argv[3])
const toEpoch = Number(process.argv[4])
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
const t = (r) => (typeof r.time === 'number' ? r.time : typeof r.time0 === 'number' ? r.time0 : undefined)
const iso = (ms) => new Date(ms).toISOString().slice(11, 23)
let n = 0
for (const r of rows) {
  const ms = t(r); if (ms === undefined || ms < fromEpoch || ms > toEpoch) continue
  n++
  const type = r.type || (r.event ? 'event:' + r.event : 'raw')
  const s = JSON.stringify(r)
  console.log(iso(ms), type, s.length > 260 ? s.slice(0, 260) + '…' : s)
}
console.log('=== ROWS_IN_WINDOW', n, '===')
