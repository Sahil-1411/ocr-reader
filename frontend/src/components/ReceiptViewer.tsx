import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react'

import { exportBaseName } from '../lib/download'
import { Pager } from './Pager'
import type { DocumentPage } from '../ocr/api'
import type { WordBox } from '../ocr/types'

/* -------------------------------------------------------------------------- */
/* Icons                                                                       */
/* -------------------------------------------------------------------------- */

const ICON = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

function ZoomIcon({ out }: { out?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...ICON}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
      {!out && <line x1="11" y1="8" x2="11" y2="14" />}
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...ICON}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  )
}

function SaveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...ICON}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* Thumbnails                                                                  */
/* -------------------------------------------------------------------------- */

/** How a page stands with the reader, which its thumbnail shows. */
export type PageState = 'read' | 'reading' | 'failed' | 'pending'

function PageThumb({
  page,
  index,
  active,
  state,
  onOpen,
}: {
  page: DocumentPage
  index: number
  active: boolean
  state: PageState
  onOpen: (index: number) => void
}) {
  // The reader renders the pages, so a thumbnail is the same picture the
  // viewer shows, drawn small. The browser fetches it once and keeps it, so
  // paging back and forth costs nothing.
  return (
    <button
      type="button"
      className={`page-thumb page-thumb--${state}${active ? ' page-thumb--active' : ''}`}
      onClick={() => onOpen(index)}
      aria-label={`Page ${index + 1}`}
      aria-current={active ? 'true' : undefined}
      title={`Page ${index + 1}${state === 'read' ? '' : state === 'failed' ? ' (could not be read)' : state === 'reading' ? ' (reading…)' : ' (not read yet)'}`}
    >
      {/* The page's own proportions, so the strip has its height before the
          pictures arrive. Without it an unloaded image is zero pixels tall,
          which leaves it outside the viewport and so never loaded. */}
      <img
        src={page.thumbnailUrl}
        className="page-thumb__canvas"
        alt=""
        style={{ aspectRatio: `${page.size.width} / ${page.size.height}` }}
      />
      <span className="page-thumb__num">{index + 1}</span>
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Viewer                                                                      */
/* -------------------------------------------------------------------------- */

/** The sizes the zoom buttons step the page through, smallest first. */
const ZOOM_STEPS = [1, 1.5, 2, 3] as const

const MIN_ZOOM = ZOOM_STEPS[0]
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]

interface ReceiptViewerProps {
  /** The canvas the session draws the page on screen into. */
  previewRef: RefObject<HTMLCanvasElement | null>
  /** The words the page was read from, for the overlay. */
  words: readonly WordBox[]
  /** The read page's pixel size, which the overlay is placed in. */
  size: { width: number; height: number } | null
  hasPreview: boolean
  fileName: string | null
  /** Every page of the document. Empty for a single image. */
  pages: readonly DocumentPage[]
  currentPage: number
  onSwitchPage: (index: number) => void
  stateOf: (index: number) => PageState
  /** Buttons for the right of the title bar: cancel, clear. */
  actions?: ReactNode
  /** Shown in place of the page while there is none: the dropzone. */
  empty: ReactNode
  /** Progress notes and banners, under the page. */
  footer?: ReactNode
}

/**
 * The uploaded page: the picture, the words read off it, and the way through
 * a PDF's pages.
 *
 * The picture and the overlay are two views of one page rather than two
 * panels, because they are the same thing twice and only ever looked at one
 * at a time.
 */
export function ReceiptViewer({
  previewRef,
  words,
  size,
  hasPreview,
  fileName,
  pages,
  currentPage,
  onSwitchPage,
  stateOf,
  actions,
  empty,
  footer,
}: ReceiptViewerProps) {
  const [tab, setTab] = useState<'image' | 'overlay'>('image')
  const [zoom, setZoom] = useState(1)
  const stageRef = useRef<HTMLDivElement>(null)
  const total = pages.length || 1

  // A new page is a new look at it: the one before it may have been zoomed
  // into a corner this page has nothing in. Adjusted while rendering the new
  // page rather than after, so the page never shows at the old zoom first.
  const [zoomedPage, setZoomedPage] = useState(currentPage)
  if (zoomedPage !== currentPage) {
    setZoomedPage(currentPage)
    setZoom(1)
  }

  /** Step one size up or down the list, stopping at either end. */
  const stepZoom = (by: 1 | -1) => {
    const at = ZOOM_STEPS.indexOf(zoom as (typeof ZOOM_STEPS)[number])
    const next = ZOOM_STEPS[Math.min(Math.max(at + by, 0), ZOOM_STEPS.length - 1)]
    setZoom(next ?? MIN_ZOOM)
  }

  const toggleFullscreen = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void stage.requestFullscreen?.().catch(() => {})
  }, [])

  /** Save the page as it was read, which is the picture the rows came from. */
  const download = useCallback(() => {
    const canvas = previewRef.current
    if (!canvas) return
    const name = `${exportBaseName(fileName, 'receipt')}${pages.length > 1 ? `-page-${currentPage + 1}` : ''}.png`
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }, 'image/png')
  }, [previewRef, fileName, pages.length, currentPage])

  const overlay = tab === 'overlay' && size !== null && words.length > 0

  return (
    <div className="card viewer-card">
      <div className="card__head">
        <div className="card__head-title">
          <span className="card__step" aria-hidden="true">
            1
          </span>
          <h2 className="card__title">Receipt Image</h2>
        </div>
        <div className="btn-row">
          {actions}
          {hasPreview && (
            <>
              <button
                type="button"
                className="icon-btn"
                onClick={() => stepZoom(-1)}
                disabled={zoom === MIN_ZOOM}
                title={zoom === MIN_ZOOM ? 'The page is already whole' : `Zoom out from ${zoom}×`}
                aria-label="Zoom out"
              >
                <ZoomIcon out />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => stepZoom(1)}
                disabled={zoom === MAX_ZOOM}
                title={zoom === MAX_ZOOM ? `Zoomed ${zoom}×, as far as it goes` : 'Zoom in'}
                aria-label="Zoom in"
              >
                <ZoomIcon />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={toggleFullscreen}
                title="Fill the screen with this page"
                aria-label="Fullscreen"
              >
                <ExpandIcon />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={download}
                title="Save this page as a PNG"
                aria-label="Download page"
              >
                <SaveIcon />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="card__body card__body--gap">
        {hasPreview && (
          <div className="viewer-tabs" role="tablist" aria-label="How to look at the page">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'image'}
              className={`viewer-tab${tab === 'image' ? ' viewer-tab--active' : ''}`}
              onClick={() => setTab('image')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" {...ICON}>
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
              Image
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'overlay'}
              className={`viewer-tab${tab === 'overlay' ? ' viewer-tab--active' : ''}`}
              onClick={() => setTab('overlay')}
              disabled={words.length === 0}
              title={words.length === 0 ? 'This page has not been read yet' : 'Show what the reader read, over the page'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" {...ICON}>
                <polyline points="4 7 4 4 20 4 20 7" />
                <line x1="9" y1="20" x2="15" y2="20" />
                <line x1="12" y1="4" x2="12" y2="20" />
              </svg>
              Text Overlay
            </button>
          </div>
        )}

        {empty}

        {hasPreview && (
          <>
            <div className={`viewer-stage${zoom > 1 ? ' viewer-stage--zoomed' : ''}`} ref={stageRef}>
              <div className="viewer-page" style={{ width: `${zoom * 100}%` }}>
                <canvas ref={previewRef} className="preview" />
                {overlay && (
                  <div className="word-layer" aria-hidden="true">
                    {words.map((word, index) => (
                      <span
                        key={`${index}-${word.x}-${word.y}`}
                        className={`word-box${word.confidence < 0.55 ? ' word-box--low' : ''}`}
                        style={{
                          left: `${(word.x / size.width) * 100}%`,
                          top: `${(word.y / size.height) * 100}%`,
                          width: `${(word.width / size.width) * 100}%`,
                          height: `${(word.height / size.height) * 100}%`,
                        }}
                        title={`${word.text} · ${(word.confidence * 100).toFixed(0)}%`}
                      >
                        {word.text}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <Pager current={currentPage} total={total} onSwitch={onSwitchPage} />

            {pages.length > 1 && (
              <div className="thumb-strip" role="list">
                {pages.map((page, index) => (
                  <PageThumb
                    key={page.page}
                    page={page}
                    index={index}
                    active={index === currentPage}
                    state={stateOf(index)}
                    onOpen={onSwitchPage}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {footer}
      </div>
    </div>
  )
}
