import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PluginListResponse, Workspace } from '@/types'

import { createPluginRuntime } from './pluginRuntime'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function workspace(): Workspace {
  return {
    id: 'workspace-1',
    name: '示例工作区',
    displayName: '示例工作区',
    rootPath: 'D:/Project',
    openedAt: '2026-07-05T00:00:00Z',
  }
}

function response(): PluginListResponse {
  return {
    environment: {
      pluginRoot: 'C:/Users/Admin/AppData/Roaming/SuperHigh/plugins',
      disableFlagPath: 'C:/Users/Admin/AppData/Roaming/SuperHigh/disable-plugins.flag',
      logPath: 'C:/Users/Admin/AppData/Roaming/SuperHigh/logs/plugins.log',
      allDisabled: false,
      disabledReason: null,
    },
    plugins: [{
      id: 'sample-tools',
      name: '示例工具',
      version: '0.1.0',
      rootPath: 'C:/plugins/sample-tools',
      main: 'main.js',
      mainPath: 'C:/plugins/sample-tools/main.js',
      style: 'style.css',
      stylePath: 'C:/plugins/sample-tools/style.css',
      source: 'global',
      permissions: ['all'],
      unsafe: true,
      status: 'matched',
      matchReason: 'activation matched current workspace',
      disabledReason: null,
      error: null,
    }],
  }
}

