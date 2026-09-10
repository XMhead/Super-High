import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildProjectEditorBridgeScript } from './projectEditorBridge'

describe('project editor bridge', () => {
  afterEach(() => {
    delete (window as any).superhighEditor
    delete (window as any).superhigh
    vi.restoreAllMocks()
  })

  it('exposes the shared DragonCore request API', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript('ni'))()

    void (window as any).superhighEditor.dragonCore('parse-gui', { path: 'DragonCore/Gui/a.yml' })

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'superhigh-editor:dragoncore',
      operation: 'parse-gui',
      payload: { path: 'DragonCore/Gui/a.yml' },
    }), '*')
  })

  it('exposes the script-tool runner with values', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript('ni'))()

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
    new Function(buildProjectEditorBridgeScript('ni'))()

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

  it('forwards dirty metadata without breaking two-argument preview listeners', () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript('ni'))()
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
    new Function(buildProjectEditorBridgeScript('ni'))()

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

  it('updates the exposed main item source from preview context', () => {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript('ni'))()

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'superhigh-editor:context',
        mainItemLibrarySource: 'mm',
      },
    }))

    expect((window as any).superhigh.itemLibrary.mainSource).toBe('mm')
    expect((window as any).superhighEditor.context().mainItemLibrarySource).toBe('mm')
  })
})
