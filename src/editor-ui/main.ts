import { createApp } from 'vue'
import { createPinia } from 'pinia'
import EditorUiRuntime from './EditorUiRuntime.vue'
import '@/styles.css'
import '@/superhigh-ui.css'

createApp(EditorUiRuntime).use(createPinia()).mount('#app')
