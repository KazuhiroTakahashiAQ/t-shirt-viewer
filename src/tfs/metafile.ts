// Raster playback of Windows metafiles (EMF / WMF) found in OLE presentation data.
//
// Pictures pasted into the CAD (screenshots, photos, icons) are stored as metafiles that
// only blit bitmaps: StretchDIBits, often as a mask + image pair combined with raster
// operations for transparency. This player executes those bitmap records into one RGBA
// image. Vector records (lines, text, fills) are counted as skipped.

import { dataView } from './container.ts'
import type { Thumbnail } from './model.ts'
import { decodeDibParts, dibInfoSize } from './thumbnail.ts'

export interface MetafileImage {
  bitmap: Thumbnail
  /** drawing records that were not rendered (vector graphics, text) */
  skipped: number
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** One bitmap or pattern operation in picture device units. */
interface Blit {
  /** destination; x1 < x0 or y1 < y0 mirrors the source */
  dest: Box
  src: Thumbnail | null
  /** source rectangle in top-down pixel coordinates */
  sx: number
  sy: number
  sw: number
  sh: number
  /** ROP3 code (the high byte of the 32-bit raster operation) */
  rop: number
  brush: number | null
  clip: Box | null
  alpha?: { constant: number; perPixel: boolean }
  transparent?: number
}

const MAX_SIDE = 4096

// ---------------------------------------------------------------- compositor

function rop3(code: number, p: number, s: number, d: number): number {
  let r = 0
  for (let i = 0; i < 8; i++) if ((code >> i) & 1) r |= (i & 4 ? p : ~p) & (i & 2 ? s : ~s) & (i & 1 ? d : ~d)
  return r & 0xff
}

function composite(pic: Box, blits: Blit[]): Thumbnail | null {
  const pw = pic.x1 - pic.x0
  const ph = pic.y1 - pic.y0
  if (!(pw > 0 && ph > 0) || !blits.length) return null
  // resolution: the finest source bitmap decides; plain fills use device units
  let scale = 0
  for (const b of blits) {
    if (!b.src) continue
    const dw = Math.abs(b.dest.x1 - b.dest.x0)
    const dh = Math.abs(b.dest.y1 - b.dest.y0)
    if (dw > 0) scale = Math.max(scale, b.sw / dw)
    if (dh > 0) scale = Math.max(scale, b.sh / dh)
  }
  if (!scale) scale = 1
  scale = Math.min(scale, MAX_SIDE / Math.max(pw, ph))
  const W = Math.max(1, Math.round(pw * scale))
  const H = Math.max(1, Math.round(ph * scale))
  const out = new Uint8ClampedArray(W * H * 4)

  for (const b of blits) {
    let bx0 = Math.min(b.dest.x0, b.dest.x1)
    let by0 = Math.min(b.dest.y0, b.dest.y1)
    let bx1 = Math.max(b.dest.x0, b.dest.x1)
    let by1 = Math.max(b.dest.y0, b.dest.y1)
    if (b.clip) {
      bx0 = Math.max(bx0, b.clip.x0)
      by0 = Math.max(by0, b.clip.y0)
      bx1 = Math.min(bx1, b.clip.x1)
      by1 = Math.min(by1, b.clip.y1)
    }
    const ox0 = Math.max(0, Math.floor((bx0 - pic.x0) * scale))
    const oy0 = Math.max(0, Math.floor((by0 - pic.y0) * scale))
    const ox1 = Math.min(W, Math.ceil((bx1 - pic.x0) * scale))
    const oy1 = Math.min(H, Math.ceil((by1 - pic.y0) * scale))
    const dw = b.dest.x1 - b.dest.x0
    const dh = b.dest.y1 - b.dest.y0
    if (!dw || !dh) continue
    const src = b.src
    const P = b.brush ?? 0
    const pr = (P >> 16) & 255
    const pg = (P >> 8) & 255
    const pb = P & 255
    for (let oy = oy0; oy < oy1; oy++) {
      const py = pic.y0 + (oy + 0.5) / scale
      if (py < by0 || py > by1) continue
      const v = (py - b.dest.y0) / dh
      if (v < 0 || v >= 1) continue
      const srow = src ? Math.floor(b.sy + v * b.sh) : 0
      if (src && (srow < 0 || srow >= src.height)) continue
      for (let ox = ox0; ox < ox1; ox++) {
        const px = pic.x0 + (ox + 0.5) / scale
        if (px < bx0 || px > bx1) continue
        const u = (px - b.dest.x0) / dw
        if (u < 0 || u >= 1) continue
        let sr = 0
        let sg = 0
        let sb = 0
        let sa = 255
        if (src) {
          const scol = Math.floor(b.sx + u * b.sw)
          if (scol < 0 || scol >= src.width) continue
          const si = (srow * src.width + scol) * 4
          sr = src.rgba[si]
          sg = src.rgba[si + 1]
          sb = src.rgba[si + 2]
          sa = src.rgba[si + 3]
        }
        const o = (oy * W + ox) * 4
        if (b.transparent !== undefined) {
          if (((sr << 16) | (sg << 8) | sb) === b.transparent) continue
          out[o] = sr
          out[o + 1] = sg
          out[o + 2] = sb
          out[o + 3] = 255
          continue
        }
        if (b.alpha) {
          // AlphaBlend: per-pixel alpha sources are premultiplied
          const ca = b.alpha.constant / 255
          const a = (b.alpha.perPixel ? sa / 255 : 1) * ca
          if (a <= 0) continue
          const k = b.alpha.perPixel ? ca : a
          const da = out[o + 3] / 255
          const oa = a + da * (1 - a)
          for (let c = 0; c < 3; c++) {
            const s = c === 0 ? sr : c === 1 ? sg : sb
            out[o + c] = (s * k + out[o + c] * da * (1 - a)) / oa
          }
          out[o + 3] = oa * 255
          continue
        }
        const code = b.rop
        if (code === 0xcc) {
          out[o] = sr
          out[o + 1] = sg
          out[o + 2] = sb
          out[o + 3] = 255
          continue
        }
        if (code === 0xaa) continue
        if (out[o + 3] === 0) {
          // transparent destination: keep it when the operation leaves the destination as is
          // (e.g. the OR / AND passes of a transparency mask), otherwise assume white paper
          const r0 = [rop3(code, pr, sr, 0), rop3(code, pg, sg, 0), rop3(code, pb, sb, 0)]
          const r1 = [rop3(code, pr, sr, 255), rop3(code, pg, sg, 255), rop3(code, pb, sb, 255)]
          if (r0[0] === 0 && r0[1] === 0 && r0[2] === 0 && r1[0] === 255 && r1[1] === 255 && r1[2] === 255) continue
          out[o] = r1[0]
          out[o + 1] = r1[1]
          out[o + 2] = r1[2]
          out[o + 3] = 255
        } else {
          out[o] = rop3(code, pr, sr, out[o])
          out[o + 1] = rop3(code, pg, sg, out[o + 1])
          out[o + 2] = rop3(code, pb, sb, out[o + 2])
        }
      }
    }
  }
  for (let i = 3; i < out.length; i += 4) if (out[i]) return { width: W, height: H, rgba: out }
  return null
}

// ---------------------------------------------------------------- shared device context

interface Dc {
  mapMode: number
  wox: number
  woy: number
  wex: number
  wey: number
  vox: number
  voy: number
  vex: number
  vey: number
  /** world transform m11 m12 m21 m22 dx dy (EMF only) */
  world: number[]
  brush: number | null
  clip: Box | null
}

const newDc = (): Dc => ({ mapMode: 1, wox: 0, woy: 0, wex: 1, wey: 1, vox: 0, voy: 0, vex: 1, vey: 1, world: [1, 0, 0, 1, 0, 0], brush: 0xffffff, clip: null })
const cloneDc = (d: Dc): Dc => ({ ...d, world: [...d.world], clip: d.clip && { ...d.clip } })

const colorRef = (c: number) => ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)

