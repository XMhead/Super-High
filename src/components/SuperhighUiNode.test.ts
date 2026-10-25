import { createApp, defineComponent, h, nextTick, reactive, ref } from 'vue'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { compileSuperhighUi, type UiNode } from '@/lib/superhighUi'
import { SUPERHIGH_UI_CONTEXT, SuperhighUiNode, type SuperhighUiContext } from './SuperhighUiNode'

const mounted: { unmount(): void; root: HTMLElement }[] = []

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  for (const item of mounted.splice(0)) {
    item.unmount()
    item.root.remove()
  }
})

function mountUi(source: string, defaults: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  const doc = compileSuperhighUi(source)
  expect(doc.diagnostics).toEqual([])
  const values = reactive<Record<string, unknown>>({})
  const context: SuperhighUiContext = {
    values,
    setValue: (name, value) => { values[name] = value },
    emitAction: () => undefined,
    beginDrag: () => undefined,
    resolveImage: async (src) => src,
    dragEnabled: ref(false),
    scope: { field: (name) => (name in values ? values[name] : defaults[name]), data: (src) => data[src] },
  }
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(defineComponent({ setup: () => () => h(SuperhighUiNode, { node: doc.root as UiNode }) }))
  app.provide(SUPERHIGH_UI_CONTEXT, context)
  app.mount(root)
  mounted.push({ unmount: () => app.unmount(), root })
  return { root, values }
}

const bodyRows = (root: HTMLElement) => [...root.querySelectorAll('tbody tr')].map((row) => row.textContent)

describe('SuperhighUiNode table', () => {
  const rows = Array.from({ length: 25 }, (_, index) => `["任务 ${index + 1}", "${index % 2 ? '10月' : '9月'}"]`).join(', ')

  it('searches, filters and paginates large tables', async () => {
    const { root } = mountUi(`root = Table(["任务", "月份"], [${rows}], filters: ["月份"], pageSize: 10)`)
    expect(root.querySelector('.shui-table-search')).not.toBeNull()
    expect(bodyRows(root)).toHaveLength(10)
    expect(root.querySelector('.shui-table-pager')?.textContent).toContain('1 / 3')

    const filter = root.querySelector<HTMLSelectElement>('.shui-table-filter')!
    filter.value = '10月'
    filter.dispatchEvent(new Event('change'))
    await nextTick()
    expect(root.querySelector('.shui-table-count')?.textContent).toBe('12 / 25 行')

    const search = root.querySelector<HTMLInputElement>('.shui-table-search')!
    search.value = '任务 2'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    expect(bodyRows(root)).toEqual(['任务 210月', '任务 1210月', '任务 2010月', '任务 2210月', '任务 2410月'])
    expect(root.querySelector('.shui-table-pager')).toBeNull()
  })

  it('narrows rows when a bound field changes', async () => {
    const { root, values } = mountUi(`root = Stack([Select("month", ["9月", "10月"]), Table(["任务", "月份"], [${rows}], where: {"月份": Bind("month")}, pageSize: 0)])`, { month: '9月' })
    expect(bodyRows(root)).toHaveLength(13)
    values.month = '10月'
    await nextTick()
    expect(bodyRows(root)).toHaveLength(12)
  })

  it('treats an explicit null option as "all"', async () => {
    const { root } = mountUi(`root = Stack([Choice("month", [{label: "全部", value: null}, "9月"], value: "9月"), Table(["任务", "月份"], [${rows}], where: {"月份": Bind("month")}, pageSize: 0)])`, { month: '9月' })
    expect(bodyRows(root)).toHaveLength(13)
    root.querySelector<HTMLButtonElement>('.shui-choice button')!.click()
    await nextTick()
    expect(bodyRows(root)).toHaveLength(25)
  })
})

describe('SuperhighUiNode dynamic values', () => {
  it('updates stats and swaps child components from Bind and Data', async () => {
    const { root, values } = mountUi(
      'root = Stack([Stat("总计", Bind("month", {"9月": 12, "10月": 30})), Bind("month", {"10月": Badge("十月")}), Stat("缓存", Data("usage.json", "cache"))])',
      { month: '9月' },
      { 'usage.json': { cache: '84%' } },
    )
    expect([...root.querySelectorAll('.shui-stat-value')].map((item) => item.textContent)).toEqual(['12', '84%'])
    expect(root.querySelector('.shui-badge')).toBeNull()
    values.month = '10月'
    await nextTick()
    expect(root.querySelector('.shui-stat-value')?.textContent).toBe('30')
    expect(root.querySelector('.shui-badge')?.textContent).toBe('十月')
  })
})

describe('SuperhighUiNode chart', () => {
  it('stacks bars, merges extra series and reports percent shares', async () => {
    const series = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, index) => `{name: "${name}", values: [${index + 1}, 1]}`).join(', ')
    const { root } = mountUi(`root = Chart("bar", ["x", "y"], [${series}], stacked: "percent")`)
    expect([...root.querySelectorAll('.shui-chart-legend span')].map((item) => item.textContent)).toEqual(['a', 'b', 'c', 'd', '其他'])
    expect(root.querySelectorAll('svg path')).toHaveLength(10)
    expect(root.querySelector('svg')?.getAttribute('aria-label')).toContain('堆叠柱状图')
    root.querySelectorAll('svg rect')[0].dispatchEvent(new Event('pointerenter'))
    await nextTick()
    const tooltip = root.querySelector('.shui-chart-tooltip')?.textContent ?? ''
    expect(tooltip).toContain('其他11 · 52.38%')
    expect(tooltip).toContain('合计21')
  })
})
