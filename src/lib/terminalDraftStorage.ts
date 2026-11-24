import type { CliImageAttachment } from './cliImagePaste'
import type { CliTextAttachment } from './cliTextPaste'

interface TerminalDraft {
  text: string
  images: Omit<CliImageAttachment, 'previewUrl'>[]
  files: CliTextAttachment[]
}

const PREFIX = 'superhigh.terminal-draft.'

export function readTerminalDraft(sessionId: string): TerminalDraft {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + sessionId) ?? '{}')
    const attachments = (items: unknown): CliTextAttachment[] => Array.isArray(items)
      ? items.filter((item) => item && typeof item.id === 'string' && typeof item.path === 'string' && typeof item.fileName === 'string')
        .map(({ id, path, fileName }) => ({ id, path, fileName }))
      : []
    return { text: typeof value?.text === 'string' ? value.text : '', images: attachments(value?.images), files: attachments(value?.files) }
  } catch { return { text: '', images: [], files: [] } }
}

// 同步写入 WebView 的本机存储，关闭窗口和强制重启前无需等待去抖任务。
// 图片只保存文件引用，避免把预览 Data URL 写入草稿。
export function saveTerminalDraft(sessionId: string, patch: Partial<TerminalDraft>) {
  const value = { ...readTerminalDraft(sessionId), ...patch }
  const key = PREFIX + sessionId
  if (!value.text && !value.images.length && !value.files.length) localStorage.removeItem(key)
  else localStorage.setItem(key, JSON.stringify(value))
}

export function removeTerminalDraft(sessionId: string) {
  localStorage.removeItem(PREFIX + sessionId)
}
