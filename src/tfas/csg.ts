// Intersection of closed polygon meshes with BSP trees (the constructive solid geometry
// method popularised by csg.js). Used to cut the extruded outlines of a part's views into
// one solid. Polygons must be convex and planar; coordinates should be of order 1 (EPS).

export type Vec = [number, number, number]

export interface Poly {
  v: Vec[]
  /** plane: n · p = w */
  n: Vec
  w: number
}

const EPS = 1e-6

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** Polygon from its vertices (null when degenerate). */
export function poly(v: Vec[]): Poly | null {
  // Newell normal: robust for slightly non-planar or nearly collinear input
  const n: Vec = [0, 0, 0]
  for (let i = 0; i < v.length; i++) {
    const p = v[i]
    const q = v[(i + 1) % v.length]
    n[0] += (p[1] - q[1]) * (p[2] + q[2])
    n[1] += (p[2] - q[2]) * (p[0] + q[0])
    n[2] += (p[0] - q[0]) * (p[1] + q[1])
  }
  const l = Math.hypot(n[0], n[1], n[2])
  if (!(l > 1e-12)) return null
  const u: Vec = [n[0] / l, n[1] / l, n[2] / l]
  return { v, n: u, w: dot(u, v[0]) }
}

const COPLANAR = 0
const FRONT = 1
const BACK = 2
const SPANNING = 3

/** Sort a polygon against a plane, splitting it when it spans the plane. */
function split(n: Vec, w: number, p: Poly, coFront: Poly[], coBack: Poly[], front: Poly[], back: Poly[]) {
  let type = 0
  const types: number[] = []
  for (const q of p.v) {
    const t = dot(n, q) - w
    const k = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR
    type |= k
    types.push(k)
  }
  switch (type) {
    case COPLANAR:
      ;(dot(n, p.n) > 0 ? coFront : coBack).push(p)
      break
    case FRONT:
      front.push(p)
      break
    case BACK:
      back.push(p)
      break
    default: {
      const f: Vec[] = []
      const b: Vec[] = []
      for (let i = 0; i < p.v.length; i++) {
        const j = (i + 1) % p.v.length
        const ti = types[i]
        const tj = types[j]
        const vi = p.v[i]
        const vj = p.v[j]
        if (ti !== BACK) f.push(vi)
        if (ti !== FRONT) b.push(vi)
        if ((ti | tj) === SPANNING) {
          const t = (w - dot(n, vi)) / dot(n, [vj[0] - vi[0], vj[1] - vi[1], vj[2] - vi[2]])
          const m = lerp(vi, vj, t)
          f.push(m)
          b.push(m)
        }
      }
      if (f.length >= 3) front.push({ v: f, n: p.n, w: p.w })
      if (b.length >= 3) back.push({ v: b, n: p.n, w: p.w })
    }
  }
}

class Node {
  n: Vec | null = null
  w = 0
  front: Node | null = null
  back: Node | null = null
  polys: Poly[] = []

  constructor(polys?: Poly[]) {
    if (polys) this.build(polys)
  }

  invert() {
    for (const p of this.polys) {
      p.v.reverse()
      p.n = [-p.n[0], -p.n[1], -p.n[2]]
      p.w = -p.w
    }
    if (this.n) {
      this.n = [-this.n[0], -this.n[1], -this.n[2]]
      this.w = -this.w
    }
    this.front?.invert()
    this.back?.invert()
    ;[this.front, this.back] = [this.back, this.front]
  }

  /** Parts of the polygons outside this solid. */
  clipPolygons(polys: Poly[]): Poly[] {
    if (!this.n) return polys.slice()
    let front: Poly[] = []
    let back: Poly[] = []
    for (const p of polys) split(this.n, this.w, p, front, back, front, back)
    if (this.front) front = this.front.clipPolygons(front)
    back = this.back ? this.back.clipPolygons(back) : []
    return front.concat(back)
  }

  clipTo(bsp: Node) {
    this.polys = bsp.clipPolygons(this.polys)
    this.front?.clipTo(bsp)
    this.back?.clipTo(bsp)
  }

  all(out: Poly[] = []): Poly[] {
    for (const p of this.polys) out.push(p)
    this.front?.all(out)
    this.back?.all(out)
    return out
  }

  build(polys: Poly[]) {
    if (!polys.length) return
    if (!this.n) {
      this.n = polys[0].n
      this.w = polys[0].w
    }
    const front: Poly[] = []
    const back: Poly[] = []
    for (const p of polys) split(this.n, this.w, p, this.polys, this.polys, front, back)
    if (front.length) (this.front ??= new Node()).build(front)
    if (back.length) (this.back ??= new Node()).build(back)
  }
}

const copy = (ps: Poly[]) => ps.map((p) => ({ v: p.v.slice(), n: p.n, w: p.w }))

/** Polygons of the solid inside both a and b. */
export function intersect(a: Poly[], b: Poly[]): Poly[] {
  const A = new Node(copy(a))
  const B = new Node(copy(b))
  A.invert()
  B.clipTo(A)
  B.invert()
  A.clipTo(B)
  B.clipTo(A)
  A.build(B.all())
  A.invert()
  return A.all()
}