describe('pluginRuntime', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  it('activates matched plugins and disposes them on workspace mismatch', async () => {
    const dispose = vi.fn()
    const activate = vi.fn(() => dispose)
    const listPlugins = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce({ ...response(), plugins: [{ ...response().plugins[0], status: 'notMatched' }] })
    const runtime = createPluginRuntime({
      listPlugins,
      readPluginAsset: vi.fn(async (_id, path) => path === 'style.css' ? '.sample { color: red }' : ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async () => ({ default: activate })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    await runtime.refresh(workspace(), [])
    expect(activate).toHaveBeenCalledOnce()
    expect(runtime.getStatuses()[0].status).toBe('loaded')
    expect(document.head.querySelector('style[data-superhigh-plugin="sample-tools"]')?.textContent).toContain('color: red')

    await runtime.refresh(null, [])
    expect(dispose).toHaveBeenCalledOnce()
    expect(document.head.querySelector('style[data-superhigh-plugin="sample-tools"]')).toBeNull()
  })

  it('registers commands and runs them through the runtime', async () => {
    const run = vi.fn()
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => response()),
      readPluginAsset: vi.fn(async () => ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async () => ({
        default: (ctx: any) => ctx.ui.registerCommand({ id: 'sample.hello', title: 'Hello', run }),
      })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    await runtime.refresh(workspace(), [])
    expect(runtime.getCommands()).toEqual([{ id: 'sample.hello', pluginId: 'sample-tools', title: 'Hello', tooltip: undefined }])
    await runtime.runCommand('sample.hello')
    expect(run).toHaveBeenCalledOnce()
  })

  it('marks plugin failed when activate throws and keeps other plugins loadable', async () => {
    const broken = response()
    const ok = { ...broken.plugins[0], id: 'second-tool', name: 'Second', main: 'second.js', mainPath: 'C:/plugins/second/main.js' }
    broken.plugins.push(ok)
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => broken),
      readPluginAsset: vi.fn(async () => ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async (plugin) => plugin.id === 'sample-tools'
        ? { default: () => { throw new Error('boom') } }
        : { default: () => undefined }),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    await runtime.refresh(workspace(), [])
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).toBe('failed')
    expect(runtime.getStatuses().find((item) => item.id === 'second-tool')?.status).toBe('loaded')
  })

  it('retries a previously failed matched plugin on a later refresh', async () => {
    const activate = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('boom')
      })
      .mockImplementationOnce(() => undefined)
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => response()),
      readPluginAsset: vi.fn(async () => ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async () => ({ default: activate })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    await runtime.refresh(workspace(), [])
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).toBe('failed')

    await runtime.refresh(workspace(), [])
    expect(activate).toHaveBeenCalledTimes(2)
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).toBe('loaded')
  })

  it('does not activate disabled matched plugins and disposes active plugins when they become disabled', async () => {
    const dispose = vi.fn()
    const activate = vi.fn(() => dispose)
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => response()),
      readPluginAsset: vi.fn(async (_id, path) => path === 'style.css' ? '.sample { color: red }' : ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async () => ({ default: activate })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    await runtime.refresh(workspace(), ['sample-tools'])
    expect(activate).not.toHaveBeenCalled()
    expect(runtime.getStatuses()[0].status).toBe('matched')
    expect(document.head.querySelector('style[data-superhigh-plugin="sample-tools"]')).toBeNull()

    await runtime.refresh(workspace(), [])
    expect(activate).toHaveBeenCalledOnce()

    await runtime.refresh(workspace(), ['sample-tools'])
    expect(dispose).toHaveBeenCalledOnce()
    expect(runtime.getCommands()).toEqual([])
    expect(document.head.querySelector('style[data-superhigh-plugin="sample-tools"]')).toBeNull()
  })

  it('invalidates in-flight refreshes when disposeAll runs before listPlugins resolves', async () => {
    const listPluginsResult = deferred<PluginListResponse>()
    const activate = vi.fn(() => undefined)
    const onChanged = vi.fn()
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(() => listPluginsResult.promise),
      readPluginAsset: vi.fn(async () => ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async () => ({ default: activate })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
      onChanged,
    })

    const refreshPromise = runtime.refresh(workspace(), [])
    runtime.disposeAll()
    listPluginsResult.resolve(response())
    await refreshPromise

    expect(activate).not.toHaveBeenCalled()
    expect(runtime.getCommands()).toEqual([])
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).not.toBe('loaded')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('cleans up late activation work when disposeAll happens during activate', async () => {
    const activationStarted = deferred<void>()
    const releaseActivation = deferred<void>()
    const lateDispose = vi.fn()
    const onChanged = vi.fn()
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => response()),
      readPluginAsset: vi.fn(async (_pluginId, relativePath) => relativePath === 'style.css' ? '.late { color: red }' : ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async () => ({
        default: async (ctx: any) => {
          activationStarted.resolve()
          await releaseActivation.promise
          ctx.ui.registerCommand({ id: 'late-command', title: 'Late command', run: vi.fn() })
          return lateDispose
        },
      })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
      onChanged,
    })

    const refreshPromise = runtime.refresh(workspace(), [])
    await activationStarted.promise
    runtime.disposeAll()
    releaseActivation.resolve()
    await refreshPromise

    expect(lateDispose).toHaveBeenCalledOnce()
    expect(runtime.getCommands()).toEqual([])
    expect(document.head.querySelector('style[data-superhigh-plugin="sample-tools"]')).toBeNull()
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).not.toBe('loaded')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('calls the module disposer only once when stale activation cleanup resumes after disposeAll', async () => {
    const activationStarted = deferred<void>()
    const releaseActivation = deferred<void>()
    const moduleDisposer = vi.fn()
    const lateDispose = vi.fn()
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => response()),
      readPluginAsset: vi.fn(async (_pluginId, relativePath) => relativePath === 'style.css' ? '.late { color: red }' : ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async () => {
        return {
          module: {
            default: async () => {
              activationStarted.resolve()
              await releaseActivation.promise
              return lateDispose
            },
          },
          dispose: moduleDisposer,
        }
      }),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    const refreshPromise = runtime.refresh(workspace(), [])
    await activationStarted.promise
    runtime.disposeAll()
    releaseActivation.resolve()
    await refreshPromise

    expect(moduleDisposer).toHaveBeenCalledTimes(1)
    expect(lateDispose).toHaveBeenCalledTimes(1)
  })

  it('keeps newer commands when stale activation cleanup finishes for the same plugin id', async () => {
    const firstActivationStarted = deferred<void>()
    const releaseFirstActivation = deferred<void>()
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    let activationCount = 0
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => response()),
      readPluginAsset: vi.fn(async (_pluginId, relativePath) => relativePath === 'style.css' ? '.race { color: blue }' : ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async () => ({
        default: async (ctx: any) => {
          activationCount += 1
          if (activationCount === 1) {
            firstActivationStarted.resolve()
            await releaseFirstActivation.promise
            ctx.ui.registerCommand({ id: 'old-command', title: 'Old command', run: vi.fn() })
            return firstDispose
          }
          ctx.ui.registerCommand({ id: 'new-command', title: 'New command', run: vi.fn() })
          return secondDispose
        },
      })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    const firstRefresh = runtime.refresh(workspace(), [])
    await firstActivationStarted.promise
    runtime.disposeAll()
    await runtime.refresh(workspace(), [])

    expect(runtime.getCommands()).toEqual([{
      id: 'sample-tools.new-command',
      pluginId: 'sample-tools',
      title: 'New command',
      tooltip: undefined,
    }])

    releaseFirstActivation.resolve()
    await firstRefresh

    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).not.toHaveBeenCalled()
    expect(runtime.getCommands()).toEqual([{
      id: 'sample-tools.new-command',
      pluginId: 'sample-tools',
      title: 'New command',
      tooltip: undefined,
    }])
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).toBe('loaded')
  })

  it('rewrites side-effect local js imports for blob module loading', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:url-1')
      .mockReturnValueOnce('blob:url-2')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const rewritten = await runtimeModule.rewriteRelativeImportsForTest(
      "import './setup.js'\nimport helper from './helper.js'\nexport default helper",
      'main.js',
      async (relativePath: string) => {
        if (relativePath === 'setup.js') {
          return 'window.__setupLoaded = true'
        }
        if (relativePath === 'helper.js') {
          return 'export default 1'
        }
        throw new Error(`unexpected asset: ${relativePath}`)
      },
      new Map(),
    )

    expect(rewritten).toMatch(/import 'blob:url-\d+'/)
    expect(rewritten).toMatch(/from 'blob:url-\d+'/)
    expect(rewritten).not.toContain("./setup.js")
    expect(rewritten).not.toContain("./helper.js")
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('rewrites local sibling module specifiers across import and export forms', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:url-1')
      .mockReturnValueOnce('blob:url-2')
      .mockReturnValueOnce('blob:url-3')
      .mockReturnValueOnce('blob:url-4')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const rewritten = await runtimeModule.rewriteRelativeImportsForTest(
      [
        "import helper from './helper.js'",
        "import './setup.js'",
        "export * from './exports.js'",
        "export { foo } from './exports.js'",
        "const dynamicModule = await import('./dynamic.js')",
        'export default [helper, dynamicModule]',
      ].join('\n'),
      'main.js',
      async (relativePath: string) => {
        if (relativePath === 'helper.js') {
          return 'export default 1'
        }
        if (relativePath === 'setup.js') {
          return 'window.__setupLoaded = true'
        }
        if (relativePath === 'exports.js') {
          return 'export const foo = 1'
        }
        if (relativePath === 'dynamic.js') {
          return 'export default 2'
        }
        throw new Error(`unexpected asset: ${relativePath}`)
      },
      new Map(),
    )

    expect(rewritten).toContain("from 'blob:url-1'")
    expect(rewritten).toMatch(/import 'blob:url-\d+'/)
    expect(rewritten).toMatch(/export \* from 'blob:url-\d+'/)
    expect(rewritten).toMatch(/export \{ foo \} from 'blob:url-\d+'/)
    expect(rewritten).toContain("import('blob:url-4')")
    expect(rewritten).not.toContain("./helper.js")
    expect(rewritten).not.toContain("./setup.js")
    expect(rewritten).not.toContain("./exports.js")
    expect(rewritten).not.toContain("./dynamic.js")
    expect(createObjectURL).toHaveBeenCalledTimes(4)
  })

  it('ignores import-like text inside strings comments and template literals', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:url-1')
      .mockReturnValueOnce('blob:url-2')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const readAsset = vi.fn(async (relativePath: string) => {
      if (relativePath === 'helper.js') {
        return 'export default 1'
      }
      if (relativePath === 'dynamic.js') {
        return 'export default 2'
      }
      throw new Error(`unexpected asset: ${relativePath}`)
    })

    const ordinaryString = "const text = \"import './fake-string.js' and export { fake } from './fake-export.js'\""
    const lineComment = "// import './fake-comment.js'"
    const blockComment = "/* export * from './fake-block.js' */"
    const templateLiteral = "const template = `await import('./fake-template.js')`"
    const rewritten = await runtimeModule.rewriteRelativeImportsForTest(
      [
        ordinaryString,
        lineComment,
        blockComment,
        templateLiteral,
        "import helper from './helper.js'",
        "const dynamicModule = await import('./dynamic.js')",
        'export default [text, template, helper, dynamicModule]',
      ].join('\n'),
      'main.js',
      readAsset,
      new Map(),
    )

    expect(rewritten).toContain("import './fake-string.js'")
    expect(rewritten).toContain("from './fake-export.js'")
    expect(rewritten).toContain("import './fake-comment.js'")
    expect(rewritten).toContain("from './fake-block.js'")
    expect(rewritten).toContain("import('./fake-template.js')")
    expect(rewritten).toContain("from 'blob:url-1'")
    expect(rewritten).toContain("import('blob:url-2')")
    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(readAsset).toHaveBeenNthCalledWith(1, 'helper.js')
    expect(readAsset).toHaveBeenNthCalledWith(2, 'dynamic.js')
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('ignores import-like text inside regex literals', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn().mockReturnValueOnce('blob:url-1')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const readAsset = vi.fn(async (relativePath: string) => {
      if (relativePath === 'helper.js') {
        return 'export default 1'
      }
      throw new Error(`unexpected asset: ${relativePath}`)
    })

    const rewritten = await runtimeModule.rewriteRelativeImportsForTest(
      [
        "const matcher = /import\\('\\.\\/fake-regex\\.js'\\)|export \\* from '\\.\\/fake-regex\\.js'/",
        "import helper from './helper.js'",
        'export default [matcher, helper]',
      ].join('\n'),
      'main.js',
      readAsset,
      new Map(),
    )

    expect(rewritten).toContain("const matcher = /import\\('\\.\\/fake-regex\\.js'\\)|export \\* from '\\.\\/fake-regex\\.js'/")
    expect(rewritten).toContain("from 'blob:url-1'")
    expect(rewritten).not.toContain("./helper.js")
    expect(readAsset).toHaveBeenCalledTimes(1)
    expect(readAsset).toHaveBeenCalledWith('helper.js')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('continues runtime-owned cleanup when plugin disposer throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => response()),
      readPluginAsset: vi.fn(async (_id, path) => path === 'style.css' ? '.sample { color: red }' : ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async () => ({
        default: (ctx: any) => {
          ctx.ui.registerCommand({ id: 'sample.hello', title: 'Hello', run: vi.fn() })
          return () => {
            throw new Error('dispose failed')
          }
        },
      })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    await runtime.refresh(workspace(), [])
    expect(runtime.getCommands()).toHaveLength(1)

    expect(() => runtime.disposeAll()).not.toThrow()
    expect(runtime.getCommands()).toEqual([])
    expect(document.head.querySelector('style[data-superhigh-plugin="sample-tools"]')).toBeNull()
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).toBe('matched')
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('uses the host app version and targets requested plugin ids for reload and disable', async () => {
    const descriptors = response()
    descriptors.plugins[0] = { ...descriptors.plugins[0], version: '1.2.3' }
    descriptors.plugins.push({
      ...descriptors.plugins[0],
      id: 'second-tool',
      name: 'Second',
      version: '4.5.6',
      main: 'second.js',
      mainPath: 'C:/plugins/second/main.js',
      style: null,
      stylePath: null,
    })

    const disposers = new Map<string, ReturnType<typeof vi.fn>>()
    const appContexts = new Map<string, any>()
    const activations = new Map<string, number>()
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => descriptors),
      readPluginAsset: vi.fn(async (_id, path) => path === 'style.css' ? '.sample { color: red }' : ''),
      execPluginShell: vi.fn(),
      hostAppVersion: '9.9.9',
      loadModule: vi.fn(async (plugin) => ({
        default: (ctx: any) => {
          appContexts.set(plugin.id, ctx.app)
          activations.set(plugin.id, (activations.get(plugin.id) ?? 0) + 1)
          const dispose = vi.fn()
          disposers.set(plugin.id, dispose)
          return dispose
        },
      })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    await runtime.refresh(workspace(), [])

    const firstApp = appContexts.get('sample-tools')
    expect(firstApp.version).toBe('9.9.9')
    expect(firstApp.version).not.toBe(descriptors.plugins[0].version)

    await firstApp.disablePlugin('second-tool')
    const firstSecondDisposer = disposers.get('second-tool')
    expect(firstSecondDisposer).toHaveBeenCalledOnce()
    expect(disposers.get('sample-tools')).not.toHaveBeenCalled()
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).toBe('loaded')
    expect(runtime.getStatuses().find((item) => item.id === 'second-tool')?.status).toBe('matched')

    await firstApp.reloadPlugin('second-tool')
    expect(activations.get('second-tool')).toBe(1)
    expect(runtime.getStatuses().find((item) => item.id === 'second-tool')?.status).toBe('matched')

    await runtime.refresh(workspace(), [])
    expect(activations.get('second-tool')).toBe(2)

    const secondApp = appContexts.get('second-tool')
    const reloadedSecondDisposer = disposers.get('second-tool')
    await secondApp.disablePlugin()
    expect(firstSecondDisposer).toHaveBeenCalledOnce()
    expect(reloadedSecondDisposer).toHaveBeenCalledOnce()
    expect(runtime.getStatuses().find((item) => item.id === 'second-tool')?.status).toBe('matched')

    await secondApp.reloadPlugin('')
    expect(activations.get('second-tool')).toBe(2)
    expect(runtime.getStatuses().find((item) => item.id === 'second-tool')?.status).toBe('matched')

    await runtime.refresh(workspace(), [])
    expect(activations.get('second-tool')).toBe(3)
  })

  it('does not reload disabled plugins and notifies immediately after disablePlugin disposes them', async () => {
    const descriptors = response()
    descriptors.plugins.push({
      ...descriptors.plugins[0],
      id: 'second-tool',
      name: 'Second',
      main: 'second.js',
      mainPath: 'C:/plugins/second/main.js',
      style: null,
      stylePath: null,
    })

    const disposers = new Map<string, ReturnType<typeof vi.fn>>()
    const appContexts = new Map<string, any>()
    const activations = new Map<string, number>()
    const onChanged = vi.fn()
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => descriptors),
      readPluginAsset: vi.fn(async (_id, path) => path === 'style.css' ? '.sample { color: red }' : ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async (plugin) => ({
        default: (ctx: any) => {
          appContexts.set(plugin.id, ctx.app)
          activations.set(plugin.id, (activations.get(plugin.id) ?? 0) + 1)
          const dispose = vi.fn()
          disposers.set(plugin.id, dispose)
          return dispose
        },
      })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
      onChanged,
    })

    await runtime.refresh(workspace(), [])
    expect(activations.get('sample-tools')).toBe(1)
    expect(activations.get('second-tool')).toBe(1)
    expect(onChanged).toHaveBeenCalledTimes(1)

    await runtime.refresh(workspace(), ['second-tool'])
    expect(disposers.get('second-tool')).toHaveBeenCalledOnce()
    expect(runtime.getStatuses().find((item) => item.id === 'second-tool')?.status).toBe('matched')
    expect(onChanged).toHaveBeenCalledTimes(2)

    const firstApp = appContexts.get('sample-tools')
    await firstApp.reloadPlugin('second-tool')
    expect(activations.get('second-tool')).toBe(1)
    expect(runtime.getStatuses().find((item) => item.id === 'second-tool')?.status).toBe('matched')
    expect(onChanged).toHaveBeenCalledTimes(3)

    await firstApp.disablePlugin('sample-tools')
    expect(disposers.get('sample-tools')).toHaveBeenCalledOnce()
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).toBe('matched')
    expect(onChanged).toHaveBeenCalledTimes(4)
  })

  it('keeps same-session disabled plugins gated from reload until refresh clears the disabled list', async () => {
    const descriptors = response()
    const activations = new Map<string, number>()
    const appContexts = new Map<string, any>()
    const disposers = new Map<string, ReturnType<typeof vi.fn>>()
    const onChanged = vi.fn()
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => descriptors),
      readPluginAsset: vi.fn(async (_id, path) => path === 'style.css' ? '.sample { color: red }' : ''),
      execPluginShell: vi.fn(),
      loadModule: vi.fn(async (plugin) => ({
        default: (ctx: any) => {
          appContexts.set(plugin.id, ctx.app)
          activations.set(plugin.id, (activations.get(plugin.id) ?? 0) + 1)
          const dispose = vi.fn()
          disposers.set(plugin.id, dispose)
          return dispose
        },
      })),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
      onChanged,
    })

    await runtime.refresh(workspace(), [])
    expect(activations.get('sample-tools')).toBe(1)

    const app = appContexts.get('sample-tools')
    await app.disablePlugin('sample-tools')
    expect(disposers.get('sample-tools')).toHaveBeenCalledOnce()
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).toBe('matched')
    expect(onChanged).toHaveBeenCalledTimes(2)

    await app.reloadPlugin('sample-tools')
    expect(activations.get('sample-tools')).toBe(1)
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).toBe('matched')
    expect(onChanged).toHaveBeenCalledTimes(3)

    await runtime.refresh(workspace(), [])
    expect(activations.get('sample-tools')).toBe(2)
    expect(runtime.getStatuses().find((item) => item.id === 'sample-tools')?.status).toBe('loaded')
    expect(onChanged).toHaveBeenCalledTimes(4)
  })

  it('detects circular local imports without recursing indefinitely', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn(() => 'blob:cycle-test')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const reads: string[] = []
    await expect(runtimeModule.rewriteRelativeImportsForTest(
      "import './a.js'\nexport default 1",
      'main.js',
      async (relativePath: string) => {
        reads.push(relativePath)
        if (reads.length > 6) {
          throw new Error(`too many reads: ${reads.join(' -> ')}`)
        }
        if (relativePath === 'a.js') {
          return "import './b.js'\nexport const a = 'a'"
        }
        if (relativePath === 'b.js') {
          return "import './a.js'\nexport const b = 'b'"
        }
        throw new Error(`unexpected asset: ${relativePath}`)
      },
      new Map(),
    )).rejects.toThrow(/Circular plugin import detected/)

    expect(reads).toEqual(['a.js', 'b.js'])
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('marks the plugin failed when the default loader hits a circular local import', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:cycle-test'),
      configurable: true,
      writable: true,
    })

    const descriptors = response()
    descriptors.plugins[0] = {
      ...descriptors.plugins[0],
      style: null,
      stylePath: null,
    }

    const reads: string[] = []
    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => descriptors),
      readPluginAsset: vi.fn(async (_pluginId, relativePath) => {
        reads.push(relativePath)
        if (reads.length > 6) {
          throw new Error(`too many reads: ${reads.join(' -> ')}`)
        }
        if (relativePath === 'main.js') {
          return "import './a.js'\nexport default () => undefined"
        }
        if (relativePath === 'a.js') {
          return "import './b.js'\nexport const a = 'a'"
        }
        if (relativePath === 'b.js') {
          return "import './a.js'\nexport const b = 'b'"
        }
        throw new Error(`unexpected asset: ${relativePath}`)
      }),
      execPluginShell: vi.fn(),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    await runtime.refresh(workspace(), [])

    const status = runtime.getStatuses().find((item) => item.id === 'sample-tools')
    expect(status?.status).toBe('failed')
    expect(status?.error).toContain('Circular plugin import detected')
    expect(reads).toEqual(['main.js', 'a.js', 'b.js'])
  })

  it('rejects local imports that escape the plugin root during rewrite', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>

    await expect(runtimeModule.rewriteRelativeImportsForTest(
      "import '../x.js'\nexport default 1",
      'main.js',
      async (_relativePath: string) => {
        throw new Error('should not read escaped import')
      },
      new Map(),
    )).rejects.toThrow(/Plugin import escapes plugin root: main\.js -> \.\.\/x\.js/)
  })

  it('allows valid parent-directory local imports within the plugin root', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn().mockReturnValueOnce('blob:url-1')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const rewritten = await runtimeModule.rewriteRelativeImportsForTest(
      "import '../helper.js'\nexport default helper",
      'nested/main.js',
      async (relativePath: string) => {
        if (relativePath === 'helper.js') {
          return 'export default 1'
        }
        throw new Error(`unexpected asset: ${relativePath}`)
      },
      new Map(),
    )

    expect(rewritten).toContain("import 'blob:url-1'")
    expect(rewritten).not.toContain("../helper.js")
    expect(createObjectURL).toHaveBeenCalledOnce()
  })

  it('revokes default loader module urls when a plugin is disposed or fails activation', async () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn()
      .mockReturnValueOnce("data:text/javascript,export%20default%201")
      .mockReturnValueOnce("data:text/javascript,export%20default%20()%20%3D%3E%20undefined%0A%2F%2F%20activation-1")
      .mockReturnValueOnce("data:text/javascript,export%20default%202")
      .mockReturnValueOnce("data:text/javascript,export%20default%20()%20%3D%3E%20%7B%20throw%20new%20Error('boom')%20%7D%0A%2F%2F%20activation-2")
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    })

    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => response()),
      readPluginAsset: vi.fn(async (_pluginId, relativePath) => {
        if (relativePath === 'main.js') {
          return "import './helper.js'\nexport default () => undefined"
        }
        if (relativePath === 'helper.js') {
          return 'export default 1'
        }
        if (relativePath === 'style.css') {
          return ''
        }
        throw new Error(`unexpected asset: ${relativePath}`)
      }),
      execPluginShell: vi.fn(),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    try {
      await runtime.refresh(workspace(), [])
      expect(createObjectURL).toHaveBeenCalledTimes(2)

      runtime.disposeAll()
      expect(revokeObjectURL).toHaveBeenNthCalledWith(1, 'data:text/javascript,export%20default%201')
      expect(revokeObjectURL).toHaveBeenNthCalledWith(2, "data:text/javascript,export%20default%20()%20%3D%3E%20undefined%0A%2F%2F%20activation-1")

      await runtime.refresh(workspace(), [])
      const status = runtime.getStatuses().find((item) => item.id === 'sample-tools')
      expect(status?.status).toBe('failed')
      expect(revokeObjectURL).toHaveBeenNthCalledWith(3, 'data:text/javascript,export%20default%202')
      expect(revokeObjectURL).toHaveBeenNthCalledWith(4, "data:text/javascript,export%20default%20()%20%3D%3E%20%7B%20throw%20new%20Error('boom')%20%7D%0A%2F%2F%20activation-2")
    } finally {
      Object.defineProperty(URL, 'createObjectURL', {
        value: originalCreateObjectURL,
        configurable: true,
        writable: true,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        value: originalRevokeObjectURL,
        configurable: true,
        writable: true,
      })
    }
  })

  it('revokes default loader module urls when module import evaluation fails', async () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('data:text/javascript,export%20const%20helper%20%3D%201')
      .mockReturnValueOnce("data:text/javascript,import%20'data:text/javascript,export%20const%20helper%20%3D%201'%0Athrow%20new%20Error('eval%20boom')")
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    })

    const runtime = createPluginRuntime({
      listPlugins: vi.fn(async () => response()),
      readPluginAsset: vi.fn(async (_pluginId, relativePath) => {
        if (relativePath === 'main.js') {
          return "import './helper.js'\nthrow new Error('eval boom')"
        }
        if (relativePath === 'helper.js') {
          return 'export const helper = 1'
        }
        if (relativePath === 'style.css') {
          return ''
        }
        throw new Error(`unexpected asset: ${relativePath}`)
      }),
      execPluginShell: vi.fn(),
      getUnsafe: () => ({ window, document }),
      getWorkspaceApi: () => ({ rootPath: 'D:/Project' }),
      getEditorApi: () => ({}),
      showToast: vi.fn(),
    })

    try {
      await runtime.refresh(workspace(), [])
      const status = runtime.getStatuses().find((item) => item.id === 'sample-tools')
      expect(status?.status).toBe('failed')
      expect(status?.error).toContain('eval boom')
      expect(createObjectURL).toHaveBeenCalledTimes(2)
      expect(revokeObjectURL).toHaveBeenNthCalledWith(1, 'data:text/javascript,export%20const%20helper%20%3D%201')
      expect(revokeObjectURL).toHaveBeenNthCalledWith(2, "data:text/javascript,import%20'data:text/javascript,export%20const%20helper%20%3D%201'%0Athrow%20new%20Error('eval%20boom')")
    } finally {
      Object.defineProperty(URL, 'createObjectURL', {
        value: originalCreateObjectURL,
        configurable: true,
        writable: true,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        value: originalRevokeObjectURL,
        configurable: true,
        writable: true,
      })
    }
  })

  it('revokes default loader module urls when module graph construction fails before import', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('data:text/javascript,export%20const%20helper%20%3D%201')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    })

    try {
      await expect(runtimeModule.defaultLoadModule(
        response().plugins[0],
        async (relativePath: string) => {
          if (relativePath === 'main.js') {
            return "import './helper.js'\nimport '../escape.js'\nexport default () => undefined"
          }
          if (relativePath === 'helper.js') {
            return 'export const helper = 1'
          }
          throw new Error(`unexpected asset: ${relativePath}`)
        },
      )).rejects.toThrow(/Plugin import escapes plugin root: main\.js -> \.\.\/escape\.js/)

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('data:text/javascript,export%20const%20helper%20%3D%201')
    } finally {
      Object.defineProperty(URL, 'createObjectURL', {
        value: originalCreateObjectURL,
        configurable: true,
        writable: true,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        value: originalRevokeObjectURL,
        configurable: true,
        writable: true,
      })
    }
  })

  it('rewrites static backtick dynamic imports without touching interpolated templates', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:url-1')
      .mockReturnValueOnce('blob:url-2')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const readAsset = vi.fn(async (relativePath: string) => {
      if (relativePath === 'dynamic.js') {
        return 'export default 2'
      }
      if (relativePath === 'helper.js') {
        return 'export default 1'
      }
      throw new Error(`unexpected asset: ${relativePath}`)
    })

    const rewritten = await runtimeModule.rewriteRelativeImportsForTest(
      [
        "const dynamicModule = await import(`./dynamic.js`)",
        "const skipped = await import(`./${name}.js`)",
        "import helper from './helper.js'",
        'export default [dynamicModule, skipped, helper]',
      ].join('\n'),
      'main.js',
      readAsset,
      new Map(),
    )

    expect(rewritten).toContain("import(`blob:url-1`)")
    expect(rewritten).toContain("import(`./${name}.js`)")
    expect(rewritten).toContain("from 'blob:url-2'")
    expect(rewritten).not.toContain("./dynamic.js`")
    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(readAsset).toHaveBeenNthCalledWith(1, 'dynamic.js')
    expect(readAsset).toHaveBeenNthCalledWith(2, 'helper.js')
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('restores template-expression state after quoted strings so later imports still rewrite', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:url-1')
      .mockReturnValueOnce('blob:url-2')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const readAsset = vi.fn(async (relativePath: string) => {
      if (relativePath === 'inner.js') {
        return 'export default 1'
      }
      if (relativePath === 'after.js') {
        return 'export default 2'
      }
      throw new Error(`unexpected asset: ${relativePath}`)
    })

    const rewritten = await runtimeModule.rewriteRelativeImportsForTest(
      [
        "const template = `prefix import './fake-template.js' ${(() => {",
        '  const text = "import ./still-fake.js"',
        "  return import('./inner.js')",
        '})()} suffix export * from \'./still-fake-after.js\'`',
        "import after from './after.js'",
        'export default [template, after]',
      ].join('\n'),
      'main.js',
      readAsset,
      new Map(),
    )

    expect(rewritten).toContain("import './fake-template.js'")
    expect(rewritten).toContain("export * from './still-fake-after.js'")
    expect(rewritten).toContain("import('blob:url-1')")
    expect(rewritten).toContain("from 'blob:url-2'")
    expect(rewritten).not.toContain("./inner.js')")
    expect(rewritten).not.toContain("./after.js")
    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(readAsset).toHaveBeenNthCalledWith(1, 'inner.js')
    expect(readAsset).toHaveBeenNthCalledWith(2, 'after.js')
  })

  it('restores template-expression state after comments so later imports still rewrite', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:url-1')
      .mockReturnValueOnce('blob:url-2')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const readAsset = vi.fn(async (relativePath: string) => {
      if (relativePath === 'inner-comment.js') {
        return 'export default 3'
      }
      if (relativePath === 'after-comment.js') {
        return 'export default 4'
      }
      throw new Error(`unexpected asset: ${relativePath}`)
    })

    const rewritten = await runtimeModule.rewriteRelativeImportsForTest(
      [
        'const template = `head ${(() => {',
        "  // import './fake-line-comment.js'",
        "  /* export * from './fake-block-comment.js' */",
        "  return import('./inner-comment.js')",
        '})()} tail import(\'./fake-template-tail.js\')`',
        "import afterComment from './after-comment.js'",
        'export default [template, afterComment]',
      ].join('\n'),
      'main.js',
      readAsset,
      new Map(),
    )

    expect(rewritten).toContain("./fake-line-comment.js")
    expect(rewritten).toContain("./fake-block-comment.js")
    expect(rewritten).toContain("./fake-template-tail.js")
    expect(rewritten).toContain("import('blob:url-1')")
    expect(rewritten).toContain("from 'blob:url-2'")
    expect(rewritten).not.toContain("./inner-comment.js')")
    expect(rewritten).not.toContain("./after-comment.js")
    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(readAsset).toHaveBeenNthCalledWith(1, 'inner-comment.js')
    expect(readAsset).toHaveBeenNthCalledWith(2, 'after-comment.js')
  })

  it('rewrites local imports after line comments ending with member-access punctuation', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:url-1')
      .mockReturnValueOnce('blob:url-2')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const readAsset = vi.fn(async (relativePath: string) => {
      if (relativePath === 'helper.js') {
        return 'export default 1'
      }
      if (relativePath === 'exports.js') {
        return 'export const value = 2'
      }
      throw new Error(`unexpected asset: ${relativePath}`)
    })

    const rewritten = await runtimeModule.rewriteRelativeImportsForTest(
      [
        '// comment ending with dot.',
        "import helper from './helper.js'",
        "export { value } from './exports.js'",
        'export default helper',
      ].join('\n'),
      'main.js',
      readAsset,
      new Map(),
    )

    expect(rewritten).toContain("from 'blob:url-1'")
    expect(rewritten).toContain("from 'blob:url-2'")
    expect(rewritten).not.toContain("./helper.js")
    expect(rewritten).not.toContain("./exports.js")
    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(readAsset).toHaveBeenNthCalledWith(1, 'helper.js')
    expect(readAsset).toHaveBeenNthCalledWith(2, 'exports.js')
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('does not rewrite member access import or export property text', async () => {
    const runtimeModule = await import('./pluginRuntime') as Record<string, any>
    const createObjectURL = vi.fn()
      .mockReturnValueOnce('blob:url-1')
      .mockReturnValueOnce('blob:url-2')
      .mockReturnValueOnce('blob:url-3')
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
      writable: true,
    })

    const readAsset = vi.fn(async (relativePath: string) => {
      if (relativePath === 'actual-dynamic.js') {
        return 'export default 1'
      }
      if (relativePath === 'actual-static.js') {
        return 'export default 2'
      }
      if (relativePath === 'actual-export.js') {
        return 'export const value = 3'
      }
      throw new Error(`unexpected asset: ${relativePath}`)
    })

    const rewritten = await runtimeModule.rewriteRelativeImportsForTest(
      [
        "const viaProperty = obj.import('./member-dynamic.js')",
        "const viaOptionalProperty = foo?.import('./member-optional.js')",
        "const exportProperty = obj.export?.value ?? registry.export",
        "const actualDynamic = await import('./actual-dynamic.js')",
        "import actualStatic from './actual-static.js'",
        "export { value } from './actual-export.js'",
        'export default [viaProperty, viaOptionalProperty, exportProperty, actualDynamic, actualStatic, value]',
      ].join('\n'),
      'main.js',
      readAsset,
      new Map(),
    )

    expect(rewritten).toContain("obj.import('./member-dynamic.js')")
    expect(rewritten).toContain("foo?.import('./member-optional.js')")
    expect(rewritten).toContain('obj.export?.value ?? registry.export')
    expect(rewritten).toContain("import('blob:url-1')")
    expect(rewritten).toContain("from 'blob:url-2'")
    expect(rewritten).toContain("from 'blob:url-3'")
    expect(rewritten).not.toContain("./actual-dynamic.js')")
    expect(rewritten).not.toContain("./actual-static.js")
    expect(rewritten).not.toContain("./actual-export.js")
    expect(readAsset).toHaveBeenCalledTimes(3)
    expect(readAsset).toHaveBeenNthCalledWith(1, 'actual-dynamic.js')
    expect(readAsset).toHaveBeenNthCalledWith(2, 'actual-static.js')
    expect(readAsset).toHaveBeenNthCalledWith(3, 'actual-export.js')
  })
})

