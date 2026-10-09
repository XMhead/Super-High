import { copyFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const dist = join(process.cwd(), 'dist-mobile')
const source = join(dist, 'index.mobile.html')
const target = join(dist, 'index.html')

try {
  await stat(source)
  await copyFile(source, target)
} catch (error) {
  console.error(`Mobile build output is missing: ${source}`)
  throw error
}
