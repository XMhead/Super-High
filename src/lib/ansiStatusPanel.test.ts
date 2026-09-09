// @vitest-environment node

import { describe, expect, it } from 'vitest'

type AnsiStatusPanelModule = {
  ansiFg: (r: number, g: number, b: number) => string
  createAnsiStatusPanel: (options: Record<string, unknown>) => {
    enabled: boolean
    update: (frame: Record<string, unknown>) => void
    finish: (frame?: Record<string, unknown>) => void
  }
}

// 中文注释：动态加载 Node 脚本模块，避免给 Vite 前端产物引入脚本侧代码。
async function loadAnsiStatusPanelModule(): Promise<AnsiStatusPanelModule> {
  // @ts-expect-error 测试直接加载 Node ESM 脚本，项目不需要为脚本侧 .mjs 生成前端类型声明。
  return await import('../../scripts/ansi-status-panel.mjs') as AnsiStatusPanelModule
}

// 中文注释：创建一个最小 stdout 替身，用来捕获 ANSI 输出。
function createStream(isTTY = true) {
  const writes: string[] = []
  return {
    writes,
    stream: {
      isTTY,
      write(value: string) {
        writes.push(String(value))
        return true
      },
    },
  }
}

describe('ansi status panel', () => {
  it('renders synchronized repaint frames in a TTY', async () => {
    const { createAnsiStatusPanel } = await loadAnsiStatusPanelModule()
    const { writes, stream } = createStream(true)
    const panel = createAnsiStatusPanel({ title: '导出图片', stream, width: 44 })

    panel.update({ status: '解析像素', progress: 25, detail: 'main.md' })
    panel.update({ status: '编码 PNG', progress: 75, detail: 'output.png' })
    panel.finish({ status: '导出完成', detail: 'output.png' })

    const output = writes.join('')
    expect(output).toContain('\x1b[?2026h')
    expect(output).toContain('\x1b[?2026l')
    expect(output).toContain('\x1b[?25l')
    expect(output).toContain('\x1b[?25h')
    expect(output).toContain('\x1b[4A')
    expect(output).toContain('导出图片')
    expect(output).toContain('导出完成')
  })

  it('keeps non-interactive output clean', async () => {
    const { createAnsiStatusPanel } = await loadAnsiStatusPanelModule()
    const { writes, stream } = createStream(false)
    const panel = createAnsiStatusPanel({ title: '导出图片', stream })

    panel.update({ status: '解析像素', progress: 25 })
    panel.finish({ status: '导出完成' })

    expect(writes).toEqual([])
  })

  it('builds truecolor foreground escape codes', async () => {
    const { ansiFg } = await loadAnsiStatusPanelModule()

    expect(ansiFg(300, -1, 12)).toBe('\x1b[38;2;255;0;12m')
  })
})
