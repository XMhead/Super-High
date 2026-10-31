import { describe, expect, it } from 'vitest'

import { terminalGridLayout } from './terminalGridLayout'

describe('terminalGridLayout', () => {
  it('fills a wide panel without leaving empty rows or cells', () => {
    expect(terminalGridLayout(4, 1840, 1000)).toEqual({ columns: 2, rows: 2, spans: [1, 1, 1, 1] })
    expect(terminalGridLayout(2, 1840, 1000)).toEqual({ columns: 2, rows: 1, spans: [1, 1] })
    expect(terminalGridLayout(1, 1840, 1000)).toEqual({ columns: 1, rows: 1, spans: [1] })
  })

  it('stretches an incomplete last row across the full width', () => {
    expect(terminalGridLayout(3, 1840, 1000)).toEqual({ columns: 2, rows: 2, spans: [1, 1, 2] })
    expect(terminalGridLayout(5, 1840, 1000)).toEqual({ columns: 6, rows: 2, spans: [2, 2, 2, 3, 3] })
  })

  it('stacks terminals in a narrow panel', () => {
    expect(terminalGridLayout(3, 600, 1200).columns).toBe(1)
  })
})
