import type {
  PluginCommandContribution,
  PluginDescriptor,
  PluginListResponse,
  PluginShellExecRequest,
  PluginShellExecResult,
  PluginWorkspaceContext,
  Workspace,
} from '@/types'

type PluginModule = {
  default?: (ctx: PluginContext) => unknown
  activate?: (ctx: PluginContext) => unknown
}

type PluginDisposer = () => void
const DEFAULT_HOST_APP_VERSION = '0.1.0'

type LoadedPluginModule = PluginModule | {
  module: PluginModule
  dispose?: PluginDisposer
}

interface RuntimePluginState {
  descriptor: PluginDescriptor
  disposer: PluginDisposer | null
  moduleDisposer: PluginDisposer | null
  styleElement: HTMLStyleElement | null
  commandDisposers: PluginDisposer[]
}

export interface PluginRuntimeOptions {
  listPlugins(workspace?: PluginWorkspaceContext | null): Promise<PluginListResponse>
  readPluginAsset(pluginId: string, relativePath: string, workspace?: PluginWorkspaceContext | null): Promise<string>
  execPluginShell(request: PluginShellExecRequest): Promise<PluginShellExecResult>
  loadModule?: (plugin: PluginDescriptor, readAsset: (relativePath: string) => Promise<string>) => Promise<LoadedPluginModule>
  hostAppVersion?: string
  getUnsafe(): Record<string, unknown>
  getWorkspaceApi(): Record<string, unknown>
  getEditorApi(): Record<string, unknown>
  showToast(message: string): void
  onChanged?: () => void
}

export interface PluginContext {
  app: {
    version: string
    platform: string
    plugin: PluginDescriptor
    reloadPlugin(id?: string): Promise<void>
    disablePlugin(id?: string): Promise<void>
    getLoadedPlugins(): PluginDescriptor[]
  }
  workspace: Record<string, unknown>
  editor: Record<string, unknown>
  ui: {
    registerCommand(command: { id: string; title: string; tooltip?: string; run: () => unknown }): PluginDisposer
    toast(message: string): void
    confirm(message: string): boolean
    prompt(message: string, defaultValue?: string): string | null
  }
  shell: {
    exec(command: string, options?: Omit<PluginShellExecRequest, 'command'>): Promise<PluginShellExecResult>
  }
  storage: {
    get(key: string): unknown
    set(key: string, value: unknown): void
    delete(key: string): void
    listKeys(): string[]
  }
  logger: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>
  unsafe: Record<string, unknown>
}

export function createPluginRuntime(options: PluginRuntimeOptions) {
  return new PluginRuntime(options)
}

export class PluginRuntime {
  private response: PluginListResponse | null = null
  private active = new Map<string, RuntimePluginState>()
  private commands = new Map<string, {
    pluginId: string
    title: string
    tooltip?: string
    run: () => unknown
    state: RuntimePluginState
  }>()
  private storage = new Map<string, Map<string, unknown>>()
  private currentWorkspace: Workspace | null = null
  private disabledPluginIds = new Set<string>()
  private lifecycleRevision = 0

  constructor(private readonly options: PluginRuntimeOptions) {}

  async refresh(workspace: Workspace | null, disabledPluginIds: string[]) {
    const revision = ++this.lifecycleRevision
    this.currentWorkspace = workspace
    const context = workspace ? workspaceContext(workspace) : null
    const response = await this.options.listPlugins(context)
    if (!this.isRevisionCurrent(revision)) {
      return
    }

    this.response = response
    const disabledIds = new Set(disabledPluginIds)
    this.disabledPluginIds = disabledIds

    const matchedIds = new Set(
      this.response.plugins
        .filter((plugin) => plugin.status === 'matched' && !disabledIds.has(plugin.id))
        .map((plugin) => plugin.id),
    )

    for (const id of [...this.active.keys()]) {
      if (!matchedIds.has(id)) {
        this.disposePlugin(id)
      }
    }

    for (const plugin of this.response.plugins) {
      if (plugin.status !== 'matched') continue
      if (disabledIds.has(plugin.id)) continue
      const activeState = this.active.get(plugin.id)
      if (activeState?.descriptor.status !== 'failed' && activeState) continue
      if (activeState?.descriptor.status === 'failed') {
        this.active.delete(plugin.id)
      }
      await this.activatePlugin(plugin, revision)
      if (!this.isRevisionCurrent(revision)) {
        return
      }
    }

    if (this.isRevisionCurrent(revision)) {
      this.options.onChanged?.()
    }
  }

