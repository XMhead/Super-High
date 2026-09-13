const FILE_EXTENSION_PATTERN = [
  'ya?ml', 'json', 'toml', 'ini', 'properties', 'conf', 'cfg',
  'md', 'mdx', 'txt',
  'py', 'js', 'jsx', 'ts', 'tsx', 'vue', 'html?', 'css', 'scss', 'sass', 'less',
  'rs', 'java', 'kt', 'kts', 'cs', 'c', 'h', 'cpp', 'cxx', 'hpp',
  'xml', 'mcfunction', 'ps1', 'bat', 'cmd', 'sh',
].join('|')

const ABSOLUTE_PATH_SEGMENT = '[^\\\\/:*?"<>|`[\\](){}]+'
const RELATIVE_PATH_SEGMENT = '[^\\\\/:*?"<>|`[\\](){}\\s]+'
const FILE_REFERENCE_PATTERN = new RegExp(
  `(?:^|(?<=[\\s\`"'([{<：,，;；]))(?:[A-Za-z]:[\\\\/](?:(?:${ABSOLUTE_PATH_SEGMENT})[\\\\/])+${ABSOLUTE_PATH_SEGMENT}|(?:(?:${RELATIVE_PATH_SEGMENT})[\\\\/])+${RELATIVE_PATH_SEGMENT})\\.(?:${FILE_EXTENSION_PATTERN})(?::(\\d+)(?::(\\d+))?|#L(\\d+)(?::(\\d+))?)?`,
  'gi',
)

export interface ScriptToolFileReference {
  text: string
  filePath: string
  index: number
  lineNumber?: number
  column?: number
}

export function findScriptToolFileReferences(text: string): ScriptToolFileReference[] {
  const references: ScriptToolFileReference[] = []
  FILE_REFERENCE_PATTERN.lastIndex = 0

  for (let match = FILE_REFERENCE_PATTERN.exec(text); match; match = FILE_REFERENCE_PATTERN.exec(text)) {
    const lineNumber = Number(match[1] ?? match[3]) || undefined
    const column = Number(match[2] ?? match[4]) || undefined
    const suffixLength = lineNumber ? (match[0].match(/(?::\d+(?::\d+)?|#L\d+(?::\d+)?)$/i)?.[0].length ?? 0) : 0
    references.push({
      text: match[0],
      filePath: suffixLength ? match[0].slice(0, -suffixLength) : match[0],
      index: match.index,
      lineNumber,
      column,
    })
  }

  return references
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

export function resolveScriptToolWorkspaceFile(workspaceRoot: string, referencePath: string): string | null {
  const root = normalizePath(workspaceRoot).replace(/\/+$/, '')
  const reference = normalizePath(referencePath.trim())
  if (!root || !reference) return null

  const isAbsolute = /^[A-Za-z]:\//.test(reference)
  if (!isAbsolute && (reference.startsWith('/') || reference.split('/').includes('..'))) return null

  const target = isAbsolute
    ? reference
    : `${root}/${reference.replace(/^(\.\/)+/, '')}`
  const rootKey = root.toLowerCase()
  const targetKey = target.toLowerCase()
  if (!targetKey.startsWith(`${rootKey}/`)) return null

  return target
}
