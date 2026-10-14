// Low-level container layer of the Tfas (.tfs) format.
//
// File layout (all little endian):
//   0x00  "TFAS" magic
//   0x08  u8 major, u8 flags (0x80 = 64-bit section table), u8, u8 minor
//   0x40  20-byte digest
//   0x58  section table: 30 entries of (start, end) as i32 pairs (narrow, ends at 0x148)
//         or i64 pairs (wide, ends at 0x458). -1 marks an unused section.
//
// Each section is a sequence of records: u32 size (incl. 8-byte header), u16 type,
// u16 section id, body. Top-level records are padded to 8 bytes; records nested inside
// decompressed blocks are packed without padding. Types with bit 0x2000/0x4000 set
// whose body starts with 0x78 are zlib streams containing further records.

import { unzlibSync } from 'fflate'

export interface Section {
  index: number
  start: number
  end: number
}

export interface Container {
  data: Uint8Array
  view: DataView
  /** true for the newer layout with a 64-bit section table and 64-bit entity ids */
  wide: boolean
  version: string
  sections: (Section | null)[]
}

export interface RawRecord {
  type: number
  body: Uint8Array
}

export class TfasFormatError extends Error {}

export function dataView(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength)
}

export function openContainer(data: Uint8Array): Container {
  if (data.length < 0x148 || data[0] !== 0x54 || data[1] !== 0x46 || data[2] !== 0x41 || data[3] !== 0x53) {
    throw new TfasFormatError('TFAS ファイルではありません (マジック不一致)')
  }
  const view = dataView(data)
  const wide = (data[9] & 0x80) !== 0
  const sections: (Section | null)[] = []
  if (wide) {
    for (let i = 0, o = 0x58; o + 16 <= 0x458 && o + 16 <= data.length; i++, o += 16) {
      const start = Number(view.getBigInt64(o, true))
      const end = Number(view.getBigInt64(o + 8, true))
      sections.push(validSection(i, start, end, data.length))
    }
  } else {
    for (let i = 0, o = 0x58; o + 8 <= 0x148; i++, o += 8) {
      const start = view.getInt32(o, true)
      const end = view.getInt32(o + 4, true)
      sections.push(validSection(i, start, end, data.length))
    }
  }
  const version = `${data[8]}.${data[11]}${wide ? ' (64bit)' : ''}`
  return { data, view, wide, version, sections }
}

function validSection(index: number, start: number, end: number, len: number): Section | null {
  if (start < 0 || end < start || end > len) return null
  return { index, start, end }
}

export function sectionBytes(c: Container, index: number): Uint8Array | null {
  const s = c.sections[index]
  return s ? c.data.subarray(s.start, s.end) : null
}

/** Iterate records in a buffer. `align` is 8 for top-level section data, 1 inside blocks. */
export function* records(buf: Uint8Array, align: 1 | 8): Generator<RawRecord> {
  const v = dataView(buf)
  let p = 0
  while (p + 8 <= buf.length) {
    const size = v.getUint32(p, true)
    const type = v.getUint16(p + 4, true)
    if (size < 8 || p + size > buf.length) return
    yield { type, body: buf.subarray(p + 8, p + size) }
    p += align === 1 ? size : (size + align - 1) & ~(align - 1)
  }
}

export function isCompressedRecord(r: RawRecord): boolean {
  return (r.type & 0x6000) !== 0 && r.body.length > 2 && r.body[0] === 0x78
}

export function inflate(body: Uint8Array): Uint8Array {
  return unzlibSync(body)
}

const sjis = new TextDecoder('shift_jis')

/** Decode CP932 (Shift_JIS) bytes, stopping at the first NUL. */
export function decodeSjis(b: Uint8Array): string {
  const z = b.indexOf(0)
  return sjis.decode(z >= 0 ? b.subarray(0, z) : b)
}
