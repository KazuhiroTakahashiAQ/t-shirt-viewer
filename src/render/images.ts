// Helpers for embedded raster images.

import { zlibSync } from 'fflate'
import type { ImageItem, Thumbnail } from '../tfas/model.ts'

/** Affine matrix mapping image pixels (u right, v down) onto the item's corners. */
export function imageMatrix(img: ImageItem, w: number, h: number, map: (x: number, y: number) => [number, number]) {
  const c = img.corners
  const [blx, bly] = map(c[0], c[1])
  const [trx, try_] = map(c[4], c[5])
  const [tlx, tly] = map(c[6], c[7])
  return { a: (trx - tlx) / w, b: (try_ - tly) / w, c: (blx - tlx) / h, d: (bly - tly) / h, e: tlx, f: tly }
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Minimal PNG encoder for decoded pixels (RGB, or RGBA when any pixel is transparent). */
export function pngBytes(t: Thumbnail): Uint8Array {
  let alpha = false
  for (let i = 3; i < t.rgba.length && !alpha; i += 4) alpha = t.rgba[i] !== 255
  const ch = alpha ? 4 : 3
  const raw = new Uint8Array((t.width * ch + 1) * t.height)
  for (let y = 0, o = 0; y < t.height; y++) {
    raw[o++] = 0
    for (let x = 0; x < t.width; x++) {
      const i = (y * t.width + x) * 4
      raw[o++] = t.rgba[i]
      raw[o++] = t.rgba[i + 1]
      raw[o++] = t.rgba[i + 2]
      if (alpha) raw[o++] = t.rgba[i + 3]
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const c = new Uint8Array(12 + data.length)
    const v = new DataView(c.buffer)
    v.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i)
    c.set(data, 8)
    v.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)))
    return c
  }
  const ihdr = new Uint8Array(13)
  const hv = new DataView(ihdr.buffer)
  hv.setUint32(0, t.width)
  hv.setUint32(4, t.height)
  ihdr.set([8, alpha ? 6 : 2, 0, 0, 0], 8)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function imageDataUri(img: ImageItem): { href: string; width: number; height: number } | null {
  if (img.bitmap) return { href: `data:image/png;base64,${base64(pngBytes(img.bitmap))}`, width: img.bitmap.width, height: img.bitmap.height }
  if (img.encoded) {
    const size = encodedSize(img.encoded.data)
    if (size) return { href: `data:${img.encoded.mime};base64,${base64(img.encoded.data)}`, width: size[0], height: size[1] }
  }
  return null
}

/** Pixel size of a JPEG or PNG stream. */
export function encodedSize(d: Uint8Array): [number, number] | null {
  if (d[0] === 0x89) return [(d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19], (d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23]]
  let p = 2
  while (p + 9 < d.length) {
    if (d[p] !== 0xff) return null
    const m = d[p + 1]
    const len = (d[p + 2] << 8) | d[p + 3]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(d[p + 7] << 8) | d[p + 8], (d[p + 5] << 8) | d[p + 6]]
    p += 2 + len
  }
  return null
}
