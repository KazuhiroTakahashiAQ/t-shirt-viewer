// The 3D / elevation / section views in a separate browser window (Tfas: 3D 画面の
// ウィンドウの位置「フレーム外」). The main window sends the drawing and keeps sheet
// visibility, the section range, options, selection and 2D linking in sync.

import type { Model3D } from '../tfas/model3d.ts'
import type { TfasDocument } from '../tfas/model.ts'
import { OPT3D_TIPS, PANE_TIPS } from './help.ts'
import { PaneGrid } from './pane-grid.ts'
import { ParserClient } from './parser-client.ts'
import { VIEW_PRESETS, Viewer3D, type Options3D, type Pane, type PaneKind, type SectionBox, type ViewPreset } from './viewer3d.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const panesEl = $<HTMLDivElement>('panes')
const layoutSelect = $<HTMLSelectElement>('popup-layout')
const status = $<HTMLSpanElement>('popup-status')
const title = $<HTMLElement>('popup-title')
const empty = $<HTMLDivElement>('popup-empty')

const LAYOUTS: Record<string, PaneKind[]> = { '3d': ['3d'], trio: ['3d', 'front', 'right'], quad: ['3d', 'front', 'back', 'right'], elev: ['front', 'back', 'right', 'left'] }
/** window order and sizes (dragging the borders and title bars) */
const grid = new PaneGrid(panesEl, 'tfas-viewer.popup-pane-split', { split: PANE_TIPS.split, head: PANE_TIPS.headPopup })

const opener = window.opener as Window | null
const send = (m: object) => opener && !opener.closed && opener.postMessage(m, location.origin)

const parser = new ParserClient()
const request = <T extends TfasDocument | Model3D>(kind: 'doc' | '3d', name: string, buffer: ArrayBuffer) => parser.request<T>(kind, name, buffer)

let viewer: Viewer3D
try {
  viewer = new Viewer3D()
} catch (e) {
  empty.textContent = `3D 表示を開始できません: ${(e as Error).message}`
  throw e
}
let link = false
let selection: { sheet: number; entity: number } | null = null

viewer.events = {
  select: (_i, obj) => {
    selection = obj ? { sheet: obj.sheet, entity: obj.entity } : null
    viewer.highlightEntity(obj ? obj.sheet : null, obj?.entity ?? 0)
    send(obj ? { type: 'select', sheet: obj.sheet, entity: obj.entity } : { type: 'select' })
  },
  // elevation / section panes only move sideways: send their horizontal axis
  link: (x, y, upp, source) => link && send({ type: 'link', x, y, upp, axis: source.kind === '3d' ? undefined : [-Math.sin(source.cam.yaw), Math.cos(source.cam.yaw)] }),
  status: (t) => (status.textContent = t),
  hint: (t) => (status.textContent = t ?? ''),
  offsetChange: (p) => paneSync.get(p)?.(),
}

/** per window: refresh the header buttons */
const paneSync = new WeakMap<Pane, () => void>()
const syncPanes = () => viewer.panes.forEach((p) => paneSync.get(p)?.())

