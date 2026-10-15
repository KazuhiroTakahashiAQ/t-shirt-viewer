// Installable app (PWA): the service worker for offline use (production builds only), the
// browser's install prompt, drawings opened from the OS (「プログラムから開く」 with the
// installed app: file_handlers in the manifest) and the notice of a new version.

interface LaunchParams {
  files?: FileSystemFileHandle[]
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void
}
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface PwaHooks {
  /** files chosen in the OS with this app */
  openFiles(files: { file: File; handle: FileSystemFileHandle }[]): void
  /** installing as an app became possible (true) or is no longer offered (false) */
  installable(on: boolean): void
  /** a new version is ready; `apply` switches to it (the page reloads) */
  updateReady(apply: () => void): void
}

let installEvent: BeforeInstallPromptEvent | null = null

export function initPwa(hooks: PwaHooks) {
  const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue
  queue?.setConsumer(async (params) => {
    if (!params.files?.length) return
    hooks.openFiles(await Promise.all(params.files.map(async (handle) => ({ file: await handle.getFile(), handle }))))
  })

  window.addEventListener('beforeinstallprompt', (e) => {
    // keep the browser's own banner away; the ヘルプ menu offers it
    e.preventDefault()
    installEvent = e as BeforeInstallPromptEvent
    hooks.installable(true)
  })
  window.addEventListener('appinstalled', () => {
    installEvent = null
    hooks.installable(false)
  })

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  let switching = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // only after 「更新」: the first installation also changes the controller
    if (switching) location.reload()
  })
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      const check = () => {
        const waiting = reg.waiting
        if (!waiting || !navigator.serviceWorker.controller) return
        hooks.updateReady(() => {
          switching = true
          waiting.postMessage('skip-waiting')
        })
      }
      check()
      reg.addEventListener('updatefound', () => {
        const w = reg.installing
        w?.addEventListener('statechange', () => w.state === 'installed' && check())
      })
    })
    .catch(() => {
      // not available (e.g. a private window): the viewer works without it
    })
}

/** Show the browser's install dialog (when offered). */
export async function promptInstall(): Promise<boolean> {
  const e = installEvent
  if (!e) return false
  await e.prompt()
  const { outcome } = await e.userChoice
  installEvent = null
  return outcome === 'accepted'
}
