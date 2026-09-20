import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesPath = resolve(process.cwd(), 'src/styles.css')
const breadcrumbNodePath = resolve(process.cwd(), 'src/components/BreadcrumbFileTreeNode.vue')
const styles = readFileSync(stylesPath, 'utf8')
const breadcrumbNode = readFileSync(breadcrumbNodePath, 'utf8')

describe('code preview chrome styles', () => {
  it('keeps project image previews pixel-perfect and uncropped', () => {
    const imageBlock = cssBlock('img {\n')
    const thumbnailBlock = cssBlock('.file-manager-entry-icon img {\n')
    const cliThumbnailBlock = cssBlock('.cli-image-thumb {\n')

    expect(imageBlock).toContain('image-rendering: pixelated;')
    expect(thumbnailBlock).toContain('object-fit: contain;')
    expect(cliThumbnailBlock).toContain('object-fit: contain;')
  })

  it('locks the file manager grid to five columns while keeping the pane split', () => {
    const gridBlock = cssBlock('.file-manager-grid {\n')
    const contentBlock = cssBlock('.file-manager-content')

    expect(gridBlock).toContain('grid-template-columns: repeat(5, minmax(0, 1fr));')
    expect(gridBlock).toContain('gap: 7px;')
    expect(contentBlock).toContain('grid-template-columns: minmax(320px, 0.85fr) minmax(380px, 1.15fr);')
  })

  it('keeps Monaco selection overrides on theme accent colors', () => {
    expect(styles).toContain('.monaco-host .monaco-editor ::selection')
    expect(styles).toContain('.monaco-host .monaco-editor .focused .selected-text')
    expect(styles).toContain('background: var(--surface-accent-blue-strong);')
    expect(styles).toContain('background-color: var(--surface-accent-blue-strong) !important;')
    expect(styles).toContain('background-color: var(--surface-accent-blue-fade) !important;')
  })

  it('uses theme accent colors for the add-selection button active states', () => {
    const buttonBlock = cssBlock('.add-selection-button:hover,')

    expect(buttonBlock).toContain('.add-selection-button:active')
    expect(buttonBlock).toContain('.add-selection-button:focus-visible')
    expect(buttonBlock).toContain('border-color: var(--surface-accent-blue-border);')
    expect(buttonBlock).toContain('color: var(--color-accent-blue);')
    expect(buttonBlock).toContain('background: var(--surface-accent-blue-soft);')
    expect(buttonBlock).not.toContain('0 0 0 2px')
    expect(buttonBlock).not.toContain('var(--color-accent-red)')
    expect(buttonBlock).not.toContain('var(--surface-danger')
  })

  it('keeps framed CLI TUI scrollbars stable for resize-sensitive renderers', () => {
    const viewportBlock = cssBlock('.terminal-host.framed-terminal-host .xterm-viewport')

    expect(viewportBlock).toContain('overflow-y: scroll !important;')
    expect(viewportBlock).toContain('scrollbar-gutter: stable;')
    expect(viewportBlock).toContain('scrollbar-color: var(--color-text-muted) var(--color-bg-primary);')
  })

  it('uses single-line workspace dividers with an expanded resize hit target', () => {
    const resizerBlock = cssBlock('.workspace-resizer')
    const hitTargetBlock = cssBlock('.workspace-resizer::before')

    expect(resizerBlock).toContain('min-width: 1px;')
    expect(resizerBlock).toContain('background: var(--surface-divider-muted);')
    expect(resizerBlock).not.toContain('border-left:')
    expect(resizerBlock).not.toContain('border-right:')
    expect(hitTargetBlock).toContain('inset: 0 -4px;')
  })

  it('uses theme tokens for yaml key value preview decorations', () => {
    const keyBlock = cssBlock('.monaco-host .monaco-editor .yaml-preview-key')
    const separatorBlock = cssBlock('.monaco-host .monaco-editor .yaml-preview-separator')
    const valueBlock = cssBlock('.monaco-host .monaco-editor .yaml-preview-value')
    const stringBlock = cssBlock('.monaco-host .monaco-editor .yaml-preview-string')
    const numberBlock = cssBlock('.monaco-host .monaco-editor .yaml-preview-number')
    const literalBlock = cssBlock('.monaco-host .monaco-editor .yaml-preview-literal')
    const blockMarkerBlock = cssBlock('.monaco-host .monaco-editor .yaml-preview-block-marker')
    const errorBlock = cssBlock('.monaco-host .monaco-editor .yaml-preview-error')

    expect(keyBlock).toContain('color: var(--color-accent-blue) !important;')
    expect(separatorBlock).toContain('color: var(--color-text-muted) !important;')
    expect(valueBlock).toContain('color: var(--color-accent-yellow) !important;')
    expect(stringBlock).toContain('color: var(--color-accent-yellow) !important;')
    expect(numberBlock).toContain('color: var(--color-accent-purple) !important;')
    expect(literalBlock).toContain('color: var(--color-accent-red) !important;')
    expect(blockMarkerBlock).toContain('color: var(--color-accent-purple) !important;')
    expect(errorBlock).toContain('background: var(--surface-danger-soft) !important;')
  })

  it('sizes editor breadcrumb dropdowns to their content with theme scrollbars', () => {
    const dropdownBlock = cssBlock('.breadcrumb-dropdown')

    expect(dropdownBlock).toContain('width: max-content;')
    expect(dropdownBlock).toContain('min-width: 220px;')
    expect(dropdownBlock).toContain('max-width: min(390px, calc(100vw - 24px));')
    expect(dropdownBlock).toContain('background: var(--surface-panel-strong);')
    expect(dropdownBlock).toContain('box-shadow: none;')
    expect(dropdownBlock).toContain('scrollbar-width: thin;')
    expect(dropdownBlock).toContain('scrollbar-color: var(--color-text-muted) transparent;')
  })

  it('keeps breadcrumb picker rows visually consistent with breadcrumb text', () => {
    const pickerRowBlock = cssBlockFrom(breadcrumbNode, '.breadcrumb-picker-row')

    expect(pickerRowBlock).toContain('height: 24px;')
    expect(pickerRowBlock).toContain('font-size: 12px;')
    expect(pickerRowBlock).not.toContain('font-size: 13px;')
    expect(pickerRowBlock).not.toContain('box-shadow:')
  })

  it('removes the bordered icon chrome from the editor tab actions button', () => {
    const tabsMoreBlock = cssBlock('.editor-panel .tabs-more-button')

    expect(tabsMoreBlock).toContain('border: 0;')
    expect(tabsMoreBlock).toContain('background: transparent;')
    expect(tabsMoreBlock).toContain('box-shadow: none;')
  })

  it('keeps explorer disclosure arrows readable without overpowering file rows', () => {
    const disclosureBlock = cssBlock('.tree-disclosure')

    expect(disclosureBlock).toContain('font-size: 13px;')
    expect(disclosureBlock).not.toContain('font-size: 15px;')
  })
})

function cssBlock(selectorStart: string): string {
  return cssBlockFrom(styles, selectorStart)
}

function cssBlockFrom(source: string, selectorStart: string): string {
  source = source.replace(/\r\n/g, '\n')
  const start = source.indexOf(selectorStart)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end + 2)
}
