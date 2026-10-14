// 3D model of a drawing, built (like Tfas' 3D 表示) from data stored with each object:
//
// - Ducts and pipes (0x500 空調, 0x600 衛生, 0x480): a hidden 3D polyline holds the center
//   line. Straight runs (attribute 0x504 length > 0) store the path; fittings, valves and
//   terminals store the center point followed by one point per connection end. A point
//   W/2 or H/2 off the axis, at right angles to it, orients a rectangular section.
//   Sizes: 0x50a duct W, H (u16 @8, @10), 0x50b nominal pipe size in A (u16 @6),
//   0x517 sleeve size (u16 @0); code 0x503 (DSP… spiral and DFL… flexible ducts are round).
// - Architecture members (0x2xx: 0x201 column, 0x205 wall, 0x207 beam, 0x20a slab,
//   0x20b ceiling …): hidden 3D polyline [base point, base point + extrusion, outline…].
//   The outline is swept along the extrusion vector. Outlines entered by their vertices
//   (slabs) use the base point as their first vertex: it then lies outside the others.
// - Valves (codes ZVLV…): the hidden polyline is [center, end 1, end 2, handle top], and a
//   hidden child (0x508) holds plan outlines tagged by attribute 0x515: 0x10 / 0x11 the
//   connection ends, 0x20 the handle. These are the valve dimensions Tfas registers
//   (L1, L2, H1 from the polyline; D1, D2 and the handle diameter H2 from the outlines).
// - Duct equipment boxes (DSNTSYO… silencer chambers, DSNTBOX… boxes): 0x512 = W, D, H and
//   the polyline [center, center + W/2 along the width, center + H/2 along the height].
// - Parts (0x120 / 0x170 / 0x470): a hidden 4-point polyline is the placement frame
//   (origin, then the ends of the x, y and z axes). An axis 128 long is scale 1: the placed
//   symbol is the part's own drawing (section 3) scaled by |axis| / 128. 0x506 holds the
//   part's outline box [W, D, H, min x, y, z] in part units. The 3D shape itself lives in
//   the parts library, so that box stands in for it. A shape estimated from the part's
//   views (section 3, see partviews.ts) is kept as the object's alternative shape.
//   Electrical symbols are scaled differently; they use 0x446 (W, D, H) when it matches
//   the plan. Parts without either only show their plan shape at their height.
// Sheets drawn at another scale than the drawing (e.g. a 1/10 detail in a 1/50 drawing)
// store coordinates multiplied by drawing scale / sheet scale; sizes from attributes are
// real millimetres and are multiplied by the same factor.
// - Visible 3D polylines (IFC shapes imported as groups of 3D polylines): closed loops
//   become faces, others lines.
// Sheet elevations (シート基準高さ) are in record 0x1004: f64 @128, floor flag @136 and the
// floor name (CP932) @137; u32 @0 = 1 when the sheet has its own scale (u32 @4).

import { dataView, decodeSjis, inflate, isCompressedRecord, openContainer, records, sectionBytes } from './container.ts'
import { readHeader } from './geometry.ts'
import { partHull, partKey, readPartViews, VIEW_NAMES, type PartHull, type PartViews } from './partviews.ts'
import { geometryBody } from './reader.ts'
import { readTables } from './tables.ts'

export type Category3D = 'duct' | 'pipe' | 'member' | 'part' | 'face' | 'line'

export interface Object3D {
  /** document layer (sheet) index */
  sheet: number
  /** top-level entity index in Layer.entities (what the plan view selects) */
  entity: number
  /** kind of the object itself (may be nested in a group) */
  kind: number
  category: Category3D
  /** Tfas color number */
  color: number
  /** レイヤ (図形属性 id, as GeomBuffer.attr) */
  attr: number
  /** first vertex and vertex count in Model3D.tri */
  tri: [number, number]
  /** first vertex and vertex count in Model3D.line */
  line: [number, number]
  /** bounds relative to the sheet (before its elevation) */
  min: [number, number, number]
  max: [number, number, number]
  /** property rows for the panel */
  info: [string, string][]
  /**
   * Another shape shown instead when chosen (parts: the shape estimated from their views);
   * the same ranges as the object's own when it could not be made.
   */
  alt?: { tri: [number, number]; line: [number, number]; info: [string, string][] }
}

export interface Sheet3D {
  index: number
  name: string
  /** シート基準高さ (mm) */
  elevation: number
  /** 階名 when the sheet has a floor setting */
  floor: string | null
  /** object index range [start, end) */
  objects: [number, number]
}

export interface Model3D {
  /** subtracted from all vertex positions */
  origin: [number, number, number]
  /** triangles: xyz per vertex, relative to origin, before sheet elevations */
  tri: Float32Array
  /** per triangle vertex: normal xyz as signed bytes (+ padding) for curved surfaces; 0 = flat (shade per face) */
  triNormal: Int8Array
  /** line segments: xyz per vertex (pairs) */
  line: Float32Array
  objects: Object3D[]
  sheets: Sheet3D[]
  stats: Record<Category3D, number> & { ms: number }
  warnings: string[]
}

type V3 = [number, number, number]

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2])
const unit = (a: V3): V3 => {
  const n = norm(a)
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0]
}
const same = (a: V3, b: V3, eps = 1e-3) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps
/** a with its component along unit vector d removed */
const reject = (a: V3, d: V3): V3 => sub(a, mul(d, dot(a, d)))

/** Outer diameters (mm) of nominal pipe sizes (JIS G 3452 SGP; 13 for resin / copper). */
const PIPE_OD: Record<number, number> = {
  6: 10.5, 8: 13.8, 10: 17.3, 13: 18, 15: 21.7, 20: 27.2, 25: 34, 30: 38, 32: 42.7, 40: 48.6, 50: 60.5, 60: 70, 65: 76.3, 75: 89.1, 80: 89.1, 90: 101.6,
  100: 114.3, 125: 139.8, 150: 165.2, 175: 190.7, 200: 216.3, 225: 241.8, 250: 267.4, 300: 318.5, 350: 355.6, 400: 406.4, 450: 457.2, 500: 508,
  550: 558.8, 600: 609.6, 650: 660.4, 700: 711.2, 750: 762, 800: 812.8, 850: 863.6, 900: 914.4, 1000: 1016,
}

function pipeOd(nominal: number): number {
  return PIPE_OD[nominal] ?? nominal * 1.1 + 8
}

