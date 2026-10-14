import { CanvasRenderer, type View } from '../render/canvas.ts'
import { appendPrim, buildLayerBatches, type SceneLayer } from '../render/scene.ts'
import { defaultOptions, tfasRgb, type RenderOptions } from '../render/style.ts'
import { toSvg, type SvgLayer } from '../render/svg.ts'
import { currentLayout, filterGeom, layoutPaper, layoutPieces, modelPieces, type SourceSheet } from '../tfas/layout.ts'
import { unionRect, type EntityInfo, type GeomBuffer, type ImageItem, type LayerColor, type Rect, type TextItem, type TfasDocument } from '../tfas/model.ts'
import { resolveXref } from '../tfas/xref.ts'
import { entityParts, entityProperties, LAYER_GROUPS, type EntityParts } from './entities.ts'
import { ParserClient } from './parser-client.ts'
import { applyStaticTips, MENU_ITEM_TIPS, CMD_TIPS, OPT3D_TIPS, PANE_TIPS, sheetTip, TERM_TIPS } from './help.ts'
import { PaneGrid } from './pane-grid.ts'
import { initParts, isPartsFile, onOpenPart, openPartsFiles } from './parts.ts'
import { Picker, type Snap } from './pick.ts'
import { printSvg } from './print.ts'
import { initPwa, promptInstall } from './pwa.ts'
import { VIEW_PRESETS, Viewer3D, type Pane, type PaneKind, type SectionBox, type ViewPreset } from './viewer3d.ts'
import type { Model3D } from '../tfas/model3d.ts'

// ---------------------------------------------------------------------------
// DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('view')
const overlay = $<HTMLCanvasElement>('overlay')
const octx = overlay.getContext('2d')!
const fileInput = $<HTMLInputElement>('file-input')
const folderInput = $<HTMLInputElement>('folder-input')
const fileSelect = $<HTMLSelectElement>('file-select')
const rangeSelect = $<HTMLSelectElement>('range-select')
const sheetList = $<HTMLUListElement>('sheet-list')
const sheetFilter = $<HTMLInputElement>('sheet-filter')
const layerList = $<HTMLUListElement>('layer-list')
const layerFilter = $<HTMLInputElement>('layer-filter')
const layersUsed = $<HTMLInputElement>('layers-used')
const sheetTabs = $<HTMLDivElement>('sheet-tabs')
const currentSheetBtn = $<HTMLButtonElement>('current-sheet')
const info = $<HTMLDivElement>('info')
const thumb = $<HTMLCanvasElement>('thumb')
const empty = $<HTMLDivElement>('empty')
const busy = $<HTMLDivElement>('busy')
const toolHint = $<HTMLDivElement>('tool-hint')
const props = $<HTMLDivElement>('props')
const measureBox = $<HTMLDivElement>('measure')
const stHint = $<HTMLSpanElement>('st-hint')
const stPos = $<HTMLSpanElement>('st-pos')
const stPaper = $<HTMLSpanElement>('st-paper')
const stScale = $<HTMLSpanElement>('st-scale')
const stZoom = $<HTMLSpanElement>('st-zoom')
const stTime = $<HTMLSpanElement>('st-time')
const warnSection = $<HTMLElement>('warn-section')
const warnList = $<HTMLUListElement>('warnings')
const searchInput = $<HTMLInputElement>('search-input')
const searchSummary = $<HTMLDivElement>('search-summary')
const searchResults = $<HTMLUListElement>('search-results')
const contextMenu = $<HTMLDivElement>('context-menu')
const docTitle = $<HTMLDivElement>('doc-title')

const options: RenderOptions = { ...defaultOptions }
const renderer = new CanvasRenderer(canvas, options)
renderer.onRendered = (ms) => {
  stTime.textContent = `描画 ${ms.toFixed(0)} ms`
  updateZoomLabel()
}
renderer.onViewChange = () => {
  drawOverlay()
  linkFrom2d()
}

/** Busy indicator shared by overlapping tasks (opening files, building 3D). */
let busyCount = 0
function setBusy(on: boolean, text = '読み込み中…') {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1))
  if (on) busy.textContent = text
  busy.hidden = busyCount === 0
}

// ---------------------------------------------------------------------------
// File library and parsing (worker)

interface Entry {
  key: string
  name: string
  read: () => Promise<ArrayBuffer>
  doc?: Promise<TfasDocument>
  model3d?: Promise<Model3D>
  /** the 3D model once built */
  model3dReady?: Model3D
  /** a part from a parts library shown in the drawing area (no .tfs data, no 3D) */
  part?: boolean
}

const library = new Map<string, Entry>()
const normName = (s: string) => s.normalize('NFKC').toLowerCase().trim()

const parser = new ParserClient()

/** 3D model of a drawing (built in the worker on first use). */
function parse3d(entry: Entry): Promise<Model3D> {
  entry.model3d ??= entry
    .read()
    .then((buffer) => parser.request<Model3D>('3d', entry.name, buffer))
    .then((m) => (entry.model3dReady = m))
  // a failure is not cached: the next request tries again
  entry.model3d.catch(() => (entry.model3d = undefined))
  return entry.model3d
}

function parse(entry: Entry): Promise<TfasDocument> {
  entry.doc ??= entry.read().then((buffer) => parser.request<TfasDocument>('doc', entry.name, buffer))
  entry.doc.catch(() => (entry.doc = undefined))
  return entry.doc
}

function addEntry(name: string, read: () => Promise<ArrayBuffer>): Entry {
  const key = normName(name)
  const entry: Entry = { key, name, read }
  library.set(key, entry)
  return entry
}

function refreshFileLists(currentKey: string) {
  const tfs = [...library.values()]
  fileSelect.hidden = tfs.length < 2
  fileSelect.replaceChildren(
    ...tfs.map((e) => {
      const o = document.createElement('option')
      o.value = e.key
      o.textContent = e.name
      o.selected = e.key === currentKey
      return o
    }),
  )
  const menu = $('menu-files')
  menu.replaceChildren(
    ...tfs.map((e) => {
      const b = document.createElement('button')
      b.textContent = e.name
      b.title = e.key === currentKey ? '表示中の図面' : 'この図面に切り替えて表示します'
      b.className = e.key === currentKey ? 'current' : ''
      b.addEventListener('click', () => {
        closeMenus()
        openEntry(e)
      })
      return b
    }),
  )
}

async function addFiles(files: File[]) {
  const parts = files.filter((f) => isPartsFile(f.name))
  const tfs = files.filter((f) => /\.tfs$/i.test(f.name))
  if (parts.length) {
    await openPartsFiles(parts)
    if (!tfs.length) {
      showTab('parts')
      return
    }
  }
  if (!tfs.length) {
    alert('.tfs ファイル (または部品ライブラリ .NCP / .MDB / .USR) が含まれていません')
    return
  }
  const added = tfs.map((f) => addEntry(f.name, () => f.arrayBuffer()))
  // Open the drawing among the added files, not a frame file it references. When only
  // frame files for the current drawing were added, reopen the current drawing with them.
  const referenced = new Set<string>()
  current?.doc.layers.forEach((l) => l.xref && referenced.add(normName(l.xref.fileName)))
  if (added.length > 1) {
    let done = 0
    setBusy(true, `読み込み中… 0 / ${added.length} ファイル`)
    try {
      await Promise.all(
        added.map((e) =>
          parse(e)
            .then((d) => d.layers.forEach((l) => l.xref && referenced.add(normName(l.xref.fileName))))
            .catch(() => {})
            .finally(() => (busy.textContent = `読み込み中… ${++done} / ${added.length} ファイル`)),
        ),
      )
    } finally {
      setBusy(false)
    }
  }
  const main = added.find((e) => !referenced.has(e.key)) ?? (current ? library.get(current.entry.key) : undefined) ?? added[0]
  await openEntry(main)
}

// ---------------------------------------------------------------------------
// Current document

/**
 * A displayed piece: a sheet's content in the model, or in a layout either a layout
 * sheet's own content or the model region one of its viewports shows (clipped).
 */
interface SheetView {
  /** index in Current.sheets (also the scene layer / visibility index) */
  index: number
  /** document layer (sheet) the content comes from */
  layer: number
  /** document layer of the sheet tab the piece belongs to */
  group: number
  geom: GeomBuffer
  texts: TextItem[]
  images: ImageItem[]
  entities: EntityInfo[]
  bbox: Rect | null
  color: LayerColor
  clip: number[] | null
  /** content before hidden レイヤ are filtered out */
  base: { geom: GeomBuffer; texts: TextItem[] }
}

interface Current {
  entry: Entry
  doc: TfasDocument
  /** per document layer, external references resolved */
  sources: SourceSheet[]
  xref: ('ok' | 'missing' | null)[]
  /** shown layout id, or null for the model */
  view: string | null
  /** paper area of the shown view */
  paper: Rect
  sheets: SheetView[]
  /** document layers shown as sheet tabs in this view */
  groups: number[]
  scene: SceneLayer[]
  /** per piece (renderer visibility) */
  visible: boolean[]
  /** per document layer */
  sheetVisible: boolean[]
  /** document layer of the current sheet */
  currentSheet: number
  /** hidden レイヤ (図形属性 ids) */
  hiddenLayers: Set<number>
  /** primitives and texts per レイヤ in the whole document */
  layerCounts: Map<number, number>
  picker: Picker
}

interface Selection {
  sheet: number
  entity: number
  parts: EntityParts
}

let current: Current | null = null
let selection: Selection | null = null
const history: View[] = []

// ---------------------------------------------------------------------------
// 3D, elevation and section windows (Tfas: 3D 表示 / クイック断面). The plan stays the
// first window; the others share one WebGL scene (viewer3d.ts).

type Layout = 'plan' | 'plan-3d' | '3d' | 'quad' | 'section2' | 'section4'
const LAYOUT_PANES: Record<Layout, PaneKind[]> = {
  plan: [],
  'plan-3d': ['3d'],
  '3d': ['3d'],
  quad: ['3d', 'front', 'right'],
  section2: ['front', 'right'],
  section4: ['front', 'back', 'right'],
}
let layout: Layout = 'plan'
let viewer: Viewer3D | null = null
let section: SectionBox | null = null
/** window the view commands (fit, zoom, PNG) apply to: a 3D window, or null for the plan */
let activePane: Pane | null = null
/** 2D・3D 連動: follow the plan's position and / or its scale (拡大率) */
let linkPosition = false
let linkZoom = false
let linking = false
const opts3d = { useElevation: true, showPlan: true, translucentMembers: false, clip3d: false, partViews: false }
const panesEl = $<HTMLDivElement>('panes')
const planPane = $<HTMLDivElement>('pane-plan')
const layoutSelect = $<HTMLSelectElement>('layout-select')
const paneSync = new WeakMap<Pane, () => void>()
/** window order and sizes (dragging the borders and title bars) */
const paneGrid = new PaneGrid(panesEl, 'tfas-viewer.pane-split', { split: PANE_TIPS.split, head: PANE_TIPS.head })
paneGrid.onChange = () => {
  renderer.requestRender()
  drawOverlay()
}

function ensureViewer(): Viewer3D | null {
  if (viewer) return viewer
  try {
    viewer = new Viewer3D()
  } catch (e) {
    alert(`3D 表示を開始できません: ${(e as Error).message}`)
    return null
  }
  viewer.options = { ...viewer.options, ...opts3d, background: options.background }
  viewer.events = {
    select: (_i, obj) => select3d(obj ? { sheet: obj.sheet, entity: obj.entity } : null),
    link: (x, y, upp, source) => linkFrom3d(x, y, upp, source, source.kind === '3d' ? undefined : paneAxis(source)),
    menu: (p, x, y, hit) => paneMenu(p, x, y, hit),
    status: (t) => (stPos.textContent = t || '—'),
    hint: (t) => setHint(t ?? undefined),
    activate: (p) => setActivePane(p),
    kindChange: (p) => paneSync.get(p)?.(),
    offsetChange: (p) => paneSync.get(p)?.(),
  }
  return viewer
}

/** Fit a 3D window by the user (the plan follows when linked). */
function fitPane3d(p: Pane) {
  viewer?.fitPane(p)
  linkFromPane(p)
}

/** Tell the plan about a window's view (2D linking). */
function linkFromPane(p: Pane) {
  viewer?.emitLink(p)
}

/** Horizontal axis (plan direction) of an elevation / section window. */
function paneAxis(p: Pane): [number, number] {
  return [-Math.sin(p.cam.yaw), Math.cos(p.cam.yaw)]
}

function setActivePane(p: Pane | null) {
  activePane = p
  planPane.classList.toggle('active', !p && layout !== 'plan')
  for (const q of viewer?.panes ?? []) q.el.classList.toggle('active', q === p)
}

/** Select the plan entity of a 3D object (null clears). */
function select3d(hit: { sheet: number; entity: number } | null) {
  if (!current) return
  if (!hit) {
    clearSelection()
    return
  }
  let sv = current.sheets.find((s) => s.layer === hit.sheet && s.group === hit.sheet)
  if (!sv && current.view !== null) {
    showView(null)
    sv = current.sheets.find((s) => s.layer === hit.sheet && s.group === hit.sheet)
  }
  if (sv) select(sv.index, hit.entity)
}

