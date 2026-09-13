import { LineCounter, isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml'

const GUI_ROOT = 'DragonCore/Gui'
const SUPPORTED_COMPONENT_TYPES = new Set([
  'texture',
  'label',
  'slot',
  'foreach',
  'hit',
  'textbox',
  'entity',
  'video',
  'textarea',
])
const COMPONENT_HINT_FIELDS = new Set([
  'type', 'extends', 'x', 'y', 'z', 'width', 'height', 'texture', 'texts', 'text',
  'visible', 'identifier', 'actions', 'src', 'data', 'scale', 'textScale',
])
const ADAPTIVE_NUMBER = /^\s*方法\.执行方法\(\s*(['"])(定位X|定位Y|设置宽度|设置高度)\1\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*;?\s*$/
const DIRECT_NUMBER = /^\s*(-?\d+(?:\.\d+)?)\s*$/

export type DragonCoreRange = { start: number; end: number }

export type DragonCoreEditableNumber = {
  mode: 'number' | 'adaptive'
  value: number
  functionName?: string
}

export type DragonCoreField = {
  key: string
  path: string[]
  kind: 'scalar' | 'mapping' | 'sequence' | 'null'
  value: unknown
  raw: string
  range: DragonCoreRange | null
  line: number
  column: number
  editableNumber: DragonCoreEditableNumber | null
}

export type DragonCoreComponent = {
  id: string
  name: string
  line: number
  column: number
  type: string
  supported: boolean
  depth: number
  templateOwner: string | null
  extends: string | null
  range: DragonCoreRange
  pairRange: DragonCoreRange
  keyRange: DragonCoreRange
  fields: DragonCoreField[]
}

export type DragonCoreDiagnostic = {
  severity: 'error' | 'warning'
  message: string
  line: number
  column: number
  range: DragonCoreRange | null
}

export type DragonCoreParseResult = {
  path: string
  hash: string
  lineEnding: '\n' | '\r\n'
  writable: boolean
  diagnostics: DragonCoreDiagnostic[]
  imports: string[]
  functions: DragonCoreField[]
  rootFields: DragonCoreField[]
  components: DragonCoreComponent[]
  canvas: { width: number; height: number }
}

export type DragonCorePatchMutation =
  | {
      kind: 'set-scalar'
      range: DragonCoreRange
      expectedRaw?: string
      value: unknown
      preserveExpression?: boolean
    }
  | {
      kind: 'delete-component'
      range: DragonCoreRange
    }
  | {
      kind: 'duplicate-component'
      range: DragonCoreRange
      keyRange: DragonCoreRange
      name: string
    }
  | {
      kind: 'insert-component'
      name: string
      componentType: string
    }
  | {
      kind: 'insert-field'
      range: DragonCoreRange
      depth: number
      key: string
      value: unknown
    }
  | {
      kind: 'replace-document'
      content: string
    }

export type DragonCoreHostContext = {
  workspaceRoot: string
  dragonCoreClientRootPath?: string
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<unknown>
  listDirectory: (path: string) => Promise<{ entries: Array<{ name: string; type: string; extension?: string | null }> }>
  readMediaAsDataUrl: (path: string) => Promise<string>
}

function nodeRange(node: any, includeTrailing = false): DragonCoreRange | null {
  if (!Array.isArray(node?.range) || node.range.length < 2) return null
  return { start: node.range[0], end: includeTrailing ? (node.range[2] ?? node.range[1]) : node.range[1] }
}

function scalarText(node: any): string | null {
  return isScalar(node) ? String(node.value ?? '') : null
}

function pairKey(pair: any): string {
  return scalarText(pair?.key) ?? String(pair?.key?.toJSON?.() ?? '')
}

function mapPair(map: any, key: string) {
  if (!isMap(map)) return null
  return map.items.find((pair: any) => pairKey(pair) === key) ?? null
}

function inferComponentType(name: string, map: any): string {
  const explicit = scalarText(mapPair(map, 'type')?.value)?.trim().toLowerCase()
  if (explicit) return explicit

  const suffix = name.trim().toLowerCase().match(/(?:^|[_-])(texture|label|slot|foreach|hit|textbox|entity|video|textarea)$/)?.[1]
  if (suffix) return suffix
  if (mapPair(map, 'data') && mapPair(map, 'src')) return 'foreach'
  if (mapPair(map, 'identifier')) return 'slot'
  if (mapPair(map, 'texture') || mapPair(map, 'textureHovered')) return 'texture'
  if (mapPair(map, 'texts') || mapPair(map, 'textScale')) return 'label'
  return 'template'
}

function plainValue(node: any): unknown {
  if (isScalar(node)) return node.value
  if (isSeq(node)) return node.items.map((item: any) => plainValue(item))
  if (isMap(node)) {
    const result: Record<string, unknown> = {}
    for (const pair of node.items) result[pairKey(pair)] = plainValue(pair.value)
    return result
  }
  return null
}

function editableNumber(raw: string): DragonCoreEditableNumber | null {
  const direct = raw.match(DIRECT_NUMBER)
  if (direct) return { mode: 'number', value: Number(direct[1]) }
  const adaptive = raw.match(ADAPTIVE_NUMBER)
  if (adaptive) return { mode: 'adaptive', functionName: adaptive[2], value: Number(adaptive[3]) }
  return null
}

function fieldFromPair(pair: any, path: string[], text: string, lineCounter: LineCounter): DragonCoreField {
  const key = pairKey(pair)
  const range = nodeRange(pair.value)
  const position = lineCounter.linePos(range?.start ?? nodeRange(pair.key)?.start ?? 0)
  const raw = range ? text.slice(range.start, range.end) : ''
  return {
    key,
    path: [...path, key],
    kind: isScalar(pair.value) ? 'scalar' : isMap(pair.value) ? 'mapping' : isSeq(pair.value) ? 'sequence' : 'null',
    value: plainValue(pair.value),
    raw,
    range,
    line: position.line,
    column: position.col,
    editableNumber: isScalar(pair.value) ? editableNumber(raw) : null,
  }
}

function componentFromPair(
  pair: any,
  path: string[],
  text: string,
  lineCounter: LineCounter,
  depth: number,
  templateOwner: string | null,
): DragonCoreComponent | null {
  if (!isMap(pair?.value)) return null
  const fields = pair.value.items.map((field: any) => fieldFromPair(field, path, text, lineCounter))
  if (!fields.some((field: DragonCoreField) => COMPONENT_HINT_FIELDS.has(field.key))) return null
  const name = pairKey(pair)
  const valueRange = nodeRange(pair.value, true)
  const keyRange = nodeRange(pair.key)
  if (!valueRange || !keyRange) return null
  const keyPosition = lineCounter.linePos(keyRange.start)
  const type = inferComponentType(name, pair.value)
  const inherited = scalarText(mapPair(pair.value, 'extends')?.value)?.trim() || null
  return {
    id: `${path.join('.')}:${keyRange.start}`,
    name,
    line: keyPosition.line,
    column: keyPosition.col,
    type,
    supported: type === 'template' || SUPPORTED_COMPONENT_TYPES.has(type),
    depth,
    templateOwner,
    extends: inherited,
    range: valueRange,
    pairRange: { start: keyRange.start, end: valueRange.end },
    keyRange,
    fields,
  }
}

function sequenceStrings(node: any): string[] {
  if (isScalar(node)) return String(node.value ?? '').trim() ? [String(node.value).trim()] : []
  if (!isSeq(node)) return []
  return node.items.map((item: any) => scalarText(item)?.trim()).filter((value): value is string => !!value)
}

function diagnostic(error: any, severity: 'error' | 'warning', lineCounter: LineCounter): DragonCoreDiagnostic {
  const position = Array.isArray(error?.pos) && typeof error.pos[0] === 'number' ? error.pos[0] : 0
  const end = Array.isArray(error?.pos) && typeof error.pos[1] === 'number' ? error.pos[1] : position
  const line = lineCounter.linePos(position)
  return {
    severity,
    message: String(error?.message ?? error),
    line: line.line,
    column: line.col,
    range: { start: position, end },
  }
}

export function dragonCoreContentHash(text: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    first ^= code
    first = Math.imul(first, 0x01000193)
    second ^= code + index
    second = Math.imul(second, 0x85ebca6b)
  }
  return `dc-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

export function parseDragonCoreGui(path: string, text: string): DragonCoreParseResult {
  const lineCounter = new LineCounter()
  const document = parseDocument(text, {
    keepSourceTokens: true,
    lineCounter,
    prettyErrors: false,
    strict: false,
    uniqueKeys: false,
  })
  const diagnostics = [
    ...document.errors.map((error) => diagnostic(error, 'error', lineCounter)),
    ...document.warnings.map((warning) => diagnostic(warning, 'warning', lineCounter)),
  ]
  const root = document.contents
  const rootFields: DragonCoreField[] = []
  const functions: DragonCoreField[] = []
  const components: DragonCoreComponent[] = []
  let imports: string[] = []

  if (isMap(root)) {
    for (const pair of root.items) {
      const key = pairKey(pair)
      if (key === 'import') {
        imports = sequenceStrings(pair.value)
        rootFields.push(fieldFromPair(pair, [], text, lineCounter))
        continue
      }
      if (key === 'Functions' && isMap(pair.value)) {
        functions.push(...pair.value.items.map((field: any) => fieldFromPair(field, ['Functions'], text, lineCounter)))
        continue
      }
      const component = componentFromPair(pair, [key], text, lineCounter, 0, null)
      if (!component) {
        rootFields.push(fieldFromPair(pair, [], text, lineCounter))
        continue
      }
      components.push(component)
      if (component.type !== 'foreach') continue
      const src = mapPair(pair.value, 'src')?.value
      if (!isMap(src)) continue
      for (const childPair of src.items) {
        const child = componentFromPair(childPair, [key, 'src', pairKey(childPair)], text, lineCounter, 1, key)
        if (child) components.push(child)
      }
    }
  } else if (text.trim()) {
    diagnostics.push({
      severity: 'error',
      message: 'DragonCore GUI 顶层必须是 YAML 映射。',
      line: 1,
      column: 1,
      range: null,
    })
  }

  const width = Number(rootFields.find((field) => field.key === '背景实际宽度')?.value)
  const height = Number(rootFields.find((field) => field.key === '背景实际高度')?.value)
  return {
    path,
    hash: dragonCoreContentHash(text),
    lineEnding: text.includes('\r\n') ? '\r\n' : '\n',
    writable: diagnostics.every((item) => item.severity !== 'error') && isMap(root),
    diagnostics,
    imports,
    functions,
    rootFields,
    components,
    canvas: {
      width: Number.isFinite(width) && width > 0 ? width : 686,
      height: Number.isFinite(height) && height > 0 ? height : 395,
    },
  }
}

function yamlScalar(value: unknown, previousRaw: string): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('DragonCore 数值必须是有限数字。')
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
  }
  if (typeof value === 'boolean' || value === null) return String(value)
  const text = String(value)
  if (previousRaw.startsWith("'") && previousRaw.endsWith("'")) return `'${text.replace(/'/g, "''")}'`
  if (previousRaw.startsWith('"') && previousRaw.endsWith('"')) return JSON.stringify(text)
  return stringify(text).trimEnd()
}

function replaceExpressionNumber(raw: string, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const formatted = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
  if (DIRECT_NUMBER.test(raw)) return raw.replace(DIRECT_NUMBER, (match) => match.replace(/-?\d+(?:\.\d+)?/, formatted))
  const adaptive = raw.match(ADAPTIVE_NUMBER)
  if (!adaptive) return null
  const numberStart = raw.lastIndexOf(adaptive[3])
  return `${raw.slice(0, numberStart)}${formatted}${raw.slice(numberStart + adaptive[3].length)}`
}

function lineBounds(text: string, range: DragonCoreRange): DragonCoreRange {
  const startBreak = text.lastIndexOf('\n', Math.max(0, range.start - 1))
  const endBreak = text.indexOf('\n', range.end)
  return { start: startBreak < 0 ? 0 : startBreak + 1, end: endBreak < 0 ? text.length : endBreak + 1 }
}

function assertRange(text: string, range: DragonCoreRange) {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > text.length) {
    throw new Error('DragonCore 补丁范围无效，请重新载入文件。')
  }
}

