// Windows DIB decoding (BITMAPINFOHEADER + palette + pixels). Used for the preview in
// section 5, for raster images embedded in drawings and for bitmaps inside metafiles.

import { dataView, records } from './container.ts'
import type { Thumbnail } from './model.ts'

/** Size of the BITMAPINFO part (header, masks, palette) of a DIB, or 0 if invalid. */
export function dibInfoSize(b: Uint8Array): number {
  if (b.length < 12) return 0
  const v = dataView(b)
  const hs = v.getUint32(0, true)
  if (hs === 12) {
    const bpp = v.getUint16(10, true)
    return 12 + (bpp <= 8 ? (1 << bpp) * 3 : 0)
  }
  if (hs < 40 || b.length < 40) return 0
  const bpp = v.getUint16(14, true)
  const compression = v.getUint32(16, true)
  const used = v.getUint32(32, true)
  const colors = bpp <= 8 ? used || 1 << bpp : used
  const masks = hs === 40 && (compression === 3 || compression === 6) ? (compression === 6 ? 16 : 12) : 0
  return hs + masks + colors * 4
}

/** Decodes a packed DIB (BITMAPINFO immediately followed by the pixels). */
export function decodeDib(b: Uint8Array, keepAlpha = false): Thumbnail | null {
  const n = dibInfoSize(b)
  if (!n || n > b.length) return null
  return decodeDibParts(b.subarray(0, n), b.subarray(n), keepAlpha)
}

/**
 * Decodes a DIB whose BITMAPINFO and pixel bits are stored separately (as in metafile
 * records). Supports 1/4/8 bpp palettes, 16/24/32 bpp, BI_BITFIELDS and RLE4/RLE8.
 * Rows are returned top-down. Alpha is opaque unless `keepAlpha` (32 bpp sources).
 */
