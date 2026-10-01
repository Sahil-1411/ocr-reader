/**
 * The top bar once a document has been read: what the read came to, what can
 * be taken away from it, and what it left behind.
 *
 * The export is what the document says. The log is everything the reader set
 * aside to say it — totals, page furniture, notes cut out of a line, and any
 * page that produced no rows at all. The log is a second opinion on the
 * export, not a second export, so it keeps one chip in the bar and puts its
 * own downloads in the panel that chip opens.
 */

import { useMemo, useState, type ReactNode } from 'react'

import { CopyButton, DownloadIcon } from '../../components/ExportButtons'
import { exportBaseName, saveFile } from '../../lib/download'
import {
  toCsv,
  toDocumentJson,
  toSkippedCsv,
  toSkippedLog,
  type ExportPage,
  type PageFailure,
} from '../../lib/export'
import { AppHeader } from './AppHeader'

interface ExportDockProps {
  /** Every page read so far, in page order, with the user's edits. */
  pages: readonly ExportPage[]
  /** Pages in the document: 1 for an image. */
  total: number
  /** Pages that produced no rows: a read that failed, or one never reached. */
  failures: readonly PageFailure[]
  /** Still reading pages: downloads wait until every page is done. */
  reading: boolean
  /** The uploaded file's name, for the downloads. */
  fileName: string | null
}

/** Which panel the bar has open below it. One at a time: both read the same page. */
type Panel = 'json' | 'log' | null

