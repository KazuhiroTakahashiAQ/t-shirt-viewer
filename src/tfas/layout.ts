// Model and layout (レイアウト) views. Sheets belonging to a layout are not part of the
// model: a layout shows its own sheets plus viewports, each of which maps a region of the
// model (optionally rotated and at the viewport sheet's scale) onto the layout and clips
// it there. 文字関数 `$(name)` in texts are expanded with the values of the shown layout.

import { textBounds } from './geometry.ts'
import { Prim, type EntityInfo, type GeomBuffer, type ImageItem, type LayerColor, type Rect, type TextItem, type TfasDocument, type Viewport } from './model.ts'

/** Sheet content after external references are resolved. */
export interface SourceSheet {
  geom: GeomBuffer
  texts: TextItem[]
  images: ImageItem[]
  entities: EntityInfo[]
  bbox: Rect | null
  color: LayerColor
}

/** One displayable piece of a view. */
export interface SheetPiece {
  /** document layer (sheet) the content comes from */
  layer: number
  /** document layer of the sheet tab the piece belongs to (the layout sheet for viewports) */
  group: number
  geom: GeomBuffer
  texts: TextItem[]
  images: ImageItem[]
  entities: EntityInfo[]
  bbox: Rect | null
  color: LayerColor
  /** clip polygon (x, y pairs) for viewport content */
  clip: number[] | null
}

/** x' = a x + c y + e, y' = b x + d y + f (similarity transforms) */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export function viewportTransform(vp: Viewport, k: number): Affine {
  const lu = Math.hypot(vp.u[0], vp.u[1])
  const lv = Math.hypot(vp.v[0], vp.v[1])
  const ux = vp.u[0] / lu
  const uy = vp.u[1] / lu
  const vx = vp.v[0] / lv
  const vy = vp.v[1] / lv
  const [ox, oy] = vp.origin
  return { a: k * ux, c: k * uy, e: vp.place[0] - k * (ox * ux + oy * uy), b: k * vx, d: k * vy, f: vp.place[1] - k * (ox * vx + oy * vy) }
}

const apply = (m: Affine, x: number, y: number): [number, number] => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]

function primBox(g: GeomBuffer, i: number): Rect {
  const c = g.coords
  const a = g.offsets[i]
  const e = g.offsets[i + 1]
  const t = g.types[i]
  if (t === Prim.Circle || t === Prim.Arc || t === Prim.Ellipse) {
    const r = t === Prim.Ellipse ? Math.max(c[a + 2], c[a + 3]) : c[a + 2]
    return { x0: c[a] - r, y0: c[a + 1] - r, x1: c[a] + r, y1: c[a + 1] + r }
  }
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (let k = a; k + 1 < e; k += 2) {
    r.x0 = Math.min(r.x0, c[k])
    r.x1 = Math.max(r.x1, c[k])
    r.y0 = Math.min(r.y0, c[k + 1])
    r.y1 = Math.max(r.y1, c[k + 1])
  }
  return r
}

const hits = (a: Rect, b: Rect) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1

/** Copy of the primitives selected by `keep` (e.g. without hidden レイヤ). */
export function filterGeom(g: GeomBuffer, keep: (i: number) => boolean): GeomBuffer {
  return transformGeom(g, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, keep)
}

