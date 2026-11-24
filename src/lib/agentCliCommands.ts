import { ref } from 'vue'

import bundledCatalog from '@/lib/agentCliCommands.json'
import { normalizePath } from '@/lib/path'
import { backend, isTauri } from '@/lib/tauri'

export interface AgentCliCommand {
  command: string
  description: string
  translation: string
}

export interface AgentCliCommandCatalog {
  version: number
  providers: Record<string, AgentCliCommand[]>
}

export const AGENT_CLI_COMMAND_CATALOG_FILE = 'agent-cli-commands.json'
/** 每次运行目录加载或切换到内置目录后递增，供补全 computed 重新读取。 */
export const agentCliCommandCatalogRevision = ref(0)
export const agentCliCommandCatalogPath = ref('')
export const agentCliCommandCatalogError = ref('')

const fallbackCatalog = normalizeCatalog(bundledCatalog)
let activeCatalog = fallbackCatalog
let loading: Promise<void> | null = null
let dataDirectoryPromise: Promise<string> | null = null

export function agentCliCommandsFor(provider: string | undefined): AgentCliCommand[] {
  return provider ? activeCatalog.providers[provider] ?? [] : []
}

export function agentCliCommandDescription(entry: AgentCliCommand, translated: boolean): string {
  return translated && entry.translation ? entry.translation : entry.description
}

function normalizeCommands(raw: unknown): AgentCliCommand[] {
  if (!Array.isArray(raw)) return []
  const commands: AgentCliCommand[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const source = item as Record<string, unknown>
    const command = typeof source.command === 'string' ? source.command.trim() : ''
    const description = typeof source.description === 'string' ? source.description.trim() : ''
    const translation = typeof source.translation === 'string' ? source.translation.trim() : ''
    if (!/^\/[A-Za-z][\w:.-]*$/.test(command) || !description) continue
    commands.push({ command, description, translation })
  }
  return commands.sort((left, right) => left.command.localeCompare(right.command))
}

function normalizeCatalog(raw: unknown): AgentCliCommandCatalog {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const providers: Record<string, AgentCliCommand[]> = {}
  const rawProviders = source.providers && typeof source.providers === 'object'
    ? source.providers as Record<string, unknown>
    : {}
  for (const [provider, commands] of Object.entries(rawProviders)) providers[provider] = normalizeCommands(commands)
  return {
    version: typeof source.version === 'number' ? source.version : 1,
    providers,
  }
}

/** 运行目录按提供方覆盖内置目录；未写出的提供方继续使用内置内容。 */
function mergeCatalog(runtime: AgentCliCommandCatalog): AgentCliCommandCatalog {
  return {
    version: Math.max(runtime.version, fallbackCatalog.version),
    providers: { ...fallbackCatalog.providers, ...runtime.providers },
  }
}

function isMissingFileError(error: unknown): boolean {
  const text = String(error).toLowerCase()
  return text.includes('os error 2') || text.includes('no such file') || text.includes('找不到')
}

async function dataDirectory(): Promise<string> {
  dataDirectoryPromise ??= backend.getAppStorageInfo()
    .then((info) => normalizePath(info.dataDir).replace(/\/+$/, ''))
    .catch((error) => {
      dataDirectoryPromise = null
      throw error
    })
  return dataDirectoryPromise
}

async function catalogPath(): Promise<string> {
  return `${await dataDirectory()}/${AGENT_CLI_COMMAND_CATALOG_FILE}`
}

/**
 * 读取应用数据目录中的命令目录。文件不存在时使用内置目录；
 * 文件写坏时保留内置目录并记录错误，避免阻塞输入补全。
 */
export async function loadAgentCliCommandCatalog(force = false): Promise<void> {
  if (!isTauri()) {
    activeCatalog = fallbackCatalog
    agentCliCommandCatalogError.value = ''
    agentCliCommandCatalogRevision.value += 1
    return
  }
  if (loading) {
    if (!force) return loading
    await loading
  }
  loading = (async () => {
    let path = ''
    try {
      path = await catalogPath()
      agentCliCommandCatalogPath.value = path
      let text: string
      try {
        text = await backend.readFile(path)
      } catch (error) {
        if (!isMissingFileError(error)) agentCliCommandCatalogError.value = `读取 Agent CLI 命令配置失败：${String(error)}`
        activeCatalog = fallbackCatalog
        return
      }
      try {
        activeCatalog = mergeCatalog(normalizeCatalog(JSON.parse(text)))
        agentCliCommandCatalogError.value = ''
      } catch (error) {
        activeCatalog = fallbackCatalog
        agentCliCommandCatalogError.value = `Agent CLI 命令配置无法解析：${String(error)}`
      }
    } catch (error) {
      activeCatalog = fallbackCatalog
      agentCliCommandCatalogError.value = `读取 Agent CLI 命令配置路径失败：${String(error)}`
    } finally {
      agentCliCommandCatalogRevision.value += 1
      loading = null
    }
  })()
  return loading
}

/** 确保可编辑的运行目录存在，返回其绝对路径。 */
export async function ensureAgentCliCommandCatalogFile(): Promise<string> {
  const path = await catalogPath()
  try {
    await backend.readFile(path)
  } catch (error) {
    if (!isMissingFileError(error)) throw error
    await backend.writeFile(path, `${JSON.stringify(bundledCatalog, null, 2)}\n`)
    await loadAgentCliCommandCatalog(true)
  }
  agentCliCommandCatalogPath.value = path
  return path
}
