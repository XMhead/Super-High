import { describe, expect, it } from 'vitest'
import { buildBreadcrumbs, buildWorkspaceBreadcrumbs, fileNameFromPath, inferLanguage, isPreviewableImage } from './path'

describe('path helpers', () => {
  it('builds breadcrumb segments from a windows path', () => {
    expect(buildBreadcrumbs('D:\\Code\\Super High\\src\\App.vue')).toEqual([
      { label: 'D:', path: 'D:/' },
      { label: 'Code', path: 'D:/Code' },
      { label: 'Super High', path: 'D:/Code/Super High' },
      { label: 'src', path: 'D:/Code/Super High/src' },
      { label: 'App.vue', path: 'D:/Code/Super High/src/App.vue' },
    ])
  })

  it('uses an absolute drive-root breadcrumb instead of a drive-relative path', () => {
    expect(buildBreadcrumbs('D:/')[0]).toEqual({ label: 'D:', path: 'D:/' })
  })

  it('removes a leading slash before windows drive paths', () => {
    expect(buildBreadcrumbs('/D:/Super High/src/App.vue')[0]).toEqual({ label: 'D:', path: 'D:/' })
  })

  it('builds compact breadcrumbs relative to the workspace root', () => {
    expect(buildWorkspaceBreadcrumbs(
      'D:/Work/server/plugins/Orryx/buffs.yml',
      'D:/Work/server/plugins',
    )).toEqual([
      {
        label: 'Orryx',
        path: 'D:/Work/server/plugins/Orryx',
      },
      {
        label: 'buffs.yml',
        path: 'D:/Work/server/plugins/Orryx/buffs.yml',
      },
    ])
  })

  it('derives file names and monaco-friendly language ids', () => {
    expect(fileNameFromPath('D:\\Code\\demo\\README.md')).toBe('README.md')
    expect(inferLanguage('index.ts')).toBe('typescript')
    expect(inferLanguage('Cargo.toml')).toBe('ini')
    expect(inferLanguage('README.md')).toBe('markdown')
    expect(inferLanguage('tools/build.py')).toBe('python')
  })

  it('detects previewable image files by extension', () => {
    expect(isPreviewableImage('D:\\Code\\sprites\\player.PNG')).toBe(true)
    expect(isPreviewableImage('D:/Code/anim.gif')).toBe(true)
    expect(isPreviewableImage('D:/Code/main.ts')).toBe(false)
  })
})
