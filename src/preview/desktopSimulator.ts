import { ref, type Ref } from 'vue'
import type { Pinia } from 'pinia'
import { backend } from '@/lib/tauri'
import { applyTheme } from '@/lib/theme'
import { useWorkspaceStore } from '@/stores/workspace'
import { emitPreviewEvent } from './tauriEventStub'
import { openPreviewSource, previewPathName, type PreviewSource } from './workspaceSource'
import type { FileOperationResult, MemoRecord, TerminalSession, Workspace } from '@/types'

export const DESKTOP_SIMULATOR_KEY = 'superhigh.preview.desktop.v1'

export interface DesktopSimulatorOptions {
  scenario: 'ready' | 'empty' | 'error'
  mode: 'simulate' | 'readonly'
  persist: boolean
}

export interface DesktopSimulator {
  message: Ref<string>
  reset: () => Promise<void>
  dispose: () => void
}

interface SimulatedTerminal {
  session: TerminalSession
  buffer: string
  endByte: number
  line: string
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const utf8 = new TextEncoder()
const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/** 浏览器内的主工作区演示：真实源码目录只读 + 本地模拟终端与写入覆盖层。 */
export async function installDesktopSimulator(pinia: Pinia, options: DesktopSimulatorOptions): Promise<DesktopSimulator> {
  const workspace = useWorkspaceStore(pinia)
  const message = ref('')
  const restorers: Array<() => void> = []
  const terminals = new Map<string, SimulatedTerminal>()
  const memos: MemoRecord[] = []
  const initialSettings = clone(workspace.settings)
  let source: PreviewSource = await openPreviewSource()
  let sessionSequence = 0
  let disposed = false

  function replace<T extends object, K extends keyof T>(target: T, key: K, value: T[K]) {
    const original = target[key]
    target[key] = value
    restorers.push(() => { target[key] = original })
  }
  function receipt(text: string) { message.value = text }
  function notWritable(): boolean {
    if (options.scenario === 'error') { receipt('失败场景：写入被拒绝（模拟）。'); return true }
    if (options.mode === 'readonly') { receipt('只读预览：不允许修改文件。'); return true }
    return false
  }
  function workspaceInfo(): Workspace {
    return { id: 'preview-source', name: source.name, displayName: source.displayName, rootPath: source.rootPath, openedAt: new Date().toISOString() }
  }
  function fallbackValue(key: string) {
    if (key.startsWith('list')) return []
    if (/^(get|read|take|pick|select|detect|ensure|probe|query|fetch|resolve|check|is)/.test(key)) return null
    return undefined
  }
  // Every backend call is answered locally; only the entries below reach the real source tree.
  for (const key of Object.keys(backend) as Array<keyof typeof backend>) {
    replace(backend, key, (async () => fallbackValue(key)) as (typeof backend)[typeof key])
  }

  // —— 工作区 ——
  replace(backend, 'openProject', async () => workspaceInfo())
  replace(backend, 'listRecentProjects', async () => (options.scenario === 'empty' ? [] : [{ path: source.rootPath, name: source.name, lastOpenedAt: new Date().toISOString() }]))
  replace(backend, 'removeRecentProject', async () => undefined)
  replace(backend, 'takeStartupOpenTarget', async () => null)
  replace(backend, 'setActiveWorkspace', async () => undefined)
  replace(backend, 'syncWorkspaceWatchRoots', async () => undefined)
  replace(backend, 'syncWorkspaceWatchTargets', async () => undefined)
  replace(backend, 'shutdownApp', async () => { receipt('关闭应用回执：预览页面不受影响。') })
  replace(backend, 'getSettings', async () => clone(workspace.settings))
  replace(backend, 'saveSettings', async (settings) => {
    workspace.settings = clone(settings)
    persist()
    receipt('设置已保存到当前浏览器会话。')
    return clone(settings)
  })
  replace(backend, 'getAppStorageInfo', async () => ({
    dataDir: '预览 · 浏览器会话', databasePath: '预览 · 不写入磁盘', databaseSizeBytes: 0,
    superHighRoot: source.rootPath, globalLibraryRoot: `${source.rootPath}/.superhigh`, globalPluginsDir: `${source.rootPath}/.superhigh/plugins`,
    pluginLogPath: `${source.rootPath}/.superhigh/plugins.log`, pluginDisableFlagPath: `${source.rootPath}/.superhigh/plugins.disabled`,
  }))

  // —— 文件树与文件内容 ——
  replace(backend, 'listDirectory', async (path) => source.listDirectory(path))
  replace(backend, 'isFile', async (path) => await source.statPath(path) === 'file')
  replace(backend, 'readFile', async (path) => source.readTextFile(path))
  replace(backend, 'readImageAsDataUrl', async (path) => dataUrl(await source.readRawFile(path)))
  replace(backend, 'readMediaAsDataUrl', async (path) => dataUrl(await source.readRawFile(path)))
  replace(backend, 'readOfficeFileBase64', async (path) => base64(await source.readRawFile(path)))
  replace(backend, 'resolveTerminalPath', async (path) => {
    const kind = await source.statPath(path)
    return kind ? { path, isFile: kind === 'file' } : null
  })
  replace(backend, 'writeFile', async (path, content) => {
    if (notWritable()) throw new Error('当前预览不允许写入文件')
    source.writeFile(path, content)
    receipt(`已写入 ${previewPathName(path)}（仅保留在当前页面）。`)
  })
  replace(backend, 'createFile', async (path) => {
    if (notWritable()) throw new Error('当前预览不允许新建文件')
    source.createFile(path)
  })
  replace(backend, 'createDirectory', async (path) => {
    if (notWritable()) throw new Error('当前预览不允许新建文件夹')
    source.createDirectory(path)
  })
  replace(backend, 'renamePath', async (path, nextPath) => {
    if (notWritable()) throw new Error('当前预览不允许重命名')
    source.renamePath(path, nextPath)
  })
  replace(backend, 'deletePath', async (path) => {
    if (notWritable()) throw new Error('当前预览不允许删除')
    source.deletePath(path)
  })
  replace(backend, 'copyPathsToDirectory', async (paths, targetDirectory) => paths.map((path): FileOperationResult => ({ sourcePath: path, targetPath: `${targetDirectory}/${previewPathName(path)}`, ok: true })))
  replace(backend, 'movePathsToDirectory', async (paths, targetDirectory) => paths.map((path): FileOperationResult => ({ sourcePath: path, targetPath: `${targetDirectory}/${previewPathName(path)}`, ok: true })))
  replace(backend, 'searchProjectFiles', async () => ({ files: [], textMatches: [] }))
  replace(backend, 'discoverProjectInstructionFiles', async (projectPath) => ({ projectPath, files: [] }))
  replace(backend, 'listSkills', async () => [])
  replace(backend, 'selectFiles', async () => [])
  replace(backend, 'selectDirectory', async () => null)
  replace(backend, 'pickSaveFilePath', async () => null)
  replace(backend, 'pickPngExportPath', async () => null)

  // —— 项目能力（预览中没有真实后端） ——
  replace(backend, 'getProjectMinecraftCapabilities', async () => { throw new Error('预览模式不提供 Minecraft 能力检测') })
  replace(backend, 'getMinecraftClientConfig', async () => null)
  replace(backend, 'getProjectStartupConfig', async () => null)
  replace(backend, 'getProjectTerminalActions', async () => [])
  replace(backend, 'listProjectScriptTools', async () => ({ configPath: null, directories: [], tools: [] }))
  replace(backend, 'detectVitePressDocs', async (projectPath) => ({ projectPath, docsRoot: '', url: '', port: 0, running: false, startedBySuperHigh: false }))
  replace(backend, 'openUrl', async (url) => { receipt(`打开链接回执：${url}（未打开）。`) })
  replace(backend, 'openPath', async (path) => { receipt(`打开路径回执：${path}（未打开）。`) })
  replace(backend, 'openFileWithApp', async (path) => { receipt(`用系统应用打开：${path}（仅回执）。`) })

  // —— 备忘录 ——
  replace(backend, 'listMemos', async () => clone(memos))
  replace(backend, 'listMemoCategories', async () => [...new Set(memos.map((memo) => memo.category ?? '').filter(Boolean))])
  replace(backend, 'createMemoCategory', async (name) => [...new Set([...memos.map((memo) => memo.category ?? '').filter(Boolean), name])])
  replace(backend, 'createMemo', async (category = '') => {
    const now = new Date().toISOString()
    const memo: MemoRecord = { id: crypto.randomUUID(), title: '新备忘', content: '', attachments: [], category, createdAt: now, updatedAt: now }
    memos.unshift(memo)
    return clone(memo)
  })
  replace(backend, 'updateMemo', async (id, title, content, category = '', attachments = []) => {
    const memo = memos.find((item) => item.id === id)
    if (!memo) throw new Error('备忘不存在（预览）')
    Object.assign(memo, { title, content, category, attachments, updatedAt: new Date().toISOString() })
    return clone(memo)
  })
  replace(backend, 'deleteMemo', async (id) => {
    const index = memos.findIndex((item) => item.id === id)
    if (index >= 0) memos.splice(index, 1)
  })
  replace(backend, 'saveMemoImage', async () => '')

  // —— 终端（浏览器内模拟 PTY） ——
  replace(backend, 'createTerminalSession', async (_workspaceId, providerKind, cwd) => createTerminal(providerKind, cwd))
  replace(backend, 'resumeCliConversation', async (_workspaceId, providerKind, cwd) => createTerminal(providerKind, cwd))
  replace(backend, 'getTerminalBuffer', async (sessionId) => {
    const terminal = terminals.get(sessionId)
    if (!terminal) throw new Error(`预览会话不存在：${sessionId}`)
    return { buffer: terminal.buffer, startByte: 0, endByte: terminal.endByte }
  })
  replace(backend, 'writeTerminalInput', async (sessionId, input) => { await handleTerminalInput(sessionId, input) })
  replace(backend, 'resizeTerminal', async () => undefined)
  replace(backend, 'closeTerminal', async (sessionId) => { terminals.delete(sessionId) })
  replace(backend, 'closeTerminalSessionsForWorkspace', async () => { terminals.clear() })
  replace(backend, 'listLiveTerminalSessionIds', async () => [...terminals.keys()])
  replace(backend, 'openExternalCli', async () => { receipt('预览中不支持打开外部 CLI。') })
  replace(backend, 'openExternalCliSession', async () => { receipt('预览中不支持接管外部会话。') })
  replace(backend, 'getSessionChanges', async () => ({ available: false, reason: '预览模式不提供改动视图', mode: 'plain', root: source.rootPath, baseline: 'session', capturedAtMs: null, files: [], truncated: false }))
  replace(backend, 'getSessionFileDiff', async () => ({ file: null, rows: [], truncated: false, tooLarge: false, unavailableBase: true }))
  replace(backend, 'promptSpacingStatus', async () => ({ ready: true }))
  replace(backend, 'loadCliHistory', async () => ({ messages: [], paths: [], scannedFiles: 0, indexedFiles: 0, indexedMessages: 0 }))
  replace(backend, 'refreshCliHistory', async () => ({ messages: [], paths: [], scannedFiles: 0, indexedFiles: 0, indexedMessages: 0 }))
  replace(backend, 'listWorkspacePromptHistory', async () => [])
  replace(backend, 'listWorkspaceCliConversations', async () => [])
  replace(backend, 'getNativeCliTranscript', async () => null)
  replace(backend, 'readWorkspaceCliConversation', async () => { throw new Error('预览模式不提供历史会话内容') })
  replace(backend, 'recordCliHistoryMessage', async () => undefined)

  // —— 应用更新与渠道（预览不做真实请求） ——
  replace(backend, 'getAppUpdateStatus', async () => updateStatus())
  replace(backend, 'checkAppUpdate', async () => updateStatus())
  replace(backend, 'downloadAppUpdate', async () => updateStatus())
  replace(backend, 'installAppUpdate', async () => updateStatus())
  replace(backend, 'listCcProviders', async () => [])
  replace(backend, 'listCcProfiles', async () => ({ profiles: [], currentClaude: null, currentCodex: null }))
  replace(backend, 'queryCodexBalance', async () => ({ ok: false, providerName: '', baseUrl: '', balance: null, currency: '', queriedAt: null, error: '预览模式不查询余额' }))
  replace(backend, 'queryCodexOfficialUsage', async () => ({ ok: false, planType: '', primaryWindow: null, secondaryWindow: null, limitReached: false, resetCreditsAvailable: null, fetchedAt: null, httpStatus: null, error: '预览模式不查询官方用量' }))
  replace(backend, 'getImageViewerRegistration', async () => ({ supported: true, enabled: false, legacyRegistered: false, defaultSelected: false }))

  // —— store 动作 ——
  replace(workspace, 'openPath', async (path) => { receipt(`打开路径回执：${path}（未打开）。`) })
  replace(workspace, 'saveSettings', async () => { persist(); receipt('设置已保存在当前浏览器会话。') })

  function updateStatus() {
    return { phase: 'idle' as const, currentVersion: 'preview', version: null, notes: null, downloadedBytes: 0, totalBytes: null, error: null, blockingSessions: [] }
  }

  function dataUrl(raw: { bytes: Uint8Array; contentType: string }) {
    return `data:${raw.contentType};base64,${base64(raw)}`
  }
  function base64(raw: { bytes: Uint8Array }) {
    let binary = ''
    for (const byte of raw.bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  function appendTerminal(sessionId: string, chunk: string, notifyStore = false) {
    const terminal = terminals.get(sessionId)
    if (!terminal || !chunk) return
    const startByte = terminal.endByte
    terminal.buffer += chunk
    terminal.endByte = startByte + utf8.encode(chunk).length
    emitPreviewEvent('terminal-output', { sessionId, chunk, startByte, endByte: terminal.endByte })
    if (notifyStore) workspace.queueTerminalOutput(sessionId, chunk)
  }

  function createTerminal(providerKind: TerminalSession['providerKind'], cwd: string): TerminalSession {
    if (options.scenario === 'error') throw new Error('演示的失败场景：无法创建终端会话')
    const id = `preview-session-${++sessionSequence}`
    const session: TerminalSession = { id, title: `演示终端 ${sessionSequence}`, providerKind, cwd }
    const buffer = [
      '\u001b[1mSuper High · 主工作区演示终端\u001b[0m\r\n',
      `工作目录：${cwd}\r\n`,
      '浏览器内模拟会话：命令不会真正执行，也不会修改文件。\r\n',
      '输入 help 查看可用命令；在下方输入框发送消息即可看到模拟回复。\r\n',
      '\u001b[90m$\u001b[0m ',
    ].join('')
    terminals.set(id, { session, buffer, endByte: utf8.encode(buffer).length, line: '' })
    return session
  }

  function stripTerminalSequences(input: string): string {
    return input
      .replace(/\u001b\[200~([\s\S]*?)\u001b\[201~/g, (_match, text: string) => text)
      .replace(/\u001b\][^\u0007]*\u0007/g, '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b[@-Z\\-_]/g, '')
  }

  async function handleTerminalInput(sessionId: string, input: string) {
    const terminal = terminals.get(sessionId)
    if (!terminal) return
    for (const char of stripTerminalSequences(input)) {
      if (char === '\r' || char === '\n') {
        const command = terminal.line
        terminal.line = ''
        appendTerminal(sessionId, '\r\n')
        if (command.trim()) await respondToTerminal(sessionId, command)
        continue
      }
      if (char === '\u007f') {
        if (terminal.line) {
          terminal.line = terminal.line.slice(0, -1)
          appendTerminal(sessionId, '\b \b')
        }
        continue
      }
      if (char < ' ') continue
      terminal.line += char
      appendTerminal(sessionId, char)
    }
  }

  async function respondToTerminal(sessionId: string, command: string) {
    await delay(260)
    if (disposed || !terminals.has(sessionId)) return
    const output = await buildTerminalReply(command)
    appendTerminal(sessionId, output.endsWith('\n') ? output.replace(/\n/g, '\r\n') : `${output}\r\n`, true)
  }

  async function buildTerminalReply(command: string): Promise<string> {
    const trimmed = command.trim()
    const lower = trimmed.toLowerCase()
    try {
      if (lower === 'help') {
        return ['演示终端可用命令：', '  ls / dir        列出源码目录', '  pwd             显示工作目录', '  cat <相对路径>   查看文件内容', '其余输入会返回一条模拟回复。', ''].join('\n')
      }
      if (lower === 'ls' || lower === 'dir') {
        const listing = await source.listDirectory(source.rootPath)
        return `${listing.entries.map((entry) => (entry.type === 'directory' ? `${entry.name}/` : entry.name)).join('  ')}\n`
      }
      if (lower === 'pwd' || lower === 'cd') return `${source.rootPath}\n`
      const match = /^cat\s+(.+)$/i.exec(trimmed)
      if (match) {
        const target = match[1].trim().replace(/^["']|["']$/g, '')
        const path = target.includes(':') ? target : `${source.rootPath}/${target.replace(/^\.\//, '')}`
        const content = await source.readTextFile(path)
        return `${content.split('\n').slice(0, 40).join('\n')}\n`
      }
      return `模拟回复：已收到「${trimmed}」。\n这是浏览器内的演示终端，未调用真实 CLI，也不会修改文件。\n`
    } catch (error) {
      return `演示终端错误：${error instanceof Error ? error.message : String(error)}\n`
    }
  }

  function persist() {
    if (!options.persist) return
    try { sessionStorage.setItem(DESKTOP_SIMULATOR_KEY, JSON.stringify({ settings: workspace.settings })) }
    catch { /* 浏览器会话存储可能被禁用。 */ }
  }

  async function seed() {
    terminals.clear()
    sessionSequence = 0
    workspace.settings = clone(initialSettings)
    workspace.workspace = null
    workspace.initialized = false
    applyTheme(workspace.settings.themeId)
    const opened = await workspace.openProject()
    if (!opened) {
      receipt('预览初始化失败：无法读取源码目录。')
      return
    }
    workspace.settingsOpen = false
    if (options.scenario === 'empty') {
      receipt('空状态演示：还没有终端会话，可在终端面板新建。')
      return
    }
    try {
      await workspace.createTerminalSession('claude', {})
      receipt(options.mode === 'readonly'
        ? `只读演示：${source.rootPath}（写入不会保存）`
        : `主工作区演示：${source.rootPath}（写入仅保留在当前页面）`)
    } catch (error) {
      receipt(error instanceof Error ? error.message : String(error))
    }
  }

  await seed()
  return {
    message,
    async reset() {
      if (disposed) return
      try { sessionStorage.removeItem(DESKTOP_SIMULATOR_KEY) } catch { /* 浏览器会话存储可能被禁用。 */ }
      source = await openPreviewSource()
      await seed()
    },
    dispose() {
      if (disposed) return
      disposed = true
      terminals.clear()
      for (const restore of restorers.reverse()) restore()
    },
  }
}
