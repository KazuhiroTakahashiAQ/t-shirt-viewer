// Tfas parts library (.NCP, "Tfas 部品データファイル" distributed by manufacturers and
// imported through サブセットライブラリのインポート).
//
// File layout (little endian):
//   0x00  "TFAS"
//   0x08  u32 format (0x16)
//   0x1c  u32 (next free id?)
//   0x40  u32 file size, u32 used entries, u32 entry capacity, u32 index offset (0x58),
//         u32 data offset, u32 data size
//   0x58  index: `capacity` entries of 208 bytes
//           +0x00 char[24] code, e.g. "A06D1$2XXXXXXXX" (XXXXXXXX: the maker's model)
//                 [設備 letter][view digit][class (3)]$2?[呼出しコード]
//           +0x18 char[40] name (CP932, truncated)
//           +0x40 u8 0, u8 1, u8 1, char[9] date "yyyymmdd"
//           +0xa0 u32 1, u32 scale denominator
//           +0xc8 u32 offset (relative to the data area), u32 size
//   data  one record stream per entry (8-byte aligned records, same format as a .tfs
//         layer block but uncompressed): 0x0a, entity start (kind 0x140120 部品),
//         attributes (0x180 name, 0x515 long name, 0x531 "DecTop" 3D model on view 0),
//         the part's own outline, nested primitive entities and 0x540 connection points.
//
// Each part has several entries that differ only in the view digit (0 = plan, used for
// placement, carries the 3D model and connection points; 1.. = other projections).

import { dataView, decodeSjis, records } from './container.ts'
import { decodeGeometry, decodeText, GeomBuilder, Kind, primFlags, readHeader } from './geometry.ts'
import { isEmptyRect, PrimFlag, unionRect, type EntityInfo, type GeomBuffer, type Layer, type Rect, type Style, type TextItem, type TfasDocument } from './model.ts'
import { decodeTagged, isBytes } from './tagged.ts'

export interface NcpEntry {
  index: number
  /** code including the view digit, e.g. "A06D1$2XXXXXXXX" */
  code: string
  /** code with the view digit replaced by 0: the part code used by the MDB catalog */
  partCode: string
  /** view digit (0 = plan) */
  view: number
  /** name stored in the index (truncated to 40 bytes) */
  name: string
  /** yyyymmdd */
  date: string
  /** drawing scale denominator the part was registered with (paper-sized text) */
  scale: number
  /** absolute byte range in the file */
  offset: number
  size: number
}

export interface NcpLibrary {
  data: Uint8Array
  entries: NcpEntry[]
  /** entries per part code (index = view digit order) */
  parts: Map<string, NcpEntry[]>
}

export interface PartConnector {
  x: number
  y: number
  /** 3D position when stored */
  z: number | null
}

export interface PartDrawing {
  /** code of the drawn view (NCP entry code, or the catalog code for preview images) */
  code: string
  /** where the geometry came from: an NCP view, or the catalog's EMF preview image */
  source: 'ncp' | 'image'
  name: string
  longName: string
  /** scale denominator for paper-sized text and built-in line type patterns */
  scale: number
  geom: GeomBuffer
  texts: TextItem[]
  styles: Style[]
  /** entity 0 is the part itself, the following ones its direct children */
  entities: EntityInfo[]
  bbox: Rect | null
  connectors: PartConnector[]
  /** size of the embedded 3D model ("DecTop" attribute) in bytes, 0 when absent */
  model3dBytes: number
  /** primitives that could not be decoded */
  errors: number
}

const ENTRY_SIZE = 208

export class NcpFormatError extends Error {}

export function isNcp(data: Uint8Array): boolean {
  if (data.length < 0x58 || data[0] !== 0x54 || data[1] !== 0x46 || data[2] !== 0x41 || data[3] !== 0x53) return false
  const v = dataView(data)
  return v.getUint32(0x4c, true) === 0x58 && v.getUint32(0x40, true) === data.length
}

