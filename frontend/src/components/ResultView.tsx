import { Fragment, useMemo, useState } from 'react'

import { extraTables, toTableCsv, toTableJson, type ExportPage } from '../lib/export'
import { exportBaseName, saveFile } from '../lib/download'
import { DownloadIcon } from './ExportButtons'
import { rowCells, toPublicJson } from '../ocr/result'
import {
  REVIEW_THRESHOLD,
  rowViews,
  type PageRows,
  type RowView,
} from './row-status'
import type { OcrResult } from '../ocr/types'

export type { PageRows } from './row-status'

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

interface FieldsViewProps {
  result: OcrResult
  /** Readings below this confidence are flagged for a human to check. */
  reviewThreshold?: number
  /** Rows the user has corrected by hand. */
  edited?: ReadonlySet<number>
  /** Rows the user has accepted as they read. */
  validated?: ReadonlySet<number>
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

const EMPTY: Record<OcrResult['kind'], string> = {
  inventory: 'No inventory rows were read.',
  settlements: 'No pack settlements were read.',
  invoice: 'No invoice lines were read.',
  table: 'No table rows were read.',
}

/** Which rows the table is showing. */
type FilterMode = 'all' | 'flagged' | 'edited' | 'valid'

const FILTERS: { value: FilterMode; label: string }[] = [
  { value: 'all', label: 'All Fields' },
  { value: 'flagged', label: 'Needs Review' },
  { value: 'edited', label: 'Edited' },
  { value: 'valid', label: 'Validated' },
]

/** Rows shown before `View More`. About a screenful on a laptop. */
const PAGE_SIZE = 12

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

/** The kind's rows under the ticket's own column headers, with its checks above them. */
export function FieldsView({
  result,
  reviewThreshold = REVIEW_THRESHOLD,
  edited = new Set(),
  validated = new Set(),
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
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  // A long document is read a screenful at a time; the rest is one click away.
  const [expanded, setExpanded] = useState(false)
  const q = query.trim().toLowerCase()

  // A search looks through every page read so far; without one, the table is
  // the page on screen.
  const own = useMemo<PageRows>(
    () => ({ index: currentPage, result, edited, validated }),
    [currentPage, result, edited, validated],
  )
  const allPages = useMemo<readonly PageRows[]>(
    () => (pages && pages.length > 1 ? pages : [own]),
    [pages, own],
  )
  const acrossPages = q.length > 0 && allPages.length > 1
  const scope = useMemo(
    () => (acrossPages ? allPages : [own]).flatMap((page) => rowViews(page, reviewThreshold)),
    [acrossPages, allPages, own, reviewThreshold],
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
      validCount: scope.filter((row) => !row.review).length,
    }),
    [scope],
  )

  const filteredRows = useMemo(
    () =>
      scope.filter((row) => {
        if (filterMode === 'flagged' && !row.review) return false
        if (filterMode === 'edited' && !row.edited) return false
        if (filterMode === 'valid' && row.review) return false
        return !q || row.cells.some((cell) => cell.toLowerCase().includes(q))
      }),
    [scope, filterMode, q],
  )
  const matchedPages = new Set(filteredRows.map((row) => row.page.index)).size
  // Rows past the first screenful wait behind `View More`, unless a filter has
  // already cut the table down to what was asked for.
  const hidden = Math.max(0, filteredRows.length - PAGE_SIZE)
  const shownRows = expanded || hidden === 0 ? filteredRows : filteredRows.slice(0, PAGE_SIZE)

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
            placeholder={allPages.length > 1 ? `Search all ${allPages.length} pages…` : 'Search extracted data…'}
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

