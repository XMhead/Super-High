// SuperHigh UI（.shui）组件清单：解析器按参数顺序映射位置参数。
// 增删组件或改参数顺序时，同步全局 superhigh-workspace-config 的 references/superhigh-ui.md 组件表与 scripts/shui_compose.py。
export type SuperhighUiArgType = 'nodes' | 'string' | 'number' | 'boolean' | 'text' | 'list' | 'object' | 'any'

export interface SuperhighUiArgSpec {
  name: string
  type: SuperhighUiArgType
  required?: boolean
  values?: string[]
  description: string
}

export interface SuperhighUiComponentSpec {
  name: string
  category: 'layout' | 'content' | 'input' | 'value'
  description: string
  args: SuperhighUiArgSpec[]
  /** 子组件列表可在预览中拖动重排并写回源码 */
  sortable?: boolean
}

const TONES = ['neutral', 'info', 'ok', 'warn', 'error']
const GAPS = ['s', 'm', 'l']

export const SUPERHIGH_UI_COMPONENTS: SuperhighUiComponentSpec[] = [
  {
    name: 'Stack',
    category: 'layout',
    description: '纵向排列子组件',
    sortable: true,
    args: [
      { name: 'children', type: 'nodes', required: true, description: '子组件' },
      { name: 'gap', type: 'string', values: GAPS, description: '间距' },
    ],
  },
  {
    name: 'Row',
    category: 'layout',
    description: '横向排列，面板变窄时自动换行',
    sortable: true,
    args: [
      { name: 'children', type: 'nodes', required: true, description: '子组件' },
      { name: 'gap', type: 'string', values: GAPS, description: '间距' },
      { name: 'align', type: 'string', values: ['start', 'center', 'end', 'between'], description: '主轴对齐' },
    ],
  },
  {
    name: 'Grid',
    category: 'layout',
    description: '等宽网格，按面板宽度自动减少列数',
    sortable: true,
    args: [
      { name: 'children', type: 'nodes', required: true, description: '子组件' },
      { name: 'columns', type: 'number', description: '最多列数，默认 3' },
    ],
  },
  {
    name: 'Card',
    category: 'layout',
    description: '带标题的分组卡片',
    sortable: true,
    args: [
      { name: 'title', type: 'string', description: '标题' },
      { name: 'children', type: 'nodes', description: '子组件' },
      { name: 'subtitle', type: 'string', description: '标题右侧的次要说明' },
      { name: 'tone', type: 'string', values: TONES, description: '左边线状态色' },
    ],
  },
  {
    name: 'Section',
    category: 'layout',
    description: '可折叠分节',
    sortable: true,
    args: [
      { name: 'title', type: 'string', required: true, description: '分节标题' },
      { name: 'children', type: 'nodes', required: true, description: '子组件' },
      { name: 'collapsed', type: 'boolean', description: '初始折叠' },
    ],
  },
  {
    name: 'Tabs',
    category: 'layout',
    description: '标签页，labels 与 panels 一一对应',
    args: [
      { name: 'labels', type: 'list', required: true, description: '标签名列表' },
      { name: 'panels', type: 'nodes', required: true, description: '各标签内容' },
    ],
  },
  {
    name: 'Divider',
    category: 'layout',
    description: '分隔线',
    args: [{ name: 'label', type: 'string', description: '线上文字' }],
  },
  {
    name: 'Text',
    category: 'content',
    description: '一段文字',
    args: [
      { name: 'content', type: 'text', required: true, description: '文字内容' },
      { name: 'variant', type: 'string', values: ['body', 'title', 'subtitle', 'strong', 'muted', 'code'], description: '样式' },
    ],
  },
  {
    name: 'Markdown',
    category: 'content',
    description: 'Markdown 正文',
    args: [{ name: 'content', type: 'text', required: true, description: 'Markdown 文本' }],
  },
  {
    name: 'Badge',
    category: 'content',
    description: '状态标签',
    args: [
      { name: 'label', type: 'string', required: true, description: '文字' },
      { name: 'tone', type: 'string', values: TONES, description: '状态色' },
    ],
  },
  {
    name: 'Callout',
    category: 'content',
    description: '提示框',
    args: [
      { name: 'content', type: 'text', required: true, description: '提示内容' },
      { name: 'tone', type: 'string', values: TONES, description: '状态色，默认 info' },
      { name: 'title', type: 'string', description: '标题' },
    ],
  },
  {
    name: 'Stat',
    category: 'content',
    description: '单个指标',
    args: [
      { name: 'label', type: 'string', required: true, description: '指标名' },
      { name: 'value', type: 'any', required: true, description: '数值' },
      { name: 'delta', type: 'string', description: '变化量，如 "+12%"' },
      { name: 'tone', type: 'string', values: TONES, description: '变化量状态色' },
    ],
  },
  {
    name: 'KeyValue',
    category: 'content',
    description: '键值列表',
    args: [{ name: 'items', type: 'any', required: true, description: '{键: 值} 对象，或 [[键, 值], ...]' }],
  },
  {
    name: 'Table',
    category: 'content',
    description: '数据表，点击表头排序，可搜索、按列筛选和分页，超宽时横向滚动',
    args: [
      { name: 'columns', type: 'list', required: true, description: '列名' },
      { name: 'rows', type: 'list', required: true, description: '行数据 [[...], ...] 或 [{列名: 值}]，单元格可为 Badge 等组件' },
      { name: 'search', type: 'boolean', description: '显示搜索框，默认超过 20 行时显示' },
      { name: 'filters', type: 'list', description: '提供下拉筛选的列名' },
      { name: 'where', type: 'object', description: '{列名: 值} 只显示匹配的行，值常用 Bind；空值不筛选，数组按任一匹配' },
      { name: 'pageSize', type: 'number', description: '每页行数，默认 50，0 不分页' },
    ],
  },
  {
    name: 'List',
    category: 'content',
    description: '列表',
    args: [
      { name: 'items', type: 'list', required: true, description: '文字或组件' },
      { name: 'ordered', type: 'boolean', description: '编号列表' },
    ],
  },
  {
    name: 'Steps',
    category: 'content',
    description: '步骤进度',
    args: [{ name: 'items', type: 'list', required: true, description: '[{title, status?: done|active|pending|error, detail?}]' }],
  },
  {
    name: 'Progress',
    category: 'content',
    description: '进度条',
    args: [
      { name: 'value', type: 'number', required: true, description: '当前值' },
      { name: 'max', type: 'number', description: '最大值，默认 100' },
      { name: 'label', type: 'string', description: '说明' },
      { name: 'tone', type: 'string', values: TONES, description: '状态色' },
    ],
  },
  {
    name: 'Chart',
    category: 'content',
    description: '柱状图或折线图，最多 4 个系列；堆叠柱超出部分合并为“其他”',
    args: [
      { name: 'kind', type: 'string', required: true, values: ['bar', 'line'], description: '图表类型' },
      { name: 'labels', type: 'list', required: true, description: '横轴标签' },
      { name: 'series', type: 'list', required: true, description: '[数值...] 或 [{name, values}]' },
      { name: 'unit', type: 'string', description: '数值单位' },
      { name: 'stacked', type: 'any', description: 'bar 时 true 堆叠，"percent" 按每组合计换算成占比' },
    ],
  },
  {
    name: 'Code',
    category: 'content',
    description: '代码块，带复制按钮',
    args: [
      { name: 'content', type: 'text', required: true, description: '代码' },
      { name: 'language', type: 'string', description: '语言名' },
    ],
  },
  {
    name: 'Image',
    category: 'content',
    description: '图片，相对路径按 .shui 所在目录解析',
    args: [
      { name: 'src', type: 'string', required: true, description: '图片路径' },
      { name: 'alt', type: 'string', description: '替代文字' },
    ],
  },
  {
    name: 'Button',
    category: 'input',
    description: '按钮，点击记录到状态文件 actions',
    args: [
      { name: 'label', type: 'string', required: true, description: '按钮文字' },
      { name: 'action', type: 'string', description: '动作名，默认用按钮文字' },
      { name: 'variant', type: 'string', values: ['default', 'primary', 'ghost', 'danger'], description: '样式' },
    ],
  },
  {
    name: 'Form',
    category: 'input',
    description: '表单，提交时记录表单内全部字段值',
    sortable: true,
    args: [
      { name: 'name', type: 'string', required: true, description: '表单名' },
      { name: 'children', type: 'nodes', required: true, description: '字段及其他组件' },
      { name: 'submit', type: 'string', description: '提交按钮文字，默认“提交”' },
    ],
  },
  {
    name: 'Input',
    category: 'input',
    description: '文本输入',
    args: [
      { name: 'name', type: 'string', required: true, description: '字段名' },
      { name: 'label', type: 'string', description: '标签' },
      { name: 'placeholder', type: 'string', description: '占位文字' },
      { name: 'multiline', type: 'boolean', description: '多行' },
      { name: 'value', type: 'string', description: '默认值' },
    ],
  },
  {
    name: 'Select',
    category: 'input',
    description: '下拉选择',
    args: [
      { name: 'name', type: 'string', required: true, description: '字段名' },
      { name: 'options', type: 'list', required: true, description: '["a", ...] 或 [{label, value}]' },
      { name: 'label', type: 'string', description: '标签' },
      { name: 'value', type: 'any', description: '默认值' },
    ],
  },
  {
    name: 'Checkbox',
    category: 'input',
    description: '复选框',
    args: [
      { name: 'name', type: 'string', required: true, description: '字段名' },
      { name: 'label', type: 'string', required: true, description: '标签' },
      { name: 'value', type: 'boolean', description: '默认值' },
    ],
  },
  {
    name: 'Slider',
    category: 'input',
    description: '数值滑块',
    args: [
      { name: 'name', type: 'string', required: true, description: '字段名' },
      { name: 'min', type: 'number', required: true, description: '最小值' },
      { name: 'max', type: 'number', required: true, description: '最大值' },
      { name: 'step', type: 'number', description: '步长，默认 1' },
      { name: 'label', type: 'string', description: '标签' },
      { name: 'value', type: 'number', description: '默认值' },
    ],
  },
  {
    name: 'Choice',
    category: 'input',
    description: '分段选择，可多选',
    args: [
      { name: 'name', type: 'string', required: true, description: '字段名' },
      { name: 'options', type: 'list', required: true, description: '["a", ...] 或 [{label, value}]' },
      { name: 'multiple', type: 'boolean', description: '允许多选' },
      { name: 'label', type: 'string', description: '标签' },
      { name: 'value', type: 'any', description: '默认值，多选时为数组' },
    ],
  },
  {
    name: 'SortList',
    category: 'input',
    description: '可拖动排序的列表，字段值为排序后的 value 数组',
    args: [
      { name: 'name', type: 'string', required: true, description: '字段名' },
      { name: 'items', type: 'list', required: true, description: '["a", ...] 或 [{label, value}]' },
      { name: 'label', type: 'string', description: '标签' },
    ],
  },
  {
    name: 'Bind',
    category: 'value',
    description: '取字段当前值，可按对照表换成其他值或组件；字段变化时随之更新',
    args: [
      { name: 'field', type: 'string', required: true, description: '字段名' },
      { name: 'cases', type: 'object', description: '{字段值: 结果}；多选字段逐项换算' },
      { name: 'fallback', type: 'any', description: '没有匹配时的结果' },
    ],
  },
  {
    name: 'Data',
    category: 'value',
    description: '读取 JSON/JSONL 文件，文件变化时自动重读',
    args: [
      { name: 'src', type: 'string', required: true, description: '文件路径，相对 .shui 所在目录' },
      { name: 'path', type: 'string', description: '取其中一项，如 "months.0.total"' },
    ],
  },
]

export const SUPERHIGH_UI_COMPONENT_MAP = new Map(SUPERHIGH_UI_COMPONENTS.map((spec) => [spec.name, spec]))

export const SUPERHIGH_UI_FIELD_COMPONENTS = new Set(['Input', 'Select', 'Checkbox', 'Slider', 'Choice', 'SortList'])

/** 渲染时才求值的动态值，可出现在任意参数或子组件位置 */
export const SUPERHIGH_UI_VALUE_COMPONENTS = new Set(['Bind', 'Data'])
