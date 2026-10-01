import { Fragment, useMemo, useState } from 'react'

import { extraTables, toTableCsv, type ExportPage } from '../lib/export'
import { exportBaseName, saveFile } from '../lib/download'
import { DownloadIcon } from './ExportButtons'
import { rowCells, toPublicJson } from '../ocr/receipt/assemble'
import type { OcrResult } from '../ocr/types'

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

interface FieldsViewProps {
  result: OcrResult
  /** Readings below this confidence are flagged for a human to check. */
  reviewThreshold?: number
  /** Rows the user has corrected by hand. */
  edited?: ReadonlySet<number>
  onEdit?: (rowIndex: number, cellIndex: number, value: string) => void
  /** Invoice or ticket heading, shown on the right of the toolbar. */
  title: string
  onResetEdits?: () => void
  /**
   * Every page read so far, when the document has several. A search looks
   * through all of them, not only the page on screen.
   */
  pages?: readonly PageRows[]
  /** Index of the page on screen within the document. */
  currentPage?: number
  /** Edit a row of any page: a search shows rows from all of them. */
  onEditPage?: (pageIndex: number, rowIndex: number, cellIndex: number, value: string) => void
  /** Show a page, from a search result's page number. */
  onOpenPage?: (pageIndex: number) => void
}

/** One page's rows as the table shows them. */
export interface PageRows {
  /** 0-based index in the document. */
  index: number
  result: OcrResult
  edited: ReadonlySet<number>
}

const EMPTY: Record<OcrResult['kind'], string> = {
  inventory: 'No inventory rows were read.',
  settlements: 'No pack settlements were read.',
  invoice: 'No invoice lines were read.',
  table: 'No table rows were read.',
}

/** The column that holds the description, which should stay left-aligned. */
function wideIndex(result: OcrResult): number {
  if (result.kind === 'invoice') return 0
  if (result.kind !== 'table') return 1
  const description = result.headers.findIndex((header) => /description|product|item name/i.test(header))
  return description >= 0 ? description : 0
}

/** Columns whose readings are numbers, so a header and its cells line up alike. */
function columnIsNumeric(result: OcrResult, index: number): boolean {
  if (result.kind === 'table') return isNumericHeader(result.headers[index] ?? '')
  return index !== wideIndex(result)
}

/** A column's class, which caps how wide its cells may grow. */
function columnClass(result: OcrResult, index: number): ColumnClass {
  if (columnIsNumeric(result, index)) return 'num'
  return index === wideIndex(result) ? 'col--wide' : 'col--text'
}

type ColumnClass = 'num' | 'col--text' | 'col--wide'

/** Characters a column's cells grow to before the reading is cut short on screen. */
const CELL_CHARS: Record<ColumnClass, number> = {
  num: 14,
  'col--text': 20,
  'col--wide': 34,
}

function rowIsIncomplete(result: OcrResult, row: readonly string[], index: number): boolean {
  if (isLabelRow(result, index)) return false
  if (result.kind === 'table') return row.filter((cell) => cell.trim()).length < 2
  return row.some((cell) => cell.trim() === '')
}

/** A printed label among the items: one cell by nature, not a row missing data. */
function isLabelRow(result: OcrResult, index: number): boolean {
  return result.kind === 'table' && result.tableRows[index]?.label === true
}

/** One row of one page, with what the table needs to show and filter it. */
interface RowView {
  page: PageRows
  /** Row index within its page. */
  index: number
  cells: string[]
  confidence: number
  /** Contradicts the page's own arithmetic, or could not be read. */
  flagged: boolean
  /** Solved from TOTALS: known, just not read. */
  solved: boolean
  /** Flagged, low confidence, or missing cells. */
  review: boolean
  edited: boolean
  label: boolean
}

function rowViews(page: PageRows, reviewThreshold: number): RowView[] {
  const { result, edited } = page
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
    return {
      page,
      index,
      cells,
      confidence,
      flagged: flagged.has(index),
      solved: solved.has(index),
      review: flagged.has(index) || confidence < reviewThreshold || rowIsIncomplete(result, cells, index),
      edited: edited.has(index),
      label: isLabelRow(result, index),
    }
  })
}