  getEnvironment() {
    return this.response?.environment ?? null
  }

  getStatuses(): PluginDescriptor[] {
    const base = this.response?.plugins ?? []
    return base.map((plugin) => this.active.get(plugin.id)?.descriptor ?? plugin)
  }

  getCommands(): PluginCommandContribution[] {
    return [...this.commands.entries()].map(([id, command]) => ({
      id,
      pluginId: command.pluginId,
      title: command.title,
      tooltip: command.tooltip,
    }))
  }

  async runCommand(id: string) {
    const command = this.commands.get(id)
    if (!command) {
      throw new Error(`Plugin command not found: ${id}`)
    }

    await command.run()
  }

  disposeAll() {
    this.lifecycleRevision += 1
    for (const id of [...this.active.keys()]) {
      this.disposePlugin(id)
    }
  }

  private async activatePlugin(plugin: PluginDescriptor, revision: number) {
    const state: RuntimePluginState = {
      descriptor: { ...plugin, status: 'loaded', error: null },
      disposer: null,
      moduleDisposer: null,
      styleElement: null,
      commandDisposers: [],
    }
    this.active.set(plugin.id, state)

    try {
      if (plugin.style) {
        state.styleElement = await this.injectStyle(plugin)
        if (!this.isActivationCurrent(plugin.id, state, revision)) {
          this.cleanupPluginState(plugin.id, state)
          return
        }
      }

      const moduleLoader = this.options.loadModule ?? defaultLoadModule
      const loadedModule = await moduleLoader(plugin, (relativePath) => this.options.readPluginAsset(plugin.id, relativePath, this.currentWorkspace ? workspaceContext(this.currentWorkspace) : null))
      const { module, dispose } = normalizeLoadedPluginModule(loadedModule)
      state.moduleDisposer = dispose ?? null
      if (!this.isActivationCurrent(plugin.id, state, revision)) {
        this.cleanupPluginState(plugin.id, state)
        return
      }
      const activate = module.default ?? module.activate
      if (typeof activate !== 'function') {
        throw new Error('plugin must export default activate(ctx) or named activate(ctx)')
      }

      const result = await activate(this.createContext(plugin, state, revision))
      if (typeof result === 'function') {
        state.disposer = result as PluginDisposer
      }
      if (!this.isActivationCurrent(plugin.id, state, revision)) {
        this.cleanupPluginState(plugin.id, state)
      }
    } catch (error) {
      if (!this.isActivationCurrent(plugin.id, state, revision)) {
        this.cleanupPluginState(plugin.id, state)
        return
      }
      this.cleanupPluginState(plugin.id, state)
      this.active.set(plugin.id, {
        descriptor: { ...plugin, status: 'failed', error: formatError(error) },
        disposer: null,
        moduleDisposer: null,
        styleElement: null,
        commandDisposers: [],
      })
    }
  }

  private disposePlugin(id: string) {
    const state = this.active.get(id)
    if (!state) return

    this.cleanupPluginState(id, state)
  }

  private async injectStyle(plugin: PluginDescriptor) {
    const style = document.createElement('style')
    style.dataset.superhighPlugin = plugin.id
    style.textContent = await this.options.readPluginAsset(plugin.id, plugin.style!, this.currentWorkspace ? workspaceContext(this.currentWorkspace) : null)
    document.head.appendChild(style)
    return style
  }

