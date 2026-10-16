// Minimal read-only reader for Microsoft Jet 4 (Access 2000-2003 .mdb) databases, enough
// for the catalogs the CAD uses for parts libraries (サブセット, 型式名称, 仕様属性, イメージテーブル).
//
// Jet 4 basics (4096-byte pages, little endian):
//   page 0      database definition ("Standard Jet DB", version byte at 0x14: 1 = Jet 4)
//   page 2      table definition (TDEF) of MSysObjects, the catalog of all tables
//   TDEF page   0x00 u8 2, 0x04 u32 next TDEF page, 0x10 u32 row count, 0x2b u16 variable
//               column count, 0x2d u16 column count, 0x33 u32 real index count,
//               0x3f real index entries (12 bytes), column entries (25 bytes),
//               column names (u16 byte length + UTF-16LE)
//   data page   0x00 u8 1, 0x04 u32 owning TDEF page, 0x0c u16 row count, 0x0e u16 row
//               offsets (0x4000 = deleted, low 13 bits = start; a row ends where the
//               previous one starts)
//   row         u16 column count, fixed columns, variable data, u16 variable offsets in
//               reverse order, u16 variable column count, null bitmap (1 = present)
//   long values (memo / OLE) are 12-byte references: u24 length, u8 kind (0x80 inline,
//               0x40 one row elsewhere, 0x00 chain of rows each starting with the next
//               row pointer), u32 page << 8 | row.

export type MdbValue = string | number | boolean | Uint8Array | Date | null

export interface MdbColumn {
  name: string
  type: number
  index: number
  varIndex: number
  fixedOffset: number
  size: number
  fixed: boolean
}

export interface MdbTable {
  name: string
  page: number
  columns: MdbColumn[]
  rowCount: number
}

export interface MdbDatabase {
  data: Uint8Array
  tables: Map<string, MdbTable>
}

export const MdbType = {
  Boolean: 0x01,
  Byte: 0x02,
  Integer: 0x03,
  Long: 0x04,
  Currency: 0x05,
  Float: 0x06,
  Double: 0x07,
  DateTime: 0x08,
  Binary: 0x09,
  Text: 0x0a,
  Ole: 0x0b,
  Memo: 0x0c,
  Guid: 0x0f,
} as const

const PAGE = 4096

export class MdbFormatError extends Error {}

export function isMdb(data: Uint8Array): boolean {
  if (data.length < PAGE * 3) return false
  const sig = 'Standard Jet DB'
  for (let i = 0; i < sig.length; i++) if (data[4 + i] !== sig.charCodeAt(i)) return false
  return true
}

export function openMdb(data: Uint8Array): MdbDatabase {
  if (!isMdb(data)) throw new MdbFormatError('Access データベース (Jet) ではありません')
  if (data[0x14] !== 1) throw new MdbFormatError(`未対応の Jet バージョンです (${data[0x14]})`)
  const db: MdbDatabase = { data, tables: new Map() }
  const sys = readTableDef(db, 'MSysObjects', 2)
  for (const row of readRows(db, sys)) {
    const type = Number(row.Type) & 0x7f
    const flags = Number(row.Flags) >>> 0
    const name = String(row.Name ?? '')
    // type 1 = local table; system tables carry flag bits 0x80000000 / 0x2
    if (type !== 1 || flags & 0x80000002 || name.startsWith('MSys')) continue
    try {
      db.tables.set(name, readTableDef(db, name, Number(row.Id) & 0xffffff))
    } catch {
      // unreadable table definitions are skipped
    }
  }
  return db
}

/** Rows of a table as objects keyed by column name (undefined table -> []). */
export function readTable(db: MdbDatabase, name: string): Record<string, MdbValue>[] {
  const t = db.tables.get(name)
  return t ? readRows(db, t) : []
}

function page(db: MdbDatabase, n: number): DataView {
  if ((n + 1) * PAGE > db.data.length || n < 0) throw new MdbFormatError(`ページ ${n} が範囲外です`)
  return new DataView(db.data.buffer, db.data.byteOffset + n * PAGE, PAGE)
}

function readTableDef(db: MdbDatabase, name: string, first: number): MdbTable {
  // concatenate the TDEF chain (continuation pages contribute everything after 8 bytes)
  const parts: Uint8Array[] = []
  const seen = new Set<number>()
  for (let p = first; p > 0 && !seen.has(p); ) {
    seen.add(p)
    const v = page(db, p)
    if (v.getUint8(0) !== 2) throw new MdbFormatError(`ページ ${p} はテーブル定義ではありません`)
    const bytes = new Uint8Array(v.buffer, v.byteOffset, PAGE)
    parts.push(parts.length ? bytes.subarray(8) : bytes)
    p = v.getUint32(4, true)
  }
  const def = concat(parts)
  const v = new DataView(def.buffer, def.byteOffset, def.byteLength)
  const rowCount = v.getUint32(16, true)
  const columnCount = v.getUint16(45, true)
  const realIndexCount = v.getInt32(51, true)
  let pos = 63 + realIndexCount * 12
  let namePos = pos + columnCount * 25
  const columns: MdbColumn[] = []
  for (let i = 0; i < columnCount; i++, pos += 25) {
    const len = v.getUint16(namePos, true)
    const colName = decodeText(def.subarray(namePos + 2, namePos + 2 + len))
    namePos += 2 + len
    const type = def[pos]
    columns.push({
      name: colName,
      type,
      index: def[pos + 5],
      varIndex: def[pos + 7],
      fixedOffset: v.getUint16(pos + 21, true),
      size: type === MdbType.Boolean ? 0 : v.getUint16(pos + 23, true),
      fixed: (def[pos + 15] & 1) !== 0,
    })
  }
  columns.sort((a, b) => a.index - b.index)
  return { name, page: first, columns, rowCount }
}

