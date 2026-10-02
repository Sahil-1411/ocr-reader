/**
 * Working with a reading the reader already produced.
 *
 * Nothing here reads anything: the rows arrive from `python/reader/` and these
 * are the three things the page does with them — list the cells, change one by
 * hand, and shape the whole thing for export.
 */

import type { OcrResult } from './types'

/**
 * `cells` with a blank for every title it does not reach.
 *
 * Padded, never cut: a page whose last column title the reader did not see
 * still printed the cells under it, and the export titles those `Column 3`
 * rather than dropping them.
 */
function padCells(cells: readonly string[], width: number): string[] {
  const padded = [...cells]
  while (padded.length < width) padded.push('')
  return padded
}

/** Each row's cells, left to right in the order the page prints its columns. */
export function rowCells(result: OcrResult): string[][] {
  return result.rows.map((row) => padCells(row.cells, result.headers.length))
}

/** `result` with one cell of `rowCells(result)` replaced by `value`. */
export function withCell(
  result: OcrResult,
  rowIndex: number,
  cellIndex: number,
  value: string,
): OcrResult {
  return {
    ...result,
    rows: result.rows.map((row, index) => {
      if (index !== rowIndex) return row
      const cells = padCells(row.cells, result.headers.length)
      if (cellIndex < 0 || cellIndex >= cells.length) return row
      cells[cellIndex] = value
      return { ...row, cells }
    }),
  }
}

/**
 * The JSON shown in the app: one kind, and only that kind's columns, each row
 * keyed by the column header exactly as the page prints it.
 */
export function toPublicJson(result: OcrResult): {
  kind: OcrResult['kind']
  title?: string
  headers: string[]
  rows: Record<string, string>[]
} {
  const { headers, title } = result
  return {
    kind: result.kind,
    ...(title ? { title } : {}),
    headers,
    rows: rowCells(result).map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
    ),
  }
}