  private createContext(plugin: PluginDescriptor, state: RuntimePluginState, revision: number): PluginContext {
    const pluginStorage = this.storage.get(plugin.id) ?? new Map<string, unknown>()
    this.storage.set(plugin.id, pluginStorage)

    return {
      app: {
        version: this.options.hostAppVersion ?? DEFAULT_HOST_APP_VERSION,
        platform: navigator.platform,
        plugin,
        reloadPlugin: async (id) => this.reload(this.resolvePluginTarget(id, plugin.id)),
        disablePlugin: async (id) => this.disable(this.resolvePluginTarget(id, plugin.id)),
        getLoadedPlugins: () => this.getStatuses().filter((item) => item.status === 'loaded'),
      },
      workspace: this.options.getWorkspaceApi(),
      editor: this.options.getEditorApi(),
      ui: {
        registerCommand: (command) => {
          if (!this.isActivationCurrent(plugin.id, state, revision)) {
            return () => undefined
          }
          const id = command.id.includes('.') ? command.id : `${plugin.id}.${command.id}`
          this.commands.set(id, {
            pluginId: plugin.id,
            title: command.title,
            tooltip: command.tooltip,
            run: command.run,
            state,
          })
          const dispose = () => {
            const registered = this.commands.get(id)
            if (registered?.state === state) {
              this.commands.delete(id)
            }
          }
          state.commandDisposers.push(dispose)
          if (this.isActivationCurrent(plugin.id, state, revision)) {
            this.options.onChanged?.()
          }
          return dispose
        },
        toast: this.options.showToast,
        confirm: (message) => window.confirm(message),
        prompt: (message, defaultValue) => window.prompt(message, defaultValue),
      },
      shell: {
        exec: (command, request = {}) => this.options.execPluginShell({
          command,
          cwd: this.currentWorkspace?.rootPath,
          env: {},
          ...request,
        }),
      },
      storage: {
        get: (key) => pluginStorage.get(key),
        set: (key, value) => {
          pluginStorage.set(key, value)
        },
        delete: (key) => {
          pluginStorage.delete(key)
        },
        listKeys: () => [...pluginStorage.keys()],
      },
      logger: console,
      unsafe: this.options.getUnsafe(),
    }
  }

  private async reload(id: string) {
    this.disposePlugin(id)
    const plugin = this.response?.plugins.find((item) => item.id === id)
    if (plugin && plugin.status === 'matched' && !this.disabledPluginIds.has(id)) {
      const revision = this.lifecycleRevision
      await this.activatePlugin(plugin, revision)
    }
    this.options.onChanged?.()
  }

  private async disable(id: string) {
    this.disabledPluginIds.add(id)
    this.disposePlugin(id)
    this.options.onChanged?.()
  }

  private resolvePluginTarget(requestedId: string | undefined, currentPluginId: string) {
    if (!requestedId?.trim()) {
      return currentPluginId
    }
    return requestedId
  }

  private isRevisionCurrent(revision: number) {
    return this.lifecycleRevision === revision
  }

  private isActivationCurrent(id: string, state: RuntimePluginState, revision: number) {
    return this.isRevisionCurrent(revision) && this.active.get(id) === state
  }

  private cleanupPluginState(id: string, state: RuntimePluginState) {
    for (const dispose of state.commandDisposers.splice(0)) {
      dispose()
    }

    const disposer = state.disposer
    state.disposer = null

    const moduleDisposer = state.moduleDisposer
    state.moduleDisposer = null

    try {
      disposer?.()
    } catch (error) {
      console.error(`Failed to dispose plugin ${id}`, error)
    } finally {
      try {
        moduleDisposer?.()
      } finally {
        state.styleElement?.remove()
        if (this.active.get(id) === state) {
          this.active.delete(id)
        }
      }
    }
  }
}

export async function defaultLoadModule(
  plugin: PluginDescriptor,
  readAsset: (relativePath: string) => Promise<string>,
): Promise<LoadedPluginModule> {
  const urls = new Map<string, string>()
  try {
    const url = await buildModuleUrl(plugin.main, readAsset, urls, [])
    const module = await import(/* @vite-ignore */ url) as PluginModule
    return {
      module,
      dispose: () => revokeModuleUrls(urls),
    }
  } catch (error) {
    revokeModuleUrls(urls)
    throw error
  }
}

