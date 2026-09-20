import { describe, expect, it } from 'vitest'

import {
  createDragonCoreGui,
  dragonCoreContentHash,
  handleDragonCoreEditorOperation,
  parseDragonCoreGui,
  patchDragonCoreGui,
} from './dragonCoreEditor'

describe('DragonCore editor CST bridge', () => {
  it('indexes all supported component types, unknown fields, foreach templates and inheritance', () => {
    const text = [
      'match: 测试',
      'import: [公共/基础]',
      'Functions:',
      '  open: |- ',
      '    方法.消息("ok");',
      '基础模板:',
      "  x: 方法.执行方法('定位X', 10)",
      '贴图:',
      '  type: texture',
      '  extends: 基础模板',
      '  unknown: 保留',
      "  x: 方法.执行方法('定位X', 100)",
      '  y: 20',
      '  width: 背景.width * 0.5',
      '循环:',
      '  type: foreach',
      '  data: 2',
      '  src:',
      '    标签{index}:',
      '      type: label',
      "      texts: '{data}'",
      ...['slot', 'hit', 'textbox', 'entity', 'video', 'textarea'].flatMap((type, index) => [
        `${type}${index}:`,
        `  type: ${type}`,
        `  x: ${index}`,
      ]),
      '',
    ].join('\n')

    const parsed = parseDragonCoreGui('DragonCore/Gui/test.yml', text)

    expect(parsed.writable).toBe(true)
    expect(parsed.imports).toEqual(['公共/基础'])
    expect(parsed.functions[0]?.key).toBe('open')
    expect(parsed.components.map((component) => component.type)).toEqual(expect.arrayContaining([
      'template', 'texture', 'foreach', 'label', 'slot', 'hit', 'textbox', 'entity', 'video', 'textarea',
    ]))
    const texture = parsed.components.find((component) => component.name === '贴图')!
    expect(texture).toMatchObject({ line: 8, column: 1 })
    expect(texture.extends).toBe('基础模板')
    expect(texture.fields.find((field) => field.key === 'unknown')?.value).toBe('保留')
    expect(texture.fields.find((field) => field.key === 'x')?.editableNumber).toMatchObject({ mode: 'adaptive', value: 100, functionName: '定位X' })
    expect(texture.fields.find((field) => field.key === 'width')?.editableNumber).toBeNull()
  })

  it('infers legacy component types from key suffixes and unambiguous fields', () => {
    const text = [
      '背景_texture:',
      '  x: 0',
      '  texture: gui/background.png',
      '标题_label:',
      "  texts: '标题'",
      '格子_slot:',
      '  identifier: container_0',
      '循环_foreach:',
      '  data: 2',
      '  src:',
      '    子标签{index}_label:',
      "      texts: '{index}'",
      '字段推断贴图:',
      '  texture: gui/inferred.png',
      '',
    ].join('\n')

    const parsed = parseDragonCoreGui('DragonCore/Gui/legacy.yml', text)

    expect(parsed.components.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: '背景_texture', type: 'texture' },
      { name: '标题_label', type: 'label' },
      { name: '格子_slot', type: 'slot' },
      { name: '循环_foreach', type: 'foreach' },
      { name: '子标签{index}_label', type: 'label' },
      { name: '字段推断贴图', type: 'texture' },
    ])
  })

  it('keeps optional semicolons on four-function coordinates editable', () => {
    const text = "组件:\n  type: texture\n  x: 方法.执行方法('定位X', 12.5);\n"
    const parsed = parseDragonCoreGui('DragonCore/Gui/semicolon.yml', text)
    const x = parsed.components[0].fields.find((item) => item.key === 'x')!

    expect(x.editableNumber).toMatchObject({ mode: 'adaptive', functionName: '定位X', value: 12.5 })
    const patched = patchDragonCoreGui(text, parsed.hash, [{
      kind: 'set-scalar',
      range: x.range!,
      expectedRaw: x.raw,
      value: 18,
      preserveExpression: true,
    }])
    expect(patched.content).toContain("方法.执行方法('定位X', 18);")
  })

  it('reports broken YAML with line and column and disables structured writes', () => {
    const parsed = parseDragonCoreGui('DragonCore/Gui/broken.yml', '组件:\n  type: texture\n bad: [\n')

    expect(parsed.writable).toBe(false)
    expect(parsed.diagnostics[0]).toMatchObject({ severity: 'error' })
    expect(parsed.diagnostics[0].line).toBeGreaterThan(0)
    expect(parsed.diagnostics[0].column).toBeGreaterThan(0)
  })

  it('patches only target scalar ranges, preserves expression wrappers, comments and removes blank lines', () => {
    const text = "组件:\r\n  type: texture\r\n  x: 方法.执行方法('定位X', 100) # keep\r\n\r\n  y: 20\r\n  actions:\r\n    click: |-\r\n      方法.消息('不改');\r\n"
    const parsed = parseDragonCoreGui('DragonCore/Gui/test.yml', text)
    const component = parsed.components[0]
    const x = component.fields.find((field) => field.key === 'x')!
    const result = patchDragonCoreGui(text, parsed.hash, [{
      kind: 'set-scalar',
      range: x.range!,
      expectedRaw: x.raw,
      value: 145,
      preserveExpression: true,
    }])

    expect(result.content).toContain("x: 方法.执行方法('定位X', 145) # keep")
    expect(result.content).toContain("方法.消息('不改');")
    expect(result.content).not.toContain('\r\n\r\n')
    expect(result.content.replace('145', '100')).toBe(text.replace('\r\n\r\n', '\r\n'))
  })

  it('rejects stale hashes and unsafe writes to complex expressions', () => {
    const text = '组件:\n  type: texture\n  x: 背景.x + 1\n'
    const parsed = parseDragonCoreGui('', text)
    const x = parsed.components[0].fields.find((field) => field.key === 'x')!

    expect(() => patchDragonCoreGui(`${text}# outside\n`, parsed.hash, [{ kind: 'set-scalar', range: x.range!, value: 1 }])).toThrow('外部修改')
    expect(x.editableNumber).toBeNull()
  })

  it('inserts missing local fields and supports hash-checked undo content', () => {
    const text = '组件:\n  type: texture\n  extends: 模板\n'
    const parsed = parseDragonCoreGui('', text)
    const component = parsed.components[0]
    const inserted = patchDragonCoreGui(text, parsed.hash, [{
      kind: 'insert-field',
      range: component.range,
      depth: component.depth,
      key: 'z',
      value: 3,
    }])
    expect(inserted.content).toContain('  z: 3\n')

    const undone = patchDragonCoreGui(inserted.content, inserted.parsed.hash, [{ kind: 'replace-document', content: text }])
    expect(undone.content).toBe(text)
  })

  it('creates a no-blank-line adaptive DragonCore GUI', () => {
    const content = createDragonCoreGui('新界面')
    const parsed = parseDragonCoreGui('DragonCore/Gui/new.yml', content)

    expect(parsed.writable).toBe(true)
    expect(content).toContain("定位X: return 背景.x+背景.width/方法.取yaml值('背景实际宽度')")
    expect(content).not.toMatch(/\n\s*\n/)
  })

  it('inspects recursive GUI files and refuses resources outside configured roots', async () => {
    const files = new Map([
      ['D:/Project/DragonCore/Gui/a.yml', 'import: [sub/b]\n组件:\n  type: texture\n'],
      ['D:/Project/DragonCore/Gui/sub/b.yaml', '组件:\n  type: label\n'],
      ['D:/Project/.superhigh/minecraft-client.json', '{"clientRoot":"D:/Client"}'],
    ])
    const context = {
      workspaceRoot: 'D:/Project',
      readFile: async (path: string) => {
        const value = files.get(path)
        if (value === undefined) throw new Error('missing')
        return value
      },
      writeFile: async () => true,
      listDirectory: async (path: string) => path.endsWith('/sub')
        ? { entries: [{ name: 'b.yaml', type: 'file' }] }
        : { entries: [{ name: 'a.yml', type: 'file' }, { name: 'sub', type: 'directory' }] },
      readMediaAsDataUrl: async (path: string) => {
        if (path === 'D:/Client/.minecraft/resourcepacks/DragonCore/gui/a.png') return 'data:image/png;base64,AA=='
        throw new Error('missing')
      },
    }

    const inspected = await handleDragonCoreEditorOperation('inspect-gui', { path: 'DragonCore/Gui/a.yml' }, context) as any
    expect(inspected.fileCount).toBe(2)
    expect(inspected.imports[0].path).toBe('DragonCore/Gui/sub/b.yaml')
    const resource = await handleDragonCoreEditorOperation('read-resource', { path: 'gui/a.png' }, context) as any
    expect(resource.dataUrl).toContain('data:image/png')
    await expect(handleDragonCoreEditorOperation('read-resource', { path: '../secret.png' }, context)).rejects.toThrow('受限相对路径')
  })

  it('keeps duplicate keys parseable and hashes content deterministically', () => {
    const text = '组件:\n  type: texture\n组件:\n  type: label\n'
    const parsed = parseDragonCoreGui('', text)

    expect(parsed.components).toHaveLength(2)
    expect(parsed.hash).toBe(dragonCoreContentHash(text))
  })
})