/** length of a part's placement axis at scale 1 (checked against the parts' own drawings in section 3) */
const PART_UNIT = 128

const fmt = (n: number) => {
  const r = Math.round(n * 10) / 10
  return (Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
const fl = (z: number) => `FL${z < 0 ? '−' : '+'}${fmt(Math.abs(z))}`

/** Growable float64 storage for vertex positions. */
class Verts {
  a = new Float64Array(3 * 4096)
  n = 0
  push(p: V3) {
    if (this.n + 3 > this.a.length) {
      const b = new Float64Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a[this.n++] = p[0]
    this.a[this.n++] = p[1]
    this.a[this.n++] = p[2]
  }
  get count() {
    return this.n / 3
  }
}

/** Growable per-vertex normals (signed bytes, 4 per vertex). */
class Normals {
  a = new Int8Array(4 * 4096)
  n = 0
  push(v: V3 | null) {
    if (this.n + 4 > this.a.length) {
      const b = new Int8Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    if (v) {
      this.a[this.n] = Math.round(v[0] * 127)
      this.a[this.n + 1] = Math.round(v[1] * 127)
      this.a[this.n + 2] = Math.round(v[2] * 127)
    }
    this.n += 4
  }
}

interface Frame {
  /** entity kind, low 12 bits */
  kind: number
  code: string
  name: string
  /** 0x504 length of straight runs (-1 when absent) */
  len: number
  duct: [number, number] | null
  nominal: number
  sleeve: number
  a446: number[] | null
  /** part outline box [W, D, H, min x, y, z] in part units (0x506) */
  a506: number[] | null
  /** W, D, H of duct equipment (0x512) */
  a512: number[] | null
  /** part code (attribute 0) */
  partCode: string
  /** name after the code in 0x503 */
  codeName: string
  /** a child draws the center line (0x503): the object is drawn to scale, not as a symbol */
  centerLine: boolean
  /** hidden plan outlines (0x508 child) by role (0x515): 0x10 / 0x11 connection ends, 0x20 handle */
  outlines: Map<number, number[]>
  /** this frame's own hidden outlines and their roles, while it is the 0x508 child */
  ownOutlines: number[][]
  ownRoles: number[]
  /** visible plan line segments (x0, y0, x1, y1 …) of the subtree */
  segs: number[]
  /** hidden 3D polyline directly under the entity */
  main: V3[] | null
  mainColor: number
  mainAttr: number
  /** x, y pairs of the visible plan geometry in the subtree */
  plan: number[]
  planColor: number
}

export function read3d(data: Uint8Array): Model3D {
  const t0 = performance.now()
  const c = openContainer(data)
  const warnings: string[] = []
  const sec1 = sectionBytes(c, 1)
  const tables = readTables(sec1, warnings)
  // drawing scale (section 1, record 1): sheets with their own scale store coordinates
  // multiplied by drawing scale / sheet scale
  let docScale = 1
  if (sec1) {
    for (const r of records(sec1, 8)) {
      if (r.type !== 1 || r.body.length < 32) continue
      const sc = dataView(r.body).getFloat64(24, true)
      if (sc > 0 && Number.isFinite(sc)) docScale = sc
    }
  }
  /** scale factor of the sheet being read (model units per real millimetre) */
  let sf = 1
  const attrColors = new Map<number, number>()
  for (const a of tables.attributes) if (a.color > 0) attrColors.set(a.id, a.color)

  const tri = new Verts()
  const triNormal = new Normals()
  const line = new Verts()
  const objects: Object3D[] = []
  const sheets: Sheet3D[] = []
  const stats = { duct: 0, pipe: 0, member: 0, part: 0, face: 0, line: 0, ms: 0 }

  // the object being emitted; vertices pushed while it is open belong to it
  let obj: Object3D | null = null
  const begin = (sheet: number, entity: number, kind: number, category: Category3D, color: number, attr: number, info: [string, string][] = []) => {
    end()
    obj = { sheet, entity, kind, category, color, attr, tri: [tri.count, 0], line: [line.count, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], info }
  }
  /** Close the object's own shape; vertices pushed after this form its alternative shape. */
  const beginAlt = (info: [string, string][]) => {
    const o = obj!
    o.tri[1] = tri.count - o.tri[0]
    o.line[1] = line.count - o.line[0]
    o.alt = { tri: [tri.count, 0], line: [line.count, 0], info }
  }
  const end = () => {
    const o = obj as Object3D | null
    if (!o) return
    const r = o.alt ?? o
    r.tri[1] = tri.count - r.tri[0]
    r.line[1] = line.count - r.line[0]
    // no alternative drawn: it is the object's own shape
    if (o.alt && !o.alt.tri[1] && !o.alt.line[1]) {
      o.alt.tri = [o.tri[0], o.tri[1]]
      o.alt.line = [o.line[0], o.line[1]]
    }
    if (o.tri[1] || o.line[1]) {
      objects.push(o)
      stats[o.category]++
    }
    obj = null
  }
  const ext = (p: V3) => {
    const o = obj!
    for (let k = 0; k < 3; k++) {
      if (p[k] < o.min[k]) o.min[k] = p[k]
      if (p[k] > o.max[k]) o.max[k] = p[k]
    }
  }
  /** Triangle; vertex normals for curved surfaces (null: flat). */
  const t3 = (a: V3, b: V3, c: V3, na: V3 | null = null, nb: V3 | null = null, nc: V3 | null = null) => {
    tri.push(a)
    tri.push(b)
    tri.push(c)
    triNormal.push(na)
    triNormal.push(nb)
    triNormal.push(nc)
    ext(a)
    ext(b)
    ext(c)
  }
  const quad = (a: V3, b: V3, c: V3, d: V3, na: V3 | null = null, nb: V3 | null = null, nc: V3 | null = null, nd: V3 | null = null) => {
    t3(a, b, c, na, nb, nc)
    t3(a, c, d, na, nc, nd)
  }
  const seg = (a: V3, b: V3) => {
    line.push(a)
    line.push(b)
    ext(a)
    ext(b)
  }

  // --- mesh builders -------------------------------------------------------

  /** Orthonormal axes perpendicular to unit vector d. */
  const perp = (d: V3): [V3, V3] => {
    const u = unit(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]))
    return [u, cross(d, u)]
  }

  const cylinder = (a: V3, b: V3, r: number) => {
    const d = unit(sub(b, a))
    if (!norm(d) || !(r > 0)) return
    const [u, v] = perp(d)
    // sides are smooth shaded with radial normals, so moderate segment counts look round
    const n = r * 2 >= 300 ? 40 : r * 2 >= 100 ? 28 : r * 2 >= 30 ? 20 : 14
    const rad: V3[] = []
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2
      rad.push(add(mul(u, Math.cos(t)), mul(v, Math.sin(t))))
    }
    const ra = rad.map((q) => add(a, mul(q, r)))
    const rb = rad.map((q) => add(b, mul(q, r)))
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      quad(ra[i], ra[j], rb[j], rb[i], rad[i], rad[j], rad[j], rad[i])
    }
    for (let i = 1; i + 1 < n; i++) {
      t3(ra[0], ra[i + 1], ra[i])
      t3(rb[0], rb[i], rb[i + 1])
    }
  }

  const sphere = (c: V3, r: number) => {
    const n = r * 2 >= 100 ? 24 : r * 2 >= 30 ? 16 : 12
    const m = n / 2
    const dir = (i: number, j: number): V3 => {
      const th = (i / n) * Math.PI * 2
      const ph = (j / m) * Math.PI - Math.PI / 2
      return [Math.cos(ph) * Math.cos(th), Math.cos(ph) * Math.sin(th), Math.sin(ph)]
    }
    const p = (q: V3): V3 => [c[0] + r * q[0], c[1] + r * q[1], c[2] + r * q[2]]
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) {
        const [q0, q1, q2, q3] = [dir(i, j), dir(i + 1, j), dir(i + 1, j + 1), dir(i, j + 1)]
        quad(p(q0), p(q1), p(q2), p(q3), q0, q1, q2, q3)
      }
    }
  }

  /** Box over [u0,u1]×[v0,v1]×[w0,w1] in the frame (o, eu, ev, ew). */
  const box = (o: V3, eu: V3, ev: V3, ew: V3, u0: number, u1: number, v0: number, v1: number, w0: number, w1: number) => {
    const P = (u: number, v: number, w: number) => add(o, add(mul(eu, u), add(mul(ev, v), mul(ew, w))))
    const c = [P(u0, v0, w0), P(u1, v0, w0), P(u1, v1, w0), P(u0, v1, w0), P(u0, v0, w1), P(u1, v0, w1), P(u1, v1, w1), P(u0, v1, w1)]
    quad(c[0], c[3], c[2], c[1])
    quad(c[4], c[5], c[6], c[7])
    quad(c[0], c[1], c[5], c[4])
    quad(c[1], c[2], c[6], c[5])
    quad(c[2], c[3], c[7], c[6])
    quad(c[3], c[0], c[4], c[7])
  }

  /** Polygon (planar, possibly concave) as triangles. */
  const polygon = (poly: V3[]) => {
    const idx = triangulate(poly)
    for (let i = 0; i + 2 < idx.length; i += 3) t3(poly[idx[i]], poly[idx[i + 1]], poly[idx[i + 2]])
  }

  /** Outline swept along e: both caps and the sides. */
  const prism = (poly: V3[], e: V3) => {
    const top = poly.map((p) => add(p, e))
    polygon(poly)
    polygon(top)
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length
      quad(poly[i], poly[j], top[j], top[i])
    }
  }

  // --- object builders -----------------------------------------------------

  const colorOf = (color: number, colorInherited: boolean, attr: number, attrSet: number, layerFlags: number) => {
    if (!colorInherited) return color
    const attrColor = attrColors.get(attr)
    return attrSet === 0 && attrColor ? attrColor : (layerFlags & 0xff) || attrColor || color
  }

  /** Width of a run in the plan: twice the typical distance of plan points from the center line. */
  const planWidth = (f: Frame, path: V3[]): number => {
    const ds: number[] = []
    for (let k = 0; k + 1 < f.plan.length; k += 2) {
      const x = f.plan[k]
      const y = f.plan[k + 1]
      let best = Infinity
      for (let i = 0; i + 1 < path.length; i++) {
        const [ax, ay] = path[i]
        const dx = path[i + 1][0] - ax
        const dy = path[i + 1][1] - ay
        const l2 = dx * dx + dy * dy
        if (l2 < 1) continue
        const t = ((x - ax) * dx + (y - ay) * dy) / l2
        if (t < -0.01 || t > 1.01) continue
        best = Math.min(best, Math.abs((x - ax) * dy - (y - ay) * dx) / Math.sqrt(l2))
      }
      if (best < 1000) ds.push(best)
    }
    if (!ds.length) return 0
    ds.sort((a, b) => a - b)
    return 2 * ds[Math.floor(ds.length * 0.9)]
  }

  const planBox = (f: Frame) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let k = 0; k + 1 < f.plan.length; k += 2) {
      x0 = Math.min(x0, f.plan[k])
      x1 = Math.max(x1, f.plan[k])
      y0 = Math.min(y0, f.plan[k + 1])
      y1 = Math.max(y1, f.plan[k + 1])
    }
    return x1 >= x0 ? { dx: x1 - x0, dy: y1 - y0 } : null
  }

  /** Width of a plan outline across unit direction (dx, dy). */
  const across = (pts: number[], dx: number, dy: number) => {
    let lo = Infinity
    let hi = -Infinity
    for (let k = 0; k + 1 < pts.length; k += 2) {
      const t = -pts[k] * dy + pts[k + 1] * dx
      lo = Math.min(lo, t)
      hi = Math.max(hi, t)
    }
    return hi > lo ? hi - lo : 0
  }
  /**
   * Size of the round face seen in a valve outline: the face is at right angles to `axis`;
   * seen from above it is a line across the axis, or (axis vertical) a polygon around it
   * whose narrower width is the diameter.
   */
  const faceSize = (pts: number[] | undefined, axis: V3) => {
    if (!pts || pts.length < 4) return 0
    const a = unit(axis)
    if (Math.abs(a[2]) > 0.7) return Math.min(across(pts, 0, 1), across(pts, 1, 0))
    const l = Math.hypot(a[0], a[1])
    return across(pts, a[0] / l, a[1] / l)
  }

  /**
   * Valve from its registered dimensions (Tfas バルブ: D1, L1, L2, H1 ハンドル高さ, H2 ハンドル径):
   * body cylinders from the center to both ends, a stem to the handle and the handle disc.
   * The stem and disc thickness are not stored; they are drawn thin.
   */
  const buildValve = (f: Frame, sheet: number, entity: number): boolean => {
    const [c, e1, e2, top] = f.main!
    const d1 = faceSize(f.outlines.get(0x10), sub(e1, c))
    const d2 = faceSize(f.outlines.get(0x11), sub(e2, c))
    if (!(d1 > 0 && d2 > 0) || same(e1, c) || same(e2, c)) return false
    const stem = sub(top, c)
    const h1 = norm(stem)
    const h2 = h1 > 0 ? faceSize(f.outlines.get(0x20), stem) : 0
    begin(sheet, entity, f.kind, 'pipe', f.mainColor, f.mainAttr)
    cylinder(e1, c, d1 / 2)
    cylinder(c, e2, d2 / 2)
    if (h1 > Math.max(d1, d2) / 2) {
      const s = unit(stem)
      const t = Math.max(h2 * 0.08, Math.min(d1, d2) * 0.1)
      const r = Math.min(d1, d2) * 0.12
      if (h2 > 0) {
        cylinder(c, add(c, mul(s, h1 - t)), r)
        cylinder(add(c, mul(s, h1 - t)), top, h2 / 2)
      } else cylinder(c, top, Math.max(r, Math.min(d1, d2) * 0.3))
    }
    const L1 = norm(sub(e1, c))
    const L2 = norm(sub(e2, c))
    const mm = (x: number) => fmt(x / sf)
    obj!.info.push(['3D 形状', '弁 (図面に保存された寸法)'])
    if (f.nominal >= 6) obj!.info.push(['サイズ', `${f.nominal}A`])
    obj!.info.push(['寸法', `L1 ${mm(L1)} / L2 ${mm(L2)} / D1 ${mm(d1)}${h1 > 0 ? ` / H1 ${mm(h1)}` : ''}${h2 > 0 ? ` / H2 ${mm(h2)}` : ''}`])
    // drawn as a symbol (single-line pipes): every outline as wide as the symbol across the
    // pipe, L1 = 0.75 of it
    const axis = sub(e2, e1)
    const al = Math.hypot(axis[0], axis[1])
    const widths = al > 1e-6 && Math.abs(axis[2]) < 0.01 * norm(axis) ? [...f.outlines.values()].map((pts) => across(pts, axis[0] / al, axis[1] / al)) : []
    if (!f.centerLine && widths.length && widths[0] > 0 && widths.every((w) => Math.abs(w - widths[0]) < 0.5) && Math.abs(L1 / widths[0] - 0.75) < 0.01)
      obj!.info.push(['寸法の種類', '記号の大きさに合わせた寸法 (実寸ではありません)'])
    obj!.info.push(['高さ (芯)', fl(c[2] / sf)])
    if (f.code) obj!.info.push(['コード', f.code])
    end()
    return true
  }

  /** Duct equipment box (DSNTSYO… / DSNTBOX…) when 0x512 and the polyline agree. */
  const buildBoxEquipment = (f: Frame, sheet: number, entity: number): boolean => {
    const P = f.main!
    const d = f.a512
    if (P.length !== 3 || !d || !(d[0] > 0 && d[1] > 0 && d[2] > 0)) return false
    const [W, D, H] = d.map((x) => x * sf)
    const a = sub(P[1], P[0])
    const b = sub(P[2], P[0])
    const tol = Math.max(0.5, 0.002 * Math.max(W, H))
    if (Math.abs(norm(a) - W / 2) > tol || Math.abs(norm(b) - H / 2) > tol || Math.abs(dot(unit(a), unit(b))) > 0.01) return false
    const ea = unit(a)
    const eb = unit(b)
    begin(sheet, entity, f.kind, 'duct', f.mainColor, f.mainAttr)
    box(P[0], ea, unit(cross(eb, ea)), eb, -W / 2, W / 2, -D / 2, D / 2, -H / 2, H / 2)
    obj!.info.push(['3D 形状', 'ダクト機器 (箱)'], ['外形', `${fmt(d[0])} × ${fmt(d[1])} × ${fmt(d[2])}`])
    if (f.codeName) obj!.info.push(['名称', f.codeName])
    obj!.info.push(['高さ (芯)', fl(P[0][2] / sf)], ['コード', f.code])
    end()
    return true
  }

  /** Objects whose 3D shape is not known: their hidden 3D reference lines only. */
  const buildReferenceLines = (f: Frame, sheet: number, entity: number) => {
    const P = f.main!
    begin(sheet, entity, f.kind, 'line', f.mainColor, f.mainAttr, [['3D 形状', '形の情報なし (3D の基準線のみ)']])
    for (let i = 1; i < P.length; i++) seg(P[0], P[i])
    if (f.codeName) obj!.info.push(['名称', f.codeName])
    obj!.info.push(['高さ', fl(P[0][2] / sf)])
    if (f.code) obj!.info.push(['コード', f.code])
    end()
    return true
  }

  const buildMep = (f: Frame, sheet: number, entity: number): boolean => {
    const P = f.main!
    if (P.length < 2) return false
    if (f.code.startsWith('ZVLV') && P.length === 4 && buildValve(f, sheet, entity)) return true
    if (/^DSNT(SYO|BOX)/.test(f.code) && buildBoxEquipment(f, sheet, entity)) return true
    // other duct equipment and supports (steel sections, bolts, bases …): shape not known
    if (f.code.startsWith('DSNT') && !f.duct) return buildReferenceLines(f, sheet, entity)
    const straight = f.len > 0
    let round = true
    let w = 0
    let h = 0
    const info: [string, string][] = []
    let category: Category3D = 'pipe'
    if (f.duct && f.duct[0] > 0) {
      category = 'duct'
      ;[w, h] = f.duct
      if (!h) h = w
      round = /^D(SP|FL)/.test(f.code)
      info.push(['3D 形状', round ? 'ダクト (丸)' : 'ダクト (角)'], ['サイズ', round ? `φ${fmt(w)}` : `${fmt(w)} × ${fmt(h)}`])
      w *= sf
      h *= sf
    } else {
      const nominal = f.sleeve > 0 && f.code.startsWith('SLE') ? f.sleeve : f.nominal
      // real outer diameter, then in the sheet's coordinates
      let d = nominal >= 6 ? pipeOd(nominal) * sf : 0
      const path = straight ? P : P.slice(1).flatMap((e) => [P[0], e])
      if (!d) d = planWidth(f, path)
      const fromPlan = nominal < 6 && d > 0
      if (!(d > 0)) d = 20 * sf
      w = h = Math.min(d, 2000 * sf)
      info.push(['3D 形状', '配管'], ['サイズ', nominal >= 6 ? `${nominal}A (外径 ${fmt(pipeOd(nominal))})` : `外径 ${fmt(d / sf)}${fromPlan ? ' (平面図の幅)' : ' (仮)'}`])
    }
    // section orientation markers of rectangular ducts
    let orient: V3 | null = null
    let orientH = false
    const skip = new Set<number>()
    if (!round) {
      let dir = sub(P[1], P[0])
      for (let i = 2; i < P.length && !norm(dir); i++) dir = sub(P[i], P[0])
      const nd = norm(dir)
      for (let i = 2; i < P.length && nd > 0; i++) {
        for (let j = 0; j < i; j++) {
          const o = sub(P[i], P[j])
          const L = norm(o)
          if (L < 1) continue
          const isH = Math.abs(L - h / 2) < Math.max(1, sf)
          const isW = Math.abs(L - w / 2) < Math.max(1, sf)
          if ((isH || isW) && Math.abs(dot(o, dir)) < 0.05 * L * nd) {
            orient = o
            orientH = isH
            skip.add(i)
            break
          }
        }
      }
    }
    const pb = planBox(f)
    const rectAxes = (d: V3): [V3, V3] => {
      if (orient) {
        const o = unit(reject(orient, d))
        if (norm(o) > 0.5) return orientH ? [unit(cross(o, d)), o] : [o, unit(cross(d, o))]
      }
      if (Math.abs(d[2]) < 0.95) {
        const wa = unit(cross([0, 0, 1], d))
        return [wa, unit(cross(d, wa))]
      }
      // vertical: the plan shows the section; put W along the matching axis
      const wx = !pb || Math.abs(pb.dx - w) + Math.abs(pb.dy - h) <= Math.abs(pb.dx - h) + Math.abs(pb.dy - w)
      const wa: V3 = wx ? [1, 0, 0] : [0, 1, 0]
      return [wa, unit(cross(d, wa))]
    }
    const run = (a: V3, b: V3) => {
      const L = norm(sub(b, a))
      if (L < 1e-6) return
      if (round) cylinder(a, b, w / 2)
      else {
        const d = unit(sub(b, a))
        const [wa, ha] = rectAxes(d)
        box(a, d, wa, ha, 0, L, -w / 2, w / 2, -h / 2, h / 2)
      }
    }
    begin(sheet, entity, f.kind, category, f.mainColor, f.mainAttr, info)
    if (straight) {
      const path: V3[] = []
      P.forEach((p, i) => {
        if (!skip.has(i) && !(path.length && same(path[path.length - 1], p))) path.push(p)
      })
      for (let i = 0; i + 1 < path.length; i++) run(path[i], path[i + 1])
      if (round) for (let i = 1; i + 1 < path.length; i++) sphere(path[i], w / 2)
      obj!.info.push(['高さ (芯)', path.length && path.every((p) => Math.abs(p[2] - path[0][2]) < 0.5) ? fl(path[0][2] / sf) : `${fl(Math.min(...path.map((p) => p[2])) / sf)} 〜 ${fl(Math.max(...path.map((p) => p[2])) / sf)}`])
    } else {
      const c = P[0]
      let ends = 0
      P.forEach((p, i) => {
        if (i === 0 || skip.has(i) || same(p, c)) return
        run(c, p)
        ends++
      })
      if (round && ends >= 2) sphere(c, w / 2)
      obj!.info.push(['高さ (芯)', fl(c[2] / sf)])
    }
    if (f.code) obj!.info.push(['コード', f.code])
    end()
    return true
  }

  const buildMember = (f: Frame, sheet: number, entity: number): boolean => {
    const P = f.main!
    if (P.length < 4) return false
    const e = sub(P[1], P[0])
    const prof = P.slice(2)
    if (prof.length > 2 && same(prof[0], prof[prof.length - 1])) prof.pop()
    if (prof.length < 2) return false
    if (outside(P[0], prof, e)) prof.unshift(P[0])
    begin(sheet, entity, f.kind, 'member', f.mainColor, f.mainAttr)
    if (norm(e) > 1e-6) prism(prof, e)
    else polygon(prof)
    const zs = [...prof.map((p) => p[2]), ...prof.map((p) => p[2] + e[2])]
    obj!.info.push(['3D 形状', '建築部材'], ['高さ', `${fl(Math.min(...zs) / sf)} 〜 ${fl(Math.max(...zs) / sf)}`])
    end()
    return true
  }

  // part views (section 3) and the shapes estimated from them, read when first needed
  let partViews: Map<string, PartViews> | null = null
  const hulls = new Map<string, PartHull | null>()
  const hullOf = (code: string, b: number[]): { hull: PartHull | null; why: string } => {
    partViews ??= readPartViews(sectionBytes(c, 3))
    const views = partViews.get(partKey(code))
    if (!views) return { hull: null, why: '図面に 5 面図がない' }
    const k = `${partKey(code)}|${b.join(',')}`
    let h = hulls.get(k)
    if (h === undefined) hulls.set(k, (h = partHull(views, b)))
    return { hull: h, why: h ? '' : '5 面図の外形が閉じた形になっていない' }
  }

  const buildPart = (f: Frame, sheet: number, entity: number): boolean => {
    const P = f.main!
    if (P.length !== 4) return false
    const o = P[0]
    const ax = sub(P[1], o)
    const ay = sub(P[2], o)
    const az = sub(P[3], o)
    const [lx, ly, lz] = [norm(ax), norm(ay), norm(az)]
    if (!(lx > 1e-6 && ly > 1e-6 && lz > 1e-6)) return false
    if (Math.abs(dot(ax, ay)) > 0.02 * lx * ly || Math.abs(dot(ax, az)) > 0.02 * lx * lz || Math.abs(dot(ay, az)) > 0.02 * ly * lz) return false
    const ex = mul(ax, 1 / lx)
    const ey = mul(ay, 1 / ly)
    const ez = mul(az, 1 / lz)
    const electrical = f.partCode.startsWith('E')
    // outline box of the part's 3D shape (0x506, part units); an axis PART_UNIT long is scale 1
    const b = f.a506
    if (b && !electrical && b[0] > 0 && b[1] > 0 && b[2] >= 0) {
      const [sx, sy, sz] = [lx / PART_UNIT, ly / PART_UNIT, lz / PART_UNIT]
      const [W, D, H, x0, y0, z0] = b
      begin(sheet, entity, f.kind, 'part', f.mainColor, f.mainAttr)
      if (H > 0) box(o, ex, ey, ez, x0 * sx, (x0 + W) * sx, y0 * sy, (y0 + D) * sy, z0 * sz, (z0 + H) * sz)
      else {
        const q = (u: number, v: number) => add(o, add(mul(ex, u * sx), add(mul(ey, v * sy), mul(ez, z0 * sz))))
        quad(q(x0, y0), q(x0 + W, y0), q(x0 + W, y0 + D), q(x0, y0 + D))
      }
      const rows: [string, string][] = [['外形', `${fmt((W * sx) / sf)} × ${fmt((D * sy) / sf)} × ${fmt((H * sz) / sf)}`], ['高さ', fl(o[2] / sf)]]
      if (f.name) rows.push(['名称', f.name])
      obj!.info.push(['3D 形状', '機器・部品 (外形の箱。形はライブラリにあり図面には含まれない)'], ...rows)
      // alternative: the shape estimated from the part's views (5 面図)
      const { hull, why } = H > 0 ? hullOf(f.partCode, b) : { hull: null, why: '高さの情報がない' }
      if (hull) {
        beginAlt([['3D 形状', '機器・部品 (5 面図から推定した形。Tfas の 3D 表示とは異なる)'], ['推定に使った図', hull.used.map((v) => VIEW_NAMES[v]).join('・')], ...rows])
        const t = hull.tri
        const at = (i: number) => add(o, add(mul(ex, t[i] * sx), add(mul(ey, t[i + 1] * sy), mul(ez, t[i + 2] * sz))))
        for (let i = 0; i + 8 < t.length; i += 9) t3(at(i), at(i + 3), at(i + 6))
      } else beginAlt([['3D 形状', `機器・部品 (外形の箱。${why}ため推定できない)`], ...rows])
      end()
      return true
    }
    // electrical parts: W, D, H (0x446) when they match the plan outline
    if (electrical && f.a446 && f.a446[2] > 0 && Math.abs(ez[2]) > 0.99) {
      let u0 = Infinity
      let u1 = -Infinity
      let v0 = Infinity
      let v1 = -Infinity
      for (let k = 0; k + 1 < f.plan.length; k += 2) {
        const d: V3 = [f.plan[k] - o[0], f.plan[k + 1] - o[1], 0]
        u0 = Math.min(u0, dot(d, ex))
        u1 = Math.max(u1, dot(d, ex))
        v0 = Math.min(v0, dot(d, ey))
        v1 = Math.max(v1, dot(d, ey))
      }
      const near = (a: number, c: number) => Math.abs(a - c) <= 0.15 * Math.max(a, c)
      const [W, D, H] = f.a446.map((x) => x * sf)
      if (u1 > u0 && v1 > v0 && near(W, u1 - u0) && near(D, v1 - v0)) {
        begin(sheet, entity, f.kind, 'part', f.mainColor, f.mainAttr)
        box(o, ex, ey, ez, u0, u1, v0, v1, 0, H)
        obj!.info.push(['3D 形状', '電気部品 (外形の箱)'], ['外形', `${fmt(f.a446[0])} × ${fmt(f.a446[1])} × ${fmt(f.a446[2])}`], ['高さ', fl(o[2] / sf)])
        if (f.name) obj!.info.push(['名称', f.name])
        end()
        return true
      }
    }
    // no height information: the plan shape at the part's height
    if (!f.segs.length) return false
    begin(sheet, entity, f.kind, 'part', f.mainColor || f.planColor, f.mainAttr, [['3D 形状', '高さの情報なし (平面の形のみ)']])
    for (let k = 0; k + 3 < f.segs.length; k += 4) seg([f.segs[k], f.segs[k + 1], o[2]], [f.segs[k + 2], f.segs[k + 3], o[2]])
    obj!.info.push(['高さ', fl(o[2] / sf)])
    if (f.name) obj!.info.push(['名称', f.name])
    end()
    return true
  }

  // --- parse the sheets ----------------------------------------------------

  const sec4 = sectionBytes(c, 4)
  if (sec4) {
    for (const r of records(sec4, 8)) {
      if (!isCompressedRecord(r)) continue
      const sheet = sheets.length
      const s: Sheet3D = { index: sheet, name: '', elevation: 0, floor: null, objects: [objects.length, objects.length] }
      sheets.push(s)
      let layerFlags = 0
      sf = 1
      let entityCount = 0
      let top = -1
      const stack: Frame[] = []
      // visible 3D polylines of the current top-level entity are collected into one object
      let free: Object3D | null = null
      try {
        for (const rec of records(inflate(r.body), 1)) {
          const b = rec.body
          switch (rec.type) {
            case 0x1004:
              if (b.length >= 8) {
                const v = dataView(b)
                if (v.getUint32(0, true) === 1 && v.getUint32(4, true) > 0) sf = docScale / v.getUint32(4, true)
              }
              if (b.length >= 137) {
                const v = dataView(b)
                const e = v.getFloat64(128, true)
                if (Number.isFinite(e) && Math.abs(e) < 1e7) s.elevation = e
                if (b[136] === 1) s.floor = decodeSjis(b.subarray(137, Math.min(b.length, 160)))
              }
              break
            case 0x1005:
              if (b.length > 4) {
                layerFlags = dataView(b).getUint32(0, true)
                s.name = decodeSjis(b.subarray(4))
              }
              break
            case 0x0002:
            case 0x0012: {
              const kind = rec.type === 2 ? dataView(b).getUint32(4, true) : Number(dataView(b).getBigUint64(8, true) & 0xffffffffn)
              if (!stack.length) {
                top = entityCount++
                end()
                free = null
              }
              stack.push({ kind: kind & 0xfff, code: '', name: '', len: -1, duct: null, nominal: 0, sleeve: 0, a446: null, a506: null, a512: null, partCode: '', codeName: '', centerLine: false, outlines: new Map(), ownOutlines: [], ownRoles: [], segs: [], main: null, mainColor: 0, mainAttr: 0, plan: [], planColor: 0 })
              break
            }
            case 0x0004: {
              const f = stack[stack.length - 1]
              if (!f || b.length < 8) break
              const v = dataView(b)
              const id = v.getUint32(0, true)
              if (id === 0x503) {
                f.code = decodeSjis(b.subarray(4, Math.min(b.length, 14)))
                if (b.length > 17) f.codeName = decodeSjis(b.subarray(17, Math.min(b.length, 40)))
              }
              else if (id === 0x504 && b.length >= 12) f.len = v.getFloat64(4, true)
              else if (id === 0x50a && b.length >= 16) f.duct = [v.getUint16(12, true), v.getUint16(14, true)]
              else if (id === 0x50b && b.length >= 12) f.nominal = v.getUint16(10, true)
              else if (id === 0x517) f.sleeve = v.getUint16(4, true)
              else if (id === 0x180) f.name = decodeSjis(b.subarray(4))
              else if (id === 0x446 && b.length >= 28) f.a446 = [v.getFloat64(4, true), v.getFloat64(12, true), v.getFloat64(20, true)]
              else if (id === 0x506 && b.length >= 52) f.a506 = [4, 12, 20, 28, 36, 44].map((o) => v.getFloat64(o, true))
              else if (id === 0x512 && b.length >= 16) f.a512 = [v.getInt32(4, true), v.getInt32(8, true), v.getInt32(12, true)]
              else if (id === 0 && b.length > 4) f.partCode = decodeSjis(b.subarray(4, Math.min(b.length, 44)))
              else if (id === 0x515) for (let o = 4; o + 8 <= b.length; o += 8) f.ownRoles[v.getUint32(o, true)] = v.getUint32(o + 4, true)
              break
            }
            case 0x0003: {
              const f = stack[stack.length - 1]
              if (!f) break
              const body = geometryBody(b)
              if (!body || body.length < 24) break
              const v = dataView(body)
              const h = readHeader(v)
              const hidden = (h.flags & 0x4) !== 0
              const aux = (h.flags & 0x8) !== 0
              const color = colorOf(h.color, h.colorInherited, h.attr, h.attrSet, layerFlags)
              if (h.kind === 0x68) {
                const n = v.getUint32(16, true)
                if (n < 2 || 24 + n * 24 > body.length) break
                const pts: V3[] = []
                for (let i = 0; i < n; i++) pts.push([v.getFloat64(24 + 24 * i, true), v.getFloat64(32 + 24 * i, true), v.getFloat64(40 + 24 * i, true)])
                if (hidden) {
                  if (!f.main) {
                    f.main = pts
                    f.mainColor = color
                    f.mainAttr = h.attr
                  }
                } else if (!aux) {
                  const open = obj as Object3D | null
                  if (!free || open !== free || (free as Object3D).color !== color || (free as Object3D).attr !== h.attr) {
                    begin(sheet, top, f.kind, 'line', color, h.attr, [['3D 形状', '3D 図形 (面・線)']])
                    free = obj as Object3D | null
                  }
                  const closed = n >= 4 && same(pts[0], pts[n - 1], 0.01)
                  if (closed) {
                    const poly = pts.slice(0, -1)
                    const before = tri.count
                    polygon(poly)
                    if (tri.count > before) (free as Object3D).category = 'face'
                  }
                  for (let i = 0; i + 1 < n; i++) seg(pts[i], pts[i + 1])
                }
              } else if (!hidden && !aux) {
                if (!f.plan.length) f.planColor = color
                planPoints(h.kind, v, body.length, f.plan)
                planSegments(h.kind, v, body.length, f.segs)
              } else if (hidden && f.kind === 0x508 && (h.kind === 0x38 || h.kind === 0x39)) {
                const pts: number[] = []
                planPoints(h.kind, v, body.length, pts)
                f.ownOutlines.push(pts)
              }
              break
            }
            case 0x0005: {
              const f = stack.pop()
              if (!f) break
              const parent = stack[stack.length - 1]
              let used = false
              if (f.main) {
                if (!f.mainColor) f.mainColor = f.planColor
                if (f.kind === 0x500 || f.kind === 0x600 || f.kind === 0x480) used = buildMep(f, sheet, top)
                else if (f.kind >= 0x200 && f.kind < 0x300) used = buildMember(f, sheet, top)
                else if (f.main.length === 4) used = buildPart(f, sheet, top)
              }
              if (!used && parent) {
                if (!parent.plan.length) parent.planColor = f.planColor
                for (const x of f.plan) parent.plan.push(x)
                for (const x of f.segs) parent.segs.push(x)
              }
              if (parent && f.kind === 0x503) parent.centerLine = true
              if (parent && f.kind === 0x508) f.ownOutlines.forEach((pts, i) => f.ownRoles[i] && parent.outlines.set(f.ownRoles[i], pts))
              break
            }
          }
        }
      } catch (e) {
        warnings.push(`シート ${sheet} (${s.name}) の 3D データの解析に失敗: ${(e as Error).message}`)
      }
      end()
      s.objects[1] = objects.length
    }
  }

  // positions relative to the model center, as float32
  const lo: V3 = [Infinity, Infinity, Infinity]
  const hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const o of objects) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], o.min[k])
      hi[k] = Math.max(hi[k], o.max[k])
    }
  }
  const origin: V3 = objects.length ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0] : [0, 0, 0]
  const toF32 = (v: Verts) => {
    const out = new Float32Array(v.n)
    for (let i = 0; i < v.n; i += 3) {
      out[i] = v.a[i] - origin[0]
      out[i + 1] = v.a[i + 1] - origin[1]
      out[i + 2] = v.a[i + 2] - origin[2]
    }
    return out
  }
  stats.ms = Math.round(performance.now() - t0)
  return { origin, tri: toF32(tri), triNormal: triNormal.a.slice(0, triNormal.n), line: toF32(line), objects, sheets, stats, warnings }
}

