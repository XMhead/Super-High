import { createServer } from 'vite'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDesktopPreviewOptions } from './superhigh-desktop-preview.mjs'

export async function ensureEmbeddedMobileUi(workspace) {
  const dir = join(resolve(workspace), '.agent', 'tmp', 'ui')
  const path = join(dir, 'mobile-live-preview.shui')
  const content = 'root = Editor(src: "http://127.0.0.1:1421/", height: 760)\n'
  await mkdir(dir, { recursive: true })
  try { await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if ((await readFile(path, 'utf8')).trim() !== content.trim()) throw new Error(`IUI 已修改，未覆盖：${path}`)
  }
  return path
}

async function main() {
  const values = new Map()
  const keys = new Set(['page', 'section', 'theme', 'scenario', 'mode', 'persist', 'port'])
  let open = true
  let embed = false
  let workspace = ''
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index]
    if (argument === '--help') {
      console.log('npm run superhigh-html -- [--page settings|mobile|desktop] [--section general|appearance|config|automation|shortcuts|mobile|cli|storage|updates|plugins|channels] [--theme <主题ID>] [--scenario ready|empty|error] [--mode simulate|readonly] [--persist 0|1] [--port <端口>] [--no-open] [--embed --workspace <工作区>]；--embed 在 Super High 代码预览打开手机实时页面；mobile 使用真实 Host，默认端口 1421；settings 默认 1422；desktop 主工作区演示使用真实源码目录，默认 1423')
      process.exit(0)
    }
    if (argument === '--no-open') { open = false; continue }
    if (argument === '--embed') { embed = true; open = false; continue }
    if (argument === '--workspace') {
      workspace = process.argv[++index] ?? ''
      if (!workspace || workspace.startsWith('--')) throw new Error('缺少参数值：workspace')
      continue
    }
    const [key, ...parts] = argument.replace(/^--/, '').split('=')
    if (!argument.startsWith('--') || !keys.has(key)) throw new Error(`未知参数：${argument}`)
    const value = parts.length ? parts.join('=') : process.argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`缺少参数值：${key}`)
    values.set(key, value)
  }
  const page = values.get('page') ?? 'settings'
  if (!['settings', 'mobile', 'desktop'].includes(page)) throw new Error(`无效参数：page=${page}`)
  values.delete('page')
  if (embed && page !== 'mobile') throw new Error('--embed 仅支持 --page mobile')
  if (workspace && !embed) throw new Error('--workspace 仅用于 --embed')
  if (page === 'mobile' && [...values.keys()].some(key => key !== 'port')) throw new Error('mobile 使用真实 Host，不接受设置模拟参数')
  if (page === 'desktop' && values.has('section')) throw new Error('desktop 主工作区演示不接受 --section 参数')
  const port = Number(values.get('port') ?? (page === 'mobile' ? 1421 : page === 'desktop' ? 1423 : 1422))
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port 必须为 1024–65535 的整数')
  if (embed && port !== 1421) throw new Error('--embed 仅支持手机预览端口 1421')
  values.delete('port')
  for (const [key, valid] of Object.entries({
    section: ['general', 'appearance', 'config', 'automation', 'shortcuts', 'mobile', 'cli', 'storage', 'updates', 'plugins', 'channels'],
    scenario: ['ready', 'empty', 'error'], mode: ['simulate', 'readonly'], persist: ['0', '1'],
  })) {
    if (values.has(key) && !valid.includes(values.get(key))) throw new Error(`无效参数：${key}=${values.get(key)}`)
  }
  const root = fileURLToPath(new URL('../', import.meta.url))
  const pagePath = page === 'mobile' ? '' : page === 'desktop' ? 'desktop-preview.html' : 'superhigh-html.html'
  const pageMarker = page === 'mobile' ? '/src/mobile/preview.ts' : page === 'desktop' ? '/src/preview/desktop.ts' : '/src/preview/main.ts'
  const url = new URL(`http://127.0.0.1:${port}/${pagePath}`)
  for (const [key, value] of values) url.searchParams.set(key, value)
  let reused = false
  let startedServer
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    reused = response.ok && (await response.text()).includes(pageMarker)
  } catch { /* No live preview; Vite checks whether the port is available. */ }
  if (reused) {
    console.log(`已复用实时预览：${url}`)
    if (open) {
      const [command, args] = process.platform === 'win32' ? ['explorer.exe', [url.href]] : process.platform === 'darwin' ? ['open', [url.href]] : ['xdg-open', [url.href]]
      execFile(command, args, { windowsHide: true }, error => { if (error) console.log(`请打开：${url}`) })
    }
  } else {
    const server = await createServer({
      root,
      ...(page === 'mobile' ? { configFile: fileURLToPath(new URL('../vite.mobile.config.ts', import.meta.url)) } : {}),
      ...(page === 'desktop' ? createDesktopPreviewOptions(root) : {}),
      server: { host: '127.0.0.1', port, strictPort: true, open: open ? `${url.pathname}${url.search}` : false },
    })
    await server.listen()
    startedServer = server
    console.log(`实时预览：${url}`)
  }
  if (embed) {
    try {
      const path = await ensureEmbeddedMobileUi(workspace || process.cwd())
      const cli = process.env.SUPERHIGH_CLI || (process.platform === 'win32' ? join(root, '.superhigh', 'cache', 'desktop-runtime', 'superhigh-cli.exe') : 'superhigh-cli')
      const { stdout } = await promisify(execFile)(cli, ['files', 'open', path, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
      const result = JSON.parse(stdout)
      if (result.ok === false || !result.path) throw new Error(result.error || 'CLI 未确认打开文件')
      console.log(`已在 Super High 代码预览打开：${result.path}`)
    } catch (error) {
      if (startedServer) await startedServer.close()
      throw new Error(`打开 IUI 失败：${error.stderr?.trim() || error.message}`)
    }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
