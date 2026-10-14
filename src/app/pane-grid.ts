// Split-window arrangement shared by the main window and the separate 3D window. The
// windows fill the grid slots in the user's order; the borders between them can be dragged
// to resize (double-click: equal sizes), and a window's title bar can be dragged onto
// another window to swap the two.

/** Arrangement by window count: 1, 2 side by side (stacked on narrow screens), 3 (first one tall on the left), 4. */
type Shape = 'one' | 'cols' | 'rows' | 'tall' | 'quad'

const AREAS: Record<Shape, string> = {
  one: '"a"',
  cols: '"a b"',
  rows: '"a" "b"',
  tall: '"a b" "a c"',
  quad: '"a b" "c d"',
}
const SLOTS = 'abcd'
/** gap between the windows (px, as .panes in style.css) */
const GAP = 2
/** smallest window while resizing (px) */
const MIN_SIZE = 120

export interface PaneGridTips {
  /** border between windows */
  split: string
  /** window title bar */
  head: string
}

interface Ratio {
  x: number
  y: number
}

export class PaneGrid {
  /** user order of the windows (slot a, b, …); windows no longer in the page are dropped */
  private order: HTMLElement[] = []
  /** windows in the caller's order (the initial arrangement) */
  private given: HTMLElement[] = []
  private shown: HTMLElement[] = []
  private shape: Shape = 'one'
  private ratios: Partial<Record<Shape, Ratio>> = {}
  private readonly vbar = document.createElement('div')
  private readonly hbar = document.createElement('div')
  private readonly narrow = window.matchMedia('(max-width: 640px)')
  /** after the arrangement or the window sizes changed by the user */
  onChange?: () => void

  readonly el: HTMLElement
  private readonly storageKey: string
  private readonly tips: PaneGridTips