async function buildModuleUrl(
  relativePath: string,
  readAsset: (relativePath: string) => Promise<string>,
  urls: Map<string, string>,
  stack: string[],
): Promise<string> {
  if (urls.has(relativePath)) {
    return urls.get(relativePath)!
  }

  if (stack.includes(relativePath)) {
    throw new Error(formatCircularImportError(stack, relativePath))
  }

  const source = await readAsset(relativePath)
  const nextStack = [...stack, relativePath]
  const rewritten = await rewriteRelativeImports(source, relativePath, readAsset, urls, nextStack)
  const blob = new Blob([rewritten], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  urls.set(relativePath, url)
  return url
}

async function rewriteRelativeImports(
  source: string,
  fromPath: string,
  readAsset: (relativePath: string) => Promise<string>,
  urls: Map<string, string>,
  stack: string[],
) {
  const replacements: Array<{ start: number; end: number; value: string }> = []
  const specifiers = findRelativeModuleSpecifiers(source)

  for (const specifier of specifiers) {
    const imported = normalizeRelativeImport(fromPath, specifier.value)
    const url = await buildModuleUrl(imported, readAsset, urls, stack)
    replacements.push({
      start: specifier.start,
      end: specifier.end,
      value: url,
    })
  }

  if (replacements.length === 0) {
    return source
  }

  let result = ''
  let cursor = 0
  for (const replacement of replacements) {
    result += source.slice(cursor, replacement.start)
    result += replacement.value
    cursor = replacement.end
  }
  result += source.slice(cursor)
  return result
}

export async function rewriteRelativeImportsForTest(
  source: string,
  fromPath: string,
  readAsset: (relativePath: string) => Promise<string>,
  urls: Map<string, string>,
) {
  return rewriteRelativeImports(source, fromPath, readAsset, urls, [fromPath])
}

function normalizeRelativeImport(fromPath: string, specifier: string) {
  const base = fromPath.split('/').slice(0, -1)
  for (const part of specifier.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (base.length === 0) {
        throw new Error(`Plugin import escapes plugin root: ${fromPath} -> ${specifier}`)
      }
      base.pop()
    } else {
      base.push(part)
    }
  }
  return base.join('/')
}

function workspaceContext(workspace: Workspace): PluginWorkspaceContext {
  return {
    name: workspace.name,
    displayName: workspace.displayName,
    rootPath: workspace.rootPath,
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatCircularImportError(stack: string[], repeatedPath: string) {
  const cycleStart = stack.indexOf(repeatedPath)
  const cycle = [...stack.slice(cycleStart), repeatedPath]
  return `Circular plugin import detected: ${cycle.join(' -> ')}`
}

function normalizeLoadedPluginModule(loadedModule: LoadedPluginModule) {
  if ('module' in loadedModule) {
    return loadedModule
  }
  return { module: loadedModule }
}

function revokeModuleUrls(urls: Map<string, string>) {
  for (const url of urls.values()) {
    URL.revokeObjectURL(url)
  }
  urls.clear()
}

type ModuleSpecifierMatch = {
  start: number
  end: number
  value: string
}

function findRelativeModuleSpecifiers(source: string) {
  const matches: ModuleSpecifierMatch[] = []
  let index = 0
  let state: ScannerState = 'code'
  let resumeState: ScannerResumeState = 'code'
  const templateStack: number[] = []

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (state === 'lineComment') {
      if (char === '\n' || char === '\r') {
        state = resumeState
      }
      index++
      continue
    }

    if (state === 'blockComment') {
      if (char === '*' && next === '/') {
        state = resumeState
        index += 2
        continue
      }
      index++
      continue
    }

    if (state === 'singleQuote') {
      index = advanceQuotedString(source, index, '\'')
      state = resumeState
      continue
    }

    if (state === 'doubleQuote') {
      index = advanceQuotedString(source, index, '"')
      state = resumeState
      continue
    }

    if (state === 'template') {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '`') {
        templateStack.pop()
        state = templateStack.length === 0 ? 'code' : 'templateExpression'
        index++
        continue
      }
      if (char === '$' && next === '{') {
        templateStack[templateStack.length - 1] = 1
        state = 'templateExpression'
        index += 2
        continue
      }
      index++
      continue
    }

    if (state === 'templateExpression') {
      if (char === '\'' || char === '"' || char === '`') {
        if (char === '\'') {
          resumeState = 'templateExpression'
          state = 'singleQuote'
        } else if (char === '"') {
          resumeState = 'templateExpression'
          state = 'doubleQuote'
        } else {
          templateStack.push(0)
          state = 'template'
        }
        index++
        continue
      }
      if (char === '/' && next === '/') {
        resumeState = 'templateExpression'
        state = 'lineComment'
        index += 2
        continue
      }
      if (char === '/' && next === '*') {
        resumeState = 'templateExpression'
        state = 'blockComment'
        index += 2
        continue
      }
      if (char === '{') {
        templateStack[templateStack.length - 1]++
        index++
        continue
      }
      if (char === '}') {
        const depth = templateStack[templateStack.length - 1] - 1
        templateStack[templateStack.length - 1] = depth
        state = depth === 0 ? 'template' : 'templateExpression'
        index++
        continue
      }
    }

    if (char === '/' && next === '/') {
      resumeState = 'code'
      state = 'lineComment'
      index += 2
      continue
    }

    if (char === '/' && next === '*') {
      resumeState = 'code'
      state = 'blockComment'
      index += 2
      continue
    }

    if (char === '\'') {
      resumeState = 'code'
      state = 'singleQuote'
      index++
      continue
    }

    if (char === '"') {
      resumeState = 'code'
      state = 'doubleQuote'
      index++
      continue
    }

    if (char === '`') {
      templateStack.push(0)
      state = 'template'
      index++
      continue
    }

    if (isIdentifierStart(char)) {
      const tokenStart = index
      index++
      while (index < source.length && isIdentifierPart(source[index])) {
        index++
      }
      const token = source.slice(tokenStart, index)
      if (!isModuleKeywordBoundary(source, tokenStart, index)) {
        continue
      }
      if (token === 'import') {
        const match = readImportSpecifier(source, index)
        if (match) {
          matches.push(match.specifier)
          index = match.nextIndex
        }
      } else if (token === 'export') {
        const match = readExportSpecifier(source, index)
        if (match) {
          matches.push(match.specifier)
          index = match.nextIndex
        }
      }
      continue
    }

    index++
  }

  return matches.filter((match) => isRelativeSpecifier(match.value))
}

