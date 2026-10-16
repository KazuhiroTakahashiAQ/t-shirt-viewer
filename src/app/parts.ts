// Parts library browser (サブセットライブラリ: maker NCP + MDB, custom desk MDB +
// USR). Parts are listed by category; the selected part is previewed per view (平面,
// 正面, 背面, 右側面, 左側面) or as a 3D model, and can be opened in the drawing area
// as a document with the views arranged like the CAD's 5 面図 registration frame.

import { CanvasRenderer } from '../render/canvas.ts'
import { buildLayerBatches } from '../render/scene.ts'
import { defaultOptions } from '../render/style.ts'
import { openPartsLibrary, readLibraryModel, readLibraryView, viewName, type LibraryCategory, type LibraryPart, type PartsLibrary } from '../tfs/library.ts'
import { Prim, unionRect, type GeomBuffer, type Layer, type Rect, type Style, type TextItem, type TfsDocument } from '../tfs/model.ts'
import { partDocument, type PartDrawing, type PartModel } from '../tfs/ncp.ts'

export interface PartsHost {
  showTab: (name: string) => void
}

let host: PartsHost
let root: HTMLElement
let onOpen: ((name: string, doc: TfsDocument) => void) | null = null
const libraries: PartsLibrary[] = []
let lib: PartsLibrary | null = null
let selected: LibraryPart | null = null
let selectedView = 0
let preview: CanvasRenderer | null = null
let previewCanvas: HTMLCanvasElement | null = null
let model3d: { model: PartModel; yaw: number; pitch: number; zoom: number } | null = null

export function isPartsFile(name: string): boolean {
  return /\.(ncp|mdb|usr)$/i.test(name)
}

export function initParts(el: HTMLElement, h: PartsHost) {
  root = el
  host = h
  render()
}

/** Called by the viewer to open a part document in the drawing area. */
export function onOpenPart(cb: (name: string, doc: TfsDocument) => void) {
  onOpen = cb
}

export async function openPartsFiles(files: File[]) {
  root.replaceChildren(text('div', 'hint', `読み込み中… (${files.map((f) => f.name).join(', ')})`))
  host.showTab('parts')
  try {
    const data = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })))
    const opened = openPartsLibrary(data)
    libraries.push(opened)
    lib = opened
    selected = null
  } catch (e) {
    alert(`部品ライブラリを開けませんでした: ${(e as Error).message}`)
  }
  render()
}

// ---------------------------------------------------------------------------

function text<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, s: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  el.textContent = s
  return el
}

/** Tooltip for a specification row. */
function specTip(k: string): string {
  const base = k.replace(/\s*\(推定\)$/, '')
  const terms: [RegExp, string][] = [
    [/^型番/, '型番: メーカーの製品の型式 (品番)。'],
    [/^名称/, '名称: 部品の名前。'],
    [/^分類/, '分類: 部品ライブラリ内の分類 (大分類 / 中分類 / 小分類)。'],
    [/^部品コード/, '部品コード: 元の CAD が部品を識別するコード。'],
    [/^メーカーコード/, 'メーカーコード: メーカーを表すコード。'],
    [/^登録日/, '登録日: 部品データが登録された日付。'],
    [/^冷房能力/, '冷房能力: 冷やす能力 (kW)。電源周波数 (50Hz / 60Hz) で値が異なります。'],
    [/^暖房能力/, '暖房能力: 暖める能力 (kW)。'],
    [/^運転音/, '運転音: 運転時の騒音 (dB)。括弧内は運転条件・測定条件。'],
    [/^風量/, '風量: 送風量 (m³/min)。括弧内は運転条件。'],
  ]
  const hit = terms.find(([re]) => re.test(base))
  const est = k.endsWith('(推定)') ? '\n(推定): ファイルには項目名がないため、値と並び順から推定した項目名です。' : ''
  return (hit ? hit[1] : base) + est
}

/** Where each view looks from (for tooltips). */
const VIEW_DIRECTIONS: Record<string, string> = { 平面: '上から', 正面: '前から', 背面: '後ろから', 右側面: '右から', 左側面: '左から' }

