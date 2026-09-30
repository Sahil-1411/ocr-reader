import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Dropzone } from './components/Dropzone'
import { FieldsView, JsonView } from './components/ResultView'
import { StageProgress } from './components/StageProgress'
import { reduceProgress, type StageMap } from './lib/stage-state'
import { useTheme, type ThemePreference } from './lib/theme'
import { drawImageDataTo, fileToImageData } from './lib/image-io'
import { isPdf, pdfToImages, type PdfPage } from './lib/pdf-to-images'
import { textLayerIsUsable } from './lib/pdf-text'
import { OcrCancelledError, OcrClient } from './ocr/client'
import type { ColumnGuide } from './ocr/layout/columns'
import { withCell } from './ocr/receipt/assemble'
import { DEFAULT_OPTIONS, type OcrResult, type ProgressEvent } from './ocr/types'

type Phase = 'idle' | 'booting' | 'running' | 'done' | 'error'

function resultTitle(result: OcrResult): string {
  if (result.title) return result.title
  switch (result.kind) {
    case 'inventory':
      return 'Inventory Summary'
    case 'settlements':
      return 'Pack Settlements'
    case 'invoice':
      return 'Invoice Breakdown'
    case 'table':
      return 'Invoice'
    default: {
      const unreachable: never = result.kind
      return unreachable
    }
  }
}

const NO_EDITS: ReadonlySet<number> = new Set()

const THEMES: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
]

/** One page's reading: as read, as edited, and which rows were edited. */
interface PageRead {
  result: OcrResult
  readResult: OcrResult
  edited: ReadonlySet<number>
}

