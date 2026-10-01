import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { reduceProgress, type StageMap } from '../../lib/stage-state'
import { drawImageDataTo, fileToImageData } from '../../lib/image-io'
import { isPdf, pdfToImages, type PdfPage } from '../../lib/pdf-to-images'
import { textLayerIsUsable } from '../../lib/pdf-text'
import { OcrCancelledError, OcrClient } from '../../ocr/client'
import type { ColumnGuide } from '../../ocr/layout/columns'
import { withCell } from '../../ocr/receipt/assemble'
import type { PageFailure } from '../../lib/export'
import { DEFAULT_OPTIONS, type OcrResult, type ProgressEvent } from '../../ocr/types'
import { NO_EDITS, type PageRead, type Phase, type ReceiptSession } from './types'

/** A table's columns, to read the next page by when it prints no header of its own. */
function guideFrom(result: OcrResult): ColumnGuide | null {
  return result.kind === 'table' && result.columnBounds?.length === result.headers.length
    ? { headers: result.headers, bounds: result.columnBounds }
    : null
}

/** Upload, read, edit, and page through one receipt. */
export function useReceiptSession(): ReceiptSession {
  const [phase, setPhase] = useState<Phase>('idle')
  const [stages, setStages] = useState<StageMap>({})
  // Every page read so far, by page index. An image is page 0 of one.
  const [pages, setPages] = useState<ReadonlyMap<number, PageRead>>(new Map())
  const [pageErrors, setPageErrors] = useState<ReadonlyMap<number, string>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [readerReady, setReaderReady] = useState(false)
  const [hasPreview, setHasPreview] = useState(false)
  const [previewData, setPreviewData] = useState<ImageData | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null)

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
        onReady: () => {
          setReaderReady(true)
        },
        onFatal: (e) => setError(e.message),
      }),
    [options],
  )

  useEffect(() => {
    client.ready().catch(() => {})
    return () => client.dispose()
  }, [client])

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
    async (imageData: ImageData, controller: AbortController): Promise<OcrResult> => {
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
  /**
   * Pages the export has no rows for, for the skipped log: one whose read
   * failed, and one reading never reached.
   */
  const failures = useMemo<PageFailure[]>(() => {
    if (!isPdfMode) return []
    return pdfPages.flatMap((_, index) =>
      pages.has(index)
        ? []
        : [
            {
              page: index + 1,
              message:
                pageErrors.get(index) ??
                (phase === 'running' || phase === 'booting'
                  ? 'Not read yet.'
                  : 'Reading stopped before this page.'),
            },
          ],
    )
  }, [isPdfMode, pdfPages, pages, pageErrors, phase])
  const tablePages = useMemo(
    () =>
      [...pages.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, page]) => ({ index, result: page.result, edited: page.edited })),
    [pages],
  )

  const busy = phase === 'running' || phase === 'booting'

  return {
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
    edited,
    busy,
    unread,
    pageError,
    failures,
    exportPages,
    tablePages,
    onFile,
    onEditPage,
    resetEdits,
    cancel,
    readRemaining,
    clearCurrent,
    switchPdfPage,
  }
}
