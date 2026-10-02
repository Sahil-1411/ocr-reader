import { Pager } from '../../components/Pager'
import { ExtraTables, FieldsView } from '../../components/ResultView'
import { validCount } from '../../components/row-status'
import { resultTitle, type ReceiptSession } from './types'

/** The rows for the page on screen, or why that page has none yet. */
export function ResultPanel({ session }: { session: ReceiptSession }) {
  const {
    result,
    edited,
    validated,
    pageError,
    busy,
    currentPage,
    isPdfMode,
    pdfPages,
    tablePages,
    exportPages,
    fileName,
    droppedTables,
    toggleTable,
    onEditPage,
    validateAll,
    resetEdits,
    switchPdfPage,
  } = session

  // What is left to look at on the page on screen, which is what `Validate
  // All` acts on.
  const counts = result ? validCount({ index: currentPage, result, edited, validated }) : null

  return (
    <div className="stack">
      {result ? (
        <div className="card">
          <div className="card__head">
            <div className="card__head-title">
              <span className="card__step" aria-hidden="true">
                2
              </span>
              <h2 className="card__title">Extracted Data</h2>
            </div>
            {/* The rows on screen are one page's, so the way to another
                  page belongs beside them as well as beside the picture. */}
            <div className="btn-row">
              {counts && (
                <>
                  {counts.valid < counts.total && (
                    <button
                      type="button"
                      className="btn btn--sm btn--outline"
                      onClick={validateAll}
                      title={`Accept the ${counts.total - counts.valid} rows still waiting on a look`}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                        <polyline points="22 4 12 14.01 9 11.01" />
                      </svg>
                      Validate All
                    </button>
                  )}
                  <span
                    className={`valid-chip${counts.valid === counts.total ? ' valid-chip--all' : ''}`}
                    title={
                      counts.valid === counts.total
                        ? 'Every row on this page reads cleanly or has been accepted'
                        : `${counts.total - counts.valid} rows still want a look`
                    }
                  >
                    {counts.valid} / {counts.total} Valid
                  </span>
                </>
              )}
              <Pager
                current={currentPage}
                total={isPdfMode ? pdfPages.length : 1}
                onSwitch={switchPdfPage}
                compact
                label="Pages of extracted data"
              />

            </div>
          </div>
          <div className="card__body card__body--compact">
            <FieldsView
              result={result}
              edited={edited}
              validated={validated}
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
          <div className="card__head">
            <div className="card__head-title">
              <span className="card__step" aria-hidden="true">
                2
              </span>
              <h2 className="card__title">Extracted Data</h2>
            </div>
            <div className="btn-row">
              <Pager
                current={currentPage}
                total={pdfPages.length}
                onSwitch={switchPdfPage}
                compact
                label="Pages of extracted data"
              />
            </div>
          </div>
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
      {/* A page prints more than one table when it prints its own and, under
          it, something like `Previous Balances`. Each is itself. */}
      <ExtraTables
        pages={exportPages}
        total={isPdfMode ? pdfPages.length : 1}
        currentPage={currentPage}
        fileName={fileName}
        dropped={droppedTables}
        onToggleTable={toggleTable}
      />
    </div>
  )
}
