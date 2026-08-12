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

const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.ico',
  '.avif',
])

export function extensionFromPath(path: string): string {
  const name = fileNameFromPath(path).toLowerCase()
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index) : ''
}

export function isPreviewableImage(path: string): boolean {
  return PREVIEWABLE_IMAGE_EXTENSIONS.has(extensionFromPath(path))
}

export function inferLanguage(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.ts')) return 'typescript'
  if (lower.endsWith('.tsx')) return 'typescript'
  if (lower.endsWith('.js')) return 'javascript'
  if (lower.endsWith('.jsx')) return 'javascript'
  if (lower.endsWith('.py')) return 'python'
  if (lower.endsWith('.vue')) return 'html'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown'
  if (lower.endsWith('.rs')) return 'rust'
  if (lower.endsWith('.css')) return 'css'
  if (lower.endsWith('.html')) return 'html'
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml'
  if (lower.endsWith('.toml')) return 'ini'
  return 'plaintext'
}
