/**
 * The whole document as one export: every page's rows, in page order.
 *
 * A multi-page invoice is one table printed across pages, so its export is
 * one table too, with each row's page kept beside it. A single image or a
 * one-page PDF exports exactly as the page does, so nothing that already
 * reads those files has to change.
 */

import { rowCells, toPublicJson } from '../ocr/receipt/assemble'
import type { OcrResult, ReceiptKind, SkipReason } from '../ocr/types'

/** One read page of the document, numbered from 1. */
export interface ExportPage {
  page: number
  result: OcrResult
}

/** An extra table as the JSON carries it. */
export interface ExtraTableJson {
  title: string
  headers: string[]
  rows: Array<Record<string, string | number>>
}

export interface DocumentJson {
  /** The pages' kind when they agree, `mixed` when they do not. */
  kind: ReceiptKind | 'mixed'
  title?: string
  /** Pages in the document. */
  pages: number
  /** Pages with no rows here because they were not read, or could not be. */
  missingPages?: number[]
  /** Every page's column headers, in the order they first appear. */
  headers: string[]
  /** Each row keyed by its headers, with the page it was printed on. */
  rows: Array<Record<string, string | number>>
  /**
   * Tables printed under the pages' own, such as an invoice's
   * `Previous Balances`. Absent when the document prints none.
   */
  tables?: ExtraTableJson[]
}

export type ExportJson = ReturnType<typeof toPublicJson> | DocumentJson

/**
 * The document's rows as JSON: the page's own shape for a one-page
 * document, one table for a longer one — however many of its pages were read.
 */
export function toDocumentJson(
  pages: readonly ExportPage[],
  total: number,
  /**
   * Extra tables to leave out, by `ExtraTable.key`. A page can print a recap
   * or a tax summary under its own table, and whether that belongs in the
   * export is the reader's judgement, not something the geometry can settle.
   */
  dropped?: ReadonlySet<string>,
): ExportJson | null {
  const [first] = pages
  if (!first) return null
  const extras = extraTables(pages).filter((table) => !dropped?.has(table.key))
  const tables = extras.length > 0 ? { tables: extras.map((table) => toTableJson(table, total)) } : {}
  if (total <= 1) return { ...toPublicJson(first.result), ...tables }

  const layout = documentLayout(pages)
  const title = pages.map(({ result }) => result.title).find(Boolean)
  const missing = missingPages(pages, total)
  return {
    kind: layout.kind,
    ...(title ? { title } : {}),
    pages: total,
    ...(missing.length > 0 ? { missingPages: missing } : {}),
    headers: layout.keys,
    rows: pages.flatMap(({ page, result }) => {
      const columns = layout.columnsOf(result)
      return rowCells(result).map((cells) => {
        const row: Record<string, string | number> = { [layout.pageKey]: page }
        layout.keys.forEach((key) => {
          row[key] = ''
        })
        columns.forEach((column, index) => {
          row[layout.keys[column]!] = cells[index] ?? ''
        })
        return row
      })
    }),
    ...tables,
  }
}

/**
 * The document's rows as CSV.
 *
 * Cells go by position under each page's own headers rather than by name, so
 * a table that prints two columns with the same title loses neither. A longer
 * document gets a `Page` column first.
 */
export function toCsv(pages: readonly ExportPage[], total: number): string {
  const [first] = pages
  if (!first) return ''
  if (total <= 1) {
    return csvLines([headersOf(first.result), ...rowCells(first.result)])
  }

  const layout = documentLayout(pages)
  const lines: string[][] = [[layout.pageTitle, ...layout.headers]]
  for (const { page, result } of pages) {
    const columns = layout.columnsOf(result)
    for (const cells of rowCells(result)) {
      const row = layout.headers.map(() => '')
      columns.forEach((column, index) => {
        row[column] = cells[index] ?? ''
      })
      lines.push([String(page), ...row])
    }
  }
  return csvLines(lines)
}

/**
 * The columns of the whole document, and where each page's cells go.
 *
 * Taken from the pages that have rows: a blank page reads as some kind with
 * some headers, and neither says anything about the table. Each cell lands
 * under the column of its own title, the n-th `PRICE` of a page under the
 * document's n-th `PRICE`.
 */
