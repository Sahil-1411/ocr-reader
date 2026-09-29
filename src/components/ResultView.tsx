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
}

const EMPTY: Record<OcrResult['kind'], string> = {
  inventory: 'No inventory rows were read.',
  settlements: 'No pack settlements were read.',
  invoice: 'No invoice lines were read.',
}

/** The kind's rows under the ticket's own column headers, with its checks above them. */
export function FieldsView({ result, reviewThreshold = 0.55 }: FieldsViewProps) {
  const { headers } = toPublicJson(result)
  const cells = rowCells(result)
  const confidences = rowConfidences(result)
  // The widest column is the free-text one: Name, or the invoice's label.
  const wide = result.kind === 'invoice' ? 0 : 1
  // A count solved from TOTALS is known, just not read; the rest need a look.
  const solved = new Set(
    result.validation.filter((issue) => issue.code === 'inventory-solved').flatMap((issue) => issue.rows),
  )
  const flagged = new Set(
    result.validation.filter((issue) => issue.code !== 'inventory-solved').flatMap((issue) => issue.rows),
  )
  // Validation messages are already among the warnings; a Tesseract fallback is not.
  const { reader, warnings } = result.processingMeta
  const notices = [
    ...(reader.includes('not running')
      ? [`Read with ${reader} — start tools/serve.py for the more accurate reader.`]
      : []),
    ...new Set(warnings),
  ]

  return (
    <>
      {notices.length > 0 && (
        <div className="banner banner--warn fields__issues">
          <div>
            <strong>
              {notices.length} warning{notices.length === 1 ? '' : 's'} to review
            </strong>
            <ul className="banner__list">
              {notices.map((notice, index) => (
                <li key={index}>{notice}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {cells.length === 0 ? (
        <p className="column__empty">{EMPTY[result.kind]}</p>
      ) : (
        <table className="fields">
          <thead>
            <tr>
              {headers.map((header, index) => (
                <th key={header} className={index === wide ? undefined : 'num'}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((row, index) => {
              const confidence = confidences[index] ?? 0
              const tone = flagged.has(index)
                ? 'fields__row--flagged'
                : solved.has(index) || confidence < reviewThreshold
                  ? 'fields__row--low'
                  : ''
              const total = /^totals?$/i.test(row[wide] ?? '') ? 'fields__row--total' : ''
              const className = [tone, total].filter(Boolean).join(' ') || undefined
              return (
                <tr key={`${row.join('|')}-${index}`} className={className}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={headers[cellIndex] ?? cellIndex}
                      className={cellIndex === wide ? undefined : 'num'}
                      title={`confidence ${(confidence * 100).toFixed(0)}%`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
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
/* JSON                                                                        */
/* -------------------------------------------------------------------------- */

interface JsonViewProps {
  result: OcrResult
}

export function JsonView({ result }: JsonViewProps) {
  const [copied, setCopied] = useState(false)

  const json = useMemo(() => JSON.stringify(toPublicJson(result), null, 2), [result])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
    } catch {
      // The async clipboard API is blocked in some embedded/insecure contexts;
      // the legacy copy command still works there.
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

  const download = () => {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'receipt.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <div className="card">
      <div className="card__head">
        <h2 className="card__title">JSON output</h2>
        <div className="btn-row">
          <button className="btn btn--sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn btn--sm" onClick={download}>
            Download
          </button>
        </div>
      </div>
    </div>
  )
}