/** Linking applies while the plan shows the model (layouts are in paper coordinates). */
function linkActive(): boolean {
  return (linkPosition || linkZoom) && !!current && current.view === null
}

/** The plan view moved: bring the 3D windows (and the separate window) along. */
function linkFrom2d() {
  if (linking || !linkActive()) return
  linking = true
  const { cx, cy, zoom } = renderer.view
  if (!(zoom > 0 && Number.isFinite(zoom)) || renderer.width < 2) {
    linking = false
    return
  }
  const center: [number, number] | null = linkPosition ? [cx, cy] : null
  const upp = linkZoom ? 1 / zoom : null
  if (layout !== 'plan') viewer?.setLinkedView(center, upp)
  // a change that came from the separate window is not sent back to it
  const echo = popupEcho && Math.abs(popupEcho.cx - cx) < 1e-6 && Math.abs(popupEcho.cy - cy) < 1e-6 && Math.abs(popupEcho.zoom - zoom) < 1e-9 * zoom
  popupEcho = null
  if (!echo) sendPopup({ type: 'link', center, upp })
  linking = false
}

/** View last received from the separate window (not echoed back to it). */
let popupEcho: View | null = null

/**
 * A 3D window moved or zoomed: the plan and the other windows follow. For an elevation
 * or section window only the sideways position (along `axis`) is meaningful.
 */
function linkFrom3d(x: number, y: number, upp: number, source?: Pane, axis?: [number, number]) {
  if (linking || !linkActive() || !(upp > 0 && Number.isFinite(upp))) return
  linking = true
  const v = renderer.view
  if (axis) {
    const d = (x - v.cx) * axis[0] + (y - v.cy) * axis[1]
    x = v.cx + axis[0] * d
    y = v.cy + axis[1] * d
  }
  renderer.view = { cx: linkPosition ? x : v.cx, cy: linkPosition ? y : v.cy, zoom: linkZoom ? 1 / upp : v.zoom }
  if (!source) popupEcho = { ...renderer.view }
  renderer.requestRender()
  drawOverlay()
  const center: [number, number] | null = linkPosition ? [x, y] : null
  viewer?.setLinkedView(center, linkZoom ? upp : null, source)
  if (source) sendPopup({ type: 'link', x, y, upp: linkZoom ? upp : null, center, axis })
  linking = false
}

function addPane(kind: PaneKind): Pane {
  const v = viewer!
  const p = v.createPane(kind)
  const mini = (label: string, title: string, fn: () => void) => {
    const b = document.createElement('button')
    b.className = 'mini'
    b.textContent = label
    b.title = title
    b.addEventListener('click', fn)
    return b
  }
  const preset = document.createElement('select')
  preset.title = PANE_TIPS.preset
  preset.add(new Option('視点…', ''))
  for (const [k, name] of VIEW_PRESETS) preset.add(new Option(name, k))
  preset.addEventListener('change', () => {
    if (preset.value) v.setPreset(p, preset.value as ViewPreset)
    preset.value = ''
  })
  const persp = document.createElement('label')
  persp.className = 'mini'
  persp.title = PANE_TIPS.perspective
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = p.perspective3d
  cb.addEventListener('change', () => {
    p.perspective3d = p.cam.perspective = cb.checked
    v.fitPane(p)
  })
  persp.append(cb, '透視')
  const arch = document.createElement('label')
  arch.className = 'mini'
  arch.title = OPT3D_TIPS.translucentMembers
  const acb = document.createElement('input')
  acb.type = 'checkbox'
  acb.dataset.opt3d = 'translucentMembers'
  acb.checked = opts3d.translucentMembers
  acb.addEventListener('change', () => setOpt3d('translucentMembers', acb.checked))
  arch.append(acb, '建築半透明')
  // parts as estimated from their views (5 面図) instead of boxes
  const shape = document.createElement('label')
  shape.className = 'mini'
  shape.title = OPT3D_TIPS.partViews
  const scb = document.createElement('input')
  scb.type = 'checkbox'
  scb.dataset.opt3d = 'partViews'
  scb.checked = opts3d.partViews
  scb.addEventListener('change', () => setOpt3d('partViews', scb.checked))
  shape.append(scb, '推定形状')
  const clear = mini('断面解除', CMD_TIPS['section-clear'], () => applySection(null))
  // ずれ調整: shift this window against the plan while 2D linking is on
  const adjust = mini('ずれ調整', PANE_TIPS.linkAdjust, () => setLinkAdjust(p, !p.adjustLink))
  const unshift = mini('ずれ解除', PANE_TIPS.linkReset, () => v.resetLinkOffset(p))
  const sync = () => {
    preset.hidden = persp.hidden = p.kind !== '3d'
    clear.hidden = !section || (p.kind === '3d' && !opts3d.clip3d)
    const linked = linkPosition || linkZoom
    if (!linked && p.adjustLink) setLinkAdjust(p, false)
    adjust.hidden = !linked
    adjust.classList.toggle('on', p.adjustLink)
    unshift.hidden = !linked || !v.hasLinkOffset(p)
  }
  paneSync.set(p, sync)
  sync()
  const link = document.createElement('label')
  link.className = 'mini'
  link.title = OPT3D_TIPS.link
  const lcb = document.createElement('input')
  lcb.type = 'checkbox'
  lcb.dataset.opt3d = 'link'
  lcb.checked = linkPosition && linkZoom
  lcb.indeterminate = linkPosition !== linkZoom
  lcb.addEventListener('change', () => setOpt3d('link', lcb.checked))
  link.append(lcb, '2D連動')
  p.tools.append(clear, preset, persp, arch, shape, link, adjust, unshift, mini('全体', PANE_TIPS.fit, () => fitPane3d(p)), mini('⧉', PANE_TIPS.popup, openPopup), mini('×', PANE_TIPS.close, () => closePane(p)))
  return p
}

/** ずれ調整 on / off for a window: while on, moving it does not move the plan. */
function setLinkAdjust(p: Pane, on: boolean) {
  p.adjustLink = on
  p.el.classList.toggle('adjusting', on)
  paneSync.get(p)?.()
  setHint(on ? PANE_TIPS.linkAdjusting : undefined)
}

/** Model area currently shown in the plan window. */
function planVisibleRect(): Rect {
  const v = renderer.view
  const w = renderer.width / v.zoom
  const h = renderer.height / v.zoom
  return { x0: v.cx - w / 2, y0: v.cy - h / 2, x1: v.cx + w / 2, y1: v.cy + h / 2 }
}

/** Grid for the plan plus n other windows. */
function gridFor(n: number, withPlan: boolean): Layout {
  if (!withPlan) return '3d'
  return n === 0 ? 'plan' : n === 1 ? 'plan-3d' : n === 2 ? 'section2' : 'quad'
}

function applyGrid(l: Layout) {
  // keep showing the same part of the plan when its window changes size
  const keep = renderer.width >= 2 && renderer.height >= 2 ? planVisibleRect() : null
  if (keep) {
    requestAnimationFrame(() => {
      if (renderer.width < 2 || renderer.height < 2) return
      renderer.fit(keep, 0)
      renderer.requestRender()
    })
  }
  layout = l
  panesEl.dataset.layout = l
  const others = viewer?.panes.map((p) => p.el) ?? []
  paneGrid.arrange(l === '3d' ? others : [planPane, ...others])
  layoutSelect.value = l
  document.querySelectorAll<HTMLElement>('[data-toggle="3d"]').forEach((b) => b.classList.toggle('active', l !== 'plan'))
  document.querySelectorAll<HTMLElement>('[data-layout-cmd]').forEach((b) => b.classList.toggle('current', b.dataset.layoutCmd === l))
  if (l === 'plan' || (l === '3d' && !activePane)) setActivePane(l === '3d' ? (viewer?.panes[0] ?? null) : null)
  else setActivePane(activePane)
  renderer.requestRender()
  resizeOverlay()
  drawOverlay()
}

function closePane(p: Pane) {
  if (!viewer) return
  viewer.removePane(p)
  if (activePane === p) setActivePane(null)
  const n = viewer.panes.length
  applyGrid(n === 0 ? 'plan' : gridFor(n, layout !== '3d'))
  // the section range is shown in section windows (and in 3D only when clipping)
  const shown = viewer.panes.some((q) => q.kind !== '3d' || opts3d.clip3d)
  if (section && !shown) applySection(null)
}

/** Switch the window arrangement. */
async function setLayout(l: Layout) {
  if (l !== 'plan' && (!current || !ensureViewer())) return
  const kinds = LAYOUT_PANES[l]
  if (viewer) {
    while (viewer.panes.length > kinds.length) viewer.removePane(viewer.panes[viewer.panes.length - 1])
    kinds.forEach((k, i) => {
      const p = viewer!.panes[i] ?? addPane(k)
      if (p.kind !== k) viewer!.setKind(p, k)
      paneSync.get(p)?.()
    })
    for (const p of viewer.panes) panesEl.append(p.el)
  }
  // 3D shows the model
  if (l !== 'plan' && current && current.view !== null) showView(null)
  applyGrid(l)
  if (l === 'plan' && section) applySection(null)
  if (l !== 'plan' && viewer && current && viewer.doc !== current.doc) await show3dData()
}

async function show3dData() {
  if (!current || !viewer) return
  const c = current
  if (viewer.doc !== c.doc) viewer.setData(null, null)
  if (c.entry.part) {
    viewer.message = '部品は 3D 表示の対象外です。部品の立体形状は、左の［部品］パネルのプレビューで［3D］を押すと見られます。'
    viewer.renderAll()
    return
  }
  viewer.message = '3D データを作成中…'
  viewer.renderAll()
  setBusy(true, '3D データを作成中…')
  try {
    const model = await parse3d(c.entry)
    if (current !== c || !viewer) return
    viewer.message = null
    viewer.hiddenLayers = new Set(c.hiddenLayers)
    viewer.setData(model, c.doc)
    viewer.setVisibility(c.sheetVisible)
    viewer.setSection(section)
    if (selection) viewer.highlightEntity(c.sheets[selection.sheet].layer, selection.entity)
    // linked windows start at the plan's view
    linkFrom2d()
    renderProps()
    if (model.warnings.length) console.warn(model.warnings.join('\n'))
  } catch (e) {
    if (viewer) {
      viewer.message = `3D データを作成できませんでした: ${(e as Error).message}`
      viewer.renderAll()
    }
  } finally {
    setBusy(false)
  }
}

function startSectionTool(t: 'section' | 'section-line') {
  if (!current) return
  if (current.view !== null) showView(null)
  if (layout === '3d') applyGrid(gridFor(viewer?.panes.length ?? 0, true))
  setTool(t)
}

/** Section range from picked points: 2 corners, or cut line (2 points) + depth point. */
function sectionBox(pts: [number, number][]): SectionBox | null {
  if (tool === 'section') {
    if (pts.length < 2) return null
    const [a, b] = pts
    const x0 = Math.min(a[0], b[0])
    const y0 = Math.min(a[1], b[1])
    const lu = Math.abs(b[0] - a[0])
    const lv = Math.abs(b[1] - a[1])
    return lu >= 1 && lv >= 1 ? { o: [x0, y0], u: [1, 0], v: [0, 1], lu, lv } : null
  }
  if (pts.length < 3) return null
  const [a, b, c] = pts
  const L = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (L < 1) return null
  const u: [number, number] = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
  let v: [number, number] = [-u[1], u[0]]
  let t = (c[0] - a[0]) * v[0] + (c[1] - a[1]) * v[1]
  if (t < 0) {
    v = [-v[0], -v[1]]
    t = -t
  }
  return t >= 1 ? { o: [a[0], a[1]], u, v, lu: L, lv: t } : null
}

function applySection(b: SectionBox | null) {
  section = b
  viewer?.setSection(b)
  sendPopup({ type: 'section', section: b })
  syncSectionUi()
  drawOverlay()
  // open section windows (クイック断面の展開) unless some are shown already
  if (b && !(viewer?.panes.some((p) => p.kind !== '3d') ?? false)) {
    const mode = (document.querySelector<HTMLInputElement>('input[name="section-mode"]:checked')?.value as Layout | undefined) ?? 'section2'
    const has3d = layout !== 'plan' && !!viewer?.panes.some((p) => p.kind === '3d')
    void setLayout(mode === 'section2' && has3d ? 'quad' : mode)
  }
  if (b) {
    requestAnimationFrame(() => {
      const xs = [0, 1].flatMap((s) => [0, 1].map((t) => b.o[0] + b.u[0] * b.lu * s + b.v[0] * b.lv * t))
      const ys = [0, 1].flatMap((s) => [0, 1].map((t) => b.o[1] + b.u[1] * b.lu * s + b.v[1] * b.lv * t))
      const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
      const vis = planVisibleRect()
      if (r.x0 >= vis.x0 && r.x1 <= vis.x1 && r.y0 >= vis.y0 && r.y1 <= vis.y1) return
      pushView()
      renderer.fit(padRect(r), 0.05)
      renderer.requestRender()
    })
  }
}

