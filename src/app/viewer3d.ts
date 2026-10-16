// 3D, elevation and section views of a drawing. Several panes (3D / 正面 / 背面 / 右側面 /
// 左側面) share one WebGL scene; a section range picked on the plan clips the elevation
// panes into sections (クイック断面) and optionally the 3D pane.

import { cameraFrame, distanceForUnitsPerPixel, Gl3d, unitsPerPixel, type Camera, type DrawState, type Plane, type SceneBuffers, type SceneGroup, type V3 } from '../render/gl3d.ts'
import { tfsRgb } from '../render/style.ts'
import { primSegments } from '../tfs/geometry.ts'
import { PrimFlag, type TfsDocument } from '../tfs/model.ts'
import type { Model3D, Object3D } from '../tfs/model3d.ts'
import { PANE_TIPS } from './help.ts'

export type PaneKind = '3d' | 'front' | 'back' | 'right' | 'left'
export const PANE_NAMES: Record<PaneKind, string> = { '3d': '3D', front: '正面', back: '背面', right: '右側面', left: '左側面' }

/** Section range on the plan: o + s·u + t·v with s in [0, lu], t in [0, lv]; u, v unit vectors. */
export interface SectionBox {
  o: [number, number]
  u: [number, number]
  v: [number, number]
  lu: number
  lv: number
}

export interface Options3D {
  translucentMembers: boolean
  showPlan: boolean
  /** apply シート基準高さ (階あり) */
  useElevation: boolean
  /** clip the 3D pane to the section range too */
  clip3d: boolean
  /** parts in the shape estimated from their views (5 面図) instead of their outline box */
  partViews: boolean
  background: 'white' | 'black'
}

export type ViewPreset = 'iso-se' | 'iso-sw' | 'iso-ne' | 'iso-nw' | 'top' | 'front' | 'back' | 'right' | 'left'
export const VIEW_PRESETS: [ViewPreset, string][] = [
  ['iso-se', '等角 (右手前から)'],
  ['iso-sw', '等角 (左手前から)'],
  ['iso-ne', '等角 (右奥から)'],
  ['iso-nw', '等角 (左奥から)'],
  ['top', '平面 (上から)'],
  ['front', '正面 (手前から)'],
  ['back', '背面 (奥から)'],
  ['right', '右側面 (右から)'],
  ['left', '左側面 (左から)'],
]

const DEG = Math.PI / 180

/** viewpoint of a new 3D window: from above, oriented like the plan */
const INITIAL_PRESET: ViewPreset = 'top'
const PRESET_YAW: Record<ViewPreset, number> = { 'iso-se': -45, 'iso-sw': -135, 'iso-ne': 45, 'iso-nw': 135, top: -90, front: -90, back: 90, right: 0, left: 180 }

function presetAngles(cam: Camera, preset: ViewPreset) {
  cam.yaw = PRESET_YAW[preset] * DEG
  cam.pitch = preset.startsWith('iso') ? 30 * DEG : preset === 'top' ? 89.99 * DEG : 0
}

interface Built {
  buffers: SceneBuffers
  /** per object: first / count of its triangles and lines in the buffers (-1 = none) */
  objTri: Int32Array
  objLine: Int32Array
  /** per scene group: bounds without elevation */
  bounds: { sheet: number; min: V3; max: V3 }[]
}

export class Pane {
  readonly el = document.createElement('div')
  readonly head = document.createElement('div')
  readonly canvas = document.createElement('canvas')
  readonly overlay = document.createElement('canvas')
  readonly kindSelect = document.createElement('select')
  readonly title = document.createElement('span')
  readonly tools = document.createElement('div')
  cam: Camera = { target: [0, 0, 0], distance: 10000, yaw: -45 * DEG, pitch: 30 * DEG, perspective: true }
  kind: PaneKind
  /** projection chosen for the 3D kind */
  perspective3d = true
  fitted = false
  /** the user moved the view since the last fit (no automatic refit on resize) */
  moved = false
  /**
   * 2D linking (ずれ調整): where this window's center sits relative to the plan's center
   * (plan units), and its scale relative to the plan's. An oblique 3D view shows a
   * different area than the plan around the same point; the user can shift it.
   */
  linkOffset: [number, number] = [0, 0]
  linkScale = 1
  /** moving this window changes its offset instead of moving the plan */
  adjustLink = false
  dirty = false
  width = 0
  height = 0

  constructor(kind: PaneKind) {
    this.kind = kind
    this.el.className = 'pane pane-3d'
    this.head.className = 'pane-head'
    const body = document.createElement('div')
    body.className = 'pane-body'
    this.canvas.className = 'pane-canvas'
    this.overlay.className = 'pane-overlay'
    body.append(this.canvas, this.overlay)
    for (const [k, name] of Object.entries(PANE_NAMES)) this.kindSelect.add(new Option(name, k))
    this.kindSelect.value = kind
    this.kindSelect.title = PANE_TIPS.kind
    this.title.className = 'pane-title'
    this.title.title = PANE_TIPS.title
    this.tools.className = 'pane-tools'
    this.head.append(this.kindSelect, this.title, this.tools)
    this.el.append(this.head, body)
  }
}

