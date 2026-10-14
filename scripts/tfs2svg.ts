// Render a .tfs file to SVG.
// usage: node scripts/tfs2svg.ts <in.tfs> [out.svg] [--layout model|current|NAME|N] [--window paper|extents|x0,y0,x1,y1]
//        [--width px] [--color] [--black] [--aux] [--all-layers]
// External references are resolved from the input file's directory. By default the
// layout holding the current sheet is rendered (as Tfas opens the drawing).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readTfas } from '../src/tfas/reader.ts'
import { resolveXref } from '../src/tfas/xref.ts'
import { currentLayout, layoutPaper, layoutPieces, modelPieces, type SourceSheet } from '../src/tfas/layout.ts'
import { toSvg, type SvgLayer } from '../src/render/svg.ts'
import { defaultOptions } from '../src/render/style.ts'
import type { Rect } from '../src/tfas/model.ts'

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const valued = ['--window', '--width', '--layout']
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && valued.includes(args[i - 1])))
const input = positional[0]
if (!input) {
  console.error('usage: node scripts/tfs2svg.ts <in.tfs> [out.svg] [--layout model|current|NAME|N] [--window paper|extents|x0,y0,x1,y1] [--width px] [--color] [--black] [--aux] [--all-layers]')
  process.exit(2)
}
const output = positional[1] ?? input.replace(/\.tfs$/i, '') + '.svg'
const doc = readTfas(new Uint8Array(readFileSync(input)), basename(input))
const allLayers = flag('--all-layers')

// resolve external references from the same folder
const dir = dirname(input)
const siblings = existsSync(dir) ? readdirSync(dir) : []
const sources: SourceSheet[] = doc.layers.map((l) => {
  const s: SourceSheet = { geom: l.geom, texts: l.texts, images: l.images, entities: l.entities, bbox: l.bbox, color: l.color }
  if (!l.xref) return s
  const norm = (x: string) => x.normalize('NFKC').toLowerCase()
  const name = siblings.find((f) => norm(f) === norm(l.xref!.fileName))
  if (!name) {
    console.error(`xref not found: ${l.xref.fileName} (sheet ${l.name})`)
    return s
  }
  const r = resolveXref(doc, l, readTfas(new Uint8Array(readFileSync(join(dir, name))), name))
  if (!r) console.error(`xref sheet not found: ${l.xref.fileName}#${l.xref.layerName}`)
  return r ? { ...s, ...r } : s
})

const want = opt('--layout') ?? 'current'
let layout: string | null = null
if (want === 'current') layout = currentLayout(doc)
else if (want !== 'model') {
  const byIndex = /^\d+$/.test(want) ? doc.layouts[Number(want) - 1] : undefined
  const found = byIndex ?? doc.layouts.find((l) => l.name === want)
  if (!found) {
    console.error(`layout not found: ${want} (${doc.layouts.map((l, i) => `${i + 1}:${l.name}`).join(', ') || 'none'})`)
    process.exit(2)
  }
  layout = found.id
}
const pieces = layout ? layoutPieces(doc, layout, sources) : modelPieces(doc, sources)
const layers: SvgLayer[] = pieces.filter((p) => allLayers || doc.layers[p.group].visible).map((p) => ({ geom: p.geom, texts: p.texts, images: p.images, color: p.color, clip: p.clip }))

let window: Rect = layout ? layoutPaper(doc, layout) : doc.paper
const w = opt('--window')
if (w === 'extents') {
  let r: Rect | null = null
  for (const p of pieces) if (p.bbox) r = r ? { x0: Math.min(r.x0, p.bbox.x0), y0: Math.min(r.y0, p.bbox.y0), x1: Math.max(r.x1, p.bbox.x1), y1: Math.max(r.y1, p.bbox.y1) } : { ...p.bbox }
  window = r ?? doc.paper
} else if (w && w !== 'paper') {
  const [x0, y0, x1, y1] = w.split(',').map(Number)
  window = { x0, y0, x1, y1 }
}
const pad = (window.x1 - window.x0) * 0.01
window = { x0: window.x0 - pad, y0: window.y0 - pad, x1: window.x1 + pad, y1: window.y1 + pad }

const svg = toSvg(doc, layers, {
  ...defaultOptions,
  colorMode: flag('--color') ? 'color' : 'mono',
  background: flag('--black') ? 'black' : 'white',
  showAux: flag('--aux'),
  window,
  widthPx: Number(opt('--width') ?? 2400),
})
writeFileSync(output, svg)
console.log(`${output}: ${layout ? `layout "${doc.layouts.find((l) => l.id === layout)?.name}"` : 'model'}, ${doc.stats.primitives} primitives, ${doc.stats.texts} texts, scale 1/${doc.scale}`)
