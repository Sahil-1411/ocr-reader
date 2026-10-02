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

import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { CopyButton, DownloadIcon } from '../../components/ExportButtons'
import { exportBaseName, saveFile } from '../../lib/download'
import { requestExport, type ExportPage, type PageFailure } from '../../ocr/api'
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
  /** Extra tables the reader has left out of the JSON, by `ExtraTable.key`. */
  droppedTables: ReadonlySet<string>
}

/** Which panel the bar has open below it. One at a time: both read the same page. */
type Panel = 'json' | 'log' | null

/** One printed line the reader left out, and the pages it was printed on. */
interface SkippedEntry {
  text: string
  pages: number[]
  /** Those pages as a person writes them: `1-7`, `1-3, 5`. */
  pageRange: string
  times: number
  confidence?: number
}

/** The lines of one kind, with what that kind is and whether it wants a look. */
interface SkippedGroup {
  reason: string
  what: string
  detail: string
  check: boolean
  lines: number
  times: number
  entries: SkippedEntry[]
}

/** The log as the reader shapes it. */
interface SkippedLog {
  failedPages?: number[]
  needsChecking?: number
  groups?: SkippedGroup[]
}

export function ExportDock({
  pages,
  total,
  failures,
  reading,
  fileName,
  droppedTables,
}: ExportDockProps) {
  const [panel, setPanel] = useState<Panel>(null)
  const toggle = (next: Exclude<Panel, null>) =>
    setPanel((open) => (open === next ? null : next))

  // What the reader last sent for an open panel. Empty until a panel is
  // opened: the export is shaped by the reader, and asking it to shape one
  // nobody has asked to see is a round trip for nothing.
  const [json, setJson] = useState('')
  const [logJson, setLogJson] = useState('')
  const rowCount = useMemo(
    () => pages.reduce((count, { result }) => count + result.rows.length, 0),
    [pages],
  )
  const exportReady = !reading && pages.length > 0
  const exportWaiting = reading ? 'Export includes every page once all of them are read' : undefined
  const exportBase = exportBaseName(fileName, `${pages[0]?.result.kind ?? 'receipt'}-receipt`)

  const skipped = useMemo(
    () => pages.reduce((count, { result }) => count + result.skipped.length, 0) + failures.length,
    [pages, failures],
  )
  // The log the reader sent, for the panel's own table. Parsed rather than
  // rebuilt here so the rows on screen are the rows the download carries.
  const log = useMemo(() => {
    try {
      return JSON.parse(logJson || '{}') as SkippedLog
    } catch {
      return {}
    }
  }, [logJson])
  const logGroups = log.groups ?? []
  const needsChecking = log.needsChecking ?? 0
  const distinctLines = logGroups.reduce((count, group) => count + group.lines, 0)
  // The log is fetched when the panel opens, so until it lands there is
  // nothing to say. Saying "every printed line is in the data" before it
  // arrives would be a claim the reader has not made.
  const logArrived = logJson !== ''
  // A PDF's own text is exact, so every line comes back at 100% and the
  // column says nothing. It earns its place only when a recogniser read the
  // page and the numbers differ.
  const showConfidence = logGroups.some((group) =>
    group.entries.some((entry) => entry.confidence !== undefined && entry.confidence < 1),
  )
  // From the pages, not from the log: the chip in the bar is there before any
  // panel is opened, and the reader's log is only fetched once one is.
  const failed = failures.length
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

  const ask = (what: 'data' | 'log', format: 'csv' | 'json') =>
    requestExport({ what, format, pages, total, dropped: [...droppedTables], failures })

  // Only the open panel is fetched, and only once it is open. A panel left
  // shut costs nothing, and one left open follows an edit or a dropped table.
  useEffect(() => {
    if (panel === null || reading || pages.length === 0) return
    const what = panel === 'json' ? 'data' : 'log'
    const set = panel === 'json' ? setJson : setLogJson
    let live = true
    void ask(what, 'json')
      .then((text) => live && set(text))
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, pages, total, droppedTables, failures, reading])

  const save = (
    what: 'data' | 'log',
    format: 'csv' | 'json',
    name: string,
  ) => {
    void ask(what, format).then((text) =>
      format === 'csv'
        ? // The byte-order mark tells Excel the file is UTF-8.
          saveFile(`﻿${text}`, 'text/csv;charset=utf-8;', name)
        : saveFile(text, 'application/json', name),
    )
  }

  const downloadExportJson = () => save('data', 'json', `${exportBase}.json`)
  const downloadExportCsv = () => save('data', 'csv', `${exportBase}.csv`)
  const downloadLogJson = () => save('log', 'json', `${logBase}.json`)
  const downloadLogCsv = () => save('log', 'csv', `${logBase}.csv`)

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
        text={() => ask('data', 'json')}
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
            // Lines once the log has arrived, because that is what the panel
            // lists; the chip in the bar counts sightings, so both are named
            // where they differ.
            [
              logArrived && distinctLines !== skipped
                ? `${distinctLines} ${distinctLines === 1 ? 'line' : 'lines'} · printed ${skipped} times`
                : `${skipped} ${skipped === 1 ? 'line' : 'lines'}`,
              failed > 0 ? `${failed} ${failed === 1 ? 'page' : 'pages'} not read` : '',
            ]
              .filter(Boolean)
              .join(' · ')
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
                text={() => ask('log', 'json')}
                label="Copy the log as JSON"
                title={logWaiting ?? 'Copy the log as JSON'}
                disabled={!logReady}
              />
            </>
          }
        >
          {/* What the reader left out, by kind rather than by sighting: the
              same footer on seven pages is one line to judge, not seven. */}
          <p className="log-summary">
            {!logArrived
              ? 'Reading the log…'
              : distinctLines === 0
                ? 'Every printed line is in the data.'
                : needsChecking === 0
                  ? `${distinctLines} printed ${distinctLines === 1 ? 'line is' : 'lines are'} not in the data, and none of them is an item.`
                  : `${distinctLines} printed ${distinctLines === 1 ? 'line is' : 'lines are'} not in the data. ${needsChecking} ${needsChecking === 1 ? 'is' : 'are'} worth checking against the page.`}
          </p>
          {logGroups.map((group) => (
            <section className="log-group" key={group.reason}>
              <h3 className="log-group__head">
                <span className={`log-group__what${group.check ? ' log-group__what--check' : ''}`}>
                  {group.what}
                </span>
                <span className="count">
                  {group.lines} {group.lines === 1 ? 'line' : 'lines'}
                  {group.times > group.lines ? ` · printed ${group.times} times` : ''}
                </span>
              </h3>
              <p className="log-group__detail">{group.detail}</p>
              <div className="table-responsive">
                <table className="fields">
                  <thead>
                    <tr>
                      {total > 1 && <th className="num">Page</th>}
                      <th className="col--wide">Printed text</th>
                      {showConfidence && <th className="num">Conf.</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {group.entries.map((entry, index) => (
                      <tr key={`${group.reason}-${index}`}>
                        {total > 1 && <td className="num">{entry.pageRange}</td>}
                        {/* The printed line can run the width of the page; the
                            cell shows what fits and the title holds the rest. */}
                        <td className="col--wide log-text" title={entry.text}>
                          {entry.text}
                        </td>
                        {showConfidence && (
                          <td className="num">
                            {entry.confidence === undefined
                              ? '—'
                              : `${Math.round(entry.confidence * 100)}%`}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
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
