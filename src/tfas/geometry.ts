// Decoding of geometry bodies (the raw blob inside a type-3 record).
//
// Common 16-byte header:
//   u32 kind   low 16 bits = primitive kind, bits 28..31 = flags
//              (0x8 auxiliary, 0x4 hidden/edit-only, 0x1 arc orientation info)
//   u32 attr   図形属性 id (high byte selects the attribute set; set 0 entries take
//              their display color from the attribute table)
//   u32 color  color number (see render/style.ts for the palette); bit 31 = inherited
//              from the layer's default color
//   u16 ltype  line type number (bit 15 = inherited)
//   u16 width  line width / pen number (bit 15 = inherited)
// followed by kind specific data (f64 coordinates in model units).

import { decodeSjis, dataView } from './container.ts'
import { Prim, PrimFlag, TEXT_ANCHORS, type GeomBuffer, type Rect, type TextItem } from './model.ts'

export const Kind = {
  Point: 0x08,
  Line: 0x10,
  HLine: 0x18,
  VLine: 0x20,
  XLineV: 0x28,
  XLineH: 0x30,
  Polyline: 0x38,
  Polygon: 0x39,
  Circle: 0x40,
  Arc: 0x48,
  Ellipse: 0x50,
  EllipseArc: 0x58,
  Spline: 0x60,
  Polyline3D: 0x68,
  Text: 0x70,
} as const

export interface BodyHeader {
  kind: number
  flags: number
  /** attribute id including the set number (bits 24..30) */
  attr: number
  /** attribute table selector (high byte without bit 7); 0 = 図形属性 table in section 1 */
  attrSet: number
  color: number
  /** color is inherited (bit 31) */
  colorInherited: boolean
  linetype: number
  width: number
}

export function readHeader(v: DataView): BodyHeader {
  const k = v.getUint32(0, true)
  return {
    kind: k & 0xffff,
    flags: k >>> 28,
    attr: v.getUint32(4, true) & 0x7fffffff,
    attrSet: (v.getUint32(4, true) >>> 24) & 0x7f,
    color: v.getUint32(8, true) & 0xffff,
    colorInherited: (v.getUint32(8, true) & 0x80000000) !== 0,
    linetype: v.getUint16(12, true) & 0x7fff,
    width: v.getUint16(14, true) & 0x7fff,
  }
}

export function primFlags(h: BodyHeader): number {
  let f = 0
  if (h.flags & 0x8) f |= PrimFlag.Aux
  if (h.flags & 0x4) f |= PrimFlag.Hidden
  return f
}

/** Growable flat storage for primitives. */
export class GeomBuilder {
  count = 0
  private types = new Uint8Array(1024)
  private flags = new Uint8Array(1024)
  private styles = new Uint16Array(1024)
  private offsets = new Uint32Array(1025)
  private entities = new Uint32Array(1024)
  private attrs = new Uint32Array(1024)
  private coords = new Float64Array(8192)
  private clen = 0
  /** entity assigned to the primitives that follow */
  entity = 0
  /** Tfas レイヤ (attribute id) assigned to the primitives that follow */
  attr = 0
  bbox: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }

  begin(type: number, flags: number, style: number, ncoords: number): number {
    if (this.count + 1 >= this.types.length) {
      const n = this.types.length * 2
      this.types = grow(this.types, n)
      this.flags = grow(this.flags, n)
      this.styles = grow(this.styles, n)
      this.offsets = grow(this.offsets, n + 1)
      this.entities = grow(this.entities, n)
      this.attrs = grow(this.attrs, n)
    }
    if (this.clen + ncoords > this.coords.length) {
      this.coords = grow(this.coords, Math.max(this.coords.length * 2, this.clen + ncoords))
    }
    const i = this.count++
    this.types[i] = type
    this.flags[i] = flags
    this.styles[i] = style
    this.entities[i] = this.entity
    this.attrs[i] = this.attr
    this.offsets[i] = this.clen
    const at = this.clen
    this.clen += ncoords
    this.offsets[this.count] = this.clen
    return at
  }

  set(at: number, ...vals: number[]) {
    for (let i = 0; i < vals.length; i++) this.coords[at + i] = vals[i]
  }

  get rawCoords(): Float64Array {
    return this.coords
  }

  extend(x: number, y: number) {
    const b = this.bbox
    if (x < b.x0) b.x0 = x
    if (x > b.x1) b.x1 = x
    if (y < b.y0) b.y0 = y
    if (y > b.y1) b.y1 = y
  }

  finish() {
    return {
      count: this.count,
      types: this.types.slice(0, this.count),
      flags: this.flags.slice(0, this.count),
      styles: this.styles.slice(0, this.count),
      offsets: this.offsets.slice(0, this.count + 1),
      coords: this.coords.slice(0, this.clen),
      entity: this.entities.slice(0, this.count),
      attr: this.attrs.slice(0, this.count),
    }
  }
}

