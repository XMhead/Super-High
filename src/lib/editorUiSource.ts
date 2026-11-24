export interface EditorUiComponent {
  component: string
  [parameter: string]: unknown
}

export function editorUiSource(input: unknown): string {
  if (typeof input === 'string') return input
  const encode = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>
      if (typeof object.component === 'string') {
        if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(object.component)) throw new Error('IUI 组件名称无效。')
        return `${object.component}(${Object.entries(object).filter(([key]) => key !== 'component').map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(',')})`
      }
      return `{${Object.entries(object).map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(',')}}`
    }
    return JSON.stringify(value ?? null)
  }
  return `root = ${encode(input)}`
}