const STOCK_BRUSHES: Record<number, number | null> = { 0: 0xffffff, 1: 0xc0c0c0, 2: 0x808080, 3: 0x404040, 4: 0x000000, 5: null }

function intersect(a: Box | null, b: Box): Box {
  if (!a) return b
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }
}

const norm = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) })

/** Average color of a pattern brush bitmap, as a solid approximation. */
function averageColor(t: Thumbnail | null): number | null {
  if (!t) return null
  let r = 0
  let g = 0
  let b = 0
  const n = t.width * t.height
  for (let i = 0; i < n; i++) {
    r += t.rgba[i * 4]
    g += t.rgba[i * 4 + 1]
    b += t.rgba[i * 4 + 2]
  }
  return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)
}

/** Source rows for StretchDIBits-style calls count from the bottom of bottom-up DIBs. */
function dibSourceY(info: Uint8Array, ySrc: number, cySrc: number, height: number): number {
  const v = dataView(info)
  const bottomUp = v.getUint32(0, true) === 12 ? true : v.getInt32(8, true) > 0
  return bottomUp ? height - ySrc - cySrc : ySrc
}

// ---------------------------------------------------------------- EMF

const EMF_DRAWING = new Set([2, 3, 4, 5, 6, 7, 8, 42, 43, 44, 45, 46, 47, 54, 55, 56, 62, 63, 64, 71, 72, 73, 74, 78, 79, 83, 84, 85, 86, 87, 88, 89, 90, 91, 96, 97, 108, 118])

