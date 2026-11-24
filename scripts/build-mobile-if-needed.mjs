import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mobileBuildNeeded } from './mobile-build-cache.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const check = process.argv.slice(2)
if (check.length && (check.length !== 1 || check[0] !== '--check')) throw new Error('Usage: node scripts/build-mobile-if-needed.mjs [--check]')
const needed = mobileBuildNeeded(root)
console.log(needed ? '手机资源已变化或缺少构建记录，需要构建。' : '手机资源未变化，复用已有构建。')
if (check.length) process.exit(needed ? 1 : 0)
if (needed) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['run', 'mobile:build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
