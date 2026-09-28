import { useMemo, useState } from 'react'

import { toPublicJson } from '../ocr/receipt/assemble'
import type { OcrResult } from '../ocr/types'

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

export interface FieldsViewProps {
  result: OcrResult
  /** Readings below this confidence are flagged for a human to check. */
  reviewThreshold?: number
}

const INVENTORY_COLUMNS = ['game', 'name', 'int', 'rec', 'act', 'set'] as const
const SETTLEMENT_COLUMNS = ['gamePack', 'name', 'dateSettled'] as const

export function FieldsView({ result, reviewThreshold = 0.55 }: FieldsViewProps) {
  switch (result.kind) {
    case 'inventory':
      return (
        <RowTable
          columns={INVENTORY_COLUMNS}
          rows={result.rows.map((row) => ({
            key: `${row.game}-${row.name}`,
            confidence: row.confidence,
            cells: INVENTORY_COLUMNS.map((column) => row[column]),
          }))}
          wide="name"
          empty="No inventory rows were read."
          reviewThreshold={reviewThreshold}
        />
      )
    case 'settlements':
      return (
        <RowTable
          columns={SETTLEMENT_COLUMNS}
          rows={result.settlements.map((row) => ({
            key: `${row.gamePack}-${row.dateSettled}`,
            confidence: row.confidence,
            cells: [row.gamePack, row.name, row.dateSettled],
          }))}
          wide="name"
          empty="No pack settlements were read."
          reviewThreshold={reviewThreshold}
        />
      )
    case 'invoice':
      return (
        <RowTable
          columns={['label', 'value']}
          rows={result.fields.map((row) => ({
            key: `${row.label}-${row.value}`,
            confidence: row.confidence,
            cells: [row.label, row.value],
          }))}
          wide="label"
          empty="No invoice lines were read."
          reviewThreshold={reviewThreshold}
        />
      )
    default: {
      const unreachable: never = result.kind
      return unreachable
    }
  }
}

function RowTable({
  columns,
  rows,
  wide,
  empty,
  reviewThreshold,
}: {
  columns: readonly string[]
  rows: { key: string; confidence: number; cells: string[] }[]
  wide: string
  empty: string
  reviewThreshold: number
}) {
  if (rows.length === 0) return <p className="column__empty">{empty}</p>

  return (
    <table className="fields">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} className={column === wide ? undefined : 'num'}>
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.key}-${index}`} className={row.confidence < reviewThreshold ? 'fields__row--low' : undefined}>
            {row.cells.map((cell, cellIndex) => (
              <td
                key={columns[cellIndex] ?? cellIndex}
                className={columns[cellIndex] === wide ? undefined : 'num'}
                title={`confidence ${(row.confidence * 100).toFixed(0)}%`}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/* -------------------------------------------------------------------------- */
/* Metadata                                                                    */
/* -------------------------------------------------------------------------- */

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`flag flag--${on ? 'on' : 'off'}`}>
      {on ? '✓' : '—'} {label}
    </span>
  )
}

export function MetaView({ result }: { result: OcrResult }) {
  const m = result.processingMeta
  const timings = Object.entries(m.timingsMs).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Flag on={m.perspectiveCorrected} label="perspective" />
        <Flag on={m.tiltCorrected} label="tilt" />
        <Flag on={m.watermarkSuppressed} label="watermark" />
      </div>

      <div className="meta">
        <span className="meta__key">total</span>
        <span className="meta__val">{Math.round(m.totalMs)} ms</span>

        <span className="meta__key">source</span>
        <span className="meta__val">
          {m.sourceSize.width}×{m.sourceSize.height} → {m.rectifiedSize.width}×
          {m.rectifiedSize.height}
        </span>

        <span className="meta__key">rotation</span>
        <span className="meta__val">{m.rotationAngleDeg.toFixed(2)}°</span>

        <span className="meta__key">watermark px</span>
        <span className="meta__val">{(m.watermarkPixelRatio * 100).toFixed(1)}%</span>

        <span className="meta__key">detector</span>
        <span className="meta__val">
          {m.detectorModel} ({m.detectorBackend})
        </span>

        <span className="meta__key">reader</span>
        <span className="meta__val">{m.recognizerModel}</span>

        <span className="meta__key">backend</span>
        <span className="meta__val">{m.executionProvider}</span>

        <span className="meta__key">rows</span>
        <span className="meta__val">
          {toPublicJson(result).rows.length} rows · {result.rawDetections.length} words
        </span>
      </div>

      {timings.length > 0 && (
        <details>
          <summary className="strip__label" style={{ cursor: 'pointer' }}>
            stage timings
          </summary>
          <div className="meta" style={{ marginTop: 8 }}>
            {timings.map(([stage, ms]) => (
              <span key={stage} style={{ display: 'contents' }}>
                <span className="meta__key">{stage}</span>
                <span className="meta__val">{Math.round(ms ?? 0)} ms</span>
              </span>
            ))}
          </div>
        </details>
      )}

      {m.warnings.length > 0 && (
        <div className="banner banner--warn">
          <div>
            <strong>{m.warnings.length} warning{m.warnings.length === 1 ? '' : 's'}</strong>
            <ul className="banner__list">
              {m.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* JSON                                                                        */
/* -------------------------------------------------------------------------- */

export interface JsonViewProps {
  result: OcrResult
}

export function JsonView({ result }: JsonViewProps) {
  const [includeRaw, setIncludeRaw] = useState(false)
  const [copied, setCopied] = useState(false)

  const json = useMemo(() => {
    const payload = includeRaw ? result : toPublicJson(result)
    return JSON.stringify(payload, null, 2)
  }, [result, includeRaw])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access is blocked in some embedded/insecure contexts. Fall
      // back to selecting the text so the user can copy it by hand.
      const pre = document.querySelector('.json')
      if (pre) {
        const range = document.createRange()
        range.selectNodeContents(pre)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    }
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
          <label className="toggle" style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={includeRaw}
              onChange={(e) => setIncludeRaw(e.target.checked)}
            />
            full result
          </label>
          <button className="btn btn--sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn btn--sm" onClick={download}>
            Download
          </button>
        </div>
      </div>
      <pre className="json">{json}</pre>
    </div>
  )
}
