// Document level tables stored in section 1 (inside a zlib block):
// record 0x1001 holds the 図形属性 (attribute) table. Entries that introduce a custom
// line type carry its dash definition inline, which is the only place line type
// patterns are stored in the file.

import { dataView, decodeSjis, inflate, isCompressedRecord, records } from './container.ts'
import { decodeTagged, isBytes, isList, type Tagged } from './tagged.ts'

export interface AttributeDef {
  /** attribute id including the set number in bits 24..30 */
  id: number
  name: string
  color: number
  linetype: number
  width: number
}

export interface Tables {
  attributes: AttributeDef[]
  /** line type number -> dash pattern in paper mm */
  linetypes: Record<number, number[]>
}

export function readTables(sec1: Uint8Array | null, warnings: string[]): Tables {
  const out: Tables = { attributes: [], linetypes: {} }
  if (!sec1) return out
  try {
    for (const r of records(sec1, 8)) {
      if (!isCompressedRecord(r)) continue
      for (const inner of records(inflate(r.body), 1)) {
        if (inner.type === 0x1001 && inner.body.length > 8) parseAttributeTable(inner.body.subarray(8), out)
      }
    }
  } catch (e) {
    warnings.push(`属性テーブルの解析に失敗: ${(e as Error).message}`)
  }
  return out
}

function parseAttributeTable(b: Uint8Array, out: Tables) {
  // Attribute sets live in several lists of the table; entries look like
  // [u32 id (high byte = set | 0x80), [.., name], [mode, u32 color, .., u16 linetype, .., u16 width ..], ..]
  const visit = (x: Tagged) => {
    if (!isList(x)) return
    const e = x
    if (isBytes(e[0]) && e[0].length === 4 && isList(e[1]) && isList(e[2]) && isBytes(e[2][1]) && e[2][1].length === 4) addEntry(e, out)
    for (const y of e) visit(y)
  }
  visit(decodeTagged(b, true))
}

function addEntry(e: Tagged[], out: Tables) {
  const id = dataView(e[0] as Uint8Array).getUint32(0, true) & 0x7fffffff
  const nameBytes = (e[1] as Tagged[]).filter(isBytes)
  const name = nameBytes.length >= 2 ? decodeSjis(nameBytes[nameBytes.length - 1]) : ''
  const props = e[2] as Tagged[]
  const color = dataView(props[1] as Uint8Array).getUint32(0, true) & 0xffff
  const twoByte: number[] = []
  let linetype = 1
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    if (!isBytes(p) || p.length !== 2) continue
    twoByte.push(dataView(p).getUint16(0, true) & 0x7fff)
    if (twoByte.length === 1) {
      linetype = twoByte[0]
      const blob = props[i + 2]
      if (isBytes(props[i + 1]) && isBytes(blob) && blob.length >= 168) {
        const pattern = parseLinetype(blob)
        if (pattern && !(linetype in out.linetypes)) out.linetypes[linetype] = pattern
      }
    }
  }
  out.attributes.push({ id, name, color, linetype, width: twoByte[1] ?? 1 })
}

/**
 * Inline line type (imported from DWG): f64 unit scale @16, name @28, f32 cycle length @96,
 * u16 count @110, then (count-1) signed f32 cumulative positions @160 (8-byte stride).
 * Returns the pattern in paper millimetres, or null when it cannot be interpreted.
 */
function parseLinetype(b: Uint8Array): number[] | null {
  const v = dataView(b)
  const unit = v.getFloat64(16, true)
  const count = v.getUint16(110, true)
  if (count < 2 || 160 + (count - 1) * 8 > b.length) return null
  const segs: number[] = []
  let prev = 0
  let lastOn: boolean | null = null
  for (let i = 0; i < count - 1; i++) {
    const p = v.getFloat32(160 + i * 8, true)
    const on = p > 0
    const len = Math.abs(p) - prev
    prev = Math.abs(p)
    if (!(len >= 0) || !Number.isFinite(len)) return null
    if (lastOn === on) segs[segs.length - 1] += len
    else {
      if (lastOn === null && !on) segs.push(0)
      segs.push(len)
    }
    lastOn = on
  }
  if (segs.length % 2 === 1) segs.push(0)
  const total = segs.reduce((a, c) => a + c, 0)
  if (!(total > 0) || segs.every((s, i) => i % 2 === 1 || s === 0)) return null
  // the cycle is stored scaled by `unit`; keep it only when it lands at a plausible paper size
  const paper = unit > 0 ? total / unit : total
  if (!(paper >= 0.8 && paper <= 60)) return null
  const k = paper / total
  return segs.map((s) => s * k)
}