export function decodeDibParts(info: Uint8Array, bits: Uint8Array, keepAlpha = false): Thumbnail | null {
  if (info.length < 12) return null
  const v = dataView(info)
  const hs = v.getUint32(0, true)
  let w: number
  let hRaw: number
  let bpp: number
  let compression = 0
  let palOff: number
  let palEntry = 4
  let colors: number
  if (hs === 12) {
    w = v.getUint16(4, true)
    hRaw = v.getInt16(6, true)
    bpp = v.getUint16(10, true)
    palOff = 12
    palEntry = 3
    colors = bpp <= 8 ? 1 << bpp : 0
  } else {
    if (hs < 40 || info.length < 40) return null
    w = v.getInt32(4, true)
    hRaw = v.getInt32(8, true)
    bpp = v.getUint16(14, true)
    compression = v.getUint32(16, true)
    const used = v.getUint32(32, true)
    colors = bpp <= 8 ? used || 1 << bpp : 0
    palOff = hs + (hs === 40 && (compression === 3 || compression === 6) ? (compression === 6 ? 16 : 12) : 0)
  }
  const h = Math.abs(hRaw)
  // at most 32 Mpixels (128 MB of RGBA) per image
  if (w <= 0 || h <= 0 || w > 16384 || h > 16384 || w * h > 32_000_000) return null
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) return null
  if (compression !== 0 && compression !== 3 && compression !== 6 && !(compression === 1 && bpp === 8) && !(compression === 2 && bpp === 4)) return null
  const bottomUp = hRaw > 0

  if (bpp <= 8) colors = Math.min(colors, 1 << bpp)
  else colors = 0
  const palette = new Uint32Array(bpp <= 8 ? 1 << bpp : 0)
  for (let i = 0; i < colors && palOff + i * palEntry + 3 <= info.length; i++) {
    const p = palOff + i * palEntry
    palette[i] = (info[p + 2] << 16) | (info[p + 1] << 8) | info[p]
  }

  const rgba = new Uint8ClampedArray(w * h * 4)
  const put = (x: number, row: number, rgb: number, a = 255) => {
    const y = bottomUp ? h - 1 - row : row
    const o = (y * w + x) * 4
    rgba[o] = (rgb >> 16) & 255
    rgba[o + 1] = (rgb >> 8) & 255
    rgba[o + 2] = rgb & 255
    rgba[o + 3] = a
  }

  if (compression === 1 || compression === 2) {
    decodeRle(bits, w, h, compression === 1 ? 8 : 4, (x, row, idx) => put(x, row, palette[idx] ?? 0))
    return { width: w, height: h, rgba }
  }

  // channel masks for 16/32 bpp
  let masks: number[] = bpp === 16 ? [0x7c00, 0x3e0, 0x1f, 0] : [0xff0000, 0xff00, 0xff, 0xff000000]
  if (compression === 3 || compression === 6) {
    // masks follow a 40-byte header, or sit at the same offset inside V4/V5 headers
    if (info.length >= 52) masks = [v.getUint32(40, true), v.getUint32(44, true), v.getUint32(48, true), compression === 6 && info.length >= 56 ? v.getUint32(52, true) : bpp === 32 ? 0xff000000 : 0]
  }
  const field = masks.map((m) => {
    if (!m) return null
    let shift = 0
    while (!((m >>> shift) & 1)) shift++
    const max = m >>> shift
    return { m, shift, max }
  })
  const chan = (px: number, k: number) => {
    const f = field[k]
    if (!f) return k === 3 ? 255 : 0
    return Math.round((((px & f.m) >>> f.shift) * 255) / f.max)
  }

  const stride = Math.floor((w * bpp + 31) / 32) * 4
  const rows = Math.min(h, Math.floor(bits.length / stride))
  const bv = dataView(bits)
  for (let row = 0; row < rows; row++) {
    const r0 = row * stride
    for (let x = 0; x < w; x++) {
      if (bpp >= 24) {
        const o = r0 + x * (bpp / 8)
        if (bpp === 32 && (compression === 3 || compression === 6)) {
          const px = bv.getUint32(o, true)
          put(x, row, (chan(px, 0) << 16) | (chan(px, 1) << 8) | chan(px, 2), keepAlpha ? chan(px, 3) : 255)
        } else put(x, row, (bits[o + 2] << 16) | (bits[o + 1] << 8) | bits[o], keepAlpha && bpp === 32 ? bits[o + 3] : 255)
      } else if (bpp === 16) {
        const px = bv.getUint16(r0 + 2 * x, true)
        put(x, row, (chan(px, 0) << 16) | (chan(px, 1) << 8) | chan(px, 2))
      } else {
        let idx: number
        if (bpp === 8) idx = bits[r0 + x]
        else if (bpp === 4) idx = x % 2 === 0 ? bits[r0 + (x >> 1)] >> 4 : bits[r0 + (x >> 1)] & 15
        else idx = (bits[r0 + (x >> 3)] >> (7 - (x & 7))) & 1
        put(x, row, palette[idx] ?? 0)
      }
    }
  }
  return { width: w, height: h, rgba }
}

/** RLE8 / RLE4 decoding; rows are counted from the start of the bitmap data. */
function decodeRle(b: Uint8Array, w: number, h: number, bpp: 8 | 4, set: (x: number, row: number, idx: number) => void) {
  let x = 0
  let row = 0
  let i = 0
  while (i + 1 < b.length && row < h) {
    const n = b[i++]
    const c = b[i++]
    if (n > 0) {
      for (let k = 0; k < n; k++) {
        if (x < w) set(x, row, bpp === 8 ? c : k % 2 === 0 ? c >> 4 : c & 15)
        x++
      }
    } else if (c === 0) {
      x = 0
      row++
    } else if (c === 1) break
    else if (c === 2) {
      x += b[i++] ?? 0
      row += b[i++] ?? 0
    } else {
      for (let k = 0; k < c; k++) {
        const byte = bpp === 8 ? b[i + k] : b[i + (k >> 1)]
        if (x < w) set(x, row, bpp === 8 ? byte : k % 2 === 0 ? byte >> 4 : byte & 15)
        x++
      }
      const used = bpp === 8 ? c : (c + 1) >> 1
      i += used + (used & 1)
    }
  }
}

export function readThumbnail(sec5: Uint8Array | null): Thumbnail | null {
  if (!sec5) return null
  for (const r of records(sec5, 8)) if (r.type === 9) return decodeDib(r.body)
  return null
}
