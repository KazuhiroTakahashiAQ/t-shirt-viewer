// Names and properties of entities for the property panel. Kind codes of composite
// objects were identified from the sample drawings (which drawings use them, what they
// contain); the ones marked 推定 are educated guesses.

import { Prim, PrimFlag, type GeomBuffer, type ImageItem, type Rect, type TextItem, type TfasDocument } from '../tfas/model.ts'
import { primLength } from './pick.ts'

const NAMES: Record<number, string> = {
  0x08: '点',
  0x10: '線分',
  0x18: '線分',
  0x20: '線分',
  0x28: '補助線',
  0x30: '補助線',
  0x38: '連続線',
  0x39: '多角形',
  0x40: '円',
  0x48: '円弧',
  0x50: '楕円',
  0x58: '楕円弧',
  0x60: 'スプライン',
  0x68: '3D 連続線',
  0x70: '文字',
  0x170: '複合図形 (器具・枠付き文字など) 推定',
  0x120: '部品 (シンボル)',
  0x121: '寸法',
  0x12a: '角度寸法',
  0x150: 'グループ',
  0x160: 'OLE オブジェクト',
  0x165: '画像',
  0x1a1: '引出線',
  0x400: '電気設備 (配線) 推定',
  0x460: '電気設備 (記号) 推定',
  0x470: '電気設備 推定',
  0x500: '空調設備 (ダクト・配管)',
  0x550: '機器 推定',
  0x600: '衛生設備 (配管)',
  0x650: '機器 推定',
}

/** レイヤグループ numbers as shown by Tfas (layer set number + 1). */
export const LAYER_GROUPS: Record<number, string> = { 1: '基本', 2: '建築', 3: 'グループ3', 4: '電気', 5: '空調', 6: '衛生' }

export function kindName(kind: number): string {
  const k = kind & 0xfff
  const name = NAMES[k] ?? (k >= 0x200 && k < 0x300 ? '建築要素 推定' : '複合図形')
  return name
}

export function kindCode(kind: number): string {
  return `0x${kind.toString(16)}`
}

export interface EntityParts {
  prims: number[]
  texts: TextItem[]
  images: ImageItem[]
  bbox: Rect | null
}

/** Primitives, texts and images belonging to one top-level entity. */
export function entityParts(geom: GeomBuffer, texts: TextItem[], images: ImageItem[], entity: number): EntityParts {
  const prims: number[] = []
  let bbox: Rect | null = null
  const add = (x: number, y: number) => {
    if (!bbox) bbox = { x0: x, y0: y, x1: x, y1: y }
    else {
      if (x < bbox.x0) bbox.x0 = x
      if (x > bbox.x1) bbox.x1 = x
      if (y < bbox.y0) bbox.y0 = y
      if (y > bbox.y1) bbox.y1 = y
    }
  }
  for (let i = 0; i < geom.count; i++) {
    if (geom.entity[i] !== entity) continue
    prims.push(i)
    const a = geom.offsets[i]
    const t = geom.types[i]
    if (t === Prim.Circle || t === Prim.Arc) {
      const r = geom.coords[a + 2]
      add(geom.coords[a] - r, geom.coords[a + 1] - r)
      add(geom.coords[a] + r, geom.coords[a + 1] + r)
    } else if (t === Prim.Ellipse) {
      const r = Math.max(geom.coords[a + 2], geom.coords[a + 3])
      add(geom.coords[a] - r, geom.coords[a + 1] - r)
      add(geom.coords[a] + r, geom.coords[a + 1] + r)
    } else for (let k = a; k + 1 < geom.offsets[i + 1]; k += 2) add(geom.coords[k], geom.coords[k + 1])
  }
  const ts = texts.filter((t) => t.entity === entity)
  for (const t of ts) {
    add(t.bbox.x0, t.bbox.y0)
    add(t.bbox.x1, t.bbox.y1)
  }
  const ims = images.filter((im) => im.entity === entity)
  for (const im of ims) {
    add(im.bbox.x0, im.bbox.y0)
    add(im.bbox.x1, im.bbox.y1)
  }
  return { prims, texts: ts, images: ims, bbox }
}

const num = (n: number, d = 1) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 })

