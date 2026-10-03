import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import DragonCoreToolsWindow from './components/DragonCoreToolsWindow.vue'
import './styles.css'

const isDragonCoreToolsWindow = new URLSearchParams(window.location.search).get('dragoncoreTools') === '1'

createApp(isDragonCoreToolsWindow ? DragonCoreToolsWindow : App).use(createPinia()).mount('#app')
