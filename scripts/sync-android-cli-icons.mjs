// Generate Android vectors directly from the shared Vue CLI icons.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const icons = ['codex', 'claude', 'opencode', 'gemini', 'grok', 'codebuddy', 'kimi']
// Android's path parser requires separators between SVG arc flags, which SVG permits to be adjacent.
function normalizeArcs(path) {
  return path.replace(/[Aa][^a-zA-Z]*/g, segment => {
    const command = segment[0]
    let rest = segment.slice(1)
    const groups = []
    const number = () => {
      rest = rest.replace(/^[\s,]+/, '')
      const match = rest.match(/^[-+]?(?:\d*\.\d+|\d+\.?\d*)/)
      if (!match) throw new Error(`Invalid arc: ${segment}`)
      rest = rest.slice(match[0].length)
      return match[0]
    }
    const flag = () => {
      rest = rest.replace(/^[\s,]+/, '')
      if (!/^[01]/.test(rest)) throw new Error(`Invalid arc flag: ${segment}`)
      const value = rest[0]; rest = rest.slice(1); return value
    }
    while (rest.trim()) groups.push([number(), number(), number(), flag(), flag(), number(), number()].join(' '))
    return command + groups.join(' ')
  })
}
for (const icon of icons) {
  const name = ({ opencode: 'OpenCode', codebuddy: 'CodeBuddy' })[icon] ?? icon[0].toUpperCase() + icon.slice(1)
  const source = readFileSync(join('src', 'components', 'icons', `${name}Icon.vue`), 'utf8')
  const svg = source.match(/<svg\b[\s\S]*?<\/svg>/)?.[0]
  const viewBox = svg?.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
  if (!svg || !viewBox) throw new Error(`Missing SVG viewBox: ${name}`)
  const paths = []
  for (const match of svg.matchAll(/<path\b([^>]*?)\s*\/>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
    if (!attrs.d || attrs.fill?.startsWith('url(')) continue
    const fill = attrs.fill === 'currentColor' ? '#202020' : attrs.fill === 'none' ? '#00000000' : attrs.fill ?? '#202020'
    const stroke = attrs.stroke ? ` android:strokeColor="${attrs.stroke}" android:strokeWidth="${attrs['stroke-width'] ?? 1}" android:strokeLineCap="round" android:strokeLineJoin="round"` : ''
    paths.push(`    <path android:fillColor="${fill}" android:fillType="${attrs['fill-rule'] === 'evenodd' ? 'evenOdd' : 'nonZero'}"${stroke} android:pathData="${normalizeArcs(attrs.d)}" />`)
  }
  if (icon === 'kimi') paths.unshift('    <path android:fillColor="#38A5FF" android:pathData="M12,2 A10,10 0,1 1,11.99,2 Z" />')
  if (!paths.length) throw new Error(`Missing SVG paths: ${name}`)
  const xml = `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="48dp" android:height="48dp" android:viewportWidth="${viewBox[1]}" android:viewportHeight="${viewBox[2]}">\n${paths.join('\n')}\n</vector>\n`
  const target = join('android', 'app', 'src', 'main', 'res', 'drawable', `cli_${icon}.xml`)
  if (existsSync(target) && readFileSync(target, 'utf8').replaceAll('\r\n', '\n') === xml) continue
  writeFileSync(target, xml)
}