  constructor(el: HTMLElement, storageKey: string, tips: PaneGridTips) {
    this.el = el
    this.storageKey = storageKey
    this.tips = tips
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, Ratio>
      for (const [k, r] of Object.entries(saved)) if (k in AREAS && Number.isFinite(r?.x) && Number.isFinite(r?.y)) this.ratios[k as Shape] = { x: r.x, y: r.y }
    } catch {
      // ignore unreadable settings
    }
    for (const [bar, axis] of [
      [this.vbar, 'x'],
      [this.hbar, 'y'],
    ] as const) {
      bar.className = `pane-split pane-split-${axis}`
      bar.title = tips.split
      bar.tabIndex = 0
      bar.setAttribute('role', 'separator')
      bar.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal')
      bar.addEventListener('pointerdown', (e) => this.startResize(e, axis))
      bar.addEventListener('dblclick', () => this.setRatio(axis, 0.5, true))
      bar.addEventListener('keydown', (e) => {
        const d = axis === 'x' ? { ArrowLeft: -1, ArrowRight: 1 }[e.key] : { ArrowUp: -1, ArrowDown: 1 }[e.key]
        if (!d) return
        e.preventDefault()
        e.stopPropagation()
        this.setRatio(axis, this.ratio()[axis] + d * 0.02, true)
      })
      el.append(bar)
    }
    el.addEventListener('pointerdown', (e) => this.startMove(e))
    this.narrow.addEventListener('change', () => this.layout())
  }

  /** Show these windows (others are hidden by the caller). */
  arrange(panes: HTMLElement[]) {
    this.given = panes.slice()
    this.order = this.order.filter((p) => p.isConnected)
    for (const p of panes) if (!this.order.includes(p)) this.order.push(p)
    this.shown = this.order.filter((p) => panes.includes(p)).slice(0, SLOTS.length)
    this.layout()
  }

  /** Back to the initial order and equal sizes. */
  reset() {
    this.order = this.given.slice()
    this.ratios = {}
    this.save()
    this.arrange(this.given)
    this.onChange?.()
  }

  private layout() {
    const n = this.shown.length
    this.shape = n <= 1 ? 'one' : n === 2 ? (this.narrow.matches ? 'rows' : 'cols') : n === 3 ? 'tall' : 'quad'
    const s = this.el.style
    const { x, y } = this.ratio()
    const two = (t: number) => `minmax(0, ${t}fr) minmax(0, ${1 - t}fr)`
    const cols = this.shape === 'one' || this.shape === 'rows' ? null : x
    const rows = this.shape === 'one' || this.shape === 'cols' ? null : y
    s.gridTemplateAreas = AREAS[this.shape]
    s.gridTemplateColumns = cols === null ? 'minmax(0, 1fr)' : two(cols)
    s.gridTemplateRows = rows === null ? 'minmax(0, 1fr)' : two(rows)
    this.shown.forEach((p, i) => (p.style.gridArea = SLOTS[i]))
    this.el.classList.toggle('multi', n > 1)
    for (const p of this.shown) {
      const head = p.querySelector<HTMLElement>('.pane-head')
      if (head && !head.title) head.title = this.tips.head
    }
    // borders: between the columns over the full height; between the rows over the full
    // width, or only beside the tall window
    this.vbar.hidden = cols === null
    this.hbar.hidden = rows === null
    if (cols !== null) this.vbar.style.left = `calc((100% - ${GAP}px) * ${cols} - 2px)`
    if (rows !== null) {
      this.hbar.style.top = `calc((100% - ${GAP}px) * ${rows} - 2px)`
      this.hbar.style.left = this.shape === 'tall' ? `calc((100% - ${GAP}px) * ${x} + ${GAP}px)` : '0'
    }
  }

  private ratio(): Ratio {
    return this.ratios[this.shape] ?? { x: 0.5, y: 0.5 }
  }

  private setRatio(axis: 'x' | 'y', t: number, done = false) {
    const r = this.el.getBoundingClientRect()
    const size = (axis === 'x' ? r.width : r.height) - GAP
    const lo = size > 0 ? Math.min(0.45, MIN_SIZE / size) : 0.1
    this.ratios[this.shape] = { ...this.ratio(), [axis]: Math.min(1 - lo, Math.max(lo, t)) }
    this.layout()
    if (done) {
      this.save()
      this.onChange?.()
    }
  }

  private save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.ratios))
    } catch {
      // storage unavailable (private mode etc.): not remembered
    }
  }

  private startResize(e: PointerEvent, axis: 'x' | 'y') {
    if (e.button !== 0) return
    e.preventDefault()
    const bar = axis === 'x' ? this.vbar : this.hbar
    bar.setPointerCapture(e.pointerId)
    bar.classList.add('dragging')
    document.body.classList.add(`pane-resizing-${axis}`)
    const move = (ev: PointerEvent) => {
      const r = this.el.getBoundingClientRect()
      const t = axis === 'x' ? (ev.clientX - r.left - GAP / 2) / (r.width - GAP) : (ev.clientY - r.top - GAP / 2) / (r.height - GAP)
      if (Number.isFinite(t)) this.setRatio(axis, t)
    }
    const end = () => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', end)
      bar.removeEventListener('pointercancel', end)
      bar.classList.remove('dragging')
      document.body.classList.remove(`pane-resizing-${axis}`)
      this.setRatio(axis, this.ratio()[axis], true)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', end)
    bar.addEventListener('pointercancel', end)
  }

  /** Title bar drag: drop on another window to swap the two. */
  private startMove(e: PointerEvent) {
    const t = e.target as HTMLElement
    const head = t.closest('.pane-head')
    if (e.button !== 0 || this.shown.length < 2 || !head || t.closest('button, select, input, label, a')) return
    const src = this.shown.find((p) => p.contains(head))
    if (!src) return
    const x0 = e.clientX
    const y0 = e.clientY
    let ghost: HTMLDivElement | null = null
    let target: HTMLElement | null = null
    const setTarget = (p: HTMLElement | null) => {
      if (p === target) return
      target?.classList.remove('pane-drop')
      target = p
      target?.classList.add('pane-drop')
    }
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return
        ghost = document.createElement('div')
        ghost.className = 'pane-ghost'
        ghost.textContent = `${paneName(src)} を移動 — 入れ替えたいウィンドウの上で離す (Esc で中止)`
        document.body.append(ghost)
        src.classList.add('pane-moving')
        document.body.classList.add('pane-dragging')
      }
      ghost.style.left = `${ev.clientX + 12}px`
      ghost.style.top = `${ev.clientY + 12}px`
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.pane')
      setTarget(over && over !== src && this.shown.includes(over) ? over : null)
    }
    const finish = (swap: boolean) => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('keydown', key, true)
      ghost?.remove()
      src.classList.remove('pane-moving')
      document.body.classList.remove('pane-dragging')
      const dst = target
      setTarget(null)
      if (swap && dst) this.swap(src, dst)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('keydown', key, true)
  }

  private swap(a: HTMLElement, b: HTMLElement) {
    const i = this.order.indexOf(a)
    const j = this.order.indexOf(b)
    if (i < 0 || j < 0) return
    this.order[i] = b
    this.order[j] = a
    this.arrange(this.given)
    this.onChange?.()
  }
}

/** Name shown while moving a window: the plan's name or the selected window kind. */
function paneName(p: HTMLElement): string {
  const sel = p.querySelector<HTMLSelectElement>('.pane-head select')
  return sel?.selectedOptions[0]?.text ?? p.querySelector('.pane-name')?.textContent ?? 'ウィンドウ'
}