/** Parse the index only; drawings are decoded on demand with readNcpEntry. */
export function openNcp(data: Uint8Array): NcpLibrary {
  if (!isNcp(data)) throw new NcpFormatError('Tfas 部品データファイル (.NCP) ではありません')
  const v = dataView(data)
  const capacity = v.getUint32(0x48, true)
  const indexAt = v.getUint32(0x4c, true)
  const dataAt = v.getUint32(0x50, true)
  const dataSize = v.getUint32(0x54, true)
  if (indexAt + capacity * ENTRY_SIZE > dataAt || dataAt + dataSize > data.length) throw new NcpFormatError('NCP の索引が壊れています')
  const entries: NcpEntry[] = []
  const parts = new Map<string, NcpEntry[]>()
  for (let i = 0; i < capacity; i++) {
    const b = indexAt + i * ENTRY_SIZE
    const code = decodeSjis(data.subarray(b, b + 0x18))
    if (!code) continue
    const off = v.getUint32(b + 0xc8, true)
    const size = v.getUint32(b + 0xcc, true)
    if (off + size > dataSize) continue
    const scale = v.getUint32(b + 0xa4, true)
    const digit = code.charCodeAt(1) - 48
    const e: NcpEntry = {
      index: entries.length,
      code,
      partCode: digit >= 0 && digit <= 9 ? `${code[0]}0${code.slice(2)}` : code,
      view: digit >= 0 && digit <= 9 ? digit : 0,
      name: decodeSjis(data.subarray(b + 0x18, b + 0x40)),
      date: decodeSjis(data.subarray(b + 0x43, b + 0x4c)),
      scale: scale > 0 && scale <= 10000 ? scale : 1,
      offset: dataAt + off,
      size,
    }
    entries.push(e)
    let list = parts.get(e.partCode)
    if (!list) parts.set(e.partCode, (list = []))
    list.push(e)
  }
  for (const list of parts.values()) list.sort((a, b) => a.view - b.view)
  return { data, entries, parts }
}

/** Decode one entry (one view of a part) into flat geometry. */
export function readNcpEntry(lib: NcpLibrary, entry: NcpEntry): PartDrawing {
  const buf = lib.data.subarray(entry.offset, entry.offset + entry.size)
  const g = new GeomBuilder()
  const texts: TextItem[] = []
  const styles: Style[] = []
  const styleIndex = new Map<number, number>()
  const styleOf = (color: number, linetype: number, width: number) => {
    const key = color + linetype * 0x10000 + width * 0x80000000
    let i = styleIndex.get(key)
    if (i === undefined) {
      i = styles.length
      styles.push({ color, linetype, width })
      styleIndex.set(key, i)
    }
    return i
  }
  const kinds: number[] = []
  const entities: EntityInfo[] = []
  const connectors: PartConnector[] = []
  let name = ''
  let longName = ''
  let model3dBytes = 0
  let errors = 0
  for (const rec of records(buf, 8)) {
    const b = rec.body
    switch (rec.type) {
      case 0x0002:
      case 0x0012: {
        const kind = rec.type === 2 ? dataView(b).getUint32(4, true) : Number(dataView(b).getBigUint64(8, true) & 0xffffffffn)
        if (kinds.length <= 1) {
          // selectable units: the part, then each of its direct children
          const id = rec.type === 2 ? dataView(b).getUint32(0, true) : Number(dataView(b).getBigUint64(0, true) & 0xffffffffn)
          g.entity = entities.length
          entities.push({ kind: kind & 0x3fffffff, id })
        }
        kinds.push(kind & 0xffff)
        break
      }
      case 0x0005:
        kinds.pop()
        if (kinds.length === 1) g.entity = 0
        break
      case 0x0004:
        if (kinds.length === 1 && b.length >= 8) {
          const id = dataView(b).getUint32(0, true)
          if (id === 0x180 && !name) name = decodeSjis(b.subarray(4))
          else if (id === 0x515 && !longName) longName = decodeSjis(b.subarray(4))
          else if (id === 0x10531) model3dBytes = b.length
        }
        break
      case 0x0003: {
        const body = geometryBody(b)
        if (!body || body.length < 16) break
        const h = readHeader(dataView(body))
        const flags = primFlags(h)
        const inConnector = kinds.includes(0x540)
        if (inConnector) {
          // connection point: a point primitive (aux) plus a hidden 3D polyline
          if (h.kind === Kind.Point && body.length >= 32) {
            const v = dataView(body)
            connectors.push({ x: v.getFloat64(16, true), y: v.getFloat64(24, true), z: null })
          } else if (h.kind === Kind.Polyline3D && body.length >= 48 && connectors.length) {
            const v = dataView(body)
            const last = connectors[connectors.length - 1]
            if (last.z === null) last.z = v.getFloat64(40, true)
          }
          break
        }
        if (flags & PrimFlag.Hidden) break
        const style = styleOf(h.color, h.linetype, h.width)
        try {
          if (h.kind === Kind.Text) {
            const t = decodeText(body, style, flags, entry.scale)
            if (t) {
              t.entity = g.entity
              texts.push(t)
            }
          } else decodeGeometry(body, h, style, flags, g)
        } catch {
          errors++
        }
        break
      }
    }
  }
  let bbox = g.bbox
  for (const t of texts) bbox = unionRect(bbox, t.bbox)
  return {
    code: entry.code,
    source: 'ncp',
    name: name || entry.name,
    longName: longName || name || entry.name,
    scale: entry.scale,
    geom: g.finish(),
    texts,
    styles,
    entities,
    bbox: isEmptyRect(bbox) ? null : bbox,
    connectors,
    model3dBytes,
    errors,
  }
}

