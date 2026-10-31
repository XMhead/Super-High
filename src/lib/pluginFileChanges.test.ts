import { describe, expect, it } from 'vitest'
import type { PluginDescriptor } from '@/types'
import { pluginFileChanges } from './pluginFileChanges'

const plugins = [
  { id: 'different-id', rootPath: 'D:/Project/.superhigh/plugins/folder' },
  { id: 'global', rootPath: 'C:/Data/plugins/global-folder' },
] as PluginDescriptor[]

describe('plugin file changes', () => {
  it('matches actual roots with case and separator normalization, including removal of a parent', () => {
    expect(pluginFileChanges(['d:\\PROJECT\\.superhigh\\plugins\\folder\\lib\\module.js'], 'D:/Project/.superhigh/plugins', plugins))
      .toEqual({ relevant: true, ids: ['different-id'] })
    expect(pluginFileChanges(['D:/Project/.superhigh/plugins'], 'D:/Project/.superhigh/plugins', plugins))
      .toEqual({ relevant: true, ids: ['different-id'] })
    expect(pluginFileChanges(['C:/Data/plugins/global-folder/main.js'], 'C:/Data/plugins', plugins))
      .toEqual({ relevant: true, ids: ['global'] })
  })

  it('rediscovers new folders and ignores unrelated events', () => {
    expect(pluginFileChanges(['D:/Project/.superhigh/plugins/new/plugin.json'], 'D:/Project/.superhigh/plugins', plugins))
      .toEqual({ relevant: true, ids: [] })
    expect(pluginFileChanges(['D:/Project/src/main.js'], 'D:/Project/.superhigh/plugins', plugins))
      .toEqual({ relevant: false, ids: [] })
    expect(pluginFileChanges([], 'C:/Data/plugins', plugins).ids).toEqual(['different-id', 'global'])
  })
})
