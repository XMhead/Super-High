import { createApp, defineComponent, h, nextTick, onMounted, onUnmounted } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import EditorWindowApp from './EditorWindowApp.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { backend } from '@/lib/tauri'
import type { EditorUiSnapshot } from '@/lib/editorWindowUi'

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
vi.mock('@/lib/tauri', () => ({ isTauri: () => false, onWorkspaceFilesChanged: vi.fn(async () => () => undefined), backend: {
  readFile: vi.fn(async () => '<main>Editor</main>'), writeFile: vi.fn(async () => undefined), saveSettings: vi.fn(),
} }))
vi.mock('@/lib/monaco', () => ({ getMonaco: vi.fn() }))
vi.mock('./SuperhighHtmlPreview.vue', () => ({ default: defineComponent({
  props: ['tab', 'parameters'],
  setup(props) {
    onMounted(() => lifecycle.mounts++)
    onUnmounted(() => lifecycle.unmounts++)
    return () => h('div', { 'data-page': props.tab.name, 'data-value': props.parameters?.value }, [h('input')])
  },
}) }))
vi.mock('./EditorPicker.vue', () => ({ default: defineComponent({ setup(_, { expose }) { expose({ show: vi.fn(), close: vi.fn() }); return () => null } }) }))
vi.mock('./EditorPane.vue', () => ({ default: { render: () => null } }))
vi.mock('./ExplorerPane.vue', () => ({ default: { render: () => null } }))
vi.mock('./AppDialog.vue', () => ({ default: { render: () => null } }))

it('keeps each HTML page mounted and deduplicates repeated plugin opens', async () => {
  const pinia = createPinia(); setActivePinia(pinia)
  const store = useWorkspaceStore()
  store.workspace = { id: 'one', name: 'One', displayName: 'One', rootPath: 'D:/One', openedAt: '' }
  const root = document.createElement('div'); document.body.append(root)
  const app = createApp(EditorWindowApp, { preview: true, initialPages: [{ path: 'D:/One/.superhigh/editor/a.html', title: 'A', parameters: {} }] }).use(pinia)
  const exposed = app.mount(root) as unknown as { openPage: (page: any) => Promise<void> }
  try {
    await new Promise(resolve => setTimeout(resolve, 0)); await nextTick()
    const input = root.querySelector('input')!
    input.value = 'unsaved page state'
    await exposed.openPage({ path: 'D:/One/.superhigh/editor/b.html', title: 'B', parameters: {} }); await nextTick()
    await exposed.openPage({ path: 'd:/one/.superhigh/editor/A.html', title: 'A', parameters: { value: 'plugin' } }); await nextTick()
    expect(root.querySelectorAll('.editor-tab')).toHaveLength(2)
    expect(root.querySelector('[data-page="A"] input')).toBe(input)
    expect(input.value).toBe('unsaved page state')
    expect(root.querySelector('[data-page="A"]')?.getAttribute('data-value')).toBe('plugin')
    expect(lifecycle.mounts).toBe(2)
    expect(lifecycle.unmounts).toBe(0)
    expect(store.workspace.rootPath).toBe('D:/One')
    await store.saveSettings()
    expect(backend.saveSettings).not.toHaveBeenCalled()
    ;(root.querySelector('.editor-tab.active .tab-close') as HTMLButtonElement).click(); await nextTick()
    expect(lifecycle.unmounts).toBe(1)
    expect(root.querySelectorAll('.editor-tab')).toHaveLength(1)
  } finally { app.unmount(); root.remove() }
})

it('adds open IUI tabs, keeps their controls alive across source refreshes, and removes closed sources', async () => {
  const pinia = createPinia(); setActivePinia(pinia)
  const store = useWorkspaceStore()
  store.workspace = { id: 'one', name: 'One', displayName: 'One', rootPath: 'D:/One', openedAt: '' }
  const root = document.createElement('div'); document.body.append(root)
  const app = createApp(EditorWindowApp, { preview: true }).use(pinia)
  const exposed = app.mount(root) as unknown as { applyUiSnapshot: (snapshot: EditorUiSnapshot) => void }
  const source = { id: 'ui', path: 'D:/One/report.shui', name: 'report.shui', content: 'root = Stack([Input("note", "备注"), Text("第一版")])', contentType: 'text' as const, language: 'plaintext', isDirty: true }
  try {
    await new Promise(resolve => setTimeout(resolve, 0))
    exposed.applyUiSnapshot({ rootPath: 'D:/One', tabs: [source], activePath: source.path })
    await nextTick()
    const input = root.querySelector<HTMLInputElement>('.shui-input')!
    expect(input).not.toBeNull()
    input.value = '保留输入'
    input.dispatchEvent(new Event('input'))
    exposed.applyUiSnapshot({ rootPath: 'D:/One', tabs: [{ ...source, content: source.content.replace('第一版', '第二版') }] })
    await nextTick()
    expect(root.querySelector('.shui-input')).toBe(input)
    expect(input.value).toBe('保留输入')
    expect(root.querySelector('.shui-text')?.textContent).toBe('第二版')
    expect(root.querySelectorAll('.editor-tab')).toHaveLength(1)
    expect(root.querySelector('.editor-window-code')).toBeNull()
    exposed.applyUiSnapshot({ rootPath: 'D:/One', tabs: [] })
    await nextTick()
    expect(root.querySelector('.shui-root')).toBeNull()
  } finally { app.unmount(); root.remove() }
})
