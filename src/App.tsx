import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Dropzone } from './components/Dropzone'
import { FieldsView, JsonView } from './components/ResultView'
import { StageProgress } from './components/StageProgress'
import { reduceProgress, type StageMap } from './lib/stage-state'
import { useTheme, type ThemePreference } from './lib/theme'
import { drawImageDataTo, fileToImageData } from './lib/image-io'
import { OcrCancelledError, OcrClient } from './ocr/client'
import { toPublicJson, withCell } from './ocr/receipt/assemble'
import { DEFAULT_OPTIONS, type OcrResult } from './ocr/types'

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
    default: {
      const unreachable: never = result.kind
      return unreachable
    }
  }
}

const THEMES: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
]

export default function App() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [stages, setStages] = useState<StageMap>({})
  const [result, setResult] = useState<OcrResult | null>(null)
  const [readResult, setReadResult] = useState<OcrResult | null>(null)
  const [edited, setEdited] = useState<ReadonlySet<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [readerReady, setReaderReady] = useState(false)
  const [hasPreview, setHasPreview] = useState(false)
  const [previewData, setPreviewData] = useState<ImageData | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null)
  const [theme, setTheme] = useTheme()

  const options = useMemo(() => DEFAULT_OPTIONS, [])
  const previewRef = useRef<HTMLCanvasElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const client = useMemo(
    () =>
      new OcrClient(options, {
        onReady: () => setReaderReady(true),
        onFatal: (e) => setError(e.message),
      }),
    [],
  )

  useEffect(() => {
    client.ready().catch(() => {})
    return () => client.dispose()
  }, [client])

  // Guarantee canvas redraw whenever previewData or hasPreview updates
  useEffect(() => {
    if (previewRef.current && previewData) {
      drawImageDataTo(previewRef.current, previewData)
    }
  }, [previewData, hasPreview])

  const onFile = useCallback(
    async (file: File) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setFileName(file.name)
      setPhase(readerReady ? 'running' : 'booting')
      setStages({})
      setResult(null)
      setReadResult(null)
      setEdited(new Set())
      setError(null)

      try {
        const loaded = await fileToImageData(file, options.maxInputSize)
        setImageDimensions({ width: loaded.imageData.width, height: loaded.imageData.height })
        setPreviewData(loaded.imageData)
        setHasPreview(true)

        if (previewRef.current) {
          drawImageDataTo(previewRef.current, loaded.imageData)
        }

        const next = await client.run(
          loaded.imageData,
          { onProgress: (event) => setStages((prev) => reduceProgress(prev, event)) },
          controller.signal,
        )
        if (abortRef.current !== controller) return
        setResult(next)
        setReadResult(next)
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
    [client, readerReady, options.maxInputSize],
  )


  const onEdit = useCallback((rowIndex: number, cellIndex: number, value: string) => {
    setResult((current) => current && withCell(current, rowIndex, cellIndex, value))
    setEdited((current) => new Set(current).add(rowIndex))
  }, [])

  const resetEdits = () => {
    setResult(readResult)
    setEdited(new Set())
  }

  const clearCurrent = () => {
    abortRef.current?.abort()
    setPhase('idle')
    setResult(null)
    setReadResult(null)
    setEdited(new Set())
    setError(null)
    setHasPreview(false)
    setPreviewData(null)
    setFileName(null)
    setImageDimensions(null)
  }

  const busy = phase === 'running' || phase === 'booting'

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
              <span className="app__badge">Fast On-Device</span>
            </div>
            <p className="app__subtitle">
              Instant lottery & receipt reader. All processing happens on your device — 100% private.
            </p>
          </div>
        </div>

        <div className="app__controls">
          <div className="privacy-pill" title="No network transmission for OCR">
            <span className="privacy-dot" />
            <span className="privacy-text">Private & Offline</span>
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
          <div className="card">
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
                  <button className="btn btn--sm btn--danger" onClick={() => abortRef.current?.abort()}>
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

            <div className="card__body card__body--gap">
              <Dropzone onFile={onFile} disabled={busy} />

              {/* Image preview framing - always mounted in DOM, revealed when hasPreview is true */}
              <div className="preview-container" hidden={!hasPreview}>
                <div className="preview-meta">
                  <span className="preview-meta__filename" title={fileName ?? 'Receipt'}>
                    {fileName ?? 'Receipt'}
                  </span>
                  {imageDimensions && (
                    <span className="preview-meta__dims">
                      {imageDimensions.width} × {imageDimensions.height} px
                    </span>
                  )}
                </div>
                <canvas ref={previewRef} className="preview" />
              </div>

              {/* Progress and status */}
              {busy && <StageProgress stages={stages} />}

              {error && (
                <div className="banner banner--err" role="alert">
                  <div className="banner__icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>
                  <div>
                    <strong>Could not read image:</strong> {error}
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
                <div className="card__head card__head--compact">
                  <div className="card__head-title">
                    <span className="kind-badge">{resultTitle(result)}</span>
                    <span className="count">
                      {toPublicJson(result).rows.length} rows
                      {edited.size > 0 && ` · ${edited.size} edited`}
                    </span>
                  </div>
                  <div className="btn-row">
                    {edited.size > 0 && (
                      <button className="btn btn--sm btn--subtle" onClick={resetEdits}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                        </svg>
                        Reset edits
                      </button>
                    )}
                  </div>
                </div>

                <div className="card__body card__body--compact">
                  <FieldsView result={result} edited={edited} onEdit={onEdit} />
                </div>
              </div>

              <JsonView result={result} />
            </>
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
                <p className="empty-card__desc">
                  Select a lottery settlement ticket, inventory summary, or invoice to begin.
                  Our local OCR extracts headers, tables, numbers, and validates column arithmetic instantly.
                </p>

                <div className="empty-card__features">
                  <div className="feature-pill">
                    <span className="feature-pill__icon">⚡</span>
                    <span>Fast WASM OCR</span>
                  </div>
                  <div className="feature-pill">
                    <span className="feature-pill__icon">🛡️</span>
                    <span>Zero Data Leaves Device</span>
                  </div>
                  <div className="feature-pill">
                    <span className="feature-pill__icon">📊</span>
                    <span>Instant CSV & JSON Export</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
