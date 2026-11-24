import { copyFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { recordMobileBuild } from './mobile-build-cache.mjs'

const dist = join(process.cwd(), 'dist-mobile')
const source = join(dist, 'index.mobile.html')
const target = join(dist, 'index.html')

try {
  await stat(source)
  await copyFile(source, target)
  recordMobileBuild(process.cwd())
} catch (error) {
  console.error(`Mobile build output is missing: ${source}`)
  throw error
}
