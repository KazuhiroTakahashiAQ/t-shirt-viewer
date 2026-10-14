// Hit testing and snapping on the displayed geometry. Each layer (sheet) gets a uniform
// grid of primitive indices, built on first use.

import { Prim, PrimFlag, type GeomBuffer, type ImageItem, type Rect, type TextItem } from '../tfas/model.ts'

export interface PickLayer {
  index: number
  geom: GeomBuffer
  texts: TextItem[]
  images: ImageItem[]
  bbox: Rect | null
}

export interface Hit {
  layer: number
  entity: number
  /** what was hit: a primitive index, a text or an image */
  prim?: number
  text?: TextItem
  image?: ImageItem
  dist: number
}

export type SnapKind = 'end' | 'mid' | 'center' | 'point' | 'near'

export interface Snap {
  x: number
  y: number
  kind: SnapKind
}

interface Grid {
  x0: number
  y0: number
  cell: number
  nx: number
  ny: number
  start: Uint32Array
  items: Uint32Array
}

const GRID_CELLS = 96
const TAU = Math.PI * 2

export class Picker {
  private grids = new Map<number, Grid | null>()
  readonly layers: PickLayer[]
  constructor(layers: PickLayer[]) {
    this.layers = layers
  }

  private grid(l: PickLayer): Grid | null {
    if (this.grids.has(l.index)) return this.grids.get(l.index)!
    const g = l.geom
    let grid: Grid | null = null
    if (g.count && l.bbox) {
      const w = Math.max(l.bbox.x1 - l.bbox.x0, l.bbox.y1 - l.bbox.y0, 1e-6)
      const cell = w / GRID_CELLS
      const nx = Math.max(1, Math.ceil((l.bbox.x1 - l.bbox.x0) / cell) + 1)
      const ny = Math.max(1, Math.ceil((l.bbox.y1 - l.bbox.y0) / cell) + 1)
      const boxes = new Float64Array(g.count * 4)
      const counts = new Uint32Array(nx * ny + 1)
      const cx = (x: number) => Math.min(nx - 1, Math.max(0, Math.floor((x - l.bbox!.x0) / cell)))
      const cy = (y: number) => Math.min(ny - 1, Math.max(0, Math.floor((y - l.bbox!.y0) / cell)))
      for (let i = 0; i < g.count; i++) {
        const b = primBox(g, i)
        boxes.set([b.x0, b.y0, b.x1, b.y1], i * 4)
        for (let y = cy(b.y0); y <= cy(b.y1); y++) for (let x = cx(b.x0); x <= cx(b.x1); x++) counts[y * nx + x + 1]++
      }
      for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1]
      const start = counts.slice()
      const fill = counts.slice()
      const items = new Uint32Array(start[start.length - 1])
      for (let i = 0; i < g.count; i++) {
        const [x0, y0, x1, y1] = boxes.subarray(i * 4, i * 4 + 4)
        for (let y = cy(y0); y <= cy(y1); y++) for (let x = cx(x0); x <= cx(x1); x++) items[fill[y * nx + x]++] = i
      }
      grid = { x0: l.bbox.x0, y0: l.bbox.y0, cell, nx, ny, start, items }
    }
    this.grids.set(l.index, grid)
    return grid
  }

  /** Primitive indices of a layer whose cells touch the square around (x, y). */
  private candidates(l: PickLayer, x: number, y: number, r: number): Set<number> {
    const out = new Set<number>()
    const g = this.grid(l)
    if (!g) return out
    const ix0 = Math.max(0, Math.floor((x - r - g.x0) / g.cell))
    const iy0 = Math.max(0, Math.floor((y - r - g.y0) / g.cell))
    const ix1 = Math.min(g.nx - 1, Math.floor((x + r - g.x0) / g.cell))
    const iy1 = Math.min(g.ny - 1, Math.floor((y + r - g.y0) / g.cell))
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const c = iy * g.nx + ix
        for (let k = g.start[c]; k < g.start[c + 1]; k++) out.add(g.items[k])
      }
    }
    return out
  }

  /** Nearest entity within `tol` model units, over the given layers (front-most last). */
  pick(x: number, y: number, tol: number, visible: (layer: number) => boolean, showAux: boolean): Hit | null {
    let best: Hit | null = null
    const consider = (h: Hit) => {
      if (h.dist <= tol && (!best || h.dist <= best.dist)) best = h
    }
    for (const l of this.layers) {
      if (!visible(l.index) || !l.bbox) continue
      if (x < l.bbox.x0 - tol || x > l.bbox.x1 + tol || y < l.bbox.y0 - tol || y > l.bbox.y1 + tol) continue
      const g = l.geom
      for (const i of this.candidates(l, x, y, tol)) {
        if (g.flags[i] & PrimFlag.Aux && !showAux) continue
        consider({ layer: l.index, entity: g.entity[i], prim: i, dist: primDistance(g, i, x, y) })
      }
      for (const t of l.texts) {
        if (t.flags & PrimFlag.Aux && !showAux) continue
        const b = t.bbox
        if (x >= b.x0 - tol && x <= b.x1 + tol && y >= b.y0 - tol && y <= b.y1 + tol) {
          // inside the box counts as a direct hit, slightly behind lines drawn on top of it
          const d = x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 ? tol * 0.5 : tol
          consider({ layer: l.index, entity: t.entity, text: t, dist: d })
        }
      }
      for (const im of l.images) {
        const b = im.bbox
        if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) consider({ layer: l.index, entity: im.entity, image: im, dist: tol * 0.9 })
      }
    }
    return best
  }

  /** Characteristic point (end, middle, center) near (x, y), else the nearest point on a line. */
  snap(x: number, y: number, tol: number, visible: (layer: number) => boolean): Snap | null {
    let best: Snap | null = null
    let bestD = tol
    const offer = (px: number, py: number, kind: SnapKind) => {
      const d = Math.hypot(px - x, py - y)
      if (d <= bestD) {
        bestD = d
        best = { x: px, y: py, kind }
      }
    }
    let near: Snap | null = null
    let nearD = tol * 0.6
    for (const l of this.layers) {
      if (!visible(l.index) || !l.bbox) continue
      const g = l.geom
      const c = g.coords
      for (const i of this.candidates(l, x, y, tol)) {
        if (g.flags[i] & PrimFlag.Aux) continue
        const a = g.offsets[i]
        const e = g.offsets[i + 1]
        switch (g.types[i]) {
          case Prim.Line:
            offer(c[a], c[a + 1], 'end')
            offer(c[a + 2], c[a + 3], 'end')
            offer((c[a] + c[a + 2]) / 2, (c[a + 1] + c[a + 3]) / 2, 'mid')
            break
          case Prim.Polyline:
            for (let k = a; k < e; k += 2) offer(c[k], c[k + 1], 'end')
            for (let k = a + 2; k < e; k += 2) offer((c[k - 2] + c[k]) / 2, (c[k - 1] + c[k + 1]) / 2, 'mid')
            break
          case Prim.Circle:
          case Prim.Ellipse:
            offer(c[a], c[a + 1], 'center')
            break
          case Prim.Arc: {
            const r = c[a + 2]
            offer(c[a], c[a + 1], 'center')
            offer(c[a] + r * Math.cos(c[a + 3]), c[a + 1] + r * Math.sin(c[a + 3]), 'end')
            offer(c[a] + r * Math.cos(c[a + 4]), c[a + 1] + r * Math.sin(c[a + 4]), 'end')
            break
          }
          case Prim.Point:
            offer(c[a], c[a + 1], 'point')
            break
          case Prim.Bezier:
            offer(c[a], c[a + 1], 'end')
            offer(c[e - 2], c[e - 1], 'end')
            break
        }
        if (!best) {
          const p = nearestOnPrim(g, i, x, y)
          if (p) {
            const d = Math.hypot(p[0] - x, p[1] - y)
            if (d < nearD) {
              nearD = d
              near = { x: p[0], y: p[1], kind: 'near' }
            }
          }
        }
      }
    }
    return best ?? near
  }
}

