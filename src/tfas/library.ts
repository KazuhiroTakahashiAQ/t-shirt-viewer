// Tfas parts libraries ("サブセットライブラリ" folders imported with
// サブセットライブラリのインポート処理). Two kinds are known:
//
//   NCP library (a maker's parts, folder like <maker>_buhin_All): xxxNNNNN.NCP drawings + .MDB catalog
//       (+ .USR user attributes for electrical parts)
//   custom desk (カスタムデスク, folder like <company>_buhin_CustomDesk): .MDB catalog + .USR
//       only. Parts refer to a stock part of Tfas itself (ストックキーコード) whose
//       shape Tfas generates, so the files hold no geometry; the only
//       drawing is the small EMF icon in イメージテーブル.
//
// MDB tables:
//   ｻﾌﾞｾｯﾄ        category tree and part list. レコード区分 0 = library title, 1/2/3 =
//                 大/中/小 分類 (分類コード１..３), 4 = part (部品コード(機能), 呼出しコード
//                 = 型番, 名称, 表示用ＳＱ №, ストックキーコード(デスク用))
//   型式名称       部品コード -> ロング部品名称
//   仕様属性       部品コード, 項目GID/項目ID, 拡張GID/ID 1..6, 単位GID/ID, 値 (equipment specs)
//   イメージテーブル 部品コード (any view code) -> EMF preview
//   Attr          electrical attributes (code4 = part code, hikidashi 配線引出区分,
//                 torituke 取付区分, hiroi 材料拾い区分, volt_ampere 負荷容量, ...)

import { GeomBuilder } from './geometry.ts'
import { isEmptyRect, Prim, PrimFlag, type Rect, type Style } from './model.ts'
import { isMdb, openMdb, readTable, type MdbDatabase, type MdbValue } from './mdb.ts'
import { hasNcpModel, isNcp, openNcp, readNcpEntry, readNcpModel, VIEW_NAMES, type NcpEntry, type NcpLibrary, type PartDrawing, type PartModel } from './ncp.ts'

export interface LibraryFile {
  name: string
  data: Uint8Array
}

export interface LibrarySpec {
  /** raw key: 項目GID-ID / 拡張 pairs, or the Attr column name */
  key: string
  label: string
  value: string
  unit: string
  /** label / unit inferred from the values (not stored in the file) */
  guessed: boolean
}

export interface LibraryView {
  /** view digit: 0 平面, 1 正面, 2 背面, 3 右側面, 4 左側面 */
  view: number
  label: string
  entry: NcpEntry | null
  /** EMF preview from イメージテーブル */
  image: Uint8Array | null
}

export interface LibraryPart {
  /** 部品コード (view 0), e.g. A06D1$2XXXXXXXX */
  code: string
  /** 呼出しコード (model number for manufacturer libraries) */
  callCode: string
  name: string
  longName: string
  seq: number
  /** category names from the library title down */
  path: string[]
  /** stock part of Tfas that generates the shape (custom desk libraries) */
  stockKey: string | null
  views: LibraryView[]
  specs: LibrarySpec[]
  /** the plan view carries a 3D model */
  hasModel: boolean
}

export interface LibraryCategory {
  key: string
  level: number
  name: string
  children: LibraryCategory[]
  parts: LibraryPart[]
}

export interface PartsLibrary {
  kind: 'ncp' | 'custom-desk'
  title: string
  root: LibraryCategory
  parts: LibraryPart[]
  ncp: NcpLibrary | null
  files: string[]
  warnings: string[]
}

/** Files that belong to a parts library folder. */
export function isLibraryFile(name: string, data: Uint8Array): boolean {
  return /\.(ncp|mdb|usr)$/i.test(name) && (isNcp(data) || isMdb(data))
}

