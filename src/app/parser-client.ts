// Client of the parsing worker (main window and the separate 3D window). Requests are
// answered by id. When the worker dies (e.g. out of memory on a damaged file) its pending
// requests fail and a fresh worker is started for the next request.

import type { Model3D } from '../tfs/model3d.ts'
import type { TfsDocument } from '../tfs/model.ts'

interface Reply {
  id: number
  doc?: TfsDocument
  model?: Model3D
  error?: string
}

export class ParserClient {
  private worker: Worker | null = null
  private reqId = 0
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()

  private start(): Worker {
    const w = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<Reply>) => {
      const p = this.pending.get(e.data.id)
      if (!p) return
      this.pending.delete(e.data.id)
      const result = e.data.doc ?? e.data.model
      if (result) p.resolve(result as never)
      else p.reject(new Error(e.data.error ?? '不明なエラー'))
    }
    w.onerror = (e) => {
      e.preventDefault()
      this.fail(new Error('解析処理が異常終了しました (ファイルが壊れているか、大きすぎる可能性があります)'))
    }
    w.onmessageerror = () => this.fail(new Error('解析結果を受け取れませんでした'))
    return w
  }

  private fail(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    this.worker?.terminate()
    this.worker = null
  }

  /** Parse a drawing ('doc') or build its 3D model ('3d'); the buffer is transferred. */
  request<T extends TfsDocument | Model3D>(kind: 'doc' | '3d', name: string, buffer: ArrayBuffer): Promise<T> {
    this.worker ??= this.start()
    const worker = this.worker
    return new Promise<T>((resolve, reject) => {
      const id = ++this.reqId
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ id, name, buffer, kind }, [buffer])
    })
  }
}