/** Points of a visible plan primitive (enough for extents and widths). */
function planPoints(kind: number, v: DataView, len: number, out: number[]) {
  const d = (i: number) => v.getFloat64(16 + 8 * i, true)
  switch (kind) {
    case 0x10:
      if (len >= 48) out.push(d(0), d(1), d(2), d(3))
      break
    case 0x18:
      if (len >= 40) out.push(d(1), d(0), d(2), d(0))
      break
    case 0x20:
      if (len >= 40) out.push(d(0), d(1), d(0), d(2))
      break
    case 0x38:
    case 0x39: {
      const n = v.getUint32(16, true)
      if (24 + n * 16 > len) break
      for (let i = 0; i < n; i++) out.push(v.getFloat64(24 + 16 * i, true), v.getFloat64(32 + 16 * i, true))
      break
    }
    case 0x40:
    case 0x48:
    case 0x50:
    case 0x58: {
      if (len < 40) break
      const r = kind >= 0x50 && len >= 48 ? Math.max(d(2), d(3)) : d(2)
      out.push(d(0) - r, d(1) - r, d(0) + r, d(1) + r)
      break
    }
  }
}

/** Line segments (x0, y0, x1, y1 …) of a visible plan primitive; arcs as short chords. */
function planSegments(kind: number, v: DataView, len: number, out: number[]) {
  const d = (i: number) => v.getFloat64(16 + 8 * i, true)
  const poly = (pts: number[], closed: boolean) => {
    for (let i = 0; i + 3 < pts.length; i += 2) out.push(pts[i], pts[i + 1], pts[i + 2], pts[i + 3])
    if (closed && pts.length >= 6) out.push(pts[pts.length - 2], pts[pts.length - 1], pts[0], pts[1])
  }
  switch (kind) {
    case 0x10:
      if (len >= 48) out.push(d(0), d(1), d(2), d(3))
      break
    case 0x18:
      if (len >= 40) out.push(d(1), d(0), d(2), d(0))
      break
    case 0x20:
      if (len >= 40) out.push(d(0), d(1), d(0), d(2))
      break
    case 0x38:
    case 0x39: {
      const n = v.getUint32(16, true)
      if (24 + n * 16 > len) break
      const pts: number[] = []
      for (let i = 0; i < n; i++) pts.push(v.getFloat64(24 + 16 * i, true), v.getFloat64(32 + 16 * i, true))
      poly(pts, kind === 0x39)
      break
    }
    case 0x40:
    case 0x48: {
      if (len < 40) break
      const [cx, cy, r] = [d(0), d(1), d(2)]
      // arcs store their end points (x0, y0, x1, y1) counter-clockwise
      let a0 = 0
      let a1 = Math.PI * 2
      if (kind === 0x48 && len >= 72) {
        a0 = Math.atan2(d(4) - cy, d(3) - cx)
        a1 = Math.atan2(d(6) - cy, d(5) - cx)
        if (a1 <= a0) a1 += Math.PI * 2
      }
      const n = Math.max(4, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 32))
      const pts: number[] = []
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n
        pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a))
      }
      poly(pts, false)
      break
    }
  }
}

