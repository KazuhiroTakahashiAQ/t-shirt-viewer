import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/** Files of the public directory (copied as they are), relative to it. */
function publicFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(relative(dir, p).split('\\').join('/'))
    }
  }
  walk(dir)
  return out
}

/**
 * Fill in the service worker's list of files to keep for offline use (every file of the
 * build) and its version (a hash of their contents, so any change installs a new version).
 */
function precache(): Plugin {
  return {
    name: 'tfas-precache',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const sw = bundle['sw.js']
      if (!sw || sw.type !== 'chunk') return
      const hash = createHash('sha256')
      const files: string[] = []
      for (const [name, item] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        if (name === 'sw.js' || name.endsWith('.map')) continue
        files.push(name)
        hash.update(name).update(item.type === 'chunk' ? item.code : item.source)
      }
      for (const name of publicFiles('public').sort()) {
        files.push(name)
        hash.update(name).update(readFileSync(join('public', name)))
      }
      const list = JSON.stringify(['./', ...files])
      sw.code = sw.code.replace(/(["'`])__PRECACHE_FILES__\1/g, list).replace(/__PRECACHE_VERSION__/g, hash.digest('hex').slice(0, 16))
      if (sw.code.includes('__PRECACHE_')) this.error('service worker placeholders were not replaced')
    },
  }
}

export default defineConfig({
  base: './',
  // fixed ports: other Vite apps take 5173 and up, and an installed PWA belongs to one origin
  // (host and port), so the app must always be served at the same address
  server: { port: 5180, strictPort: true },
  preview: { port: 5181, strictPort: true },
  worker: { format: 'es' },
  plugins: [precache()],
  build: {
    rollupOptions: {
      // main viewer, the separate 3D window and the service worker (sw.js at the root, so
      // that it covers both pages)
      input: { main: 'index.html', view3d: 'view3d.html', sw: 'src/sw.ts' },
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
})