const hexRgb = (n: number): [number, number, number] => [(n >> 16) & 255, (n >> 8) & 255, n & 255]

function color3d(n: number, bg: 'white' | 'black'): [number, number, number] {
  const rgb = tfsRgb(n)
  if (rgb === null) return bg === 'white' ? [120, 124, 130] : [200, 200, 200]
  const [r, g, b] = hexRgb(rgb)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  if (bg === 'white' && lum > 0.85) return [168, 173, 179]
  if (bg === 'black' && lum < 0.12) return [138, 138, 138]
  return [r, g, b]
}

function highlightColor(bg: 'white' | 'black'): [number, number, number] {
  return bg === 'white' ? [255, 120, 0] : [0, 220, 255]
}

/** Sheets shown in 3D: model sheets that are not layout sheets or external references. */
export function sheets3d(doc: TfsDocument): number[] {
  return doc.layers.filter((l) => !l.layout && !l.xref).map((l) => l.index)
}

/**
 * Scene buffers for the visible sheets; objects and plan lines on hidden レイヤ are left out.
 * `alt`: objects in their alternative shape (parts estimated from their views).
 */
function buildScene(model: Model3D, doc: TfsDocument, bg: 'white' | 'black', hidden: Set<number>, alt: boolean): Built {
  const shape = (o: Object3D) => (alt && o.alt ? o.alt : o)
  const include = new Set(sheets3d(doc))
  // origin: the model's, or the plan's center when there are no 3D objects
  let origin: V3 = model.origin
  if (!model.objects.length) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const i of include) {
      const b = doc.layers[i].bbox
      if (!b) continue
      x0 = Math.min(x0, b.x0)
      y0 = Math.min(y0, b.y0)
      x1 = Math.max(x1, b.x1)
      y1 = Math.max(y1, b.y1)
    }
    origin = x1 >= x0 ? [(x0 + x1) / 2, (y0 + y1) / 2, 0] : [0, 0, 0]
  }
  const dz = origin[2] - model.origin[2]
  const dx = origin[0] - model.origin[0]
  const dy = origin[1] - model.origin[1]
  // count vertices
  let triN = 0
  let lineN = 0
  for (const o of model.objects) {
    if (!include.has(o.sheet) || hidden.has(o.attr)) continue
    triN += shape(o).tri[1]
    lineN += shape(o).line[1]
  }
  const planSegs: number[][] = []
  const with3d = new Map<number, Set<number>>()
  for (const o of model.objects) {
    let s = with3d.get(o.sheet)
    if (!s) with3d.set(o.sheet, (s = new Set()))
    s.add(o.entity)
  }
  for (const i of include) {
    const g = doc.layers[i].geom
    const skip = with3d.get(i)
    const segs: number[] = []
    for (let k = 0; k < g.count; k++) {
      if (g.flags[k] & (PrimFlag.Aux | PrimFlag.Hidden)) continue
      if (skip?.has(g.entity[k]) || hidden.has(g.attr[k])) continue
      const style = g.styles[k]
      primSegments(g, k, (ax, ay, bx, by) => segs.push(ax, ay, bx, by, style))
    }
    planSegs[i] = segs
    lineN += (segs.length / 5) * 2
  }
  const triPos = new Float32Array(triN * 3)
  const triNormal = new Int8Array(triN * 4)
  const triColor = new Uint8Array(triN * 4)
  const triId = new Uint8Array(triN * 4)
  const linePos = new Float32Array(lineN * 3)
  const lineColor = new Uint8Array(lineN * 4)
  const lineId = new Uint8Array(lineN * 4)
  const objTri = new Int32Array(model.objects.length * 2).fill(-1)
  const objLine = new Int32Array(model.objects.length * 2).fill(-1)
  let tn = 0
  let ln = 0
  const groups: SceneGroup[] = []
  const bounds: Built['bounds'] = []
  const copy = (oi: number, src: Float32Array, range: [number, number], pos: Float32Array, col: Uint8Array, ids: Uint8Array, at: number, rgb: [number, number, number]) => {
    const id = oi + 1
    for (let v = 0; v < range[1]; v++) {
      const s = (range[0] + v) * 3
      const d = (at + v) * 3
      pos[d] = src[s] - dx
      pos[d + 1] = src[s + 1] - dy
      pos[d + 2] = src[s + 2] - dz
      const c = (at + v) * 4
      col[c] = rgb[0]
      col[c + 1] = rgb[1]
      col[c + 2] = rgb[2]
      col[c + 3] = 255
      ids[c] = id & 255
      ids[c + 1] = (id >> 8) & 255
      ids[c + 2] = (id >> 16) & 255
      ids[c + 3] = 255
    }
  }
  const bgRgb: [number, number, number] = bg === 'white' ? [255, 255, 255] : [0, 0, 0]
  for (const s of model.sheets) {
    if (!include.has(s.index)) continue
    const min: V3 = [Infinity, Infinity, Infinity]
    const max: V3 = [-Infinity, -Infinity, -Infinity]
    const grow = (p: V3) => {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k])
        max[k] = Math.max(max[k], p[k])
      }
    }
    const g: SceneGroup = { sheet: s.index, elevation: s.elevation, opaque: [tn, 0], members: [0, 0], lines: [0, 0], plan: [0, 0] }
    const objs = model.objects.slice(s.objects[0], s.objects[1])
    const place = (filter: (o: Object3D) => boolean) => {
      objs.forEach((o, k) => {
        const r = shape(o).tri
        if (!filter(o) || !r[1] || hidden.has(o.attr)) return
        const oi = s.objects[0] + k
        objTri[oi * 2] = tn
        objTri[oi * 2 + 1] = r[1]
        copy(oi, model.tri, r, triPos, triColor, triId, tn, color3d(o.color, bg))
        triNormal.set(model.triNormal.subarray(r[0] * 4, (r[0] + r[1]) * 4), tn * 4)
        tn += r[1]
        grow(o.min)
        grow(o.max)
      })
    }
    const arch = (o: Object3D) => o.category === 'member' || o.category === 'face'
    place((o) => !arch(o))
    g.opaque[1] = tn - g.opaque[0]
    g.members[0] = tn
    place(arch)
    g.members[1] = tn - g.members[0]
    g.lines[0] = ln
    objs.forEach((o, k) => {
      const r = shape(o).line
      if (!r[1] || hidden.has(o.attr)) return
      const oi = s.objects[0] + k
      objLine[oi * 2] = ln
      objLine[oi * 2 + 1] = r[1]
      // edges of faces a little darker than the faces
      const c = color3d(o.color, bg)
      const edge: [number, number, number] = o.category === 'face' ? [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55] : c
      copy(oi, model.line, r, linePos, lineColor, lineId, ln, edge)
      ln += r[1]
      grow(o.min)
      grow(o.max)
    })
    g.lines[1] = ln - g.lines[0]
    g.plan[0] = ln
    const segs = planSegs[s.index] ?? []
    const styles = doc.styles
    for (let k = 0; k < segs.length; k += 5) {
      const st = styles[segs[k + 4]]
      const c = color3d(st?.color ?? 0, bg)
      const mix = (j: number) => Math.round(c[j] * 0.45 + bgRgb[j] * 0.55)
      for (const [x, y] of [
        [segs[k], segs[k + 1]],
        [segs[k + 2], segs[k + 3]],
      ]) {
        const d = ln * 3
        linePos[d] = x - origin[0]
        linePos[d + 1] = y - origin[1]
        linePos[d + 2] = -origin[2]
        const cc = ln * 4
        lineColor[cc] = mix(0)
        lineColor[cc + 1] = mix(1)
        lineColor[cc + 2] = mix(2)
        lineColor[cc + 3] = 255
        ln++
      }
    }
    g.plan[1] = ln - g.plan[0]
    const pb = doc.layers[s.index].bbox
    if (pb) {
      grow([pb.x0, pb.y0, 0])
      grow([pb.x1, pb.y1, 0])
    }
    groups.push(g)
    if (min[0] <= max[0]) bounds.push({ sheet: s.index, min, max })
  }
  return { buffers: { origin, triPos, triNormal, triColor, triId, linePos, lineColor, lineId, groups }, objTri, objLine, bounds }
}

