// Embedded OLE objects (entity kind 0x160). Record 0x0007 holds a 24-byte header
// followed by the object's compound file. What is drawn is the object's cached
// presentation, looked up in this order:
//   CONTENTS     static pictures ("Picture (Enhanced Metafile)" etc.): EMF / WMF / BMP
//   OlePresNNN   presentation cache: CF_DIB, CF_METAFILEPICT (WMF), CF_ENHMETAFILE (EMF)
//   Ole10Native  OLE 1 native data; packages (embedded files) only give a file name,
//                unless the file is an image

import { dataView, decodeSjis } from './container.ts'
import { findCompoundFile, readCompoundFile, type CfbStream } from './cfb.ts'
import { isEmf, isWmf, renderEmf, renderWmf, type MetafileImage } from './metafile.ts'
import type { Thumbnail } from './model.ts'
import { decodeDib } from './thumbnail.ts'

export interface OlePresentation {
  /** object type ("Picture (Enhanced Metafile)", embedded file name, ...) */
  label: string
  bitmap: Thumbnail | null
  encoded: { mime: string; data: Uint8Array } | null
  /** drawing records of the presentation that could not be rendered */
  skipped: number
}

const CF_BITMAP = 2
const CF_METAFILEPICT = 3
const CF_DIB = 8
const CF_ENHMETAFILE = 14

export function readOleObject(rec: Uint8Array): OlePresentation {
  const result: OlePresentation = { label: '', bitmap: null, encoded: null, skipped: 0 }
  const at = findCompoundFile(rec, 256)
  if (at < 0) return result
  const streams = readCompoundFile(rec.subarray(at))
  const find = (re: RegExp) => streams.filter((s) => re.test(s.name))

  for (const s of find(/CompObj$/)) result.label ||= compObjUserType(s.data)
  const native = find(/Ole10Native$/)[0]
  const pkg = native ? readPackage(native.data) : null
  if (pkg?.label) result.label = pkg.label

  const take = (img: MetafileImage | Thumbnail | null): boolean => {
    if (!img) return false
    if ('rgba' in img) result.bitmap = img
    else {
      result.bitmap = img.bitmap
      result.skipped = img.skipped
    }
    return true
  }

  for (const s of find(/^CONTENTS$/i)) if (take(fromContents(s.data, result))) return result
  if (result.encoded) return result
  const pres = find(/OlePres\d{3}$/).sort((a, b) => a.name.localeCompare(b.name))
  for (const s of pres) if (take(fromPresentation(s))) return result
  const data = pkg ? pkg.data : native?.data.subarray(4)
  if (data && take(fromImageFile(data, result))) return result
  return result
}

/** Static picture objects keep the picture itself in CONTENTS (after a short prefix). */
function fromContents(b: Uint8Array, out: OlePresentation): MetafileImage | Thumbnail | null {
  for (let i = 0; i <= 16 && i + 88 <= b.length; i += 4) {
    if (isEmf(b.subarray(i))) return renderEmf(b.subarray(i))
  }
  if (isWmf(b)) return renderWmf(b)
  return fromImageFile(b, out)
}

/** BMP / PNG / JPEG files (package contents, Paintbrush objects). */
function fromImageFile(b: Uint8Array, out: OlePresentation): Thumbnail | null {
  if (b.length > 54 && b[0] === 0x42 && b[1] === 0x4d) return decodeDib(b.subarray(14))
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) out.encoded = { mime: 'image/png', data: b.slice() }
  else if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) out.encoded = { mime: 'image/jpeg', data: b.slice() }
  return null
}

/** OLEPresentationStream: clipboard format, target device, aspect, size, data. */
function fromPresentation(s: CfbStream): MetafileImage | Thumbnail | null {
  const b = s.data
  if (b.length < 40) return null
  const v = dataView(b)
  let o = 0
  const marker = v.getUint32(0, true)
  let format = 0
  if (marker === 0xffffffff || marker === 0xfffffffe) {
    format = v.getUint32(4, true)
    o = 8
  } else if (marker === 0) return null
  else o = 4 + marker // registered format name: not a picture we can draw
  const td = v.getUint32(o, true)
  o += 4 + (td >= 4 ? td - 4 : 0)
  o += 4 * 4 // aspect, lindex, advf, reserved
  if (o + 12 > b.length) return null
  const size = v.getUint32(o + 8, true)
  const data = b.subarray(o + 12, Math.min(b.length, o + 12 + size))
  if (format === CF_DIB) return decodeDib(data)
  if (format === CF_METAFILEPICT) return renderWmf(data)
  if (format === CF_ENHMETAFILE) return renderEmf(data)
  if (format === CF_BITMAP) return null
  return isEmf(data) ? renderEmf(data) : isWmf(data) ? renderWmf(data) : null
}

/** CompObj stream: 28-byte header, then the length-prefixed ANSI user type. */
function compObjUserType(b: Uint8Array): string {
  if (b.length < 32) return ''
  const n = dataView(b).getUint32(28, true)
  if (n === 0 || n > 256 || 32 + n > b.length) return ''
  return decodeAnsi(b.subarray(32, 32 + n))
}

const utf8 = new TextDecoder('utf-8')

/**
 * ANSI strings are CP932, but packages created on UTF-8 systems store UTF-8, sometimes
 * damaged by a CP932 round trip (lost bytes become "\x81\x45"). Pick whichever reads better.
 */
function decodeAnsi(b: Uint8Array): string {
  const z = b.indexOf(0)
  if (z >= 0) b = b.subarray(0, z)
  const sjis = decodeSjis(b)
  if (!b.some((c) => c >= 0x80)) return sjis
  // decode UTF-8 piecewise, cutting at damaged spots (0x81 0x45 after a non-ASCII byte)
  let u = ''
  let from = 0
  for (let i = 1; i + 1 < b.length; i++) {
    if (b[i] === 0x81 && b[i + 1] === 0x45 && b[i - 1] >= 0x80) {
      u += utf8.decode(b.subarray(from, i)) + '\uFFFD'
      from = i + 2
      i++
    }
  }
  u = (u + utf8.decode(b.subarray(from))).replace(/\uFFFD+/g, '\uFFFD')
  const bad = (u.match(/\uFFFD/g) ?? []).length
  const cjk = (u.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) ?? []).length
  return cjk > bad * 2 ? u.replace(/\uFFFD+/g, '?') : sjis
}

/** OLE 1 Package: u32 size, u16 2, label, source path, u16, u32 + temp path, u32 + data. */
function readPackage(b: Uint8Array): { label: string; data: Uint8Array } | null {
  if (b.length < 12) return null
  const v = dataView(b)
  if (v.getUint16(4, true) !== 2) return null
  let o = 6
  const str = () => {
    const z = b.indexOf(0, o)
    if (z < 0) throw new Error('package')
    const s = decodeAnsi(b.subarray(o, z))
    o = z + 1
    return s
  }
  try {
    const label = str()
    str() // original path
    o += 4 // reserved u16 + u16
    const tl = v.getUint32(o, true)
    o += 4 + tl
    const size = v.getUint32(o, true)
    o += 4
    return { label, data: b.subarray(o, Math.min(b.length, o + size)) }
  } catch {
    return null
  }
}
