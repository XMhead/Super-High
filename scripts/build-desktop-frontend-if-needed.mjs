import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { desktopBuildNeeded } from './desktop-build-cache.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
if (args.length && (args.length !== 1 || args[0] !== '--check')) throw new Error('Usage: node scripts/build-desktop-frontend-if-needed.mjs [--check]')
const needed = desktopBuildNeeded(root)
console.log(needed ? '桌面前端资源已变化或缺少构建记录，需要构建。' : '桌面前端资源未变化，复用已有构建。')
if (args.length) process.exit(needed ? 1 : 0)
if (needed) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