/** Wrap a part drawing as a one-layer document so the regular renderers can draw it. */
export function partDocument(d: PartDrawing): TfasDocument {
  const bbox = d.bbox ?? { x0: -500, y0: -500, x1: 500, y1: 500 }
  const layer: Layer = {
    index: 0,
    name: d.name,
    visible: true,
    color: { mode: 'entity', color: 0 },
    scale: d.scale,
    layout: null,
    xref: null,
    geom: d.geom,
    texts: d.texts,
    images: [],
    entities: d.entities,
    bbox: d.bbox,
  }
  return {
    fileName: d.code,
    version: d.source === 'ncp' ? 'NCP' : 'EMF',
    scale: d.scale,
    paper: bbox,
    layouts: [],
    layers: [layer],
    styles: d.styles,
    linetypes: {},
    thumbnail: null,
    functions: [],
    attributes: [],
    warnings: d.errors ? [`${d.errors} 個の図形を解釈できずスキップしました`] : [],
    stats: { primitives: d.geom.count, texts: d.texts.length, hiddenSkipped: 0, parseMs: 0 },
  }
}

function geometryBody(b: Uint8Array): Uint8Array | null {
  if (b.length >= 10 && b[0] === 0x1e && b[5] === 0x0f) {
    const n = dataView(b).getUint32(6, true)
    if (10 + n <= b.length) return b.subarray(10, 10 + n)
  }
  try {
    const v = decodeTagged(b)
    return isBytes(v[1]) ? v[1] : null
  } catch {
    return null
  }
}


/** View digit -> name (order of the 5 面図 registration frame: 平面 in the middle, 正面
 * below, 背面 above, 右側面 / 左側面 beside it). */
export const VIEW_NAMES = ['平面', '正面', '背面', '右側面', '左側面', '下面']

export interface PartModel {
  /** x, y, z per vertex (model mm; x/y as in the plan view, z up) */
  positions: Float64Array
  /** vertex indices, 3 per triangle */
  triangles: Uint32Array
  min: [number, number, number]
  max: [number, number, number]
}