export function openPartsLibrary(files: LibraryFile[]): PartsLibrary {
  const warnings: string[] = []
  let ncp: NcpLibrary | null = null
  let catalog: MdbDatabase | null = null
  const attrDbs: MdbDatabase[] = []
  for (const f of files) {
    if (isNcp(f.data)) {
      if (ncp) warnings.push(`NCP が複数あります。${f.name} は無視しました`)
      else ncp = openNcp(f.data)
    } else if (isMdb(f.data)) {
      const db = openMdb(f.data)
      if (db.tables.has('ｻﾌﾞｾｯﾄ') && !catalog) catalog = db
      if (db.tables.has('Attr')) attrDbs.push(db)
    }
  }
  if (!ncp && !catalog) throw new Error('部品ライブラリ (.NCP / .MDB) が見つかりません')

  const images = new Map<string, Uint8Array>()
  const longNames = new Map<string, string>()
  const specs = new Map<string, LibrarySpec[]>()
  const addSpec = (code: string, s: LibrarySpec) => {
    let list = specs.get(code)
    if (!list) specs.set(code, (list = []))
    if (!list.some((x) => x.key === s.key)) list.push(s)
  }
  if (catalog) {
    for (const r of readTable(catalog, 'イメージテーブル')) {
      const img = r['イメージ']
      if (r['イメージフラグ'] !== false && img instanceof Uint8Array && img.length > 8) images.set(str(r['部品コード']), img)
    }
    for (const r of readTable(catalog, '型式名称')) longNames.set(str(r['部品コード']), str(r['ロング部品名称']))
    for (const r of readTable(catalog, '仕様属性')) addSpec(str(r['部品コード']), specFromRow(r))
  }
  for (const db of attrDbs) for (const r of readTable(db, 'Attr')) for (const s of attrSpecs(r)) addSpec(str(r.code4), s)

  // category tree
  const root: LibraryCategory = { key: '', level: 0, name: '部品ライブラリ', children: [], parts: [] }
  const nodes = new Map<string, LibraryCategory>([['', root]])
  const parts: LibraryPart[] = []
  const known = new Set<string>()
  const node = (key: string, level: number): LibraryCategory => {
    let n = nodes.get(key)
    if (!n) {
      const parentKey = key.split('/').slice(0, -1).join('/')
      const parent = level > 1 ? node(parentKey, level - 1) : root
      n = { key, level, name: key.split('/').pop() ?? key, children: [], parts: [] }
      nodes.set(key, n)
      parent.children.push(n)
    }
    return n
  }
  if (catalog) {
    const rows = readTable(catalog, 'ｻﾌﾞｾｯﾄ')
    for (const r of rows) {
      const level = Number(r['レコード区分'])
      const c = [str(r['分類コード１(大)']), str(r['分類コード２(中)']), str(r['分類コード３(小)'])]
      if (level === 0) root.name = str(r['分類名称']) || root.name
      else if (level >= 1 && level <= 3) node(c.slice(0, level).join('/'), level).name = str(r['分類名称']) || c[level - 1]
    }
    for (const r of rows) {
      if (Number(r['レコード区分']) !== 4) continue
      const c = [str(r['分類コード１(大)']), str(r['分類コード２(中)']), str(r['分類コード３(小)'])]
      // deepest defined category
      let parent = root
      for (let l = 3; l >= 1; l--) {
        const n = nodes.get(c.slice(0, l).join('/'))
        if (n) {
          parent = n
          break
        }
      }
      const code = str(r['部品コード(機能)']) || str(r['部品コード(表示用)'])
      if (!code || known.has(code)) continue
      known.add(code)
      const stockKey = str(r['ストックキーコード(デスク用)']) || null
      const name = str(r['名称'])
      const part: LibraryPart = {
        code,
        callCode: str(r['呼出しコード']),
        name,
        longName: longNames.get(code) || name,
        seq: Number(r['表示用ＳＱ №']) || 0,
        path: [],
        stockKey,
        views: [],
        specs: specs.get(code) ?? [],
        hasModel: false,
      }
      if (stockKey) part.specs.unshift({ key: 'stock', label: 'ストックキー', value: stockKey, unit: '', guessed: false })
      parent.parts.push(part)
      parts.push(part)
    }
  }
  if (ncp) {
    // parts that exist only in the NCP (no catalog, or catalog without them)
    let orphans = 0
    for (const [code, entries] of ncp.parts) {
      if (known.has(code)) continue
      orphans++
      const e = entries[0]
      const n = node(`${code[0]}/${code.slice(2, 5)}`, 1)
      const part: LibraryPart = { code, callCode: code.slice(code.indexOf('$') + 3) || code, name: e.name, longName: e.name, seq: n.parts.length + 1, path: [], stockKey: null, views: [], specs: [], hasModel: false }
      n.parts.push(part)
      parts.push(part)
    }
    if (catalog && orphans) warnings.push(`${orphans} 個の部品は MDB に分類がありません`)
    if (!catalog) warnings.push('MDB がないため分類名・仕様は表示できません')
  }

  // views
  let noGeometry = 0
  for (const p of parts) {
    const entries = ncp?.parts.get(p.code) ?? []
    const views = new Map<number, LibraryView>()
    for (const e of entries) views.set(e.view, { view: e.view, label: viewName(e.view), entry: e, image: images.get(e.code) ?? null })
    for (let v = 0; v <= 9; v++) {
      if (views.has(v)) continue
      const img = images.get(v === 0 ? p.code : `${p.code[0]}${v}${p.code.slice(2)}`)
      if (img) views.set(v, { view: v, label: viewName(v), entry: null, image: img })
    }
    p.views = [...views.values()].sort((a, b) => a.view - b.view)
    const plan = entries.find((e) => e.view === 0)
    p.hasModel = !!plan && !!ncp && hasNcpModel(ncp, plan)
    if (!entries.length) noGeometry++
  }
  if (ncp && noGeometry) warnings.push(`${noGeometry} 個の部品は NCP に図形がありません`)
  if (!ncp && parts.some((p) => p.stockKey)) {
    warnings.push('カスタムデスクのライブラリです。部品の形状は Tfas 本体のストック部品から生成されるためファイルに含まれず、登録されたイメージのみ表示します。')
  }

  // sort and fill paths
  const sortTree = (n: LibraryCategory, path: string[]) => {
    n.children.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    n.parts.sort((a, b) => a.seq - b.seq)
    for (const p of n.parts) p.path = path
    for (const c of n.children) sortTree(c, [...path, c.name])
  }
  sortTree(root, [root.name])
  prune(root)

  return {
    kind: ncp ? 'ncp' : 'custom-desk',
    title: root.name,
    root,
    parts,
    ncp,
    files: files.map((f) => f.name),
    warnings,
  }
}

