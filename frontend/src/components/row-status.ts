/**
 * Where each row of a reading stands: what was read, how sure the reader was,
 * and whether anyone has had to look at it.
 *
 * Kept apart from the table that draws it so the count above the table and the
 * rows inside it are the same judgement, made once.
 */

import { rowCells } from '../ocr/receipt/assemble'
import type { OcrResult } from '../ocr/types'

/** One page's rows as the table shows them. */
export interface PageRows {
  /** 0-based index in the document. */
  index: number
  result: OcrResult
  edited: ReadonlySet<number>
  /** Rows someone has looked at and accepted. */
  validated: ReadonlySet<number>
}

/** One row of one page, with what the table needs to show and filter it. */
export interface RowView {
  page: PageRows
  /** Row index within its page. */
  index: number
  cells: string[]
  confidence: number
  /** Contradicts the page's own arithmetic, or could not be read. */
  flagged: boolean
  /** Solved from TOTALS: known, just not read. */
  solved: boolean
  /** Flagged, low confidence, or missing cells, and nobody has said otherwise. */
  review: boolean
  edited: boolean
  /** Accepted by hand, which settles a row the checks were unsure of. */
  validated: boolean
  label: boolean
}

/** Readings below this confidence are flagged for a human to check. */
export const REVIEW_THRESHOLD = 0.55

/** A printed label among the items: one cell by nature, not a row missing data. */
export function isLabelRow(result: OcrResult, index: number): boolean {
  return result.kind === 'table' && result.tableRows[index]?.label === true
}

function rowIsIncomplete(result: OcrResult, row: readonly string[], index: number): boolean {
  if (isLabelRow(result, index)) return false
  if (result.kind === 'table') return row.filter((cell) => cell.trim()).length < 2
  return row.some((cell) => cell.trim() === '')
}

function rowConfidences(result: OcrResult): number[] {
  switch (result.kind) {
    case 'inventory':
      return result.rows.map((row) => row.confidence)
    case 'settlements':
      return result.settlements.map((row) => row.confidence)
    case 'invoice':
      return result.fields.map((row) => row.confidence)
    case 'table':
      return result.tableRows.map((row) => row.confidence)
    default: {
      const unreachable: never = result.kind
      return unreachable
    }
  }
}

export function rowViews(page: PageRows, reviewThreshold = REVIEW_THRESHOLD): RowView[] {
  const { result, edited, validated } = page
  const issues = (solved: boolean) =>
    new Set(
      result.validation
        .filter((issue) => (issue.code === 'inventory-solved') === solved)
        .flatMap((issue) => issue.rows),
    )
  const flagged = issues(false)
  const solved = issues(true)
  const confidences = rowConfidences(result)
  return rowCells(result).map((cells, index) => {
    const confidence = confidences[index] ?? 0
    const accepted = validated.has(index)
    const unsure =
      flagged.has(index) || confidence < reviewThreshold || rowIsIncomplete(result, cells, index)
    return {
      page,
      index,
      cells,
      confidence,
      flagged: flagged.has(index),
      solved: solved.has(index),
      // Accepting a row does not change what was read, only whether it is
      // still waiting on someone.
      review: unsure && !accepted,
      edited: edited.has(index),
      validated: accepted,
      label: isLabelRow(result, index),
    }
  })
}

/** Rows of a page, and how many of them no longer want a look. */
export interface ValidCount {
  total: number
  valid: number
}

/**
 * How much of a page has been settled, for the count above the table.
 *
 * A row counts as settled when nothing about it asks for a human: the checks
 * pass, it was read confidently, and it is whole — or someone has since said
 * so by accepting or correcting it.
 */
export function validCount(page: PageRows, reviewThreshold = REVIEW_THRESHOLD): ValidCount {
  const rows = rowViews(page, reviewThreshold)
  return { total: rows.length, valid: rows.filter((row) => !row.review).length }
}
