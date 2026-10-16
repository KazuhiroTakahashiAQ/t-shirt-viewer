// 最近開いたファイル: the drawings opened recently, remembered as file handles (File System
// Access API: Chrome / Edge) in IndexedDB so that they can be opened again without picking
// them. Web pages are not told where a file is on the disk; a drawing taken from a folder
// (［フォルダを開く］ or a dropped folder) keeps its path inside that folder.

/** Read access to a handle (not in TypeScript's DOM types yet). */
interface PermissionHandle {
  queryPermission(d: { mode: 'read' }): Promise<PermissionState>
  requestPermission(d: { mode: 'read' }): Promise<PermissionState>
}

export interface RecentItem {
  id: string
  /** file name of the drawing */
  name: string
  /** folder path to the drawing (folder name first) when it was opened from a folder */
  path: string[]
  /** opened last (ms) */
  at: number
  file: FileSystemFileHandle
  /** files opened with it that it needs (frames and other external references) */
  others: FileSystemFileHandle[]
  /** the folder it was taken from (asking for its permission covers the files in it) */
  dir: FileSystemDirectoryHandle | null
}

const DB = 't-shirt-viewer'
const STORE = 'recent'
const MAX = 10

/** Whether files can be remembered (handles from the file pickers). */
export const recentSupported = typeof window !== 'undefined' && 'showOpenFilePicker' in window && 'indexedDB' in window

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' })
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(d.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    d.close()
  }
}

/** Remembered drawings, the last opened first (empty when storage is unavailable). */
export async function recentList(): Promise<RecentItem[]> {
  if (!recentSupported) return []
  try {
    const all = await tx<RecentItem[]>('readonly', (s) => s.getAll())
    return all.sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

/** Remember a drawing that was opened (replacing an older record of the same file). */
export async function remember(item: Omit<RecentItem, 'id' | 'at'>): Promise<void> {
  if (!recentSupported) return
  try {
    const list = await recentList()
    for (const r of list) if (await r.file.isSameEntry(item.file)) await tx('readwrite', (s) => s.delete(r.id))
    await tx('readwrite', (s) => s.put({ ...item, id: crypto.randomUUID(), at: Date.now() }))
    const rest = (await recentList()).slice(MAX)
    for (const r of rest) await tx('readwrite', (s) => s.delete(r.id))
  } catch {
    // storage unavailable (private window etc.): not remembered
  }
}

export async function forget(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id)).catch(() => {})
}

export async function forgetAll(): Promise<void> {
  await tx('readwrite', (s) => s.clear()).catch(() => {})
}

/** Path shown for an item: folder/…/file name, or the file name alone. */
export function recentPath(r: RecentItem): string {
  return [...r.path, r.name].join('/')
}

/**
 * Read the files of a remembered drawing again. Must run from a click: the browser may ask
 * for permission to read them. Frame files that can no longer be read are left out.
 * 'denied': reading was not allowed; 'missing': the drawing was moved or deleted.
 */
export async function reopen(r: RecentItem): Promise<{ file: File; others: { file: File; handle: FileSystemFileHandle }[] } | 'denied' | 'missing'> {
  const allowed = async (h: FileSystemHandle) => {
    const p = h as unknown as PermissionHandle
    if ((await p.queryPermission({ mode: 'read' })) === 'granted') return true
    return (await p.requestPermission({ mode: 'read' })) === 'granted'
  }
  try {
    if (!(await allowed(r.dir ?? r.file))) return 'denied'
  } catch {
    return 'denied'
  }
  try {
    const file = await r.file.getFile()
    const others: { file: File; handle: FileSystemFileHandle }[] = []
    for (const h of r.others) {
      try {
        if (r.dir || (await allowed(h))) others.push({ file: await h.getFile(), handle: h })
      } catch {
        // a frame file that was moved or deleted: the drawing opens without it
      }
    }
    return { file, others }
  } catch {
    return 'missing'
  }
}

/** drawings and parts library files */
const WANTED = /\.(tfs|ncp|mdb|usr)$/i

/** The drawings and parts library files in a folder, with their paths (folder name first). */
export async function walkFolder(dir: FileSystemDirectoryHandle): Promise<{ file: File; handle: FileSystemFileHandle; path: string[] }[]> {
  const out: { file: File; handle: FileSystemFileHandle; path: string[] }[] = []
  const walk = async (d: FileSystemDirectoryHandle, path: string[]) => {
    for await (const h of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, [...path, h.name])
      else if (WANTED.test(h.name)) {
        const fh = h as FileSystemFileHandle
        out.push({ file: await fh.getFile(), handle: fh, path })
      }
    }
  }
  await walk(dir, [dir.name])
  return out
}