function render() {
  if (!root) return
  const openBtn = text('button', 'btn', '部品ライブラリを開く…')
  openBtn.title = '部品ライブラリを開く\nメーカーが配布する部品データ (元の CAD 用のサブセットライブラリ: .NCP / .MDB / .USR が入ったフォルダー) を選びます。'
  openBtn.addEventListener('click', () => document.getElementById('folder-input')?.click())
  const fileBtn = text('button', 'link', 'ファイルを選択')
  fileBtn.title = 'フォルダーではなく、部品データのファイル (.NCP / .MDB / .USR) を個別に選びます。'
  fileBtn.addEventListener('click', () => document.getElementById('file-input')?.click())
  if (!lib) {
    root.replaceChildren(
      openBtn,
      text('p', 'hint', '元の CAD の部品データフォルダー (サブセットライブラリ: .NCP / .MDB / .USR) を選ぶか、ファイルを画面にドロップしてください。'),
      fileBtn,
    )
    return
  }
  const wrap = document.createElement('div')
  wrap.className = 'parts'
  const head = document.createElement('div')
  head.className = 'panel-tools'
  if (libraries.length > 1) {
    const sel = document.createElement('select')
    sel.title = '表示する部品ライブラリ (読み込んだメーカーのデータ) を選びます。'
    libraries.forEach((l, i) => {
      const o = document.createElement('option')
      o.value = String(i)
      o.textContent = l.title
      o.selected = l === lib
      sel.append(o)
    })
    sel.addEventListener('change', () => {
      lib = libraries[Number(sel.value)]
      selected = null
      render()
    })
    head.append(sel)
  }
  const filter = document.createElement('input')
  filter.type = 'search'
  filter.placeholder = '部品名・型番で絞込み'
  filter.title = '部品名・型番の一部を入力すると、一覧をその部品だけにします。'
  head.append(filter)
  const title = text('div', 'hint', `${lib.title} — ${lib.parts.length} 部品 (${lib.kind === 'ncp' ? '図形データあり' : 'カスタムデスク: アイコンのみ'})`)
  const tree = document.createElement('div')
  tree.className = 'parts-tree'
  const fill = () => tree.replaceChildren(...categoryNodes(lib!.root, filter.value.trim().normalize('NFKC').toLowerCase(), 0))
  filter.addEventListener('input', fill)
  fill()
  const detail = document.createElement('div')
  detail.id = 'part-detail'
  wrap.append(openBtn, title, head, tree, detail)
  if (lib.warnings.length) wrap.append(text('div', 'hint', lib.warnings.join(' / ')))
  root.replaceChildren(wrap)
  renderDetail()
}

function matches(p: LibraryPart, q: string): boolean {
  if (!q) return true
  return `${p.name} ${p.longName} ${p.callCode} ${p.code}`.normalize('NFKC').toLowerCase().includes(q)
}

function countParts(c: LibraryCategory, q: string): number {
  return c.parts.filter((p) => matches(p, q)).length + c.children.reduce((n, k) => n + countParts(k, q), 0)
}

function categoryNodes(c: LibraryCategory, q: string, depth: number): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const k of c.children) {
    const n = countParts(k, q)
    if (!n) continue
    const d = document.createElement('details')
    d.open = depth < 1 || !!q
    const s = document.createElement('summary')
    s.textContent = `${k.name} (${n})`
    d.append(s)
    const inner = document.createElement('div')
    inner.style.paddingLeft = '12px'
    inner.append(...categoryNodes(k, q, depth + 1))
    d.append(inner)
    out.push(d)
  }
  const parts = c.parts.filter((p) => matches(p, q))
  if (parts.length) {
    const ul = document.createElement('ul')
    for (const p of parts) {
      const li = document.createElement('li')
      li.textContent = `${p.callCode}  ${p.name}`
      li.title = `${p.longName || p.name}\n${p.code}`
      li.classList.toggle('active', p === selected)
      li.addEventListener('click', () => {
        selected = p
        selectedView = p.views[0]?.view ?? 0
        root.querySelectorAll('.parts-tree li.active').forEach((x) => x.classList.remove('active'))
        li.classList.add('active')
        renderDetail()
      })
      li.addEventListener('dblclick', () => openInStage(p))
      ul.append(li)
    }
    out.push(ul)
  }
  return out
}

