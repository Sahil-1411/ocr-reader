import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Dropzone } from './components/Dropzone'
import { FieldsView, JsonView } from './components/ResultView'
import { StageProgress } from './components/StageProgress'
import { reduceProgress, type StageMap } from './lib/stage-state'
import { useTheme, type ThemePreference } from './lib/theme'
import { drawImageDataTo, fileToImageData } from './lib/image-io'
import { OcrCancelledError, OcrClient } from './ocr/client'
import { toPublicJson, withCell } from './ocr/receipt/assemble'
import { DEFAULT_OPTIONS, type OcrResult, type ReceiptKind } from './ocr/types'

type Phase = 'idle' | 'booting' | 'running' | 'done' | 'error'

function resultTitle(kind: ReceiptKind): string {
  switch (kind) {
    case 'inventory':
      return 'Inventory'
    case 'settlements':
      return 'Pack settlements'
    case 'invoice':
      return 'Invoice'
    default: {
      const unreachable: never = kind
      return unreachable
    }
  }
}

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export default function App() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [stages, setStages] = useState<StageMap>({})
  const [result, setResult] = useState<OcrResult | null>(null)
  // The result as read, kept so hand edits can be undone.
  const [readResult, setReadResult] = useState<OcrResult | null>(null)
  const [edited, setEdited] = useState<ReadonlySet<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [readerReady, setReaderReady] = useState(false)
  const [hasPreview, setHasPreview] = useState(false)
  const [theme, setTheme] = useTheme()

  const options = useMemo(() => DEFAULT_OPTIONS, [])
  const previewRef = useRef<HTMLCanvasElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // One client for the life of the page, so the reader is loaded once.
  const client = useMemo(
    () =>
      new OcrClient(options, {
        onReady: () => setReaderReady(true),
        onFatal: (e) => setError(e.message),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally once per page
    [],
  )

  useEffect(() => {
    // Load the reader now so the first image doesn't wait on it. A failure is
    // reported through `onFatal`.
    client.ready().catch(() => {})
    return () => client.dispose()
  }, [client])

  const onFile = useCallback(
    async (file: File) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setPhase(readerReady ? 'running' : 'booting')
      setStages({})
      setResult(null)
      setReadResult(null)
      setEdited(new Set())
      setError(null)

      try {
        const loaded = await fileToImageData(file, options.maxInputSize)
        if (previewRef.current) {
          drawImageDataTo(previewRef.current, loaded.imageData)
          setHasPreview(true)
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

  const busy = phase === 'running' || phase === 'booting'

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">Receipt OCR</h1>
          <p className="app__subtitle">
            Upload a receipt photo. It is read on this computer and never leaves it.
          </p>
        </div>
        <div className="app__controls">
          <div className="segmented" role="group" aria-label="Theme">
            {THEMES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={`segmented__option${theme === value ? ' segmented__option--active' : ''}`}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="app__grid">
        <div className="stack">
          <div className="card">
            <div className="card__head">
              <h2 className="card__title">Image</h2>
              {busy && (
                <button className="btn btn--sm" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </button>
              )}
            </div>
            <div className="card__body" style={{ display: 'grid', gap: 14 }}>
              <Dropzone onFile={onFile} disabled={busy} />
              <canvas ref={previewRef} className="preview" hidden={!hasPreview} />
              {(busy || Object.keys(stages).length > 0) && (
                <StageProgress stages={stages} running={busy} />
              )}
              {error && (
                <div className="banner banner--err">
                  <div>
                    <strong>Could not read that image.</strong> {error}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="stack">
          {result ? (
            <>
              <div className="card">
                <div className="card__head">
                  <h2 className="card__title">{resultTitle(result.kind)}</h2>
                  <div className="btn-row">
                    {edited.size > 0 && (
                      <button className="btn btn--sm" onClick={resetEdits}>
                        Reset edits
                      </button>
                    )}
                    <span className="count">
                      {toPublicJson(result).rows.length} rows
                      {edited.size > 0 && ` · ${edited.size} edited`}
                    </span>
                  </div>
                </div>
                <div className="card__body">
                  <p className="muted fields__hint">
                    Click any cell to correct it. Red rows are missing data; the JSON below
                    includes your edits.
                  </p>
                  <FieldsView result={result} edited={edited} onEdit={onEdit} />
                </div>
              </div>

              <JsonView result={result} />
            </>
          ) : (
            <div className="card">
              <div className="card__head">
                <h2 className="card__title">Result</h2>
              </div>
              <div className="card__body">
                <p className="muted">
                  The extracted JSON will appear here, keyed by the ticket's own column
                  headers. An inventory summary uses Game, Name, Int, Rec, Act, and Set, with
                  one row for every printed game plus TOTALS. A pack settlement uses
                  Game-Pack, Name, and Date Settled. An invoice uses a label and an amount.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
