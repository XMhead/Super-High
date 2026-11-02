import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildProjectEditorBridgeScript } from './projectEditorBridge'

describe('project editor bridge', () => {
  afterEach(() => {
    delete (window as any).superhighEditor
    delete (window as any).superhigh
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([{ getRandomValues: vi.fn() }, undefined])('routes concurrent replies without randomUUID (%s)', async (cryptoApi) => {
    vi.stubGlobal('crypto', cryptoApi)
    vi.spyOn(Date, 'now').mockReturnValue(123)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript())()
    postMessage.mockClear()
    const bridge = (window as any).superhighEditor
    const read = bridge.fs('read', 'DragonCore/Gui/a.yml')
    const script = bridge.runScriptToolJson('internal', { query: 'a' })
    const bind = bridge.bindCodePreview('DragonCore/Gui/a.yml')
    const failedBinding = expect(bind).rejects.toThrow('binding failed')
    const requests = postMessage.mock.calls.map(([message]) => message)
    expect(new Set(requests.map(({ requestId }) => requestId)).size).toBe(3)
    for (const request of requests) expect(request.requestId).toEqual(expect.any(String))
    const reply = (index: number, payload: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', {
      data: { type: `${requests[index].type}-result`, requestId: requests[index].requestId, ...payload },
    }))
    reply(1, { result: { exitCode: 0, stdout: '{"items":[]}', stderr: '' } })
    reply(2, { type: `${requests[2].type}-error`, error: 'binding failed' })
    reply(0, { result: '组件:\n  type: texture\n' })
    await expect(script).resolves.toEqual({ items: [] })
    await expect(read).resolves.toBe('组件:\n  type: texture\n')
    await failedBinding
  })


  it('forwards unmodified F1 once and suppresses browser help', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript())()
    postMessage.mockClear()
    const event = new KeyboardEvent('keydown', { key: 'F1', cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(postMessage).toHaveBeenCalledWith({ type: 'superhigh-editor:toggle-explorer' }, '*')
    postMessage.mockClear()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', repeat: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', ctrlKey: true, cancelable: true }))
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('exposes the script-tool runner with values', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript())()

    void (window as any).superhighEditor.runScriptTool('bbmodel-ai', {
      requestFile: '.superhigh/bbmodel-ai/runs/jobs/test.request.json',
    })

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'superhigh-editor:script-tool',
      toolId: 'bbmodel-ai',
      values: { requestFile: '.superhigh/bbmodel-ai/runs/jobs/test.request.json' },
    }), '*')
  })

  it('resolves script-tool requests through the shared response channel', async () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript())()

    const pending = (window as any).superhighEditor.runScriptTool('bbmodel-ai', { action: 'batch-generate' })
    const request = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find((message) => message.type === 'superhigh-editor:script-tool')!
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'superhigh-editor:script-tool-result',
        requestId: request.requestId,
        result: { exitCode: 0 },
      },
    }))

    await expect(pending).resolves.toEqual({ exitCode: 0 })
  })

  it('discovers tools and parses JSON while rejecting process and JSON failures', async () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript())()
    const bridge = (window as any).superhighEditor
    const reply = (result: unknown) => {
      const message = postMessage.mock.calls.at(-1)![0]
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: `${message.type}-result`, requestId: message.requestId, result,
      } }))
    }
    const discovery = bridge.listScriptTools()
    reply({ tools: [{ id: 'internal', hidden: true }] })
    await expect(discovery).resolves.toEqual({ tools: [{ id: 'internal', hidden: true }] })
    const success = bridge.runScriptToolJson('internal', { query: 'a' })
    reply({ exitCode: 0, stdout: '{"items":[]}', stderr: '' })
    await expect(success).resolves.toEqual({ items: [] })
    const failure = bridge.runScriptToolJson('internal')
    reply({ exitCode: 4, stdout: '{}', stderr: 'operation failed' })
    await expect(failure).rejects.toThrow('operation failed')
    const malformed = bridge.runScriptToolJson('internal')
    reply({ exitCode: 0, stdout: 'progress\n{}', stderr: '' })
    await expect(malformed).rejects.toThrow('有效 JSON')
  })

  it('forwards dirty metadata without breaking two-argument preview listeners', () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript())()
    const legacyListener = vi.fn((_path: string, _content: string) => undefined)
    const metadataListener = vi.fn()

    ;(window as any).superhighEditor.onCodePreviewContent(legacyListener)
    ;(window as any).superhighEditor.onCodePreviewContent(metadataListener)
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'superhigh-editor:code-preview-content',
        path: 'DragonCore/Gui/a.yml',
        content: '组件:\n  type: texture\n',
        isDirty: true,
      },
    }))

    expect(legacyListener.mock.calls[0]?.slice(0, 2)).toEqual([
      'DragonCore/Gui/a.yml',
      '组件:\n  type: texture\n',
    ])
    expect(metadataListener).toHaveBeenCalledWith(
      'DragonCore/Gui/a.yml',
      '组件:\n  type: texture\n',
      { isDirty: true },
    )
  })

  it('carries Monaco positions and clean content updates', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript())()

    void (window as any).superhighEditor.bindCodePreview('DragonCore/Gui/a.yml', { lineNumber: 12, column: 3 })
    void (window as any).superhighEditor.setCodePreviewContent('DragonCore/Gui/a.yml', 'saved', { isDirty: false })

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'superhigh-editor:code-preview-bind',
      path: 'DragonCore/Gui/a.yml',
      lineNumber: 12,
      column: 3,
    }), '*')
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'superhigh-editor:code-preview-set-content',
      path: 'DragonCore/Gui/a.yml',
      content: 'saved',
      isDirty: false,
    }), '*')
  })


})