export interface Viewer3DEvents {
  /** an object was clicked (null: empty space) */
  select?: (index: number | null, obj: Object3D | null) => void
  /** the user moved or zoomed a pane (for 2D linking): plan coordinates of its center and world units per CSS pixel */
  link?: (x: number, y: number, upp: number, source: Pane) => void
  /** right click without dragging; `hit` is the object under the cursor */
  menu?: (pane: Pane, clientX: number, clientY: number, hit: number | null) => void
  status?: (text: string) => void
  /** operating hint for the pane under the cursor (null: pointer left) */
  hint?: (text: string | null) => void
  /** a pane got the user's attention (pointer down) */
  activate?: (pane: Pane) => void
  /** a pane's kind was changed from its header */
  kindChange?: (pane: Pane) => void
  /** a pane's 2D linking offset changed (ずれ調整) */
  offsetChange?: (pane: Pane) => void
}

export class Viewer3D {
  readonly engine: Gl3d
  model: Model3D | null = null
  doc: TfsDocument | null = null
  private built: Built | null = null
  panes: Pane[] = []
  options: Options3D = { translucentMembers: false, showPlan: true, useElevation: true, clip3d: false, partViews: false, background: 'black' }
  /** per document layer */
  visible: boolean[] = []
  section: SectionBox | null = null
  /** hidden レイヤ (図形属性 ids) */
  hiddenLayers = new Set<number>()
  /** note shown in every pane instead of the scene state (e.g. while the 3D data is built) */
  message: string | null = null
  /** highlighted object indices */
  private selected: number[] = []
  events: Viewer3DEvents = {}
  private raf = 0
  private observer = new ResizeObserver((entries) => {
    for (const e of entries) {
      const p = this.panes.find((x) => x.el === e.target)
      if (p) this.resizePane(p)
    }
  })

  constructor() {
    this.engine = new Gl3d()
  }

  // --- data ----------------------------------------------------------------

  setData(model: Model3D | null, doc: TfsDocument | null) {
    // offsets belong to the drawing they were adjusted on
    if (doc !== this.doc) for (const p of this.panes) this.resetLinkOffset(p)
    this.model = model
    this.doc = doc
    this.selected = []
    this.built = null
    if (model && doc) {
      this.built = buildScene(model, doc, this.options.background, this.hiddenLayers, this.options.partViews)
      this.engine.setScene(this.built.buffers)
    } else this.engine.dispose()
    for (const p of this.panes) p.fitted = false
    for (const p of this.panes) this.resizePane(p)
    this.renderAll()
  }

