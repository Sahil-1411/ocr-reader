import { useMemo, useState } from 'react'

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
}

const EMPTY: Record<OcrResult['kind'], string> = {
  inventory: 'No inventory rows were read.',
  settlements: 'No pack settlements were read.',
  invoice: 'No invoice lines were read.',
}

/** The kind's rows under the ticket's own column headers, with its checks above them. */
export function FieldsView({
  result,
  reviewThreshold = 0.55,
  edited = new Set(),
  onEdit,
}: FieldsViewProps) {
  const { headers } = toPublicJson(result)
  const cells = rowCells(result)
  const confidences = rowConfidences(result)
  const wide = result.kind === 'invoice' ? 0 : 1

  const [query, setQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'all' | 'flagged' | 'edited'>('all')

  // A count solved from TOTALS is known, just not read; the rest need a look.
  const solved = useMemo(
    () =>
      new Set(
        result.validation
          .filter((issue) => issue.code === 'inventory-solved')
          .flatMap((issue) => issue.rows),
      ),
    [result.validation],
  )

  const flagged = useMemo(
    () =>
      new Set(
        result.validation
          .filter((issue) => issue.code !== 'inventory-solved')
          .flatMap((issue) => issue.rows),
      ),
    [result.validation],
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

  // Calculate statistics
  const stats = useMemo(() => {
    const totalRows = cells.length
    if (totalRows === 0) return { totalRows: 0, avgConfidence: 0, flaggedCount: 0, editedCount: 0 }
    const sumConf = confidences.reduce((acc, c) => acc + c, 0)
    const avgConfidence = Math.round((sumConf / totalRows) * 100)
    const flaggedCount = cells.filter((row, idx) => {
      const conf = confidences[idx] ?? 0
      const incomplete = row.some((c) => c.trim() === '')
      return flagged.has(idx) || conf < reviewThreshold || incomplete
    }).length
    return {
      totalRows,
      avgConfidence,
      flaggedCount,
      editedCount: edited.size,
    }
  }, [cells, confidences, flagged, reviewThreshold, edited.size])

  // Filtered rows for fast interactive search & tab switching
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return cells
      .map((row, originalIndex) => ({ row, originalIndex }))
      .filter(({ row, originalIndex }) => {
        const conf = confidences[originalIndex] ?? 0
        const isFlagged = flagged.has(originalIndex) || conf < reviewThreshold || row.some((c) => c.trim() === '')
        const isEdited = edited.has(originalIndex)

        if (filterMode === 'flagged' && !isFlagged) return false
        if (filterMode === 'edited' && !isEdited) return false

        if (q) {
          const match = row.some((cell) => cell.toLowerCase().includes(q))
          if (!match) return false
        }
        return true
      })
  }, [cells, confidences, flagged, reviewThreshold, edited, filterMode, query])

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

      {/* Interactive Filter & Search Controls */}
      <div className="table-controls">
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
            placeholder="Filter table rows..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter rows"
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

      {cells.length === 0 ? (
        <p className="column__empty">{EMPTY[result.kind]}</p>
      ) : filteredRows.length === 0 ? (
        <div className="empty-filter-state">
          <p>No rows match "{query}".</p>
          <button type="button" className="btn btn--sm" onClick={() => { setQuery(''); setFilterMode('all'); }}>
            Reset Filter
          </button>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="fields">
            <thead>
              <tr>
                <th className="num th--seq">#</th>
                {headers.map((header, index) => (
                  <th key={header} className={index === wide ? undefined : 'num'}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ row, originalIndex }) => {
                const confidence = confidences[originalIndex] ?? 0
                const complete = row.every((cell) => cell.trim() !== '')
                const tone =
                  edited.has(originalIndex) && complete
                    ? 'fields__row--edited'
                    : flagged.has(originalIndex)
                      ? 'fields__row--flagged'
                      : solved.has(originalIndex) || confidence < reviewThreshold
                        ? 'fields__row--low'
                        : ''
                const total = /^totals?$/i.test(row[wide] ?? '') ? 'fields__row--total' : ''
                const className = [tone, total].filter(Boolean).join(' ') || undefined

                return (
                  <tr key={originalIndex} className={className}>
                    <td className="num td--seq" title={`Row ${originalIndex + 1}`}>
                      {originalIndex + 1}
                    </td>
                    {row.map((cell, cellIndex) => {
                      const header = headers[cellIndex] ?? ''
                      const numeric = cellIndex !== wide
                      const isEmpty = cell.trim() === ''
                      const isLowConfidence = confidence < reviewThreshold

                      return (
                        <td
                          key={header || cellIndex}
                          className={numeric ? 'num' : undefined}
                          title={
                            edited.has(originalIndex)
                              ? 'Edited manually'
                              : `Confidence: ${(confidence * 100).toFixed(0)}%`
                          }
                        >
                          <input
                            className={`cell-input${isEmpty ? ' cell-input--empty' : ''}${isLowConfidence ? ' cell-input--low' : ''}`}
                            value={cell}
                            size={numeric ? Math.max(cell.length, header.length, 3) : undefined}
                            placeholder="empty"
                            aria-label={`${header}, row ${originalIndex + 1}`}
                            readOnly={!onEdit}
                            spellCheck={false}
                            onChange={(event) =>
                              onEdit?.(originalIndex, cellIndex, event.target.value)
                            }
                          />
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function rowConfidences(result: OcrResult): number[] {
  switch (result.kind) {
    case 'inventory':
      return result.rows.map((row) => row.confidence)
    case 'settlements':
      return result.settlements.map((row) => row.confidence)
    case 'invoice':
      return result.fields.map((row) => row.confidence)
    default: {
      const unreachable: never = result.kind
      return unreachable
    }
  }
}

/* -------------------------------------------------------------------------- */
/* JSON & Export View                                                         */
/* -------------------------------------------------------------------------- */

interface JsonViewProps {
  result: OcrResult
}

export function JsonView({ result }: JsonViewProps) {
  const [copied, setCopied] = useState(false)
  const [showJson, setShowJson] = useState(false)

  const publicData = useMemo(() => toPublicJson(result), [result])
  const json = useMemo(() => JSON.stringify(publicData, null, 2), [publicData])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
    } catch {
      const area = document.createElement('textarea')
      area.value = json
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.append(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const downloadJson = () => {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${result.kind}-receipt.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const downloadCsv = () => {
    const { headers } = publicData
    const escapeCsv = (val: string) => {
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`
      }
      return val
    }
    const cells = rowCells(result)
    const csvContent = [
      headers.map(escapeCsv).join(','),
      ...cells.map((row) => row.map((c) => escapeCsv(c ?? '')).join(',')),
    ].join('\r\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${result.kind}-receipt.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <div className="card export-card">
      <div className="card__head">
        <div className="export-title-group">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="16 16 12 12 8 16" />
            <line x1="12" y1="12" x2="12" y2="21" />
            <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
            <polyline points="16 16 12 12 8 16" />
          </svg>
          <h2 className="card__title">Export & Data Output</h2>
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn--sm" onClick={downloadCsv} title="Download standard CSV spreadsheet">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            CSV
          </button>
          <button type="button" className="btn btn--sm" onClick={downloadJson} title="Download formatted JSON">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            JSON
          </button>
          <button
            type="button"
            className={`btn btn--sm${copied ? ' btn--copied' : ''}`}
            onClick={copy}
            title="Copy JSON to clipboard"
          >
            {copied ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                Copy
              </>
            )}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setShowJson(!showJson)}
          >
            {showJson ? 'Hide Raw JSON' : 'View Raw JSON'}
          </button>
        </div>
      </div>

      {showJson && (
        <div className="card__body card__body--code">
          <pre className="json-preview">{json}</pre>
        </div>
      )}
    </div>
  )
}
