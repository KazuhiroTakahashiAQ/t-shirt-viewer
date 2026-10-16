// Canvas 2D renderer with pan/zoom. Model space is y-up; the view transform flips y.
// During interaction the last full frame is reused as a transformed bitmap and a full
// redraw follows once the interaction pauses.

import { layoutText } from '../tfs/geometry.ts'
import { intersects, PrimFlag, type ImageItem, type LayerColor, type Rect, type TextItem, type TfsDocument } from '../tfs/model.ts'
import { imageMatrix } from './images.ts'
import type { SceneLayer } from './scene.ts'
import { backgroundColor, dashPattern, fontFamily, layerStroke, linePx, type RenderOptions } from './style.ts'

export interface View {
  /** model coordinate at the canvas center */
  cx: number
  cy: number
  /** CSS pixels per model unit */
  zoom: number
}

export class CanvasRenderer {
  readonly canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private snapshot = document.createElement('canvas')
  private snapView: View | null = null
  private fullTimer = 0
  private frame = 0
  doc: TfsDocument | null = null
  layers: SceneLayer[] = []
  visible: boolean[] = []
  options: RenderOptions
  view: View = { cx: 0, cy: 0, zoom: 1 }
  /** paper outline to draw (defaults to the document paper) */
  paper: Rect | null = null
  onRendered: ((ms: number) => void) | null = null
  /** called whenever the view changes (also during interactive previews) */
  onViewChange: (() => void) | null = null