function primBox(g: GeomBuffer, i: number): Rect {
  const c = g.coords
  const a = g.offsets[i]
  const e = g.offsets[i + 1]
  switch (g.types[i]) {
    case Prim.Circle:
    case Prim.Arc:
      return { x0: c[a] - c[a + 2], y0: c[a + 1] - c[a + 2], x1: c[a] + c[a + 2], y1: c[a + 1] + c[a + 2] }
    case Prim.Ellipse: {
      const r = Math.max(c[a + 2], c[a + 3])
      return { x0: c[a] - r, y0: c[a + 1] - r, x1: c[a] + r, y1: c[a + 1] + r }
    }
    default: {
      const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      for (let k = a; k + 1 < e; k += 2) {
        if (c[k] < r.x0) r.x0 = c[k]
        if (c[k] > r.x1) r.x1 = c[k]
        if (c[k + 1] < r.y0) r.y0 = c[k + 1]
        if (c[k + 1] > r.y1) r.y1 = c[k + 1]
      }
      return r
    }
  }
}

function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const p = segNearest(px, py, x0, y0, x1, y1)
  return Math.hypot(px - p[0], py - p[1])
}

function segNearest(px: number, py: number, x0: number, y0: number, x1: number, y1: number): [number, number] {
  const dx = x1 - x0
  const dy = y1 - y0
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0
  return [x0 + t * dx, y0 + t * dy]
}

