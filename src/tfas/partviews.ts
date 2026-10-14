// Shapes of parts estimated from their embedded views (5 面図).
//
// Section 3 of a drawing holds the definitions of the placed parts: 2D drawings at real
// size, one per view, separated by record 9; attribute 0 is the code whose second
// character is the view: 0 平面, 1 正面, 2 背面, 3 右側面, 4 左側面 (5 and up: other
// drawings, not used). Checked against the part outline box 0x506 on the sample drawings,
// the views map to the part's axes as
//   平面 (x, y), 正面 (x, z), 背面 (−x, z), 右側面 (y, z), 左側面 (−y, z).
// Tfas itself shows parts in 3D from 3D data in its parts library, which drawings do not
// contain. The estimate here is a visual hull: each view's silhouette (found on a grid by
// flooding the outside of its lines) is traced into outline polygons, extruded along the
// viewing direction, and the 0x506 box is cut with these prisms (csg.ts). Recesses that no
// view shows cannot be reproduced, and extra lines in a view (inspection space, connection
// stubs) can make it larger than the body.

import { dataView, decodeSjis, inflate, isCompressedRecord, records } from './container.ts'
import { intersect, poly as csgPoly, type Poly, type Vec } from './csg.ts'
import { decodeGeometry, GeomBuilder, primSegments, readHeader } from './geometry.ts'
import { geometryBody } from './reader.ts'

/** View digit → line segments (x0, y0, x1, y1 …) in the view's own coordinates. */
export type PartViews = Map<string, number[]>

export const VIEW_NAMES: Record<string, string> = { '0': '平面', '1': '正面', '2': '背面', '3': '右側面', '4': '左側面' }

/** Key of a part definition: its code without the view digit. */
export const partKey = (code: string) => (code.length > 2 ? code[0] + code.slice(2) : '')

/** Views of the part definitions in section 3, by part key. */
export function readPartViews(sec3: Uint8Array | null): Map<string, PartViews> {
  const out = new Map<string, PartViews>()
  if (!sec3) return out
  for (const r of records(sec3, 8)) {
    if (!isCompressedRecord(r)) continue
    let code = ''
    let g = new GeomBuilder()
    const flush = () => {
      const view = code[1]
      if (code.length > 2 && view >= '0' && view <= '4' && g.count) {
        const key = partKey(code)
        let m = out.get(key)
        if (!m) out.set(key, (m = new Map()))
        if (!m.has(view)) {
          const buf = g.finish()
          const segs: number[] = []
          for (let i = 0; i < buf.count; i++) primSegments(buf, i, (x0, y0, x1, y1) => segs.push(x0, y0, x1, y1))
          m.set(view, segs)
        }
      }
      code = ''
      g = new GeomBuilder()
    }
    try {
      for (const rec of records(inflate(r.body), 1)) {
        if (rec.type === 9) flush()
        else if (rec.type === 4 && !code && rec.body.length > 4 && dataView(rec.body).getUint32(0, true) === 0) code = decodeSjis(rec.body.subarray(4, Math.min(rec.body.length, 44)))
        else if (rec.type === 3) {
          const body = geometryBody(rec.body)
          if (!body || body.length < 16) continue
          const h = readHeader(dataView(body))
          // hidden and auxiliary data are not part of the drawing. All line types are used:
          // leaving out dashed / chain types lost outlines (on the sample drawings 10 of 161
          // parts had no closed outline left, and fewer matched their 0x506 box)
          if (h.flags & 0xc) continue
          decodeGeometry(body, h, 0, 0, g)
        }
      }
      flush()
    } catch {
      // a damaged definition block: keep what was read
    }
  }
  return out
}

// --- visual hull -------------------------------------------------------------

/** cells along the longest side of the box */
const RES = 64
/** empty border around a view's grid, so the outside can be flooded around the outline */
const PAD = 2
/** fewest cells along a side of the box */
const MIN_CELLS = 16
/** smoothing passes over the outline loops (binomial: straight runs do not move) */
const SMOOTH = 2
/** a view whose silhouette covers less of the box than this is not a usable outline */
const MIN_FILL = 0.05

