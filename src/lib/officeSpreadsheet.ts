import { read, utils, type WorkBook, type WorkSheet } from 'xlsx'

export const SHEET_PAGE_ROWS = 200
export const SHEET_PAGE_COLUMNS = 40

export function parseSpreadsheet(bytes: Uint8Array): WorkBook {
  return read(bytes, { type: 'array', cellStyles: true, cellHTML: false, cellFormula: true })
}

export function sheetSize(sheet: WorkSheet) {
  let rows = 0
  let columns = 0
  // Excel often includes thousands of styled but empty cells in !ref.
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue
    const cell = sheet[address]
    if ((cell?.v == null || cell.v === '') && !cell?.f) continue
    const position = utils.decode_cell(address)
    rows = Math.max(rows, position.r + 1)
    columns = Math.max(columns, position.c + 1)
  }
  for (const merge of sheet['!merges'] ?? []) {
    rows = Math.max(rows, merge.e.r + 1)
    columns = Math.max(columns, merge.e.c + 1)
  }
  return { rows, columns }
}

export function buildSheetPage(sheet: WorkSheet, size: ReturnType<typeof sheetSize>, rowPage: number, columnPage: number) {
  const startRow = rowPage * SHEET_PAGE_ROWS
  const startColumn = columnPage * SHEET_PAGE_COLUMNS
  const endRow = Math.min(startRow + SHEET_PAGE_ROWS, size.rows)
  const endColumn = Math.min(startColumn + SHEET_PAGE_COLUMNS, size.columns)
  const merged = new Map<string, { address: string; rowSpan: number; colSpan: number } | null>()
  for (const range of sheet['!merges'] ?? []) {
    const top = Math.max(startRow, range.s.r)
    const left = Math.max(startColumn, range.s.c)
    const bottom = Math.min(endRow - 1, range.e.r)
    const right = Math.min(endColumn - 1, range.e.c)
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        merged.set(`${r}:${c}`, r === top && c === left
          ? { address: utils.encode_cell(range.s), rowSpan: bottom - top + 1, colSpan: right - left + 1 }
          : null)
      }
    }
  }
  const columns = Array.from({ length: endColumn - startColumn }, (_, i) => {
    const index = startColumn + i
    const info = sheet['!cols']?.[index]
    return { label: utils.encode_col(index), width: Math.max(80, Math.min(360, info?.wpx ?? 140)) }
  })
  const rows = Array.from({ length: endRow - startRow }, (_, i) => {
    const index = startRow + i
    const cells = []
    for (let c = startColumn; c < endColumn; c++) {
      const merge = merged.get(`${index}:${c}`)
      if (merge === null) continue
      const address = merge?.address ?? utils.encode_cell({ r: index, c })
      const cell = sheet[address]
      const text = cell ? utils.format_cell(cell) || (cell.f ? `=${cell.f}` : '') : ''
      cells.push({
        key: c, address, text,
        title: cell?.f ? `${address} · =${cell.f}\n${text}` : `${address}\n${text}`,
        numeric: cell?.t === 'n',
        rowSpan: merge?.rowSpan ?? 1, colSpan: merge?.colSpan ?? 1,
      })
    }
    return { number: index + 1, cells }
  })
  return { columns, rows, startRow, endRow, startColumn, endColumn }
}