/** Points along curved primitives, for distance tests. */
function sampled(g: GeomBuffer, i: number): number[] {
  const c = g.coords
  const a = g.offsets[i]
  const e = g.offsets[i + 1]
  const pts: number[] = []
  switch (g.types[i]) {
    case Prim.Ellipse: {
      const [cx, cy, rx, ry, rot, t0, t1] = Array.from(c.subarray(a, a + 7))
      const full = t0 === t1
      let span = full ? TAU : t1 - t0
      while (span <= 0) span += TAU
      const n = 64
      for (let k = 0; k <= n; k++) {
        const t = (full ? 0 : t0) + (span * k) / n
        const lx = rx * Math.cos(t)
        const ly = ry * Math.sin(t)
        pts.push(cx + lx * Math.cos(rot) - ly * Math.sin(rot), cy + lx * Math.sin(rot) + ly * Math.cos(rot))
      }
      break
    }
    case Prim.Bezier: {
      pts.push(c[a], c[a + 1])
      for (let k = a + 2; k + 5 < e; k += 6) {
        const x0 = pts[pts.length - 2]
        const y0 = pts[pts.length - 1]
        for (let s = 1; s <= 16; s++) {
          const t = s / 16
          const u = 1 - t
          pts.push(
            u * u * u * x0 + 3 * u * u * t * c[k] + 3 * u * t * t * c[k + 2] + t * t * t * c[k + 4],
            u * u * u * y0 + 3 * u * u * t * c[k + 1] + 3 * u * t * t * c[k + 3] + t * t * t * c[k + 5],
          )
        }
      }
      break
    }
  }
  return pts
}

function arcContains(a0: number, a1: number, ang: number): boolean {
  let span = (a1 - a0) % TAU
  if (span <= 0) span += TAU
  let d = (ang - a0) % TAU
  if (d < 0) d += TAU
  return d <= span
}

export function primDistance(g: GeomBuffer, i: number, x: number, y: number): number {
  const p = nearestOnPrim(g, i, x, y)
  return p ? Math.hypot(p[0] - x, p[1] - y) : Infinity
}

function nearestOnPrim(g: GeomBuffer, i: number, x: number, y: number): [number, number] | null {
  const c = g.coords
  const a = g.offsets[i]
  const e = g.offsets[i + 1]
  switch (g.types[i]) {
    case Prim.Line:
      return segNearest(x, y, c[a], c[a + 1], c[a + 2], c[a + 3])
    case Prim.Polyline: {
      let best: [number, number] | null = null
      let bd = Infinity
      const n = (e - a) / 2
      const segs = g.flags[i] & PrimFlag.Closed ? n : n - 1
      for (let k = 0; k < segs; k++) {
        const p = a + 2 * k
        const q = a + 2 * ((k + 1) % n)
        const d = segDist(x, y, c[p], c[p + 1], c[q], c[q + 1])
        if (d < bd) {
          bd = d
          best = segNearest(x, y, c[p], c[p + 1], c[q], c[q + 1])
        }
      }
      return best
    }
    case Prim.Circle:
    case Prim.Arc: {
      const cx = c[a]
      const cy = c[a + 1]
      const r = c[a + 2]
      const ang = Math.atan2(y - cy, x - cx)
      if (g.types[i] === Prim.Circle || arcContains(c[a + 3], c[a + 4], ang)) return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)]
      const p0: [number, number] = [cx + r * Math.cos(c[a + 3]), cy + r * Math.sin(c[a + 3])]
      const p1: [number, number] = [cx + r * Math.cos(c[a + 4]), cy + r * Math.sin(c[a + 4])]
      return Math.hypot(p0[0] - x, p0[1] - y) < Math.hypot(p1[0] - x, p1[1] - y) ? p0 : p1
    }
    case Prim.Point:
      return [c[a], c[a + 1]]
    default: {
      const pts = sampled(g, i)
      let best: [number, number] | null = null
      let bd = Infinity
      for (let k = 2; k < pts.length; k += 2) {
        const d = segDist(x, y, pts[k - 2], pts[k - 1], pts[k], pts[k + 1])
        if (d < bd) {
          bd = d
          best = segNearest(x, y, pts[k - 2], pts[k - 1], pts[k], pts[k + 1])
        }
      }
      return best
    }
  }
}

/** Length of a primitive (perimeter for closed shapes). */
export function primLength(g: GeomBuffer, i: number): number {
  const c = g.coords
  const a = g.offsets[i]
  const e = g.offsets[i + 1]
  switch (g.types[i]) {
    case Prim.Line:
      return Math.hypot(c[a + 2] - c[a], c[a + 3] - c[a + 1])
    case Prim.Polyline: {
      let s = 0
      for (let k = a + 2; k < e; k += 2) s += Math.hypot(c[k] - c[k - 2], c[k + 1] - c[k - 1])
      if (g.flags[i] & PrimFlag.Closed) s += Math.hypot(c[a] - c[e - 2], c[a + 1] - c[e - 1])
      return s
    }
    case Prim.Circle:
      return TAU * c[a + 2]
    case Prim.Arc: {
      let span = (c[a + 4] - c[a + 3]) % TAU
      if (span <= 0) span += TAU
      return span * c[a + 2]
    }
    default: {
      const pts = sampled(g, i)
      let s = 0
      for (let k = 2; k < pts.length; k += 2) s += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1])
      return s
    }
  }
}
