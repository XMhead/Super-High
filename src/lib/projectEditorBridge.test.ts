import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildProjectEditorBridgeScript } from './projectEditorBridge'

describe('project editor bridge', () => {
  afterEach(() => {
    delete (window as any).superhighEditor
    delete (window as any).superhigh
    vi.restoreAllMocks()
  })

  it('exposes the script-tool runner with values', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript())()

    void (window as any).superhighEditor.runScriptTool('project-task', {
      requestFile: '.superhigh/project-task/runs/jobs/test.request.json',
    })

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'superhigh-editor:script-tool',
      toolId: 'project-task',
      values: { requestFile: '.superhigh/project-task/runs/jobs/test.request.json' },
    }), '*')
  })

  it('resolves script-tool requests through the shared response channel', async () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript())()

    const pending = (window as any).superhighEditor.runScriptTool('project-task', { action: 'batch-generate' })
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
    new Function(buildProjectEditorBridgeScript())()
    const legacyListener = vi.fn((_path: string, _content: string) => undefined)
    const metadataListener = vi.fn()

    ;(window as any).superhighEditor.onCodePreviewContent(legacyListener)
    ;(window as any).superhighEditor.onCodePreviewContent(metadataListener)
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'superhigh-editor:code-preview-content',
        path: 'docs/guide/a.yml',
        content: '组件:\n  type: texture\n',
        isDirty: true,
      },
    }))

    expect(legacyListener.mock.calls[0]?.slice(0, 2)).toEqual([
      'docs/guide/a.yml',
      '组件:\n  type: texture\n',
    ])
    expect(metadataListener).toHaveBeenCalledWith(
      'docs/guide/a.yml',
      '组件:\n  type: texture\n',
      { isDirty: true },
    )
  })

  it('carries Monaco positions and clean content updates', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)
    new Function(buildProjectEditorBridgeScript())()

    void (window as any).superhighEditor.bindCodePreview('docs/guide/a.yml', { lineNumber: 12, column: 3 })
    void (window as any).superhighEditor.setCodePreviewContent('docs/guide/a.yml', 'saved', { isDirty: false })

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'superhigh-editor:code-preview-bind',
      path: 'docs/guide/a.yml',
      lineNumber: 12,
      column: 3,
    }), '*')
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'superhigh-editor:code-preview-set-content',
      path: 'docs/guide/a.yml',
      content: 'saved',
      isDirty: false,
    }), '*')
  })

})
