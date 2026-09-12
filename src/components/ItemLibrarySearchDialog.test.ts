import { createApp, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ItemLibrarySearchDialog from './ItemLibrarySearchDialog.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Workspace } from '@/types'

const mocks = vi.hoisted(() => ({
  searchItemLibrary: vi.fn(),
  itemLibraryKeys: vi.fn(),
  onWorkspaceFilesChanged: vi.fn(),
  sendItemToPlayer: vi.fn(),
  sendItemToNamedPlayer: vi.fn(),
  onlinePlayers: vi.fn(),
  readFile: vi.fn(),
  saveSettings: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('@/lib/tauri', () => ({
  backend: {
    searchItemLibrary: mocks.searchItemLibrary,
    itemLibraryKeys: mocks.itemLibraryKeys,
    sendItemToPlayer: mocks.sendItemToPlayer,
    sendItemToNamedPlayer: mocks.sendItemToNamedPlayer,
    onlinePlayers: mocks.onlinePlayers,
    readFile: mocks.readFile,
    saveSettings: mocks.saveSettings,
    writeFile: mocks.writeFile,
  },
  isTauri: () => false,
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
  onWorkspaceFilesChanged: mocks.onWorkspaceFilesChanged,
}))

vi.mock('@/lib/monaco', () => ({
  getMonaco: vi.fn(),
}))

function workspace(rootPath: string): Workspace {
  return {
    id: rootPath,
    name: rootPath.split('/').pop() ?? rootPath,
    displayName: rootPath.split('/').pop() ?? rootPath,
    rootPath,
    openedAt: '2026-07-05T00:00:00Z',
  }
}

function searchItem(index: number) {
  return {
    source: 'ni',
    itemKey: `item_${index}`,
    displayName: `&a物品${index}`,
    materialOrId: 'STONE',
    filePath: `D:/Project/NeigeItems/Items/items-${index}.yml`,
    relativePath: `items-${index}.yml`,
    lineNumber: index,
    yamlBlock: `item_${index}:\n  name: '&a物品${index}'`,
    libraryRootPath: 'D:/Project/NeigeItems/Items',
  }
}

function mountDialog(pinia: Pinia) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({
    render: () => h(ItemLibrarySearchDialog),
  }))
  app.use(pinia)
  app.mount(root)
  return { app, root }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

describe('ItemLibrarySearchDialog', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    mocks.searchItemLibrary.mockReset()
    mocks.itemLibraryKeys.mockReset()
    mocks.onWorkspaceFilesChanged.mockReset()
    mocks.sendItemToPlayer.mockReset()
    mocks.sendItemToNamedPlayer.mockReset()
    mocks.onlinePlayers.mockReset()
    mocks.readFile.mockReset()
    mocks.saveSettings.mockReset()
    mocks.writeFile.mockReset()
    mocks.saveSettings.mockImplementation(async (settings) => settings)
    mocks.sendItemToPlayer.mockResolvedValue({
      playerName: 'NO_mc',
      itemKey: 'goblin_helmet',
      amount: 1,
      command: 'ni give NO_mc goblin_helmet 1',
      output: 'ok',
    })
    mocks.sendItemToNamedPlayer.mockResolvedValue({
      playerName: 'Alice',
      itemKey: 'goblin_helmet',
      amount: 1,
      command: 'ni give Alice goblin_helmet 1',
      output: 'ok',
    })
    mocks.onlinePlayers.mockResolvedValue({ players: ['Alice', 'Bob'], output: 'There are 2 of a max of 20 players online: Alice, Bob' })
    mocks.readFile.mockResolvedValue("goblin_helmet:\n  name: '&a哥布林头盔'\n")
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.searchItemLibrary.mockResolvedValue({
      source: 'ni',
      libraryRootPath: 'D:/Project/NeigeItems/Items',
      ignoredPathCount: 0,
      ignoreConfigPath: null,
      items: [{
        source: 'ni',
        itemKey: 'goblin_helmet',
        displayName: '&a哥布林头盔',
        materialOrId: 'IRON_HELMET',
        filePath: 'D:/Project/NeigeItems/Items/items.yml',
        relativePath: 'items.yml',
        lineNumber: 42,
        yamlBlock: "goblin_helmet:\n  name: '&a哥布林头盔'",
        libraryRootPath: 'D:/Project/NeigeItems/Items',
      }],
    })
    mocks.itemLibraryKeys.mockResolvedValue({
      source: 'ni',
      libraryRootPath: 'D:/Project/NeigeItems/Items',
      itemKeys: ['goblin_helmet'],
    })
    mocks.onWorkspaceFilesChanged.mockResolvedValue(() => {})
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  it('opens with NI search by default and switches MM with a fresh search', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    expect(mocks.searchItemLibrary).toHaveBeenCalledWith('D:/Project', 'ni', '', undefined, undefined, 1, 9, true)
    expect(root.querySelector('[data-testid="item-source-ni"]')?.textContent).toContain('NeigeItems')
    expect(root.querySelector('[data-testid="item-source-mm"]')?.textContent).toContain('MythicMobs')
    const subtitle = root.querySelector('[data-testid="item-search-status"]')
    expect(subtitle?.textContent).toBe('NeigeItems · 1 项')
    expect(subtitle?.textContent).not.toContain('D:/Project')
    expect(subtitle?.getAttribute('title')).toContain('D:/Project')
    expect(root.querySelector('.panel-title')).toBeNull()
    expect(root.querySelector('[data-testid="item-search-footer-status"]')).toBeNull()
    expect(root.querySelector('[data-testid="item-expand-panel"]')).not.toBeNull()
    expect(root.querySelectorAll('[data-testid="item-expand-row"]')).toHaveLength(1)
    const panelName = root.querySelector('.item-expand-name') as HTMLElement
    expect(panelName.textContent).toBe('哥布林头盔')
    expect(panelName.getAttribute('title')).toBe('哥布林头盔')
    expect(panelName.querySelector('span')?.getAttribute('style')).toContain('rgb(85, 255, 85)')

    const mmButton = root.querySelector('[data-testid="item-source-mm"]') as HTMLButtonElement
    mmButton.click()
    await flushPromises()
    await nextTick()

    expect(mocks.searchItemLibrary).toHaveBeenLastCalledWith('D:/Project', 'mm', '', undefined, undefined, 1, 9, true)
    app.unmount()
  })

  it('completes the search input from the latest real item keys on Tab', async () => {
    mocks.itemLibraryKeys.mockResolvedValue({
      source: 'ni',
      libraryRootPath: 'D:/Project/NeigeItems/Items',
      itemKeys: ['goblin_helmet', 'goblin_sword'],
    })
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    const input = root.querySelector('.item-search-input') as HTMLInputElement
    input.value = 'gob'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await nextTick()

    expect(input.value).toBe('goblin_helmet')
    app.unmount()
  })

  it('uses the configured default while keeping both detected sources available', async () => {
    mocks.readFile.mockImplementation(async (path: string) => (
      path.endsWith('.superhigh/item-library.json')
        ? '{"version":1,"mainSource":"mm"}'
        : "goblin_helmet:\n  name: '&a哥布林头盔'\n"
    ))
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    expect(mocks.searchItemLibrary).toHaveBeenCalledWith('D:/Project', 'mm', '', undefined, undefined, 1, 9, true)
    expect(root.querySelector('[data-testid="item-source-ni"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="item-source-mm"]')).not.toBeNull()
    app.unmount()
  })

  it('reopens the dialog with cached results instead of refetching the same NI library', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()
    expect(mocks.searchItemLibrary).toHaveBeenCalledTimes(1)

    store.setItemSearchDialogOpen(false)
    await nextTick()
    expect(root.querySelector('.item-search-dialog')).toBeNull()

    store.setItemSearchDialogOpen(true)
    await flushPromises()
    await nextTick()

    expect(mocks.searchItemLibrary).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-testid="item-search-status"]')?.textContent).toBe('NeigeItems · 1 项')
    app.unmount()
  })

  it('copies the absolute path and line number for a result', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    const copyButton = root.querySelector('[data-testid="item-copy-location"]') as HTMLButtonElement
    copyButton.click()
    await flushPromises()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('D:/Project/NeigeItems/Items/items.yml:42')
    app.unmount()
  })

  it('renders yaml as highlighted rows without repeating item key display material or location metadata outside the yaml block', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    const card = root.querySelector('.item-result-card') as HTMLElement
    const yamlText = card.querySelector('[data-testid="item-yaml-highlight"]')?.textContent ?? ''
    const expandRow = root.querySelector('[data-testid="item-expand-row"]') as HTMLElement

    expect(card.querySelector('.item-result-actions')).toBeNull()
    expect(card.querySelector('.item-result-meta')).toBeNull()
    expect(expandRow?.textContent).toContain('goblin_helmet')
    expect(expandRow?.querySelector('[data-testid="item-expand-actions"]')).not.toBeNull()
    expect(card.querySelector('[data-testid="item-yaml-preview"]')).toBeNull()
    expect(yamlText).toContain('goblin_helmet')
    expect(root.querySelector('.item-yaml-token.key')?.textContent).toContain('goblin_helmet')
    app.unmount()
  })

  it('uses one editable yaml surface with syntax and color highlighting', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    const surface = root.querySelector('[data-testid="item-yaml-editor-surface"]') as HTMLElement
    const highlight = root.querySelector('[data-testid="item-yaml-highlight"]') as HTMLElement
    const editor = root.querySelector('[data-testid="item-yaml-editor"]') as HTMLTextAreaElement
    const colored = Array.from(highlight.querySelectorAll<HTMLElement>('.item-yaml-token'))
      .find((segment) => segment.textContent?.includes('&a哥布林头盔'))

    expect(surface.contains(editor)).toBe(true)
    expect(surface.contains(highlight)).toBe(true)
    expect(root.querySelector('[data-testid="item-yaml-preview"]')).toBeNull()
    expect(highlight.getAttribute('aria-hidden')).toBe('true')
    expect(highlight.textContent).toContain('goblin_helmet')
    expect(editor.value).toContain("goblin_helmet:\n  name: '&a哥布林头盔'")
    expect(editor.getAttribute('style')).toBeNull()
    expect(colored?.style.color).toBe('rgb(85, 255, 85)')
    app.unmount()
  })

  it('sends a NI item to the configured player through the backend', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    const messageSpy = vi.spyOn(store, 'showActivityMessage')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    const sendButton = root.querySelector('[data-testid="item-send-to-player"]') as HTMLButtonElement
    expect(sendButton).not.toBeNull()
    expect(sendButton.disabled).toBe(false)
    sendButton.click()
    await flushPromises()

    expect(mocks.sendItemToPlayer).toHaveBeenCalledWith('D:/Project', 'goblin_helmet', 1)
    expect(messageSpy).toHaveBeenCalledWith('已发送给 NO_mc：goblin_helmet')
    app.unmount()
    messageSpy.mockRestore()
  })

  it('allows the administrator send amount to be changed without changing the one-click default', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    const optionsButton = root.querySelector('[data-testid="item-send-admin-options"]') as HTMLButtonElement
    optionsButton.click()
    await nextTick()

    const amountInput = root.querySelector('[data-testid="item-send-amount"]') as HTMLInputElement
    amountInput.value = '3'
    amountInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;(root.querySelector('[data-testid="item-send-panel-submit"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(mocks.sendItemToPlayer).toHaveBeenCalledWith('D:/Project', 'goblin_helmet', 3)
    app.unmount()
  })

  it('loads a fresh RCON player list before sending an item to a selected online player', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    ;(root.querySelector('[data-testid="item-send-to-online-player"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(mocks.onlinePlayers).toHaveBeenCalledWith('D:/Project')
    ;(root.querySelector('[data-testid="item-online-player-Alice"]') as HTMLButtonElement).click()
    const amountInput = root.querySelector('[data-testid="item-send-amount"]') as HTMLInputElement
    amountInput.value = '2'
    amountInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;(root.querySelector('[data-testid="item-send-panel-submit"]') as HTMLButtonElement).click()
    await flushPromises()

    expect(mocks.sendItemToNamedPlayer).toHaveBeenCalledWith('D:/Project', 'goblin_helmet', 'Alice', 2)
    app.unmount()
  })

  it('requests only the selected result page as a fixed three-by-three grid', async () => {
    mocks.searchItemLibrary
      .mockResolvedValueOnce({
      source: 'ni',
      libraryRootPath: 'D:/Project/NeigeItems/Items',
      totalItems: 10,
      page: 1,
      pageSize: 9,
      items: Array.from({ length: 9 }, (_, index) => searchItem(index + 1)),
      })
      .mockResolvedValueOnce({
        source: 'ni',
        libraryRootPath: 'D:/Project/NeigeItems/Items',
        totalItems: 10,
        page: 2,
        pageSize: 9,
        items: [searchItem(10)],
      })
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    expect(root.querySelectorAll('.item-result-card')).toHaveLength(9)
    expect(root.querySelector('[data-testid="item-page-status"]')?.textContent).toContain('1 / 2')

    const nextButton = root.querySelector('[data-testid="item-next-page"]') as HTMLButtonElement
    nextButton.click()
    await flushPromises()
    await nextTick()

    const cards = root.querySelectorAll('.item-result-card')
    expect(cards).toHaveLength(1)
    expect((cards[0].querySelector('[data-testid="item-yaml-editor"]') as HTMLTextAreaElement).value).toContain('item_10')
    expect(root.querySelector('[data-testid="item-page-status"]')?.textContent).toContain('2 / 2')
    expect(mocks.searchItemLibrary).toHaveBeenLastCalledWith('D:/Project', 'ni', '', undefined, undefined, 2, 9, false)
    expect(mocks.itemLibraryKeys).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('keeps short yaml editors compact and caps long editors to twenty visible lines', async () => {
    const longYaml = [
      'item_5:',
      "  name: '&a长 Lore 物品'",
      '  lore:',
      ...Array.from({ length: 30 }, (_, index) => `  - '第 ${index + 1} 行 Lore'`),
    ].join('\n')
    mocks.searchItemLibrary.mockResolvedValueOnce({
      source: 'ni',
      libraryRootPath: 'D:/Project/NeigeItems/Items',
      items: Array.from({ length: 9 }, (_, index) => (
        index === 4
          ? { ...searchItem(index + 1), yamlBlock: longYaml }
          : searchItem(index + 1)
      )),
    })
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    const grid = root.querySelector('.item-result-grid') as HTMLElement
    const cards = root.querySelectorAll<HTMLElement>('.item-result-card')
    const shortCard = cards[0]
    const shortEditor = shortCard.querySelector('[data-testid="item-yaml-editor"]') as HTMLTextAreaElement
    const longCard = cards[4]
    const longEditor = longCard.querySelector('[data-testid="item-yaml-editor"]') as HTMLTextAreaElement

    expect(cards).toHaveLength(9)
    expect(grid.getAttribute('style')).toBeNull()
    expect(shortCard.style.getPropertyValue('--item-yaml-line-count')).toBe('2')
    expect(shortCard.style.getPropertyValue('--item-yaml-visible-line-count')).toBe('2')
    expect(shortEditor.rows).toBe(2)
    expect(longCard.style.getPropertyValue('--item-yaml-line-count')).toBe('33')
    expect(longCard.style.getPropertyValue('--item-yaml-visible-line-count')).toBe('20')
    expect(longEditor.rows).toBe(20)
    expect(longEditor.getAttribute('wrap')).toBe('off')
    expect(root.querySelectorAll('[data-testid="item-expand-row"]')).toHaveLength(9)
    expect(root.querySelector('[data-testid="item-page-controls"]')).not.toBeNull()
    app.unmount()
  })

  it('jumps to the item file and line inside Super High', async () => {
    vi.useFakeTimers()
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    const openFileSpy = vi.spyOn(store, 'openFile').mockResolvedValue(true)
    let app: ReturnType<typeof createApp> | null = null
    try {
      store.workspace = workspace('D:/Project')
      store.settings.activePreviewMode = 'local_terminal'
      store.activeWorkspaceSurface = 'docs'
      store.setItemSearchDialogOpen(true)
      const mounted = mountDialog(pinia)
      app = mounted.app
      const { root } = mounted

      await flushPromises()
      await nextTick()

      const jumpButton = root.querySelector('[data-testid="item-jump-location"]') as HTMLButtonElement
      jumpButton.click()
      await flushPromises()

      expect(store.activeWorkspaceSurface).toBe('project')
      expect(store.settings.activePreviewMode).toBe('code')
      expect(openFileSpy).toHaveBeenCalledWith('D:/Project/NeigeItems/Items/items.yml')
      expect(store.itemSearchDialogOpen).toBe(true)

      await vi.advanceTimersByTimeAsync(110)
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'superhigh:reveal-editor-position',
        detail: {
          path: 'D:/Project/NeigeItems/Items/items.yml',
          lineNumber: 42,
          column: 1,
        },
      }))
    } finally {
      app?.unmount()
      openFileSpy.mockRestore()
      dispatchSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('refreshes search results from the latest backend item payload', async () => {
    mocks.searchItemLibrary
      .mockResolvedValueOnce({
        source: 'ni',
        libraryRootPath: 'D:/Project/NeigeItems/Items',
        items: [searchItem(1)],
      })
      .mockResolvedValueOnce({
        source: 'ni',
        libraryRootPath: 'D:/Project/NeigeItems/Items',
        items: [{
          ...searchItem(1),
          yamlBlock: "item_1:\n  name: '&b外部更新'",
        }],
      })
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()
    expect((root.querySelector('[data-testid="item-yaml-editor"]') as HTMLTextAreaElement).value).toContain('&a物品1')

    const refreshButton = root.querySelector('[data-testid="item-search-refresh"]') as HTMLButtonElement
    refreshButton.click()
    await flushPromises()
    await nextTick()

    expect((root.querySelector('[data-testid="item-yaml-editor"]') as HTMLTextAreaElement).value).toContain('&b外部更新')
    app.unmount()
  })

  it('reverts an edited item yaml draft without saving', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    const editor = root.querySelector('[data-testid="item-yaml-editor"]') as HTMLTextAreaElement
    editor.value = "goblin_helmet:\n  name: '&c临时改动'"
    editor.dispatchEvent(new Event('input'))
    await nextTick()

    const revertButton = root.querySelector('[data-testid="item-revert-yaml"]') as HTMLButtonElement
    expect(revertButton.disabled).toBe(false)
    revertButton.click()
    await nextTick()

    expect(editor.value).toBe("goblin_helmet:\n  name: '&a哥布林头盔'")
    expect(mocks.writeFile).not.toHaveBeenCalled()
    app.unmount()
  })

  it('saves an edited item by merging into the latest file content and refreshing', async () => {
    mocks.searchItemLibrary
      .mockResolvedValueOnce({
        source: 'ni',
        libraryRootPath: 'D:/Project/NeigeItems/Items',
        items: [{
          source: 'ni',
          itemKey: 'goblin_helmet',
          displayName: '&a哥布林头盔',
          materialOrId: 'IRON_HELMET',
          filePath: 'D:/Project/NeigeItems/Items/items.yml',
          relativePath: 'items.yml',
          lineNumber: 4,
          yamlBlock: "goblin_helmet:\n  name: '&a哥布林头盔'\n  material: IRON_HELMET",
          libraryRootPath: 'D:/Project/NeigeItems/Items',
        }],
      })
      .mockResolvedValueOnce({
        source: 'ni',
        libraryRootPath: 'D:/Project/NeigeItems/Items',
        items: [{
          source: 'ni',
          itemKey: 'goblin_helmet',
          displayName: '&b新头盔',
          materialOrId: 'DIAMOND_HELMET',
          filePath: 'D:/Project/NeigeItems/Items/items.yml',
          relativePath: 'items.yml',
          lineNumber: 4,
          yamlBlock: "goblin_helmet:\n  name: '&b新头盔'\n  material: DIAMOND_HELMET",
          libraryRootPath: 'D:/Project/NeigeItems/Items',
        }],
      })
    mocks.readFile.mockResolvedValue([
      'external_item:',
      "  name: '外部新增'",
      '',
      'goblin_helmet:',
      "  name: '&a哥布林头盔'",
      '  material: IRON_HELMET',
      '',
      'wolf_pelt:',
      "  name: '狼皮'",
      '  material: LEATHER',
      '',
    ].join('\n'))
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    const editor = root.querySelector('[data-testid="item-yaml-editor"]') as HTMLTextAreaElement
    editor.value = "goblin_helmet:\n  name: '&b新头盔'\n  material: DIAMOND_HELMET"
    editor.dispatchEvent(new Event('input'))
    await nextTick()

    const saveButton = root.querySelector('[data-testid="item-save-yaml"]') as HTMLButtonElement
    saveButton.click()
    await flushPromises()
    await nextTick()

    expect(mocks.readFile).toHaveBeenCalledWith('D:/Project/NeigeItems/Items/items.yml')
    expect(mocks.writeFile).toHaveBeenCalledTimes(1)
    const [savedPath, savedContent] = mocks.writeFile.mock.calls[0]
    expect(savedPath).toBe('D:/Project/NeigeItems/Items/items.yml')
    expect(savedContent).toContain("external_item:\n  name: '外部新增'")
    expect(savedContent).toContain("goblin_helmet:\n  name: '&b新头盔'\n  material: DIAMOND_HELMET")
    expect(savedContent).toContain("wolf_pelt:\n  name: '狼皮'\n  material: LEATHER")
    expect(savedContent).not.toBe(editor.value)
    expect(mocks.searchItemLibrary).toHaveBeenCalledTimes(2)
    expect((root.querySelector('[data-testid="item-yaml-editor"]') as HTMLTextAreaElement).value).toContain('&b新头盔')
    app.unmount()
  })

  it('renders DragonCore ItemIcon and ItemEffect images only when the result has payloads', async () => {
    mocks.searchItemLibrary.mockResolvedValueOnce({
      source: 'ni',
      libraryRootPath: 'D:/Project/NeigeItems/Items',
      items: [
        {
          source: 'ni',
          itemKey: 'goblin_blade',
          displayName: '&a哥布林太刀',
          materialOrId: 'IRON_SWORD',
          filePath: 'D:/Project/NeigeItems/Items/items.yml',
          relativePath: 'items.yml',
          lineNumber: 12,
          yamlBlock: "goblin_blade:\n  name: '&a哥布林太刀'",
          libraryRootPath: 'D:/Project/NeigeItems/Items',
          dragonCoreIcon: {
            dataUrl: 'data:image/png;base64,AA==',
            texture: 'zhuangbei/gblwq1.png',
            imagePath: 'D:/Client/resourcepacks/DragonCore/zhuangbei/gblwq1.png',
            configPath: 'D:/Project/DragonCore/ItemIcon/装备.yml',
            relativeConfigPath: '装备.yml',
            lineNumber: 180,
          },
          dragonCoreEffect: {
            dataUrl: 'data:image/png;base64,BB==',
            texture: 'gui/beibao/itemtip/pinzhi4.png',
            imagePath: 'D:/Client/resourcepacks/DragonCore/gui/beibao/itemtip/pinzhi4.png',
            configPath: 'D:/Project/DragonCore/ItemEffect.yml',
            relativeConfigPath: 'ItemEffect.yml',
            lineNumber: 12,
            matchText: '品质=§#8f28b5非凡',
          },
        },
        {
          source: 'ni',
          itemKey: 'plain_boots',
          displayName: '旅人靴',
          materialOrId: 'LEATHER_BOOTS',
          filePath: 'D:/Project/NeigeItems/Items/items.yml',
          relativePath: 'items.yml',
          lineNumber: 20,
          yamlBlock: "plain_boots:\n  name: '旅人靴'",
          libraryRootPath: 'D:/Project/NeigeItems/Items',
        },
      ],
    })
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    ;(store.settings as any).dragonCoreClientRootPath = 'D:/Client'
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    expect(root.querySelectorAll('.item-result-card .item-dragoncore-icon')).toHaveLength(0)
    expect(root.querySelectorAll('.item-result-card .item-dragoncore-effect')).toHaveLength(0)

    const icons = root.querySelectorAll('[data-testid="item-expand-icon"]')
    const effects = root.querySelectorAll('[data-testid="item-expand-effect"]')
    expect(icons).toHaveLength(1)
    expect(effects).toHaveLength(1)
    expect((icons[0] as HTMLImageElement).src).toBe('data:image/png;base64,AA==')
    expect((effects[0] as HTMLImageElement).src).toBe('data:image/png;base64,BB==')
    expect(mocks.searchItemLibrary).toHaveBeenCalledWith('D:/Project', 'ni', '', undefined, 'D:/Client', 1, 9, true)
    app.unmount()
  })

  it('toggles DragonCore font image rendering inside the yaml code preview', async () => {
    mocks.searchItemLibrary.mockResolvedValueOnce({
      source: 'ni',
      libraryRootPath: 'D:/Project/NeigeItems/Items',
      items: [{
        source: 'ni',
        itemKey: 'tide_title',
        displayName: '§汐秘境',
        materialOrId: 'PAPER',
        filePath: 'D:/Project/NeigeItems/Items/title.yml',
        relativePath: 'title.yml',
        lineNumber: 8,
        yamlBlock: "tide_title:\n  name: '§汐秘境'",
        libraryRootPath: 'D:/Project/NeigeItems/Items',
        dragonCoreFontImages: [{
          character: '汐',
          dataUrl: 'data:image/gif;base64,AA==',
          path: 'title/潮汐.gif',
          imagePath: 'D:/Client/resourcepacks/DragonCore/title/潮汐.gif',
          configPath: 'D:/Project/DragonCore/FontConfig.yml',
          relativeConfigPath: 'FontConfig.yml',
          lineNumber: 1,
          width: 38,
          height: 9,
          yOffset: 0,
          color: true,
          fontWidth: 2,
        }],
      }],
    })
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    ;(store.settings as any).dragonCoreClientRootPath = 'D:/Client/resourcepacks/DragonCore'
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    expect(root.querySelector('[data-testid="item-font-image"]')).toBeNull()

    const fontButton = root.querySelector('[data-testid="item-font-render-button"]') as HTMLButtonElement
    fontButton.click()
    await nextTick()

    const image = root.querySelector('[data-testid="item-font-image"]') as HTMLImageElement
    expect(image).not.toBeNull()
    expect(image.src).toBe('data:image/gif;base64,AA==')
    expect(image.alt).toBe('汐')
    app.unmount()
  })

  it('saves the DragonCore client source path from the dialog', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    const dragonCoreButton = root.querySelector('[data-testid="item-dragoncore-button"]') as HTMLButtonElement
    dragonCoreButton.click()
    await nextTick()

    const pathInput = root.querySelector('[data-testid="item-dragoncore-path"]') as HTMLInputElement
    pathInput.value = 'D:/Client/resourcepacks/DragonCore'
    pathInput.dispatchEvent(new Event('input'))
    const saveButton = root.querySelector('[data-testid="item-dragoncore-save"]') as HTMLButtonElement
    saveButton.click()
    await flushPromises()

    const status = root.querySelector('[data-testid="item-dragoncore-status"]')
    expect(status?.textContent).toContain('已配置 DragonCore 资源包')
    expect(status?.textContent).not.toContain('D:/Client/resourcepacks/DragonCore')
    expect(status?.getAttribute('title')).toBe('D:/Client/resourcepacks/DragonCore')
    expect(mocks.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      dragonCoreClientRootPath: 'D:/Client/resourcepacks/DragonCore',
    }))
    app.unmount()
  })

  it('shows phrase edit history in the phrase panel', async () => {
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.settings.itemSearchPhrases = [{
      id: 'phrase-1',
      phrase: '2c',
      value: '樱骸',
      createdAt: '2026-07-05T00:00:00Z',
      updatedAt: '2026-07-05T00:00:01Z',
      history: [{
        id: 'history-1',
        action: 'updated',
        phrase: '2c',
        value: '樱骸',
        previousPhrase: '1c',
        previousValue: '哥布林',
        createdAt: '2026-07-05T00:00:01Z',
      }],
    }]
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    const phraseButton = root.querySelector('.item-phrase-button') as HTMLButtonElement
    phraseButton.click()
    await nextTick()

    expect(root.textContent).toContain('历史')
    expect(root.textContent).toContain('1c → 哥布林')
    expect(root.textContent).toContain('2c → 樱骸')
    app.unmount()
  })

  it('shows ignored path count in header status when backend reports blocked files', async () => {
    mocks.searchItemLibrary.mockResolvedValue({
      source: 'ni',
      libraryRootPath: 'D:/Project/NeigeItems/Items',
      ignoredPathCount: 3,
      ignoreConfigPath: 'D:/Project/.superhigh/item-library-ignore.yml',
      items: [{
        source: 'ni',
        itemKey: 'goblin_helmet',
        displayName: '&a哥布林头盔',
        materialOrId: 'IRON_HELMET',
        filePath: 'D:/Project/NeigeItems/Items/items.yml',
        relativePath: 'items.yml',
        lineNumber: 42,
        yamlBlock: "goblin_helmet:\n  name: '&a哥布林头盔'",
        libraryRootPath: 'D:/Project/NeigeItems/Items',
      }],
    })
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)
    await flushPromises()
    const status = root.querySelector('[data-testid="item-search-status"]')
    expect(status?.textContent).toContain('1 项')
    expect(status?.textContent).toContain('已屏蔽 3 个路径')
    expect(status?.textContent).not.toContain('D:/Project')
    expect(status?.getAttribute('title')).toContain('物品库：D:/Project/NeigeItems/Items')
    expect(status?.getAttribute('title')).toContain('.superhigh/item-library-ignore.yml')
    expect(root.querySelector('[data-testid="item-search-footer-status"]')).toBeNull()
    app.unmount()
    root.remove()
  })

  it('supports keyboard left and right paging outside editable fields', async () => {
    mocks.searchItemLibrary
      .mockResolvedValueOnce({
      source: 'ni',
      libraryRootPath: 'D:/Project/NeigeItems/Items',
      totalItems: 10,
      page: 1,
      pageSize: 9,
      items: Array.from({ length: 9 }, (_, index) => searchItem(index + 1)),
      })
      .mockResolvedValueOnce({
        source: 'ni',
        libraryRootPath: 'D:/Project/NeigeItems/Items',
        totalItems: 10,
        page: 2,
        pageSize: 9,
        items: [searchItem(10)],
      })
      .mockResolvedValueOnce({
        source: 'ni',
        libraryRootPath: 'D:/Project/NeigeItems/Items',
        totalItems: 10,
        page: 1,
        pageSize: 9,
        items: Array.from({ length: 9 }, (_, index) => searchItem(index + 1)),
      })
      .mockResolvedValueOnce({
        source: 'ni',
        libraryRootPath: 'D:/Project/NeigeItems/Items',
        totalItems: 10,
        page: 2,
        pageSize: 9,
        items: [searchItem(10)],
      })
    const store = useWorkspaceStore()
    store.minecraftCapabilities = { itemSources: ['ni', 'mm'], monsterLibrary: true, dragonCore: true }
    store.workspace = workspace('D:/Project')
    store.setItemSearchDialogOpen(true)
    const { app, root } = mountDialog(pinia)

    await flushPromises()
    await nextTick()

    expect(root.querySelector('[data-testid="item-page-status"]')?.textContent).toContain('1 / 2')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flushPromises()
    await nextTick()
    expect(root.querySelector('[data-testid="item-page-status"]')?.textContent).toContain('2 / 2')
    expect(root.querySelectorAll('.item-result-card')).toHaveLength(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await flushPromises()
    await nextTick()
    expect(root.querySelector('[data-testid="item-page-status"]')?.textContent).toContain('1 / 2')
    expect(root.querySelectorAll('.item-result-card')).toHaveLength(9)

    const nextButton = root.querySelector('[data-testid="item-next-page"]') as HTMLButtonElement
    nextButton.click()
    await flushPromises()
    await nextTick()
    expect(root.querySelector('[data-testid="item-page-status"]')?.textContent).toContain('2 / 2')
    expect(root.querySelector('[data-testid="item-page-jump-input"]')).not.toBeNull()

    app.unmount()
  })
})
