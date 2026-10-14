// Tfas document reader: container -> layers -> entities -> primitives.
//
// Section 1: document settings (record 1: scale, record 2: paper rect) and tables.
// Section 4: one zlib block per layer. Inside a block:
//   0x1004 layer settings (u32 own-scale flag, u32 scale, u8 visible @8, f64 base height @128)
//   0x1005 u32 flags + layer name
//   0x1006 tagged: ids, layer type (0x1xxxx = layout/sheet), sheet rect
//   0x1008 external reference (xref)
//   0x0002 / 0x0012 entity start (u32 id + u32 kind / u64 id + u64 kind), 0x0005 entity end
//   0x0003 tagged [len, geometry body, len, extension]; entities nest (groups, MEP objects)
//   0x0004 / 0x000c entity properties
// Section 5: preview bitmap.

import { dataView, decodeSjis, inflate, isCompressedRecord, openContainer, records, sectionBytes } from './container.ts'
import { decodeGeometry, decodeText, GeomBuilder, Kind, primFlags, readHeader } from './geometry.ts'
import { emptyRect, isEmptyRect, PrimFlag, unionRect, type EntityInfo, type ImageItem, type AttributeInfo, type Layer, type LayoutInfo, type Rect, type SheetLayout, type Style, type TextFunction, type TextItem, type TfasDocument, type XrefInfo } from './model.ts'
import { decodeTagged, isBytes, isList, type Tagged } from './tagged.ts'
import { readOleObject } from './ole.ts'
import { readTables } from './tables.ts'
import { decodeDib, readThumbnail } from './thumbnail.ts'

export interface ReadOptions {
  /** keep edit-only data (kind flag 0x4) marked with PrimFlag.Hidden */
  keepHidden?: boolean
}

