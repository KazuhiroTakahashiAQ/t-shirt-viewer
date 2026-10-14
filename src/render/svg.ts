// SVG export. Shares layout rules with the canvas renderer; used by the CLI and by
// the viewer's "SVG 保存" command.

import { layoutText } from '../tfas/geometry.ts'
import { Prim, PrimFlag, intersects, type GeomBuffer, type ImageItem, type LayerColor, type Rect, type TextItem, type TfasDocument } from '../tfas/model.ts'
import { imageDataUri, imageMatrix } from './images.ts'
import { backgroundColor, dashPattern, fontFamily, layerStroke, linePx, type RenderOptions } from './style.ts'

export interface SvgLayer {
  geom: GeomBuffer
  texts: TextItem[]
  images?: ImageItem[]
  color: LayerColor
  /** clip polygon (x, y pairs in model units), for layout viewports */
  clip?: number[] | null
}

export interface SvgOptions extends RenderOptions {
  /** model rectangle to export */
  window: Rect
  /** output width in px (height follows the aspect ratio) */
  widthPx: number
  /** stroke width in px */
  strokePx?: number
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const f = (n: number) => (Math.round(n * 100) / 100).toString()

export function toSvg(doc: TfasDocument, layers: SvgLayer[], o: SvgOptions): string {
  const { window: w, widthPx } = o
  const s = widthPx / (w.x1 - w.x0)
  const H = Math.ceil((w.y1 - w.y0) * s)
  const X = (x: number) => (x - w.x0) * s
  const Y = (y: number) => (w.y1 - y) * s
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${H}" viewBox="0 0 ${widthPx} ${H}">`)
  out.push(`<rect width="100%" height="100%" fill="${backgroundColor(o)}"/>`)
  out.push(`<g fill="none" stroke-width="${o.strokePx ?? 0.8}" stroke-linecap="round" stroke-linejoin="round">`)
  layers.forEach((layer, li) => {
    if (layer.clip?.length) {
      const pts = []
      for (let k = 0; k + 1 < layer.clip.length; k += 2) pts.push(`${f(X(layer.clip[k]))},${f(Y(layer.clip[k + 1]))}`)
      out.push(`<clipPath id="clip${li}"><polygon points="${pts.join(' ')}"/></clipPath><g clip-path="url(#clip${li})">`)
    } else out.push('<g>')
    for (const img of layer.images ?? []) {
      if (!intersects(img.bbox, w)) continue
      const uri = imageDataUri(img)
      if (uri) {
        const m = imageMatrix(img, uri.width, uri.height, (x, y) => [X(x), Y(y)])
        out.push(`<image width="${uri.width}" height="${uri.height}" preserveAspectRatio="none" transform="matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map(f).join(' ')})" href="${uri.href}"/>`)
        const c = img.corners
        out.push(`<polygon points="${[0, 2, 4, 6].map((k) => `${f(X(c[k]))},${f(Y(c[k + 1]))}`).join(' ')}" fill="none" stroke="#808080"/>`)
      } else {
        const r = img.bbox
        out.push(`<rect x="${f(X(r.x0))}" y="${f(Y(r.y1))}" width="${f((r.x1 - r.x0) * s)}" height="${f((r.y1 - r.y0) * s)}" fill="none" stroke="#7a8aa0" stroke-dasharray="4 3"/>`)
      }
    }
    const g = layer.geom
    let current = ''
    let d = ''
    const flush = () => {
      if (d) out.push(`<path ${current} d="${d}"/>`)
      d = ''
    }
    for (let i = 0; i < g.count; i++) {
      const fl = g.flags[i]
      if (fl & PrimFlag.Aux && !o.showAux) continue
      const a = g.offsets[i]
      const e = g.offsets[i + 1]
      const c = g.coords
      if (!primInWindow(g, i, w)) continue
      const st = doc.styles[g.styles[i]]
      const dash = dashPattern(doc, st.linetype)
      const lw = linePx(st.width, o)
      const attrs = `stroke="${layerStroke(layer.color, st.color, o)}"${lw !== 1 ? ` stroke-width="${f(lw * (o.strokePx ?? 0.8))}"` : ''}${dash ? ` stroke-dasharray="${dash.map((v) => f(v * s)).join(' ')}"` : ''}`
      if (attrs !== current) {
        flush()
        current = attrs
      }
      switch (g.types[i]) {
        case Prim.Line:
          d += `M${f(X(c[a]))} ${f(Y(c[a + 1]))}L${f(X(c[a + 2]))} ${f(Y(c[a + 3]))}`
          break
        case Prim.Polyline:
          d += `M${f(X(c[a]))} ${f(Y(c[a + 1]))}`
          for (let k = a + 2; k < e; k += 2) d += `L${f(X(c[k]))} ${f(Y(c[k + 1]))}`
          if (fl & PrimFlag.Closed) d += 'Z'
          break
        case Prim.Circle: {
          const r = c[a + 2] * s
          d += `M${f(X(c[a]) + r)} ${f(Y(c[a + 1]))}a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0`
          break
        }
        case Prim.Arc: {
          const [cx, cy, r, a0, a1] = [c[a], c[a + 1], c[a + 2], c[a + 3], c[a + 4]]
          const large = a1 - a0 > Math.PI ? 1 : 0
          d += `M${f(X(cx + r * Math.cos(a0)))} ${f(Y(cy + r * Math.sin(a0)))}A${f(r * s)} ${f(r * s)} 0 ${large} 0 ${f(X(cx + r * Math.cos(a1)))} ${f(Y(cy + r * Math.sin(a1)))}`
          break
        }
        case Prim.Ellipse: {
          const [cx, cy, rx, ry, rot, t0, t1] = [c[a], c[a + 1], c[a + 2], c[a + 3], c[a + 4], c[a + 5], c[a + 6]]
          const pt = (t: number): [number, number] => {
            const lx = rx * Math.cos(t)
            const ly = ry * Math.sin(t)
            return [cx + lx * Math.cos(rot) - ly * Math.sin(rot), cy + lx * Math.sin(rot) + ly * Math.cos(rot)]
          }
          const deg = (-rot * 180) / Math.PI
          if (t0 === t1) {
            const [x0, y0] = pt(0)
            const [x1, y1] = pt(Math.PI)
            d += `M${f(X(x0))} ${f(Y(y0))}A${f(rx * s)} ${f(ry * s)} ${f(deg)} 1 0 ${f(X(x1))} ${f(Y(y1))}A${f(rx * s)} ${f(ry * s)} ${f(deg)} 1 0 ${f(X(x0))} ${f(Y(y0))}`
          } else {
            const [x0, y0] = pt(t0)
            const [x1, y1] = pt(t1)
            d += `M${f(X(x0))} ${f(Y(y0))}A${f(rx * s)} ${f(ry * s)} ${f(deg)} ${t1 - t0 > Math.PI ? 1 : 0} 0 ${f(X(x1))} ${f(Y(y1))}`
          }
          break
        }
        case Prim.Bezier:
          d += `M${f(X(c[a]))} ${f(Y(c[a + 1]))}`
          for (let k = a + 2; k + 5 < e; k += 6) d += `C${f(X(c[k]))} ${f(Y(c[k + 1]))} ${f(X(c[k + 2]))} ${f(Y(c[k + 3]))} ${f(X(c[k + 4]))} ${f(Y(c[k + 5]))}`
          break
        case Prim.Point:
          if (o.showAux) d += `M${f(X(c[a]) - 1)} ${f(Y(c[a + 1]))}h2`
          break
      }
      if (d.length > 60000) flush()
    }
    flush()
    if (o.showText) {
      for (const t of layer.texts) {
        if (!intersects(t.bbox, w)) continue
        if (t.flags & PrimFlag.Aux && !o.showAux) continue
        const fill = layerStroke(layer.color, doc.styles[t.style].color, o)
        const kx = t.width / t.height
        const rad = (t.angle * Math.PI) / 180
        const ca = Math.cos(rad)
        const sa = Math.sin(rad)
        const glyphs: string[] = []
        for (const ln of layoutText(t)) {
          for (let i = 0; i < ln.chars.length; i++) {
            const ch = ln.chars[i]
            if (ch === ' ' || ch === '　') continue
            const lx = ln.xs[i]
            const ly = ln.y
            const px = X(t.x + lx * ca - ly * sa)
            const py = Y(t.y + lx * sa + ly * ca)
            glyphs.push(`<text transform="matrix(${f(ca * kx)} ${f(-sa * kx)} ${f(sa)} ${f(ca)} ${f(px)} ${f(py)})">${esc(ch)}</text>`)
          }
        }
        if (glyphs.length) out.push(`<g fill="${fill}" stroke="none" dominant-baseline="ideographic" font-size="${f(t.height * s)}" font-family="${esc(fontFamily(t.font))}">${glyphs.join('')}</g>`)
      }
    }
    out.push('</g>')
  })
  out.push('</g>')
  out.push('</svg>')
  return out.join('\n')
}

function primInWindow(g: GeomBuffer, i: number, w: Rect): boolean {
  const a = g.offsets[i]
  const e = g.offsets[i + 1]
  const c = g.coords
  const t = g.types[i]
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  if (t === Prim.Circle || t === Prim.Arc || t === Prim.Ellipse) {
    const r = t === Prim.Ellipse ? Math.max(c[a + 2], c[a + 3]) : c[a + 2]
    return intersects({ x0: c[a] - r, y0: c[a + 1] - r, x1: c[a] + r, y1: c[a + 1] + r }, w)
  }
  for (let k = a; k + 1 < e; k += 2) {
    if (c[k] < x0) x0 = c[k]
    if (c[k] > x1) x1 = c[k]
    if (c[k + 1] < y0) y0 = c[k + 1]
    if (c[k + 1] > y1) y1 = c[k + 1]
  }
  return intersects({ x0, y0, x1, y1 }, w)
}