export interface PartHull {
  /** triangles: xyz per vertex in part units */
  tri: Float64Array
  /** views that shaped it (view digits) */
  used: string[]
  /** views present but not usable (open outlines) */
  unusable: string[]
}

/** Grid axis: cells over [lo, lo + n·size]. */
interface Axis {
  lo: number
  n: number
  size: number
}

/** How a view's (u, v) map to the part axes: axis index (0 x, 1 y, 2 z) and sign of u. */
const VIEW_AXES: Record<string, [number, number, 1 | -1]> = { '0': [0, 1, 1], '1': [0, 2, 1], '2': [0, 2, -1], '3': [1, 2, 1], '4': [1, 2, -1] }

/**
 * Silhouette of a view on the grid of axes (a, b): the cells inside its outline. Lines
 * are drawn one cell thick (closing gaps up to about two cells), the outside is flooded
 * from the border and the result shrunk back by the added thickness.
 */
function silhouette(segs: number[], A: Axis, B: Axis, sign: 1 | -1): Uint8Array | null {
  const w = A.n + 2 * PAD
  const h = B.n + 2 * PAD
  const mark = new Uint8Array(w * h)
  // grid coordinates (cells, including the border)
  const gx = (u: number) => (sign * u - A.lo) / A.size + PAD
  const gy = (v: number) => (v - B.lo) / B.size + PAD
  for (let k = 0; k + 3 < segs.length; k += 4) {
    let x0 = gx(segs[k])
    let y0 = gy(segs[k + 1])
    let x1 = gx(segs[k + 2])
    let y1 = gy(segs[k + 3])
    // clip to the grid (Liang–Barsky)
    let t0 = 0
    let t1 = 1
    const dx = x1 - x0
    const dy = y1 - y0
    const clip = (p: number, q: number) => {
      if (p === 0) return q >= 0
      const r = q / p
      if (p < 0) {
        if (r > t1) return false
        if (r > t0) t0 = r
      } else {
        if (r < t0) return false
        if (r < t1) t1 = r
      }
      return true
    }
    if (!(clip(-dx, x0) && clip(dx, w - 1e-9 - x0) && clip(-dy, y0) && clip(dy, h - 1e-9 - y0))) continue
    ;[x0, y0, x1, y1] = [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy]
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2) + 1
    for (let s = 0; s <= steps; s++) {
      const x = Math.floor(x0 + ((x1 - x0) * s) / steps)
      const y = Math.floor(y0 + ((y1 - y0) * s) / steps)
      if (x >= 0 && y >= 0 && x < w && y < h) mark[y * w + x] = 1
    }
  }
  // thicken by one cell
  const thick = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mark[y * w + x]) continue
      for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++) for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) thick[j * w + i] = 1
    }
  }
  // flood the outside from the border
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (i: number) => {
    if (!thick[i] && !outside[i]) {
      outside[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (i >= w) push(i - w)
    if (i < (h - 1) * w) push(i + w)
  }
  // shrink back: a cell stays when none of its neighbours is outside
  const out = new Uint8Array(A.n * B.n)
  let filled = 0
  for (let b = 0; b < B.n; b++) {
    for (let a = 0; a < A.n; a++) {
      const x = a + PAD
      const y = b + PAD
      let inside = !outside[y * w + x]
      for (let j = y - 1; j <= y + 1 && inside; j++) for (let i = x - 1; i <= x + 1 && inside; i++) if (outside[j * w + i]) inside = false
      if (inside) {
        out[b * A.n + a] = 1
        filled++
      }
    }
  }
  return filled >= MIN_FILL * A.n * B.n ? out : null
}

/**
 * Visual hull of a part from its views, inside its outline box [W, D, H, min x, y, z]
 * (part units). Null when no view gives a usable outline.
 */
export function partHull(views: PartViews, box: number[]): PartHull | null {
  const [W, D, H, x0, y0, z0] = box
  if (!(W > 0 && D > 0 && H > 0)) return null
  const cell = Math.max(W, D, H) / RES
  const axis = (lo: number, len: number): Axis => {
    // thin sides get finer cells, so that smoothing does not round them off
    const n = Math.max(MIN_CELLS, Math.round(len / cell))
    return { lo, n, size: len / n }
  }
  const ax = [axis(x0, W), axis(y0, D), axis(z0, H)]
  // silhouettes per plane: 0 = xy, 1 = xz, 2 = yz (all cells inside when no view)
  const planes: (Uint8Array | null)[] = [null, null, null]
  const used: string[] = []
  const unusable: string[] = []
  for (const [view, [a, b, sign]] of Object.entries(VIEW_AXES)) {
    const segs = views.get(view)
    if (!segs?.length) continue
    const s = silhouette(segs, ax[a], ax[b], sign)
    if (!s) {
      unusable.push(view)
      continue
    }
    used.push(view)
    const p = a === 0 && b === 1 ? 0 : a === 0 ? 1 : 2
    const cur = planes[p]
    if (!cur) planes[p] = s
    else for (let i = 0; i < cur.length; i++) cur[i] &= s[i]
  }
  if (!used.length) return null
  // Cut the box with each silhouette extruded along its viewing direction. Computed in
  // box-relative coordinates (0…1 on each axis); the prisms reach past the box so that
  // only their sides cut.
  let solid: Poly[] = cube()
  for (const [p, a, b] of [
    [0, 0, 1],
    [1, 0, 2],
    [2, 1, 2],
  ] as const) {
    const m = planes[p]
    if (!m) continue
    const sweep = 3 - a - b
    // (a, b, sweep) left-handed (the xz plane): turn the faces so that they face outwards
    const flip = (a + 1) % 3 !== b
    const pt = (i: number, j: number, t: number): Vec => {
      const c: Vec = [0, 0, 0]
      c[a] = i / ax[a].n
      c[b] = j / ax[b].n
      c[sweep] = t
      return c
    }
    const prism: Poly[] = []
    const face = (v: Vec[]) => {
      const f = csgPoly(flip ? v.reverse() : v)
      if (f) prism.push(f)
    }
    for (const loop of contours(m, ax[a].n, ax[b].n)) {
      const lo = loop.map(([i, j]) => pt(i, j, -0.1))
      const hi = loop.map(([i, j]) => pt(i, j, 1.1))
      const idx = triangulate2d(loop)
      for (let k = 0; k + 2 < idx.length; k += 3) {
        face([lo[idx[k]], lo[idx[k + 2]], lo[idx[k + 1]]])
        face([hi[idx[k]], hi[idx[k + 1]], hi[idx[k + 2]]])
      }
      for (let k = 0; k < loop.length; k++) {
        const l = (k + 1) % loop.length
        face([lo[k], lo[l], hi[l], hi[k]])
      }
    }
    solid = intersect(solid, prism)
    if (!solid.length) return null
  }
  // back to part units, as triangles
  const tri: number[] = []
  const back = (q: Vec) => [ax[0].lo + q[0] * W, ax[1].lo + q[1] * D, ax[2].lo + q[2] * H]
  for (const f of solid) for (let k = 1; k + 1 < f.v.length; k++) tri.push(...back(f.v[0]), ...back(f.v[k]), ...back(f.v[k + 1]))
  if (!tri.length) return null
  return { tri: new Float64Array(tri), used, unusable }
}

/** The unit cube as outward-facing polygons. */
function cube(): Poly[] {
  const c = (i: number): Vec => [i & 1, (i >> 1) & 1, (i >> 2) & 1]
  return [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ].map((f) => csgPoly(f.map(c))!)
}

/**
 * Outlines of the filled cells as closed loops (counter-clockwise, cells touching only at
 * a corner kept apart). The cell steps of slanted and curved edges are smoothed out (straight
 * runs stay where they are, square corners are cut by a fraction of a cell) and the loop is
 * simplified to within half a cell.
 */
function contours(m: Uint8Array, w: number, h: number): [number, number][][] {
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && m[j * w + i] === 1
  const W1 = w + 1
  // directed boundary edges with the cells on their left; by start corner
  const DX = [1, 0, -1, 0]
  const DY = [0, 1, 0, -1]
  const edges = new Map<number, number[]>()
  const add = (i: number, j: number, d: number) => {
    const k = j * W1 + i
    const l = edges.get(k)
    if (l) l.push(d)
    else edges.set(k, [d])
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!at(i, j)) continue
      if (!at(i, j - 1)) add(i, j, 0)
      if (!at(i + 1, j)) add(i + 1, j, 1)
      if (!at(i, j + 1)) add(i + 1, j + 1, 2)
      if (!at(i - 1, j)) add(i, j + 1, 3)
    }
  }
  const loops: [number, number][][] = []
  for (const [start, list] of edges) {
    while (list.length) {
      let d = list.pop()!
      let i = start % W1
      let j = (start - i) / W1
      let pts: [number, number][] = []
      for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
        pts.push([i, j])
        i += DX[d]
        j += DY[d]
        const k = j * W1 + i
        // back at the start: the loop is closed (holes are filled, so a loop passes each
        // corner once)
        if (k === start) break
        const out = edges.get(k)
        if (!out?.length) break
        // at a corner shared by two cells, turn left (stay with the same cell)
        const left = (d + 1) % 4
        const pick = out.includes(left) ? left : out.includes(d) ? d : out[0]
        out.splice(out.indexOf(pick), 1)
        d = pick
      }
      for (let it = 0; it < SMOOTH; it++) pts = pts.map((p, k) => {
        const a = pts[(k + pts.length - 1) % pts.length]
        const b = pts[(k + 1) % pts.length]
        return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4]
      })
      const s = simplify(pts, 0.5)
      if (s.length >= 3) loops.push(s)
    }
  }
  return loops
}