/** True when `b` starts with an EMF header record. */
export function isEmf(b: Uint8Array): boolean {
  return b.length >= 88 && dataView(b).getUint32(0, true) === 1 && dataView(b).getUint32(40, true) === 0x464d4520
}

export function renderEmf(b: Uint8Array): MetafileImage | null {
  if (!isEmf(b)) return null
  const v = dataView(b)
  const i32 = (o: number) => v.getInt32(o, true)
  const u32 = (o: number) => v.getUint32(o, true)
  const devPx = [i32(72), i32(76)]
  const devMm = [i32(80), i32(84)]
  const pxPerMm = [devMm[0] > 0 ? devPx[0] / devMm[0] : 96 / 25.4, devMm[1] > 0 ? devPx[1] / devMm[1] : 96 / 25.4]
  // picture rectangle: rclFrame (0.01 mm) in device units, else rclBounds
  let pic = norm((i32(24) / 100) * pxPerMm[0], (i32(28) / 100) * pxPerMm[1], (i32(32) / 100) * pxPerMm[0], (i32(36) / 100) * pxPerMm[1])
  if (!(pic.x1 > pic.x0 && pic.y1 > pic.y0)) pic = { x0: i32(8), y0: i32(12), x1: i32(16) + 1, y1: i32(20) + 1 }

  let dc = newDc()
  const stack: Dc[] = []
  const objects = new Map<number, number | null>()
  const blits: Blit[] = []
  let skipped = 0

  const toDevice = (x: number, y: number): [number, number] => {
    const w = dc.world
    const wx = x * w[0] + y * w[2] + w[4]
    const wy = x * w[1] + y * w[3] + w[5]
    let sx = 1
    let sy = 1
    switch (dc.mapMode) {
      case 2: // MM_LOMETRIC
      case 3: // MM_HIMETRIC
      case 4: // MM_LOENGLISH
      case 5: // MM_HIENGLISH
      case 6: {
        // MM_TWIPS
        const mm = [0, 0, 0.1, 0.01, 0.254, 0.0254, 25.4 / 1440][dc.mapMode]
        sx = mm * pxPerMm[0]
        sy = -mm * pxPerMm[1]
        break
      }
      case 7:
      case 8: {
        sx = dc.wex ? dc.vex / dc.wex : 1
        sy = dc.wey ? dc.vey / dc.wey : 1
        if (dc.mapMode === 7) {
          const s = Math.min(Math.abs(sx), Math.abs(sy))
          sx = Math.sign(sx || 1) * s
          sy = Math.sign(sy || 1) * s
        }
        break
      }
    }
    return [(wx - dc.wox) * sx + dc.vox, (wy - dc.woy) * sy + dc.voy]
  }
  const destBox = (x: number, y: number, cx: number, cy: number): Box => {
    const [x0, y0] = toDevice(x, y)
    const [x1, y1] = toDevice(x + cx, y + cy)
    return { x0, y0, x1, y1 }
  }
  const bitmap = (rec: Uint8Array, offBmi: number, cbBmi: number, offBits: number, cbBits: number, keepAlpha = false) => {
    if (!cbBmi || offBmi + cbBmi > rec.length) return null
    const info = rec.subarray(offBmi, offBmi + cbBmi)
    if (!dibInfoSize(info)) return null
    return { info, src: decodeDibParts(info, rec.subarray(offBits, Math.min(rec.length, offBits + cbBits)), keepAlpha) }
  }

  let off = 0
  while (off + 8 <= b.length) {
    const type = u32(off)
    const size = u32(off + 4)
    if (size < 8 || off + size > b.length) break
    const rec = b.subarray(off, off + size)
    const r = dataView(rec)
    const ri = (o: number) => (o + 4 <= size ? r.getInt32(o, true) : 0)
    const ru = (o: number) => (o + 4 <= size ? r.getUint32(o, true) : 0)
    const rf = (o: number) => (o + 4 <= size ? r.getFloat32(o, true) : 0)
    switch (type) {
      case 9:
        dc.wex = ri(8)
        dc.wey = ri(12)
        break
      case 10:
        dc.wox = ri(8)
        dc.woy = ri(12)
        break
      case 11:
        dc.vex = ri(8)
        dc.vey = ri(12)
        break
      case 12:
        dc.vox = ri(8)
        dc.voy = ri(12)
        break
      case 17:
        dc.mapMode = ru(8)
        break
      case 33:
        stack.push(cloneDc(dc))
        break
      case 34: {
        const n = ri(8)
        const keep = n < 0 ? stack.length + n : n - 1
        if (keep >= 0 && keep < stack.length) {
          dc = stack[keep]
          stack.length = keep
        }
        break
      }
      case 35:
        dc.world = [rf(8), rf(12), rf(16), rf(20), rf(24), rf(28)]
        break
      case 36: {
        const m = [rf(8), rf(12), rf(16), rf(20), rf(24), rf(28)]
        const mode = ru(32)
        const w = dc.world
        const mul = (a: number[], c: number[]) => [a[0] * c[0] + a[1] * c[2], a[0] * c[1] + a[1] * c[3], a[2] * c[0] + a[3] * c[2], a[2] * c[1] + a[3] * c[3], a[4] * c[0] + a[5] * c[2] + c[4], a[4] * c[1] + a[5] * c[3] + c[5]]
        if (mode === 1) dc.world = [1, 0, 0, 1, 0, 0]
        else if (mode === 2) dc.world = mul(m, w)
        else if (mode === 3) dc.world = mul(w, m)
        else if (mode === 4) dc.world = m
        break
      }
      case 37: {
        const ih = ru(8)
        if (ih & 0x80000000) {
          const stock = ih & 0x7fffffff
          if (stock in STOCK_BRUSHES) dc.brush = STOCK_BRUSHES[stock]
        } else if (objects.has(ih)) dc.brush = objects.get(ih) ?? null
        break
      }
      case 39: // CREATEBRUSHINDIRECT
        objects.set(ru(8), ru(12) === 1 ? null : colorRef(ru(16)))
        break
      case 93: // CREATEMONOBRUSH
      case 94: {
        // CREATEDIBPATTERNBRUSHPT
        const bm = bitmap(rec, ru(16), ru(20), ru(24), ru(28))
        objects.set(ru(8), averageColor(bm?.src ?? null))
        break
      }
      case 40:
        objects.delete(ru(8))
        break
      case 30: {
        // INTERSECTCLIPRECT
        const [x0, y0] = toDevice(ri(8), ri(12))
        const [x1, y1] = toDevice(ri(16), ri(20))
        dc.clip = intersect(dc.clip, norm(x0, y0, x1, y1))
        break
      }
      case 75: {
        // EXTSELECTCLIPRGN: region data is in device units
        const cb = ru(8)
        const mode = ru(12)
        if (mode === 5 && cb === 0) dc.clip = null
        else if (cb >= 32) {
          const box = norm(ri(32), ri(36), ri(40), ri(44))
          if (mode === 5) dc.clip = box
          else if (mode === 1) dc.clip = intersect(dc.clip, box)
        }
        break
      }
      case 76: // BITBLT
      case 77: // STRETCHBLT
      case 114: // ALPHABLEND
      case 116: {
        // TRANSPARENTBLT
        const dest = destBox(ri(24), ri(28), ri(32), ri(36))
        const op = ru(40)
        const xf = [rf(52), rf(56), rf(60), rf(64), rf(68), rf(72)]
        const bm = bitmap(rec, ru(84), ru(88), ru(92), ru(96), type === 114)
        let cxSrc = type === 76 ? ri(32) : ri(100)
        let cySrc = type === 76 ? ri(36) : ri(104)
        if (!bm) {
          if (type !== 76 && type !== 77) break
          blits.push({ dest, src: null, sx: 0, sy: 0, sw: 0, sh: 0, rop: (op >> 16) & 0xff, brush: dc.brush, clip: dc.clip })
          break
        }
        if (!bm.src) {
          skipped++
          break
        }
        const sx = ri(44) * xf[0] + ri(48) * xf[2] + xf[4]
        const sy = ri(44) * xf[1] + ri(48) * xf[3] + xf[5]
        if (xf[0]) cxSrc *= xf[0]
        if (xf[3]) cySrc *= xf[3]
        const blit: Blit = { dest, src: bm.src, sx, sy, sw: cxSrc, sh: cySrc, rop: (op >> 16) & 0xff, brush: dc.brush, clip: dc.clip }
        if (type === 114) blit.alpha = { constant: (op >> 16) & 0xff, perPixel: ((op >> 24) & 0xff) === 1 }
        if (type === 116) blit.transparent = colorRef(op)
        blits.push(blit)
        break
      }
      case 80: // SETDIBITSTODEVICE
      case 81: {
        // STRETCHDIBITS
        const cxSrc = ri(40)
        const cySrc = ri(44)
        const dest = type === 81 ? destBox(ri(24), ri(28), ri(72), ri(76)) : destBox(ri(24), ri(28), cxSrc, cySrc)
        const bm = bitmap(rec, ru(48), ru(52), ru(56), ru(60))
        if (!bm?.src) {
          skipped++
          break
        }
        const rop = type === 81 ? (ru(68) >> 16) & 0xff : 0xcc
        blits.push({ dest, src: bm.src, sx: ri(32), sy: dibSourceY(bm.info, ri(36), cySrc, bm.src.height), sw: cxSrc, sh: cySrc, rop, brush: dc.brush, clip: dc.clip })
        break
      }
      case 14:
        off = b.length
        continue
      default:
        if (EMF_DRAWING.has(type)) skipped++
    }
    off += size
  }
  const bitmapOut = composite(pic, blits)
  return bitmapOut ? { bitmap: bitmapOut, skipped } : null
}

