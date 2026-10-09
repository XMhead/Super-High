#!/usr/bin/env node
/**
 * Super High 内置主题维护入口。
 *
 * 只接受主题 key（如 opencode-github-light），不接受序号：界面按深色/浅色分组展示，
 * 序号随分组变化，用它做映射会整体错位（曾把 61-64 当成 glass，误删并漏删）。
 * 人工核对序号用 --list；导出待删清单用 --gallery 页面里的「复制删除清单」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = findProjectRoot(here)
const THEME_FILE = path.join(root, 'src/lib/theme.ts')
const TEST_FILE = path.join(root, 'src/lib/theme-catalog.test.ts')
const TEMPLATE = path.join(here, 'gallery-template.html')
const GALLERY_OUT = path.join(root, '.superhigh/script-tools/theme-gallery.html')

const args = process.argv.slice(2)
const has = name => args.includes('--' + name)
const valueOf = name => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : null
}
const keysOf = name => (valueOf(name) ?? '').split(',').map(s => s.trim()).filter(Boolean)

function findProjectRoot(start) {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'src/lib/theme.ts'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error('未找到项目根：缺少 src/lib/theme.ts')
}

function matchBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error('theme.ts 花括号不配对')
}

function parseEntries(objText) {
  const entries = []
  const re = /^  '?([\w-]+)'?: \{/gm
  let m
  while ((m = re.exec(objText))) {
    const open = m.index + m[0].indexOf('{')
    const close = matchBrace(objText, open)
    let end = close + 1
    if (objText[end] === ',') end++
    entries.push({ id: m[1], start: m.index, end, text: objText.slice(m.index, end) })
  }
  return entries
}

function readTheme(text) {
  const themeStart = text.indexOf('export const THEMES')
  if (themeStart < 0) throw new Error('theme.ts 缺少 THEMES 定义')
  const objOpen = text.indexOf('{', themeStart)
  const objEnd = matchBrace(text, objOpen)
  const objText = text.slice(objOpen + 1, objEnd)
  const entries = parseEntries(objText)

  const assignStart = text.indexOf('Object.assign(THEMES, {', objEnd)
  let assign = null
  if (assignStart >= 0) {
    const close = matchBrace(text, text.indexOf('{', assignStart)) + 1
    const end = text[close] === ')' ? close + 1 : close
    const assignText = text.slice(assignStart, end)
    assign = {
      start: assignStart,
      end,
      text: assignText,
      ids: [...assignText.matchAll(/^  '([\w-]+)': \{/gm)].map(x => x[1]),
    }
  }
  return { themeStart, objEnd, entries, assign, ids: [...entries.map(e => e.id), ...(assign?.ids ?? [])] }
}

function loadThemes() {
  const require = createRequire(path.join(root, 'package.json'))
  const esbuild = require('esbuild')
  const out = path.join(process.env.TEMP ?? process.env.TMP ?? '/tmp', 'superhigh-theme-tool-bundle.mjs')
  esbuild.buildSync({
    entryPoints: [THEME_FILE],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'warning',
  })
  return import(pathToFileURL(out).href + '?t=' + Date.now()).then(mod => {
    fs.rmSync(out, { force: true })
    return mod.THEMES
  })
}

function uiOrder(ids, THEMES) {
  return [
    ...ids.filter(id => THEMES[id]?.type === 'dark'),
    ...ids.filter(id => THEMES[id]?.type !== 'dark'),
  ]
}

function historyLookup(needIds) {
  if (!needIds.length) return new Map()
  const hashes = execFileSync('git', ['log', '--format=%H', '-n', '40', '--', 'src/lib/theme.ts'], {
    cwd: root,
    maxBuffer: 1 << 28,
  }).toString().trim().split('\n').filter(Boolean)
  const found = new Map()
  for (const hash of hashes) {
    const text = execFileSync('git', ['show', `${hash}:src/lib/theme.ts`], { cwd: root, maxBuffer: 1 << 28 }).toString('utf8')
    const parsed = readTheme(text)
    for (const id of needIds) {
      if (found.has(id)) continue
      const entry = parsed.entries.find(e => e.id === id)
      if (entry) {
        found.set(id, { kind: 'entry', text: entry.text })
        continue
      }
      const line = parsed.assign?.text.split(/\r?\n/).find(l => l.startsWith(`  '${id}': {`))
      if (line) found.set(id, { kind: 'assign', text: line })
    }
    if (found.size === needIds.length) break
  }
  const missing = needIds.filter(id => !found.has(id))
  if (missing.length) throw new Error('git 历史里找不到这些主题 key：' + missing.join(', '))
  return found
}

/** 把从历史恢复的 Object.assign 行并回现有 glass 段；没有现存段时重建整块。 */
function keepAssignSegment(currentSegment, extraLines) {
  if (!extraLines.length) return currentSegment
  if (!currentSegment) return 'Object.assign(THEMES, {\n' + extraLines.join('\n') + '\n})'
  return currentSegment.replace(/\n\}\)\s*$/, '\n' + extraLines.join('\n') + '\n})')
}

