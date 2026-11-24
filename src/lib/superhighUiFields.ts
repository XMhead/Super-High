import { isUiNode, type UiNode } from './superhighUi'
import { SUPERHIGH_UI_FIELD_COMPONENTS } from './superhighUiComponents'
import { resolveUiNodeProps, resolveUiValue, uiText, walkUiTree, type SuperhighUiScope } from './superhighUiData'

export interface UiOption {
  label: string
  value: unknown
  description?: string
  recommended?: boolean
}

export const uiList = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value]
export const sameUiValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

export function uiOptions(value: unknown): UiOption[] {
  return uiList(value).map(item => {
    if (item && typeof item === 'object' && !isUiNode(item)) {
      const record = item as Record<string, unknown>
      const optionValue = 'value' in record ? record.value : record.label
      return {
        label: uiText(record.label ?? optionValue),
        value: optionValue,
        description: uiText(record.description),
        recommended: record.recommended === true,
      }
    }
    return { label: uiText(item), value: item }
  })
}

export interface UiQuestionAnswer {
  choices: unknown[]
  text: string
}

export function questionAnswer(props: UiNode['props'], value: unknown): UiQuestionAnswer {
  const stored = value && typeof value === 'object' ? value as Partial<UiQuestionAnswer> : {}
  const options = uiOptions(props.options)
  const choices = Array.isArray(stored.choices)
    ? stored.choices.filter((choice, index, all) => options.some(option => sameUiValue(option.value, choice))
      && all.findIndex(item => sameUiValue(item, choice)) === index)
    : []
  return {
    choices: props.multiple === true ? choices : choices.slice(0, 1),
    text: (props.freeText !== false || !options.length) && typeof stored.text === 'string' ? stored.text : '',
  }
}

function defaultFieldValue(node: UiNode) {
  const props = node.props
  switch (node.type) {
    case 'SortList':
      return uiOptions(props.items).map(option => option.value)
    case 'Slider':
      return props.value === undefined ? Number(props.min) || 0 : Number(props.value)
    case 'Checkbox':
      return props.value === true
    case 'Choice':
      return props.multiple === true ? uiList(props.value) : props.value ?? null
    case 'Question':
      return questionAnswer(props, props.value)
    default:
      return props.value ?? null
  }
}

export function submittedFieldValue(node: UiNode, values: Record<string, unknown>) {
  const name = uiText(node.props.name)
  if (!(name in values) || !Object.prototype.hasOwnProperty.call(values, name)) return defaultFieldValue(node)
  return node.type === 'Question' ? questionAnswer(node.props, values[name]) : values[name]
}

export function indexUiFields(root: UiNode | null) {
  const fields = new Map<string, UiNode>()
  walkUiTree(root, node => {
    const name = uiText(node.props.name)
    if (SUPERHIGH_UI_FIELD_COMPONENTS.has(node.type) && name && !fields.has(name)) fields.set(name, node)
  })
  return fields
}

export function createUiScope(fields: () => Map<string, UiNode>, values: Record<string, unknown>, data: SuperhighUiScope['data']): SuperhighUiScope {
  const evaluating = new Set<string>()
  const scope: SuperhighUiScope = {
    data,
    field(name) {
      const node = fields().get(name)
      const stored = name in values && Object.prototype.hasOwnProperty.call(values, name)
      if (node?.type !== 'Question') return stored ? values[name] : node && defaultFieldValue(node)
      if (evaluating.has(name)) return undefined
      evaluating.add(name)
      try {
        const { options, value, multiple, freeText } = node.props
        const question = resolveUiValue({ options, multiple, freeText }, scope) as UiNode['props']
        return questionAnswer(question, stored ? values[name] : resolveUiValue(value, scope))
      } finally {
        evaluating.delete(name)
      }
    },
  }
  return scope
}

export function formatUiDraft(root: UiNode | null, scope: SuperhighUiScope, values: Record<string, unknown>, label: string, submitted?: Record<string, unknown>) {
  const lines = [label]
  walkUiTree(root, field => {
    if (!SUPERHIGH_UI_FIELD_COMPONENTS.has(field.type)) return
    const node = resolveUiNodeProps(field, scope)
    const props = node.props
    const name = uiText(props.name)
    if (!name || (submitted && !Object.prototype.hasOwnProperty.call(submitted, name))) return
    const value = submittedFieldValue(node, submitted ?? values)
    const options = uiOptions(field.type === 'SortList' ? props.items : props.options)
    const display = (item: unknown) => options.find(option => sameUiValue(option.value, item))?.label
      ?? (typeof item === 'boolean' ? (item ? '是' : '否') : uiText(item))
    const title = uiText(props.label) || name
    if (field.type === 'Question') {
      const answer = value as UiQuestionAnswer
      const selection = answer.choices.map(display).join('、')
      const notes = answer.text.trim()
      if (selection || notes) lines.push(`${title}：${selection || notes}`)
      if (selection && notes) lines.push(`补充：${notes}`)
      return
    }
    lines.push(`${title}：${Array.isArray(value) ? value.map(display).join('、') : display(value)}`)
  })
  return lines.join('\n')
}
