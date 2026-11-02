import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import CliCompletionNotice from './components/CliCompletionNotice.vue'
import { parseCompletionNotice } from './lib/cliCompletion'
import './styles.css'


const completionNotice = new URLSearchParams(window.location.search).get('cliCompletion')
if (completionNotice) {
  createApp(CliCompletionNotice, { ...parseCompletionNotice(completionNotice) }).mount('#app')
} else {
  createApp(App).use(createPinia()).mount('#app')
}
