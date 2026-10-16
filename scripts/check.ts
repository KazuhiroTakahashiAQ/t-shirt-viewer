// Parse every .tfs file under the given directories (plan document and 3D model) and
// print a summary. Parts library
// folders (.NCP / .MDB / .USR) directly below the given directories are opened too and
// every view of every part is decoded.
// usage: node scripts/check.ts <dir|file>...
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isLibraryFile, openPartsLibrary, readLibraryModel, readLibraryView } from '../src/tfs/library.ts'
import { read3d } from '../src/tfs/model3d.ts'
import { readTfs } from '../src/tfs/reader.ts'

const libraryDirs: string[] = []

function collect(p: string, out: string[]) {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const f of readdirSync(p).sort()) {
      const q = join(p, f)
      if (statSync(q).isDirectory()) {
        if (readdirSync(q).some((n) => /\.(ncp|mdb|usr)$/i.test(n))) libraryDirs.push(q)
        continue
      }
      if (f.toLowerCase().endsWith('.tfs')) out.push(q)
    }
  } else out.push(p)
}

const files: string[] = []
for (const a of process.argv.slice(2)) collect(a, files)
let ok = 0
let failed = 0
let totalPrims = 0
let totalTexts = 0
let total3d = 0
const t0 = performance.now()
for (const f of files) {
  try {
    const data = new Uint8Array(readFileSync(f))
    const doc = readTfs(data, basename(f))
    const m3 = read3d(data)
    const n3 = m3.objects.length
    total3d += n3
    const vis = doc.layers.filter((l) => l.visible).length
    const xrefs = doc.layers.filter((l) => l.xref).map((l) => l.xref!.fileName)
    totalPrims += doc.stats.primitives
    totalTexts += doc.stats.texts
    ok++
    console.log(
      [
        basename(f).slice(0, 34).padEnd(34),
        `v${doc.version}`.padEnd(12),
        `1/${doc.scale}`.padEnd(6),
        `layers ${vis}/${doc.layers.length}`.padEnd(13),
        `prims ${doc.stats.primitives}`.padEnd(13),
        `texts ${doc.stats.texts}`.padEnd(11),
        `layouts ${doc.layouts.length}`.padEnd(10),
        `${doc.stats.parseMs}ms`.padEnd(7),
        `3d ${n3}`.padEnd(8),
        xrefs.length ? `xref ${[...new Set(xrefs)].join(',')}` : '',
        doc.warnings.length || m3.warnings.length ? `WARN ${[...doc.warnings, ...m3.warnings].join(' / ')}` : '',
      ].join(' '),
    )
  } catch (e) {
    failed++
    console.log(`${basename(f).padEnd(34)} FAILED ${(e as Error).stack}`)
  }
}
console.log(`\n${files.length} files: ${ok} ok, ${failed} failed, ${totalPrims} primitives, ${totalTexts} texts, ${total3d} 3D objects, ${Math.round(performance.now() - t0)}ms`)

for (const dir of libraryDirs) {
  const t1 = performance.now()
  try {
    const libFiles = readdirSync(dir)
      .map((n) => ({ name: n, data: new Uint8Array(readFileSync(join(dir, n))) }))
      .filter((f) => isLibraryFile(f.name, f.data))
    const lib = openPartsLibrary(libFiles)
    let views = 0
    let empty = 0
    let models = 0
    let viewFails = 0
    for (const p of lib.parts) {
      for (const v of p.views) {
        try {
          const d = readLibraryView(lib, p, v)
          views++
          if (!d?.bbox) empty++
        } catch {
          viewFails++
        }
      }
      if (p.hasModel && readLibraryModel(lib, p)) models++
    }
    if (viewFails) failed++
    console.log(`library ${basename(dir)}: ${lib.kind} "${lib.title}" ${lib.parts.length} parts, ${views} views (${empty} empty, ${viewFails} failed), ${models} 3D models, ${Math.round(performance.now() - t1)}ms${lib.warnings.length ? ` WARN ${lib.warnings.join(' / ')}` : ''}`)
  } catch (e) {
    failed++
    console.log(`library ${basename(dir)} FAILED ${(e as Error).stack}`)
  }
}
process.exitCode = failed ? 1 : 0
