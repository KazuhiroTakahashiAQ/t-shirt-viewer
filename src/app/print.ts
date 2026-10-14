// Printing: the chosen range is converted to SVG and printed from a hidden frame with
// the page size set to the drawing's paper, so "PDF に保存" yields a true-size drawing.

const PAPERS: [string, number, number][] = [
  ['A0', 1189, 841],
  ['A1', 841, 594],
  ['A2', 594, 420],
  ['A3', 420, 297],
  ['A4', 297, 210],
]

/** CSS @page size for a paper size in mm (named sizes when they match). */
export function pageSize(wmm: number, hmm: number): string {
  const [a, b] = wmm >= hmm ? [wmm, hmm] : [hmm, wmm]
  const hit = PAPERS.find(([, x, y]) => Math.abs(x - a) < 2 && Math.abs(y - b) < 2)
  if (hit) return `${hit[0]} ${wmm >= hmm ? 'landscape' : 'portrait'}`
  return `${Math.round(wmm)}mm ${Math.round(hmm)}mm`
}

export function printSvg(svg: string, wmm: number, hmm: number, title: string) {
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.append(frame)
  const doc = frame.contentDocument!
  doc.open()
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title>
<style>@page{size:${pageSize(wmm, hmm)};margin:0}html,body{margin:0;padding:0}
svg{display:block;width:${wmm}mm;height:${hmm}mm}</style></head><body>${svg}</body></html>`)
  doc.close()
  const go = () => {
    frame.contentWindow!.focus()
    frame.contentWindow!.print()
    // give the keyboard back to the viewer (shortcuts would go to the hidden frame)
    window.focus()
    setTimeout(() => frame.remove(), 60_000)
  }
  // let embedded images decode first
  setTimeout(go, 300)
}
