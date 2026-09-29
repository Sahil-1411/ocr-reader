/**
 * Reads one receipt on the main thread: words from the Python reader (or
 * Tesseract when it is not running), then rows from `receipt/assemble.ts`.
 *
 * On the Tesseract path the coloured lottery stamp is painted out in plain
 * pixels first; the Python reader does that itself.
 */

import type { ColumnGuide } from './layout/columns'
import type { WordBox } from './layout/rows'
import {
  DEFAULT_PYTHON_READER_URL,
  pythonReaderHealthy,
  PythonReaderUnavailableError,
  readWithPython,
} from './python/reader'
import { assembleReceipt, rowCells } from './receipt/assemble'
import { isWatermarkWord, suppressColoredWatermark } from './receipt/color-watermark'
import { loadRecognizer, recognizeWords, terminateRecognizer } from './tesseract/engine'
import { DEFAULT_OPTIONS, type OcrOptions, type OcrResult, type ProgressEvent } from './types'

interface RunCallbacks {
  onProgress?: (event: ProgressEvent) => void
}

interface OcrClientEvents {
  /** Fired once a reader is loaded, with its name. */
  onReady?: (reader: string) => void
  /** Fired for failures that are not tied to a specific run. */
  onFatal?: (error: Error) => void
}

const now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

export class OcrCancelledError extends Error {
  constructor() {
    super('OCR run was cancelled')
    this.name = 'OcrCancelledError'
  }
}

export class OcrClient {
  #readyPromise: Promise<string> | null = null
  #events: OcrClientEvents
  #options: OcrOptions
  #disposed = false
  #runToken = 0
  #pythonUrl = DEFAULT_PYTHON_READER_URL
  /** What the Python reader reported it painted out, for `processingMeta`. */
  #pythonRatio = 0
  /** False once `ready()` has found the Python reader absent and fallen back. */
  #pythonAvailable = false

  constructor(options: Partial<OcrOptions> = {}, events: OcrClientEvents = {}) {
    this.#options = { ...DEFAULT_OPTIONS, ...options }
    this.#events = events
  }

  /**
   * Load the reader named by `options.reader`. Safe to call repeatedly — the
   * first call wins and later callers await the same promise.
   */
  ready(): Promise<string> {
    if (this.#disposed) return Promise.reject(new Error('OcrClient has been disposed'))
    if (this.#readyPromise) return this.#readyPromise

    const loading = this.#options.reader === 'python' ? this.#checkPython() : this.#loadTesseract()

    this.#readyPromise = loading
      .then((name) => {
        this.#events.onReady?.(name)
        return name
      })
      .catch((error: unknown) => {
        this.#readyPromise = null
        throw error instanceof Error ? error : new Error(String(error))
      })

    return this.#readyPromise
  }

  #loadTesseract(): Promise<string> {
    return loadRecognizer().then(() => 'tesseract')
  }

  /**
   * Confirm the Python reader is up before any image is read.
   *
   * Checked here rather than on the first read so a server that was never
   * started is reported before the user picks a file and watches it fail.
   */
  async #checkPython(): Promise<string> {
    if (await pythonReaderHealthy(this.#pythonUrl)) {
      this.#pythonAvailable = true
      return `python (${this.#pythonUrl})`
    }
    this.#pythonAvailable = false

    // Fall back rather than refuse to read at all — but say so loudly and name
    // it in the returned reader, because the two readers do not produce the
    // same answer and a silent downgrade would be indistinguishable from the
    // Python reader having been used.
    this.#events.onFatal?.(
      new PythonReaderUnavailableError(this.#pythonUrl, 'no response to /health'),
    )
    await this.#loadTesseract()
    return 'tesseract (Python reader not running)'
  }

  get #usingPython(): boolean {
    return this.#options.reader === 'python' && this.#pythonAvailable
  }

  /** The cleaned page in, words out — whichever reader is loaded. */
  async #readWords(image: ImageData, cleaned: Uint8ClampedArray, signal?: AbortSignal): Promise<WordBox[]> {
    if (this.#usingPython) {
      // The original image, not `cleaned`: the server suppresses the watermark
      // itself, and its word boxes then address the pixels it was given.
      const result = await readWithPython(image, this.#pythonUrl, signal)
      this.#pythonRatio = result.watermarkPixelRatio
      return result.words
    }
    // Tesseract resolves small print better on an enlarged page.
    const scale = 2
    const read = await recognizeWords(
      scaledCanvas(canvasFromPixels(image.width, image.height, cleaned), scale),
      signal,
    )
    return scaleWords(read, scale)
  }

