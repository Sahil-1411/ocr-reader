import { FieldsView, JsonView, SkippedView } from '../../components/ResultView'
import { resultTitle, type ReceiptSession } from './types'

/** The rows for the page on screen, or why that page has none yet. */
export function ResultPanel({ session }: { session: ReceiptSession }) {
  const {
    result,
    edited,
    pageError,
    busy,
    currentPage,
    isPdfMode,
    pdfPages,
    tablePages,
    exportPages,
    failures,
    fileName,
    onEditPage,
    resetEdits,
    switchPdfPage,
  } = session

  return (
    <div className="stack">
      {result ? (
        <div className="card">
          <div className="card__body card__body--compact">
            <FieldsView
              result={result}
              edited={edited}
              title={resultTitle(result)}
              onResetEdits={resetEdits}
              pages={tablePages}
              currentPage={currentPage}
              onEditPage={onEditPage}
              onOpenPage={isPdfMode ? switchPdfPage : undefined}
            />
          </div>
        </div>
      ) : isPdfMode && pdfPages.length > 0 ? (
        <div className="card empty-card">
          <div className="card__body empty-card__body">
            <h3 className="empty-card__title">
              {pageError
                ? `Page ${currentPage + 1} could not be read`
                : busy
                  ? `Reading page ${currentPage + 1}…`
                  : `Page ${currentPage + 1} was not read`}
            </h3>
            <p className="empty-card__desc">
              {pageError
                ? pageError
                : busy
                  ? 'Its rows appear here as soon as it is read. Pages are read in order.'
                  : 'Reading stopped before this page. Read the remaining pages to include it.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="card empty-card">
          <div className="card__body empty-card__body">
            <div className="empty-card__icon" aria-hidden="true">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <h3 className="empty-card__title">No Receipt Scanned Yet</h3>
          </div>
        </div>
      )}
      {exportPages.length > 0 && (
        <>
          <JsonView
            pages={exportPages}
            total={isPdfMode ? pdfPages.length : 1}
            reading={busy}
            fileName={fileName}
          />
          <SkippedView
            pages={exportPages}
            total={isPdfMode ? pdfPages.length : 1}
            failures={failures}
            reading={busy}
            fileName={fileName}
          />
        </>
      )}
    </div>
  )
}
