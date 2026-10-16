// External references: a layer can show a layer of another .tfs file (typically the
// title-block frame). The referenced file's paper rectangle is mapped onto the
// referencing file's paper rectangle.

import { Prim, type EntityInfo, type GeomBuffer, type Layer, type Rect, type TextItem, type TfsDocument } from './model.ts'

export interface ResolvedXref {
  geom: GeomBuffer
  texts: TextItem[]
  bbox: Rect | null
  /** entities of the referenced layer (indices used by geom.entity / texts) */
  entities: EntityInfo[]
}

export function resolveXref(target: TfsDocument, layer: Layer, source: TfsDocument): ResolvedXref | null {
  const want = layer.xref?.layerName ?? ''
  const src = source.layers.find((l) => l.name === want && !l.xref) ?? (want ? null : source.layers.find((l) => l.visible && !l.xref))
  if (!src) return null
  const sp = source.paper
  const tp = target.paper
  const s = (tp.x1 - tp.x0) / (sp.x1 - sp.x0)
  const tx = (x: number) => tp.x0 + (x - sp.x0) * s
  const ty = (y: number) => tp.y0 + (y - sp.y0) * s

  const styleMap = new Map<number, number>()
  const mapStyle = (i: number) => {
    let j = styleMap.get(i)
    if (j === undefined) {
      const st = source.styles[i]
      j = target.styles.findIndex((t) => t.color === st.color && t.linetype === st.linetype && t.width === st.width)
      if (j < 0) {
        j = target.styles.length
        target.styles.push({ ...st })
      }
      styleMap.set(i, j)
    }
    return j
  }

  const g = src.geom
  const coords = new Float64Array(g.coords.length)
  const styles = new Uint16Array(g.count)
  for (let i = 0; i < g.count; i++) {
    styles[i] = mapStyle(g.styles[i])
    const a = g.offsets[i]
    const b = g.offsets[i + 1]
    switch (g.types[i]) {
      case Prim.Circle:
      case Prim.Arc:
        coords[a] = tx(g.coords[a])
        coords[a + 1] = ty(g.coords[a + 1])
        coords[a + 2] = g.coords[a + 2] * s
        for (let k = a + 3; k < b; k++) coords[k] = g.coords[k]
        break
      case Prim.Ellipse:
        coords[a] = tx(g.coords[a])
        coords[a + 1] = ty(g.coords[a + 1])
        coords[a + 2] = g.coords[a + 2] * s
        coords[a + 3] = g.coords[a + 3] * s
        for (let k = a + 4; k < b; k++) coords[k] = g.coords[k]
        break
      default:
        for (let k = a; k < b; k += 2) {
          coords[k] = tx(g.coords[k])
          coords[k + 1] = ty(g.coords[k + 1])
        }
    }
  }
  const geom: GeomBuffer = { ...g, styles, coords }
  const texts = src.texts.map((t) => ({
    ...t,
    x: tx(t.x),
    y: ty(t.y),
    height: t.height * s,
    width: t.width * s,
    pitch: t.pitch * s,
    style: mapStyle(t.style),
    bbox: { x0: tx(t.bbox.x0), y0: ty(t.bbox.y0), x1: tx(t.bbox.x1), y1: ty(t.bbox.y1) },
  }))
  const bbox = src.bbox ? { x0: tx(src.bbox.x0), y0: ty(src.bbox.y0), x1: tx(src.bbox.x1), y1: ty(src.bbox.y1) } : null
  return { geom, texts, bbox, entities: src.entities }
}