function keptAssignSegment(assign, keep) {
  if (!assign.ids.some(id => keep.includes(id))) return ''
  return assign.text
    .split(/\r?\n/)
    .filter(line => {
      const m = /^  '([\w-]+)': \{/.exec(line)
      return !m || keep.includes(m[1])
    })
    .join('\n')
}

function syncTestFile(ids) {
  const text = fs.readFileSync(TEST_FILE, 'utf8')
  const re = /(expect\(Object\.keys\(THEMES\)\)\.toEqual\(\[\r?\n)([\s\S]*?)(\r?\n    \]\))/
  if (!re.test(text)) throw new Error('theme-catalog.test.ts 缺少保留清单断言')
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const body = ids.map(id => `      '${id}',`).join(nl)
  return text.replace(re, (_all, head, _old, tail) => head + body + tail)
}

async function main() {
  const THEMES = await loadThemes()
  const text = fs.readFileSync(THEME_FILE, 'utf8')
  const parsed = readTheme(text)
  const ordered = uiOrder(parsed.ids, THEMES)

  if (has('list') || args.length === 0) {
    const dark = ordered.filter(id => THEMES[id]?.type === 'dark')
    const light = ordered.filter(id => THEMES[id]?.type !== 'dark')
    console.log(`内置主题 ${parsed.ids.length} 个（深色 ${dark.length} / 浅色 ${light.length}）`)
    let index = 0
    for (const [label, group] of [['深色', dark], ['浅色', light]]) {
      console.log(label)
      for (const id of group) {
        index++
        console.log(`  ${String(index).padStart(3)}  ${id.padEnd(32)} ${THEMES[id].name}`)
      }
    }
    console.log('\n序号只用于人工核对；增删请传 key。')
    return
  }

  if (has('gallery')) {
    const out = path.resolve(valueOf('out') ?? GALLERY_OUT)
    if (!fs.existsSync(TEMPLATE)) throw new Error('缺少画廊模板：' + TEMPLATE)
    const data = ordered.map(key => {
      const t = THEMES[key]
      return {
        key,
        id: t.id,
        name: t.name,
        type: t.type,
        surfaceOpacity: t.surfaceOpacity ?? null,
        colors: t.colors,
        terminal: t.terminal,
      }
    })
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, fs.readFileSync(TEMPLATE, 'utf8').replace('/*__THEMES_JSON__*/', JSON.stringify(data)), 'utf8')
    console.log(`画廊已生成（${data.length} 个主题）：${out}`)
    console.log('勾选后复制文本里的 keys 清单，再传给 --remove / --keep。')
    return
  }

  const removeKeys = keysOf('remove')
  const keepKeys = keysOf('keep')
  if (!removeKeys.length && !keepKeys.length) throw new Error('需要 --remove 或 --keep，参数一律使用主题 key')
  const unknownRemove = removeKeys.filter(id => !parsed.ids.includes(id))
  if (unknownRemove.length) throw new Error('--remove 里有当前不存在的主题 key：' + unknownRemove.join(', '))
  const badKeep = keepKeys.filter(id => !parsed.ids.includes(id) && !/^[a-z0-9][a-z0-9-]{1,48}$/i.test(id))
  if (badKeep.length) throw new Error('--keep 里有非法主题 key：' + badKeep.join(', '))

  const keep = keepKeys.length ? keepKeys : parsed.ids.filter(id => !removeKeys.includes(id))
  const drop = parsed.ids.filter(id => !keep.includes(id))
  const entriesById = new Map(parsed.entries.map(e => [e.id, e.text]))
  const assignIdsNow = parsed.assign?.ids ?? []
  const known = new Set([...entriesById.keys(), ...assignIdsNow])
  const restored = historyLookup(keep.filter(id => !known.has(id)))
  const restoredEntries = new Map([...restored].filter(([, v]) => v.kind === 'entry').map(([id, v]) => [id, v.text]))
  const restoredAssignLines = [...restored].filter(([, v]) => v.kind === 'assign').map(([, v]) => v.text)

  const keptText = keep.map(id => entriesById.get(id) ?? restoredEntries.get(id) ?? '').join('\n')
    + (parsed.assign ? keptAssignSegment(parsed.assign, keep) : '')
    + restoredAssignLines.join('\n')
  const referenced = [...keptText.matchAll(/\.\.\.THEMES(?:\[['"]?([\w-]+)['"]?\]|\.([\w-]+))/g)].map(m => m[1] ?? m[2])
  const dangling = [...new Set(referenced)].filter(id => !keep.includes(id))
  if (dangling.length) {
    throw new Error(`保留项依赖被排除的主题：${dangling.join(', ')}。把依赖项一并 --keep，或把该条目改成不依赖它的写法。`)
  }

  console.log(`目标保留 ${keep.length} 个；从 git 恢复 ${restored.size} 个${restored.size ? '：' + [...restored.keys()].join(', ') : ''}`)
  console.log(`删除 ${drop.length} 个：${drop.join(', ') || '无'}`)
  if (!has('apply')) {
    console.log('以上为预览；确认后加 --apply 写盘并同步测试清单。')
    return
  }

  const crlf = text.includes('\r\n')
  const restoredAssignIds = [...restored].filter(([, v]) => v.kind === 'assign').map(([id]) => id)
  const keptTop = keep.filter(id => !assignIdsNow.includes(id) && !restoredAssignIds.includes(id))
  const builtTheme = 'export const THEMES: Record<string, ThemeTokens> = {\n'
    + keptTop.map(id => entriesById.get(id) ?? restoredEntries.get(id)).join('\n')
    + '\n}'
  const assignSegment = keepAssignSegment(parsed.assign ? keptAssignSegment(parsed.assign, keep) : '', restoredAssignLines)
  const head = text.slice(0, parsed.themeStart)
  const tail = text.slice(parsed.assign ? parsed.assign.end : parsed.objEnd + 1)
  let next = head + builtTheme + (assignSegment ? '\n\n' + assignSegment : '') + tail
  if (crlf) next = next.replace(/\r?\n/g, '\r\n')

  fs.writeFileSync(THEME_FILE, next, 'utf8')
  const nextIds = readTheme(fs.readFileSync(THEME_FILE, 'utf8')).ids
  fs.writeFileSync(TEST_FILE, syncTestFile(nextIds), 'utf8')
  console.log(`已写入 theme.ts（${nextIds.length} 个）并同步 theme-catalog.test.ts。`)
  console.log('接着跑：npx vitest run src/lib/theme-catalog.test.ts src/lib/terminalColors.test.ts')
}

main().catch(error => {
  console.error('theme-tool 失败：' + (error?.message ?? error))
  process.exit(1)
})
