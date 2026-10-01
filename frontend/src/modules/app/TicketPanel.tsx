import { Dropzone } from '../../components/Dropzone'
import { StageProgress } from '../../components/StageProgress'
import type { ReceiptSession } from './types'

/** The uploaded page, its page list, and whatever stopped the read. */
export function TicketPanel({ session }: { session: ReceiptSession }) {
  const {
    stages,
    pages,
    pageErrors,
    error,
    hasPreview,
    fileName,
    imageDimensions,
    pdfPages,
    currentPage,
    isPdfMode,
    pdfProcessingPage,
    previewRef,
    result,
    busy,
    unread,
    pageError,
    onFile,
    cancel,
    readRemaining,
    clearCurrent,
    switchPdfPage,
  } = session

  return (
    <div className="stack">
      <div className="card ticket-card">
        <div className="card__head">
          <div className="card__head-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <h2 className="card__title">Ticket Image</h2>
          </div>
          <div className="btn-row">
            {busy && (
              <button className="btn btn--sm btn--danger" onClick={cancel}>
                Cancel
              </button>
            )}
            {hasPreview && !busy && (
              <button className="btn btn--sm btn--ghost" onClick={clearCurrent}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="ticket-sticky">
          <div className="ticket-sticky__tools">
            <Dropzone onFile={onFile} disabled={busy} />

            <div className="preview-chrome" hidden={!hasPreview}>
              <div className="preview-meta">
                <span className="preview-meta__filename" title={fileName ?? 'Receipt'}>
                  {fileName ?? 'Receipt'}
                  {isPdfMode && pdfPages.length > 0 && (
                    <span className="preview-meta__page-badge">
                      PDF · {pdfPages.length} page{pdfPages.length > 1 ? 's' : ''}
                    </span>
                  )}
                </span>
                {imageDimensions && (
                  <span className="preview-meta__dims">
                    {imageDimensions.width} × {imageDimensions.height} px
                  </span>
                )}
              </div>

              {isPdfMode && pdfPages.length > 1 && (
                <div className="pdf-page-nav">
                  <button
                    className="btn btn--sm btn--ghost pdf-page-nav__btn"
                    disabled={currentPage === 0}
                    onClick={() => switchPdfPage(currentPage - 1)}
                    aria-label="Previous page"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </button>
                  <div className="pdf-page-nav__pages">
                    {pdfPages.map((_, idx) => {
                      const isCurrent = idx === currentPage
                      const isProcessed = pages.has(idx)
                      const isProcessing = pdfProcessingPage === idx
                      const failed = pageErrors.has(idx)
                      return (
                        <button
                          key={idx}
                          className={`pdf-page-dot${isCurrent ? ' pdf-page-dot--active' : ''}${isProcessed ? ' pdf-page-dot--done' : ''}${isProcessing ? ' pdf-page-dot--processing' : ''}${failed ? ' pdf-page-dot--failed' : ''}`}
                          onClick={() => switchPdfPage(idx)}
                          aria-label={`Page ${idx + 1}`}
                          title={`Page ${idx + 1}${isProcessed ? ' (read)' : failed ? ' (could not be read)' : isProcessing ? ' (reading…)' : ''}`}
                        >
                          {idx + 1}
                        </button>
                      )
                    })}
                  </div>
                  <button
                    className="btn btn--sm btn--ghost pdf-page-nav__btn"
                    disabled={currentPage === pdfPages.length - 1}
                    onClick={() => switchPdfPage(currentPage + 1)}
                    aria-label="Next page"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card__body card__body--gap">
          <div className="preview-container" hidden={!hasPreview}>
            <canvas ref={previewRef} className="preview" />
          </div>

          {busy && isPdfMode && pdfProcessingPage !== null && (
            <p className="reading-note" aria-live="polite">
              Reading page {pdfProcessingPage + 1} of {pdfPages.length}…
              {result ? ' Export waits until every page is read.' : ''}
            </p>
          )}
          {busy && !result && !pageError && <StageProgress stages={stages} />}
          {!busy && unread.length > 0 && (
            <div className="reading-note reading-note--action">
              <span>
                {unread.length} of {pdfPages.length} pages not read, so the export leaves them out.
              </span>
              <button type="button" className="btn btn--sm" onClick={readRemaining}>
                Read remaining pages
              </button>
            </div>
          )}

          {(error ?? pageError) && (
            <div className="banner banner--err" role="alert">
              <div className="banner__icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div>
                <strong>
                  Could not read {isPdfMode ? (pageError && !error ? `page ${currentPage + 1}` : 'PDF') : 'image'}:
                </strong>{' '}
                {error ?? pageError}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