function validComponentName(name: string) {
  const value = name.trim()
  if (!value || /[\r\n:#{}\[\],&*!|>'"%@`]/.test(value)) throw new Error('组件名包含 YAML 不安全字符。')
  return value
}

function validFieldName(name: string) {
  const value = name.trim()
  if (!value || /[\r\n:#{}\[\],&*!|>'"%@`]/.test(value)) throw new Error('字段名包含 YAML 不安全字符。')
  return value
}

function componentSnippet(name: string, componentType: string, lineEnding: string) {
  const type = componentType.trim().toLowerCase()
  if (!SUPPORTED_COMPONENT_TYPES.has(type)) throw new Error(`不支持新增组件类型：${componentType}`)
  const common = [`${validComponentName(name)}:`, `  type: ${type}`]
  if (type === 'foreach') common.push('  data: 1', '  src:', '    子组件{index}:', '      type: texture', "      x: 方法.执行方法('定位X', 0)", "      y: 方法.执行方法('定位Y', 0)", "      width: 方法.执行方法('设置宽度', 80)", "      height: 方法.执行方法('设置高度', 30)")
  else {
    common.push("  x: 方法.执行方法('定位X', 0)", "  y: 方法.执行方法('定位Y', 0)")
    if (type === 'label') common.push("  texts: '新标签'", "  scale: 方法.执行方法('设置宽度', 1)")
    else {
      common.push("  width: 方法.执行方法('设置宽度', 80)", "  height: 方法.执行方法('设置高度', 30)")
      if (type === 'texture' || type === 'hit') common.push('  texture: 255,255,255,255')
      if (type === 'textbox' || type === 'textarea') common.push("  text: ''")
    }
  }
  return common.join(lineEnding)
}

export function removeYamlBlankLines(text: string): string {
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingLine = text.endsWith(lineEnding)
  const lines = text.split(/\r?\n/).filter((line, index, all) => line.trim().length > 0 || (hadTrailingLine && index === all.length - 1))
  return lines.join(lineEnding)
}

export function patchDragonCoreGui(
  text: string,
  expectedHash: string,
  mutations: DragonCorePatchMutation[],
): { content: string; parsed: DragonCoreParseResult } {
  if (dragonCoreContentHash(text) !== expectedHash) throw new Error('文件已被外部修改，请重新载入后再保存。')
  if (!Array.isArray(mutations) || !mutations.length) throw new Error('DragonCore 补丁不能为空。')
  const parsedBefore = parseDragonCoreGui('', text)
  if (!parsedBefore.writable) throw new Error('当前 YAML 存在语法错误，已禁止结构化写回。')
  const lineEnding = parsedBefore.lineEnding
  const replacementDocument = mutations.find((mutation): mutation is Extract<DragonCorePatchMutation, { kind: 'replace-document' }> => mutation.kind === 'replace-document')
  if (replacementDocument) {
    if (mutations.length !== 1) throw new Error('整文档替换不能和其它 DragonCore 补丁混用。')
    const content = removeYamlBlankLines(replacementDocument.content)
    const parsed = parseDragonCoreGui('', content)
    if (!parsed.writable) throw new Error(`撤销内容不是有效 YAML：${parsed.diagnostics[0]?.message ?? '未知错误'}`)
    return { content, parsed }
  }
  const replacements: Array<{ start: number; end: number; value: string }> = []

  for (const mutation of mutations) {
    if (mutation.kind === 'replace-document') continue
    if (mutation.kind === 'insert-component') {
      const prefix = text.length && !/\r?\n$/.test(text) ? lineEnding : ''
      replacements.push({ start: text.length, end: text.length, value: `${prefix}${componentSnippet(mutation.name, mutation.componentType, lineEnding)}${lineEnding}` })
      continue
    }
    assertRange(text, mutation.range)
    if (mutation.kind === 'set-scalar') {
      const currentRaw = text.slice(mutation.range.start, mutation.range.end)
      if (mutation.expectedRaw !== undefined && currentRaw !== mutation.expectedRaw) throw new Error('目标字段原文已变化，请重新载入后再保存。')
      const nextRaw = mutation.preserveExpression ? replaceExpressionNumber(currentRaw, mutation.value) : null
      replacements.push({ start: mutation.range.start, end: mutation.range.end, value: nextRaw ?? yamlScalar(mutation.value, currentRaw) })
    } else if (mutation.kind === 'delete-component') {
      const bounds = lineBounds(text, mutation.range)
      replacements.push({ ...bounds, value: '' })
    } else if (mutation.kind === 'duplicate-component') {
      assertRange(text, mutation.keyRange)
      if (mutation.keyRange.start < mutation.range.start || mutation.keyRange.end > mutation.range.end) throw new Error('组件 key 范围无效。')
      const bounds = lineBounds(text, mutation.range)
      const raw = text.slice(bounds.start, bounds.end)
      const relativeStart = mutation.keyRange.start - bounds.start
      const relativeEnd = mutation.keyRange.end - bounds.start
      const copy = `${raw.slice(0, relativeStart)}${validComponentName(mutation.name)}${raw.slice(relativeEnd)}`
      replacements.push({ start: bounds.end, end: bounds.end, value: copy })
    } else if (mutation.kind === 'insert-field') {
      const fieldName = validFieldName(mutation.key)
      const indent = ' '.repeat((Math.max(0, mutation.depth) + 1) * 2)
      const insertion = `${indent}${fieldName}: ${yamlScalar(mutation.value, '')}${lineEnding}`
      const start = mutation.range.end
      const prefix = start > 0 && text[start - 1] !== '\n' ? lineEnding : ''
      replacements.push({ start, end: start, value: `${prefix}${insertion}` })
    }
  }

  replacements.sort((left, right) => right.start - left.start)
  for (let index = 1; index < replacements.length; index++) {
    if (replacements[index - 1].start < replacements[index].end) throw new Error('DragonCore 补丁范围互相重叠。')
  }
  let content = text
  for (const replacement of replacements) content = `${content.slice(0, replacement.start)}${replacement.value}${content.slice(replacement.end)}`
  content = removeYamlBlankLines(content)
  const parsed = parseDragonCoreGui('', content)
  if (!parsed.writable) throw new Error(`补丁会生成无效 YAML：${parsed.diagnostics[0]?.message ?? '未知错误'}`)
  return { content, parsed }
}

export function createDragonCoreGui(match = ''): string {
  const safeMatch = stringify(String(match)).trimEnd()
  return [
    `match: ${safeMatch}`,
    '背景实际宽度: 686',
    '背景实际高度: 395',
    '界面大小: 1.2',
    'Functions:',
    "  定位X: return 背景.x+背景.width/方法.取yaml值('背景实际宽度')*局部变量.参数.0",
    "  定位Y: return 背景.y+背景.height/方法.取yaml值('背景实际高度')*局部变量.参数.0",
    "  设置宽度: return 背景.width/方法.取yaml值('背景实际宽度')*局部变量.参数.0",
    "  设置高度: return 背景.height/方法.取yaml值('背景实际高度')*局部变量.参数.0",
    '底色:',
    '  type: texture',
    '  x: 0',
    '  y: 0',
    '  width: w',
    '  height: h',
    '  texture: 0,0,0,168',
    '  z: -1',
    '背景:',
    '  type: texture',
    '  x: (w - 背景.width)*0.5',
    '  y: (h - 背景.height)*0.5',
    "  width: h*方法.取yaml值('界面大小')",
    "  height: 方法.执行方法('设置宽度', 方法.取yaml值('背景实际高度'))",
    '  texture: 255,255,255,255',
    '',
  ].join('\n')
}

function normalizeRelativePath(value: unknown, root?: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('DragonCore 文件路径不能为空。')
  const path = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!path || /^[a-zA-Z]:\//.test(path) || path.split('/').some((part) => part === '.' || part === '..')) throw new Error('DragonCore 只能访问受限相对路径。')
  if (root && path.toLowerCase() !== root.toLowerCase() && !path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) throw new Error(`DragonCore 文件必须位于 ${root}。`)
  return path
}

function joinPath(root: string, relative: string) {
  return `${root.replace(/[\\/]+$/, '')}/${relative.replace(/^[\\/]+/, '')}`
}

async function listGuiFiles(context: DragonCoreHostContext) {
  const files: string[] = []
  const visit = async (relative: string) => {
    const listing = await context.listDirectory(joinPath(context.workspaceRoot, relative))
    for (const entry of listing.entries) {
      const child = `${relative}/${entry.name}`.replace(/\\/g, '/')
      if (entry.type === 'directory') await visit(child)
      else if (/\.ya?ml$/i.test(entry.name)) files.push(child)
    }
  }
  await visit(GUI_ROOT)
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

function resolveImportPath(currentPath: string, value: string, files: string[]) {
  const normalized = value.replace(/\\/g, '/').replace(/^Gui\//i, '').replace(/\.ya?ml$/i, '')
  const currentDirectory = currentPath.slice(0, currentPath.lastIndexOf('/'))
  const candidates = [
    `${GUI_ROOT}/${normalized}`,
    `${currentDirectory}/${normalized}`,
  ]
  for (const candidate of candidates) {
    const match = files.find((file) => file.replace(/\.ya?ml$/i, '').toLowerCase() === candidate.toLowerCase())
    if (match) return match
  }
  return null
}

async function clientRoots(context: DragonCoreHostContext) {
  const configured = context.dragonCoreClientRootPath?.trim()
  const roots: string[] = []
  const add = (value: string) => {
    const normalized = value.replace(/[\\/]+$/, '')
    if (normalized && !roots.some((root) => root.toLowerCase() === normalized.toLowerCase())) roots.push(normalized)
  }
  if (configured) {
    add(configured)
    add(joinPath(configured, 'DragonCore'))
    add(joinPath(configured, 'resourcepacks/DragonCore'))
    add(joinPath(configured, '.minecraft/resourcepacks/DragonCore'))
  }
  try {
    const raw = await context.readFile(joinPath(context.workspaceRoot, '.superhigh/minecraft-client.json'))
    const parsed = JSON.parse(raw) as { clientRoot?: unknown }
    if (typeof parsed.clientRoot === 'string' && parsed.clientRoot.trim()) {
      const clientRoot = /^[a-zA-Z]:[\\/]/.test(parsed.clientRoot) ? parsed.clientRoot : joinPath(context.workspaceRoot, parsed.clientRoot)
      add(joinPath(clientRoot, '.minecraft/resourcepacks/DragonCore'))
      add(joinPath(clientRoot, 'resourcepacks/DragonCore'))
      add(joinPath(clientRoot, 'DragonCore'))
    }
  } catch {
    // A configured global DragonCore root remains sufficient.
  }
  return roots
}

export async function handleDragonCoreEditorOperation(
  operation: string,
  payload: Record<string, unknown>,
  context: DragonCoreHostContext,
): Promise<unknown> {
  if (!context.workspaceRoot) throw new Error('未打开工作区。')
  if (operation === 'parse-gui') {
    const path = normalizeRelativePath(payload.path, GUI_ROOT)
    const content = typeof payload.content === 'string'
      ? payload.content
      : await context.readFile(joinPath(context.workspaceRoot, path))
    return { ...parseDragonCoreGui(path, content), content }
  }
  if (operation === 'inspect-gui') {
    const files = await listGuiFiles(context)
    if (typeof payload.path !== 'string' || !payload.path.trim()) return { files, fileCount: files.length }
    const path = normalizeRelativePath(payload.path, GUI_ROOT)
    const content = await context.readFile(joinPath(context.workspaceRoot, path))
    const parsed = parseDragonCoreGui(path, content)
    return {
      files,
      fileCount: files.length,
      imports: parsed.imports.map((value) => ({ value, path: resolveImportPath(path, value, files) })),
      inheritance: parsed.components.filter((component) => component.extends).map((component) => ({ component: component.name, source: component.extends })),
      foreach: parsed.components.filter((component) => component.type === 'foreach').map((component) => component.name),
    }
  }
  if (operation === 'patch-gui') {
    const path = normalizeRelativePath(payload.path, GUI_ROOT)
    const target = joinPath(context.workspaceRoot, path)
    const content = await context.readFile(target)
    if (typeof payload.hash !== 'string') throw new Error('DragonCore 补丁缺少内容 hash。')
    const result = patchDragonCoreGui(content, payload.hash, payload.mutations as DragonCorePatchMutation[])
    await context.writeFile(target, result.content)
    return { ...result.parsed, path, content: result.content }
  }
  if (operation === 'create-gui') {
    const path = normalizeRelativePath(payload.path, GUI_ROOT)
    if (!/\.ya?ml$/i.test(path)) throw new Error('DragonCore GUI 文件必须使用 .yml 或 .yaml。')
    const target = joinPath(context.workspaceRoot, path)
    try {
      await context.readFile(target)
      throw new Error('目标 DragonCore GUI 已存在。')
    } catch (error) {
      if (error instanceof Error && error.message === '目标 DragonCore GUI 已存在。') throw error
    }
    const content = createDragonCoreGui(typeof payload.match === 'string' ? payload.match : '')
    await context.writeFile(target, content)
    return { ...parseDragonCoreGui(path, content), content }
  }
  if (operation === 'read-resource') {
    let resourcePath = normalizeRelativePath(payload.path)
    resourcePath = resourcePath.replace(/^DragonCore\//i, '')
    if (!/\.(?:png|gif|jpe?g|webp|mp4|webm)$/i.test(resourcePath)) throw new Error('该 DragonCore 资源类型不能预览。')
    const roots = await clientRoots(context)
    for (const root of roots) {
      const resolvedPath = joinPath(root, resourcePath)
      try {
        return { dataUrl: await context.readMediaAsDataUrl(resolvedPath), resolvedPath }
      } catch {
        // Try the next configured DragonCore root.
      }
    }
    throw new Error(`未在已配置的 DragonCore 客户端资源根找到：${resourcePath}`)
  }
  throw new Error(`不支持的 DragonCore 编辑器操作：${operation}`)
}