export function readTfas(data: Uint8Array, fileName = '', opts: ReadOptions = {}): TfasDocument {
  const t0 = performance.now()
  const c = openContainer(data)
  const warnings: string[] = []

  let scale = 1
  let paper: Rect = { x0: 0, y0: 0, x1: 841, y1: 594 }
  const sec1 = sectionBytes(c, 1)
  if (sec1) {
    for (const r of records(sec1, 8)) {
      const v = dataView(r.body)
      if (r.type === 1 && r.body.length >= 32) {
        const s = v.getFloat64(24, true)
        if (s > 0 && Number.isFinite(s)) scale = s
      } else if (r.type === 2 && r.body.length >= 32) {
        const p = { x0: v.getFloat64(0, true), y0: v.getFloat64(8, true), x1: v.getFloat64(16, true), y1: v.getFloat64(24, true) }
        if (p.x1 > p.x0 && p.y1 > p.y0) paper = p
      }
    }
  }
  const tables = readTables(sec1, warnings)
  const s24 = readLayoutsAndFunctions(sectionBytes(c, 24))
  const attrColors = new Map<number, number>()
  for (const a of tables.attributes) if (a.color > 0) attrColors.set(a.id, a.color)

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

  const layers: Layer[] = []
  let primitives = 0
  let texts = 0
  let hiddenSkipped = 0
  let decodeErrors = 0
  let oleTotal = 0
  let oleBlank = 0
  let olePartial = 0
  const sec4 = sectionBytes(c, 4)
  if (!sec4) warnings.push('図形セクションがありません')
  else {
    for (const r of records(sec4, 8)) {
      if (!isCompressedRecord(r)) continue
      const index = layers.length
      const g = new GeomBuilder()
      const layer: Layer = {
        index,
        name: `layer ${index}`,
        visible: true,
        color: { mode: 'entity', color: 0 },
        scale,
        layout: null,
        xref: null,
        geom: g.finish(),
        texts: [],
        images: [],
        entities: [],
        bbox: null,
      }
      const entities: EntityInfo[] = layer.entities
      const layerTexts: TextItem[] = []
      // entity stack: kind of each open entity and the image being assembled for it
      const kinds: number[] = []
      let image: (ImageItem & { dib: Uint8Array | null }) | null = null
      let layerFlags = 0
      let monoFlag = false
      try {
        const block = inflate(r.body)
        for (const rec of records(block, 1)) {
          const b = rec.body
          switch (rec.type) {
            case 0x1004:
              if (b.length >= 9) {
                const v = dataView(b)
                if (v.getUint32(0, true) === 1 && v.getUint32(4, true) > 0) layer.scale = v.getUint32(4, true)
                // byte 8: shown, byte 11: current layer (always shown by Tfas)
                layer.visible = b[8] !== 0 || (b.length > 11 && b[11] !== 0)
                layer.current = b.length > 11 && b[11] !== 0
                layer.editable = b.length > 10 && b[10] !== 0
                // byte 12: 単色指定 (shown in the sheet color unless it is the current sheet)
                monoFlag = b.length > 12 && b[12] !== 0
                // シート基準高さ: f64 @128, floor flag @136, floor name @137
                if (b.length >= 137) {
                  const e = v.getFloat64(128, true)
                  if (Number.isFinite(e) && Math.abs(e) < 1e7) layer.elevation = e
                  if (b[136] === 1) layer.floor = decodeSjis(b.subarray(137, Math.min(b.length, 160)))
                }
              }
              break
            case 0x1005:
              if (b.length > 4) {
                layerFlags = dataView(b).getUint32(0, true)
                layer.name = decodeSjis(b.subarray(4))
              }
              break
            case 0x1006:
              layer.layout = readSheetLayout(b)
              break
            case 0x1008:
              layer.xref = readXref(b)
              break
            case 0x0002:
            case 0x0012: {
              const kind = rec.type === 2 ? dataView(b).getUint32(4, true) : Number(dataView(b).getBigUint64(8, true) & 0xffffffffn)
              if (!kinds.length) {
                const id = rec.type === 2 ? dataView(b).getUint32(0, true) : Number(dataView(b).getBigUint64(0, true) & 0xffffffffn)
                g.entity = entities.length
                entities.push({ kind: kind & 0x3fffffff, id })
              }
              kinds.push(kind & 0xffff)
              if ((kind & 0xffff) === 0x165 || (kind & 0xffff) === 0x160) {
                image = { kind: (kind & 0xffff) === 0x165 ? 'raster' : 'ole', name: '', corners: [], bitmap: null, encoded: null, bbox: emptyRect(), dib: null, entity: g.entity }
              }
              break
            }
            case 0x0005: {
              const closed = kinds.pop()
              if (image && (closed === 0x165 || closed === 0x160)) {
                if (image.corners.length === 8) {
                  if (image.kind === 'ole') {
                    // OLE frames run bottom-left, top-left, top-right, bottom-right; use the
                    // raster order (bottom-left, bottom-right, top-right, top-left)
                    const c = image.corners
                    image.corners = [c[0], c[1], c[6], c[7], c[4], c[5], c[2], c[3]]
                    oleTotal++
                    if (!image.bitmap && !image.encoded) oleBlank++
                  }
                  if (image.dib) image.bitmap = decodeDib(image.dib)
                  const { dib: _dib, ...item } = image
                  layer.images.push(item)
                }
                image = null
              }
              break
            }
            case 0x0007:
              if (image?.kind === 'ole') {
                // a damaged embedded object only loses its picture, not the sheet
                try {
                  const ole = readOleObject(b)
                  image.name = ole.label
                  image.bitmap = ole.bitmap
                  image.encoded = ole.encoded
                  if (ole.skipped) olePartial++
                } catch {
                  olePartial++
                }
              }
              break
            case 0x0004:
              if (image && b.length > 8) {
                const v = dataView(b)
                // u32 format + data: 0 = DIB, 1 = JPEG (PNG detected by signature); u32 2 = file name
                const data = b.subarray(4)
                if (v.getUint32(0, true) === 0 && v.getUint32(4, true) === 40) image.dib = data
                else if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) image.encoded = { mime: 'image/jpeg', data: data.slice() }
                else if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) image.encoded = { mime: 'image/png', data: data.slice() }
                else if (v.getUint32(0, true) === 2) image.name = decodeSjis(data)
              }
              break
            case 0x0003: {
              const body = geometryBody(b)
              if (!body || body.length < 16) break
              const h = readHeader(dataView(body))
              if (image && image.corners.length === 0 && (h.kind === Kind.Polyline || h.kind === Kind.Polygon) && body.length >= 24 + 64) {
                const v = dataView(body)
                if (v.getUint32(16, true) >= 4) {
                  for (let k = 0; k < 8; k++) image.corners.push(v.getFloat64(24 + 8 * k, true))
                  for (let k = 0; k < 8; k += 2) {
                    image.bbox = unionRect(image.bbox, { x0: image.corners[k], y0: image.corners[k + 1], x1: image.corners[k], y1: image.corners[k + 1] })
                  }
                }
                break
              }
              const flags = primFlags(h)
              if (flags & PrimFlag.Hidden && !opts.keepHidden) {
                hiddenSkipped++
                break
              }
              // Display color: the entity's own color; inherited colors (bit 31) follow the
              // sheet color, or the layer (attribute) color for layer group 1. An earlier
              // rule that preferred layer colors for some groups was disproved by the official Tfas
              // manual (a red 分割枠 on a white layer) and by preview statistics.
              const attrColor = attrColors.get(h.attr)
              let color = h.color
              if (h.colorInherited) color = h.attrSet === 0 && attrColor ? attrColor : (layerFlags & 0xff) || attrColor || h.color
              const style = styleOf(color, h.linetype, h.width)
              try {
                if (h.kind === Kind.Text) {
                  const t = decodeText(body, style, flags, scale)
                  if (t) {
                    t.entity = g.entity
                    t.attr = h.attr
                    layerTexts.push(t)
                  }
                } else if (((g.attr = h.attr), decodeGeometry(body, h, style, flags, g))) {
                  primitives++
                }
              } catch {
                decodeErrors++
              }
              break
            }
          }
        }
      } catch (e) {
        warnings.push(`レイヤ ${index} (${layer.name}) の解析に失敗: ${(e as Error).message}`)
      }
      layer.monoColor = monoFlag ? layerFlags & 0xff : 0
      if (layerFlags & 0x100) layer.color = { mode: 'gray', color: 0 }
      else if (layer.monoColor && !layer.current) layer.color = { mode: 'layer', color: layer.monoColor }
      layer.geom = g.finish()
      layer.texts = layerTexts
      texts += layerTexts.length
      let bb = g.bbox
      for (const t of layerTexts) bb = unionRect(bb, t.bbox)
      for (const im of layer.images) bb = unionRect(bb, im.bbox)
      layer.bbox = isEmptyRect(bb) ? null : bb
      layers.push(layer)
    }
  }

  if (decodeErrors) warnings.push(`${decodeErrors} 個の図形を解釈できずスキップしました`)
  if (oleBlank) warnings.push(`埋め込みオブジェクト ${oleTotal} 個のうち ${oleBlank} 個は表示用の画像データがないため枠のみ表示しています`)
  if (olePartial) warnings.push(`埋め込みオブジェクト ${olePartial} 個は図形・文字の一部を表示できていません (画像部分のみ表示)`)
  return {
    fileName,
    version: c.version,
    scale,
    paper,
    layouts: s24.layouts,
    layers,
    styles,
    linetypes: tables.linetypes,
    thumbnail: readThumbnail(sectionBytes(c, 5)),
    functions: s24.functions,
    attributes: tables.attributes.map((a): AttributeInfo => ({ id: a.id, name: a.name, group: ((a.id >>> 24) & 0x7f) + 1, color: a.color })),
    warnings,
    stats: { primitives, texts, hiddenSkipped, parseMs: Math.round(performance.now() - t0) },
  }
}

