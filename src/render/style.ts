// Visual style mapping. The CAD keeps its color palette and built-in line type patterns in
// the application, not in the drawing.

import type { LayerColor, TfsDocument } from '../tfs/model.ts'

export type Background = 'white' | 'black'
export type ColorMode = 'mono' | 'color'

export interface RenderOptions {
  background: Background
  colorMode: ColorMode
  showAux: boolean
  showText: boolean
  showSheets: boolean
  /** draw thick pens thicker (screen pixels, like the CAD's 線幅表示) */
  lineWeights: boolean
}

export const defaultOptions: RenderOptions = {
  background: 'black',
  colorMode: 'color',
  showAux: false,
  showText: true,
  showSheets: true,
  lineWeights: true,
}

// Drawing color numbers. 1..30 are the application's base colors (9..14 and 30 are
// AutoCAD ACI colors); 31 onwards continue through ACI 10..255 skipping the ACI
// entries already used as base colors. Derived from the 800x800 previews that the CAD
// stores in the files; 18..29 and user colors beyond the ACI range are unknown.
const BASE_RGB: Record<number, number> = {
  1: 0xffffff,
  2: 0x5b5b5b,
  3: 0xff0000,
  4: 0x00ff00,
  5: 0x0000ff,
  6: 0xffff00,
  7: 0xff00ff,
  8: 0x00ffff,
  15: 0xc0c0c0,
  16: 0x808080,
  17: 0xc6c6c6,
}
const BASE_ACI: Record<number, number> = { 9: 222, 10: 42, 11: 30, 12: 103, 13: 150, 14: 190, 30: 214 }
const ACI_SEQUENCE: number[] = []
{
  const used = new Set(Object.values(BASE_ACI))
  for (let n = 10; n <= 255; n++) if (!used.has(n)) ACI_SEQUENCE.push(n)
}

/** AutoCAD Color Index 10..255 -> RGB */
export function aciRgb(n: number): number {
  if (n >= 250) return [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff][n - 250]
  const hue = (Math.floor(n / 10) - 1) * 15
  const k = n % 10
  const v = [255, 255, 165, 165, 127, 127, 76, 76, 38, 38][k]
  const s = k % 2 === 0 ? 1 : 0.5
  const c = v * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
  const q = (t: number) => Math.round(t + m - 0.001)
  return (q(r) << 16) | (q(g) << 8) | q(b)
}

/** RGB of a drawing color number, or null when unknown (drawn in the foreground color). */
export function tfsRgb(n: number): number | null {
  if (n in BASE_RGB) return BASE_RGB[n]
  if (n in BASE_ACI) return aciRgb(BASE_ACI[n])
  if (n >= 31 && n - 31 < ACI_SEQUENCE.length) return aciRgb(ACI_SEQUENCE[n - 31])
  return null
}

const hex = (rgb: number) => `#${(rgb | (1 << 24)).toString(16).slice(1)}`
const cache = new Map<string, string>()

export function strokeColor(color: number, o: RenderOptions): string {
  const key = `${color}|${o.colorMode}|${o.background}`
  let c = cache.get(key)
  if (c) return c
  const fg = o.background === 'white' ? '#000000' : '#ffffff'
  if (o.colorMode === 'mono') c = fg
  else {
    const rgb = tfsRgb(color)
    c = rgb === null ? fg : o.background === 'white' ? forWhite(rgb) : hex(rgb)
  }
  cache.set(key, c)
  return c
}

/** Color for a primitive on a layer, honoring layer color / gray display modes. */
export function layerStroke(layer: LayerColor, color: number, o: RenderOptions): string {
  if (layer.mode === 'gray') return o.background === 'white' ? '#a8a8a8' : '#505050'
  return strokeColor(layer.mode === 'layer' ? layer.color : color, o)
}

/** Darken light colors so they stay readable on white paper. */
function forWhite(rgb: number): string {
  let r = (rgb >> 16) & 255
  let g = (rgb >> 8) & 255
  let b = rgb & 255
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  if (lum > 0.92) return '#000000'
  if (lum > 0.5) {
    const k = 0.5 / lum
    r = Math.round(r * k)
    g = Math.round(g * k)
    b = Math.round(b * k)
  }
  return hex((r << 16) | (g << 8) | b)
}

export function backgroundColor(o: RenderOptions): string {
  return o.background === 'white' ? '#ffffff' : '#000000'
}

// Built-in line types (paper mm). Ratios measured from the line type samples in the
// official manual; the absolute size is unknown and scaled so that the period
// of 2 (dashed) and 4 (chain) is 4 mm. 6 and up were drawn solid before the manual check.
// Sample pixel runs (dash, gap, ...): 2: 73 23 / 3: 12 12 / 4: 37 23 13 23 / 6: 70 18 /
// 7: 70 70 / 8: 142 17 4 17 / 11: 4 16 / 12: 161 16 42 17 / 14: 72 15 6 15 ...
const PX = 1 / 24
const px = (...runs: number[]) => runs.map((r) => r * PX)
const BUILTIN_DASH: Record<number, number[]> = {
  2: px(73, 23),
  3: px(12, 12),
  4: px(37, 23, 13, 23),
  5: px(36, 11, 13, 11, 13, 11),
  6: px(70, 18),
  7: px(70, 70),
  8: px(142, 17, 4, 17),
  9: px(170, 16, 5, 16, 4, 16),
  10: px(159, 15, 6, 15, 6, 15, 4, 17),
  11: px(4, 16),
  12: px(161, 16, 42, 17),
  13: px(132, 18, 42, 16, 42, 16),
  14: px(72, 15, 6, 15),
  20: px(60, 8),
  21: px(22, 8),
  22: px(118, 9, 12, 9),
  23: px(118, 9, 12, 9, 13, 9),
  24: px(37, 8, 2.5, 8),
  25: px(37, 8, 2.5, 8),
  26: px(37, 7, 3, 8, 4, 6),
  33: px(12, 7),
  35: px(60, 8),
  36: px(118, 9, 12, 9, 13, 9),
  37: px(23, 7),
  39: px(119, 7, 13, 8),
}

/** Screen line width in CSS px for a width (pen) number; thick pens are numbered 13 and up. */
export function linePx(width: number, o: RenderOptions): number {
  if (!o.lineWeights || width < 13) return 1
  if (width < 20) return 1.5
  if (width < 26) return 2
  return 2.5
}

const dashCache = new WeakMap<TfsDocument, Map<number, number[] | null>>()

/** Dash pattern in model units for a line type, or null for solid lines. */
export function dashPattern(doc: TfsDocument, linetype: number): number[] | null {
  let m = dashCache.get(doc)
  if (!m) dashCache.set(doc, (m = new Map()))
  let d = m.get(linetype)
  if (d === undefined) {
    const mm = doc.linetypes[linetype] ?? BUILTIN_DASH[linetype] ?? null
    d = mm ? mm.map((x) => x * doc.scale) : null
    m.set(linetype, d)
  }
  return d
}

export const FONT_GOTHIC = '"MS Gothic","Osaka-Mono","Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP","Noto Sans CJK JP",monospace'
export const FONT_PGOTHIC = '"MS PGothic","Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP","Noto Sans CJK JP",sans-serif'
export const FONT_MINCHO = '"MS Mincho","Hiragino Mincho ProN","Noto Serif JP","Noto Serif CJK JP",serif'

export function fontFamily(name: string): string {
  if (/明朝|mincho/i.test(name)) return FONT_MINCHO
  if (/Ｐ|P(ゴシック|gothic)/i.test(name)) return FONT_PGOTHIC
  return FONT_GOTHIC
}
