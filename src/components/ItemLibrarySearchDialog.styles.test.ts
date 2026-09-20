import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const componentPath = resolve(process.cwd(), 'src/components/ItemLibrarySearchDialog.vue')
const componentSource = readFileSync(componentPath, 'utf8')

describe('ItemLibrarySearchDialog styles', () => {
  it('stacks expand ItemIcon above the ItemEffect quality frame', () => {
    const iconBlock = cssBlock('.item-expand-icon {')
    const effectBlock = cssBlock('.item-expand-effect {', 2)

    expect(zIndex(iconBlock)).toBeGreaterThan(zIndex(effectBlock))
  })

  it('keeps paged item results adaptive with capped editor scrolling and a side expand panel', () => {
    const bodyBlock = cssBlock('.item-search-body {')
    const mainBlock = cssBlock('.item-search-main {')
    const gridBlock = cssBlock('.item-result-grid {')
    const cardBlock = cssBlock('.item-result-card {')
    const expandBlock = cssBlock('.item-expand-panel {', 2)
    const expandRowBlock = cssBlock('.item-expand-row {')
    const expandActionsBlock = cssBlock('.item-expand-actions {')
    const actionButtonBlock = cssBlock('.item-expand-actions .icon-button {')
    const surfaceBlock = cssBlock('.item-yaml-editor-surface {')
    const highlightBlock = cssBlock('.item-yaml-highlight {')
    const yamlLineBlock = cssBlock('.item-yaml-line {')
    const editorBlock = cssBlock('.item-yaml-editor {')
    const editorSelectionBlock = cssBlock('.item-yaml-editor::selection {')
    const scrollbarBaseBlock = cssBlock('.item-search-body,')
    const scrollbarSizeBlock = cssBlock('.item-search-body::-webkit-scrollbar,')
    const scrollbarThumbBlock = cssBlock('.item-search-body::-webkit-scrollbar-thumb,')
    const scrollbarButtonBlock = cssBlock('.item-search-body::-webkit-scrollbar-button,')

    expect(mainBlock).toContain('display: flex;')
    expect(mainBlock).toContain('overflow: hidden;')

    expect(bodyBlock).toContain('overflow: auto;')
    expect(bodyBlock).not.toContain('overflow: hidden;')

    expect(gridBlock).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));')
    expect(gridBlock).toContain('grid-auto-rows: max-content;')
    expect(gridBlock).toContain('align-content: start;')
    expect(gridBlock).toContain('overflow: visible;')
    expect(componentSource).not.toContain('const RESULT_ROW_MIN_HEIGHT = 420')
    expect(componentSource).not.toContain(':style="resultGridStyle"')
    expect(componentSource).not.toContain('.item-result-grid {\n    grid-template-columns: repeat(2, minmax(0, 1fr));')
    expect(componentSource).not.toContain('.item-result-grid {\n    grid-template-columns: 1fr;')
    expect(componentSource).toContain('const YAML_EDITOR_MAX_VISIBLE_LINES = 20')
    expect(componentSource).toContain('data-testid="item-expand-panel"')
    expect(componentSource).toContain('data-testid="item-expand-row"')
    expect(componentSource).not.toContain('class="item-result-top"')
    expect(componentSource).not.toContain('data-testid="item-dragoncore-icon"')
    expect(componentSource).not.toContain('data-testid="item-dragoncore-effect"')
    expect(componentSource).toContain('data-testid="item-expand-icon"')
    expect(componentSource).toContain('data-testid="item-expand-effect"')

    expect(cardBlock).toContain('display: flex;')
    expect(cardBlock).toContain('height: auto;')
    expect(cardBlock).toContain('flex-direction: column;')
    expect(cardBlock).toContain('contain: paint;')
    expect(cardBlock).toContain('min-height: 0;')

    expect(expandBlock).toContain('border-left: 1px solid var(--border);')
    expect(expandBlock).toContain('flex-direction: column;')
    expect(expandRowBlock).toContain('flex-direction: column;')
    expect(expandActionsBlock).toContain('gap: 4px;')
    expect(actionButtonBlock).toContain('width: 26px;')
    expect(actionButtonBlock).toContain('height: 26px;')

    expect(surfaceBlock).toContain('flex: 0 0 auto;')
    expect(surfaceBlock).toContain('box-sizing: border-box;')
    expect(surfaceBlock).toContain('contain: paint;')
    expect(surfaceBlock).toContain('min-height: 0;')
    expect(surfaceBlock).toContain('overflow: hidden;')

    expect(highlightBlock).toContain('box-sizing: border-box;')
    expect(highlightBlock).toContain('overflow: hidden;')

    expect(yamlLineBlock).toContain('width: max-content;')
    expect(yamlLineBlock).toContain('white-space: pre;')
    expect(yamlLineBlock).toContain('overflow-wrap: normal;')
    expect(yamlLineBlock).not.toContain('white-space: pre-wrap;')

    expect(componentSource).toContain('wrap="off"')
    expect(componentSource).not.toContain('style="color: transparent;"')
    expect(editorBlock).toContain('height: 100%;')
    expect(editorBlock).toContain('box-sizing: border-box;')
    expect(editorBlock).toContain('min-height: 0;')
    expect(editorBlock).toContain('resize: none;')
    expect(editorBlock).toContain('caret-color: var(--color-accent-purple);')
    expect(editorBlock).toContain('overflow: auto;')
    expect(editorBlock).toContain('white-space: pre;')
    expect(editorBlock).toContain('overflow-wrap: normal;')
    expect(editorBlock).not.toContain('overflow: hidden;')
    expect(editorBlock).not.toContain('white-space: pre-wrap;')
    expect(editorBlock).not.toContain('resize: vertical;')

    expect(editorSelectionBlock).toContain('background: var(--color-accent-blue);')
    expect(editorSelectionBlock).toContain('color: var(--color-text-primary);')
    expect(editorSelectionBlock).toContain('-webkit-text-fill-color: var(--color-text-primary);')

    expect(scrollbarBaseBlock).toContain('scrollbar-width: thin;')
    expect(scrollbarBaseBlock).toContain('scrollbar-color: var(--color-text-muted) var(--color-bg-primary);')
    expect(scrollbarSizeBlock).toContain('width: 10px;')
    expect(scrollbarSizeBlock).toContain('height: 10px;')
    expect(scrollbarThumbBlock).toContain('border: 2px solid var(--color-bg-primary);')
    expect(scrollbarThumbBlock).toContain('border-radius: 4px;')
    expect(scrollbarThumbBlock).toContain('background: var(--color-text-muted);')
    expect(scrollbarButtonBlock).toContain('display: none;')
    expect(scrollbarButtonBlock).toContain('width: 0;')
    expect(scrollbarButtonBlock).toContain('height: 0;')
  })
})

function cssBlock(selectorStart: string, occurrence = 1): string {
  let start = -1
  let from = 0
  for (let index = 0; index < occurrence; index += 1) {
    start = componentSource.indexOf(selectorStart, from)
    expect(start).toBeGreaterThanOrEqual(0)
    from = start + selectorStart.length
  }
  const end = componentSource.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  return componentSource.slice(start, end + 2)
}

function zIndex(block: string): number {
  const match = block.match(/z-index:\s*(\d+);/)
  expect(match).not.toBeNull()
  return Number(match?.[1])
}
