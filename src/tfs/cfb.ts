// Minimal reader for OLE compound files (Compound File Binary, "d0 cf 11 e0"), the
// container Windows uses for embedded OLE objects.

import { dataView } from './container.ts'

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const END_OF_CHAIN = 0xfffffffe
const FREE = 0xffffffff

export interface CfbStream {
  /** stream name (without its storage path) */
  name: string
  data: Uint8Array
}

/** Offset of a compound file signature within the first `limit` bytes, or -1. */
export function findCompoundFile(b: Uint8Array, limit = 512): number {
  outer: for (let i = 0; i + 8 <= Math.min(b.length, limit + 8); i++) {
    for (let k = 0; k < 8; k++) if (b[i + k] !== SIGNATURE[k]) continue outer
    return i
  }
  return -1
}

/** Lists all streams of a compound file. Damaged chains end the stream early instead of throwing. */
export function readCompoundFile(b: Uint8Array): CfbStream[] {
  if (b.length < 512 || findCompoundFile(b, 0) !== 0) return []
  const v = dataView(b)
  const sectorSize = 1 << v.getUint16(0x1e, true)
  const miniSize = 1 << v.getUint16(0x20, true)
  if (sectorSize < 128 || sectorSize > 65536 || miniSize > sectorSize) return []
  const numFat = v.getUint32(0x2c, true)
  const firstDir = v.getUint32(0x30, true)
  const cutoff = v.getUint32(0x38, true)
  const firstMiniFat = v.getUint32(0x3c, true)
  let difatSector = v.getUint32(0x44, true)
  const numDifat = v.getUint32(0x48, true)
  const sectors = Math.floor((b.length - sectorSize) / sectorSize) + 1
  const offset = (s: number) => (s + 1) * sectorSize
  // counts from the header cannot exceed the sectors the file has (guards damaged / hostile input)
  const fatCount = Math.min(numFat, sectors)
  const difatCount = Math.min(numDifat, sectors)

  // FAT sector list: 109 entries in the header, then DIFAT sectors
  const fatSectors: number[] = []
  for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) fatSectors.push(v.getUint32(0x4c + i * 4, true))
  const seenDifat = new Set<number>()
  for (let n = 0; n < difatCount && difatSector < sectors && !seenDifat.has(difatSector) && fatSectors.length < fatCount; n++) {
    seenDifat.add(difatSector)
    const o = offset(difatSector)
    const per = sectorSize / 4 - 1
    for (let i = 0; i < per && fatSectors.length < fatCount; i++) fatSectors.push(v.getUint32(o + i * 4, true))
    difatSector = v.getUint32(o + per * 4, true)
  }
  const fat = new Uint32Array(fatSectors.length * (sectorSize / 4))
  fatSectors.forEach((s, i) => {
    if (s >= sectors) return
    const o = offset(s)
    for (let k = 0; k < sectorSize / 4 && o + k * 4 + 4 <= b.length; k++) fat[i * (sectorSize / 4) + k] = v.getUint32(o + k * 4, true)
  })

  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = []
    let s = start
    while (s !== END_OF_CHAIN && s !== FREE && s < limit && out.length <= table.length) {
      out.push(s)
      s = table[s] ?? END_OF_CHAIN
    }
    return out
  }
  const readChain = (start: number, size: number): Uint8Array => {
    const list = chain(start, fat, sectors)
    const out = new Uint8Array(Math.min(size, list.length * sectorSize))
    list.forEach((s, i) => {
      const at = i * sectorSize
      if (at >= out.length) return
      const o = offset(s)
      out.set(b.subarray(o, Math.min(o + sectorSize, o + out.length - at, b.length)), at)
    })
    return out
  }

  const dir = readChain(firstDir, Number.MAX_SAFE_INTEGER)
  const dv = dataView(dir)
  const entries: { name: string; type: number; start: number; size: number }[] = []
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = Math.min(dv.getUint16(o + 0x40, true), 64)
    let name = ''
    for (let k = 0; k + 2 < nameLen; k += 2) name += String.fromCharCode(dv.getUint16(o + k, true))
    entries.push({ name, type: dir[o + 0x42], start: dv.getUint32(o + 0x74, true), size: dv.getUint32(o + 0x78, true) })
  }
  const root = entries.find((e) => e.type === 5)
  const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0)
  const miniFatBytes = firstMiniFat < sectors ? readChain(firstMiniFat, Number.MAX_SAFE_INTEGER) : new Uint8Array(0)
  const miniFat = new Uint32Array(miniFatBytes.length >> 2)
  const mv = dataView(miniFatBytes)
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = mv.getUint32(i * 4, true)

  const streams: CfbStream[] = []
  for (const e of entries) {
    if (e.type !== 2) continue
    let data: Uint8Array
    if (e.size < cutoff) {
      const list = chain(e.start, miniFat, Math.floor(miniStream.length / miniSize))
      data = new Uint8Array(Math.min(e.size, list.length * miniSize))
      list.forEach((s, i) => {
        const at = i * miniSize
        if (at < data.length) data.set(miniStream.subarray(s * miniSize, s * miniSize + Math.min(miniSize, data.length - at)), at)
      })
    } else data = readChain(e.start, e.size)
    streams.push({ name: e.name, data })
  }
  return streams
}