function addPane(kind: PaneKind): Pane {
  const p = viewer.createPane(kind)
  const preset = document.createElement('select')
  preset.title = PANE_TIPS.preset
  preset.add(new Option('視点…', ''))
  for (const [k, name] of VIEW_PRESETS) preset.add(new Option(name, k))
  preset.addEventListener('change', () => {
    if (preset.value) viewer.setPreset(p, preset.value as ViewPreset)
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
    viewer.fitPane(p)
  })
  persp.append(cb, '透視')
  const arch = document.createElement('label')
  arch.className = 'mini'
  arch.title = OPT3D_TIPS.translucentMembers
  const acb = document.createElement('input')
  acb.type = 'checkbox'
  acb.className = 'opt-translucent'
  acb.checked = viewer.options.translucentMembers
  acb.addEventListener('change', () => setTranslucent(acb.checked))
  arch.append(acb, '建築半透明')
  // parts as estimated from their views (5 面図) instead of boxes
  const shape = document.createElement('label')
  shape.className = 'mini'
  shape.title = OPT3D_TIPS.partViews
  const scb = document.createElement('input')
  scb.type = 'checkbox'
  scb.className = 'opt-partviews'
  scb.checked = viewer.options.partViews
  scb.addEventListener('change', () => {
    viewer.setOptions({ partViews: scb.checked })
    syncChecks()
  })
  shape.append(scb, '推定形状')
  const fit = document.createElement('button')
  fit.className = 'mini'
  fit.textContent = '全体'
  fit.title = PANE_TIPS.fit
  fit.addEventListener('click', () => viewer.fitPane(p))
  // ずれ調整: shift this window against the plan while 2D linking is on
  const adjust = document.createElement('button')
  adjust.className = 'mini'
  adjust.textContent = 'ずれ調整'
  adjust.title = PANE_TIPS.linkAdjust
  adjust.addEventListener('click', () => {
    p.adjustLink = !p.adjustLink
    sync()
    status.textContent = p.adjustLink ? PANE_TIPS.linkAdjusting : ''
  })
  const unshift = document.createElement('button')
  unshift.className = 'mini'
  unshift.textContent = 'ずれ解除'
  unshift.title = PANE_TIPS.linkReset
  unshift.addEventListener('click', () => viewer.resetLinkOffset(p))
  const sync = () => {
    preset.hidden = persp.hidden = p.kind !== '3d'
    if (!link) p.adjustLink = false
    p.el.classList.toggle('adjusting', p.adjustLink)
    adjust.hidden = !link
    adjust.classList.toggle('on', p.adjustLink)
    unshift.hidden = !link || !viewer.hasLinkOffset(p)
  }
  paneSync.set(p, sync)
  p.kindSelect.addEventListener('change', sync)
  sync()
  p.tools.append(preset, persp, arch, shape, adjust, unshift, fit)
  return p
}

function setTranslucent(on: boolean) {
  viewer.setOptions({ translucentMembers: on })
  syncChecks()
}

function setLayout(name: string) {
  const kinds = LAYOUTS[name] ?? LAYOUTS['3d']
  while (viewer.panes.length > kinds.length) viewer.removePane(viewer.panes[viewer.panes.length - 1])
  kinds.forEach((k, i) => {
    const p = viewer.panes[i] ?? addPane(k)
    if (p.kind !== k) viewer.setKind(p, k)
    p.kindSelect.dispatchEvent(new Event('change'))
  })
  for (const p of viewer.panes) panesEl.append(p.el)
  grid.arrange(viewer.panes.map((p) => p.el))
  layoutSelect.value = name
}
layoutSelect.title = '画面分割\nこのウィンドウの中の 3D・立面/断面図の並べ方を選びます。'
const reset = $<HTMLButtonElement>('popup-reset')
reset.title = '並びを戻す\nウィンドウの見出しをドラッグして入れ替えた並び順と、境界線をドラッグして変えた大きさを、最初の状態に戻します。'
reset.addEventListener('click', () => grid.reset())
layoutSelect.addEventListener('change', () => setLayout(layoutSelect.value))
setLayout('3d')

interface FileMessage {
  type: 'file'
  name: string
  buffer: ArrayBuffer
  visible: boolean[]
  section: SectionBox | null
  hiddenLayers: number[]
  options: Partial<Options3D>
  link: boolean
  linkView: LinkView | null
  selection: { sheet: number; entity: number } | null
}

/** plan view from the main window for 2D linking */
interface LinkView {
  center: [number, number] | null
  upp: number | null
}

/** Latest state from the main window (updates that arrive while a drawing loads are kept here). */
const state = {
  visible: [] as boolean[],
  section: null as SectionBox | null,
  hiddenLayers: [] as number[],
  options: {} as Partial<Options3D>,
  linkView: null as LinkView | null,
}
let loadGen = 0

