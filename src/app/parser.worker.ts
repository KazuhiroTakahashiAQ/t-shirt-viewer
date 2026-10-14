// Parses .tfs files off the main thread and transfers the geometry buffers back.
// `kind: '3d'` builds the 3D model (src/tfas/model3d.ts) instead of the plan document.
import { read3d } from '../tfas/model3d.ts'
import { readTfas } from '../tfas/reader.ts'

interface Request {
  id: number
  name: string
  buffer: ArrayBuffer
  kind?: 'doc' | '3d'
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, name, buffer, kind } = e.data
  try {
    if (kind === '3d') {
      const model = read3d(new Uint8Array(buffer))
      ;(self as unknown as Worker).postMessage({ id, model }, [model.tri.buffer as ArrayBuffer, model.triNormal.buffer as ArrayBuffer, model.line.buffer as ArrayBuffer])
      return
    }
    const doc = readTfas(new Uint8Array(buffer), name)
    const transfer: ArrayBuffer[] = []
    for (const l of doc.layers) {
      const g = l.geom
      transfer.push(g.types.buffer, g.flags.buffer, g.styles.buffer, g.offsets.buffer, g.coords.buffer as ArrayBuffer, g.entity.buffer as ArrayBuffer)
      for (const im of l.images) {
        if (im.bitmap) transfer.push(im.bitmap.rgba.buffer as ArrayBuffer)
        if (im.encoded) transfer.push(im.encoded.data.buffer as ArrayBuffer)
      }
    }
    if (doc.thumbnail) transfer.push(doc.thumbnail.rgba.buffer as ArrayBuffer)
    ;(self as unknown as Worker).postMessage({ id, doc }, transfer)
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: (err as Error).message })
  }
}