function grow<T extends Uint8Array | Uint16Array | Uint32Array | Float64Array>(a: T, n: number): T {
  const b = new (a.constructor as { new (n: number): T })(n)
  b.set(a)
  return b
}

const TAU = Math.PI * 2

/**
 * Append the primitive encoded in `body` to `g`. Returns false for kinds that are not
 * drawable geometry (text is handled separately, infinite construction lines are skipped).
 */
export function decodeGeometry(body: Uint8Array, h: BodyHeader, style: number, flags: number, g: GeomBuilder): boolean {
  const v = dataView(body)
  const n = body.length
  const d = (i: number) => v.getFloat64(16 + 8 * i, true)
  switch (h.kind) {
    case Kind.Line:
    case Kind.HLine:
    case Kind.VLine: {
      let x0 = d(0)
      let y0 = d(1)
      let x1 = d(2)
      let y1 = 0
      if (h.kind === Kind.Line) {
        y1 = d(3)
      } else if (h.kind === Kind.HLine) {
        // y, x0, x1
        y0 = d(0)
        x0 = d(1)
        y1 = y0
      } else {
        // x, y0, y1
        y1 = d(2)
        x1 = x0
      }
      const at = g.begin(Prim.Line, flags, style, 4)
      g.set(at, x0, y0, x1, y1)
      g.extend(x0, y0)
      g.extend(x1, y1)
      return true
    }
    case Kind.Polyline:
    case Kind.Polygon:
    case Kind.Polyline3D: {
      if (n < 24) return false
      const cnt = v.getUint32(16, true)
      // u32 @20: 0 = closed, 1 = open (open outlines repeat the first point to close)
      const closed = v.getUint32(20, true) === 0 || h.kind === Kind.Polygon
      const stride = h.kind === Kind.Polyline3D ? 24 : 16
      if (cnt < 2 || 24 + cnt * stride > n) return false
      const at = g.begin(Prim.Polyline, flags | (closed ? PrimFlag.Closed : 0), style, cnt * 2)
      const c = g.rawCoords
      for (let i = 0; i < cnt; i++) {
        const x = v.getFloat64(24 + i * stride, true)
        const y = v.getFloat64(32 + i * stride, true)
        c[at + 2 * i] = x
        c[at + 2 * i + 1] = y
        g.extend(x, y)
      }
      return true
    }
    case Kind.Circle: {
      const [cx, cy, r] = [d(0), d(1), d(2)]
      if (!okRadius(r) || !Number.isFinite(cx + cy)) return false
      const at = g.begin(Prim.Circle, flags, style, 3)
      g.set(at, cx, cy, r)
      g.extend(cx - r, cy - r)
      g.extend(cx + r, cy + r)
      return true
    }
    case Kind.Arc: {
      const [cx, cy, r, sx, sy, ex, ey] = [d(0), d(1), d(2), d(3), d(4), d(5), d(6)]
      if (!okRadius(r) || !Number.isFinite(cx + cy + sx + sy + ex + ey)) return false
      const a0 = Math.atan2(sy - cy, sx - cx)
      let a1 = Math.atan2(ey - cy, ex - cx)
      if (a1 <= a0) a1 += TAU
      const at = g.begin(Prim.Arc, flags, style, 5)
      g.set(at, cx, cy, r, a0, a1)
      arcBounds(g, cx, cy, r, a0, a1)
      return true
    }
    case Kind.Ellipse:
    case Kind.EllipseArc: {
      const [cx, cy, rx, ry, rotDeg] = [d(0), d(1), d(2), d(3), d(4)]
      if (!okRadius(rx) || !okRadius(ry) || !Number.isFinite(cx + cy + rotDeg)) return false
      const rot = (rotDeg * Math.PI) / 180
      let t0 = 0
      let t1 = 0
      if (h.kind === Kind.EllipseArc) {
        const param = (x: number, y: number) => {
          const dx = x - cx
          const dy = y - cy
          const lx = dx * Math.cos(rot) + dy * Math.sin(rot)
          const ly = -dx * Math.sin(rot) + dy * Math.cos(rot)
          return Math.atan2(ly / ry, lx / rx)
        }
        t0 = param(d(5), d(6))
        t1 = param(d(7), d(8))
        if (t1 <= t0) t1 += TAU
      }
      const at = g.begin(Prim.Ellipse, flags, style, 7)
      g.set(at, cx, cy, rx, ry, rot, t0, t1)
      const r = Math.max(rx, ry)
      g.extend(cx - r, cy - r)
      g.extend(cx + r, cy + r)
      return true
    }
    case Kind.Spline: {
      // u32 count, u32, u32, u32, then per point: x y tx ty len (f64) + 8 bytes
      if (n < 32) return false
      const cnt = v.getUint32(16, true)
      if (cnt < 2 || 32 + cnt * 48 > n) return false
      const at = g.begin(Prim.Bezier, flags, style, 2 + (cnt - 1) * 6)
      const c = g.rawCoords
      const P = (i: number, k: number) => v.getFloat64(32 + i * 48 + k * 8, true)
      c[at] = P(0, 0)
      c[at + 1] = P(0, 1)
      g.extend(c[at], c[at + 1])
      for (let i = 0; i < cnt - 1; i++) {
        const [x0, y0, tx0, ty0, len] = [P(i, 0), P(i, 1), P(i, 2), P(i, 3), P(i, 4)]
        const [x1, y1, tx1, ty1] = [P(i + 1, 0), P(i + 1, 1), P(i + 1, 2), P(i + 1, 3)]
        // Hermite (tangent * segment length) -> cubic Bezier
        const o = at + 2 + i * 6
        c[o] = x0 + (tx0 * len) / 3
        c[o + 1] = y0 + (ty0 * len) / 3
        c[o + 2] = x1 - (tx1 * len) / 3
        c[o + 3] = y1 - (ty1 * len) / 3
        c[o + 4] = x1
        c[o + 5] = y1
        g.extend(c[o], c[o + 1])
        g.extend(c[o + 2], c[o + 3])
        g.extend(x1, y1)
      }
      return true
    }
    case Kind.Point: {
      const at = g.begin(Prim.Point, flags, style, 2)
      g.set(at, d(0), d(1))
      g.extend(d(0), d(1))
      return true
    }
    default:
      return false
  }
}