  get hasObjects() {
    return !!this.model?.objects.length
  }

  setVisibility(visible: boolean[]) {
    this.visible = visible.slice()
    this.renderAll()
  }

  /** Hide the objects and plan lines of these レイヤ. */
  setHiddenLayers(ids: Iterable<number>) {
    this.hiddenLayers = new Set(ids)
    if (!this.model || !this.doc) return
    const sel = this.selected
    this.built = buildScene(this.model, this.doc, this.options.background, this.hiddenLayers, this.options.partViews)
    this.engine.setScene(this.built.buffers)
    this.selected = []
    this.applyHighlight(sel)
    this.renderAll()
  }

  setOptions(o: Partial<Options3D>) {
    const bgChanged = o.background !== undefined && o.background !== this.options.background
    const shapeChanged = o.partViews !== undefined && o.partViews !== this.options.partViews
    const elevChanged = o.useElevation !== undefined && o.useElevation !== this.options.useElevation
    Object.assign(this.options, o)
    if ((bgChanged || shapeChanged) && this.model && this.doc) {
      const sel = this.selected
      this.built = buildScene(this.model, this.doc, this.options.background, this.hiddenLayers, this.options.partViews)
      this.engine.setScene(this.built.buffers)
      this.selected = []
      this.applyHighlight(sel)
    }
    if (elevChanged) for (const p of this.panes) this.fitPane(p)
    this.updateTitles()
    this.renderAll()
  }

  setSection(box: SectionBox | null) {
    this.section = box
    for (const p of this.panes) if (p.kind !== '3d') this.orientPane(p, true)
    this.updateTitles()
    this.renderAll()
  }

  // --- panes ---------------------------------------------------------------

  createPane(kind: PaneKind): Pane {
    const p = new Pane(kind)
    this.panes.push(p)
    this.orientPane(p, false)
    this.attach(p)
    this.observer.observe(p.el)
    p.kindSelect.addEventListener('change', () => {
      p.kind = p.kindSelect.value as PaneKind
      this.orientPane(p, true)
      this.updateTitles()
      this.events.kindChange?.(p)
      this.render(p)
    })
    this.updateTitles()
    return p
  }

  removePane(p: Pane) {
    this.observer.unobserve(p.el)
    this.panes = this.panes.filter((x) => x !== p)
    p.el.remove()
  }

  setKind(p: Pane, kind: PaneKind) {
    p.kind = kind
    p.kindSelect.value = kind
    this.orientPane(p, true)
    this.updateTitles()
    this.render(p)
  }

  private updateTitles() {
    for (const p of this.panes) {
      if (p.kind === '3d') p.title.textContent = this.section && this.options.clip3d ? '断面範囲' : ''
      else p.title.textContent = this.section ? '断面' : '立面'
    }
  }

  /** Section axes: the section range's, or the plan axes. */
  private axes() {
    const s = this.section
    return s ? { u: s.u, v: s.v } : { u: [1, 0] as [number, number], v: [0, 1] as [number, number] }
  }

  /** Point an elevation / section pane in its direction. */
  private orientPane(p: Pane, fit: boolean) {
    if (p.kind === '3d') {
      p.cam.perspective = p.perspective3d
      if (fit) this.setPreset(p, INITIAL_PRESET)
      else presetAngles(p.cam, INITIAL_PRESET)
      return
    }
    const { u, v } = this.axes()
    // direction of the eye seen from the target
    const dir: [number, number] = p.kind === 'front' ? [-v[0], -v[1]] : p.kind === 'back' ? [v[0], v[1]] : p.kind === 'right' ? [u[0], u[1]] : [-u[0], -u[1]]
    p.cam.yaw = Math.atan2(dir[1], dir[0])
    p.cam.pitch = 0
    p.cam.perspective = false
    if (fit) this.fitPane(p)
  }

  setPreset(p: Pane, preset: ViewPreset) {
    presetAngles(p.cam, preset)
    this.fitPane(p)
  }

  private clipPlanes(p: Pane): Plane[] {
    const s = this.section
    if (!s || (p.kind === '3d' && !this.options.clip3d)) return []
    const [ox, oy] = s.o
    const uo = s.u[0] * ox + s.u[1] * oy
    const vo = s.v[0] * ox + s.v[1] * oy
    return [
      [s.u[0], s.u[1], 0, -uo],
      [-s.u[0], -s.u[1], 0, uo + s.lu],
      [s.v[0], s.v[1], 0, -vo],
      [-s.v[0], -s.v[1], 0, vo + s.lv],
    ]
  }

  private drawState(p: Pane): DrawState {
    const include = new Set(this.doc ? sheets3d(this.doc) : [])
    return {
      background: this.options.background === 'white' ? [255, 255, 255] : [0, 0, 0],
      visible: (i) => include.has(i) && this.visible[i] !== false,
      translucentMembers: this.options.translucentMembers,
      showPlan: this.options.showPlan,
      useElevation: this.options.useElevation,
      clip: this.clipPlanes(p),
    }
  }

