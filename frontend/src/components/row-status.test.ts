import { describe, expect, it } from 'vitest'

import { REVIEW_THRESHOLD, rowViews, validCount, type PageRows } from './row-status'
import { rowCells, withCell } from '../ocr/result'
import type { OcrResult } from '../ocr/types'

/**
 * A reading as the API returns one: cells under headers, nothing kind-specific.
 */
function read(
  headers: string[],
  rows: Array<{ cells: string[]; confidence?: number; label?: boolean }>,
  extra: Partial<OcrResult> = {},
): OcrResult {
  return {
    kind: 'table',
    headers,
    rows: rows.map(({ cells, confidence = 1, label }) => ({
      cells,
      confidence,
      ...(label ? { label: true } : {}),
    })),
    tables: [],
    validation: [],
    skipped: [],
    processingMeta: {
      reader: 'pdf text',
      sourceSize: { width: 1700, height: 2200 },
      wordCount: 0,
      warnings: [],
    },
    ...extra,
  }
}

const page = (result: OcrResult, over: Partial<PageRows> = {}): PageRows => ({
  index: 0,
  result,
  edited: new Set(),
  validated: new Set(),
  ...over,
})

const HEADERS = ['QTY', 'DESCRIPTION', 'PRICE']

describe('rowViews', () => {
  it('leaves a row alone when it reads cleanly and whole', () => {
    const [row] = rowViews(page(read(HEADERS, [{ cells: ['1', 'MINT SNUFF', '31.20'] }])))
    expect(row).toMatchObject({ review: false, flagged: false, edited: false, validated: false })
  })

  it('asks for a look at a row the reader was unsure of', () => {
    const [row] = rowViews(
      page(read(HEADERS, [{ cells: ['1', 'MINT SNUFF', '31.20'], confidence: 0.3 }])),
    )
    expect(row.review).toBe(true)
    expect(row.confidence).toBeLessThan(REVIEW_THRESHOLD)
  })

  it('asks for a look at a table row with fewer than two cells read', () => {
    const rows = rowViews(
      page(read(HEADERS, [{ cells: ['', 'MINT SNUFF', ''] }, { cells: ['1', 'HERB CAN', '52.40'] }])),
    )
    expect(rows.map((row) => row.review)).toEqual([true, false])
  })

  it('does not ask for a look at a printed label, which is one cell by nature', () => {
    const [row] = rowViews(
      page(read(HEADERS, [{ cells: ['', '***DAMAGED IN TRANSIT***', ''], label: true }])),
    )
    expect(row.label).toBe(true)
    expect(row.review).toBe(false)
  })

  it('carries the checks onto the rows they name', () => {
    const result = read(HEADERS, [
      { cells: ['1', 'MINT SNUFF', '31.20'] },
      { cells: ['2', 'LEAF BAG', '17.35'] },
    ])
    result.validation = [
      { code: 'inventory-totals', message: 'the int column does not add up', rows: [1] },
      { code: 'inventory-solved', message: 'solved from TOTALS', rows: [0] },
    ]
    const rows = rowViews(page(result))
    expect(rows.map((row) => row.flagged)).toEqual([false, true])
    expect(rows.map((row) => row.solved)).toEqual([true, false])
    // Solved is not flagged: the count is known, it just was not read.
    expect(rows[0]!.review).toBe(false)
  })

  it('settles a flagged row once somebody accepts it', () => {
    const result = read(HEADERS, [{ cells: ['1', 'MINT SNUFF', '31.20'], confidence: 0.2 }])
    expect(rowViews(page(result))[0]!.review).toBe(true)
    const accepted = rowViews(page(result, { validated: new Set([0]) }))[0]!
    // What was read has not changed — only whether it still wants someone.
    expect(accepted.review).toBe(false)
    expect(accepted.confidence).toBe(0.2)
    expect(accepted.validated).toBe(true)
  })
})

describe('validCount', () => {
  it('counts the rows that no longer want a look', () => {
    const result = read(HEADERS, [
      { cells: ['1', 'MINT SNUFF', '31.20'] },
      { cells: ['2', 'LEAF BAG', '17.35'], confidence: 0.1 },
      { cells: ['', 'HERB CAN', ''] },
    ])
    expect(validCount(page(result))).toEqual({ total: 3, valid: 1 })
    expect(validCount(page(result, { validated: new Set([1, 2]) }))).toEqual({ total: 3, valid: 3 })
  })
})

describe('rowCells and withCell', () => {
  it('pads a row out to the titles it does not reach', () => {
    expect(rowCells(read(HEADERS, [{ cells: ['1'] }]))).toEqual([['1', '', '']])
  })

  it('keeps a cell the page printed no title for', () => {
    // A page whose last title was not read still printed the cells under it.
    expect(rowCells(read(['A', 'B'], [{ cells: ['1', '2', '3'] }]))).toEqual([['1', '2', '3']])
  })

  it('changes one cell and leaves the rest of the reading alone', () => {
    const before = read(HEADERS, [
      { cells: ['1', 'MINT SNUF', '31.20'] },
      { cells: ['2', 'LEAF BAG', '17.35'] },
    ])
    const after = withCell(before, 0, 1, 'MINT SNUFF')
    expect(rowCells(after)).toEqual([
      ['1', 'MINT SNUFF', '31.20'],
      ['2', 'LEAF BAG', '17.35'],
    ])
    // The reading it was made from is untouched, so a reset can go back to it.
    expect(rowCells(before)[0]).toEqual(['1', 'MINT SNUF', '31.20'])
  })

  it('ignores a cell index the row does not have', () => {
    const before = read(HEADERS, [{ cells: ['1', 'MINT SNUFF', '31.20'] }])
    expect(withCell(before, 0, 9, 'nowhere')).toEqual(before)
  })
})
