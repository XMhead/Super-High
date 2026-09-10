import { createServer } from 'vite'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

async function main() {
  const values = new Map()
  const keys = new Set(['section', 'theme', 'scenario', 'mode', 'persist', 'port'])
  let open = true
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index]
    if (argument === '--help') {
      console.log('npm run superhigh-html -- [--section general|appearance|config|shortcuts|mobile|cli|storage|updates|plugins|channels] [--theme <主题ID>] [--scenario ready|empty|error] [--mode simulate|readonly] [--persist 0|1] [--port 1422] [--no-open]')
      process.exit(0)
    }
    if (argument === '--no-open') { open = false; continue }
    const [key, ...parts] = argument.replace(/^--/, '').split('=')
    if (!argument.startsWith('--') || !keys.has(key)) throw new Error(`未知参数：${argument}`)
    const value = parts.length ? parts.join('=') : process.argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`缺少参数值：${key}`)
    values.set(key, value)
  }
  const port = Number(values.get('port') ?? 1422)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('port 必须为 1024–65535 的整数')
  values.delete('port')
  for (const [key, valid] of Object.entries({
    section: ['general', 'appearance', 'config', 'shortcuts', 'mobile', 'cli', 'storage', 'updates', 'plugins', 'channels'],
    scenario: ['ready', 'empty', 'error'], mode: ['simulate', 'readonly'], persist: ['0', '1'],
  })) {
    if (values.has(key) && !valid.includes(values.get(key))) throw new Error(`无效参数：${key}=${values.get(key)}`)
  }
  const url = new URL(`http://127.0.0.1:${port}/superhigh-html.html`)
  for (const [key, value] of values) url.searchParams.set(key, value)
  let reused = false
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    reused = response.ok && (await response.text()).includes('/src/preview/main.ts')
  } catch { /* No live preview; Vite checks whether the port is available. */ }
  if (reused) {
    console.log(`已复用实时预览：${url}`)
    if (open) {
      const [command, args] = process.platform === 'win32' ? ['explorer.exe', [url.href]] : process.platform === 'darwin' ? ['open', [url.href]] : ['xdg-open', [url.href]]
      execFile(command, args, { windowsHide: true }, error => { if (error) console.log(`请打开：${url}`) })
    }
  } else {
    const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port, strictPort: true, open: open ? `${url.pathname}${url.search}` : false } })
    await server.listen()
    console.log(`实时预览：${url}`)
  }

}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