/** Section-clear buttons are usable only while a section range exists. */
function syncSectionUi() {
  document.querySelectorAll<HTMLButtonElement>('[data-cmd="section-clear"]').forEach((b) => (b.disabled = !section))
  for (const p of viewer?.panes ?? []) paneSync.get(p)?.()
}

function floorRows(doc: TfasDocument): [string, string][] {
  const seen = new Map<string, number>()
  for (const l of doc.layers) if (l.floor && !seen.has(l.floor)) seen.set(l.floor, l.elevation ?? 0)
  if (!seen.size) return []
  return [['階 (基準高さ)', [...seen].sort((a, b) => a[1] - b[1]).map(([f, z]) => `${f} ${z.toLocaleString()}`).join(' / ')]]
}

// --- 3D in a separate browser window (Tfas: ウィンドウの位置「フレーム外」) ---------

let popup: Window | null = null

function openPopup() {
  if (!current) return
  if (popup && !popup.closed) {
    popup.focus()
    return
  }
  // 3D details for the property panel
  if (!current.entry.part) void parse3d(current.entry).then(() => renderProps(), () => {})
  popup = window.open(new URL('view3d.html', location.href).href, 'tfas-viewer-3d', 'width=1100,height=760')
  if (!popup) alert('別ウィンドウを開けませんでした (ブラウザーのポップアップブロックを確認してください)')
}

function sendPopup(m: object, transfer: Transferable[] = []) {
  if (popup && !popup.closed) popup.postMessage(m, location.origin, transfer)
}

async function sendPopupFile() {
  if (!popup || popup.closed || !current) return
  const c = current
  if (c.entry.part) {
    sendPopup({ type: 'none', name: c.entry.name })
    return
  }
  const buffer = await c.entry.read()
  if (current !== c) return
  sendPopup(
    {
      type: 'file',
      name: c.entry.name,
      buffer,
      visible: c.sheetVisible,
      section,
      hiddenLayers: [...c.hiddenLayers],
      options: { ...opts3d, background: options.background },
      link: linkPosition || linkZoom,
      // the plan's view, for windows linked to it
      linkView: linkActive() ? { center: linkPosition ? [renderer.view.cx, renderer.view.cy] : null, upp: linkZoom ? 1 / renderer.view.zoom : null } : null,
      selection: selection ? { sheet: c.sheets[selection.sheet].layer, entity: selection.entity } : null,
    },
    [buffer],
  )
}

window.addEventListener('message', (e: MessageEvent) => {
  if (!popup || e.source !== popup || e.origin !== location.origin) return
  const m = e.data as { type: string; sheet?: number; entity?: number; x?: number; y?: number; upp?: number; axis?: [number, number] } | null
  if (!m) return
  if (m.type === 'ready') void sendPopupFile()
  else if (m.type === 'select') select3d(m.sheet === undefined ? null : { sheet: m.sheet, entity: m.entity ?? 0 })
  else if (m.type === 'link' && m.x !== undefined && m.y !== undefined && m.upp) linkFrom3d(m.x, m.y, m.upp, undefined, m.axis)
})

/** Generation of the latest open request: an older request that finishes later is dropped. */
let openGen = 0

async function openEntry(entry: Entry) {
  const gen = ++openGen
  setBusy(true)
  try {
    const doc = await parse(entry)
    const sources: SourceSheet[] = []
    const xref: ('ok' | 'missing' | null)[] = []
    for (const l of doc.layers) {
      const s: SourceSheet = { geom: l.geom, texts: l.texts, images: l.images, entities: l.entities, bbox: l.bbox, color: l.color }
      let state: 'ok' | 'missing' | null = null
      if (l.xref) {
        state = 'missing'
        const src = library.get(normName(l.xref.fileName))
        if (src && src !== entry) {
          try {
            const r = resolveXref(doc, l, await parse(src))
            if (r) {
              Object.assign(s, { geom: r.geom, texts: r.texts, bbox: r.bbox, entities: r.entities })
              state = 'ok'
            }
          } catch {
            state = 'missing'
          }
        }
      }
      sources.push(s)
      xref.push(state)
    }
    if (gen !== openGen) return
    const cur = doc.layers.findIndex((l) => l.current)
    // selection, measurement and section refer to the previous drawing
    selection = null
    measure.points = []
    section = null
    current = {
      entry,
      doc,
      sources,
      xref,
      view: null,
      paper: doc.paper,
      sheets: [],
      groups: [],
      scene: [],
      visible: [],
      sheetVisible: doc.layers.map((l) => l.visible),
      currentSheet: Math.max(0, cur),
      hiddenLayers: new Set(),
      layerCounts: countLayers(doc),
      picker: new Picker([]),
    }
    empty.hidden = true
    syncSectionUi()
    refreshFileLists(entry.key)
    document.querySelectorAll<HTMLButtonElement>('[data-needs-doc]').forEach((b) => (b.disabled = false))
    renderInfo()
    renderLayers()
    renderLayouts()
    // Tfas opens a drawing on the layout that holds the current sheet; the 3D windows show the model
    showView(layout === 'plan' ? currentLayout(doc) : null, cur >= 0 ? cur : undefined)
    document.title = `${entry.name} - Tfas Viewer`
    docTitle.textContent = entry.name
    setHint()
    sync3d()
    void sendPopupFile()
  } catch (e) {
    if (gen === openGen) alert(`${entry.name} を開けませんでした。\n${friendlyError(e as Error)}`)
  } finally {
    setBusy(false)
  }
}

/** Error text for users new to CAD (keeps the technical detail at the end). */
function friendlyError(e: Error): string {
  if (/マジック|TFAS ファイルではありません/.test(e.message)) return `Tfas の図面ファイル (.tfs) ではないか、ファイルが壊れている可能性があります。\n(詳細: ${e.message})`
  return `ファイルの形式に対応していないか、壊れている可能性があります。\n(詳細: ${e.message})`
}

/** Bring the 3D windows in line with the current drawing (after opening or reopening one). */
function sync3d() {
  if (!current || !viewer) return
  if (viewer.doc === current.doc) {
    viewer.hiddenLayers = new Set()
    viewer.setSection(section)
    viewer.setHiddenLayers(current.hiddenLayers)
    viewer.setVisibility(current.sheetVisible)
    viewer.highlightEntity(null)
  } else if (layout !== 'plan') void show3dData()
  // do not keep another drawing's model around (its object numbers mean nothing here)
  else viewer.setData(null, null)
}

/** Display color mode of a sheet: 単色指定 applies unless it is the current sheet. */
function sheetColorMode(i: number): LayerColor {
  const l = current!.doc.layers[i]
  if (l.color.mode === 'gray') return l.color
  if (l.monoColor && i !== current!.currentSheet) return { mode: 'layer', color: l.monoColor }
  return { mode: 'entity', color: 0 }
}

/** Switch between the model (null) and a layout. */
function showView(view: string | null, currentSheet?: number) {
  if (!current) return
  const c = current
  const { doc } = c
  c.view = view
  c.paper = view ? layoutPaper(doc, view) : doc.paper
  renderer.paper = c.paper
  const pieces = view ? layoutPieces(doc, view, c.sources) : modelPieces(doc, c.sources)
  c.groups = doc.layers.filter((l) => (view ? l.layout?.layoutId === view : !l.layout)).map((l) => l.index)
  if (currentSheet !== undefined && c.groups.includes(currentSheet)) c.currentSheet = currentSheet
  else if (!c.groups.includes(c.currentSheet)) {
    const lc = view ? doc.layers.find((l) => l.layout?.layoutId === view && l.layout.layoutCurrent) : undefined
    c.currentSheet = lc?.index ?? c.groups.find((g) => c.sheetVisible[g]) ?? c.groups[0] ?? 0
  }
  c.sheets = pieces.map((p, index) => filterLayers(c, { index, ...p, base: { geom: p.geom, texts: p.texts }, color: sheetColorMode(p.layer) }))
  c.scene = buildScene(c)
  c.visible = c.sheets.map((s) => c.sheetVisible[s.group])
  c.picker = new Picker(c.sheets)
  // selection and measurement refer to the previous pieces
  selection = null
  viewer?.highlightEntity(null)
  sendPopup({ type: 'select', sheet: null })
  history.length = 0
  syncHistoryUi()
  measure.points = []
  measure.done = false
  renderMeasure()
  renderer.setScene(doc, c.scene, c.visible)
  rangeSelect.value = view ?? 'model'
  stScale.textContent = `縮尺 1/${doc.scale}`
  stPaper.textContent = paperName((c.paper.x1 - c.paper.x0) / doc.scale, (c.paper.y1 - c.paper.y0) / doc.scale)
  renderSheets()
  renderLayers()
  renderProps()
  runSearch()
  renderer.resize()
  resizeOverlay()
  fitInitial()
}

/** Scene layers (drawing batches) of the displayed pieces. */
function buildScene(c: Current): SceneLayer[] {
  return c.sheets.map((s) => ({ index: s.index, name: c.doc.layers[s.layer].name, batches: buildLayerBatches(s.geom, s.bbox), texts: s.texts, images: s.images, bbox: s.bbox, primitives: s.geom.count, color: s.color, clip: s.clip }))
}

// ---------------------------------------------------------------------------
// レイヤ (Tfas の図形属性: 通り芯・壁・給水管…) visibility

function countLayers(doc: TfasDocument): Map<number, number> {
  const n = new Map<number, number>()
  for (const l of doc.layers) {
    if (l.xref) continue
    const a = l.geom.attr
    for (let i = 0; i < l.geom.count; i++) n.set(a[i], (n.get(a[i]) ?? 0) + 1)
    for (const t of l.texts) n.set(t.attr, (n.get(t.attr) ?? 0) + 1)
  }
  return n
}

/** Apply the hidden レイヤ to a piece (external references keep their own レイヤ ids and stay as they are). */
function filterLayers(c: Current, s: SheetView): SheetView {
  const hidden = c.hiddenLayers
  if (!hidden.size || c.doc.layers[s.layer].xref) {
    s.geom = s.base.geom
    s.texts = s.base.texts
  } else {
    const a = s.base.geom.attr
    s.geom = filterGeom(s.base.geom, (i) => !hidden.has(a[i]))
    s.texts = s.base.texts.filter((t) => !hidden.has(t.attr))
  }
  return s
}

/** Redraw after the hidden レイヤ changed (keeps the view). */
function applyLayerVisibility() {
  const c = current
  if (!c) return
  for (const s of c.sheets) filterLayers(c, s)
  c.scene = buildScene(c)
  c.picker = new Picker(c.sheets)
  renderer.setScene(c.doc, c.scene, c.visible)
  renderer.requestRender()
  if (selection) {
    const s = c.sheets[selection.sheet]
    const parts = entityParts(s.geom, s.texts, s.images, selection.entity)
    if (parts.prims.length || parts.texts.length || parts.images.length) selection.parts = parts
    else selection = null
    viewer?.highlightEntity(selection ? s.layer : null, selection?.entity ?? 0)
    renderProps()
  }
  drawOverlay()
  runSearch()
  renderLayers()
  viewer?.setHiddenLayers(c.hiddenLayers)
  sendPopup({ type: 'layers', hidden: [...c.hiddenLayers] })
}

function setLayersVisible(ids: Iterable<number>, on: boolean) {
  if (!current) return
  for (const id of ids) {
    if (on) current.hiddenLayers.delete(id)
    else current.hiddenLayers.add(id)
  }
  applyLayerVisibility()
}

/** Show only these レイヤ (all others hidden). */
function showOnlyLayers(ids: Iterable<number>) {
  if (!current) return
  const keep = new Set(ids)
  current.hiddenLayers = new Set(current.doc.attributes.map((a) => a.id).filter((id) => !keep.has(id)))
  applyLayerVisibility()
}

/** Hide the レイヤ of the selected figure. */
function hideSelectionLayers() {
  const ids = selectionLayers()
  if (ids.length) setLayersVisible(ids, false)
}

/** Menu for a right click in a 3D / elevation / section window (the object under the cursor gets selected). */
function paneMenu(p: Pane, x: number, y: number, hit: number | null) {
  setActivePane(p)
  const obj = hit !== null ? viewer?.model?.objects[hit] : undefined
  if (obj) select3d({ sheet: obj.sheet, entity: obj.entity })
  const items: MenuItem[] = [['このウィンドウに全体を表示', () => viewer?.fitPane(p)], null]
  if (selection) {
    items.push(
      ['選択図形のレイヤを非表示', hideSelectionLayers],
      ['選択図形のレイヤのみ表示', () => showOnlyLayers(selectionLayers())],
      ['選択図形のシートのみ表示', () => setAllSheets(current!.sheets[selection!.sheet].group)],
      ['選択解除', clearSelection],
    )
  }
  if (current?.hiddenLayers.size) items.push(['すべてのレイヤを表示', () => setLayersVisible(current!.doc.attributes.map((a) => a.id), true)])
  if (items[items.length - 1] === null) items.pop()
  showContextMenu(x, y, items)
}