type ScannerState =
  | 'code'
  | 'singleQuote'
  | 'doubleQuote'
  | 'template'
  | 'templateExpression'
  | 'lineComment'
  | 'blockComment'

type ScannerResumeState = 'code' | 'templateExpression'

type ScannerMatch = {
  specifier: ModuleSpecifierMatch
  nextIndex: number
}

function readImportSpecifier(source: string, startIndex: number) {
  const index = skipTrivia(source, startIndex)
  if (index >= source.length) {
    return null
  }

  if (source[index] === '(') {
    return readDynamicImportSpecifier(source, index + 1)
  }

  if (source[index] === '\'' || source[index] === '"') {
    return readStringLiteralSpecifier(source, index)
  }

  return readFromClauseSpecifier(source, index)
}

function readExportSpecifier(source: string, startIndex: number) {
  return readFromClauseSpecifier(source, startIndex)
}

function readDynamicImportSpecifier(source: string, startIndex: number) {
  const index = skipTrivia(source, startIndex)
  if (index >= source.length) {
    return null
  }

  if (source[index] === '`') {
    return readStaticTemplateLiteralSpecifier(source, index)
  }

  if (source[index] !== '\'' && source[index] !== '"') {
    return null
  }

  return readStringLiteralSpecifier(source, index)
}