/** The kind's rows under the ticket's own column headers, with its checks above them. */
export function FieldsView({
  result,
  reviewThreshold = 0.55,
  edited = new Set(),
  onEdit,
  title,
  onResetEdits,
  pages,
  currentPage = 0,
  onEditPage,
  onOpenPage,
}: FieldsViewProps) {
  const { headers } = toPublicJson(result)
  const pageRowCount = rowCells(result).length

  const [query, setQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'all' | 'flagged' | 'edited'>('all')
  const q = query.trim().toLowerCase()

  // A search looks through every page read so far; without one, the table is
  // the page on screen.
  const allPages = useMemo<readonly PageRows[]>(
    () => (pages && pages.length > 1 ? pages : [{ index: currentPage, result, edited }]),
    [pages, currentPage, result, edited],
  )
  const acrossPages = q.length > 0 && allPages.length > 1
  const scope = useMemo(
    () =>
      (acrossPages ? allPages : [{ index: currentPage, result, edited }]).flatMap((page) =>
        rowViews(page, reviewThreshold),
      ),
    [acrossPages, allPages, currentPage, result, edited, reviewThreshold],
  )

  const { reader, warnings } = result.processingMeta
  const notices = useMemo(
    () => [
      ...(reader.includes('not running')
        ? ['This receipt was read in basic mode, so results may be less accurate. Check every row against the ticket.']
        : []),
      ...new Set(warnings),
    ],
    [reader, warnings],
  )

  const stats = useMemo(
    () => ({
      totalRows: scope.length,
      flaggedCount: scope.filter((row) => row.review).length,
      editedCount: scope.filter((row) => row.edited).length,
    }),
    [scope],
  )

  const filteredRows = useMemo(
    () =>
      scope.filter((row) => {
        if (filterMode === 'flagged' && !row.review) return false
        if (filterMode === 'edited' && !row.edited) return false
        return !q || row.cells.some((cell) => cell.toLowerCase().includes(q))
      }),
    [scope, filterMode, q],
  )
  const matchedPages = new Set(filteredRows.map((row) => row.page.index)).size

  const edit = (row: RowView, cellIndex: number, value: string) => {
    if (onEditPage) onEditPage(row.page.index, row.index, cellIndex, value)
    else if (row.page.index === currentPage) onEdit?.(row.index, cellIndex, value)
  }
  const editable = Boolean(onEditPage ?? onEdit)
  const sameHeaders = (other: OcrResult) => other.headers.join('\u0000') === headers.join('\u0000')

  return (
    <div className="fields-container">
      {/* Compact Slim Warning if issues exist */}
      {notices.length > 0 && (
        <div className="banner-slim" role="alert">
          <svg className="banner-slim__icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div className="banner-slim__text">
            <strong>{notices.length} warning{notices.length === 1 ? '' : 's'}:</strong>{' '}
            {notices.join(' · ')}
          </div>
        </div>
      )}

      {/* Search on the left, ticket title on the right. */}
      <div className="table-controls">
        <div className="table-controls__start">
          <div className="search-box">
          <svg className="search-box__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            role="searchbox"
            autoComplete="off"
            spellCheck={false}
            className="search-box__input"
            placeholder={allPages.length > 1 ? `Search all ${allPages.length} pages...` : 'Filter table rows...'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={allPages.length > 1 ? 'Search rows on every page' : 'Filter rows'}
          />
          {query && (
            <button
              type="button"
              className="search-box__clear"
              onClick={() => setQuery('')}
              aria-label="Clear filter"
              title="Clear search"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
          </div>

          <div className="filter-tabs" role="tablist">
          <button
            type="button"
            className={`filter-tab${filterMode === 'all' ? ' filter-tab--active' : ''}`}
            onClick={() => setFilterMode('all')}
          >
            All <span className="tab-badge">{stats.totalRows}</span>
          </button>
          {stats.flaggedCount > 0 && (
            <button
              type="button"
              className={`filter-tab filter-tab--warn${filterMode === 'flagged' ? ' filter-tab--active' : ''}`}
              onClick={() => setFilterMode('flagged')}
            >
              Needs Review <span className="tab-badge tab-badge--warn">{stats.flaggedCount}</span>
            </button>
          )}
          {stats.editedCount > 0 && (
            <button
              type="button"
              className={`filter-tab filter-tab--ok${filterMode === 'edited' ? ' filter-tab--active' : ''}`}
              onClick={() => setFilterMode('edited')}
            >
              Edited <span className="tab-badge tab-badge--ok">{stats.editedCount}</span>
            </button>
          )}
          </div>
        </div>

        <div className="table-controls__end">
          <span className="kind-badge">{title}</span>
          <span className="count">
            {pageRowCount} rows
            {edited.size > 0 && ` · ${edited.size} edited`}
          </span>
          {edited.size > 0 && onResetEdits && (
            <button type="button" className="btn btn--sm btn--subtle" onClick={onResetEdits}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              Reset edits
            </button>
          )}
        </div>
      </div>

      {acrossPages && filteredRows.length > 0 && (
        <p className="search-scope" aria-live="polite">
          {filteredRows.length} row{filteredRows.length === 1 ? '' : 's'} on {matchedPages} of{' '}
          {allPages.length} pages match "{query.trim()}"
        </p>
      )}

      {scope.length === 0 ? (
        <p className="column__empty">{EMPTY[result.kind]}</p>
      ) : filteredRows.length === 0 ? (
        <div className="empty-filter-state">
          <p>
            No rows {acrossPages ? `on any of the ${allPages.length} pages ` : ''}match "{query}".
          </p>
          <button type="button" className="btn btn--sm" onClick={() => { setQuery(''); setFilterMode('all'); }}>
            Reset Filter
          </button>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="fields">
            <thead>
              <tr>
                {acrossPages && <th className="num th--seq th--page">Pg</th>}
                <th className="num th--seq">#</th>
                {headers.map((header, index) => (
                  <th key={`${header}-${index}`} className={columnClass(result, index)}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, position) => {
                const { page, index: originalIndex, confidence, label } = row
                const own = page.result
                const ownHeaders = own.headers
                const wide = wideIndex(own)
                const complete = row.cells.every((cell) => cell.trim() !== '')
                const tone =
                  row.edited && complete
                    ? 'fields__row--edited'
                    : row.flagged
                      ? 'fields__row--flagged'
                      : row.solved || confidence < reviewThreshold
                        ? 'fields__row--low'
                        : ''
                const total = /^totals?$/i.test(row.cells[wide] ?? '') ? 'fields__row--total' : ''
                const className =
                  [tone, total, label ? 'fields__row--label' : ''].filter(Boolean).join(' ') ||
                  undefined
                // A page set out with other columns shows its own titles above its rows.
                const previous = filteredRows[position - 1]
                const retitle =
                  acrossPages && previous?.page.index !== page.index && !sameHeaders(own)

                return (
                  <Fragment key={`${page.index}:${originalIndex}`}>
                    {retitle && (
                      <tr className="fields__retitle">
                        <td className="td--seq td--page" />
                        <td className="td--seq" />
                        {ownHeaders.map((header, index) => (
                          <td key={`${header}-${index}`} className={columnClass(own, index)}>
                            {header}
                          </td>
                        ))}
                      </tr>
                    )}
                    <tr className={className}>
                      {acrossPages && (
                        <td className="num td--seq td--page">
                          {onOpenPage ? (
                            <button
                              type="button"
                              className="page-link"
                              onClick={() => onOpenPage(page.index)}
                              title={`Show page ${page.index + 1}`}
                              aria-label={`Show page ${page.index + 1}`}
                            >
                              {page.index + 1}
                            </button>
                          ) : (
                            page.index + 1
                          )}
                        </td>
                      )}
                      <td className="num td--seq" title={`Row ${originalIndex + 1}`}>
                        {originalIndex + 1}
                      </td>
                      {row.cells.map((cell, cellIndex) => {
                        const header = ownHeaders[cellIndex] ?? ''
                        const column = columnClass(own, cellIndex)
                        // A label's other cells are blank on the page, not missing.
                        const isEmpty = cell.trim() === '' && !label
                        const isLowConfidence = confidence < reviewThreshold
                        // Cells ask for the width of their reading, up to the column's cap,
                        // so one long description cannot stretch the table past the card.
                        const width = Math.min(Math.max(cell.length, header.length, 4), CELL_CHARS[column])

                        return (
                          <td
                            key={`${header}-${cellIndex}`}
                            className={column}
                            title={row.edited ? 'Edited manually' : `Confidence: ${(confidence * 100).toFixed(0)}%`}
                          >
                            <input
                              className={`cell-input${isEmpty ? ' cell-input--empty' : ''}${isLowConfidence ? ' cell-input--low' : ''}`}
                              value={cell}
                              size={width}
                              // A reading too long for its column is cut short: hover shows all of it.
                              title={cell.length > width ? cell : undefined}
                              placeholder={label ? '' : 'empty'}
                              aria-label={
                                acrossPages
                                  ? `${header}, page ${page.index + 1}, row ${originalIndex + 1}`
                                  : `${header}, row ${originalIndex + 1}`
                              }
                              readOnly={!editable}
                              spellCheck={false}
                              onChange={(event) => edit(row, cellIndex, event.target.value)}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function isNumericHeader(header: string): boolean {
  if (/part|upc|sku|desc|name|item/i.test(header)) return false
  return /\b(qty|quantity|price|prc|amount|amt|ext|extended|total|pack)\b/i.test(header)
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

/* -------------------------------------------------------------------------- */
/* Tables printed under the main one                                          */
/* -------------------------------------------------------------------------- */

interface ExtraTablesProps {
  /** Every page read so far, in page order. */
  pages: readonly ExportPage[]
  /** Pages in the document: 1 for an image. */
  total: number
  /** The uploaded file's name, for the downloads. */
  fileName: string | null
}

/**
 * The tables a page prints under its own: an invoice's `Previous Balances`,
 * a recap of the order by category.
 *
 * Each is shown and downloaded as itself. Reading them into the document's
 * table would file their dates as descriptions and their amounts as
 * quantities, which is what the reader used to do.
 */
export function ExtraTables({ pages, total, fileName }: ExtraTablesProps) {
  const tables = useMemo(() => extraTables(pages), [pages])
  if (tables.length === 0) return null
  const base = exportBaseName(fileName, 'receipt')

  return (
    <>
      {tables.map((table) => (
        <div className="card" key={`${table.slug}-${table.headers.join('|')}`}>
          <div className="card__head">
            <div className="export-title-group">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="9" x2="9" y2="21" />
              </svg>
              <h2 className="card__title">{table.title}</h2>
              <span className="count">
                {table.rows.length} {table.rows.length === 1 ? 'row' : 'rows'}
              </span>
            </div>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() =>
                  saveFile(
                    // The byte-order mark tells Excel the file is UTF-8.
                    `﻿${toTableCsv(table, total)}`,
                    'text/csv;charset=utf-8;',
                    `${base}-${table.slug}.csv`,
                  )
                }
                title={`Download ${table.title} as a CSV spreadsheet`}
              >
                <DownloadIcon />
                CSV
              </button>
            </div>
          </div>
          <div className="card__body card__body--compact">
            <div className="table-responsive">
              <table className="fields">
                <thead>
                  <tr>
                    {total > 1 && <th className="num">Page</th>}
                    {table.headers.map((header, index) => (
                      <th key={`${header}-${index}`} className={index === 0 ? 'col--text' : 'num'}>
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, index) => (
                    <tr key={index}>
                      {total > 1 && <td className="num">{row.page}</td>}
                      {table.headers.map((header, cell) => (
                        <td key={`${header}-${cell}`} className={cell === 0 ? 'col--text' : 'num'}>
                          {row.cells[cell] ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}
    </>
  )
}