/** Geometry of one view: the NCP drawing, or the vectorized EMF preview image. */
export function readLibraryView(lib: PartsLibrary, part: LibraryPart, view: LibraryView): PartDrawing | null {
  if (view.entry && lib.ncp) return readNcpEntry(lib.ncp, view.entry)
  if (view.image) return emfDrawing(view.image, view.view === 0 ? part.code : `${part.code[0]}${view.view}${part.code.slice(2)}`, part.name)
  return null
}

export function readLibraryModel(lib: PartsLibrary, part: LibraryPart): PartModel | null {
  const plan = part.views.find((v) => v.view === 0)?.entry
  return plan && lib.ncp ? readNcpModel(lib.ncp, plan) : null
}

export function viewName(v: number): string {
  return VIEW_NAMES[v] ?? `ビュー${v}`
}

function prune(n: LibraryCategory): boolean {
  n.children = n.children.filter(prune)
  return n.parts.length > 0 || n.children.length > 0
}

function str(v: MdbValue | undefined): string {
  return v === null || v === undefined ? '' : String(v).trim()
}

// 仕様属性: item / extension / unit codes are not described in the library; the labels
// below are inferred from the values of a maker's catalog (e.g. 2-6 >= 2-3 for every
// part, 7-17/18/19 match published outdoor unit dimensions W/D/H).
const SPEC_ITEMS: Record<string, [string, string, boolean]> = {
  '1-1': ['登録日', '', true],
  '1-3': ['型番', '', true],
  '1-5': ['メーカーコード', '', true],
  '2-3': ['冷房能力', 'kW', true],
  '2-6': ['暖房能力', 'kW', true],
  '3-1': ['風量', 'm³/min', true],
  '7-17': ['外形寸法 幅', 'mm', true],
  '7-18': ['外形寸法 奥行', 'mm', true],
  '7-19': ['外形寸法 高さ', 'mm', true],
  '7-22': ['質量', 'kg', true],
  '7-33': ['運転音', 'dB', true],
  '7-34': ['運転音 (音響パワー)', 'dB', true],
  '8-2': ['電源 相', '', true],
  '8-3': ['電源 電圧', 'V', true],
  '8-5': ['消費電力', 'kW', true],
}
const SPEC_EXT: Record<string, string> = {
  '2-1': '室内機',
  '2-2': '室外機',
  '3-1': '冷房',
  '3-2': '暖房',
  '8-1': '50Hz',
  '8-2': '60Hz',
}