/** レイヤ of the selected figure. */
function selectionLayers(): number[] {
  if (!current || !selection) return []
  const piece = current.sheets[selection.sheet]
  if (!piece || current.doc.layers[piece.layer].xref) return []
  const g = piece.geom
  const ids = new Set<number>()
  for (const i of selection.parts.prims) ids.add(g.attr[i])
  for (const t of selection.parts.texts) ids.add(t.attr)
  return [...ids]
}

function renderLayers() {
  if (!current) return
  const { doc, hiddenLayers, layerCounts } = current
  const q = layerFilter.value.trim().toLowerCase()
  const usedOnly = layersUsed.checked
  const selected = new Set(selectionLayers())
  const hiddenCount = $<HTMLSpanElement>('layers-hidden-count')
  hiddenCount.hidden = !hiddenLayers.size
  hiddenCount.textContent = `${hiddenLayers.size}`
  hiddenCount.title = `非表示のレイヤが ${hiddenLayers.size} 個あります`
  $<HTMLButtonElement>('layers-selected').disabled = !selected.size
  $<HTMLButtonElement>('layers-hide-selected').disabled = !selected.size
  const groups = new Map<number, typeof doc.attributes>()
  for (const a of doc.attributes) {
    if (usedOnly && !layerCounts.get(a.id)) continue
    if (q && !a.name.toLowerCase().includes(q)) continue
    let g = groups.get(a.group)
    if (!g) groups.set(a.group, (g = []))
    g.push(a)
  }
  const items: HTMLElement[] = []
  for (const [group, attrs] of [...groups].sort((a, b) => a[0] - b[0])) {
    const gname = LAYER_GROUPS[group] ?? `グループ ${group}`
    const head = document.createElement('li')
    head.className = 'layer-group'
    const gcb = document.createElement('input')
    gcb.type = 'checkbox'
    const shown = attrs.filter((a) => !hiddenLayers.has(a.id)).length
    gcb.checked = shown === attrs.length
    gcb.indeterminate = shown > 0 && shown < attrs.length
    gcb.title = `「${gname}」グループのレイヤをまとめて表示 / 非表示`
    gcb.addEventListener('change', () =>
      setLayersVisible(
        attrs.map((a) => a.id),
        gcb.checked,
      ),
    )
    const gn = document.createElement('span')
    gn.className = 'name'
    gn.textContent = `${gname} (${attrs.length})`
    head.title = `レイヤグループ「${gname}」\nTfas はレイヤを 基本・建築・電気・空調・衛生 などのグループに分けて管理します。チェックでグループ内のレイヤをまとめて表示・非表示にします。`
    head.append(gcb, gn)
    items.push(head)
    for (const a of attrs) {
      const li = document.createElement('li')
      const hidden = hiddenLayers.has(a.id)
      li.className = `${hidden ? 'hidden-sheet' : ''} ${selected.has(a.id) ? 'current' : ''}`
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = !hidden
      cb.title = '表示 / 非表示\nチェックを外すと、このレイヤの図形を隠します。'
      cb.addEventListener('click', (e) => e.stopPropagation())
      cb.addEventListener('change', () => setLayersVisible([a.id], cb.checked))
      const sw = document.createElement('span')
      sw.className = 'swatch'
      sw.style.background = colorCss(a.color)
      sw.title = `レイヤの色 (色番号 ${a.color})`
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = a.name || '(名称なし)'
      const n = document.createElement('span')
      n.className = 'scale'
      n.textContent = (layerCounts.get(a.id) ?? 0).toLocaleString()
      n.title = 'このレイヤの図形の数 (線・円・文字など)'
      li.title = `${a.name || '(名称なし)'}  (${gname}・${hidden ? '非表示' : '表示'}${selected.has(a.id) ? '・選択中の図形のレイヤ' : ''})\nレイヤ: 図形の分類 (通り芯・壁・給水管など)。どのシートにある図形でも、同じレイヤならまとめて表示・非表示できます。\nクリック: 表示 / 非表示の切り替え ／ 右クリック: このレイヤのみ表示 などのメニュー`
      li.append(cb, sw, name, n)
      li.addEventListener('click', () => setLayersVisible([a.id], hiddenLayers.has(a.id)))
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        showContextMenu(e.clientX, e.clientY, [
          ['このレイヤのみ表示', () => showOnlyLayers([a.id])],
          [hidden ? 'このレイヤを表示' : 'このレイヤを非表示', () => setLayersVisible([a.id], hidden)],
          [`「${gname}」グループのみ表示`, () => showOnlyLayers(attrs.map((x) => x.id))],
          null,
          ['すべてのレイヤを表示', () => setLayersVisible(doc.attributes.map((x) => x.id), true)],
        ])
      })
      items.push(li)
    }
  }
  if (!items.length) {
    const li = document.createElement('li')
    li.className = 'muted'
    li.textContent = doc.attributes.length ? '該当するレイヤがありません' : 'この図面にはレイヤの情報がありません'
    items.push(li)
  }
  layerList.replaceChildren(...items)
}

/** Recompute colors after the current sheet changed (単色指定 skips the current sheet). */
function refreshColors() {
  if (!current) return
  for (const s of current.sheets) {
    s.color = sheetColorMode(s.layer)
    current.scene[s.index].color = s.color
  }
  renderer.requestRender()
}

function visibleExtents(): Rect | null {
  if (!current) return null
  let r: Rect | null = null
  for (const s of current.sheets) {
    if (current.visible[s.index] && s.bbox) r = r ? unionRect(r, s.bbox) : s.bbox
  }
  return r
}

function fitInitial() {
  if (!current) return
  // like Tfas' own preview: the paper area, unless nothing visible is drawn there
  const ext = visibleExtents()
  const p = current.paper
  if (ext && !(ext.x0 <= p.x1 && p.x0 <= ext.x1 && ext.y0 <= p.y1 && p.y0 <= ext.y1)) renderer.fit(ext)
  else renderer.fit(p)
  renderer.requestRender()
}

// ---------------------------------------------------------------------------
// View commands

function pushView() {
  history.push({ ...renderer.view })
  if (history.length > 50) history.shift()
  syncHistoryUi()
}

/** 前画面 is usable only with a previous view. */
function syncHistoryUi() {
  document.querySelectorAll<HTMLButtonElement>('[data-cmd="prev-view"]').forEach((b) => (b.disabled = !current || !history.length))
}

/** Wheel / drag view changes go to the history once per gesture (a pause starts a new one). */
let gestureTimer = 0
function viewGesture() {
  if (!gestureTimer) pushView()
  clearTimeout(gestureTimer)
  gestureTimer = window.setTimeout(() => (gestureTimer = 0), 700)
}

function fitTo(r: Rect, margin?: number) {
  pushView()
  renderer.fit(r, margin)
  renderer.requestRender()
}

function fitPaper() {
  if (!current) return
  fitTo(current.paper)
}

function fitAll() {
  const r = visibleExtents()
  if (r) fitTo(r)
}

function prevView() {
  const v = history.pop()
  syncHistoryUi()
  if (!v) return
  renderer.view = v
  renderer.requestRender()
}

function zoomBy(k: number) {
  pushView()
  renderer.zoomAt(renderer.width / 2, renderer.height / 2, k)
}

// ---------------------------------------------------------------------------
// Tools

type Tool = 'select' | 'distance' | 'area' | 'zoom-window' | 'section' | 'section-line'
let tool: Tool = 'select'
/** points picked for a section range */
const sectionPick = { points: [] as [number, number][], cursor: null as [number, number] | null }

const measure = {
  points: [] as [number, number][],
  done: false,
  cursor: null as [number, number] | null,
  snap: null as Snap | null,
}
let windowDrag: { x0: number; y0: number; x1: number; y1: number } | null = null

const TOOL_HINTS: Record<Tool, string> = {
  select: '図形をクリックで選択 (プロパティ表示) / ドラッグで画面移動 / 右クリックでメニュー',
  distance: '距離計測: 点をクリック (端点・中点・中心にスナップ、Shift で解除)。ダブルクリックまたは Enter で確定、Esc で終了',
  area: '面積計測: 頂点をクリック。ダブルクリックまたは Enter で閉じて面積を表示、Esc で終了',
  'zoom-window': '窓拡大: 拡大する範囲をドラッグで指定 (Esc で中止)',
  section: 'クイック断面: 断面にする範囲の 2 つの角を順にクリック (端点などにスナップ、Esc で中止)',
  'section-line': '断面線: 切断線の始点・終点をクリックし、3 点目で見る方向と奥行きをクリック (Esc で中止)',
}

function setTool(t: Tool) {
  if (!current && t !== 'select') return
  tool = t
  measure.points = []
  measure.done = false
  measure.snap = null
  windowDrag = null
  sectionPick.points = []
  sectionPick.cursor = null
  canvas.className = `tool-${t}`
  document.querySelectorAll<HTMLElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t))
  toolHint.hidden = t === 'select'
  toolHint.textContent = TOOL_HINTS[t]
  renderMeasure()
  setHint()
  drawOverlay()
}

function setHint(text?: string) {
  stHint.textContent = text ?? (current ? TOOL_HINTS[tool] : 'ファイルを開いてください')
}

function finishMeasure() {
  if (tool !== 'distance' && tool !== 'area') return
  // the two clicks of a double click both added points: drop the duplicate
  const p = measure.points
  if (p.length >= 2) {
    const [a, b] = [p[p.length - 1], p[p.length - 2]]
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) p.pop()
  }
  measure.done = p.length >= 2
  renderMeasure()
  drawOverlay()
  if (measure.done && narrow.matches) showTab('selinfo')
}

function measurePoint(sx: number, sy: number, noSnap: boolean): [number, number] {
  const [x, y] = renderer.screenToModel(sx, sy)
  measure.snap = null
  if (!noSnap && current) {
    const tol = 10 / renderer.view.zoom
    measure.snap = current.picker.snap(x, y, tol, (i) => current!.visible[i])
    if (measure.snap) return [measure.snap.x, measure.snap.y]
  }
  return [x, y]
}

const fmtNum = (n: number, d = 1) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })

function polygonArea(p: [number, number][]): number {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]
    const [x1, y1] = p[(i + 1) % p.length]
    s += x0 * y1 - x1 * y0
  }
  return Math.abs(s) / 2
}

function renderMeasure() {
  const p = measure.points
  if ((tool !== 'distance' && tool !== 'area') || !current || !p.length) {
    measureBox.hidden = true
    return
  }
  const scale = current.doc.scale
  const rows: [string, string][] = []
  let total = 0
  for (let i = 1; i < p.length; i++) total += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
  if (tool === 'distance') {
    if (p.length >= 2) {
      const last = Math.hypot(p[p.length - 1][0] - p[p.length - 2][0], p[p.length - 1][1] - p[p.length - 2][1])
      const dx = p[p.length - 1][0] - p[p.length - 2][0]
      const dy = p[p.length - 1][1] - p[p.length - 2][1]
      rows.push(['最終区間', `${fmtNum(last)} mm`])
      rows.push(['  ΔX / ΔY', `${fmtNum(dx)} / ${fmtNum(dy)}`])
      rows.push(['  角度', `${fmtNum((Math.atan2(dy, dx) * 180) / Math.PI, 2)}°`])
    }
    rows.push(['合計', `${fmtNum(total)} mm`])
    rows.push(['用紙上', `${fmtNum(total / scale, 2)} mm`])
    rows.push(['点数', `${p.length}`])
  } else {
    const closed = measure.done
    const perim = total + (closed && p.length > 2 ? Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) : 0)
    if (p.length >= 3) {
      const a = polygonArea(p)
      rows.push(['面積', `${fmtNum(a / 1e6, 3)} m²`])
      rows.push(['', `${fmtNum(a, 0)} mm²`])
    }
    rows.push([closed ? '周長' : '長さ', `${fmtNum(perim)} mm`])
    rows.push(['頂点数', `${p.length}`])
  }
  measureBox.hidden = false
  const table = document.createElement('table')
  for (const [k, v] of rows) {
    const tr = table.insertRow()
    tr.insertCell().textContent = k
    tr.insertCell().textContent = v
  }
  const h = document.createElement('h3')
  h.textContent = tool === 'distance' ? `距離計測${measure.done ? ' (確定)' : ''}` : `面積計測${measure.done ? ' (確定)' : ''}`
  measureBox.replaceChildren(h, table)
}

// ---------------------------------------------------------------------------
// Selection and properties

function select(sheet: number, entity: number) {
  if (!current) return
  const s = current.sheets[sheet]
  selection = { sheet, entity, parts: entityParts(s.geom, s.texts, s.images, entity) }
  viewer?.highlightEntity(s.layer, entity)
  sendPopup({ type: 'select', sheet: s.layer, entity })
  renderProps()
  renderLayers()
  drawOverlay()
  if (narrow.matches) showTab('selinfo')
}