          {/* One picker rather than a tab each: the counts are above the
              table already, and a row of tabs crowds out the search. */}
          <div className="field-select">
            <select
              className="field-select__input"
              value={filterMode}
              aria-label="Which rows to show"
              onChange={(event) => {
                setFilterMode(event.target.value as FilterMode)
                setExpanded(false)
              }}
            >
              {FILTERS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label} ({value === 'all'
                    ? stats.totalRows
                    : value === 'flagged'
                      ? stats.flaggedCount
                      : value === 'edited'
                        ? stats.editedCount
                        : stats.validCount})
                </option>
              ))}
            </select>
            <svg className="field-select__caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
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
              {shownRows.map((row, position) => {
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
                const previous = shownRows[position - 1]
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
          {hidden > 0 && (
            <div className="view-more">
              <button
                type="button"
                className="btn btn--sm btn--subtle view-more__btn"
                onClick={() => setExpanded((open) => !open)}
                aria-expanded={expanded}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points={expanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
                </svg>
                {expanded ? 'View Less' : `View More (${hidden})`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function isNumericHeader(header: string): boolean {
  if (/part|upc|sku|desc|name|item/i.test(header)) return false
  return /\b(qty|quantity|price|prc|amount|amt|ext|extended|total|pack)\b/i.test(header)
}

/* -------------------------------------------------------------------------- */
/* Tables printed under the main one                                          */
/* -------------------------------------------------------------------------- */

interface ExtraTablesProps {
  /** Every page read so far, in page order. */
  pages: readonly ExportPage[]
  /** Pages in the document: 1 for an image. */
  total: number
  /** Index of the page on screen within the document. */
  currentPage: number
  /** The uploaded file's name, for the downloads. */
  fileName: string | null
  /** Tables left out of the JSON export, by `ExtraTable.key`. */
  dropped: ReadonlySet<string>
  /** Take a table out of the JSON export, or put it back. */
  onToggleTable: (key: string) => void
}

/**
 * The tables the page on screen prints under its own: an invoice's
 * `Previous Balances`, a recap of the order by category.
 *
 * Shown for that page and in the order it prints them, beside the rows of
 * the same page: a table printed on page 3 is not something page 2 has. The
 * download is the whole document's, since a table repeated on every page is
 * one table to whoever reads the file.
 */
export function ExtraTables({
  pages,
  total,
  currentPage,
  fileName,
  dropped,
  onToggleTable,
}: ExtraTablesProps) {
  const tables = useMemo(() => extraTables(pages), [pages])
  const page = currentPage + 1
  const onPage = useMemo(
    () =>
      tables
        .map((table) => ({ table, rows: table.rows.filter((row) => row.page === page) }))
        .filter(({ rows }) => rows.length > 0),
    [tables, page],
  )
  if (onPage.length === 0) return null
  const base = exportBaseName(fileName, 'receipt')

  return (
    <>
      {onPage.map(({ table, rows }) => {
        const out = dropped.has(table.key)
        return (
        <div className={`card${out ? ' card--dropped' : ''}`} key={table.key}>
          <div className="card__head">
            <div className="export-title-group">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="9" y1="9" x2="9" y2="21" />
              </svg>
              <h2 className="card__title">{table.title}</h2>
              <span className="count">
                {rows.length} {rows.length === 1 ? 'row' : 'rows'}
                {/* The same table printed on other pages too: the download
                    carries all of them, so say how many. */}
                {table.rows.length > rows.length ? ` · ${table.rows.length} in all` : ''}
              </span>
              {out && (
                <span className="dropped-chip" title="This table is left out of the JSON export">
                  Not in JSON
                </span>
              )}
            </div>
            <div className="btn-row">
              {/* The downloads are this table on its own, and stay whatever
                  the export carries: taking a table out of the document is
                  not a reason to stop being able to save it. */}
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
                title={
                  table.rows.length > rows.length
                    ? `Download ${table.title} from every page as a CSV spreadsheet`
                    : `Download ${table.title} as a CSV spreadsheet`
                }
              >
                <DownloadIcon />
                CSV
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() =>
                  saveFile(
                    `${JSON.stringify(toTableJson(table, total), null, 2)}\n`,
                    'application/json',
                    `${base}-${table.slug}.json`,
                  )
                }
                title={
                  table.rows.length > rows.length
                    ? `Download ${table.title} from every page as JSON`
                    : `Download ${table.title} as JSON`
                }
              >
                <DownloadIcon />
                JSON
              </button>
              <button
                type="button"
                className={`btn btn--sm${out ? '' : ' btn--subtle'}`}
                onClick={() => onToggleTable(table.key)}
                aria-pressed={out}
                title={
                  out
                    ? `Put ${table.title} back into the JSON export`
                    : `Leave ${table.title} out of the JSON export`
                }
              >
                {out ? (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="1 4 1 10 7 10" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                    Restore
                  </>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                    Remove
                  </>
                )}
              </button>
            </div>
          </div>
          <div className="card__body card__body--compact">
            <div className="table-responsive">
              <table className="fields">
                <thead>
                  <tr>
                    {table.headers.map((header, index) => (
                      <th key={`${header}-${index}`} className={index === 0 ? 'col--text' : 'num'}>
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={index}>
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
        )
      })}
    </>
  )
}