/** Tessellate a primitive into segments. */
export function primSegments(g: GeomBuffer, i: number, out: (x0: number, y0: number, x1: number, y1: number) => void) {
  const c = g.coords
  const a = g.offsets[i]
  const e = g.offsets[i + 1]
  const arc = (cx: number, cy: number, rx: number, ry: number, rot: number, t0: number, t1: number) => {
    const n = Math.max(2, Math.min(96, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 32))))
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    const p = (t: number): [number, number] => {
      const x = rx * Math.cos(t)
      const y = ry * Math.sin(t)
      return [cx + x * cr - y * sr, cy + x * sr + y * cr]
    }
    let [px, py] = p(t0)
    for (let k = 1; k <= n; k++) {
      const [x, y] = p(t0 + ((t1 - t0) * k) / n)
      out(px, py, x, y)
      px = x
      py = y
    }
  }
  switch (g.types[i]) {
    case Prim.Line:
      out(c[a], c[a + 1], c[a + 2], c[a + 3])
      break
    case Prim.Polyline:
      for (let k = a; k + 3 < e; k += 2) out(c[k], c[k + 1], c[k + 2], c[k + 3])
      if (g.flags[i] & PrimFlag.Closed && e - a >= 6) out(c[e - 2], c[e - 1], c[a], c[a + 1])
      break
    case Prim.Circle:
      arc(c[a], c[a + 1], c[a + 2], c[a + 2], 0, 0, Math.PI * 2)
      break
    case Prim.Arc:
      arc(c[a], c[a + 1], c[a + 2], c[a + 2], 0, c[a + 3], c[a + 4])
      break
    case Prim.Ellipse: {
      const full = c[a + 5] === c[a + 6]
      arc(c[a], c[a + 1], c[a + 2], c[a + 3], c[a + 4], full ? 0 : c[a + 5], full ? Math.PI * 2 : c[a + 6])
      break
    }
    case Prim.Bezier: {
      let px = c[a]
      let py = c[a + 1]
      for (let k = a + 2; k + 5 < e; k += 6) {
        const [x0, y0] = [px, py]
        for (let s = 1; s <= 8; s++) {
          const t = s / 8
          const u = 1 - t
          const x = u * u * u * x0 + 3 * u * u * t * c[k] + 3 * u * t * t * c[k + 2] + t * t * t * c[k + 4]
          const y = u * u * u * y0 + 3 * u * u * t * c[k + 1] + 3 * u * t * t * c[k + 3] + t * t * t * c[k + 5]
          out(px, py, x, y)
          px = x
          py = y
        }
      }
      break
    }
  }
}

/** Radii must be finite and not negative (canvas arc() throws on negative ones). */
function okRadius(r: number): boolean {
  return Number.isFinite(r) && r >= 0
}