/** header checkboxes of every window follow the viewer's options */
function syncChecks() {
  document.querySelectorAll<HTMLInputElement>('.opt-translucent').forEach((c) => (c.checked = viewer.options.translucentMembers))
  document.querySelectorAll<HTMLInputElement>('.opt-partviews').forEach((c) => (c.checked = viewer.options.partViews))
}

async function load(m: FileMessage) {
  const gen = ++loadGen
  title.textContent = m.name
  document.title = `3D - ${m.name}`
  Object.assign(state, { visible: m.visible, section: m.section, hiddenLayers: m.hiddenLayers, options: { ...state.options, ...m.options }, linkView: m.linkView })
  link = m.link
  syncPanes()
  selection = m.selection
  viewer.setData(null, null)
  empty.hidden = false
  empty.textContent = '3D データを作成中…'
  try {
    const [doc, model] = await Promise.all([request<TfasDocument>('doc', m.name, m.buffer.slice(0)), request<Model3D>('3d', m.name, m.buffer)])
    if (gen !== loadGen) return
    viewer.hiddenLayers = new Set(state.hiddenLayers)
    viewer.setOptions(state.options)
    syncChecks()
    viewer.setData(model, doc)
    viewer.setVisibility(state.visible)
    viewer.setSection(state.section)
    if (selection) viewer.highlightEntity(selection.sheet, selection.entity)
    if (link && state.linkView) viewer.setLinkedView(state.linkView.center, state.linkView.upp)
    empty.hidden = true
  } catch (e) {
    if (gen === loadGen) empty.textContent = `3D データを作成できませんでした: ${(e as Error).message}`
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== opener || e.origin !== location.origin) return
  const m = e.data as { type: string; [k: string]: unknown }
  switch (m.type) {
    case 'file':
      void load(m as unknown as FileMessage)
      break
    case 'none':
      // the main window shows something without 3D data (a library part)
      loadGen++
      viewer.setData(null, null)
      title.textContent = String(m.name ?? '')
      empty.hidden = false
      empty.textContent = '部品は 3D 表示の対象外です。部品の立体形状は、元のウィンドウの［部品］パネルのプレビューで［3D］を押すと見られます。'
      break
    case 'visibility':
      state.visible = m.visible as boolean[]
      viewer.setVisibility(state.visible)
      break
    case 'section':
      state.section = m.section as SectionBox | null
      viewer.setSection(state.section)
      break
    case 'options':
      state.options = { ...state.options, ...(m.options as Partial<Options3D>) }
      viewer.setOptions(m.options as Partial<Options3D>)
      syncChecks()
      break
    case 'select':
      selection = m.sheet === null || m.sheet === undefined ? null : { sheet: m.sheet as number, entity: m.entity as number }
      viewer.highlightEntity(selection ? selection.sheet : null, selection?.entity ?? 0)
      break
    case 'layers':
      state.hiddenLayers = m.hidden as number[]
      viewer.setHiddenLayers(state.hiddenLayers)
      break
    case 'link-mode':
      link = m.link as boolean
      syncPanes()
      break
    case 'link': {
      const lv: LinkView = { center: (m.center as [number, number] | null) ?? null, upp: (m.upp as number | null) ?? null }
      state.linkView = { center: lv.center ?? state.linkView?.center ?? null, upp: lv.upp ?? state.linkView?.upp ?? null }
      viewer.setLinkedView(lv.center, lv.upp)
      break
    }
  }
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') viewer.fitAll()
})

if (opener) send({ type: 'ready' })
else empty.textContent = 'このページは T-Shirt Viewer の［3D］－［3D を別ウィンドウで表示］から開いてください'

// expose internals for debugging in development builds
if (import.meta.env.DEV) Object.assign(window, { __tfas3d: viewer })