  /**
   * Corner points of the visible content (elevations applied), clipped to the section.
   * Uses the 1–99 % range of the 3D objects so that stray far-away objects do not shrink
   * the view; the plan extents when there are no 3D objects.
   */
  private contentPoints(p: Pane): V3[] {
    if (!this.built || !this.model) return []
    const st = this.drawState(p)
    const elev = (sheet: number) => (this.options.useElevation ? (this.model!.sheets[sheet]?.elevation ?? 0) : 0)
    const lo: number[][] = [[], [], []]
    const hi: number[][] = [[], [], []]
    for (const o of this.model.objects) {
      if (!st.visible(o.sheet) || this.hiddenLayers.has(o.attr)) continue
      const e = elev(o.sheet)
      for (let k = 0; k < 3; k++) {
        lo[k].push(o.min[k] + (k === 2 ? e : 0))
        hi[k].push(o.max[k] + (k === 2 ? e : 0))
      }
    }
    let min: V3 = [Infinity, Infinity, Infinity]
    let max: V3 = [-Infinity, -Infinity, -Infinity]
    if (lo[0].length) {
      const q = (a: number[], f: number) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * f)))]
      const f = lo[0].length >= 50 ? 0.01 : 0
      min = [q(lo[0], f), q(lo[1], f), q(lo[2], f)]
      max = [q(hi[0], 1 - f), q(hi[1], 1 - f), q(hi[2], 1 - f)]
    } else {
      for (const b of this.built.bounds) {
        if (!st.visible(b.sheet)) continue
        const e = this.options.useElevation ? (this.built.buffers.groups.find((g) => g.sheet === b.sheet)?.elevation ?? 0) : 0
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], b.min[k] + (k === 2 ? e : 0))
          max[k] = Math.max(max[k], b.max[k] + (k === 2 ? e : 0))
        }
      }
    }
    if (!(min[0] <= max[0])) return []
    const s = this.section
    if (s && (p.kind !== '3d' || this.options.clip3d)) {
      const pts: V3[] = []
      for (const [a, b] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const x = s.o[0] + s.u[0] * s.lu * a + s.v[0] * s.lv * b
        const y = s.o[1] + s.u[1] * s.lu * a + s.v[1] * s.lv * b
        pts.push([x, y, min[2]], [x, y, max[2]])
      }
      return pts
    }
    const pts: V3[] = []
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) pts.push([x, y, z])
    return pts
  }

  fitPane(p: Pane) {
    const pts = this.contentPoints(p)
    if (!pts.length) return
    const f = cameraFrame(p.cam)
    const proj = (q: V3, c: V3) => {
      const d: V3 = [q[0] - c[0], q[1] - c[1], q[2] - c[2]]
      return [d[0] * f.right[0] + d[1] * f.right[1] + d[2] * f.right[2], d[0] * f.up[0] + d[1] * f.up[1] + d[2] * f.up[2], d[0] * f.dir[0] + d[1] * f.dir[1] + d[2] * f.dir[2]]
    }
    // center: middle of the projected extents
    const c0: V3 = [0, 0, 0]
    for (const q of pts) for (let k = 0; k < 3; k++) c0[k] += q[k] / pts.length
    let r0 = Infinity
    let r1 = -Infinity
    let u0 = Infinity
    let u1 = -Infinity
    for (const q of pts) {
      const [r, u] = proj(q, c0)
      r0 = Math.min(r0, r)
      r1 = Math.max(r1, r)
      u0 = Math.min(u0, u)
      u1 = Math.max(u1, u)
    }
    const rc = (r0 + r1) / 2
    const uc = (u0 + u1) / 2
    const c: V3 = [c0[0] + f.right[0] * rc + f.up[0] * uc, c0[1] + f.right[1] * rc + f.up[1] * uc, c0[2] + f.right[2] * rc + f.up[2] * uc]
    const aspect = p.width && p.height ? p.width / p.height : 1.5
    const tanH = Math.tan((40 * DEG) / 2)
    const margin = 1.08
    let dist = 0
    for (const q of pts) {
      const [x, y, z] = proj(q, c)
      // parallel: half height must cover |y| and |x| / aspect; perspective: also the depth
      const need = Math.max(Math.abs(x) / (tanH * aspect), Math.abs(y) / tanH) * margin
      dist = Math.max(dist, p.cam.perspective ? z + need : need)
    }
    p.cam.target = c
    p.cam.distance = Math.max(dist, 100)
    p.fitted = true
    p.moved = false
    this.render(p)
  }

  fitAll() {
    for (const p of this.panes) this.fitPane(p)
  }

  private resizePane(p: Pane) {
    const r = p.el.querySelector('.pane-body')!.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    p.width = r.width
    p.height = r.height
    for (const c of [p.canvas, p.overlay]) {
      const w = Math.max(1, Math.round(r.width * dpr))
      const h = Math.max(1, Math.round(r.height * dpr))
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
    }
    if ((!p.fitted || !p.moved) && r.width > 2 && r.height > 2 && this.built) this.fitPane(p)
    this.render(p)
  }

  // --- rendering -----------------------------------------------------------

  render(p: Pane) {
    p.dirty = true
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush())
  }

  renderAll() {
    for (const p of this.panes) this.render(p)
  }

  private flush() {
    this.raf = 0
    for (const p of this.panes) {
      if (!p.dirty) continue
      p.dirty = false
      if (!p.width || !p.height || !p.el.isConnected) continue
      this.engine.render(p.cam, p.canvas, this.drawState(p))
      this.drawOverlay(p)
    }
  }

  private floors(): { name: string; z: number }[] {
    if (!this.model || !this.doc || !this.options.useElevation) return []
    const st = new Set(sheets3d(this.doc))
    const seen = new Map<string, number>()
    for (const s of this.model.sheets) {
      if (!st.has(s.index) || s.floor === null || this.visible[s.index] === false) continue
      const key = `${s.floor}@${s.elevation}`
      if (!seen.has(key)) seen.set(key, s.elevation)
    }
    return [...seen].map(([k, z]) => ({ name: k.split('@')[0], z })).sort((a, b) => a.z - b.z)
  }

  private drawOverlay(p: Pane) {
    const ctx = p.overlay.getContext('2d')!
    const dpr = p.overlay.width / Math.max(p.width, 1)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, p.overlay.width, p.overlay.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const fg = this.options.background === 'white' ? '#1a4f8a' : '#7fc4ff'
    if (p.kind !== '3d') {
      // floor levels (階あり)
      const f = cameraFrame(p.cam)
      const upp = unitsPerPixel(p.cam, p.height)
      ctx.font = '11px system-ui, sans-serif'
      for (const fl of this.floors()) {
        const y = p.height / 2 - (fl.z - p.cam.target[2]) * f.up[2] / upp
        if (y < -20 || y > p.height + 20) continue
        ctx.strokeStyle = fg
        ctx.setLineDash([6, 4])
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(0, Math.round(y) + 0.5)
        ctx.lineTo(p.width, Math.round(y) + 0.5)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = fg
        // label on a backing so it stays readable over the building
        const label = `${fl.name}(${Math.round(fl.z)})`
        const lw = ctx.measureText(label).width
        ctx.fillStyle = this.options.background === 'white' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)'
        ctx.fillRect(3, y - 17, lw + 6, 15)
        ctx.fillStyle = fg
        ctx.fillText(label, 6, y - 5)
      }
    } else {
      // axis gizmo
      const f = cameraFrame(p.cam)
      const o = [40, p.height - 40]
      const axes: [V3, string, string][] = [
        [[1, 0, 0], 'X', '#e05252'],
        [[0, 1, 0], 'Y', '#3fb950'],
        [[0, 0, 1], 'Z', '#4f8fe8'],
      ]
      ctx.lineWidth = 2
      ctx.font = 'bold 11px system-ui, sans-serif'
      for (const [a, label, col] of axes) {
        const x = a[0] * f.right[0] + a[1] * f.right[1] + a[2] * f.right[2]
        const y = a[0] * f.up[0] + a[1] * f.up[1] + a[2] * f.up[2]
        ctx.strokeStyle = col
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.moveTo(o[0], o[1])
        ctx.lineTo(o[0] + x * 24, o[1] - y * 24)
        ctx.stroke()
        ctx.fillText(label, o[0] + x * 30 - 4, o[1] - y * 30 + 4)
      }
    }
    const msg = this.message ?? (this.model && !this.hasObjects ? 'この図面には 3D 情報 (配管・ダクト・建築部材・機器) がありません' : null)
    if (msg) {
      ctx.font = '12px system-ui, sans-serif'
      const w = Math.min(ctx.measureText(msg).width, p.width - 20)
      ctx.fillStyle = this.options.background === 'white' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)'
      ctx.fillRect(6, 6, w + 8, 20)
      ctx.fillStyle = fg
      ctx.fillText(msg, 10, 20, p.width - 20)
    }
  }

  // --- selection -----------------------------------------------------------

  /** Highlight all objects of an entity (null clears). */
  highlightEntity(sheet: number | null, entity = 0) {
    const sel: number[] = []
    if (this.model && sheet !== null) this.model.objects.forEach((o, i) => o.sheet === sheet && o.entity === entity && sel.push(i))
    this.applyHighlight(sel)
    this.renderAll()
  }

  /** Bring an entity's 3D objects into view in every window. */
  focusEntity(sheet: number, entity: number) {
    if (!this.model) return
    const min: V3 = [Infinity, Infinity, Infinity]
    const max: V3 = [-Infinity, -Infinity, -Infinity]
    this.model.objects.forEach((o, i) => {
      if (o.sheet !== sheet || o.entity !== entity) return
      const c = this.objectCenter(i)!
      for (let k = 0; k < 3; k++) {
        const h = (o.max[k] - o.min[k]) / 2
        min[k] = Math.min(min[k], c[k] - h)
        max[k] = Math.max(max[k], c[k] + h)
      }
    })
    if (!(min[0] <= max[0])) return
    const c: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
    const r = Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 300)
    for (const p of this.panes) {
      p.cam.target = c
      p.cam.distance = (r * 3) / Math.tan(20 * DEG) / (p.cam.perspective ? 1 : 2)
      p.moved = true
      this.render(p)
    }
  }

  private applyHighlight(sel: number[]) {
    const b = this.built
    if (!b || !this.model) return
    const set = (i: number, on: boolean) => {
      const c = on ? highlightColor(this.options.background) : null
      for (const [kind, arr, src] of [
        ['tri', b.objTri, b.buffers.triColor],
        ['line', b.objLine, b.buffers.lineColor],
      ] as const) {
        const first = arr[i * 2]
        const count = arr[i * 2 + 1]
        if (first < 0 || count <= 0) continue
        let data = src.subarray(first * 4, (first + count) * 4)
        if (c) {
          data = new Uint8Array(count * 4)
          for (let k = 0; k < count; k++) data.set([c[0], c[1], c[2], 255], k * 4)
        }
        this.engine.updateColors(kind, first, data)
      }
    }
    for (const i of this.selected) set(i, false)
    this.selected = sel
    for (const i of sel) set(i, true)
  }

  // --- interaction ---------------------------------------------------------

  /**
   * 2D linking: put plan point `center` in the middle of the panes (elevations and
   * sections only move sideways) and/or show `upp` world units per CSS pixel, the scale
   * of the plan. `except` is the pane the change came from.
   */
  setLinkedView(center: [number, number] | null, upp: number | null, except?: Pane) {
    if (center) this.linked.center = center
    if (upp) this.linked.upp = upp
    for (const p of this.panes) if (p !== except) this.applyLink(p, center, upp)
  }

  private applyLink(p: Pane, center: [number, number] | null, upp: number | null) {
    if (center) {
      const x = center[0] + p.linkOffset[0]
      const y = center[1] + p.linkOffset[1]
      const t = p.cam.target
      if (p.kind === '3d') p.cam.target = [x, y, t[2]]
      else {
        const f = cameraFrame(p.cam)
        const d = (x - t[0]) * f.right[0] + (y - t[1]) * f.right[1]
        p.cam.target = [t[0] + f.right[0] * d, t[1] + f.right[1] * d, t[2]]
      }
    }
    if (upp && p.height > 0) p.cam.distance = Math.min(Math.max(distanceForUnitsPerPixel(upp * p.linkScale, p.height), 10), 5e7)
    p.moved = true
    this.render(p)
  }

  /** plan center and scale the windows were last linked to */
  private linked: { center: [number, number] | null; upp: number | null } = { center: null, upp: null }

  /**
   * Report a window's view for 2D linking (plan coordinates of its center, without its
   * offset). While the window is being adjusted (ずれ調整) its view becomes its offset
   * from the plan instead, and the plan stays put.
   */
  emitLink(p: Pane) {
    if (!(p.height > 0)) return
    const upp = unitsPerPixel(p.cam, p.height)
    const t = p.cam.target
    if (p.adjustLink) {
      const c = this.linked.center
      if (c) p.linkOffset = [t[0] - c[0], t[1] - c[1]]
      if (this.linked.upp) p.linkScale = upp / this.linked.upp
      this.events.offsetChange?.(p)
      return
    }
    this.events.link?.(t[0] - p.linkOffset[0], t[1] - p.linkOffset[1], upp / p.linkScale, p)
  }

  hasLinkOffset(p: Pane): boolean {
    return Math.hypot(p.linkOffset[0], p.linkOffset[1]) > 1e-6 || Math.abs(p.linkScale - 1) > 1e-6
  }

  /** Remove a window's offset (it shows the plan's center and scale again). */
  resetLinkOffset(p: Pane) {
    p.linkOffset = [0, 0]
    p.linkScale = 1
    p.adjustLink = false
    if (this.linked.center || this.linked.upp) this.applyLink(p, this.linked.center, this.linked.upp)
    this.events.offsetChange?.(p)
  }

  /** Scene point on the target plane under a pane pixel (CSS px). */
  pointAt(p: Pane, sx: number, sy: number): V3 {
    const f = cameraFrame(p.cam)
    const upp = unitsPerPixel(p.cam, p.height)
    const dx = (sx - p.width / 2) * upp
    const dy = (p.height / 2 - sy) * upp
    const t = p.cam.target
    return [t[0] + f.right[0] * dx + f.up[0] * dy, t[1] + f.right[1] * dx + f.up[1] * dy, t[2] + f.right[2] * dx + f.up[2] * dy]
  }

  zoomAt(p: Pane, sx: number, sy: number, factor: number) {
    const q = this.pointAt(p, sx, sy)
    const t = p.cam.target
    const before = p.cam.distance
    p.cam.distance = Math.min(Math.max(before * factor, 10), 5e7)
    // at the zoom limits the applied factor is smaller: keep the point under the cursor fixed
    const k = p.cam.distance / before
    p.cam.target = [q[0] + (t[0] - q[0]) * k, q[1] + (t[1] - q[1]) * k, q[2] + (t[2] - q[2]) * k]
    p.moved = true
    this.render(p)
    this.emitLink(p)
  }

  pan(p: Pane, dx: number, dy: number) {
    const f = cameraFrame(p.cam)
    const upp = unitsPerPixel(p.cam, p.height)
    const t = p.cam.target
    p.cam.target = [t[0] - (f.right[0] * dx - f.up[0] * dy) * upp, t[1] - (f.right[1] * dx - f.up[1] * dy) * upp, t[2] - (f.right[2] * dx - f.up[2] * dy) * upp]
    p.moved = true
    this.render(p)
    this.emitLink(p)
  }

  orbit(p: Pane, dx: number, dy: number) {
    p.cam.yaw -= dx * 0.008
    p.cam.pitch = Math.min(Math.max(p.cam.pitch + dy * 0.008, -89.99 * DEG), 89.99 * DEG)
    p.moved = true
    this.render(p)
  }

  pick(p: Pane, sx: number, sy: number): number {
    const dpr = p.canvas.width / Math.max(p.width, 1)
    return this.engine.pick(p.cam, p.canvas.width, p.canvas.height, sx * dpr, sy * dpr, this.drawState(p), Math.round(4 * dpr))
  }

  /** Center (scene coordinates, elevation applied) of an object. */
  objectCenter(i: number): V3 | null {
    const o = this.model?.objects[i]
    if (!o) return null
    const e = this.options.useElevation ? (this.model!.sheets[o.sheet]?.elevation ?? 0) : 0
    return [(o.min[0] + o.max[0]) / 2, (o.min[1] + o.max[1]) / 2, (o.min[2] + o.max[2]) / 2 + e]
  }

  /** Status text for the cursor over a section pane. */
  cursorText(p: Pane, sx: number, sy: number): string {
    if (p.kind === '3d') return ''
    const q = this.pointAt(p, sx, sy)
    const z = q[2]
    const fls = this.floors()
    let floor = ''
    for (const fl of fls) if (fl.z <= z + 1e-6) floor = ` (${fl.name} FL${z - fl.z < 0 ? '−' : '+'}${Math.abs(Math.round(z - fl.z)).toLocaleString()})`
    const f = cameraFrame(p.cam)
    const along = Math.abs(f.right[0]) > 0.999 ? `X ${Math.round(q[0]).toLocaleString()}` : Math.abs(f.right[1]) > 0.999 ? `Y ${Math.round(q[1]).toLocaleString()}` : `${Math.round(q[0]).toLocaleString()}, ${Math.round(q[1]).toLocaleString()}`
    return `${along} / 高さ ${Math.round(z).toLocaleString()}${floor}`
  }

  private attach(p: Pane) {
    const pointers = new Map<number, { x: number; y: number }>()
    let drag: { x: number; y: number; button: number; shift: boolean; moved: boolean } | null = null
    let pinch: { d: number; cx: number; cy: number } | null = null
    const c = p.overlay
    c.addEventListener('contextmenu', (e) => e.preventDefault())
    c.addEventListener('pointerdown', (e) => {
      this.events.activate?.(p)
      c.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
        drag = null
      } else drag = { x: e.offsetX, y: e.offsetY, button: e.button, shift: e.shiftKey, moved: false }
    })
    c.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY })
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const cx = (a.x + b.x) / 2
        const cy = (a.y + b.y) / 2
        if (d > 0 && pinch.d > 0) this.zoomAt(p, cx, cy, pinch.d / d)
        this.pan(p, cx - pinch.cx, cy - pinch.cy)
        pinch = { d, cx, cy }
        return
      }
      if (drag) {
        const dx = e.offsetX - drag.x
        const dy = e.offsetY - drag.y
        if (!drag.moved && Math.hypot(dx, dy) < 4) return
        drag.moved = true
        drag.x = e.offsetX
        drag.y = e.offsetY
        if (p.kind === '3d' && drag.button === 0 && !drag.shift && !e.shiftKey) this.orbit(p, dx, dy)
        else this.pan(p, dx, dy)
        return
      }
      this.events.status?.(this.cursorText(p, e.offsetX, e.offsetY))
    })
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      if (pointers.size < 2) pinch = null
      if (drag && !drag.moved && e.type === 'pointerup' && drag.button === 0) {
        const i = this.pick(p, e.offsetX, e.offsetY)
        this.events.select?.(i >= 0 ? i : null, i >= 0 ? this.model!.objects[i] : null)
      } else if (drag && !drag.moved && e.type === 'pointerup' && drag.button === 2) {
        const i = this.pick(p, e.offsetX, e.offsetY)
        this.events.menu?.(p, e.clientX, e.clientY, i >= 0 ? i : null)
      }
      drag = null
    }
    c.addEventListener('pointerup', up)
    c.addEventListener('pointercancel', up)
    c.addEventListener('pointerenter', () => this.events.hint?.(p.adjustLink ? PANE_TIPS.linkAdjusting : p.kind === '3d' ? PANE_TIPS.body3d : PANE_TIPS.bodyElev))
    c.addEventListener('pointerleave', () => {
      this.events.status?.('')
      this.events.hint?.(null)
    })
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const k = Math.exp((e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0015)
        this.zoomAt(p, e.offsetX, e.offsetY, k)
      },
      { passive: false },
    )
    c.addEventListener('dblclick', (e) => {
      const i = this.pick(p, e.offsetX, e.offsetY)
      const q = i >= 0 ? this.objectCenter(i) : null
      if (q && p.kind === '3d') {
        // orbit around the clicked object
        p.cam.target = q
        p.moved = true
        this.render(p)
      } else if (!q) this.fitPane(p)
      else return
      this.emitLink(p)
    })
  }
}
