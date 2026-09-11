import { File, FileCode2, FileImage, FileJson, FileText } from 'lucide-vue-next'
import { isMediaFile } from './path'

export function fileIconTone(path: string, extension?: string | null) {
  extension = (extension ?? path.match(/\.[^./\\]+$/)?.[0] ?? '').toLowerCase()
  if (['.ts', '.tsx', '.js', '.jsx', '.vue', '.css', '.html', '.rs'].includes(extension)) return 'code'
  if (['.json', '.jsonc', '.lock', '.yml', '.yaml', '.toml', '.xml', '.ini'].includes(extension)) return 'data'
  if (['.md', '.mdx', '.txt'].includes(extension)) return 'document'
  if (isMediaFile(path)) return 'image'
  return 'file'
}

export const fileIconComponents = { code: FileCode2, data: FileJson, document: FileText, image: FileImage, file: File }