// ---------------------------------------------------------------- WMF

const WMF_DRAWING = new Set([0x0213, 0x0325, 0x0324, 0x0538, 0x041b, 0x061c, 0x0418, 0x0817, 0x081a, 0x0830, 0x0521, 0x0a32, 0x0228, 0x0419, 0x0548, 0x0429, 0x012b, 0x041f, 0x0922, 0x0b23])

/** True when `b` looks like a WMF (optionally with the placeable header). */
export function isWmf(b: Uint8Array): boolean {
  if (b.length < 18) return false
  const v = dataView(b)
  if (v.getUint32(0, true) === 0x9ac6cdd7) return true
  return (v.getUint16(0, true) === 1 || v.getUint16(0, true) === 2) && v.getUint16(2, true) === 9
}

export function renderWmf(b: Uint8Array): MetafileImage | null {
  if (!isWmf(b)) return null
  const v = dataView(b)
  let base = 0
  let pic: Box | null = null
  if (v.getUint32(0, true) === 0x9ac6cdd7 && b.length >= 22 + 18) {
    pic = norm(v.getInt16(6, true), v.getInt16(8, true), v.getInt16(10, true), v.getInt16(12, true))
    base = 22
  }
  const headerWords = v.getUint16(base + 2, true)
  let off = base + headerWords * 2

  let dc = newDc()
  const stack: Dc[] = []
  const objects: (number | null | undefined)[] = []
  const kinds: string[] = []
  const blits: Blit[] = []
  let skipped = 0
  // With MM_ANISOTROPIC / MM_ISOTROPIC the picture is the first window rectangle (the
  // player maps it onto the target); coordinates are normalized to it, which also handles
  // negative extents (y up). Other modes use logical units directly.
  let frame: { ex: number; ey: number } | null = null
  const scaled = () => frame !== null && (dc.mapMode === 7 || dc.mapMode === 8) && dc.wex !== 0 && dc.wey !== 0

  const toDevice = (x: number, y: number): [number, number] => {
    if (frame && scaled()) return [((x - dc.wox) / dc.wex) * frame.ex, ((y - dc.woy) / dc.wey) * frame.ey]
    return [x - dc.wox, y - dc.woy]
  }
  const destBox = (x: number, y: number, cx: number, cy: number): Box => {
    const [x0, y0] = toDevice(x, y)
    const [x1, y1] = toDevice(x + cx, y + cy)
    return { x0, y0, x1, y1 }
  }
  const addObject = (value: number | null | undefined, kind: string) => {
    let i = kinds.indexOf('')
    if (i < 0) i = objects.length
    objects[i] = value
    kinds[i] = kind
  }

  while (off + 6 <= b.length) {
    const words = v.getUint32(off, true)
    const fn = v.getUint16(off + 4, true)
    if (words < 3 || off + words * 2 > b.length) break
    const p = off + 6
    const end = off + words * 2
    const i16 = (k: number) => (p + 2 * k + 2 <= end ? v.getInt16(p + 2 * k, true) : 0)
    const u16 = (k: number) => (p + 2 * k + 2 <= end ? v.getUint16(p + 2 * k, true) : 0)
    const u32 = (k: number) => (p + 2 * k + 4 <= end ? v.getUint32(p + 2 * k, true) : 0)
    const dib = (k: number) => {
      const bytes = b.subarray(p + 2 * k, end)
      const n = dibInfoSize(bytes)
      if (!n || n > bytes.length) return null
      const info = bytes.subarray(0, n)
      const src = decodeDibParts(info, bytes.subarray(n))
      return src ? { info, src } : null
    }
    const ensureFrame = () => {
      if (!frame) frame = { ex: Math.abs(dc.wex), ey: Math.abs(dc.wey) }
    }
    switch (fn) {
      case 0x0000:
        off = b.length
        continue
      case 0x0103:
        dc.mapMode = u16(0)
        break
      case 0x020b:
        dc.woy = i16(0)
        dc.wox = i16(1)
        break
      case 0x020c:
        dc.wey = i16(0)
        dc.wex = i16(1)
        break
      case 0x001e:
        stack.push(cloneDc(dc))
        break
      case 0x0127: {
        const n = i16(0)
        const keep = n < 0 ? stack.length + n : n - 1
        if (keep >= 0 && keep < stack.length) {
          dc = stack[keep]
          stack.length = keep
        }
        break
      }
      case 0x0416: {
        // INTERSECTCLIPRECT bottom, right, top, left
        ensureFrame()
        const [x0, y0] = toDevice(i16(3), i16(2))
        const [x1, y1] = toDevice(i16(1), i16(0))
        dc.clip = intersect(dc.clip, norm(x0, y0, x1, y1))
        break
      }
      case 0x02fc: // CREATEBRUSHINDIRECT
        addObject(u16(0) === 1 ? null : colorRef(u32(1)), 'brush')
        break
      case 0x0142: // DIBCREATEPATTERNBRUSH
        addObject(averageColor(dib(2)?.src ?? null), 'brush')
        break
      case 0x02fa:
      case 0x02fb:
      case 0x00f7:
      case 0x06ff:
      case 0x01f9:
        addObject(undefined, 'other')
        break
      case 0x01f0: {
        const i = u16(0)
        if (i < kinds.length) kinds[i] = ''
        break
      }
      case 0x012d: {
        const i = u16(0)
        if (kinds[i] === 'brush') dc.brush = objects[i] ?? null
        break
      }
      case 0x0940: // DIBBITBLT
      case 0x0b41: // DIBSTRETCHBLT
      case 0x0f43: // STRETCHDIB
      case 0x0d33: // SETDIBTODEV
      case 0x061d: {
        // PATBLT
        ensureFrame()
        const noBitmap = words === 3 + (fn >> 8)
        let rop = 0xcc
        let dest: Box
        let src: { info: Uint8Array; src: Thumbnail } | null = null
        let sx = 0
        let sy = 0
        let sw = 0
        let sh = 0
        if (fn === 0x061d) {
          rop = (u32(0) >> 16) & 0xff
          dest = destBox(i16(5), i16(4), i16(3), i16(2))
        } else if (fn === 0x0940) {
          rop = (u32(0) >> 16) & 0xff
          const k = noBitmap ? 5 : 4
          dest = destBox(i16(k + 3), i16(k + 2), i16(k + 1), i16(k))
          sy = i16(2)
          sx = i16(3)
          sw = i16(k + 1)
          sh = i16(k)
          if (!noBitmap) src = dib(8)
        } else if (fn === 0x0b41) {
          rop = (u32(0) >> 16) & 0xff
          sh = i16(2)
          sw = i16(3)
          sy = i16(4)
          sx = i16(5)
          const k = noBitmap ? 7 : 6
          dest = destBox(i16(k + 3), i16(k + 2), i16(k + 1), i16(k))
          if (!noBitmap) src = dib(10)
        } else if (fn === 0x0f43) {
          rop = (u32(0) >> 16) & 0xff
          sh = i16(3)
          sw = i16(4)
          sy = i16(5)
          sx = i16(6)
          dest = destBox(i16(10), i16(9), i16(8), i16(7))
          src = dib(11)
          if (src) sy = dibSourceY(src.info, sy, sh, src.src.height)
        } else {
          sh = i16(5)
          sw = i16(6)
          sy = i16(3)
          sx = i16(4)
          dest = destBox(i16(8), i16(7), sw, sh)
          src = dib(9)
          if (src) sy = dibSourceY(src.info, sy, sh, src.src.height)
        }
        if (fn !== 0x061d && !noBitmap && !src) {
          skipped++
          break
        }
        blits.push({ dest, src: src?.src ?? null, sx, sy, sw, sh, rop, brush: dc.brush, clip: dc.clip })
        break
      }
      default:
        if (WMF_DRAWING.has(fn)) skipped++
    }
    off = end
  }
  const f = frame as { ex: number; ey: number } | null
  if (f && (dc.mapMode === 7 || dc.mapMode === 8)) pic = { x0: 0, y0: 0, x1: f.ex, y1: f.ey }
  else if (!pic && blits.length) {
    pic = norm(blits[0].dest.x0, blits[0].dest.y0, blits[0].dest.x1, blits[0].dest.y1)
    for (const bl of blits) {
      const d = norm(bl.dest.x0, bl.dest.y0, bl.dest.x1, bl.dest.y1)
      pic = { x0: Math.min(pic.x0, d.x0), y0: Math.min(pic.y0, d.y0), x1: Math.max(pic.x1, d.x1), y1: Math.max(pic.y1, d.y1) }
    }
  }
  if (!pic) return null
  const bitmapOut = composite(pic, blits)
  return bitmapOut ? { bitmap: bitmapOut, skipped } : null
}
