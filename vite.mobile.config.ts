import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

function mobilePreviewRoutes(): Plugin {
  return {
    name: 'mobile-preview-routes',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
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

export default defineConfig({
  base: './',
  plugins: [vue(), mobilePreviewRoutes()],
  optimizeDeps: {
    include: ['lucide-vue-next'],
  },
  build: {
    outDir: 'dist-mobile',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        mobile: fileURLToPath(new URL('./index.mobile.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 1421,
    strictPort: true,
    proxy: {
      '/api/mobile': {
        target: process.env.SUPERHIGH_MOBILE_HOST || 'http://127.0.0.1:10320',
        changeOrigin: true,
      },
    },
  },
  clearScreen: false,
})