  constructor(canvas: HTMLCanvasElement, options: RenderOptions) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D を利用できません')
    this.ctx = ctx
    this.options = options
  }

  setScene(doc: TfsDocument, layers: SceneLayer[], visible: boolean[]) {
    this.doc = doc
    this.layers = layers
    this.visible = visible
    this.snapView = null
  }

  get width() {
    return this.canvas.clientWidth
  }

  get height() {
    return this.canvas.clientHeight
  }

  resize() {
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
      this.snapView = null
    }
  }

  /** fit requested while the canvas had no size (hidden): applied once it is laid out */
  private pendingFit: { r: Rect; margin: number } | null = null

  fit(r: Rect, margin = 0.04) {
    if (this.width < 2 || this.height < 2) {
      this.pendingFit = { r, margin }
      return
    }
    this.pendingFit = null
    const w = Math.max(r.x1 - r.x0, 1e-9)
    const h = Math.max(r.y1 - r.y0, 1e-9)
    this.view = {
      cx: (r.x0 + r.x1) / 2,
      cy: (r.y0 + r.y1) / 2,
      zoom: Math.min(this.width / w, this.height / h) * (1 - 2 * margin),
    }
  }

  screenToModel(sx: number, sy: number): [number, number] {
    const v = this.view
    return [v.cx + (sx - this.width / 2) / v.zoom, v.cy - (sy - this.height / 2) / v.zoom]
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const [mx, my] = this.screenToModel(sx, sy)
    const z = Math.min(Math.max(this.view.zoom * factor, 1e-7), 1e4)
    this.view = { zoom: z, cx: mx - (sx - this.width / 2) / z, cy: my + (sy - this.height / 2) / z }
    this.interactive()
  }

  panBy(dx: number, dy: number) {
    this.view = { ...this.view, cx: this.view.cx - dx / this.view.zoom, cy: this.view.cy + dy / this.view.zoom }
    this.interactive()
  }

  /** Cheap preview from the last frame, then a full render shortly after. */
  private interactive() {
    if (this.snapView) this.drawSnapshot()
    this.onViewChange?.()
    clearTimeout(this.fullTimer)
    this.fullTimer = window.setTimeout(() => this.requestRender(), 90)
  }

  requestRender() {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.render())
  }

  private drawSnapshot() {
    const ctx = this.ctx
    const dpr = window.devicePixelRatio || 1
    const s = this.snapView!
    const v = this.view
    const k = v.zoom / s.zoom
    const W = this.width
    const H = this.height
    // screen position of the old view center in the new view
    const px = W / 2 + (s.cx - v.cx) * v.zoom
    const py = H / 2 - (s.cy - v.cy) * v.zoom
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = backgroundColor(this.options)
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (px - (W / 2) * k), dpr * (py - (H / 2) * k))
    ctx.drawImage(this.snapshot, 0, 0, this.snapshot.width / dpr, this.snapshot.height / dpr)
  }

  render() {
    const t0 = performance.now()
    this.resize()
    if (this.pendingFit && this.width >= 2 && this.height >= 2) this.fit(this.pendingFit.r, this.pendingFit.margin)
    const ctx = this.ctx
    const dpr = window.devicePixelRatio || 1
    const o = this.options
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = backgroundColor(o)
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    const doc = this.doc
    if (!doc) return
    const v = this.view
    const W = this.width
    const H = this.height
    const viewRect: Rect = {
      x0: v.cx - W / 2 / v.zoom,
      x1: v.cx + W / 2 / v.zoom,
      y0: v.cy - H / 2 / v.zoom,
      y1: v.cy + H / 2 / v.zoom,
    }
    const z = v.zoom * dpr
    const ex = (x: number) => dpr * (W / 2) + (x - v.cx) * z
    const ey = (y: number) => dpr * (H / 2) - (y - v.cy) * z

    if (o.showSheets) this.drawSheets(doc, ex, ey, dpr)

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const minPx = 0.35 / v.zoom
    for (const layer of this.layers) {
      if (!this.visible[layer.index] || !layer.bbox || !intersects(layer.bbox, viewRect)) continue
      const lc = layer.color ?? doc.layers[layer.index]?.color ?? { mode: 'entity', color: 0 }
      ctx.save()
      if (layer.clip?.length) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.beginPath()
        for (let k = 0; k + 1 < layer.clip.length; k += 2) ctx.lineTo(ex(layer.clip[k]), ey(layer.clip[k + 1]))
        ctx.closePath()
        ctx.clip()
      }
      if (layer.images.length) this.drawImages(layer.images, viewRect, ex, ey, dpr)
      for (const b of layer.batches) {
        if (b.aux && !o.showAux) continue
        if (!intersects(b.bbox, viewRect)) continue
        // skip batches that collapse below a fraction of a pixel
        if (b.bbox.x1 - b.bbox.x0 < minPx && b.bbox.y1 - b.bbox.y0 < minPx) continue
        const st = doc.styles[b.style]
        ctx.setTransform(z, 0, 0, -z, ex(b.ox), ey(b.oy))
        ctx.strokeStyle = b.aux ? auxColor(o) : layerStroke(lc, st.color, o)
        ctx.lineWidth = linePx(st.width, o) / v.zoom
        const dash = dashPattern(doc, st.linetype)
        if (dash && dash.reduce((s, d) => s + d, 0) * v.zoom > 4) ctx.setLineDash(dash)
        else ctx.setLineDash([])
        ctx.stroke(b.path)
        if (b.points.length && o.showAux) {
          ctx.fillStyle = ctx.strokeStyle
          const r = 1.5 / v.zoom
          for (let k = 0; k < b.points.length; k += 2) ctx.fillRect(b.points[k] - r, b.points[k + 1] - r, 2 * r, 2 * r)
        }
      }
      ctx.setLineDash([])
      if (o.showText) this.drawTexts(doc, lc, layer.texts, viewRect, ex, ey, dpr)
      ctx.restore()
    }

    // keep this frame for interactive previews
    this.snapshot.width = this.canvas.width
    this.snapshot.height = this.canvas.height
    this.snapshot.getContext('2d')!.drawImage(this.canvas, 0, 0)
    this.snapView = { ...v }
    this.onRendered?.(performance.now() - t0)
    this.onViewChange?.()
  }

  private bitmaps = new WeakMap<ImageItem, ImageBitmap | 'pending' | 'failed'>()

  private bitmapFor(img: ImageItem): ImageBitmap | null {
    const have = this.bitmaps.get(img)
    if (have instanceof ImageBitmap) return have
    if (have) return null
    this.bitmaps.set(img, 'pending')
    const src = img.bitmap
      ? createImageBitmap(new ImageData(new Uint8ClampedArray(img.bitmap.rgba), img.bitmap.width, img.bitmap.height))
      : img.encoded
        ? createImageBitmap(new Blob([img.encoded.data as BlobPart], { type: img.encoded.mime }))
        : null
    if (!src) {
      this.bitmaps.set(img, 'failed')
      return null
    }
    src.then(
      (bm) => {
        this.bitmaps.set(img, bm)
        this.requestRender()
      },
      () => this.bitmaps.set(img, 'failed'),
    )
    return null
  }

  private drawImages(images: ImageItem[], viewRect: Rect, ex: (x: number) => number, ey: (y: number) => number, dpr: number) {
    const ctx = this.ctx
    for (const img of images) {
      if (!intersects(img.bbox, viewRect)) continue
      const bm = this.bitmapFor(img)
      if (bm) {
        const m = imageMatrix(img, bm.width, bm.height, (x, y) => [ex(x), ey(y)])
        ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(bm, 0, 0)
        // The CAD outlines pictures and OLE objects with a thin gray frame
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.strokeStyle = '#808080'
        ctx.lineWidth = dpr
        ctx.beginPath()
        for (let k = 0; k < 8; k += 2) ctx.lineTo(ex(img.corners[k]), ey(img.corners[k + 1]))
        ctx.closePath()
        ctx.stroke()
        continue
      }
      // objects without displayable data (or images still decoding): framed placeholder
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const r = img.bbox
      ctx.strokeStyle = this.options.background === 'white' ? '#7a8aa0' : '#8090a8'
      ctx.lineWidth = dpr
      ctx.setLineDash([4 * dpr, 3 * dpr])
      ctx.strokeRect(ex(r.x0), ey(r.y1), ex(r.x1) - ex(r.x0), ey(r.y0) - ey(r.y1))
      ctx.setLineDash([])
      if (ex(r.x1) - ex(r.x0) > 170 * dpr && ey(r.y0) - ey(r.y1) > 24 * dpr) {
        ctx.fillStyle = ctx.strokeStyle
        ctx.font = `${11 * dpr}px sans-serif`
        ctx.textBaseline = 'top'
        ctx.fillText(img.kind === 'ole' ? `埋め込みオブジェクト${img.name ? `: ${img.name}` : ''}` : img.name || '画像', ex(r.x0) + 3 * dpr, ey(r.y1) + 3 * dpr)
      }
    }
  }

  private drawSheets(doc: TfsDocument, ex: (x: number) => number, ey: (y: number) => number, dpr: number) {
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // paper outline, drawn like the CAD (yellow)
    const r = this.paper ?? doc.paper
    ctx.strokeStyle = this.options.background === 'white' ? '#b8a000' : '#c8c800'
    ctx.lineWidth = dpr
    ctx.setLineDash([])
    ctx.strokeRect(ex(r.x0), ey(r.y1), ex(r.x1) - ex(r.x0), ey(r.y0) - ey(r.y1))
  }

  private drawTexts(doc: TfsDocument, lc: LayerColor, texts: TextItem[], viewRect: Rect, ex: (x: number) => number, ey: (y: number) => number, dpr: number) {
    const ctx = this.ctx
    const z = this.view.zoom * dpr
    ctx.textBaseline = 'ideographic'
    ctx.textAlign = 'left'
    for (const t of texts) {
      if (!intersects(t.bbox, viewRect)) continue
      if (t.flags & PrimFlag.Aux && !this.options.showAux) continue
      const px = t.height * z
      if (px < 1.2 * dpr) continue
      const st = doc.styles[t.style]
      ctx.fillStyle = layerStroke(lc, st.color, this.options)
      ctx.font = `${px}px ${fontFamily(t.font)}`
      const a = (t.angle * Math.PI) / 180
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const kx = t.width / t.height
      const sx = ex(t.x)
      const sy = ey(t.y)
      for (const ln of layoutText(t)) {
        for (let i = 0; i < ln.chars.length; i++) {
          const ch = ln.chars[i]
          if (ch === ' ' || ch === '　') continue
          // local (u along text, w up) -> screen
          const u = ln.xs[i] * z
          const w = ln.y * z
          const ox = sx + u * ca - w * sa
          const oy = sy - (u * sa + w * ca)
          // glyphs are designed for a 1em box; half-width glyphs use half the cell
          ctx.setTransform(ca * kx, -sa * kx, sa, ca, ox, oy)
          ctx.fillText(ch, 0, 0)
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }
}

function auxColor(o: RenderOptions): string {
  return o.background === 'white' ? '#c08040' : '#d0a060'
}