/** Transformed copy of the primitives selected by `keep`. */
export function transformGeom(g: GeomBuffer, m: Affine, keep: (i: number) => boolean = () => true): GeomBuffer {
  const scale = Math.hypot(m.a, m.b)
  const rot = Math.atan2(m.b, m.a)
  const idx: number[] = []
  let n = 0
  for (let i = 0; i < g.count; i++) {
    if (!keep(i)) continue
    idx.push(i)
    n += g.offsets[i + 1] - g.offsets[i]
  }
  const pick = <T extends Uint8Array | Uint16Array | Uint32Array>(a: T): T => {
    const b = new (a.constructor as { new (n: number): T })(idx.length)
    idx.forEach((i, j) => (b[j] = a[i]))
    return b
  }
  const offsets = new Uint32Array(idx.length + 1)
  const coords = new Float64Array(n)
  let o = 0
  idx.forEach((i, j) => {
    offsets[j] = o
    const a = g.offsets[i]
    const e = g.offsets[i + 1]
    const c = g.coords
    const t = g.types[i]
    if (t === Prim.Circle || t === Prim.Arc || t === Prim.Ellipse) {
      const [x, y] = apply(m, c[a], c[a + 1])
      coords[o] = x
      coords[o + 1] = y
      coords[o + 2] = c[a + 2] * scale
      if (t === Prim.Arc) {
        coords[o + 3] = c[a + 3] + rot
        coords[o + 4] = c[a + 4] + rot
      } else if (t === Prim.Ellipse) {
        coords[o + 3] = c[a + 3] * scale
        coords[o + 4] = c[a + 4] + rot
        coords[o + 5] = c[a + 5]
        coords[o + 6] = c[a + 6]
      }
    } else
      for (let k = a; k + 1 < e; k += 2) {
        const [x, y] = apply(m, c[k], c[k + 1])
        coords[o + k - a] = x
        coords[o + k - a + 1] = y
      }
    o += e - a
  })
  offsets[idx.length] = o
  return { count: idx.length, types: pick(g.types), flags: pick(g.flags), styles: pick(g.styles), offsets, coords, entity: pick(g.entity), attr: pick(g.attr) }
}

export function transformText(t: TextItem, m: Affine): TextItem {
  const s = Math.hypot(m.a, m.b)
  const [x, y] = apply(m, t.x, t.y)
  const out = { ...t, x, y, angle: t.angle + (Math.atan2(m.b, m.a) * 180) / Math.PI, height: t.height * s, width: t.width * s, pitch: t.pitch * s }
  out.bbox = textBounds(out)
  return out
}

export function transformImage(im: ImageItem, m: Affine): ImageItem {
  const corners: number[] = []
  const bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (let k = 0; k < im.corners.length; k += 2) {
    const [x, y] = apply(m, im.corners[k], im.corners[k + 1])
    corners.push(x, y)
    bbox.x0 = Math.min(bbox.x0, x)
    bbox.x1 = Math.max(bbox.x1, x)
    bbox.y0 = Math.min(bbox.y0, y)
    bbox.y1 = Math.max(bbox.y1, y)
  }
  return { ...im, corners, bbox }
}

/** Replace `$(name)` with the function value (layout specific when given); empty values stay as written. */
export function expandFunctions(texts: TextItem[], doc: TfasDocument, layoutId: string | null): TextItem[] {
  if (!doc.functions.length || !texts.some((t) => t.text.includes('$('))) return texts
  const values = new Map<string, string>()
  for (const f of doc.functions) values.set(f.name, (layoutId && f.layouts[layoutId]) || f.value)
  return texts.map((t) => {
    if (!t.text.includes('$(')) return t
    const text = t.text.replace(/\$\(([^)]*)\)/g, (all, name: string) => values.get(name) || all)
    if (text === t.text) return t
    const out = { ...t, text }
    out.bbox = textBounds(out)
    return out
  })
}

function geomBox(g: GeomBuffer, texts: TextItem[], images: ImageItem[]): Rect | null {
  let r: Rect | null = null
  const add = (b: Rect) => {
    if (!(b.x0 <= b.x1)) return
    r = r ? { x0: Math.min(r.x0, b.x0), y0: Math.min(r.y0, b.y0), x1: Math.max(r.x1, b.x1), y1: Math.max(r.y1, b.y1) } : { ...b }
  }
  for (let i = 0; i < g.count; i++) add(primBox(g, i))
  for (const t of texts) add(t.bbox)
  for (const im of images) add(im.bbox)
  return r
}

/** The model: every sheet that does not belong to a layout. */
export function modelPieces(doc: TfasDocument, sources: SourceSheet[]): SheetPiece[] {
  return doc.layers
    .filter((l) => !l.layout)
    .map((l) => {
      const s = sources[l.index]
      return { layer: l.index, group: l.index, ...s, texts: expandFunctions(s.texts, doc, null), clip: null }
    })
}

