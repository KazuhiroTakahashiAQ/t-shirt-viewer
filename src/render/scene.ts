// Build drawable batches for the canvas renderer. Primitives are grouped per layer,
// style and spatial tile into Path2D objects. Paths are stored relative to the tile
// origin so large model coordinates do not lose precision at high zoom.

import { Prim, PrimFlag, type GeomBuffer, type ImageItem, type LayerColor, type Rect, type TextItem } from '../tfas/model.ts'

export interface Batch {
  style: number
  aux: boolean
  ox: number
  oy: number
  bbox: Rect
  path: Path2D
  /** point primitives (x, y pairs relative to origin), drawn as screen-size marks */
  points: number[]
}

export interface SceneLayer {
  index: number
  name: string
  batches: Batch[]
  texts: TextItem[]
  images: ImageItem[]
  bbox: Rect | null
  primitives: number
  /** display color mode (defaults to the document layer's) */
  color?: LayerColor
  /** clip polygon (x, y pairs in model units), for layout viewports */
  clip?: number[] | null
}

const TILES = 24

export function buildLayerBatches(geom: GeomBuffer, bbox: Rect | null): Batch[] {
  if (!geom.count || !bbox) return []
  const w = Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0, 1e-9)
  const tile = w / TILES
  const builders = new Map<number, Batch>()
  const { types, flags, styles, offsets, coords } = geom
  for (let i = 0; i < geom.count; i++) {
    const a = offsets[i]
    const t = types[i]
    const aux = (flags[i] & PrimFlag.Aux) !== 0
    const tx = Math.floor((coords[a] - bbox.x0) / tile)
    const ty = Math.floor((coords[a + 1] - bbox.y0) / tile)
    const key = ((styles[i] * 2 + (aux ? 1 : 0)) * 64 + clampTile(tx)) * 64 + clampTile(ty)
    let b = builders.get(key)
    if (!b) {
      b = {
        style: styles[i],
        aux,
        ox: bbox.x0 + clampTile(tx) * tile,
        oy: bbox.y0 + clampTile(ty) * tile,
        bbox: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
        path: new Path2D(),
        points: [],
      }
      builders.set(key, b)
    }
    appendPrim(b.path, t, flags[i], coords, a, offsets[i + 1], b.ox, b.oy, (x, y) => ext(b, x, y), b.points)
  }
  return [...builders.values()]
}

function clampTile(t: number): number {
  return t < 0 ? 0 : t > 63 ? 63 : t
}

function ext(b: Batch, x: number, y: number) {
  const r = b.bbox
  if (x < r.x0) r.x0 = x
  if (x > r.x1) r.x1 = x
  if (y < r.y0) r.y0 = y
  if (y > r.y1) r.y1 = y
}

/**
 * Append one primitive to a path, relative to (ox, oy). `extend` receives model points
 * covering the primitive; point primitives go to `points` (relative) instead.
 */
export function appendPrim(p: Path2D | CanvasRenderingContext2D, t: number, f: number, c: Float64Array, a: number, end: number, ox: number, oy: number, extend: (x: number, y: number) => void = () => {}, points?: number[]) {
  switch (t) {
    case Prim.Line:
      p.moveTo(c[a] - ox, c[a + 1] - oy)
      p.lineTo(c[a + 2] - ox, c[a + 3] - oy)
      extend(c[a], c[a + 1])
      extend(c[a + 2], c[a + 3])
      break
    case Prim.Polyline:
      p.moveTo(c[a] - ox, c[a + 1] - oy)
      extend(c[a], c[a + 1])
      for (let k = a + 2; k < end; k += 2) {
        p.lineTo(c[k] - ox, c[k + 1] - oy)
        extend(c[k], c[k + 1])
      }
      if (f & PrimFlag.Closed) p.closePath()
      break
    case Prim.Circle: {
      const [cx, cy, r] = [c[a] - ox, c[a + 1] - oy, c[a + 2]]
      p.moveTo(cx + r, cy)
      p.arc(cx, cy, r, 0, Math.PI * 2)
      extend(c[a] - r, c[a + 1] - r)
      extend(c[a] + r, c[a + 1] + r)
      break
    }
    case Prim.Arc: {
      const [cx, cy, r, a0, a1] = [c[a] - ox, c[a + 1] - oy, c[a + 2], c[a + 3], c[a + 4]]
      p.moveTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0))
      p.arc(cx, cy, r, a0, a1, false)
      extend(c[a] - r, c[a + 1] - r)
      extend(c[a] + r, c[a + 1] + r)
      break
    }
    case Prim.Ellipse: {
      const [cx, cy, rx, ry, rot, t0, t1] = [c[a] - ox, c[a + 1] - oy, c[a + 2], c[a + 3], c[a + 4], c[a + 5], c[a + 6]]
      const full = t0 === t1
      const s0 = full ? 0 : t0
      const cr = Math.cos(rot)
      const sr = Math.sin(rot)
      const lx = rx * Math.cos(s0)
      const ly = ry * Math.sin(s0)
      p.moveTo(cx + lx * cr - ly * sr, cy + lx * sr + ly * cr)
      p.ellipse(cx, cy, rx, ry, rot, s0, full ? Math.PI * 2 : t1, false)
      const r = Math.max(rx, ry)
      extend(c[a] - r, c[a + 1] - r)
      extend(c[a] + r, c[a + 1] + r)
      break
    }
    case Prim.Bezier:
      p.moveTo(c[a] - ox, c[a + 1] - oy)
      extend(c[a], c[a + 1])
      for (let k = a + 2; k + 5 < end; k += 6) {
        p.bezierCurveTo(c[k] - ox, c[k + 1] - oy, c[k + 2] - ox, c[k + 3] - oy, c[k + 4] - ox, c[k + 5] - oy)
        extend(c[k], c[k + 1])
        extend(c[k + 2], c[k + 3])
        extend(c[k + 4], c[k + 5])
      }
      break
    case Prim.Point:
      points?.push(c[a] - ox, c[a + 1] - oy)
      extend(c[a], c[a + 1])
      break
  }
}
