import { describe, expect, it } from 'vitest'

import { parseProjectItemLibraryMainSource } from './itemLibraryConfig'

describe('parseProjectItemLibraryMainSource', () => {
  it('accepts a versioned NI or MM main source', () => {
    expect(parseProjectItemLibraryMainSource('{"version":1,"mainSource":"ni"}')).toBe('ni')
    expect(parseProjectItemLibraryMainSource('{"version":1,"mainSource":"mm"}')).toBe('mm')
  })

  it('ignores invalid or unsupported config', () => {
    expect(parseProjectItemLibraryMainSource('{"version":1,"mainSource":"other"}')).toBeNull()
    expect(parseProjectItemLibraryMainSource('{"version":2,"mainSource":"ni"}')).toBeNull()
    expect(parseProjectItemLibraryMainSource('not json')).toBeNull()
  })
})
