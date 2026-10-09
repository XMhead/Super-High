import { describe, expect, it } from 'vitest'
import { findPluginPreviewProvider, registerPluginPreviewProvider } from './pluginPreviewProviders'

describe('plugin preview providers', () => {
  it('matches by extension case-insensitively and unregisters with the returned disposer', () => {
    const dispose = registerPluginPreviewProvider({ id: 'bb', extensions: ['bbmodel'], mount: () => undefined })
    expect(findPluginPreviewProvider('D:/models/Sword.BBMODEL')?.id).toBe('bb')
    expect(findPluginPreviewProvider('D:/models/sword.json')).toBeNull()
    dispose()
    expect(findPluginPreviewProvider('D:/models/sword.bbmodel')).toBeNull()
  })

  it('replaces a provider re-registered with the same id, and a stale disposer does not remove the new one', () => {
    const disposeOld = registerPluginPreviewProvider({ id: 'bb', title: 'old', extensions: ['.bbmodel'], mount: () => undefined })
    const disposeNew = registerPluginPreviewProvider({ id: 'bb', title: 'new', extensions: ['.bbmodel'], mount: () => undefined })
    expect(findPluginPreviewProvider('a.bbmodel')?.title).toBe('new')
    disposeOld()
    expect(findPluginPreviewProvider('a.bbmodel')?.title).toBe('new')
    disposeNew()
  })

  it('rejects providers without mount or extensions', () => {
    expect(() => registerPluginPreviewProvider({ id: 'x', extensions: [], mount: () => undefined })).toThrow()
    expect(() => registerPluginPreviewProvider({ id: 'x', extensions: ['a'] } as never)).toThrow()
  })
})