function renderDetail() {
  const el = root.querySelector('#part-detail')
  if (!el || !lib) return
  if (!selected) {
    el.replaceChildren(text('p', 'hint', '部品をクリックでプレビュー、ダブルクリックで作図領域に表示'))
    return
  }
  const p = selected
  const head = text('div', '', `${p.callCode}`)
  head.style.fontWeight = '700'
  const name = text('div', 'hint', p.longName || p.name)
  const views = document.createElement('div')
  views.className = 'parts-views'
  for (const v of p.views) {
    const b = text('button', `btn${v.view === selectedView ? ' active' : ''}`, v.label)
    b.title = `${v.label}\nこの部品を${VIEW_DIRECTIONS[v.label] ?? ''}見た形を表示します。`
    if (v.view === selectedView) b.style.fontWeight = '700'
    b.addEventListener('click', () => {
      selectedView = v.view
      renderDetail()
    })
    views.append(b)
  }
  if (p.hasModel) {
    const b = text('button', 'btn', '3D')
    b.title = '3D\nこの部品の立体形状を表示します。ドラッグで回転します。'
    if (selectedView === -1) b.style.fontWeight = '700'
    b.addEventListener('click', () => {
      selectedView = -1
      renderDetail()
    })
    views.append(b)
  }
  previewCanvas = document.createElement('canvas')
  previewCanvas.className = 'parts-preview'
  const open = text('button', 'btn', '作図領域に表示')
  open.title = '作図領域に表示\nこの部品の平面・正面・背面・右側面・左側面の図 (5 面図) を並べて、中央の図面表示エリアに表示します。選択・計測もできます。'
  open.addEventListener('click', () => openInStage(p))
  open.disabled = !p.views.length
  const children: HTMLElement[] = [head, name, views, previewCanvas, open]
  if (p.stockKey && lib.kind === 'custom-desk')
    children.push(text('p', 'hint', `形状は元の CAD 本体のストック部品 (${p.stockKey}) から生成されるため、このデータには含まれていません。登録されているアイコンを表示しています。`))
  const specs = [...p.specs]
  const table = document.createElement('table')
  table.className = 'prop-table'
  const add = (k: string, v: string) => {
    const tr = table.insertRow()
    const th = document.createElement('th')
    th.textContent = k
    th.title = specTip(k)
    tr.append(th)
    tr.insertCell().textContent = v
  }
  add('型番', p.callCode)
  add('名称', p.longName || p.name)
  add('分類', p.path.join(' > '))
  add('部品コード', p.code)
  for (const s of specs) add(`${s.label}${s.guessed ? ' (推定)' : ''}`, `${s.value}${s.unit ? ` ${s.unit}` : ''}`)
  children.push(table)
  el.replaceChildren(...children)
  requestAnimationFrame(drawPreview)
}

function drawPreview() {
  if (!previewCanvas || !lib || !selected) return
  const p = selected
  model3d = null
  if (selectedView === -1) {
    const m = readLibraryModel(lib, p)
    if (m) {
      model3d = { model: m, yaw: -Math.PI / 4, pitch: 0.6, zoom: 1 }
      bind3d(previewCanvas)
      draw3d()
    }
    return
  }
  const v = p.views.find((x) => x.view === selectedView)
  const d = v ? readLibraryView(lib, p, v) : null
  if (!d) return
  const doc = partDocument(d)
  const layer = doc.layers[0]
  preview = new CanvasRenderer(previewCanvas, { ...defaultOptions, showSheets: false })
  preview.setScene(doc, [{ index: 0, name: layer.name, batches: buildLayerBatches(layer.geom, layer.bbox), texts: layer.texts, images: [], bbox: layer.bbox, primitives: layer.geom.count }], [true])
  preview.resize()
  if (layer.bbox) preview.fit(layer.bbox, 0.08)
  preview.render()
  const r = preview
  previewCanvas.onwheel = (e) => {
    e.preventDefault()
    r.zoomAt(e.offsetX, e.offsetY, Math.pow(1.0015, -e.deltaY))
  }
  let last: [number, number] | null = null
  previewCanvas.onpointerdown = (e) => {
    last = [e.offsetX, e.offsetY]
    previewCanvas!.setPointerCapture(e.pointerId)
  }
  previewCanvas.onpointermove = (e) => {
    if (!last) return
    r.panBy(e.offsetX - last[0], e.offsetY - last[1])
    last = [e.offsetX, e.offsetY]
  }
  previewCanvas.onpointerup = () => (last = null)
  previewCanvas.ondblclick = () => {
    if (layer.bbox) r.fit(layer.bbox, 0.08)
    r.requestRender()
  }
}

// ---------------------------------------------------------------------------
// 3D preview: flat-shaded triangles, painter's algorithm, drag to orbit

