import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// PDF fonts, character maps and decoders must also work with no internet access.
const pdfResourceRoot = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url))
const pdfResourceFolders = ['cmaps', 'standard_fonts', 'wasm']

export default defineConfig({
  plugins: [vue(), {
    name: 'local-pdf-resources',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (request, response, next) => {
        const path = (request.url ?? '').split('?')[0]
        if (!/^(cmaps|standard_fonts|wasm)\/[\w.-]+$/.test(path)) return next()
        response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
        const stream = createReadStream(resolve(pdfResourceRoot, path))
        stream.on('error', () => { response.statusCode = 404; response.end() })
        stream.pipe(response)
      })
    },
    async generateBundle() {
      const { readFile } = await import('node:fs/promises')
      for (const folder of pdfResourceFolders) {
        for (const entry of await readdir(resolve(pdfResourceRoot, folder), { withFileTypes: true })) {
          if (!entry.isFile()) continue
          this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${entry.name}`, source: await readFile(resolve(pdfResourceRoot, folder, entry.name)) })
        }
      }
    },
  }],
  optimizeDeps: {
    include: ['lucide-vue-next', 'marked', 'pinia'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('monaco-editor')) return 'monaco-editor'
          if (id.includes('@xterm')) return 'xterm'
          if (id.includes('marked')) return 'markdown'
          return undefined
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
})