/** On narrow screens the property pane is hidden: its content lives in the 情報 tab. */
const narrow = window.matchMedia('(max-width: 900px)')
function placeProps() {
  const host = narrow.matches ? document.querySelector<HTMLElement>('.tab-panel[data-panel="selinfo"]')! : $('props-pane')
  host.append(props, measureBox)
  if (!narrow.matches && document.querySelector('.tab[data-tab="selinfo"].active')) showTab('sheets')
}
narrow.addEventListener('change', placeProps)
placeProps()

function clearSelection() {
  selection = null
  viewer?.highlightEntity(null)
  sendPopup({ type: 'select', sheet: null })
  renderProps()
  renderLayers()
  drawOverlay()
}

function colorCss(n: number): string {
  const rgb = tfasRgb(n)
  return rgb === null ? 'transparent' : `#${(rgb | (1 << 24)).toString(16).slice(1)}`
}

function renderProps() {
  if (!current || !selection) {
    props.className = 'props-body muted'
    props.textContent = current ? '図形をクリックすると情報を表示します' : 'ファイル未選択'
    return
  }
  const s = current.sheets[selection.sheet]
  // properties read sheet name / scale / entity kinds from the displayed sheet (xref aware)
  const docLike = { ...current.doc, layers: current.doc.layers.map((l, i) => (i === s.layer ? { ...l, entities: s.entities } : l)) }
  const rows = entityProperties(docLike, s.layer, s.geom, selection.entity, selection.parts)
  if (s.group !== s.layer) rows.splice(2, 0, ['ビューポート', `${current.doc.layers[s.group].name} (レイアウト「${layoutName(current.view)}」)`])
  const layer = current.doc.layers[s.layer]
  if (layer.floor || layer.elevation) rows.splice(2, 0, ['シート基準高さ', `${layer.floor ? `${layer.floor}  ` : ''}${(layer.elevation ?? 0).toLocaleString()}`])
  const model = current.entry.model3dReady
  const objs = model ? model.objects.filter((o) => o.sheet === s.layer && o.entity === selection!.entity) : []
  if (objs.length) {
    rows.push(...(opts3d.partViews && objs[0].alt ? objs[0].alt.info : objs[0].info))
    if (objs.length > 1) rows.push(['3D 図形', `${objs.length} 個`])
  }
  const table = document.createElement('table')
  table.className = 'prop-table'
  for (const [k, v] of rows) {
    const tr = table.insertRow()
    const th = document.createElement('th')
    th.textContent = k
    th.title = TERM_TIPS[k] ?? ''
    const td = tr.insertCell()
    if (k === '色' && /^\d+$/.test(v)) {
      const chip = document.createElement('span')
      chip.className = 'color-chip'
      chip.style.background = colorCss(Number(v))
      td.append(chip, v)
    } else td.textContent = v
    tr.prepend(th)
  }
  props.className = 'props-body'
  const zoomBtn = document.createElement('button')
  zoomBtn.className = 'btn'
  zoomBtn.textContent = 'この図形を表示'
  zoomBtn.title = 'この図形を表示\n選択した図形が画面に収まるように平面図を拡大します。'
  zoomBtn.style.marginTop = '6px'
  zoomBtn.addEventListener('click', () => {
    const b = selection?.parts.bbox
    if (b) fitTo(padRect(b), 0.15)
  })
  const hideBtn = document.createElement('button')
  hideBtn.className = 'btn'
  hideBtn.textContent = 'このレイヤを非表示'
  hideBtn.title = 'このレイヤを非表示\n選択した図形と同じレイヤ (図形の分類) の図形をすべて隠します。元に戻すときはレイヤタブの「全表示」か、右クリックの「すべてのレイヤを表示」。'
  hideBtn.style.marginTop = '6px'
  hideBtn.style.marginLeft = '6px'
  hideBtn.disabled = !selectionLayers().length
  hideBtn.addEventListener('click', hideSelectionLayers)
  const buttons = [zoomBtn, hideBtn]
  if (objs.length && layout !== 'plan' && viewer) {
    const b3 = document.createElement('button')
    b3.className = 'btn'
    b3.textContent = '3D で表示'
    b3.title = '3D で表示\n3D・立面・断面のウィンドウで、この図形に近寄って表示します。'
    b3.style.marginTop = '6px'
    b3.style.marginLeft = '6px'
    b3.addEventListener('click', () => {
      if (!selection || !viewer) return
      // the building would hide most equipment
      if (!opts3d.translucentMembers) setOpt3d('translucentMembers', true)
      viewer.focusEntity(current!.sheets[selection.sheet].layer, selection.entity)
      const p0 = viewer.panes.find((p) => p.kind === '3d') ?? viewer.panes[0]
      if (p0) linkFromPane(p0)
    })
    buttons.push(b3)
  }
  props.replaceChildren(table, ...buttons)
}

function padRect(b: Rect): Rect {
  const m = Math.max(b.x1 - b.x0, b.y1 - b.y0, 1) * 0.5
  return { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m }
}

// ---------------------------------------------------------------------------
// Overlay (selection, measurement, window zoom, snap marker)

function resizeOverlay() {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(overlay.clientWidth * dpr))
  const h = Math.max(1, Math.round(overlay.clientHeight * dpr))
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w
    overlay.height = h
  }
}

function drawOverlay() {
  resizeOverlay()
  const dpr = window.devicePixelRatio || 1
  octx.setTransform(1, 0, 0, 1, 0, 0)
  octx.clearRect(0, 0, overlay.width, overlay.height)
  if (!current) return
  const v = renderer.view
  const W = renderer.width
  const H = renderer.height
  const z = v.zoom * dpr
  const ex = (x: number) => dpr * (W / 2) + (x - v.cx) * z
  const ey = (y: number) => dpr * (H / 2) - (y - v.cy) * z
  const hl = options.background === 'white' ? '#e0007a' : '#ffd400'

  if (selection) {
    const s = current.sheets[selection.sheet]
    const p = selection.parts
    if (p.prims.length && p.bbox) {
      const ox = p.bbox.x0
      const oy = p.bbox.y0
      octx.setTransform(z, 0, 0, -z, ex(ox), ey(oy))
      octx.beginPath()
      const pts: number[] = []
      for (const i of p.prims) appendPrim(octx, s.geom.types[i], s.geom.flags[i], s.geom.coords, s.geom.offsets[i], s.geom.offsets[i + 1], ox, oy, undefined, pts)
      octx.lineCap = 'round'
      octx.lineJoin = 'round'
      octx.strokeStyle = options.background === 'white' ? 'rgba(224,0,122,0.25)' : 'rgba(255,212,0,0.35)'
      octx.lineWidth = (6 * dpr) / z
      octx.stroke()
      octx.strokeStyle = hl
      octx.lineWidth = (1.5 * dpr) / z
      octx.stroke()
      octx.setTransform(1, 0, 0, 1, 0, 0)
    }
    octx.strokeStyle = hl
    octx.lineWidth = 1.5 * dpr
    octx.setLineDash([4 * dpr, 3 * dpr])
    for (const t of p.texts) octx.strokeRect(ex(t.bbox.x0), ey(t.bbox.y1), ex(t.bbox.x1) - ex(t.bbox.x0), ey(t.bbox.y0) - ey(t.bbox.y1))
    for (const im of p.images) octx.strokeRect(ex(im.bbox.x0), ey(im.bbox.y1), ex(im.bbox.x1) - ex(im.bbox.x0), ey(im.bbox.y0) - ey(im.bbox.y1))
    octx.setLineDash([])
  }

  if ((tool === 'distance' || tool === 'area') && (measure.points.length || measure.snap)) {
    const pts = [...measure.points]
    if (!measure.done && measure.cursor && pts.length) pts.push(measure.cursor)
    const col = options.background === 'white' ? '#0060d0' : '#38e1ff'
    octx.strokeStyle = col
    octx.fillStyle = col
    octx.lineWidth = 1.5 * dpr
    if (pts.length) {
      octx.beginPath()
      pts.forEach(([x, y], i) => (i ? octx.lineTo(ex(x), ey(y)) : octx.moveTo(ex(x), ey(y))))
      if (tool === 'area' && pts.length > 2) {
        octx.closePath()
        octx.save()
        octx.globalAlpha = 0.18
        octx.fill()
        octx.restore()
      }
      octx.stroke()
      for (const [x, y] of measure.points) octx.fillRect(ex(x) - 2.5 * dpr, ey(y) - 2.5 * dpr, 5 * dpr, 5 * dpr)
      // segment lengths
      if (tool === 'distance') {
        octx.font = `${11 * dpr}px sans-serif`
        octx.textAlign = 'center'
        octx.textBaseline = 'bottom'
        for (let i = 1; i < pts.length; i++) {
          const [x0, y0] = pts[i - 1]
          const [x1, y1] = pts[i]
          const d = Math.hypot(x1 - x0, y1 - y0)
          const label = `${fmtNum(d)}`
          const mx = (ex(x0) + ex(x1)) / 2
          const my = (ey(y0) + ey(y1)) / 2
          const w = octx.measureText(label).width + 6 * dpr
          octx.fillStyle = 'rgba(0,0,0,0.65)'
          octx.fillRect(mx - w / 2, my - 15 * dpr, w, 14 * dpr)
          octx.fillStyle = '#fff'
          octx.fillText(label, mx, my - 2 * dpr)
        }
      }
    }
    const sn = measure.snap
    if (sn) {
      const sx = ex(sn.x)
      const sy = ey(sn.y)
      const r = 6 * dpr
      octx.strokeStyle = '#ff5ad1'
      octx.lineWidth = 1.5 * dpr
      octx.beginPath()
      if (sn.kind === 'end' || sn.kind === 'point') octx.rect(sx - r, sy - r, 2 * r, 2 * r)
      else if (sn.kind === 'mid') {
        octx.moveTo(sx, sy - r)
        octx.lineTo(sx + r, sy + r)
        octx.lineTo(sx - r, sy + r)
        octx.closePath()
      } else if (sn.kind === 'center') octx.arc(sx, sy, r, 0, Math.PI * 2)
      else {
        octx.moveTo(sx - r, sy - r)
        octx.lineTo(sx + r, sy + r)
        octx.moveTo(sx + r, sy - r)
        octx.lineTo(sx - r, sy + r)
      }
      octx.stroke()
    }
  }

  // section range (and the one being picked)
  const drawSection = (b: SectionBox, preview: boolean) => {
    const col = options.background === 'white' ? '#0077cc' : '#2ec5ff'
    const P = (s: number, t: number): [number, number] => [ex(b.o[0] + b.u[0] * b.lu * s + b.v[0] * b.lv * t), ey(b.o[1] + b.u[1] * b.lu * s + b.v[1] * b.lv * t)]
    octx.strokeStyle = col
    octx.fillStyle = col
    octx.lineWidth = 2.5 * dpr
    octx.setLineDash(preview ? [4 * dpr, 4 * dpr] : [10 * dpr, 5 * dpr])
    octx.beginPath()
    ;[P(0, 0), P(1, 0), P(1, 1), P(0, 1)].forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y)))
    octx.closePath()
    octx.save()
    octx.globalAlpha = 0.18
    octx.fill()
    octx.restore()
    octx.stroke()
    octx.setLineDash([])
    // cut line (正面 looks from it toward +v) with the viewing direction
    octx.lineWidth = 2.5 * dpr
    octx.beginPath()
    octx.moveTo(...P(0, 0))
    octx.lineTo(...P(1, 0))
    octx.stroke()
    const [mx, my] = P(0.5, 0)
    const vx = b.v[0]
    const vy = -b.v[1]
    const L = 26 * dpr
    octx.lineWidth = 2 * dpr
    octx.beginPath()
    octx.moveTo(mx, my)
    octx.lineTo(mx + vx * L, my + vy * L)
    octx.moveTo(mx + vx * L, my + vy * L)
    octx.lineTo(mx + vx * L * 0.7 - vy * L * 0.25, my + vy * L * 0.7 + vx * L * 0.25)
    octx.moveTo(mx + vx * L, my + vy * L)
    octx.lineTo(mx + vx * L * 0.7 + vy * L * 0.25, my + vy * L * 0.7 - vx * L * 0.25)
    octx.stroke()
    octx.font = `${11 * dpr}px sans-serif`
    octx.textAlign = 'center'
    octx.textBaseline = 'middle'
    octx.fillText('正面', mx - vx * 14 * dpr, my - vy * 14 * dpr)
  }
  if (section && current.view === null) drawSection(section, false)
  if (tool === 'section' || tool === 'section-line') {
    const pts = [...sectionPick.points]
    if (sectionPick.cursor) pts.push(sectionPick.cursor)
    const b = sectionBox(pts)
    if (b) drawSection(b, true)
    else if (pts.length === 2) {
      octx.strokeStyle = options.background === 'white' ? '#0077cc' : '#2ec5ff'
      octx.lineWidth = 2 * dpr
      octx.beginPath()
      octx.moveTo(ex(pts[0][0]), ey(pts[0][1]))
      octx.lineTo(ex(pts[1][0]), ey(pts[1][1]))
      octx.stroke()
    }
    const sn = measure.snap
    if (sn) {
      octx.strokeStyle = '#ff5ad1'
      octx.lineWidth = 1.5 * dpr
      octx.strokeRect(ex(sn.x) - 6 * dpr, ey(sn.y) - 6 * dpr, 12 * dpr, 12 * dpr)
    }
  }

  if (windowDrag) {
    const { x0, y0, x1, y1 } = windowDrag
    octx.strokeStyle = options.background === 'white' ? '#0060d0' : '#ffffff'
    octx.lineWidth = dpr
    octx.setLineDash([5 * dpr, 4 * dpr])
    octx.strokeRect(Math.min(x0, x1) * dpr, Math.min(y0, y1) * dpr, Math.abs(x1 - x0) * dpr, Math.abs(y1 - y0) * dpr)
    octx.setLineDash([])
  }
}

