// In-memory document model produced by the reader. Geometry is kept in flat typed arrays
// so a parsed document can be moved between a worker and the page cheaply.

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Primitive types stored in a GeomBuffer. */
export const Prim = {
  /** x0 y0 x1 y1 */
  Line: 1,
  /** n * (x y); flag bit Closed marks closed polylines */
  Polyline: 2,
  /** cx cy r */
  Circle: 3,
  /** cx cy r a0 a1 (radians, counter-clockwise from a0 to a1) */
  Arc: 4,
  /** cx cy rx ry rot t0 t1 (radians); full ellipse when t0 == t1 */
  Ellipse: 5,
  /** x0 y0 then 6 coords per cubic segment (c1 c2 end) */
  Bezier: 6,
  /** x y */
  Point: 7,
} as const

export const PrimFlag = {
  /** auxiliary geometry (construction points, helper lines) that the CAD does not print */
  Aux: 1,
  Closed: 2,
  /** data the CAD keeps for editing but does not display (kind bit 0x40000000) */
  Hidden: 4,
} as const

export interface GeomBuffer {
  count: number
  types: Uint8Array
  flags: Uint8Array
  styles: Uint16Array
  /** start index into coords; offsets[count] is the total length */
  offsets: Uint32Array
  coords: Float64Array
  /** top-level entity of each primitive (index into Layer.entities) */
  entity: Uint32Array
  /** レイヤ (図形属性 id) of each primitive */
  attr: Uint32Array
}

/** A top-level entity (line, text, duct, dimension, part ...) as the CAD selects it. */
export interface EntityInfo {
  /** entity kind without the aux / hidden bits (0x500 duct or pipe, 0x121 dimension, ...) */
  kind: number
  id: number
}

export interface Style {
  color: number
  linetype: number
  width: number
}

export interface TextItem {
  x: number
  y: number
  /** degrees, counter-clockwise */
  angle: number
  /** character box height in model units */
  height: number
  /** full-width character width in model units */
  width: number
  /** distance between baselines of consecutive lines in model units */
  pitch: number
  /** 1..9, see TEXT_ANCHORS */
  align: number
  text: string
  font: string
  style: number
  flags: number
  bbox: Rect
  /** top-level entity (index into Layer.entities) */
  entity: number
  /** レイヤ (図形属性 id) */
  attr: number
}

export interface XrefInfo {
  directory: string
  fileName: string
  /** name of the layer to take from the referenced file */
  layerName: string
}

/**
 * How a layer is colored on screen: by each primitive's color, in one layer color
 * (レイヤ色表示), or dimmed as a reference layer (グレー表示).
 */
export interface LayerColor {
  mode: 'entity' | 'layer' | 'gray'
  color: number
}

/** Raster image (kind 0x165) or embedded OLE object (kind 0x160) placed on a quadrilateral. */
export interface ImageItem {
  kind: 'raster' | 'ole'
  name: string
  /** bottom-left, bottom-right, top-right, top-left corners (x, y pairs) */
  corners: number[]
  /** decoded pixels (DIB images) */
  bitmap: Thumbnail | null
  /** compressed image data (JPEG / PNG) to be decoded by the viewer */
  encoded: { mime: string; data: Uint8Array } | null
  bbox: Rect
  /** top-level entity (index into Layer.entities) */
  entity: number
}

export interface Layer {
  index: number
  name: string
  /** visibility stored in the file */
  visible: boolean
  /** current sheet (カレントシート) when the file was saved */
  current?: boolean
  /** sheet state 編集 (editable) rather than 表示 (display only) */
  editable?: boolean
  color: LayerColor
  /** own layer scale denominator, or the document scale */
  scale: number
  /** set for sheets that belong to a layout (レイアウト) instead of the model */
  layout: SheetLayout | null
  /** 単色指定: color number the sheet is shown in when it is not the current sheet (0 = off) */
  monoColor?: number
  /** シート基準高さ (mm) */
  elevation?: number
  /** 階名 of the sheet's floor setting */
  floor?: string
  xref: XrefInfo | null
  geom: GeomBuffer
  texts: TextItem[]
  images: ImageItem[]
  entities: EntityInfo[]
  bbox: Rect | null
}

/**
 * A viewport shows a region of the model on a layout. The model region is
 * origin + s*u + t*v (s, t in 0..1); u and v may be rotated. On the layout the region
 * appears at `place` with u along +x and v along +y, scaled by
 * document scale / sheet scale.
 */
export interface Viewport {
  origin: [number, number]
  u: [number, number]
  v: [number, number]
  place: [number, number]
}

export interface SheetLayout {
  /** layout id, as in TfsDocument.layouts */
  layoutId: string
  /** the current sheet of its layout */
  layoutCurrent: boolean
  viewport: Viewport | null
  /** model sheets shown in the viewport (null: all of them) */
  showSheets: string[] | null
  /** レイヤ hidden in the viewport */
  frozenLayers: string[]
}

export interface LayoutInfo {
  id: string
  name: string
}

/** 文字関数: `$(name)` in texts is replaced by the value (per layout when given). */
export interface TextFunction {
  name: string
  value: string
  layouts: Record<string, string>
}

/** レイヤ (stored as the 図形属性 table). */
export interface AttributeInfo {
  id: number
  name: string
  /** レイヤグループ: 1 基本, 2 建築, 4 電気, 5 空調, 6 衛生 ... (= set number + 1) */
  group: number
  /** color number of the レイヤ */
  color: number
}

export interface Thumbnail {
  width: number
  height: number
  rgba: Uint8ClampedArray
}

export interface TfsDocument {
  fileName: string
  version: string
  /** document scale denominator, e.g. 50 for 1/50 */
  scale: number
  /** paper rectangle in model units */
  paper: Rect
  /** layouts (レイアウト) besides the model, in file order */
  layouts: LayoutInfo[]
  layers: Layer[]
  styles: Style[]
  /** line types defined in the file: number -> dash pattern in paper mm (on, off, on, off...) */
  linetypes: Record<number, number[]>
  thumbnail: Thumbnail | null
  /** 文字関数 values */
  functions: TextFunction[]
  /** レイヤ definitions */
  attributes: AttributeInfo[]
  warnings: string[]
  stats: { primitives: number; texts: number; hiddenSkipped: number; parseMs: number }
}

/** Text anchor code -> [horizontal 0..2 (left/center/right), vertical 0..2 (bottom/middle/top)] */
export const TEXT_ANCHORS: Record<number, [number, number]> = {
  1: [0, 0],
  2: [1, 0],
  3: [2, 0],
  8: [0, 1],
  4: [1, 1],
  9: [2, 1],
  5: [0, 2],
  6: [1, 2],
  7: [2, 2],
}

export function emptyRect(): Rect {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
}

export function isEmptyRect(r: Rect): boolean {
  return !(r.x0 <= r.x1 && r.y0 <= r.y1)
}

export function unionRect(a: Rect, b: Rect): Rect {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1
}