function readRows(db: MdbDatabase, t: MdbTable): Record<string, MdbValue>[] {
  const out: Record<string, MdbValue>[] = []
  const pages = db.data.length / PAGE
  const maskBytes = (n: number) => (n + 7) >> 3
  for (let p = 1; p < pages; p++) {
    const v = page(db, p)
    if (v.getUint8(0) !== 1 || v.getUint32(4, true) !== t.page) continue
    const n = v.getUint16(12, true)
    for (let r = 0; r < n; r++) {
      const raw = v.getUint16(14 + r * 2, true)
      if (raw & 0x4000) continue
      const start = raw & 0x1fff
      const next = r === 0 ? PAGE : v.getUint16(14 + (r - 1) * 2, true) & 0x1fff
      const end = next - 1 // inclusive
      if (end <= start) continue
      const cols = v.getUint16(start, true)
      const mb = maskBytes(cols)
      const varCount = v.getUint16(end - mb - 1, true)
      const varOffsets: number[] = []
      for (let i = 0; i <= varCount; i++) varOffsets.push(v.getUint16(end - mb - 3 - i * 2, true))
      const maskAt = end - mb + 1
      const present = (i: number) => i < cols && (v.getUint8(maskAt + (i >> 3)) & (1 << (i & 7))) !== 0
      const row: Record<string, MdbValue> = {}
      for (const c of t.columns) {
        if (c.type === MdbType.Boolean) {
          row[c.name] = present(c.index)
          continue
        }
        if (!present(c.index)) {
          row[c.name] = null
          continue
        }
        let s: number
        let len: number
        if (c.fixed) {
          s = start + 2 + c.fixedOffset
          len = c.size
        } else if (c.varIndex < varCount) {
          s = start + varOffsets[c.varIndex]
          len = varOffsets[c.varIndex + 1] - varOffsets[c.varIndex]
        } else {
          row[c.name] = null
          continue
        }
        const bytes = new Uint8Array(v.buffer, v.byteOffset + s, Math.max(0, len))
        row[c.name] = readValue(db, c, bytes)
      }
      out.push(row)
    }
  }
  return out
}

function readValue(db: MdbDatabase, c: MdbColumn, b: Uint8Array): MdbValue {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  switch (c.type) {
    case MdbType.Byte:
      return b[0]
    case MdbType.Integer:
      return v.getInt16(0, true)
    case MdbType.Long:
      return v.getInt32(0, true)
    case MdbType.Currency:
      return Number(v.getBigInt64(0, true)) / 10000
    case MdbType.Float:
      return v.getFloat32(0, true)
    case MdbType.Double:
      return v.getFloat64(0, true)
    case MdbType.DateTime:
      return new Date(Date.UTC(1899, 11, 30) + v.getFloat64(0, true) * 86400000)
    case MdbType.Text:
      return decodeText(b)
    case MdbType.Memo: {
      const lv = longValue(db, b)
      return lv ? decodeText(lv) : null
    }
    case MdbType.Ole:
      return longValue(db, b)
    default:
      return b.slice()
  }
}

/** Find a row by its page/row pointer. */
function pageRow(db: MdbDatabase, ptr: number): Uint8Array | null {
  const p = ptr >>> 8
  const r = ptr & 0xff
  const v = page(db, p)
  if (r >= v.getUint16(12, true)) return null
  const start = v.getUint16(14 + r * 2, true) & 0x1fff
  const end = r === 0 ? PAGE : v.getUint16(14 + (r - 1) * 2, true) & 0x1fff
  return new Uint8Array(v.buffer, v.byteOffset + start, Math.max(0, end - start))
}

function longValue(db: MdbDatabase, ref: Uint8Array): Uint8Array | null {
  if (ref.length < 12) return null
  const v = new DataView(ref.buffer, ref.byteOffset, ref.byteLength)
  const length = v.getUint32(0, true) & 0xffffff
  const kind = ref[3]
  if (kind === 0x80) return ref.slice(12, 12 + length)
  if (kind === 0x40) return pageRow(db, v.getUint32(4, true))?.slice(0, length) ?? null
  const out = new Uint8Array(length)
  let at = 0
  let ptr = v.getUint32(4, true)
  const seen = new Set<number>()
  while (ptr && at < length && !seen.has(ptr)) {
    seen.add(ptr)
    const row = pageRow(db, ptr)
    if (!row || row.length <= 4) break
    ptr = new DataView(row.buffer, row.byteOffset, 4).getUint32(0, true)
    const chunk = row.subarray(4, 4 + Math.min(row.length - 4, length - at))
    out.set(chunk, at)
    at += chunk.length
  }
  return out.subarray(0, at)
}

const utf16 = new TextDecoder('utf-16le')

/** Jet 4 text: UTF-16LE, or "FF FE" + compressed runs (single bytes, 0x00 toggles mode). */
function decodeText(b: Uint8Array): string {
  if (b.length < 2 || b[0] !== 0xff || b[1] !== 0xfe) return utf16.decode(b)
  const out: number[] = []
  let compressed = true
  for (let i = 2; i < b.length; ) {
    if (b[i] === 0) {
      compressed = !compressed
      i++
    } else if (compressed) {
      out.push(b[i++])
    } else if (i + 1 < b.length) {
      out.push(b[i] | (b[i + 1] << 8))
      i += 2
    } else break
  }
  let s = ''
  for (let i = 0; i < out.length; i += 0x4000) s += String.fromCharCode(...out.slice(i, i + 0x4000))
  return s
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