// ---------------------------------------------------------------------------
// Side panel: sheets, info, search

const PAPER_SIZES: [string, number, number][] = [
  ['A0', 1189, 841],
  ['A1', 841, 594],
  ['A2', 594, 420],
  ['A3', 420, 297],
  ['A4', 297, 210],
]

function paperName(w: number, h: number): string {
  const [a, b] = w >= h ? [w, h] : [h, w]
  const hit = PAPER_SIZES.find(([, x, y]) => Math.abs(x - a) < 2 && Math.abs(y - b) < 2)
  return `${hit ? hit[0] + ' ' : ''}${Math.round(w)}×${Math.round(h)} mm`
}

function showTab(name: string) {
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name))
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name))
  if (document.body.classList.contains('no-side')) setPanel('side', true)
}

function renderInfo() {
  if (!current) return
  const { doc, entry } = current
  const pw = (doc.paper.x1 - doc.paper.x0) / doc.scale
  const ph = (doc.paper.y1 - doc.paper.y0) / doc.scale
  const images = doc.layers.reduce((a, l) => a + l.images.length, 0)
  const rows: [string, string][] = [
    ['ファイル', entry.name],
    ['形式', `Tfas ${doc.version}`],
    ['縮尺', `1/${doc.scale}`],
    ['用紙', paperName(pw, ph)],
    ['シート', `${doc.layers.filter((l) => l.visible).length} / ${doc.layers.length} 表示`],
    ['図形', doc.stats.primitives.toLocaleString()],
    ['文字', doc.stats.texts.toLocaleString()],
    ['レイアウト', doc.layouts.length ? `${doc.layouts.length}` : 'なし'],
    ...floorRows(doc),
    ...(doc.functions.length ? ([['文字関数', doc.functions.map((f) => f.name).join(', ')]] as [string, string][]) : []),
    ...(images ? ([['画像・OLE', `${images}`]] as [string, string][]) : []),
    ['解析', `${doc.stats.parseMs} ms`],
  ]
  const dl = document.createElement('dl')
  dl.className = 'info'
  for (const [k, v] of rows) {
    const dt = document.createElement('dt')
    dt.textContent = k
    dt.title = TERM_TIPS[k] ?? ''
    const dd = document.createElement('dd')
    dd.textContent = v
    dl.append(dt, dd)
  }
  info.classList.remove('muted')
  info.replaceChildren(dl)

  if (doc.thumbnail) {
    thumb.hidden = false
    thumb.width = doc.thumbnail.width
    thumb.height = doc.thumbnail.height
    thumb.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(doc.thumbnail.rgba), doc.thumbnail.width, doc.thumbnail.height), 0, 0)
    thumb.title = 'ファイル内蔵プレビュー'
  } else thumb.hidden = true

  const warnings = [...doc.warnings]
  current.xref.forEach((state, i) => {
    const x = doc.layers[i].xref
    if (state === 'missing' && x) warnings.push(`外部参照「${x.fileName}」が未読込のためシート「${doc.layers[i].name}」は空です。同じファイルを一緒に開くと表示されます。`)
  })
  warnSection.hidden = !warnings.length
  warnList.replaceChildren(
    ...warnings.map((w) => {
      const li = document.createElement('li')
      li.textContent = w
      return li
    }),
  )
}

function sheetState(i: number): string {
  const l = current!.doc.layers[i]
  if (!current!.sheetVisible[i]) return '非表示'
  return l.editable ? '編集' : '表示'
}

function sheetColor(i: number): string {
  const c = current!.doc.layers[i]
  if (c.color.mode === 'gray') return '#a0a0a0'
  if (c.monoColor) return colorCss(c.monoColor)
  return 'transparent'
}

function layoutName(id: string | null): string {
  if (!id) return 'モデル'
  return current?.doc.layouts.find((l) => l.id === id)?.name ?? id
}

function renderSheets() {
  if (!current) return
  const { doc, sheetVisible, xref } = current
  const q = sheetFilter.value.trim().toLowerCase()
  sheetList.replaceChildren(
    ...current.groups
      .map((i) => doc.layers[i])
      .filter((l) => !q || l.name.toLowerCase().includes(q))
      .map((l) => {
        const i = l.index
        const li = document.createElement('li')
        li.className = `${i === current!.currentSheet ? 'current' : ''} ${sheetVisible[i] ? '' : 'hidden-sheet'}`
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = sheetVisible[i]
        cb.title = '表示 / 非表示\nチェックを外すと、このシートの図形を隠します。'
        cb.addEventListener('click', (e) => e.stopPropagation())
        cb.addEventListener('change', () => setSheetVisible(i, cb.checked))
        const sw = document.createElement('span')
        sw.className = 'swatch'
        sw.style.background = sheetColor(i)
        if (sheetColor(i) === 'transparent') sw.style.visibility = 'hidden'
        sw.title =
          l.color.mode === 'gray'
            ? 'グレー表示\nこのシートを灰色で表示する設定です (下図などを目立たなくするため)。'
            : l.monoColor
              ? `単色指定 (色 ${l.monoColor})\nこのシートの図形を 1 色で表示する設定です (下図などを目立たなくするため)。${i === current!.currentSheet ? 'カレントシートなので本来の色で表示しています。' : 'カレントシートにすると本来の色で表示されます。'}`
              : ''
        const name = document.createElement('span')
        name.className = 'name'
        name.textContent = l.name || `(${i})`
        li.title = sheetTip(l.name, l.scale, sheetState(i), i === current!.currentSheet)
        li.append(cb, sw, name)
        if (l.xref) {
          const b = document.createElement('span')
          b.className = `badge ${xref[i] === 'ok' ? 'ok' : 'warn'}`
          b.textContent = '参照'
          b.title = `外部参照\n別のファイル ${l.xref.directory}${l.xref.fileName} のシート「${l.xref.layerName}」を取り込んで表示します (図枠などに使われます)。${xref[i] === 'ok' ? '' : '\nそのファイルが読み込まれていないため空です。一緒に開くと表示されます。'}`
          li.append(b)
        }
        if (l.layout?.viewport) {
          const b = document.createElement('span')
          b.className = 'badge'
          b.textContent = 'ビューポート'
          b.title = `ビューポート\nレイアウト (印刷用の用紙) の上で、モデルの一部を切り取って表示する枠を持つシートです。\n${l.layout.showSheets ? `表示するシート: ${l.layout.showSheets.join(', ')}` : 'すべてのシートを表示'}`
          li.append(b)
        }
        const sc = document.createElement('span')
        sc.className = 'scale'
        sc.textContent = `1/${l.scale}`
        li.append(sc)
        li.addEventListener('click', () => setCurrentSheet(i))
        li.addEventListener('dblclick', () => zoomSheet(i))
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          sheetMenu(i, e.clientX, e.clientY)
        })
        return li
      }),
  )
  renderSheetTabs()
}

function renderSheetTabs() {
  if (!current) return
  const { doc, sheetVisible, xref } = current
  sheetTabs.replaceChildren(
    ...current.groups.map((i) => {
      const l = doc.layers[i]
      const t = document.createElement('div')
      t.className = `sheet-tab${i === current!.currentSheet ? ' current' : ''}${sheetVisible[i] ? '' : ' off'}${xref[i] ? ' xref' : ''}`
      t.textContent = l.name || `(${i})`
      t.title = sheetTip(l.name, l.scale, sheetState(i), i === current!.currentSheet)
      t.addEventListener('click', () => setCurrentSheet(i))
      t.addEventListener('dblclick', () => zoomSheet(i))
      t.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        sheetMenu(i, e.clientX, e.clientY)
      })
      return t
    }),
  )
  const i = current.currentSheet
  const l = doc.layers[i]
  const sw = document.createElement('span')
  sw.className = 'swatch'
  sw.style.background = l ? sheetColor(i) : 'transparent'
  if (!l || sheetColor(i) === 'transparent') sw.style.visibility = 'hidden'
  const name = document.createElement('span')
  name.textContent = l ? l.name || `(${i})` : '—'
  const sc = document.createElement('span')
  sc.className = 'scale'
  sc.textContent = l ? `1/${l.scale}  ${sheetState(i)}` : ''
  currentSheetBtn.replaceChildren(sw, name, sc)
  sheetTabs.children[current.groups.indexOf(i)]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function setCurrentSheet(i: number) {
  if (!current) return
  current.currentSheet = i
  refreshColors()
  renderSheets()
}

function applyVisibility() {
  if (!current) return
  current.sheets.forEach((s) => (current!.visible[s.index] = current!.sheetVisible[s.group]))
  if (selection && !current.visible[selection.sheet]) clearSelection()
  viewer?.setVisibility(current.sheetVisible)
  sendPopup({ type: 'visibility', visible: current.sheetVisible })
  renderSheets()
  runSearch()
  renderer.requestRender()
}

function setSheetVisible(i: number, on: boolean) {
  if (!current) return
  current.sheetVisible[i] = on
  applyVisibility()
}

function setAllSheets(mode: 'all' | 'none' | 'reset' | number) {
  if (!current) return
  for (const i of current.groups) current.sheetVisible[i] = mode === 'all' ? true : mode === 'none' ? false : mode === 'reset' ? current.doc.layers[i].visible : i === mode
  applyVisibility()
}

function zoomSheet(i: number) {
  if (!current) return
  let b: Rect | null = null
  for (const s of current.sheets) if (s.group === i && s.bbox) b = b ? unionRect(b, s.bbox) : s.bbox
  if (!b) return
  if (!current.sheetVisible[i]) setSheetVisible(i, true)
  fitTo(b)
}

function sheetMenu(i: number, x: number, y: number) {
  const on = current!.sheetVisible[i]
  showContextMenu(x, y, [
    [on ? '非表示にする' : '表示する', () => setSheetVisible(i, !on)],
    ['このシートのみ表示', () => setAllSheets(i)],
    ['すべて表示', () => setAllSheets('all')],
    ['初期状態に戻す', () => setAllSheets('reset')],
    null,
    ['カレントシートにする', () => setCurrentSheet(i)],
    ['このシートの範囲を表示', () => zoomSheet(i), !current!.sheets.some((s) => s.group === i && s.bbox)],
  ])
}

function renderLayouts() {
  if (!current) return
  const { doc } = current
  const opts = [['model', 'モデル'], ...doc.layouts.map((l) => [l.id, l.name || l.id])]
  rangeSelect.replaceChildren(
    ...opts.map(([v, t]) => {
      const o = document.createElement('option')
      o.value = v
      o.textContent = t
      return o
    }),
  )
  rangeSelect.disabled = !doc.layouts.length
}

// text search
interface SearchHit {
  sheet: number
  text: TextItem
}
let searchHits: SearchHit[] = []
let searchPos = -1

function runSearch() {
  searchHits = []
  searchPos = -1
  const q = searchInput.value.trim()
  if (!current || !q) {
    searchSummary.textContent = q ? '' : '図面内の文字を検索します'
    searchResults.replaceChildren()
    return
  }
  const nq = q.normalize('NFKC').toLowerCase()
  for (const s of current.sheets) for (const t of s.texts) if (t.text.normalize('NFKC').toLowerCase().includes(nq)) searchHits.push({ sheet: s.index, text: t })
  searchHits.sort((a, b) => a.sheet - b.sheet)
  searchSummary.textContent = `${searchHits.length.toLocaleString()} 件${searchHits.length > 500 ? ' (先頭 500 件を表示)' : ''}`
  searchResults.replaceChildren(
    ...searchHits.slice(0, 500).map((h, k) => {
      const li = document.createElement('li')
      const main = document.createElement('span')
      const text = h.text.text.replace(/\n/g, ' ')
      const at = text.normalize('NFKC').toLowerCase().indexOf(nq)
      if (at >= 0 && text.length === text.normalize('NFKC').length) {
        const mark = document.createElement('mark')
        mark.textContent = text.slice(at, at + q.length)
        main.append(text.slice(0, at), mark, text.slice(at + q.length))
      } else main.textContent = text
      const sub = document.createElement('span')
      sub.className = 'sub'
      const piece = current!.sheets[h.sheet]
      sub.textContent = `${current!.doc.layers[piece.group].name}${piece.group !== piece.layer ? ` › ${current!.doc.layers[piece.layer].name}` : ''}${current!.visible[h.sheet] ? '' : ' (非表示)'}`
      li.append(main, sub)
      li.addEventListener('click', () => gotoHit(k))
      return li
    }),
  )
}

