import { createApp } from 'vue'
import MobileApp from './MobileApp.vue'
import '../styles.css'
import './styles.css'

async function mount() {
  if (import.meta.env.DEV && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) {
    try {
      const response = await fetch('/__superhigh_preview/connection', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
      if (response.ok) {
        const connection = await response.json()
        if (typeof connection.token === 'string' && connection.token) {
          localStorage.setItem('super-high-mobile-connection', JSON.stringify({ baseUrl: window.location.origin, token: connection.token }))
        }
      }
    } catch { /* Keep the normal connection UI when the local desktop configuration is unavailable. */ }
  }
  createApp(MobileApp).mount('#app')
}

void mount()