/** A layout: its sheets' own content and the model regions their viewports show. */
export function layoutPieces(doc: TfasDocument, layoutId: string, sources: SourceSheet[]): SheetPiece[] {
  const out: SheetPiece[] = []
  const attrName = new Map(doc.attributes.map((a) => [a.id, a.name]))
  for (const l of doc.layers) {
    if (l.layout?.layoutId !== layoutId) continue
    const own = sources[l.index]
    if (own.geom.count || own.texts.length || own.images.length) out.push({ layer: l.index, group: l.index, ...own, texts: expandFunctions(own.texts, doc, layoutId), clip: null })
    const vp = l.layout.viewport
    if (!vp) continue
    const k = doc.scale / (l.scale || doc.scale)
    const m = viewportTransform(vp, k)
    const lu = Math.hypot(vp.u[0], vp.u[1]) * k
    const lv = Math.hypot(vp.v[0], vp.v[1]) * k
    const [px, py] = vp.place
    const clip = [px, py, px + lu, py, px + lu, py + lv, px, py + lv]
    // model region bounds (the region may be rotated)
    const pts = [vp.origin, [vp.origin[0] + vp.u[0], vp.origin[1] + vp.u[1]], [vp.origin[0] + vp.v[0], vp.origin[1] + vp.v[1]], [vp.origin[0] + vp.u[0] + vp.v[0], vp.origin[1] + vp.u[1] + vp.v[1]]]
    const region = { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) }
    const frozen = new Set(l.layout.frozenLayers)
    const hidden = (attr: number) => frozen.size > 0 && frozen.has(attrName.get(attr) ?? '')
    const shown = doc.layers.filter((s) => !s.layout && (l.layout!.showSheets ? l.layout!.showSheets.includes(s.name) : s.visible))
    for (const s of shown) {
      const src = sources[s.index]
      if (!src.bbox || !hits(src.bbox, region)) continue
      const geom = transformGeom(src.geom, m, (i) => !hidden(src.geom.attr[i]) && hits(primBox(src.geom, i), region))
      const texts = expandFunctions(
        src.texts.filter((t) => !hidden(t.attr) && hits(t.bbox, region)),
        doc,
        layoutId,
      ).map((t) => transformText(t, m))
      const images = src.images.filter((im) => hits(im.bbox, region)).map((im) => transformImage(im, m))
      if (!geom.count && !texts.length && !images.length) continue
      const bbox = geomBox(geom, texts, images)
      const clipBox = { x0: px, y0: py, x1: px + lu, y1: py + lv }
      out.push({
        layer: s.index,
        group: l.index,
        geom,
        texts,
        images,
        entities: src.entities,
        bbox: bbox && { x0: Math.max(bbox.x0, clipBox.x0), y0: Math.max(bbox.y0, clipBox.y0), x1: Math.min(bbox.x1, clipBox.x1), y1: Math.min(bbox.y1, clipBox.y1) },
        color: src.color,
        clip,
      })
    }
  }
  return out
}

/**
 * Paper area of a layout. The layout's paper size is not known; the viewports (typically
 * one showing the title-block frame across the whole sheet) span it.
 */
export function layoutPaper(doc: TfasDocument, layoutId: string): Rect {
  let r: Rect | null = null
  for (const l of doc.layers) {
    const vp = l.layout?.layoutId === layoutId ? l.layout.viewport : null
    if (!vp) continue
    const k = doc.scale / (l.scale || doc.scale)
    const b = { x0: vp.place[0], y0: vp.place[1], x1: vp.place[0] + Math.hypot(vp.u[0], vp.u[1]) * k, y1: vp.place[1] + Math.hypot(vp.v[0], vp.v[1]) * k }
    r = r ? { x0: Math.min(r.x0, b.x0), y0: Math.min(r.y0, b.y0), x1: Math.max(r.x1, b.x1), y1: Math.max(r.y1, b.y1) } : b
  }
  return r ?? doc.paper
}

/** The layout that holds the current sheet (null: the model). */
export function currentLayout(doc: TfasDocument): string | null {
  const cur = doc.layers.find((l) => l.current)
  return cur?.layout && doc.layouts.some((x) => x.id === cur.layout!.layoutId) ? cur.layout.layoutId : null
}
