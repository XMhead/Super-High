import { describe, expect, it } from 'vitest'

import {
  MEDIA_IMAGE_EXTENSIONS,
  MEDIA_VIDEO_EXTENSIONS,
  buildBreadcrumbs,
  buildWorkspaceBreadcrumbs,
  fileNameFromPath,
  inferLanguage,
  isMediaFile,
  isMediaImage,
  isMediaVideo,
  isPreviewableImage,
  isRasterMediaImage,
} from './path'

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
    expect(buildBreadcrumbs('/D:/Demo Files/src/App.vue')[0]).toEqual({ label: 'D:', path: 'D:/' })
  })

  it('builds compact breadcrumbs relative to the workspace root', () => {
    expect(buildWorkspaceBreadcrumbs(
      'D:/示例项目/示例项目服务端/示例项目服务端/plugins/Orryx/buffs.yml',
      'D:/示例项目/示例项目服务端/示例项目服务端/plugins',
    )).toEqual([
      {
        label: 'Orryx',
        path: 'D:/示例项目/示例项目服务端/示例项目服务端/plugins/Orryx',
      },
      {
        label: 'buffs.yml',
        path: 'D:/示例项目/示例项目服务端/示例项目服务端/plugins/Orryx/buffs.yml',
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

  it.each([
    ['scripts/build.pyw', 'python'],
    ['scripts/start.bat', 'bat'],
    ['scripts/start.cmd', 'bat'],
    ['scripts/setup.ps1', 'powershell'],
    ['scripts/deploy.sh', 'shell'],
    ['database/schema.sql', 'sql'],
    ['native/main.cpp', 'cpp'],
    ['server/Main.java', 'java'],
    ['infra/main.tf', 'hcl'],
    ['Dockerfile.dev', 'dockerfile'],
    ['.env.local', 'ini'],
  ])('detects syntax highlighting for %s', (path, language) => {
    expect(inferLanguage(path)).toBe(language)
  })

  it('detects previewable image files by extension', () => {
    expect(isPreviewableImage('D:\\Code\\sprites\\player.PNG')).toBe(true)
    expect(isPreviewableImage('D:/Code/anim.gif')).toBe(true)
    expect(isPreviewableImage('D:/Code/main.ts')).toBe(false)
  })
})

describe('media path detection', () => {
  it('recognizes every supported image and video extension', () => {
    for (const extension of MEDIA_IMAGE_EXTENSIONS) {
      expect(isMediaImage(`D:/Media/sample${extension}`)).toBe(true)
      expect(isMediaFile(`D:/Media/sample${extension}`)).toBe(true)
    }
    for (const extension of MEDIA_VIDEO_EXTENSIONS) {
      expect(isMediaVideo(`D:/Media/sample${extension}`)).toBe(true)
      expect(isMediaFile(`D:/Media/sample${extension}`)).toBe(true)
    }
  })

  it('handles uppercase extensions and rejects ordinary files', () => {
    expect(isMediaImage('D:/Media/ICON.PNG')).toBe(true)
    expect(isMediaVideo('D:/Media/CLIP.MP4')).toBe(true)
    expect(isMediaFile('D:/Media/notes.txt')).toBe(false)
    expect(isMediaFile('D:/Media/png')).toBe(false)
  })

  it('applies pixel rendering only to raster images', () => {
    expect(isRasterMediaImage('D:/Media/icon.png')).toBe(true)
    expect(isRasterMediaImage('D:/Media/vector.svg')).toBe(false)
    expect(isRasterMediaImage('D:/Media/video.mp4')).toBe(false)
  })
})
