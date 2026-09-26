import { describe, expect, it } from 'vitest'
import { utils, write } from 'xlsx'
import { buildSheetPage, parseSpreadsheet, sheetSize } from './officeSpreadsheet'

describe('Office spreadsheet preview', () => {
  it('reads multiple sheets, Chinese text, number formats and cached formula results', () => {
    const book = utils.book_new()
    const sheet = utils.aoa_to_sheet([['奖励', '比例', '合计'], ['乾坤宝匣', 0.25, 42]])
    sheet.B2.z = '0%'
    sheet.C2.f = 'SUM(20,22)'
    utils.book_append_sheet(book, sheet, '乾坤宝匣基础')
    utils.book_append_sheet(book, utils.aoa_to_sheet([['<img src=x onerror=alert(1)>']]), '奖励')
    const parsed = parseSpreadsheet(new Uint8Array(write(book, { type: 'array', bookType: 'xlsx' })))
    expect(parsed.SheetNames).toEqual(['乾坤宝匣基础', '奖励'])
    const result = buildSheetPage(parsed.Sheets['乾坤宝匣基础'], { rows: 2, columns: 3 }, 0, 0)
    expect(result.rows[1].cells.map((cell) => cell.text)).toEqual(['乾坤宝匣', '25%', '42'])
    expect(result.rows[1].cells[2].title).toContain('SUM(20,22)')
    expect(buildSheetPage(parsed.Sheets['奖励'], { rows: 1, columns: 1 }, 0, 0).rows[0].cells[0].text)
      .toBe('<img src=x onerror=alert(1)>')
  })

  it('keeps merged content visible across row and column pages without rendering the whole sheet', () => {
    const sheet = utils.aoa_to_sheet([['开始']])
    sheet.AN200 = { t: 's', v: '跨页合并' }
    sheet['!merges'] = [{ s: { r: 199, c: 39 }, e: { r: 202, c: 42 } }]
    sheet.XFD1048576 = { t: 'z' }
    sheet.XFC1048575 = { t: 's', v: '' }
    sheet['!ref'] = 'A1:XFD1048576'
    expect(sheetSize(sheet)).toEqual({ rows: 203, columns: 43 })
    const result = buildSheetPage(sheet, sheetSize(sheet), 1, 1)
    expect(result.rows).toHaveLength(3)
    expect(result.columns).toHaveLength(3)
    expect(result.rows[0].cells).toEqual([expect.objectContaining({ text: '跨页合并', rowSpan: 3, colSpan: 3 })])
    expect(result.rows[1].cells).toEqual([])
  })
})
