import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, type App } from 'vue'
import MarkdownFilePreview from './MarkdownFilePreview.vue'
import { renderMarkdown } from '@/lib/markdown'

let app: App
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
})
afterEach(() => { app?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('Markdown file tables', () => {
  it('groups dense records without losing prose, links, or the expanded table columns', async () => {
    const note = '这里是需要连续阅读的模型检查说明。'.repeat(18)
    const source = `| ID | 标题 | 地址 | 作者 | 状态 | 日期 | 检查说明 |\n|---|---|---|---|---|---|---|\n| 22 | 神殿 | https://example.com/temple | 作者A | 完成 | 2026-09-20 | ${note} |`
    const host = document.createElement('div')
    document.body.append(host)
    app = createApp(MarkdownFilePreview, { html: renderMarkdown(source) })
    app.mount(host)
    expect(host.querySelector('.md-record-table')).not.toBeNull()
    expect(host.querySelectorAll('.md-field-label')).toHaveLength(7)
    expect(host.querySelector('.md-field-wide .md-field-value')?.textContent).toBe(note)
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com/temple')
    host.querySelector<HTMLButtonElement>('.md-table-expand')!.click()
    await nextTick()
    const dialog = document.querySelector('dialog')!
    expect(dialog.querySelectorAll('thead th')).toHaveLength(7)
    expect(dialog.querySelectorAll('tbody td')).toHaveLength(7)
    expect(dialog.querySelectorAll('.md-field-label')).toHaveLength(0)
    expect(dialog.querySelector('tbody')?.textContent).toContain(note)
  })
  it('keeps full link targets and labels, searches hidden URL paths, and restores the document after closing', async () => {
    const href = 'https://example.com/models/windmill'
    const html = renderMarkdown(`| ID | 标题 | 链接 |\n|---|---|---|\n| 1 | 风车 | ${href} |\n| 2 | 小屋 | [作品主页](https://example.com/cabin) |`)
    const props = reactive({ html })
    const host = document.createElement('div')
    document.body.append(host)
    app = createApp(MarkdownFilePreview, props)
    app.mount(host)
    const links = host.querySelectorAll('a')
    expect(links[0].textContent).toBe('example.com ↗')
    expect(links[0].getAttribute('href')).toBe(href)
    expect(links[0].title).toBe(href)
    expect(links[1].textContent).toBe('作品主页')
    const expand = host.querySelector<HTMLButtonElement>('.md-table-expand')!
    expand.click()
    await nextTick()
    const dialog = document.querySelector('dialog')!
    expect(dialog.open).toBe(true)
    const search = dialog.querySelector('input')!
    search.value = 'windmill'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    expect(dialog.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(dialog.querySelector('tbody')!.textContent).toContain('风车')
    search.value = 'missing'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    expect(dialog.querySelector('.md-table-empty')).not.toBeNull()
    dialog.querySelector<HTMLButtonElement>('.md-table-toolbar button')!.click()
    expect(dialog.open).toBe(false)
    expect(document.activeElement).toBe(expand)
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(props.html).toBe(html)
  })
})