/** Whether p lies outside polygon poly (not inside, not on an edge), seen along e. */
function outside(p: V3, poly: V3[], e: V3): boolean {
  let n = e
  if (norm(n) < 1e-9) n = newell(poly)
  const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2
  const [i, j] = ax === 0 ? [1, 2] : ax === 1 ? [0, 2] : [0, 1]
  const px = p[i]
  const py = p[j]
  let inside = false
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = [poly[a][i], poly[a][j]]
    const [xb, yb] = [poly[b][i], poly[b][j]]
    const dx = xb - xa
    const dy = yb - ya
    const l = Math.hypot(dx, dy)
    if (l > 0) {
      const t = ((px - xa) * dx + (py - ya) * dy) / (l * l)
      if (t >= -1e-6 && t <= 1 + 1e-6 && Math.abs((px - xa) * dy - (py - ya) * dx) / l < 0.5) return false
    }
    if (ya > py !== yb > py && px < (xb - xa) * ((py - ya) / (yb - ya)) + xa) inside = !inside
  }
  return !inside
}

function newell(poly: V3[]): V3 {
  const n: V3 = [0, 0, 0]
  for (let a = 0; a < poly.length; a++) {
    const p = poly[a]
    const q = poly[(a + 1) % poly.length]
    n[0] += (p[1] - q[1]) * (p[2] + q[2])
    n[1] += (p[2] - q[2]) * (p[0] + q[0])
    n[2] += (p[0] - q[0]) * (p[1] + q[1])
  }
  return n
}