export function ExportDock({ pages, total, failures, reading, fileName }: ExportDockProps) {
  const [panel, setPanel] = useState<Panel>(null)
  const toggle = (next: Exclude<Panel, null>) =>
    setPanel((open) => (open === next ? null : next))

  const publicData = useMemo(() => toDocumentJson(pages, total), [pages, total])
  const json = useMemo(() => JSON.stringify(publicData, null, 2), [publicData])
  const rowCount = publicData?.rows.length ?? 0
  const exportReady = !reading && pages.length > 0
  const exportWaiting = reading ? 'Export includes every page once all of them are read' : undefined
  const exportBase = exportBaseName(fileName, `${publicData?.kind ?? 'receipt'}-receipt`)

  const log = useMemo(() => toSkippedLog(pages, total, failures), [pages, total, failures])
  const logJson = useMemo(() => JSON.stringify(log, null, 2), [log])
  const skipped = log.rows.length
  const failed = log.failedPages?.length ?? 0
  const logReady = !reading && skipped > 0
  const logWaiting = reading ? 'The log covers every page once all of them are read' : undefined
  const logBase = `${exportBaseName(fileName, 'receipt')}-skipped`

  const rows = `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`
  // What has been read, in one phrase: a page count only where there are pages.
  const read = reading
    ? `Reading page ${pages.length + 1} of ${total}`
    : total === 1
      ? rows
      : pages.length === total
        ? `${total} pages · ${rows}`
        : `${pages.length} of ${total} pages · ${rows}`

  const downloadExportJson = () => saveFile(json, 'application/json', `${exportBase}.json`)
  const downloadExportCsv = () =>
    saveFile(`﻿${toCsv(pages, total)}`, 'text/csv;charset=utf-8;', `${exportBase}.csv`)
  const downloadLogJson = () => saveFile(logJson, 'application/json', `${logBase}.json`)
  const downloadLogCsv = () =>
    saveFile(
      `﻿${toSkippedCsv(pages, total, failures)}`,
      'text/csv;charset=utf-8;',
      `${logBase}.csv`,
    )

  const status = (
    <>
      <span className="read-count">{read}</span>
      <SkippedToggle
        count={skipped}
        failed={failed}
        reading={reading}
        open={panel === 'log'}
        onClick={() => toggle('log')}
      />
    </>
  )

  const actions = (
    <>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        onClick={downloadExportCsv}
        disabled={!exportReady}
        title={exportWaiting ?? 'Download every row as a CSV spreadsheet'}
      >
        <DownloadIcon />
        CSV
      </button>
      <button
        type="button"
        className="btn btn--sm"
        onClick={downloadExportJson}
        disabled={!exportReady}
        title={exportWaiting ?? 'Download every row as JSON'}
      >
        <DownloadIcon />
        JSON
      </button>
      <CopyButton
        text={json}
        label="Copy every row as JSON"
        title={exportWaiting ?? 'Copy every row as JSON'}
        disabled={!exportReady}
      />
      <button
        type="button"
        className={`btn btn--sm btn--ghost${panel === 'json' ? ' btn--on' : ''}`}
        onClick={() => toggle('json')}
        aria-expanded={panel === 'json'}
        title={panel === 'json' ? 'Hide the raw JSON' : 'Read the raw JSON'}
      >
        Raw
        <Chevron open={panel === 'json'} />
      </button>
    </>
  )

  return (
    <>
      <div className="app__top">
        <AppHeader status={status} actions={actions} />
      </div>

      {panel === 'json' && (
        <DockPanel title="Raw JSON" count={read} onClose={() => setPanel(null)}>
          <pre className="json-preview">{json}</pre>
        </DockPanel>
      )}

      {panel === 'log' && (
        <DockPanel
          title="Skipped &amp; removed"
          count={
            failed > 0
              ? `${skipped} entries · ${failed} ${failed === 1 ? 'page' : 'pages'} not read`
              : `${skipped} ${skipped === 1 ? 'entry' : 'entries'}`
          }
          onClose={() => setPanel(null)}
          actions={
            <>
              <button
                type="button"
                className="btn btn--sm"
                onClick={downloadLogCsv}
                disabled={!logReady}
                title={logWaiting ?? 'Download the log as a CSV spreadsheet'}
              >
                <DownloadIcon />
                CSV
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={downloadLogJson}
                disabled={!logReady}
                title={logWaiting ?? 'Download the log as JSON'}
              >
                <DownloadIcon />
                JSON
              </button>
              <CopyButton
                text={logJson}
                label="Copy the log as JSON"
                title={logWaiting ?? 'Copy the log as JSON'}
                disabled={!logReady}
              />
            </>
          }
        >
          <div className="table-responsive">
            <table className="fields">
              <thead>
                <tr>
                  {total > 1 && <th className="num">Page</th>}
                  <th className="col--text">Reason</th>
                  <th className="col--wide">Printed text</th>
                  <th className="num">Conf.</th>
                </tr>
              </thead>
              <tbody>
                {log.rows.map((row, index) => (
                  <tr
                    key={`${row.page}-${index}`}
                    className={row.reason === 'page-error' ? 'fields__row--flagged' : undefined}
                  >
                    {total > 1 && <td className="num">{row.page}</td>}
                    <td className="col--text">{row.what}</td>
                    {/* The printed line can run the width of the page; the cell
                        shows what fits and the title holds the rest. */}
                    <td className="col--wide log-text" title={row.text}>
                      {row.text}
                    </td>
                    <td className="num">
                      {row.confidence === undefined ? '—' : `${Math.round(row.confidence * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DockPanel>
      )}
    </>
  )
}

/**
 * How much the read set aside, as the control that opens the log.
 *
 * It is a button shaped like the other buttons in the bar, with a chevron
 * that turns: a tinted pill reads as a status badge, and a badge that opens
 * something is a thing nobody clicks. With nothing to show it stops being a
 * control at all and just says so.
 */
function SkippedToggle({
  count,
  failed,
  reading,
  open,
  onClick,
}: {
  count: number
  /** Pages that produced no rows, which is worth more than a quiet button. */
  failed: number
  reading: boolean
  open: boolean
  onClick: () => void
}) {
  if (count === 0) {
    return (
      <span className="read-note" title="Every printed line went into the export">
        {reading ? 'Nothing skipped yet' : 'Nothing skipped'}
      </span>
    )
  }
  const tone = failed > 0 ? ' btn--alert' : ' btn--warn'
  return (
    <button
      type="button"
      className={`btn btn--sm${tone}${open ? ' btn--on' : ''}`}
      onClick={onClick}
      aria-expanded={open}
      title={open ? 'Hide what the read left out' : 'See what the read left out'}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="8" x2="12" y2="13" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      {reading ? `${count} skipped so far` : `${count} skipped`}
      <Chevron open={open} />
    </button>
  )
}

/** The mark of a button that opens a panel, pointing the way it will go. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`chevron${open ? ' chevron--up' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

/** A panel the bar opens under itself, with its own heading and downloads. */
function DockPanel({
  title,
  count,
  actions,
  onClose,
  children,
}: {
  title: string
  count: string
  actions?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  return (
    <section className="dock-panel">
      <div className="dock-panel__head">
        <h2 className="dock-panel__title">{title}</h2>
        <span className="count">{count}</span>
        <div className="btn-row dock-panel__actions">
          {actions}
          <button
            type="button"
            className="btn btn--sm btn--ghost dock-panel__close"
            onClick={onClose}
            aria-label={`Close ${title}`}
            title="Close"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div className="dock-panel__body">{children}</div>
    </section>
  )
}
