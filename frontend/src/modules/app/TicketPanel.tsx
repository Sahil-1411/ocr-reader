import { Dropzone } from '../../components/Dropzone'
import { ReceiptViewer, type PageState } from '../../components/ReceiptViewer'
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
    words,
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

  /** How a page stands with the reader, for its thumbnail. */
  const stateOf = (index: number): PageState => {
    if (pages.has(index)) return 'read'
    if (pageErrors.has(index)) return 'failed'
    if (pdfProcessingPage === index) return 'reading'
    return 'pending'
  }

  return (
    <div className="stack">
      <ReceiptViewer
        previewRef={previewRef}
        words={words}
        size={imageDimensions}
        hasPreview={hasPreview}
        fileName={fileName}
        pages={isPdfMode ? pdfPages : []}
        currentPage={currentPage}
        onSwitchPage={switchPdfPage}
        stateOf={stateOf}
        actions={
          <>
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
          </>
        }
        empty={
          hasPreview ? null : (
            <Dropzone onFile={onFile} disabled={busy} />
          )
        }
        footer={
          <>
            {hasPreview && (
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
            )}

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
          </>
        }
      />
    </div>
  )
}