/** Ear clipping triangulation of a planar polygon; returns vertex indices. */
export function triangulate(poly: V3[]): number[] {
  const n = poly.length
  if (n < 3) return []
  if (n === 3) return [0, 1, 2]
  // ear clipping is quadratic: very large outlines are fanned (exact for convex ones)
  if (n > 2000) {
    const out: number[] = []
    for (let k = 1; k + 1 < n; k++) out.push(0, k, k + 1)
    return out
  }
  const nn = newell(poly)
  if (norm(nn) < 1e-12) return []
  const ax = Math.abs(nn[0]) >= Math.abs(nn[1]) && Math.abs(nn[0]) >= Math.abs(nn[2]) ? 0 : Math.abs(nn[1]) >= Math.abs(nn[2]) ? 1 : 2
  const [i, j] = ax === 0 ? [1, 2] : ax === 1 ? [2, 0] : [0, 1]
  const xs = poly.map((p) => p[i])
  const ys = poly.map((p) => p[j])
  // orientation in the projection: make it counter-clockwise
  let area = 0
  for (let a = 0, b = n - 1; a < n; b = a++) area += xs[b] * ys[a] - xs[a] * ys[b]
  const idx = [...Array(n).keys()]
  if (area < 0) idx.reverse()
  const crossAt = (a: number, b: number, c: number) => (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a])
  const inTri = (p: number, a: number, b: number, c: number) => crossAt(a, b, p) > 0 && crossAt(b, c, p) > 0 && crossAt(c, a, p) > 0
  const out: number[] = []
  let guard = n * n
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length]
      const b = idx[k]
      const c = idx[(k + 1) % idx.length]
      const cr = crossAt(a, b, c)
      if (cr <= 0) {
        // collinear points can simply be dropped
        if (cr === 0 || Math.abs(cr) < 1e-9) {
          idx.splice(k, 1)
          clipped = true
          break
        }
        continue
      }
      let ear = true
      for (const p of idx) if (p !== a && p !== b && p !== c && inTri(p, a, b, c)) ear = false
      if (!ear) continue
      out.push(a, b, c)
      idx.splice(k, 1)
      clipped = true
      break
    }
    if (!clipped) break
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2])
  else if (idx.length > 3) for (let k = 1; k + 1 < idx.length; k++) out.push(idx[0], idx[k], idx[k + 1])
  return out
}