function documentLayout(pages: readonly ExportPage[]) {
  const filled = pages.filter(({ result }) => rowCells(result).length > 0)
  const source = filled.length > 0 ? filled : pages
  const kinds = new Set(source.map(({ result }) => result.kind))
  const headers: string[] = []
  for (const { result } of source) {
    const own = headersOf(result)
    own.forEach((header, index) => {
      if (nth(headers, header, occurrence(own, index)) < 0) headers.push(header)
    })
  }
  // JSON keys must be unique where printed titles need not be.
  const keys = headers.map((header, index) => {
    const count = occurrence(headers, index)
    return count === 0 ? header : `${header} (${count + 1})`
  })
  return {
    kind: kinds.size === 1 ? [...kinds][0]! : ('mixed' as const),
    headers,
    keys,
    pageTitle: headers.includes('Page') ? 'PDF Page' : 'Page',
    pageKey: keys.includes('page') ? 'pdfPage' : 'page',
    columnsOf: (result: OcrResult) => {
      const own = headersOf(result)
      return own.map((header, index) => nth(headers, header, occurrence(own, index)))
    },
  }
}

/**
 * A page's headers, one per cell. A row can carry more cells than the page
 * printed titles for, and those cells are data too.
 */
function headersOf(result: OcrResult): string[] {
  const width = Math.max(result.headers.length, ...rowCells(result).map((cells) => cells.length))
  return Array.from({ length: width }, (_, index) => result.headers[index] ?? `Column ${index + 1}`)
}

function missingPages(pages: readonly ExportPage[], total: number): number[] {
  const read = new Set(pages.map(({ page }) => page))
  return Array.from({ length: total }, (_, index) => index + 1).filter((page) => !read.has(page))
}

/** How many times `headers[index]` has already appeared before `index`. */
function occurrence(headers: readonly string[], index: number): number {
  return headers.slice(0, index).filter((header) => header === headers[index]).length
}

/** Where the `count`-th (from 0) `header` sits in `headers`, or -1. */
function nth(headers: readonly string[], header: string, count: number): number {
  let seen = -1
  return headers.findIndex((candidate) => candidate === header && ++seen === count)
}

function csvLines(lines: readonly (readonly string[])[]): string {
  return lines.map((cells) => cells.map(escapeCsv).join(',')).join('\r\n')
}

