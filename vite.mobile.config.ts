import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { existsSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import { localPreviewRequest, readLocalMobileHost } from './scripts/mobile-preview-host'

function localHost() {
  try { return readLocalMobileHost() } catch { return null }
}

function mobilePreviewRoutes(): Plugin {
  return {
    name: 'mobile-preview-routes',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (url.pathname === '/__superhigh_preview/connection') {
          response.setHeader('Cache-Control', 'no-store')
          response.setHeader('Content-Type', 'application/json')
          const host = localHost()
          if (request.method !== 'GET' || !localPreviewRequest(request) || !host || (process.env.SUPERHIGH_MOBILE_HOST && process.env.SUPERHIGH_MOBILE_HOST !== host.target)) {
            response.statusCode = 404
            response.end('{}')
          } else {
            response.end(JSON.stringify({ token: host.token }))
          }
          return
        }
        if (url.pathname === '/mobile') {
          response.writeHead(302, { Location: `/mobile/${url.search}` })
          response.end()
          return
        }
        if (url.pathname === '/') request.url = `/mobile-preview.html${url.search}`
        if (url.pathname === '/mobile/') request.url = `/index.mobile.html${url.search}`
        next()
      })
    },
  }
}

function mobileBuildInputs(): Plugin {
  return {
    name: 'mobile-build-inputs',
    apply: 'build',
    generateBundle() {
      const modules = [...this.getModuleIds(), ...this.getWatchFiles()]
        .map(id => id.split('?')[0])
        .filter(id => !id.startsWith('\0') && existsSync(id) && statSync(id).isFile())
        .map(id => relative(process.cwd(), id).replaceAll('\\', '/'))
      this.emitFile({ type: 'asset', fileName: '.mobile-build-inputs.json', source: JSON.stringify({ modules: [...new Set(modules)].sort() }) })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [vue(), mobilePreviewRoutes(), mobileBuildInputs()],
  optimizeDeps: {
    include: ['lucide-vue-next'],
  },
  build: {
    outDir: 'dist-mobile',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        editorUi: fileURLToPath(new URL('./editor-ui-runtime.html', import.meta.url)),
        mobile: fileURLToPath(new URL('./index.mobile.html', import.meta.url)),
        noticeDetail: fileURLToPath(new URL('./notice-detail.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    cors: { origin: [/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/, 'null'] },
    port: 1421,
    strictPort: true,
    watch: {
      ignored: ['**/.agent/**', '**/.superhigh/cache/**', '**/.publish-worktree/**', '**/src-tauri/target*/**', '**/dist-mobile/**', '**/android/**'],
    },
    proxy: {
      '/api/mobile': {
        target: process.env.SUPERHIGH_MOBILE_HOST || localHost()?.target || 'http://127.0.0.1:10320',
        changeOrigin: true,
      },
    },
  },
  clearScreen: false,
})
