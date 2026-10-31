import { describe, expect, it } from 'vitest'
import { createSourceOverlay, mergeDirectoryListing, previewParentPath, type SourceOverlayState } from './workspaceSource'
import type { DirectoryListing } from '@/types'

const ROOT = 'D:/Super High'

function listing(path: string, entries: Array<{ name: string, type: 'file' | 'directory' }>): DirectoryListing {
  return {
    path,
    entries: entries.map((entry) => ({ name: entry.name, path: `${path}/${entry.name}`, type: entry.type })),
  }
}

function names(path: string, overlay: SourceOverlayState, entries: Array<{ name: string, type: 'file' | 'directory' }>) {
  return mergeDirectoryListing(listing(path, entries), overlay).entries.map((entry) => `${entry.type === 'directory' ? 'dir' : 'file'}:${entry.name}`)
}

describe('preview source overlay', () => {
  it('keeps real entries and sorts directories first', () => {
    const overlay = createSourceOverlay()
    expect(names(ROOT, overlay, [{ name: 'src', type: 'directory' }, { name: 'AGENTS.md', type: 'file' }])).toEqual(['dir:src', 'file:AGENTS.md'])
  })
  it('adds created files and directories to their parent listing', () => {
    const overlay = createSourceOverlay()
    overlay.files.set('d:/super high/notes.md', { path: `${ROOT}/notes.md`, content: 'hello' })
    overlay.directories.set('d:/super high/tmp', `${ROOT}/tmp`)
    expect(names(ROOT, overlay, [{ name: 'src', type: 'directory' }])).toEqual(['dir:src', 'dir:tmp', 'file:notes.md'])
    expect(names(`${ROOT}/src`, overlay, [])).toEqual([])
  })
  it('hides deleted entries including their children', () => {
    const overlay = createSourceOverlay()
    overlay.removed.add('d:/super high/src')
    expect(names(ROOT, overlay, [{ name: 'src', type: 'directory' }, { name: 'package.json', type: 'file' }])).toEqual(['file:package.json'])
    expect(names(`${ROOT}/src`, overlay, [{ name: 'main.ts', type: 'file' }])).toEqual([])
  })
  it('renames real entries in place without dropping siblings', () => {
    const overlay = createSourceOverlay()
    overlay.renamed.set('d:/super high/readme.md', `${ROOT}/介绍.md`)
    const merged = mergeDirectoryListing(listing(ROOT, [{ name: 'README.md', type: 'file' }, { name: 'src', type: 'directory' }]), overlay)
    expect(merged.entries.map((entry) => entry.name)).toEqual(['src', '介绍.md'])
    expect(merged.entries[1].path).toBe(`${ROOT}/介绍.md`)
  })
  it('replaces overlaid files with their browser copy', () => {
    const overlay = createSourceOverlay()
    overlay.files.set('d:/super high/package.json', { path: `${ROOT}/package.json`, content: '{}' })
    const merged = mergeDirectoryListing(listing(ROOT, [{ name: 'package.json', type: 'file' }]), overlay)
    expect(merged.entries).toHaveLength(1)
    expect(merged.entries[0].path).toBe(`${ROOT}/package.json`)
  })
  it('computes parent paths for nested entries', () => {
    expect(previewParentPath(`${ROOT}/src/main.ts`)).toBe(`${ROOT}/src`.toLowerCase())
    expect(previewParentPath(`${ROOT}/AGENTS.md`)).toBe(ROOT.toLowerCase())
  })
})