/** A table's columns, to read the next page by when it prints no header of its own. */
function guideFrom(result: OcrResult): ColumnGuide | null {
  return result.kind === 'table' && result.columnBounds?.length === result.headers.length
    ? { headers: result.headers, bounds: result.columnBounds }
    : null
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [stages, setStages] = useState<StageMap>({})
  // Every page read so far, by page index. An image is page 0 of one.
  const [pages, setPages] = useState<ReadonlyMap<number, PageRead>>(new Map())
  const [pageErrors, setPageErrors] = useState<ReadonlyMap<number, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [readerReady, setReaderReady] = useState(false)
  const [readerName, setReaderName] = useState<string | null>(null)
  const [hasPreview, setHasPreview] = useState(false)
  const [previewData, setPreviewData] = useState<ImageData | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null)
  const [theme, setTheme] = useTheme()

  // PDF multi-page state
  const [pdfPages, setPdfPages] = useState<PdfPage[]>([])
  const [currentPage, setCurrentPage] = useState(0)
  const [isPdfMode, setIsPdfMode] = useState(false)
  const [pdfProcessingPage, setPdfProcessingPage] = useState<number | null>(null)

  const options = useMemo(() => DEFAULT_OPTIONS, [])
  const previewRef = useRef<HTMLCanvasElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const current = pages.get(currentPage)
  const result = current?.result ?? null
  const edited = current?.edited ?? NO_EDITS

  const client = useMemo(
    () =>
      new OcrClient(options, {
        onReady: (name) => {
          setReaderName(name)
          setReaderReady(true)
        },
        onFatal: (e) => setError(e.message),
      }),
    [],
  )

  useEffect(() => {
    client.ready().catch(() => { })
    return () => client.dispose()
  }, [client])

  // Guarantee canvas redraw whenever previewData or hasPreview updates
  useEffect(() => {
    if (previewRef.current && previewData) {
      drawImageDataTo(previewRef.current, previewData)
    }
  }, [previewData, hasPreview])

  /** Show a PDF page's picture while its rows are read or looked at. */
  const showPdfPage = useCallback((page: PdfPage) => {
    setImageDimensions({ width: page.width, height: page.height })
    setPreviewData(page.imageData)
    setHasPreview(true)
    if (previewRef.current) {
      drawImageDataTo(previewRef.current, page.imageData)
    }
  }, [])

  /** Read one PDF page from its text layer, or OCR the raster when it has none. */
  const recognizePage = useCallback(
    async (page: PdfPage, controller: AbortController, guide: ColumnGuide | null): Promise<OcrResult> => {
      const onProgress = (event: ProgressEvent) => {
        setStages((prev) => reduceProgress(prev, event))
      }
      if (textLayerIsUsable(page.words)) {
        return client.assembleFromWords(
          page.words,
          { width: page.width, height: page.height },
          { onProgress },
          controller.signal,
          guide,
        )
      }
      return client.run(page.imageData, { onProgress }, controller.signal, guide)
    },
    [client],
  )

  /** Process a single ImageData through the OCR pipeline. */
  const processImageData = useCallback(
    async (
      imageData: ImageData,
      controller: AbortController,
    ): Promise<OcrResult> => {
      setImageDimensions({ width: imageData.width, height: imageData.height })
      setPreviewData(imageData)
      setHasPreview(true)

      if (previewRef.current) {
        drawImageDataTo(previewRef.current, imageData)
      }

      return client.run(
        imageData,
        { onProgress: (event) => setStages((prev) => reduceProgress(prev, event)) },
        controller.signal,
      )
    },
    [client],
  )

  /**
   * Read pages first to last, while the first is already on screen.
   *
   * In order because a page that prints no header of its own is read by the
   * columns of the page before it, and because the export is the whole
   * document. A page that fails is noted and the rest are still read. `only`
   * reads just those pages — the ones a cancel or a failure left — with the
   * columns of the nearest page before each that was read.
   */
  const readPdfPages = useCallback(
    async (
      all: readonly PdfPage[],
      controller: AbortController,
      only?: readonly number[],
      known: ReadonlyMap<number, PageRead> = new Map(),
    ) => {
      const read = new Map<number, OcrResult>([...known].map(([index, page]) => [index, page.result]))
      const guideBefore = (index: number): ColumnGuide | null => {
        for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
          const found = read.get(earlier)
          const guide = found && guideFrom(found)
          if (guide) return guide
        }
        return null
      }
      // A reader that cannot start fails every scanned page the same way, and
      // each try waits out its start-up; one try is enough to say so.
      let readerDown: string | null = null
      const fail = (index: number, error: unknown) =>
        setPageErrors((prev) => new Map(prev).set(index, error instanceof Error ? error.message : String(error)))

      for (const index of only ?? all.map((_, at) => at)) {
        const page = all[index]
        if (!page || controller.signal.aborted) break
        setPdfProcessingPage(index)
        setStages({})
        if (!textLayerIsUsable(page.words)) {
          if (readerDown) {
            fail(index, readerDown)
            continue
          }
          try {
            await client.ready()
          } catch (e) {
            if (abortRef.current !== controller) return
            readerDown = e instanceof Error ? e.message : String(e)
            fail(index, e)
            continue
          }
        }
        try {
          const next = await recognizePage(page, controller, guideBefore(index))
          if (abortRef.current !== controller) return
          read.set(index, next)
          setPages((prev) => new Map(prev).set(index, { result: next, readResult: next, edited: NO_EDITS }))
        } catch (e) {
          if (abortRef.current !== controller) return
          if (e instanceof OcrCancelledError) break
          fail(index, e)
        }
      }
      if (abortRef.current !== controller) return
      setPdfProcessingPage(null)
      setPhase(read.size > 0 ? 'done' : 'idle')
    },
    [client, recognizePage],
  )

  const onFile = useCallback(
    async (file: File) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setFileName(file.name)
      setPhase(readerReady ? 'running' : 'booting')
      setStages({})
      setPages(new Map())
      setPageErrors(new Map())
      // The last file's picture must not stand in for this one while it loads.
      setHasPreview(false)
      setPreviewData(null)
      setError(null)
      setPdfPages([])
      setCurrentPage(0)
      setPdfProcessingPage(null)

      // ─── PDF path ───
      if (isPdf(file)) {
        setIsPdfMode(true)
        try {
          const all = await pdfToImages(file, 200)
          if (abortRef.current !== controller) return
          const first = all[0]
          if (!first) throw new Error('PDF has no pages')
          setPdfPages(all)
          showPdfPage(first)
          setPhase('running')
          await readPdfPages(all, controller)
        } catch (e) {
          if (abortRef.current !== controller) return
          setError(e instanceof Error ? e.message : String(e))
          setPhase('error')
        }
        return
      }

      // ─── Image path (unchanged) ───
      setIsPdfMode(false)
      try {
        const loaded = await fileToImageData(file, options.maxInputSize)
        const next = await processImageData(loaded.imageData, controller)
        if (abortRef.current !== controller) return
        setPages(new Map([[0, { result: next, readResult: next, edited: NO_EDITS }]]))
        setPhase('done')
      } catch (e) {
        if (abortRef.current !== controller) return
        if (e instanceof OcrCancelledError) {
          setPhase('idle')
          return
        }
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    },
    [readerReady, options.maxInputSize, processImageData, readPdfPages, showPdfPage],
  )

  // Edits belong to their page, so moving between pages keeps them and the
  // export carries every page's.
  const onEditPage = useCallback(
    (pageIndex: number, rowIndex: number, cellIndex: number, value: string) => {
      setPages((prev) => {
        const page = prev.get(pageIndex)
        if (!page) return prev
        return new Map(prev).set(pageIndex, {
          ...page,
          result: withCell(page.result, rowIndex, cellIndex, value),
          edited: new Set(page.edited).add(rowIndex),
        })
      })
    },
    [],
  )

  const resetEdits = () => {
    setPages((prev) => {
      const page = prev.get(currentPage)
      if (!page) return prev
      return new Map(prev).set(currentPage, { ...page, result: page.readResult, edited: NO_EDITS })
    })
  }

  const cancel = () => {
    abortRef.current?.abort()
    setPdfProcessingPage(null)
    setPhase(pages.size > 0 ? 'done' : 'idle')
  }

  /** Pages a cancel or a failure left unread. Reading them again keeps every edit. */
  const unread = isPdfMode ? pdfPages.flatMap((_, index) => (pages.has(index) ? [] : [index])) : []
  const readRemaining = () => {
    if (unread.length === 0) return
    const controller = new AbortController()
    abortRef.current = controller
    setPageErrors((prev) => {
      const next = new Map(prev)
      for (const index of unread) next.delete(index)
      return next
    })
    setError(null)
    setPhase('running')
    void readPdfPages(pdfPages, controller, unread, pages)
  }

  const clearCurrent = () => {
    abortRef.current?.abort()
    setPhase('idle')
    setPages(new Map())
    setPageErrors(new Map())
    setError(null)
    setHasPreview(false)
    setPreviewData(null)
    setFileName(null)
    setImageDimensions(null)
    setPdfPages([])
    setIsPdfMode(false)
    setCurrentPage(0)
    setPdfProcessingPage(null)
  }

  /** Look at another PDF page. Its rows show as soon as they are read. */
  const switchPdfPage = useCallback(
    (pageIndex: number) => {
      const page = pdfPages[pageIndex]
      if (!page) return
      setCurrentPage(pageIndex)
      showPdfPage(page)
    },
    [pdfPages, showPdfPage],
  )

  const exportPages = useMemo(
    () =>
      [...pages.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, page]) => ({ page: index + 1, result: page.result })),
    [pages],
  )
  const pageError = pageErrors.get(currentPage)
  // Every page read so far, for a search across the whole document.
  const tablePages = useMemo(
    () =>
      [...pages.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, page]) => ({ index, result: page.result, edited: page.edited })),
    [pages],
  )

  const busy = phase === 'running' || phase === 'booting'
  const onDevice = readerName?.startsWith('tesseract') ?? false

  return (
    <div className="app">
      {/* Top Navbar */}
      <header className="app__header">
        <div className="app__brand">
          <div className="app__logo" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 3h16a1 1 0 0 1 1 1v17l-3-2-3 2-3-2-3 2-3-2-2 2V4a1 1 0 0 1 1-1Z" />
              <path d="M8 8h8" />
              <path d="M8 12h8" />
              <path d="M8 16h4" />
            </svg>
          </div>
          <div>
            <div className="app__title-row">
              <h1 className="app__title">Receipt OCR</h1>
              <span className="app__badge">{onDevice ? 'On this device' : 'OCR server'}</span>
            </div>
            <p className="app__subtitle">
              Instant lottery and receipt reader.
              {onDevice
                ? ' This fallback reads the page in the browser.'
                : ' Photos are sent to the OCR server for this site.'}
            </p>
          </div>
        </div>

        <div className="app__controls">
          <div
            className="privacy-pill"
            title={onDevice ? 'Tesseract is reading the page in this browser' : 'The Python reader on this site reads the photo'}
          >
            <span className="privacy-dot" />
            <span className="privacy-text">{onDevice ? 'In the browser' : 'OCR server'}</span>
          </div>

          <div className="segmented" role="group" aria-label="Theme selector">
            {THEMES.map(({ value, label, icon }) => (
              <button
                key={value}
                type="button"
                className={`segmented__option${theme === value ? ' segmented__option--active' : ''}`}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                {icon === 'sun' && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" />
                    <line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" />
                    <line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                  </svg>
                )}
                {icon === 'moon' && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                )}
                {icon === 'monitor' && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                )}
                <span className="segmented__label">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Main Two-Column Layout */}
      <div className="app__grid">
        {/* Left Column: Image & Upload Card */}
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

                {/* PDF page navigator */}
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
                            className={`pdf-page-dot${isCurrent ? ' pdf-page-dot--active' : ''
                              }${isProcessed ? ' pdf-page-dot--done' : ''}${isProcessing ? ' pdf-page-dot--processing' : ''
                              }${failed ? ' pdf-page-dot--failed' : ''}`}
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

              {/* Progress and status */}
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

        {/* Right Column: Extracted Result & Interactive Table */}
        <div className="stack">
          {result ? (
            <>
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
            </>
          ) : isPdfMode && pdfPages.length > 0 ? (
            // A page of this document with no rows to show yet: say why.
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
            <JsonView
              pages={exportPages}
              total={isPdfMode ? pdfPages.length : 1}
              reading={busy}
              fileName={fileName}
            />
          )}
        </div>
      </div>
    </div>
  )
}
