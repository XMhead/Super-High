import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseDragonCoreGui } from './dragonCoreEditor'

const corpusRoot = process.env.DRAGONCORE_GUI_ROOT?.trim()

describe.skipIf(!corpusRoot)('DragonCore GUI corpus', () => {
  it('indexes every yml and yaml without crashing on recoverable syntax errors', async () => {
    const files: string[] = []
    const visit = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await visit(path)
        else if (/\.ya?ml$/i.test(entry.name)) files.push(path)
      }
    }
    await visit(corpusRoot!)

    const results = files.map((path) => parseDragonCoreGui(relative(corpusRoot!, path).replace(/\\/g, '/'), readFileSync(path, 'utf8')))

    expect(results).toHaveLength(files.length)
    expect(files.length).toBeGreaterThan(500)
    expect(results.every((result) => result.hash && Array.isArray(result.components))).toBe(true)
  })
})