/** Douglas–Peucker on a closed loop. */
function simplify(pts: [number, number][], tol: number): [number, number][] {
  const n = pts.length
  if (n <= 4) return pts
  // split at the point farthest from the first
  let far = 0
  let best = -1
  for (let i = 1; i < n; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2
    if (d > best) {
      best = d
      far = i
    }
  }
  const keep = new Uint8Array(n + 1)
  keep[0] = keep[far] = keep[n] = 1
  const at = (i: number) => pts[i % n]
  const run = (a: number, b: number) => {
    if (b - a < 2) return
    const [ax, ay] = at(a)
    const [bx, by] = at(b)
    const dx = bx - ax
    const dy = by - ay
    const l = Math.hypot(dx, dy)
    let idx = -1
    let dm = tol
    for (let i = a + 1; i < b; i++) {
      const [px, py] = at(i)
      const d = l > 0 ? Math.abs((px - ax) * dy - (py - ay) * dx) / l : Math.hypot(px - ax, py - ay)
      if (d > dm) {
        dm = d
        idx = i
      }
    }
    if (idx < 0) return
    keep[idx] = 1
    run(a, idx)
    run(idx, b)
  }
  run(0, far)
  run(far, n)
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i])
  return out
}

/** Ear clipping of a simple counter-clockwise polygon; returns vertex indices. */
function triangulate2d(p: [number, number][]): number[] {
  const n = p.length
  const idx = [...Array(n).keys()]
  const cr = (a: number, b: number, c: number) => (p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0])
  let area = 0
  for (let a = 0, b = n - 1; a < n; b = a++) area += p[b][0] * p[a][1] - p[a][0] * p[b][1]
  if (area < 0) idx.reverse()
  const inside = (q: number, a: number, b: number, c: number) => cr(a, b, q) >= 0 && cr(b, c, q) >= 0 && cr(c, a, q) >= 0
  const out: number[] = []
  let guard = n * n
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length]
      const b = idx[k]
      const c = idx[(k + 1) % idx.length]
      const x = cr(a, b, c)
      if (x <= 0) {
        if (x === 0) {
          idx.splice(k, 1)
          clipped = true
          break
        }
        continue
      }
      let ear = true
      for (const q of idx) {
        if (q === a || q === b || q === c) continue
        // a vertex at the same place as a corner of the ear (loops touching themselves)
        if ((p[q][0] === p[a][0] && p[q][1] === p[a][1]) || (p[q][0] === p[c][0] && p[q][1] === p[c][1])) continue
        if (inside(q, a, b, c)) {
          ear = false
          break
        }
      }
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