/** Property rows (label, value) for the panel. */
export function entityProperties(doc: TfasDocument, layerIndex: number, geom: GeomBuffer, entity: number, parts: EntityParts): [string, string][] {
  const layer = doc.layers[layerIndex]
  const info = layer.entities[entity]
  const rows: [string, string][] = []
  const kind = info?.kind ?? 0
  rows.push(['種別', `${kindName(kind)}  (${kindCode(kind)})`])
  rows.push(['シート', `${layer.name || `(${layerIndex})`}  1/${layer.scale}`])
  // Tfas レイヤ (stored as the 図形属性 table) and its レイヤグループ
  const attrId = parts.prims.length ? geom.attr[parts.prims[0]] : parts.texts[0]?.attr
  const attr = attrId !== undefined ? doc.attributes.find((x) => x.id === attrId) : undefined
  if (attr) rows.push(['レイヤ', `${attr.name || '(名称なし)'}  (${LAYER_GROUPS[attr.group] ?? `グループ ${attr.group}`})`])
  // style: the common value, or 混在 when the parts differ
  const styleIds = [...parts.prims.map((i) => geom.styles[i]), ...parts.texts.map((t) => t.style)]
  if (styleIds.length) {
    const styles = styleIds.map((i) => doc.styles[i])
    const value = (k: 'color' | 'linetype' | 'width') => {
      const set = new Set(styles.map((st) => st[k]))
      return set.size === 1 ? `${styles[0][k]}` : `混在 (${[...set].slice(0, 4).join(', ')}${set.size > 4 ? '…' : ''})`
    }
    rows.push(['色', value('color')])
    rows.push(['線種', value('linetype')])
    rows.push(['線幅', value('width')])
  }
  const flags = [...parts.prims.map((i) => geom.flags[i]), ...parts.texts.map((t) => t.flags)]
  const aux = flags.filter((f) => f & PrimFlag.Aux).length
  if (aux) rows.push(['補助図形', aux === flags.length ? 'はい (印刷されない)' : `一部 (${aux} / ${flags.length} 個は印刷されない)`])
  const scale = doc.scale
  const mm = (v: number) => `${num(v)} mm`
  if (parts.prims.length === 1 && !parts.texts.length) {
    const i = parts.prims[0]
    const c = geom.coords
    const a = geom.offsets[i]
    switch (geom.types[i]) {
      case Prim.Line:
        rows.push(['始点', `${num(c[a])}, ${num(c[a + 1])}`])
        rows.push(['終点', `${num(c[a + 2])}, ${num(c[a + 3])}`])
        rows.push(['長さ', mm(primLength(geom, i))])
        rows.push(['角度', `${num((Math.atan2(c[a + 3] - c[a + 1], c[a + 2] - c[a]) * 180) / Math.PI, 2)}°`])
        break
      case Prim.Polyline:
        rows.push(['頂点数', `${(geom.offsets[i + 1] - a) / 2}${geom.flags[i] & PrimFlag.Closed ? ' (閉じた図形)' : ''}`])
        rows.push(['長さ', mm(primLength(geom, i))])
        break
      case Prim.Circle:
        rows.push(['中心', `${num(c[a])}, ${num(c[a + 1])}`])
        rows.push(['半径', mm(c[a + 2])])
        rows.push(['直径', mm(c[a + 2] * 2)])
        break
      case Prim.Arc: {
        rows.push(['中心', `${num(c[a])}, ${num(c[a + 1])}`])
        rows.push(['半径', mm(c[a + 2])])
        rows.push(['弧長', mm(primLength(geom, i))])
        let span = ((c[a + 4] - c[a + 3]) * 180) / Math.PI
        while (span <= 0) span += 360
        rows.push(['開き角', `${num(span, 2)}°`])
        break
      }
      case Prim.Ellipse:
        rows.push(['中心', `${num(c[a])}, ${num(c[a + 1])}`])
        rows.push(['半径', `${num(c[a + 2])} × ${num(c[a + 3])} mm`])
        break
      case Prim.Point:
        rows.push(['位置', `${num(c[a])}, ${num(c[a + 1])}`])
        break
    }
  } else if (parts.prims.length) rows.push(['構成図形', `${parts.prims.length.toLocaleString()} 個`])
  if (parts.texts.length) {
    const t = parts.texts[0]
    rows.push(['文字', parts.texts.map((x) => x.text).join(' / ')])
    rows.push(['フォント', t.font || '(既定)'])
    rows.push(['文字高', `${num(t.height / scale, 2)} mm (用紙)`])
    if (t.angle) rows.push(['文字角度', `${num(t.angle, 2)}°`])
  }
  for (const im of parts.images) {
    rows.push([im.kind === 'ole' ? 'OLE' : '画像', im.name || '(名称なし)'])
    if (im.bitmap) rows.push(['画素数', `${im.bitmap.width} × ${im.bitmap.height}`])
  }
  if (parts.bbox) {
    const b = parts.bbox
    rows.push(['範囲', `${num(b.x1 - b.x0)} × ${num(b.y1 - b.y0)} mm`])
  }
  if (info) rows.push(['ID', `${info.id}`])
  return rows
}
