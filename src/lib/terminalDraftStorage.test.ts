import { afterEach, describe, expect, it } from 'vitest'
import { readTerminalDraft, removeTerminalDraft, saveTerminalDraft } from './terminalDraftStorage'

afterEach(() => localStorage.clear())

describe('terminal draft persistence', () => {
  it('restores unsent text and attachment references independently for each session', () => {
    saveTerminalDraft('a', { text: '尚未发送\n继续编辑' })
    saveTerminalDraft('a', { images: [{ id: 'image', path: 'D:/Repo/image.png', fileName: 'image.png' }] })
    saveTerminalDraft('a', { files: [{ id: 'file', path: 'D:/Repo/note.txt', fileName: 'note.txt' }] })
    saveTerminalDraft('b', { text: '另一会话' })
    expect(readTerminalDraft('a')).toEqual({
      text: '尚未发送\n继续编辑',
      images: [{ id: 'image', path: 'D:/Repo/image.png', fileName: 'image.png' }],
      files: [{ id: 'file', path: 'D:/Repo/note.txt', fileName: 'note.txt' }],
    })
    saveTerminalDraft('a', { text: '', images: [], files: [] })
    expect(readTerminalDraft('a').text).toBe('')
    expect(readTerminalDraft('b').text).toBe('另一会话')
    removeTerminalDraft('b')
    expect(localStorage.length).toBe(0)
  })

  it('ignores malformed storage and does not retain image preview data', () => {
    localStorage.setItem('superhigh.terminal-draft.a', '{broken')
    expect(readTerminalDraft('a')).toEqual({ text: '', images: [], files: [] })
    localStorage.setItem('superhigh.terminal-draft.a', JSON.stringify({ text: 12, files: [null], images: [
      { id: 'i', path: 'D:/image.png', fileName: 'image.png', previewUrl: 'data:huge-preview' },
    ] }))
    saveTerminalDraft('a', { text: 'recovered' })
    expect(localStorage.getItem('superhigh.terminal-draft.a')).not.toContain('previewUrl')
    expect(readTerminalDraft('a').files).toEqual([])
  })
})