/** Whether the entry carries a 3D model (cheap: only looks at the part's attributes). */
export function hasNcpModel(lib: NcpLibrary, entry: NcpEntry): boolean {
  const buf = lib.data.subarray(entry.offset, entry.offset + entry.size)
  for (const rec of records(buf, 8)) {
    if (rec.type === 0x0004 && rec.body.length > 32 && dataView(rec.body).getUint32(0, true) === 0x10531) return true
    if (rec.type === 0x0003) break
  }
  return false
}

/**
 * Decode the 3D model attached to the plan view (attribute 0x10531). It is a boundary
 * representation ("DecTop"): u32 id, u32 2, u32 length, "DecTop  ", u32 version, u32 size,
 * then chunks [tag, u32 size, data]: ATTR (counts of shells, faces, coedges, edges,
 * vertices) and DATA containing BODY, SHEL, FACE, COED, EDGE and VRTX records.
 *   FACE  u32 id, u32, u32 n, u32 coedge ids[n], ...
 *   COED  u32 id, u32 same-direction flag, u32 face, u32 edge, u32 next, u32 prev, ...
 *   EDGE  u32 id, u32 coedge, u32 coedge (or -1), u32 vertex0, u32 vertex1, ...
 *   VRTX  u32 id, f64 x, y, z, adjacency ...
 */
export function readNcpModel(lib: NcpLibrary, entry: NcpEntry): PartModel | null {
  const buf = lib.data.subarray(entry.offset, entry.offset + entry.size)
  let attr: Uint8Array | null = null
  for (const rec of records(buf, 8)) {
    if (rec.type === 0x0004 && rec.body.length > 32 && dataView(rec.body).getUint32(0, true) === 0x10531) {
      attr = rec.body
      break
    }
    if (rec.type === 0x0003) break
  }
  if (!attr) return null
  const tagAt = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])
  const sig = 12
  if (tagAt(attr, sig) !== 'DecT') return null
  const v = dataView(attr)
  const faces: Uint8Array[] = []
  const coeds = new Map<number, [number, number]>() // id -> [sameDir, edge]
  const edges = new Map<number, [number, number]>() // id -> [v0, v1]
  const verts = new Map<number, number>() // id -> index
  const pos: number[] = []
  const walk = (start: number, end: number, depth: number) => {
    for (let o = start; o + 8 <= end; ) {
      const tag = tagAt(attr!, o)
      const size = v.getUint32(o + 4, true)
      const d = o + 8
      if (d + size > end) break
      if (tag === 'DATA' && depth === 0) walk(d, d + size, 1)
      else if (tag === 'FACE') faces.push(attr!.subarray(d, d + size))
      else if (tag === 'COED' && size >= 16) coeds.set(v.getUint32(d, true), [v.getUint32(d + 4, true), v.getUint32(d + 12, true)])
      else if (tag === 'EDGE' && size >= 20) edges.set(v.getUint32(d, true), [v.getUint32(d + 12, true), v.getUint32(d + 16, true)])
      else if (tag === 'VRTX' && size >= 28) {
        verts.set(v.getUint32(d, true), pos.length / 3)
        pos.push(v.getFloat64(d + 4, true), v.getFloat64(d + 12, true), v.getFloat64(d + 20, true))
      }
      o = d + size
    }
  }
  walk(sig + 16, attr.length, 0)
  const tris: number[] = []
  for (const f of faces) {
    const fv = dataView(f)
    const n = f.length >= 12 ? fv.getUint32(8, true) : 0
    if (n < 3 || 12 + n * 4 > f.length) continue
    const loop: number[] = []
    for (let i = 0; i < n; i++) {
      const c = coeds.get(fv.getUint32(12 + i * 4, true))
      const e = c && edges.get(c[1])
      const vi = e && verts.get(c[0] ? e[0] : e[1])
      if (vi === undefined) break
      loop.push(vi)
    }
    if (loop.length !== n) continue
    for (let i = 1; i + 1 < n; i++) tris.push(loop[0], loop[i], loop[i + 1])
  }
  if (!tris.length) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < min[k]) min[k] = pos[i + k]
      if (pos[i + k] > max[k]) max[k] = pos[i + k]
    }
  }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tris), min, max }
}