function specFromRow(r: Record<string, MdbValue>): LibrarySpec {
  const item = `${r['項目GID']}-${r['項目ID']}`
  const ext: string[] = []
  for (let i = 1; i <= 6; i++) {
    const g = Number(r[`拡張GID${i}`])
    if (g) ext.push(`${g}-${r[`拡張ID${i}`]}`)
  }
  const known = SPEC_ITEMS[item]
  const extLabel = ext.map((e) => SPEC_EXT[e] ?? e).join(' ')
  return {
    key: [item, ...ext].join('/'),
    label: `${known ? known[0] : `項目 ${item}`}${extLabel ? ` (${extLabel})` : ''}`,
    value: str(r['値']),
    unit: known ? known[1] : '',
    guessed: known ? known[2] : false,
  }
}

const ATTR_LABELS: Record<string, string> = {
  hikidashi: '配線引出区分',
  torituke: '取り付け区分',
  hiroi: '材料拾い区分',
  volt_ampere: '負荷容量',
  volt: '電圧',
  wire_plus: '配線余長',
  power_source: '電源',
  layer: 'レイヤ',
}
// values seen in the Tfas manual's sample (境界中心 / 天井面 / 材料拾いする = 1)
const ATTR_VALUES: Record<string, Record<number, string>> = {
  hikidashi: { 1: '境界中心' },
  torituke: { 1: '天井面' },
  hiroi: { 0: '材料拾いしない', 1: '材料拾いする' },
}

function attrSpecs(r: Record<string, MdbValue>): LibrarySpec[] {
  const out: LibrarySpec[] = []
  for (const [k, label] of Object.entries(ATTR_LABELS)) {
    const v = r[k]
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && v === 0 && !(k in ATTR_VALUES))) continue
    const named = typeof v === 'number' ? ATTR_VALUES[k]?.[v] : undefined
    out.push({ key: `Attr.${k}`, label, value: named ?? String(v), unit: k === 'volt' ? 'V' : k === 'wire_plus' ? 'mm' : '', guessed: named !== undefined })
  }
  return out
}

// ---------------------------------------------------------------------------------
// EMF previews: Tfas stores small vector icons (pens + POLYLINE16 etc.). They are
// converted to the same flat geometry as part drawings (device units, y up).

const STOCK_PEN_WHITE = 0x80000006
const STOCK_PEN_BLACK = 0x80000007
const STOCK_PEN_NULL = 0x80000008

interface Pen {
  color: number
  linetype: number
  visible: boolean
}