/** Type-3 records are tagged [i32 len, bytes body, ...]; take the fast path when possible. */
export function geometryBody(b: Uint8Array): Uint8Array | null {
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

/** Hex id of a [lo, hi] u32 pair, as used by the layout list in section 24. */
function hexId(v: Tagged): string {
  if (!isList(v) || typeof v[0] !== 'number' || typeof v[1] !== 'number') return ''
  const h = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0')
  return h(v[0]) + h(v[1])
}

/**
 * 0x1006: [[id, type, layout id, model id, ?, 12 doubles, ...]]. Type bit 0x10000 marks
 * sheets that belong to a layout (0x10: the current sheet of its layout). The doubles are
 * the viewport: origin, u, v, placement (x y z each). Further on, lists name the model
 * sheets the viewport shows ([count, (len, name)...]) or the layers it hides
 * ([bytes, count, (len, name)...]).
 */
function readSheetLayout(b: Uint8Array): SheetLayout | null {
  try {
    const v = decodeTagged(b, true)[0]
    if (!isList(v) || typeof v[1] !== 'number' || !(v[1] & 0x10000)) return null
    const d = v.slice(5, 17).map((x) => (typeof x === 'number' ? x : 0))
    const viewport =
      Math.hypot(d[3], d[4]) > 0 && Math.hypot(d[6], d[7]) > 0
        ? { origin: [d[0], d[1]] as [number, number], u: [d[3], d[4]] as [number, number], v: [d[6], d[7]] as [number, number], place: [d[9], d[10]] as [number, number] }
        : null
    let showSheets: string[] | null = null
    const frozenLayers: string[] = []
    for (const x of v.slice(17)) {
      if (!isList(x) || !x.some(isBytes)) continue
      const names = x.filter((y): y is Uint8Array => isBytes(y) && y.length > 0 && !(y === x[0]))
      if (typeof x[0] === 'number') showSheets = [...(showSheets ?? []), ...names.map((n) => decodeSjis(n))]
      else frozenLayers.push(...names.map((n) => decodeSjis(n)))
    }
    return { layoutId: hexId(v[2]), layoutCurrent: (v[1] & 0x10) !== 0, viewport, showSheets, frozenLayers }
  } catch {
    return null
  }
}

/**
 * Section 24, record 1: u32, u32 length, then CP932 XML:
 * <WordFunction><Layout id name/>... <WordFunction name value><Layout id value/>...</WordFunction></WordFunction>
 */
function readLayoutsAndFunctions(sec: Uint8Array | null): { layouts: LayoutInfo[]; functions: TextFunction[] } {
  const out = { layouts: [] as LayoutInfo[], functions: [] as TextFunction[] }
  if (!sec) return out
  try {
    for (const r of records(sec, 8)) {
      if (r.type !== 1) continue
      const body = isCompressedRecord(r) ? inflate(r.body) : r.body
      const at = body.indexOf(0x3c)
      if (at < 0) continue
      const xml = sjisFull.decode(body.subarray(at)).replace(/\0[\s\S]*$/, '')
      const attr = (tag: string, name: string) => {
        const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
        return m ? unescapeXml(m[1]) : null
      }
      // top level layouts: <Layout id name/> directly under the root
      const root = xml.replace(/<WordFunction\s[^>]*?(\/>|>[\s\S]*?<\/WordFunction>)/g, '')
      for (const m of root.matchAll(/<Layout\s[^>]*>/g)) {
        const id = attr(m[0], 'id')
        const name = attr(m[0], 'name')
        if (id && name !== null) out.layouts.push({ id, name })
      }
      for (const m of xml.matchAll(/<WordFunction\s([^>]*?)(\/>|>([\s\S]*?)<\/WordFunction>)/g)) {
        const name = attr(m[1], 'name')
        if (!name) continue
        const f: TextFunction = { name, value: attr(m[1], 'value') ?? '', layouts: {} }
        for (const l of (m[3] ?? '').matchAll(/<Layout\s[^>]*>/g)) {
          const id = attr(l[0], 'id')
          const value = attr(l[0], 'value')
          if (id && value !== null) f.layouts[id] = value
        }
        out.functions.push(f)
      }
    }
  } catch {
    // optional data
  }
  return out
}

const sjisFull = new TextDecoder('shift_jis')
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** 0x1008: 8 bytes, u32, then length-prefixed strings: directory, file, ?, ?, ?, layer name, ... */
function readXref(b: Uint8Array): XrefInfo | null {
  const v = dataView(b)
  const items: Uint8Array[] = []
  let p = 12
  while (p + 4 <= b.length && items.length < 7) {
    const n = v.getUint32(p, true)
    if (n > 2048 || p + 4 + n > b.length) break
    items.push(b.subarray(p + 4, p + 4 + n))
    p += 4 + n
  }
  if (items.length < 6) return null
  const fileName = decodeSjis(items[1])
  if (!fileName) return null
  return { directory: decodeSjis(items[0]), fileName, layerName: decodeSjis(items[5]) }
}

export function documentExtents(doc: TfasDocument, onlyVisible = true): Rect | null {
  let r = emptyRect()
  for (const l of doc.layers) if (l.bbox && (!onlyVisible || l.visible)) r = unionRect(r, l.bbox)
  return isEmptyRect(r) ? null : r
}
