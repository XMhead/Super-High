import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import CliCompletionNotice from './components/CliCompletionNotice.vue'
import { parseCompletionNotice } from './lib/cliCompletion'
import './styles.css'


const completionNotice = new URLSearchParams(window.location.search).get('cliCompletion')
if (new URLSearchParams(window.location.search).has('editorWindow')) {
  void import('./components/EditorWindowApp.vue').then(({ default: EditorWindowApp }) => {
    createApp(EditorWindowApp).use(createPinia()).mount('#app')
  })
} else if (completionNotice) {
  createApp(CliCompletionNotice, { ...parseCompletionNotice(completionNotice) }).mount('#app')
} else {
  createApp(App).use(createPinia()).mount('#app')
}