export function emfDrawing(emf: Uint8Array, code: string, name: string): PartDrawing | null {
  if (emf.length < 88) return null
  const v = new DataView(emf.buffer, emf.byteOffset, emf.byteLength)
  if (v.getUint32(0, true) !== 1 || v.getUint32(40, true) !== 0x464d4520) return null
  const g = new GeomBuilder()
  const styles: Style[] = []
  const styleIndex = new Map<string, number>()
  const styleOf = (p: Pen) => {
    const key = `${p.color}/${p.linetype}`
    let i = styleIndex.get(key)
    if (i === undefined) {
      i = styles.length
      styles.push({ color: p.color, linetype: p.linetype, width: 1 })
      styleIndex.set(key, i)
    }
    return i
  }
  const objects = new Map<number, Pen | null>()
  let pen: Pen = { color: 1, linetype: 1, visible: true }
  let mapMode = 1
  let winOrg = [0, 0]
  let winExt = [1, 1]
  let vpOrg = [0, 0]
  let vpExt = [1, 1]
  let cur = [0, 0]
  const tx = (x: number, y: number): [number, number] => {
    let sx = 1
    let sy = 1
    if (mapMode === 7 || mapMode === 8) {
      sx = winExt[0] ? vpExt[0] / winExt[0] : 1
      sy = winExt[1] ? vpExt[1] / winExt[1] : 1
      if (mapMode === 7) {
        const s = Math.min(Math.abs(sx), Math.abs(sy))
        sx = Math.sign(sx) * s
        sy = Math.sign(sy) * s
      }
    }
    return [(x - winOrg[0]) * sx + vpOrg[0], -((y - winOrg[1]) * sy + vpOrg[1])]
  }
  const poly = (pts: number[], closed: boolean) => {
    if (!pen.visible || pts.length < 4) return
    const at = g.begin(Prim.Polyline, closed ? PrimFlag.Closed : 0, styleOf(pen), pts.length)
    const c = g.rawCoords
    for (let i = 0; i < pts.length; i += 2) {
      const [x, y] = tx(pts[i], pts[i + 1])
      c[at + i] = x
      c[at + i + 1] = y
      g.extend(x, y)
    }
  }
  const points = (o: number, n: number, small: boolean): number[] => {
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      out.push(small ? v.getInt16(o + i * 4, true) : v.getInt32(o + i * 8, true), small ? v.getInt16(o + i * 4 + 2, true) : v.getInt32(o + i * 8 + 4, true))
    }
    return out
  }
  for (let o = 0; o + 8 <= emf.length; ) {
    const type = v.getUint32(o, true)
    const size = v.getUint32(o + 4, true)
    if (size < 8 || o + size > emf.length) break
    const d = o + 8
    switch (type) {
      case 3: // POLYGON
      case 4: // POLYLINE
      case 86: // POLYGON16
      case 87: {
        // POLYLINE16
        const n = v.getUint32(d + 16, true)
        const small = type >= 86
        if (d + 20 + n * (small ? 4 : 8) <= o + size) poly(points(d + 20, n, small), type === 3 || type === 86)
        break
      }
      case 7: // POLYPOLYLINE
      case 8: // POLYPOLYGON
      case 90: // POLYPOLYLINE16
      case 91: {
        // POLYPOLYGON16
        const np = v.getUint32(d + 16, true)
        const small = type >= 90
        let at = d + 24 + np * 4
        for (let i = 0; i < np; i++) {
          const n = v.getUint32(d + 24 + i * 4, true)
          if (at + n * (small ? 4 : 8) > o + size) break
          poly(points(at, n, small), type === 8 || type === 91)
          at += n * (small ? 4 : 8)
        }
        break
      }
      case 27: // MOVETOEX
        cur = [v.getInt32(d, true), v.getInt32(d + 4, true)]
        break
      case 54: {
        // LINETO
        const next = [v.getInt32(d, true), v.getInt32(d + 4, true)]
        poly([cur[0], cur[1], next[0], next[1]], false)
        cur = next
        break
      }
      case 43: {
        // RECTANGLE
        const [l, t, r, b] = [v.getInt32(d, true), v.getInt32(d + 4, true), v.getInt32(d + 8, true), v.getInt32(d + 12, true)]
        poly([l, t, r, t, r, b, l, b], true)
        break
      }
      case 42: {
        // ELLIPSE (approximated by a polygon)
        const [l, t, r, b] = [v.getInt32(d, true), v.getInt32(d + 4, true), v.getInt32(d + 8, true), v.getInt32(d + 12, true)]
        const pts: number[] = []
        for (let i = 0; i < 48; i++) {
          const a = (i / 48) * Math.PI * 2
          pts.push((l + r) / 2 + ((r - l) / 2) * Math.cos(a), (t + b) / 2 + ((b - t) / 2) * Math.sin(a))
        }
        poly(pts, true)
        break
      }
      case 17: // SETMAPMODE
        mapMode = v.getUint32(d, true)
        break
      case 9: // SETWINDOWEXTEX
        winExt = [v.getInt32(d, true), v.getInt32(d + 4, true)]
        break
      case 10: // SETWINDOWORGEX
        winOrg = [v.getInt32(d, true), v.getInt32(d + 4, true)]
        break
      case 11: // SETVIEWPORTEXTEX
        vpExt = [v.getInt32(d, true), v.getInt32(d + 4, true)]
        break
      case 12: // SETVIEWPORTORGEX
        vpOrg = [v.getInt32(d, true), v.getInt32(d + 4, true)]
        break
      case 38: {
        // CREATEPEN: ihPen, style, width (point), color
        const style = v.getUint32(d + 4, true)
        objects.set(v.getUint32(d, true), { color: colorNumber(v.getUint32(d + 16, true)), linetype: penLinetype(style), visible: (style & 0xf) !== 5 })
        break
      }
      case 95: {
        // EXTCREATEPEN: ihPen, offBmi, cbBmi, offBits, cbBits, style, width, brush style, color
        const style = v.getUint32(d + 20, true)
        objects.set(v.getUint32(d, true), { color: colorNumber(v.getUint32(d + 32, true)), linetype: penLinetype(style), visible: (style & 0xf) !== 5 })
        break
      }
      case 39: // CREATEBRUSHINDIRECT (brushes are not drawn)
        objects.set(v.getUint32(d, true), null)
        break
      case 37: {
        // SELECTOBJECT
        const ih = v.getUint32(d, true)
        if (ih === STOCK_PEN_NULL) pen = { ...pen, visible: false }
        else if (ih === STOCK_PEN_BLACK || ih === STOCK_PEN_WHITE) pen = { color: 1, linetype: 1, visible: true }
        else {
          const obj = objects.get(ih)
          if (obj) pen = obj
        }
        break
      }
      case 40: // DELETEOBJECT
        objects.delete(v.getUint32(d, true))
        break
    }
    o += size
    if (type === 14) break
  }
  const geom = g.finish()
  const bbox: Rect | null = isEmptyRect(g.bbox) ? null : g.bbox
  return {
    code,
    source: 'image',
    name,
    longName: name,
    scale: 1,
    geom,
    texts: [],
    styles,
    entities: [{ kind: 0x120, id: 0 }],
    bbox,
    connectors: [],
    model3dBytes: 0,
    errors: 0,
  }
}

/** PS_DASH .. PS_DASHDOTDOT -> Tfas built-in line types (2 破線, 3 点線, 4 一点鎖線, 5 二点鎖線). */
function penLinetype(style: number): number {
  return [1, 2, 3, 4, 5][style & 0xf] ?? 1
}

// COLORREF (0x00BBGGRR) -> nearest Tfas base color number; near-white and black map to 1,
// the foreground color of the drawing.
const BASE_COLORS: [number, number, number, number][] = [
  [3, 255, 0, 0],
  [4, 0, 255, 0],
  [5, 0, 0, 255],
  [6, 255, 255, 0],
  [7, 255, 0, 255],
  [8, 0, 255, 255],
  [16, 128, 128, 128],
]

function colorNumber(colorref: number): number {
  const r = colorref & 255
  const g = (colorref >> 8) & 255
  const b = (colorref >> 16) & 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max - min < 48 && (max > 170 || max < 60)) return 1
  let best = 1
  let dist = Infinity
  for (const [n, cr, cg, cb] of BASE_COLORS) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (d < dist) {
      dist = d
      best = n
    }
  }
  return best
}
