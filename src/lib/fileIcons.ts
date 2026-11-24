import { File, FileCode2, FileImage, FileJson, FileText } from 'lucide-vue-next'
import BlockbenchIcon from '@/components/icons/BlockbenchIcon.vue'
import JavaIcon from '@/components/icons/JavaIcon.vue'
import NotepadPlusPlusIcon from '@/components/icons/NotepadPlusPlusIcon.vue'
import { isMediaFile } from './path'
import { h, render, type Component } from 'vue'

export function fileIconTone(path: string, extension?: string | null) {
  extension = (extension ?? path.match(/\.[^./\\]+$/)?.[0] ?? '').toLowerCase()
  if (extension === '.bbmodel') return 'model'
  if (extension === '.jar') return 'java'
  if (['.yml', '.yaml'].includes(extension)) return 'yaml'
  if (['.ts', '.tsx', '.js', '.jsx', '.vue', '.css', '.html', '.rs'].includes(extension)) return 'code'
  if (['.json', '.jsonc', '.lock', '.toml', '.xml', '.ini'].includes(extension)) return 'data'
  if (['.md', '.mdx', '.txt'].includes(extension)) return 'document'
  if (isMediaFile(path)) return 'image'
  return 'file'
}

export const fileIconComponents = { code: FileCode2, data: FileJson, document: FileText, image: FileImage, model: BlockbenchIcon, java: JavaIcon, yaml: NotepadPlusPlusIcon, file: File }

/** Shared file icons for rendered Markdown, which has no Vue component tree. */
export function fileIconElement(path: string): HTMLElement {
  const tone = fileIconTone(path)
  const holder = document.createElement('span')
  holder.className = `tree-kind-icon ${tone}`
  holder.setAttribute('aria-hidden', 'true')
  render(h(fileIconComponents[tone] as Component, { size: 14 }), holder)
  const icon = holder.cloneNode(true) as HTMLElement
  render(null, holder)
  return icon
}