  /**
   * Read one image and return the receipt JSON.
   *
   * The caller's `ImageData` is not transferred and stays usable.
   */
  async run(
    image: ImageData,
    callbacks: RunCallbacks = {},
    signal?: AbortSignal,
    guide?: ColumnGuide | null,
  ): Promise<OcrResult> {
    if (this.#disposed) throw new Error('OcrClient has been disposed')
    if (signal?.aborted) throw new OcrCancelledError()

    const token = ++this.#runToken
    const onAbort = () => {
      void terminateRecognizer()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      callbacks.onProgress?.({ stage: 'init', status: 'start', message: 'loading the reader…' })
      const reader = await this.ready()
      this.#throwIfStale(token, signal)
      callbacks.onProgress?.({ stage: 'init', status: 'done', message: 'reader ready' })

      // The Python reader runs its own port of this pass, so cleaning here too
      // would put every stroke through the ink ramp twice.
      const suppressHere = !this.#usingPython

      const watermarkStarted = now()
      callbacks.onProgress?.({ stage: 'watermark', status: 'start', message: 'removing the watermark…' })
      const cleaned = suppressHere
        ? suppressColoredWatermark(image.width, image.height, image.data)
        : { data: image.data, ratio: 0 }
      const watermarkMs = now() - watermarkStarted
      callbacks.onProgress?.({
        stage: 'watermark',
        status: suppressHere ? 'done' : 'skip',
        message: suppressHere
          ? `${Math.round(cleaned.ratio * 1000) / 10}% of the page`
          : 'the Python reader does this itself',
        elapsedMs: watermarkMs,
      })

      const recognizeStarted = now()
      callbacks.onProgress?.({ stage: 'recognize', status: 'start', message: 'reading the receipt…' })
      const read = await this.#readWords(image, cleaned.data, signal)
      const words = read.filter((word) => !isWatermarkWord(image.width, image.data, word))
      this.#throwIfStale(token, signal)

      const recognizeMs = now() - recognizeStarted
      callbacks.onProgress?.({
        stage: 'recognize',
        status: 'done',
        message: `${words.length} words`,
        elapsedMs: recognizeMs,
      })

      const assembleStarted = now()
      callbacks.onProgress?.({ stage: 'assemble', status: 'start', message: 'building rows…' })
      const watermarkPixelRatio = suppressHere ? cleaned.ratio : this.#pythonRatio
      const result = assembleReceipt(
        words,
        {
          reader,
          watermarkSuppressed: watermarkPixelRatio > 0.005,
          watermarkPixelRatio,
          sourceSize: { width: image.width, height: image.height },
          timingsMs: { watermark: watermarkMs, recognize: recognizeMs },
        },
        this.#options.rowOverlapRatio,
        guide,
      )
      const assembleMs = now() - assembleStarted
      result.processingMeta.timingsMs.assemble = assembleMs
      result.processingMeta.totalMs = watermarkMs + recognizeMs + assembleMs
      callbacks.onProgress?.({
        stage: 'assemble',
        status: 'done',
        message: `${rowCells(result).length} rows`,
        elapsedMs: assembleMs,
      })
      this.#throwIfStale(token, signal)
      return result
    } catch (error) {
      if (signal?.aborted || error instanceof OcrCancelledError) throw new OcrCancelledError()
      callbacks.onProgress?.({
        stage: 'recognize',
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Build rows from words the PDF already contained.
   *
   * Skips watermark removal and OCR. The boxes are in the rendered page's
   * pixel space, the same space a reader would have returned.
   */
  assembleFromWords(
    words: readonly WordBox[],
    sourceSize: { width: number; height: number },
    callbacks: RunCallbacks = {},
    signal?: AbortSignal,
    guide?: ColumnGuide | null,
  ): OcrResult {
    if (this.#disposed) throw new Error('OcrClient has been disposed')
    if (signal?.aborted) throw new OcrCancelledError()

    this.#runToken += 1
    callbacks.onProgress?.({ stage: 'init', status: 'done', message: 'using the PDF text' })
    callbacks.onProgress?.({
      stage: 'watermark',
      status: 'skip',
      message: 'digital text needs no cleanup',
    })
    callbacks.onProgress?.({
      stage: 'recognize',
      status: 'skip',
      message: `${words.length} words from the PDF`,
    })

    const assembleStarted = now()
    callbacks.onProgress?.({ stage: 'assemble', status: 'start', message: 'building rows…' })
    const result = assembleReceipt(
      words,
      {
        reader: 'pdf text',
        watermarkSuppressed: false,
        watermarkPixelRatio: 0,
        sourceSize,
        timingsMs: {},
      },
      this.#options.rowOverlapRatio,
      guide,
    )
    const assembleMs = now() - assembleStarted
    result.processingMeta.timingsMs.assemble = assembleMs
    result.processingMeta.totalMs = assembleMs
    callbacks.onProgress?.({
      stage: 'assemble',
      status: 'done',
      message: `${rowCells(result).length} rows`,
      elapsedMs: assembleMs,
    })
    if (signal?.aborted) throw new OcrCancelledError()
    return result
  }

  #throwIfStale(token: number, signal: AbortSignal | undefined): void {
    if (this.#disposed || token !== this.#runToken || signal?.aborted) throw new OcrCancelledError()
  }

  /** Drop the reader. An in-flight `run` rejects with {@link OcrCancelledError}. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#runToken += 1
    this.#readyPromise = null
    void terminateRecognizer()
  }
}

function canvasFromPixels(width: number, height: number, pixels: Uint8ClampedArray): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare the page for reading')
  const image = new ImageData(new Uint8ClampedArray(pixels), width, height)
  context.putImageData(image, 0, 0)
  return canvas
}

/** Draw the page larger. The reader resolves small print more reliably that way. */
function scaledCanvas(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  if (scale === 1) return source
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(source.width * scale)
  canvas.height = Math.round(source.height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare the page for reading')
  context.imageSmoothingEnabled = false
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

function scaleWords(words: readonly WordBox[], scale: number): WordBox[] {
  if (scale === 1) return [...words]
  return words.map((word) => ({
    ...word,
    x: word.x / scale,
    y: word.y / scale,
    width: word.width / scale,
    height: word.height / scale,
  }))
}