function bind3d(c: HTMLCanvasElement) {
  let last: [number, number] | null = null
  c.onpointerdown = (e) => {
    last = [e.offsetX, e.offsetY]
    c.setPointerCapture(e.pointerId)
  }
  c.onpointermove = (e) => {
    if (!last || !model3d) return
    model3d.yaw += (e.offsetX - last[0]) * 0.01
    model3d.pitch = Math.max(-1.5, Math.min(1.5, model3d.pitch + (e.offsetY - last[1]) * 0.01))
    last = [e.offsetX, e.offsetY]
    draw3d()
  }
  c.onpointerup = () => (last = null)
  c.onwheel = (e) => {
    e.preventDefault()
    if (!model3d) return
    model3d.zoom *= Math.pow(1.0015, -e.deltaY)
    draw3d()
  }
  c.ondblclick = () => {
    if (!model3d) return
    Object.assign(model3d, { yaw: -Math.PI / 4, pitch: 0.6, zoom: 1 })
    draw3d()
  }
}

function draw3d() {
  const c = previewCanvas
  if (!c || !model3d) return
  const dpr = window.devicePixelRatio || 1
  c.width = Math.round(c.clientWidth * dpr)
  c.height = Math.round(c.clientHeight * dpr)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#202326'
  ctx.fillRect(0, 0, c.width, c.height)
  const { model: m, yaw, pitch, zoom } = model3d
  const P = m.positions
  const T = m.triangles
  const cx = (m.min[0] + m.max[0]) / 2
  const cy = (m.min[1] + m.max[1]) / 2
  const cz = (m.min[2] + m.max[2]) / 2
  const cyw = Math.cos(yaw)
  const syw = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const n = P.length / 3
  const sx = new Float64Array(n)
  const sy = new Float64Array(n)
  const sz = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = P[3 * i] - cx
    const y = P[3 * i + 1] - cy
    const z = P[3 * i + 2] - cz
    const x1 = x * cyw - y * syw
    const y1 = x * syw + y * cyw
    sx[i] = x1
    sy[i] = z * cp + y1 * sp
    sz[i] = -y1 * cp + z * sp
  }
  const ext = Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]) || 1
  const s = (Math.min(c.width, c.height) / ext) * 0.8 * zoom
  const order: number[] = []
  const depth = new Float64Array(T.length / 3)
  const shade = new Float64Array(T.length / 3)
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t]
    const b = T[t + 1]
    const d = T[t + 2]
    const ux = sx[b] - sx[a]
    const uy = sy[b] - sy[a]
    const uz = sz[b] - sz[a]
    const vx = sx[d] - sx[a]
    const vy = sy[d] - sy[a]
    const vz = sz[d] - sz[a]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    depth[t / 3] = (sz[a] + sz[b] + sz[d]) / 3
    shade[t / 3] = 0.3 + 0.7 * Math.abs((nz / len) * 0.75 + (ny / len) * 0.45)
    order.push(t / 3)
  }
  order.sort((p, q) => depth[p] - depth[q])
  const X = (i: number) => c.width / 2 + sx[i] * s
  const Y = (i: number) => c.height / 2 - sy[i] * s
  ctx.lineJoin = 'round'
  for (const k of order) {
    const t = k * 3
    const g = Math.round(235 * Math.min(1, shade[k]))
    ctx.fillStyle = ctx.strokeStyle = `rgb(${g},${g},${Math.min(255, g + 18)})`
    ctx.beginPath()
    ctx.moveTo(X(T[t]), Y(T[t]))
    ctx.lineTo(X(T[t + 1]), Y(T[t + 1]))
    ctx.lineTo(X(T[t + 2]), Y(T[t + 2]))
    ctx.closePath()
    ctx.fill()
    ctx.lineWidth = 0.5
    ctx.stroke()
  }
  ctx.fillStyle = '#9aa4ae'
  ctx.font = `${11 * dpr}px sans-serif`
  ctx.fillText(`${Math.round(m.max[0] - m.min[0])} × ${Math.round(m.max[1] - m.min[1])} × ${Math.round(m.max[2] - m.min[2])} mm  (ドラッグで回転)`, 6 * dpr, c.height - 6 * dpr)
}

// ---------------------------------------------------------------------------
// Part document: views laid out like the 5 面図 frame (背面 above the plan, 正面 below,
// 左側面 / 右側面 at the sides)

