import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const mode = process.argv[3] || 'hist'
const raw = fs.readFileSync(file)
// 按 zstd 魔法头 28 B5 2F FD 切分多帧，逐帧解压拼接
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const frames = []
let i = 0
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
  try {
    parts.push(zlib.zstdDecompressSync(raw.subarray(start, end)))
  } catch (e) {
    console.log('FRAME', f, 'DECODE_ERR', e.code, 'bytes', start, '->', end)
  }
}
const buf = Buffer.concat(parts)
const text = buf.toString('utf8')
const lines = text.split('\n').filter(Boolean)
const rows = []
for (const l of lines) {
  try { rows.push(JSON.parse(l)) } catch { /* skip */ }
}

if (mode === 'sample') {
  console.log('TOTAL_LINES', lines.length, 'PARSED', rows.length)
  const r = rows[0]
  console.log('TOP_KEYS', Object.keys(r))
  for (const k of Object.keys(r)) {
    const v = r[k]
    console.log('KEY', k, 'TYPE', Array.isArray(v) ? 'array[' + v.length + ']' : typeof v)
  }
} else if (mode === 'detail') {
  const want = new Set(process.argv.slice(4))
  const seen = {}
  for (const r of rows) {
    const t = r.type
    if (want.size && !want.has(t)) continue
    seen[t] = (seen[t] || 0) + 1
    if (seen[t] <= 4 || t.includes('compaction')) {
      const data = r.data || r.payload || {}
      console.log('[' + t + ']', JSON.stringify(r).slice(0, 700))
    }
  }
  console.log('=== COUNTS ===', JSON.stringify(seen))
} else if (mode === 'hist') {
  const byType = {}
  for (const r of rows) {
    const t = r.type || (r.event ? 'event:' + r.event : 'raw')
    byType[t] = (byType[t] || 0) + 1
  }
  console.log('TOTAL', rows.length)
  console.log(JSON.stringify(byType, null, 1))
  // memory tool calls + contextWindow carriers
  const memCalls = []
  const ctxEvents = []
  for (const r of rows) {
    const s = JSON.stringify(r)
    if (s.includes('memory_compress') || s.includes('memory_status') || s.includes('memory_model_probe') || s.includes('memory_probe')) memCalls.push(r)
    if (s.includes('contextWindow') && s.length < 4000) ctxEvents.push(r)
  }
  console.log('MEM_TOOL_HITS', memCalls.length, 'CTX_EVENTS', ctxEvents.length)
  for (const r of ctxEvents.slice(0, 5)) console.log('CTX>', JSON.stringify(r).slice(0, 500))
}