function arcBounds(g: GeomBuilder, cx: number, cy: number, r: number, a0: number, a1: number) {
  g.extend(cx + r * Math.cos(a0), cy + r * Math.sin(a0))
  g.extend(cx + r * Math.cos(a1), cy + r * Math.sin(a1))
  for (let k = Math.ceil(a0 / (Math.PI / 2)); k * (Math.PI / 2) <= a1; k++) {
    const a = k * (Math.PI / 2)
    g.extend(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
}

/**
 * Text body layout after the header:
 *   16 f64 x, y, angle(deg), height, char width, (unused)
 *   64 f64 line gap (行間)
 *   72 u16, 74 u8 flags (0x20 = sizes are model units, otherwise paper mm),
 *   76 u8 width ratio %, 77 u8 flags, 78 u8 anchor code (low nibble)
 *   79 font name (CP932, NUL terminated, may be empty) then text (NUL terminated, lines end with \n)
 *   then f64 (unknown)
 */
export function decodeText(body: Uint8Array, style: number, flags: number, docScale: number): TextItem | null {
  if (body.length < 82) return null
  const v = dataView(body)
  const x = v.getFloat64(16, true)
  const y = v.getFloat64(24, true)
  const angle = v.getFloat64(32, true)
  let height = v.getFloat64(40, true)
  let width = v.getFloat64(48, true)
  let gap = v.getFloat64(64, true)
  if (!(body[74] & 0x20)) {
    height *= docScale
    width *= docScale
    gap *= docScale
  }
  const fontEnd = body.indexOf(0, 79)
  if (fontEnd < 0) return null
  const textEnd = body.indexOf(0, fontEnd + 1)
  if (textEnd < 0) return null
  const font = decodeSjis(body.subarray(79, fontEnd))
  const text = decodeSjis(body.subarray(fontEnd + 1, textEnd)).replace(/\r/g, '').replace(/\n+$/, '')
  const align = TEXT_ANCHORS[body[78] & 0x0f] ? body[78] & 0x0f : 1
  if (!(height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null
  const item: TextItem = {
    x,
    y,
    angle: Number.isFinite(angle) ? angle : 0,
    height,
    width: width > 0 ? width : height,
    pitch: height + (gap > 0 && Number.isFinite(gap) ? gap : 0),
    align,
    text,
    font,
    style,
    flags,
    bbox: { x0: x, y0: y, x1: x, y1: y },
    entity: 0,
    attr: 0,
  }
  item.bbox = textBounds(item)
  return item
}

export function isHalfWidth(code: number): boolean {
  return code < 0x80 || (code >= 0xff61 && code <= 0xff9f)
}

export interface TextLine {
  /** x offset of every character relative to the anchor (model units, along the text direction) */
  xs: number[]
  chars: string[]
  /** half-width flags per character */
  half: boolean[]
  /** baseline (bottom of the character box) offset perpendicular to the text direction, y up */
  y: number
  width: number
}

/** Lay out text lines in the text's local frame (origin = anchor, x along the text, y up). */
export function layoutText(t: TextItem): TextLine[] {
  const pitch = t.pitch
  const [hc, vr] = TEXT_ANCHORS[t.align] ?? [0, 0]
  const lines = t.text.split('\n')
  const n = lines.length
  const total = t.height + (n - 1) * pitch
  const out: TextLine[] = []
  for (let i = 0; i < n; i++) {
    const chars = Array.from(lines[i])
    const xs: number[] = []
    const half: boolean[] = []
    let cx = 0
    for (let k = 0; k < chars.length; k++) {
      const hw = isHalfWidth(chars[k].codePointAt(0) ?? 0)
      xs.push(cx)
      half.push(hw)
      cx += hw ? t.width / 2 : t.width
    }
    const width = cx
    const shift = -width * (hc / 2)
    for (let k = 0; k < xs.length; k++) xs[k] += shift
    let y: number
    if (vr === 0) y = (n - 1 - i) * pitch
    else if (vr === 1) y = total / 2 - t.height - i * pitch
    else y = -t.height - i * pitch
    out.push({ xs, chars, half, y, width })
  }
  return out
}

export function textBounds(t: TextItem): Rect {
  const lines = layoutText(t)
  const a = (t.angle * Math.PI) / 180
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const r: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const ln of lines) {
    const lx0 = ln.xs.length ? ln.xs[0] : 0
    const lx1 = lx0 + ln.width
    for (const [lx, ly] of [
      [lx0, ln.y],
      [lx1, ln.y],
      [lx0, ln.y + t.height],
      [lx1, ln.y + t.height],
    ]) {
      const x = t.x + lx * ca - ly * sa
      const y = t.y + lx * sa + ly * ca
      if (x < r.x0) r.x0 = x
      if (x > r.x1) r.x1 = x
      if (y < r.y0) r.y0 = y
      if (y > r.y1) r.y1 = y
    }
  }
  return r
}