function translateGeom(g: GeomBuffer, dx: number, dy: number, styleMap: (i: number) => number): GeomBuffer {
  const coords = new Float64Array(g.coords.length)
  const styles = new Uint16Array(g.count)
  for (let i = 0; i < g.count; i++) {
    styles[i] = styleMap(g.styles[i])
    const a = g.offsets[i]
    const b = g.offsets[i + 1]
    const t = g.types[i]
    if (t === Prim.Circle || t === Prim.Arc || t === Prim.Ellipse) {
      coords[a] = g.coords[a] + dx
      coords[a + 1] = g.coords[a + 1] + dy
      for (let k = a + 2; k < b; k++) coords[k] = g.coords[k]
    } else
      for (let k = a; k < b; k += 2) {
        coords[k] = g.coords[k] + dx
        coords[k + 1] = g.coords[k + 1] + dy
      }
  }
  return { ...g, coords, styles }
}

function buildPartDocument(l: PartsLibrary, p: LibraryPart): TfsDocument | null {
  const drawings = new Map<number, PartDrawing>()
  for (const v of p.views) {
    const d = readLibraryView(l, p, v)
    if (d?.bbox) drawings.set(v.view, d)
  }
  if (!drawings.size) return null
  const size = (r: Rect) => [r.x1 - r.x0, r.y1 - r.y0]
  const plan = drawings.get(0) ?? [...drawings.values()][0]
  const [pw, ph] = size(plan.bbox!)
  const gap = Math.max(pw, ph) * 0.25 + 100
  // target center of each view relative to the plan's center
  const place: Record<number, (w: number, h: number) => [number, number]> = {
    0: () => [0, 0],
    2: (_w, h) => [0, ph / 2 + gap + h / 2],
    1: (_w, h) => [0, -(ph / 2 + gap + h / 2)],
    3: (w) => [pw / 2 + gap + w / 2, 0],
    4: (w) => [-(pw / 2 + gap + w / 2), 0],
  }
  const styles: Style[] = []
  const layers: Layer[] = []
  let bbox: Rect | null = null
  const pc = [(plan.bbox!.x0 + plan.bbox!.x1) / 2, (plan.bbox!.y0 + plan.bbox!.y1) / 2]
  for (const [view, d] of [...drawings].sort((a, b) => a[0] - b[0])) {
    const b = d.bbox!
    const [w, h] = size(b)
    const [tx, ty] = (place[view] ?? place[0])(w, h)
    const dx = pc[0] + tx - (b.x0 + b.x1) / 2
    const dy = pc[1] + ty - (b.y0 + b.y1) / 2
    const map = new Map<number, number>()
    const styleMap = (i: number) => {
      let j = map.get(i)
      if (j === undefined) {
        const st = d.styles[i]
        j = styles.findIndex((s) => s.color === st.color && s.linetype === st.linetype && s.width === st.width)
        if (j < 0) {
          j = styles.length
          styles.push({ ...st })
        }
        map.set(i, j)
      }
      return j
    }
    const geom = translateGeom(d.geom, dx, dy, styleMap)
    const texts: TextItem[] = d.texts.map((t) => ({ ...t, x: t.x + dx, y: t.y + dy, style: styleMap(t.style), bbox: { x0: t.bbox.x0 + dx, y0: t.bbox.y0 + dy, x1: t.bbox.x1 + dx, y1: t.bbox.y1 + dy } }))
    const lb = { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy }
    bbox = bbox ? unionRect(bbox, lb) : lb
    layers.push({ index: layers.length, name: viewName(view), visible: true, color: { mode: 'entity', color: 0 }, scale: d.scale, layout: null, xref: null, geom, texts, images: [], entities: d.entities, bbox: lb })
  }
  const b = bbox!
  const m = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.08
  const paper = { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m }
  const scale = plan.scale || 50
  return {
    fileName: p.code,
    version: plan.source === 'ncp' ? 'NCP 部品' : 'EMF アイコン',
    scale,
    paper,
    layouts: [],
    layers,
    styles,
    linetypes: {},
    thumbnail: null,
    functions: [],
    attributes: [],
    warnings: [],
    stats: { primitives: layers.reduce((n, l) => n + l.geom.count, 0), texts: layers.reduce((n, l) => n + l.texts.length, 0), hiddenSkipped: 0, parseMs: 0 },
  }
}

function openInStage(p: LibraryPart) {
  if (!lib || !onOpen) return
  const doc = buildPartDocument(lib, p)
  if (!doc) {
    alert('この部品には表示できる図形がありません')
    return
  }
  onOpen(`${p.callCode} ${p.name}`, doc)
}
