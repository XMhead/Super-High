export interface BreadcrumbSegment {
  label: string
  path: string
}

export function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/')
  return normalized.replace(/^\/([A-Za-z]:\/)/, '$1')
}

export function buildBreadcrumbs(path: string): BreadcrumbSegment[] {
  const normalized = normalizePath(path)
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return []

  const breadcrumbs: BreadcrumbSegment[] = []
  let current = parts[0].endsWith(':') ? `${parts[0]}/` : ''

  parts.forEach((part, index) => {
    if (index === 0 && part.endsWith(':')) {
      current = `${part}/`
      breadcrumbs.push({ label: part, path: current })
      return
    }
    current = current ? `${current.replace(/\/+$/, '')}/${part}` : part
    breadcrumbs.push({ label: part, path: current })
  })

  return breadcrumbs
}

export function buildWorkspaceBreadcrumbs(path: string, workspaceRootPath?: string | null): BreadcrumbSegment[] {
  const normalizedPath = trimTrailingPathSlash(normalizePath(path))
  const normalizedRoot = trimTrailingPathSlash(normalizePath(workspaceRootPath ?? ''))
  if (!normalizedPath || !normalizedRoot) return buildBreadcrumbs(path)

  const pathKey = normalizedPath.toLowerCase()
  const rootKey = normalizedRoot.toLowerCase()
  const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
  const rootPrefixKey = rootPrefix.toLowerCase()

  if (pathKey === rootKey) return buildBreadcrumbs(normalizedPath).slice(-1)
  if (!pathKey.startsWith(rootPrefixKey)) return buildBreadcrumbs(path)

  const relativeParts = normalizedPath.slice(rootPrefix.length).split('/').filter(Boolean)
  const breadcrumbs: BreadcrumbSegment[] = []
  let current = normalizedRoot
  for (const part of relativeParts) {
    current = current.endsWith('/') ? `${current}${part}` : `${current}/${part}`
    breadcrumbs.push({ label: part, path: current })
  }
  return breadcrumbs
}

function trimTrailingPathSlash(path: string): string {
  if (!path) return ''
  if (/^[A-Za-z]:\/$/.test(path)) return path
  return path.replace(/\/+$/, '')
}

export function fileNameFromPath(path: string): string {
  return normalizePath(path).split('/').filter(Boolean).pop() ?? path
}

export const MEDIA_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
  '.avif',
] as const

export const MEDIA_VIDEO_EXTENSIONS = [
  '.mp4',
  '.webm',
  '.ogg',
  '.ogv',
  '.mov',
  '.mkv',
  '.avi',
  '.m4v',
  '.wmv',
] as const

const MEDIA_IMAGE_EXTENSION_SET = new Set<string>(MEDIA_IMAGE_EXTENSIONS)
const MEDIA_VIDEO_EXTENSION_SET = new Set<string>(MEDIA_VIDEO_EXTENSIONS)

export function extensionFromPath(path: string): string {
  const name = fileNameFromPath(path).toLowerCase()
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index) : ''
}

export function isPreviewableImage(path: string): boolean {
  return isMediaImage(path)
}

export function isOfficeDocument(path: string): boolean {
  return ['.doc', '.docx', '.pdf', '.xlsx'].includes(extensionFromPath(path))
}

export function isMediaImage(path: string): boolean {
  return MEDIA_IMAGE_EXTENSION_SET.has(extensionFromPath(path))
}

export function isMediaVideo(path: string): boolean {
  return MEDIA_VIDEO_EXTENSION_SET.has(extensionFromPath(path))
}

export function isMediaAudio(path: string): boolean {
  return ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.oga', '.opus'].includes(extensionFromPath(path))
}

export function isPlayableMedia(path: string): boolean {
  return isMediaVideo(path) || isMediaAudio(path)
}

export function isMediaFile(path: string): boolean {
  return isMediaImage(path) || isMediaVideo(path)
}

export function isRasterMediaImage(path: string): boolean {
  return isMediaImage(path) && extensionFromPath(path) !== '.svg'
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.pyi': 'python',
  '.rpy': 'python',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.ksh': 'shell',
  '.vue': 'html',
  '.svelte': 'html',
  '.astro': 'html',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.properties': 'ini',
  '.xml': 'xml',
  '.xsd': 'xml',
  '.xsl': 'xml',
  '.xslt': 'xml',
  '.plist': 'xml',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hh': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.csx': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.lua': 'lua',
  '.pl': 'perl',
  '.pm': 'perl',
  '.r': 'r',
  '.dart': 'dart',
  '.swift': 'swift',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'proto',
  '.hcl': 'hcl',
  '.tf': 'hcl',
  '.tfvars': 'hcl',
  '.fs': 'fsharp',
  '.fsx': 'fsharp',
  '.scala': 'scala',
  '.sc': 'scala',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.jl': 'julia',
  '.sol': 'sol',
  '.tcl': 'tcl',
  '.v': 'verilog',
  '.sv': 'systemverilog',
  '.svh': 'systemverilog',
  '.wgsl': 'wgsl',
}

const LANGUAGE_BY_FILENAME: Readonly<Record<string, string>> = {
  '.editorconfig': 'ini',
  '.env': 'ini',
  '.gitconfig': 'ini',
  '.npmrc': 'ini',
  '.yarnrc': 'ini',
  'containerfile': 'dockerfile',
  'dockerfile': 'dockerfile',
  'gemfile': 'ruby',
  'rakefile': 'ruby',
}

export function inferLanguage(name: string): string {
  const fileName = fileNameFromPath(name).toLowerCase()
  const exactMatch = LANGUAGE_BY_FILENAME[fileName]
  if (exactMatch) return exactMatch
  if (fileName.startsWith('dockerfile.') || fileName.startsWith('containerfile.')) return 'dockerfile'
  if (fileName.startsWith('.env.')) return 'ini'
  return LANGUAGE_BY_EXTENSION[extensionFromPath(fileName)] ?? 'plaintext'
}
