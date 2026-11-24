import { createApp } from 'vue'
import { applyTheme } from '@/lib/theme'
import { applyFontStyle } from '@/lib/fontStyles'
import NoticeDetail from './NoticeDetail.vue'
import '../styles.css'
import '../markdown.css'

applyTheme('dark')
applyFontStyle('anthropic')
createApp(NoticeDetail).mount('#app')