function readFromClauseSpecifier(source: string, startIndex: number) {
  let index = startIndex
  let depth = 0
  let state: Exclude<ScannerState, 'templateExpression'> = 'code'
  const templateStack: number[] = []

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (state === 'lineComment') {
      if (char === '\n' || char === '\r') {
        state = 'code'
      }
      index++
      continue
    }

    if (state === 'blockComment') {
      if (char === '*' && next === '/') {
        state = 'code'
        index += 2
        continue
      }
      index++
      continue
    }

    if (state === 'singleQuote') {
      index = advanceQuotedString(source, index, '\'')
      state = 'code'
      continue
    }

    if (state === 'doubleQuote') {
      index = advanceQuotedString(source, index, '"')
      state = 'code'
      continue
    }

    if (state === 'template') {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '`') {
        const templateDepth = templateStack.pop()
        if (templateDepth === 0) {
          state = 'code'
        }
        index++
        continue
      }
      if (char === '$' && next === '{') {
        templateStack[templateStack.length - 1] = 1
        depth++
        index += 2
        continue
      }
      index++
      continue
    }

    if (char === '/' && next === '/') {
      state = 'lineComment'
      index += 2
      continue
    }

    if (char === '/' && next === '*') {
      state = 'blockComment'
      index += 2
      continue
    }

    if (char === '\'') {
      state = 'singleQuote'
      index++
      continue
    }

    if (char === '"') {
      state = 'doubleQuote'
      index++
      continue
    }

    if (char === '`') {
      templateStack.push(0)
      state = 'template'
      index++
      continue
    }

    if (char === '{' || char === '(' || char === '[') {
      depth++
      index++
      continue
    }

    if (char === '}' || char === ')' || char === ']') {
      if (depth > 0) {
        depth--
      }
      index++
      continue
    }

    if (depth === 0 && isIdentifierStart(char)) {
      const tokenStart = index
      index++
      while (index < source.length && isIdentifierPart(source[index])) {
        index++
      }
      if (source.slice(tokenStart, index) === 'from' && isKeywordBoundary(source, tokenStart, index)) {
        return readStringLiteralSpecifier(source, skipTrivia(source, index))
      }
      continue
    }

    index++
  }

  return null
}

function readStringLiteralSpecifier(source: string, quoteIndex: number): ScannerMatch | null {
  const quote = source[quoteIndex]
  if (quote !== '\'' && quote !== '"') {
    return null
  }

  let index = quoteIndex + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) {
      return {
        specifier: {
          start: quoteIndex + 1,
          end: index,
          value: source.slice(quoteIndex + 1, index),
        },
        nextIndex: index + 1,
      }
    }
    index++
  }

  return null
}

function readStaticTemplateLiteralSpecifier(source: string, quoteIndex: number): ScannerMatch | null {
  let index = quoteIndex + 1
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '$' && next === '{') {
      return null
    }
    if (char === '`') {
      return {
        specifier: {
          start: quoteIndex + 1,
          end: index,
          value: source.slice(quoteIndex + 1, index),
        },
        nextIndex: index + 1,
      }
    }
    index++
  }

  return null
}

function skipTrivia(source: string, startIndex: number) {
  let index = startIndex
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (/\s/.test(char)) {
      index++
      continue
    }
    if (char === '/' && next === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        index++
      }
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          index += 2
          break
        }
        index++
      }
      continue
    }
    break
  }
  return index
}

function advanceQuotedString(source: string, startIndex: number, quote: '\'' | '"') {
  let index = startIndex + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) {
      return index + 1
    }
    index++
  }
  return index
}

function isKeywordBoundary(source: string, start: number, end: number) {
  const previous = start > 0 ? source[start - 1] : ''
  const next = end < source.length ? source[end] : ''
  return !isIdentifierPart(previous) && !isIdentifierPart(next)
}

function isModuleKeywordBoundary(source: string, start: number, end: number) {
  if (!isKeywordBoundary(source, start, end)) {
    return false
  }

  const previousIndex = findPreviousSignificantIndex(source, start - 1)
  if (previousIndex >= 0 && source[previousIndex] === '.') {
    return false
  }

  return true
}

function findPreviousSignificantIndex(source: string, startIndex: number) {
  let index = startIndex
  while (index >= 0) {
    const char = source[index]
    const previous = source[index - 1]

    if (/\s/.test(char)) {
      index--
      continue
    }

    let lineStart = index
    while (lineStart >= 0 && source[lineStart] !== '\n' && source[lineStart] !== '\r') {
      lineStart--
    }
    lineStart++

    const lineCommentIndex = source.lastIndexOf('//', index)
    if (lineCommentIndex >= lineStart) {
      index = lineCommentIndex - 1
      continue
    }

    if (char === '/' && previous === '*') {
      index -= 2
      while (index >= 0) {
        if (source[index] === '/' && source[index + 1] === '*') {
          index--
          break
        }
        index--
      }
      continue
    }

    return index
  }

  return -1
}

function isIdentifierStart(char: string) {
  return /[A-Za-z_$]/.test(char)
}

function isIdentifierPart(char: string) {
  return /[A-Za-z0-9_$]/.test(char)
}

function isRelativeSpecifier(specifier: string) {
  return specifier.startsWith('./') || specifier.startsWith('../')
}