function escapeCsv(value: string | undefined): string {
  const text = value ?? ''
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/* -------------------------------------------------------------------------- */
/* Skipped & removed                                                           */
/* -------------------------------------------------------------------------- */

/** A page the reader never produced rows for, and why. */
export interface PageFailure {
  page: number
  /** The error as the reader reported it, or why the page was not reached. */
  message: string
}

/** One line, note, or whole page that is not in the data export. */
export interface SkippedEntry {
  page: number
  /** The reader's own reason, for a caller that wants to group the log. */
  reason: SkipReason | 'page-error'
  /** What that reason means, in the words the log shows. */
  what: string
  /** The printed line, the note that was cut, or the page's error. */
  text: string
  /** Mean word confidence in [0, 1]. Absent for a page that was never read. */
  confidence?: number
}

export interface SkippedJson {
  /** Pages in the document. */
  pages: number
  /** Entries in the log. */
  skipped: number
  /** Pages that produced no rows at all. */
  failedPages?: number[]
  rows: SkippedEntry[]
}

/** What each reason means, in the words the log shows. */
const SKIP_REASON: Record<SkipReason | 'page-error', string> = {
  note: 'Note removed from the line',
  furniture: 'Page header, footer, or banner',
  'repeated-header': 'Column header printed again',
  summary: 'Totals or subtotal line',
  unplaced: 'Line that belongs to no item',
  'page-error': 'Page produced no rows',
}

/**
 * Everything the read left out, in page order: the lines each page's reader
 * printed over, and the pages that produced nothing at all.
 *
 * Kept apart from the data export so the rows a caller imports stay exactly
 * the rows the document prints, while the account of the rest is still there
 * to check a reading against the page.
 */
export function toSkippedLog(
  pages: readonly ExportPage[],
  total: number,
  failures: readonly PageFailure[] = [],
): SkippedJson {
  const rows: SkippedEntry[] = []
  for (const { page, result } of pages) {
    for (const line of result.skipped) {
      rows.push({
        page,
        reason: line.reason,
        what: SKIP_REASON[line.reason],
        text: line.text,
        confidence: Math.round(line.confidence * 100) / 100,
      })
    }
  }
  for (const { page, message } of failures) {
    rows.push({ page, reason: 'page-error', what: SKIP_REASON['page-error'], text: message })
  }
  rows.sort((a, b) => a.page - b.page)
  const failed = failures.map(({ page }) => page).sort((a, b) => a - b)
  return {
    pages: total,
    skipped: rows.length,
    ...(failed.length > 0 ? { failedPages: failed } : {}),
    rows,
  }
}

/** The same log as CSV, with a `Page` column however long the document is. */
export function toSkippedCsv(
  pages: readonly ExportPage[],
  total: number,
  failures: readonly PageFailure[] = [],
): string {
  const log = toSkippedLog(pages, total, failures)
  const lines: string[][] = [['Page', 'Reason', 'Text', 'Confidence']]
  for (const row of log.rows) {
    lines.push([
      String(row.page),
      row.what,
      row.text,
      row.confidence === undefined ? '' : row.confidence.toFixed(2),
    ])
  }
  return csvLines(lines)
}

/* -------------------------------------------------------------------------- */
/* Tables printed under the main one                                           */
/* -------------------------------------------------------------------------- */

/**
 * A table printed under the page's own, gathered across the pages it appears
 * on: an invoice's `Previous Balances`, a recap of the order by category.
 *
 * Kept out of the data export, which is the document's own table, and
 * downloaded on its own.
 */
export interface ExtraTable {
  /** The heading printed over it, or a name made from its columns. */
  title: string
  /** That title as a file name's tail: `previous-balances`. */
  slug: string
  /**
   * What makes this table itself: its heading and its columns, which is also
   * what gathers the same table across pages into one. Two tables can slugify
   * alike — `Tax Summary` and `Tax, Summary` — so the slug cannot be it, and
   * a position cannot either: reading another page can add a table above this
   * one, and a table dropped by hand must not come back as a different one.
   */
  key: string
  headers: string[]
  /** Its rows, each with the page it was printed on. */
  rows: Array<{ page: number; cells: string[] }>
}

/**
 * Every table printed under the pages' own, in the order they appear.
 *
 * The same table printed on several pages is one table here, so a balance
 * list repeated per page downloads once with a `Page` column.
 */
export function extraTables(pages: readonly ExportPage[]): ExtraTable[] {
  const found = new Map<string, ExtraTable>()
  for (const { page, result } of pages) {
    result.tables.slice(1).forEach((table, index) => {
      // A table with no heading of its own is named for its first column,
      // which is what it is a table of — `Category Description`, `Date`.
      const title = table.title?.trim() || table.headers[0]?.trim() || `Table ${index + 2}`
      const key = `${title}\u0000${table.headers.join('\u0000')}`
      const existing = found.get(key)
      const rows = table.rows.map((row) => ({ page, cells: [...row.cells] }))
      if (existing) existing.rows.push(...rows)
      else found.set(key, { title, slug: slugify(title), key, headers: [...table.headers], rows })
    })
  }
  return [...found.values()]
}

/** `Previous Balances` → `previous-balances`, for a file name. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'table'
}

/**
 * One extra table as JSON, with the page each row was printed on.
 *
 * The same shape the document's own `tables` carries, so a table taken on its
 * own and the same table inside the whole export read alike.
 */
export function toTableJson(table: ExtraTable, total: number): ExtraTableJson {
  return {
    title: table.title,
    headers: [...table.headers],
    rows: table.rows.map((row) => ({
      ...(total > 1 ? { page: row.page } : {}),
      ...Object.fromEntries(
        table.headers.map((header, index) => [header, row.cells[index] ?? '']),
      ),
    })),
  }
}

/** One extra table as CSV, with a `Page` column when the document has pages. */
export function toTableCsv(table: ExtraTable, total: number): string {
  const paged = total > 1
  const pageTitle = table.headers.includes('Page') ? 'PDF Page' : 'Page'
  const lines: string[][] = [paged ? [pageTitle, ...table.headers] : [...table.headers]]
  for (const row of table.rows) {
    const cells = table.headers.map((_, index) => row.cells[index] ?? '')
    lines.push(paged ? [String(row.page), ...cells] : cells)
  }
  return csvLines(lines)
}