function gotoHit(k: number) {
  if (!current || !searchHits.length) return
  searchPos = ((k % searchHits.length) + searchHits.length) % searchHits.length
  const h = searchHits[searchPos]
  if (!current.visible[h.sheet]) setSheetVisible(current.sheets[h.sheet].group, true)
  select(h.sheet, h.text.entity)
  const b = h.text.bbox
  const m = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 4
  fitTo({ x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m }, 0)
  ;[...searchResults.children].forEach((li, i) => li.classList.toggle('active', i === searchPos))
  searchResults.children[searchPos]?.scrollIntoView({ block: 'nearest' })
}

// ---------------------------------------------------------------------------
// Menus, context menu, commands

type MenuItem = [string, () => void, boolean?] | null

/** Context menu labels -> the matching command's tooltip. */
const MENU_TIPS = new Map([...Object.values(CMD_TIPS).map((t): [string, string] => [t.split('\n')[0].replace(/\s*\(.*\)$/, ''), t]), ...Object.entries(MENU_ITEM_TIPS)])

function showContextMenu(x: number, y: number, items: MenuItem[]) {
  contextMenu.replaceChildren(
    ...items.map((it) => {
      if (!it) return document.createElement('hr')
      const b = document.createElement('button')
      b.textContent = it[0]
      b.title = MENU_TIPS.get(it[0]) ?? (it[0].endsWith('グループのみ表示') ? 'このレイヤグループ (基本・建築・電気・空調・衛生など) のレイヤだけを表示します。' : '')
      b.disabled = !!it[2]
      b.addEventListener('click', () => {
        hideContextMenu()
        it[1]()
      })
      return b
    }),
  )
  contextMenu.hidden = false
  const r = contextMenu.getBoundingClientRect()
  contextMenu.style.left = `${Math.min(x, window.innerWidth - r.width - 4)}px`
  contextMenu.style.top = `${Math.min(y, window.innerHeight - r.height - 4)}px`
}

function hideContextMenu() {
  contextMenu.hidden = true
}

function closeMenus() {
  document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'))
}

function canvasMenu(x: number, y: number) {
  const has = !!current
  const items: MenuItem[] = []
  if (tool === 'distance' || tool === 'area') {
    items.push(['計測を確定', finishMeasure, measure.points.length < 2], ['計測をやり直す', () => setTool(tool)], ['計測を終了', () => setTool('select')], null)
  }
  if (tool === 'section' || tool === 'section-line') items.push(['断面の指定を中止', () => setTool('select')], null)
  if (section) items.push(['断面を解除', () => applySection(null)], null)
  items.push(
    ['全体表示', fitAll, !has],
    ['用紙範囲', fitPaper, !has],
    ['窓拡大', () => setTool('zoom-window'), !has],
    ['前画面', prevView, !history.length],
    null,
    ['距離計測', () => setTool('distance'), !has],
    ['面積計測', () => setTool('area'), !has],
    ['クイック断面', () => startSectionTool('section'), !has],
    ['断面線', () => startSectionTool('section-line'), !has],
    ['選択解除', clearSelection, !selection],
  )
  if (selection) items.push(['選択図形のシートのみ表示', () => setAllSheets(current!.sheets[selection!.sheet].group)], ['選択図形のレイヤのみ表示', () => showOnlyLayers(selectionLayers())], ['選択図形のレイヤを非表示', hideSelectionLayers])
  if (current?.hiddenLayers.size) items.push(['すべてのレイヤを表示', () => setLayersVisible(current!.doc.attributes.map((a) => a.id), true)])
  showContextMenu(x, y, items)
}

const commands: Record<string, () => void> = {
  open: () => fileInput.click(),
  'open-folder': () => folderInput.click(),
  print: printRange,
  'export-svg': exportSvg,
  'export-png': exportPng,
  'fit-all': () => (activePane ? fitPane3d(activePane) : fitAll()),
  'fit-paper': fitPaper,
  'zoom-window': () => setTool('zoom-window'),
  'prev-view': prevView,
  'zoom-in': () => (activePane ? viewer?.zoomAt(activePane, activePane.width / 2, activePane.height / 2, 1 / 1.5) : zoomBy(1.5)),
  'zoom-out': () => (activePane ? viewer?.zoomAt(activePane, activePane.width / 2, activePane.height / 2, 1.5) : zoomBy(1 / 1.5)),
  'view-3d': () => setLayout(layout === 'plan' ? 'plan-3d' : 'plan'),
  'layout-plan': () => setLayout('plan'),
  'layout-plan-3d': () => setLayout('plan-3d'),
  'layout-3d': () => setLayout('3d'),
  'layout-quad': () => setLayout('quad'),
  'layout-reset': () => paneGrid.reset(),
  section: () => startSectionTool('section'),
  'section-line': () => startSectionTool('section-line'),
  'section-clear': () => applySection(null),
  'popup-3d': openPopup,
  'tool-select': () => setTool('select'),
  'tool-distance': () => setTool('distance'),
  'tool-area': () => setTool('area'),
  search: () => {
    showTab('search')
    searchInput.focus()
    searchInput.select()
  },
  'clear-selection': clearSelection,
  'parts-open': () => fileInput.click(),
  'parts-panel': () => showTab('parts'),
  help: () => $<HTMLDialogElement>('help-dialog').showModal(),
  install: async () => {
    await promptInstall()
    setInstallable(false)
  },
}

function run(cmd: string) {
  closeMenus()
  hideContextMenu()
  commands[cmd]?.()
}

document.querySelectorAll<HTMLElement>('[data-cmd]').forEach((el) => el.addEventListener('click', () => run(el.dataset.cmd!)))
document.querySelectorAll<HTMLButtonElement>('[data-needs-doc]').forEach((b) => (b.disabled = true))

// menu bar: click to open, hover switches while one is open
document.querySelectorAll<HTMLElement>('.menu').forEach((m) => {
  const title = m.querySelector('.menu-title')!
  title.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = m.classList.contains('open')
    closeMenus()
    if (!open) m.classList.add('open')
  })
  title.addEventListener('mouseenter', () => {
    if (document.querySelector('.menu.open') && !m.classList.contains('open')) {
      closeMenus()
      m.classList.add('open')
    }
  })
  m.querySelector('.menu-items')!.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('label')) e.stopPropagation()
  })
})
window.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.menu')) closeMenus()
  if (!(e.target as HTMLElement).closest('.context-menu')) hideContextMenu()
})

// display options (toolbar and menu checkboxes stay in sync)
const OPTION_SETTERS: Record<string, (on: boolean) => void> = {
  color: (on) => (options.colorMode = on ? 'color' : 'mono'),
  black: (on) => {
    options.background = on ? 'black' : 'white'
    viewer?.setOptions({ background: options.background })
    sendPopup({ type: 'options', options: { background: options.background } })
  },
  weight: (on) => (options.lineWeights = on),
  text: (on) => (options.showText = on),
  aux: (on) => (options.showAux = on),
  sheets: (on) => (options.showSheets = on),
}
document.querySelectorAll<HTMLInputElement>('[data-opt]').forEach((el) =>
  el.addEventListener('change', () => {
    const key = el.dataset.opt!
    OPTION_SETTERS[key](el.checked)
    document.querySelectorAll<HTMLInputElement>(`[data-opt="${key}"]`).forEach((o) => (o.checked = el.checked))
    renderer.requestRender()
  }),
)
// screen areas that can be hidden: body class no-<name> (remembered per browser)
const PANELS = ['toolbar', 'side', 'props', 'sheetbar', 'status'] as const
const PANEL_KEY = 'tfas-viewer.hidden-panels'
function setPanel(name: string, on: boolean) {
  document.body.classList.toggle(`no-${name}`, !on)
  syncPanelChecks()
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify(PANELS.filter((p) => document.body.classList.contains(`no-${p}`))))
  } catch {
    // storage unavailable (private mode etc.): not remembered
  }
  renderer.requestRender()
}
try {
  const saved = JSON.parse(localStorage.getItem(PANEL_KEY) ?? '[]') as string[]
  for (const p of saved) if ((PANELS as readonly string[]).includes(p)) document.body.classList.add(`no-${p}`)
} catch {
  // ignore unreadable settings
}
document.querySelectorAll<HTMLInputElement>('input[data-panel]').forEach((el) => el.addEventListener('change', () => setPanel(el.dataset.panel!, el.checked)))
/** Set a 3D option (menu and window header checkboxes stay in sync). */
function setOpt3d(key: string, on: boolean) {
  document.querySelectorAll<HTMLInputElement>(`[data-opt3d="${key}"]`).forEach((o) => (o.checked = on))
  if (key === 'link' || key === 'linkPosition' || key === 'linkZoom') {
    if (key !== 'linkZoom') linkPosition = on
    if (key !== 'linkPosition') linkZoom = on
    document.querySelectorAll<HTMLInputElement>('[data-opt3d="linkPosition"]').forEach((o) => (o.checked = linkPosition))
    document.querySelectorAll<HTMLInputElement>('[data-opt3d="linkZoom"]').forEach((o) => (o.checked = linkZoom))
    document.querySelectorAll<HTMLInputElement>('[data-opt3d="link"]').forEach((o) => {
      o.checked = linkPosition && linkZoom
      o.indeterminate = linkPosition !== linkZoom
    })
    sendPopup({ type: 'link-mode', link: linkPosition || linkZoom })
    for (const p of viewer?.panes ?? []) paneSync.get(p)?.()
    linkFrom2d()
    return
  }
  ;(opts3d as Record<string, boolean>)[key] = on
  viewer?.setOptions({ [key]: on })
  sendPopup({ type: 'options', options: { [key]: on } })
  if (key === 'clip3d') syncSectionUi()
  if (key === 'partViews') renderProps()
}
document.querySelectorAll<HTMLInputElement>('[data-opt3d]').forEach((el) => el.addEventListener('change', () => setOpt3d(el.dataset.opt3d!, el.checked)))
layoutSelect.addEventListener('change', () => {
  const l = layoutSelect.value as Layout
  // choosing a section expansion here also makes it the クイック断面 setting
  if (l === 'section2' || l === 'section4') document.querySelectorAll<HTMLInputElement>('input[name="section-mode"]').forEach((r) => (r.checked = r.value === l))
  void setLayout(l)
})

function syncPanelChecks() {
  document.querySelectorAll<HTMLInputElement>('input[data-panel]').forEach((el) => (el.checked = !document.body.classList.contains(`no-${el.dataset.panel}`)))
}

document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab!)))

$('layers-all').addEventListener('click', () => current && setLayersVisible(current.doc.attributes.map((a) => a.id), true))
$('layers-none').addEventListener('click', () => current && setLayersVisible(current.doc.attributes.map((a) => a.id), false))
$('layers-selected').addEventListener('click', () => showOnlyLayers(selectionLayers()))
$('layers-hide-selected').addEventListener('click', hideSelectionLayers)
layerFilter.addEventListener('input', renderLayers)
layersUsed.addEventListener('change', renderLayers)
$('sheets-all').addEventListener('click', () => setAllSheets('all'))
$('sheets-none').addEventListener('click', () => setAllSheets('none'))
$('sheets-reset').addEventListener('click', () => setAllSheets('reset'))
sheetFilter.addEventListener('input', renderSheets)
currentSheetBtn.addEventListener('click', () => {
  if (current) showTab('sheets')
})
document.querySelectorAll<HTMLButtonElement>('[data-scroll]').forEach((b) =>
  b.addEventListener('click', () => {
    const step = sheetTabs.clientWidth * 0.6
    const k = b.dataset.scroll
    sheetTabs.scrollLeft = k === 'first' ? 0 : k === 'last' ? sheetTabs.scrollWidth : sheetTabs.scrollLeft + (k === 'next' ? step : -step)
  }),
)
sheetTabs.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    sheetTabs.scrollLeft += e.deltaY + e.deltaX
  },
  { passive: false },
)

let searchTimer = 0
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = window.setTimeout(runSearch, 200)
})
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (searchPos < 0 || searchInput.value.trim() !== (searchInput.dataset.last ?? '')) {
      runSearch()
      searchInput.dataset.last = searchInput.value.trim()
    }
    gotoHit(searchPos + (e.shiftKey ? -1 : 1))
  }
})

fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) addFiles([...fileInput.files])
  fileInput.value = ''
})
folderInput.addEventListener('change', () => {
  if (folderInput.files?.length) addFiles([...folderInput.files])
  folderInput.value = ''
})
fileSelect.addEventListener('change', () => {
  const e = library.get(fileSelect.value)
  if (e) openEntry(e)
})
rangeSelect.addEventListener('change', () => {
  if (current) showView(rangeSelect.value === 'model' ? null : rangeSelect.value)
})

// ---------------------------------------------------------------------------
// Output

function visibleSvgLayers(): SvgLayer[] {
  return current!.sheets.filter((s) => current!.visible[s.index]).map((s) => ({ geom: s.geom, texts: s.texts, images: s.images, color: s.color, clip: s.clip }))
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

const baseName = () => current!.entry.name.replace(/\.tfs$/i, '')

function exportSvg() {
  if (!current) return
  const v = renderer.view
  const w = renderer.width / v.zoom
  const h = renderer.height / v.zoom
  const win = { x0: v.cx - w / 2, x1: v.cx + w / 2, y0: v.cy - h / 2, y1: v.cy + h / 2 }
  const svg = toSvg(current.doc, visibleSvgLayers(), { ...options, window: win, widthPx: Math.round(renderer.width * 2) })
  download(new Blob([svg], { type: 'image/svg+xml' }), `${baseName()}.svg`)
}

function exportPng() {
  if (!current) return
  const [base, over] = activePane ? [activePane.canvas, activePane.overlay] : [canvas, overlay]
  const out = document.createElement('canvas')
  out.width = base.width
  out.height = base.height
  const ctx = out.getContext('2d')!
  ctx.drawImage(base, 0, 0)
  if (over.width && over.height) ctx.drawImage(over, 0, 0, out.width, out.height)
  out.toBlob((b) => b && download(b, `${baseName()}${activePane ? `_${activePane.kindSelect.selectedOptions[0]?.text ?? '3D'}` : ''}.png`), 'image/png')
}

function printRange() {
  if (!current) return
  const r = current.paper
  const wmm = (r.x1 - r.x0) / current.doc.scale
  const hmm = (r.y1 - r.y0) / current.doc.scale
  const svg = toSvg(current.doc, visibleSvgLayers(), { ...options, background: 'white', window: r, widthPx: Math.round(Math.min(wmm * 6, 8000)), strokePx: 0.6 })
  printSvg(svg, wmm, hmm, current.entry.name)
}

// ---------------------------------------------------------------------------
// Status

function updateZoomLabel() {
  if (!current) return
  // 100% = paper at real size on a 96 dpi screen
  const pct = (renderer.view.zoom * current.doc.scale * 100) / (96 / 25.4)
  stZoom.textContent = `表示 ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })
}

// ---------------------------------------------------------------------------
// Pointer input

const pointers = new Map<number, { x: number; y: number }>()
let pinchDist = 0
let press: { x: number; y: number; button: number; moved: boolean; pan: boolean } | null = null

canvas.addEventListener('contextmenu', (e) => e.preventDefault())
canvas.addEventListener('pointerdown', (e) => {
  hideContextMenu()
  closeMenus()
  setActivePane(null)
  canvas.setPointerCapture(e.pointerId)
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY })
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
    press = null
    return
  }
  press = { x: e.offsetX, y: e.offsetY, button: e.button, moved: false, pan: e.button !== 0 || tool === 'select' }
  if (tool === 'zoom-window' && e.button === 0) windowDrag = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY }
})

canvas.addEventListener('pointermove', (e) => {
  if (current) {
    const [x, y] = renderer.screenToModel(e.offsetX, e.offsetY)
    stPos.textContent = `X ${fmt(x)}  Y ${fmt(y)}`
    stPos.title = `用紙上 ${fmt((x - current.doc.paper.x0) / current.doc.scale)}, ${fmt((y - current.doc.paper.y0) / current.doc.scale)} mm`
  }
  const p = pointers.get(e.pointerId)
  if (p && pointers.size === 2) {
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY })
    const [a, b] = [...pointers.values()]
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    if (pinchDist > 0) renderer.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist)
    pinchDist = d
    return
  }
  if (p && press) {
    if (!press.moved && Math.hypot(e.offsetX - press.x, e.offsetY - press.y) > 4) {
      press.moved = true
      if (!windowDrag) viewGesture()
      if (press.pan) canvas.classList.add('dragging')
    }
    if (windowDrag) {
      windowDrag.x1 = e.offsetX
      windowDrag.y1 = e.offsetY
      drawOverlay()
    } else if (press.moved && (press.pan || tool !== 'zoom-window')) {
      canvas.classList.add('dragging')
      renderer.panBy(e.offsetX - p.x, e.offsetY - p.y)
    }
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY })
    return
  }
  if ((tool === 'distance' || tool === 'area') && current) {
    measure.cursor = measurePoint(e.offsetX, e.offsetY, e.shiftKey)
    if (measure.done) measure.cursor = null
    drawOverlay()
  }
  if ((tool === 'section' || tool === 'section-line') && current) {
    sectionPick.cursor = measurePoint(e.offsetX, e.offsetY, e.shiftKey)
    drawOverlay()
  }
})

const release = (e: PointerEvent) => {
  pointers.delete(e.pointerId)
  pinchDist = 0
  canvas.classList.remove('dragging')
  const pr = press
  press = null
  if (!pr || e.type === 'pointercancel') return
  if (windowDrag) {
    const w = windowDrag
    windowDrag = null
    if (Math.abs(w.x1 - w.x0) > 6 && Math.abs(w.y1 - w.y0) > 6) {
      const [x0, y0] = renderer.screenToModel(Math.min(w.x0, w.x1), Math.max(w.y0, w.y1))
      const [x1, y1] = renderer.screenToModel(Math.max(w.x0, w.x1), Math.min(w.y0, w.y1))
      fitTo({ x0, y0, x1, y1 }, 0)
      setTool('select')
    }
    drawOverlay()
    return
  }
  if (pr.moved) return
  if (pr.button === 2) {
    if (tool === 'select' && current) {
      const [x, y] = renderer.screenToModel(e.offsetX, e.offsetY)
      const hit = current.picker.pick(x, y, 6 / renderer.view.zoom, (i) => current!.visible[i], options.showAux || false)
      if (hit) select(hit.layer, hit.entity)
    }
    canvasMenu(e.clientX, e.clientY)
    return
  }
  if (pr.button !== 0 || !current) return
  onClick(e.offsetX, e.offsetY, e.shiftKey)
}
canvas.addEventListener('pointerup', release)
canvas.addEventListener('pointercancel', release)

function onClick(sx: number, sy: number, shift: boolean) {
  if (!current) return
  if (tool === 'distance' || tool === 'area') {
    if (measure.done) {
      measure.points = []
      measure.done = false
    }
    measure.points.push(measurePoint(sx, sy, shift))
    renderMeasure()
    drawOverlay()
    return
  }
  if (tool === 'section' || tool === 'section-line') {
    sectionPick.points.push(measurePoint(sx, sy, shift))
    const need = tool === 'section' ? 2 : 3
    if (sectionPick.points.length >= need) {
      const b = sectionBox(sectionPick.points)
      if (b) {
        setTool('select')
        applySection(b)
      } else sectionPick.points = []
    }
    drawOverlay()
    return
  }
  if (tool !== 'select') return
  const [x, y] = renderer.screenToModel(sx, sy)
  const hit = current.picker.pick(x, y, 6 / renderer.view.zoom, (i) => current!.visible[i], options.showAux || false)
  if (hit) select(hit.layer, hit.entity)
  else clearSelection()
}

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    viewGesture()
    const k = e.deltaMode === 1 ? 40 : 1
    renderer.zoomAt(e.offsetX, e.offsetY, Math.pow(1.0015, -e.deltaY * k))
  },
  { passive: false },
)

canvas.addEventListener('dblclick', (e) => {
  if (tool === 'distance' || tool === 'area') {
    finishMeasure()
    return
  }
  if (tool === 'select' && current) {
    const [x, y] = renderer.screenToModel(e.offsetX, e.offsetY)
    if (!current.picker.pick(x, y, 6 / renderer.view.zoom, (i) => current!.visible[i], options.showAux)) fitPaper()
  }
})

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement
  // text entry keeps its keys; checkboxes and buttons do not swallow the shortcuts
  const typing = (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type)) || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.key.toLowerCase() === 'o') {
    e.preventDefault()
    run('open')
    return
  }
  if (ctrl && e.key.toLowerCase() === 'p') {
    e.preventDefault()
    run('print')
    return
  }
  if (ctrl && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    run('search')
    return
  }
  // Ctrl+PageUp/Down as in Tfas (browsers may keep it for tab switching: Alt+PageUp/Down works too)
  if ((ctrl || e.altKey) && (e.key === 'PageUp' || e.key === 'PageDown') && current) {
    e.preventDefault()
    const g = current.groups
    const k = g.indexOf(current.currentSheet)
    if (g.length) setCurrentSheet(g[(k + (e.key === 'PageUp' ? -1 : 1) + g.length) % g.length])
    return
  }
  if (typing) {
    if (e.key === 'Escape') target.blur()
    return
  }
  if (e.key === 'Escape') {
    // with a menu open, Esc only closes it
    const menuOpen = !contextMenu.hidden || !!document.querySelector('.menu.open')
    hideContextMenu()
    closeMenus()
    if (menuOpen) return
    if (tool !== 'select') setTool('select')
    else if (selection) clearSelection()
    else if (section) applySection(null)
  } else if (e.key === 'Enter') finishMeasure()
  else if (e.key === 'f' || e.key === 'F') run('fit-all')
  else if (e.key === 'p' || e.key === 'P') run('fit-paper')
  else if (e.key === 'w' || e.key === 'W') run('zoom-window')
  else if (e.key === 'd' || e.key === 'D') run('tool-distance')
  else if (e.key === 'a' || e.key === 'A') run('tool-area')
  else if (e.key === 'Backspace') {
    e.preventDefault()
    run('prev-view')
  } else if (e.key === '+' || e.key === '=') run('zoom-in')
  else if (e.key === '-') run('zoom-out')
})

new ResizeObserver(() => {
  renderer.requestRender()
  resizeOverlay()
  drawOverlay()
}).observe(canvas)

// drag & drop (files and folders)
async function collectDropped(dt: DataTransfer): Promise<File[]> {
  const items = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x)
  if (!items.length) return [...dt.files]
  const out: File[] = []
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)))
    else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const c of batch) await walk(c)
      }
    }
  }
  for (const it of items) await walk(it)
  return out
}

window.addEventListener('dragover', (e) => {
  e.preventDefault()
  document.body.classList.add('dragover')
})
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragover')
})
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  document.body.classList.remove('dragover')
  if (!e.dataTransfer) return
  const files = await collectDropped(e.dataTransfer)
  if (files.length) addFiles(files)
})

// ?file=path/to/a.tfs&file=path/to/frame.tfs opens files served next to the viewer
// ?file=… (same origin only; values are already decoded by URLSearchParams)
const urlFiles = new URLSearchParams(location.search).getAll('file').filter((u) => {
  try {
    return new URL(u, location.href).origin === location.origin
  } catch {
    return false
  }
})
if (urlFiles.length) {
  const fetchFile = async (u: string) => {
    const res = await fetch(u)
    if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`)
    return res.arrayBuffer()
  }
  const name = (u: string) => u.split('/').pop() || u
  const partUrls = urlFiles.filter((u) => isPartsFile(name(u)))
  if (partUrls.length) {
    Promise.all(partUrls.map(async (u) => new File([await fetchFile(u)], name(u)))).then(async (files) => {
      await openPartsFiles(files)
      if (partUrls.length === urlFiles.length) showTab('parts')
    })
  }
  const entries = urlFiles.filter((u) => !isPartsFile(name(u))).map((u) => addEntry(name(u), () => fetchFile(u)))
  if (entries.length) openEntry(entries[0])
}

// installable app: offline use, files opened from the OS, install and update notices
function setInstallable(on: boolean) {
  document.querySelectorAll<HTMLElement>('[data-cmd="install"]').forEach((b) => (b.hidden = !on))
}
initPwa({
  openFiles: (files) => void addFiles(files),
  installable: setInstallable,
  updateReady: (apply) => {
    $('st-update').hidden = false
    $<HTMLButtonElement>('update-btn').onclick = apply
  },
})

initParts($('parts-panel'), { showTab })
onOpenPart((name, doc) => {
  const entry: Entry = { key: `part:${normName(name)}`, name, read: async () => new ArrayBuffer(0), doc: Promise.resolve(doc), part: true }
  library.set(entry.key, entry)
  openEntry(entry)
})
setTool('select')
setHint()
applyStaticTips()
syncPanelChecks()
planPane.querySelector<HTMLElement>('.pane-name')!.title = PANE_TIPS.plan

// expose internals for debugging in development builds
if (import.meta.env.DEV)
  Object.assign(window, {
    __tfas: {
      renderer,
      get current() {
        return current
      },
      get selection() {
        return selection
      },
      get viewer() {
        return viewer
      },
      get layout() {
        return layout
      },
      run,
      select,
    },
  })
