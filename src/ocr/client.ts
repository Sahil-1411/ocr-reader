/**
 * Reads one receipt on the main thread.
 *
 * The coloured lottery stamp is painted out in plain pixels first. OpenCV's
 * watermark pass is not on this path: its runtime can fail to settle, and a
 * run that waits for it leaves the spinner up with no result.
 */

import type { WordBox } from './layout/rows'
import { DEFAULT_MODEL_BUNDLE } from './models/registry'
import type { PaddleReader } from './onnx/reader'
import { assembleReceipt } from './receipt/assemble'
import { isWatermarkWord, suppressColoredWatermark } from './receipt/color-watermark'
import { loadRecognizer, recognizeWords, terminateRecognizer } from './tesseract/engine'
import { DEFAULT_OPTIONS, type DebugImage, type OcrOptions, type OcrResult, type ProgressEvent } from './types'

export interface RunCallbacks {
  onProgress?: (event: ProgressEvent) => void
  onDebugImage?: (image: DebugImage) => void
}

export interface OcrClientEvents {
  /** Fired once the English reader is loaded. */
  onReady?: (executionProvider: string) => void
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
  /** Held only while `options.reader` is `paddle`; null on the Tesseract path. */
  #paddle: PaddleReader | null = null

  constructor(options: Partial<OcrOptions> = {}, events: OcrClientEvents = {}) {
    this.#options = mergeOptions(options)
    this.#events = events
  }

  get options(): OcrOptions {
    return this.#options
  }

  setOptions(options: Partial<OcrOptions>): void {
    const previous = this.#options.reader
    this.#options = mergeOptions(options, this.#options)
    // Switching readers invalidates whatever was loaded, so drop it and let the
    // next `ready()` build the other one.
    if (this.#options.reader !== previous) {
      this.#readyPromise = null
      this.#paddle?.dispose()
      this.#paddle = null
    }
  }

  /**
   * Load the reader named by `options.reader`. Safe to call repeatedly — the
   * first call wins and later callers await the same promise.
   */
  ready(): Promise<string> {
    if (this.#disposed) return Promise.reject(new Error('OcrClient has been disposed'))
    if (this.#readyPromise) return this.#readyPromise

    const loading =
      this.#options.reader === 'paddle' ? this.#loadPaddle() : this.#loadTesseract()

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
   * Stand up PP-OCR, falling back to Tesseract if the weights cannot be had.
   *
   * The download is the part that fails in the real world — offline, a blocked
   * host, a proxy that returns HTML. None of those should leave the user with no
   * reader at all when a working one ships with the app.
   */
  async #loadPaddle(): Promise<string> {
    try {
      const { createPaddleReader } = await import('./onnx/reader')
      this.#paddle = await createPaddleReader(DEFAULT_MODEL_BUNDLE, this.#options)
      return `paddle (${this.#paddle.executionProvider})`
    } catch (error) {
      this.#paddle = null
      const message = error instanceof Error ? error.message : String(error)
      this.#events.onFatal?.(
        new Error(`PP-OCR could not be loaded (${message}); reading with Tesseract instead.`),
      )
      await this.#loadTesseract()
      return 'tesseract (PP-OCR unavailable)'
    }
  }

  /** The cleaned page in, words out — whichever reader is loaded. */
  async #readWords(image: ImageData, cleaned: Uint8ClampedArray, signal?: AbortSignal): Promise<WordBox[]> {
    if (this.#paddle) {
      return this.#paddle.recognizeWords(
        new ImageData(new Uint8ClampedArray(cleaned), image.width, image.height),
      )
    }
    // Tesseract resolves small print better on an enlarged page; PP-OCR does its
    // own resizing from the detector's `limitSideLen`, so it takes the original.
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
      await this.ready()
      this.#throwIfStale(token, signal)
      callbacks.onProgress?.({ stage: 'init', status: 'done', message: 'reader ready' })

      const watermarkStarted = now()
      callbacks.onProgress?.({ stage: 'watermark', status: 'start', message: 'removing the watermark…' })
      const cleaned = suppressColoredWatermark(image.width, image.height, image.data)
      const watermarkMs = now() - watermarkStarted
      callbacks.onProgress?.({
        stage: 'watermark',
        status: 'done',
        message: `${Math.round(cleaned.ratio * 1000) / 10}% of the page`,
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
      const result = assembleReceipt(
        words,
        {
          tiltCorrected: false,
          perspectiveCorrected: false,
          watermarkSuppressed: cleaned.ratio > 0.005,
          rotationAngleDeg: 0,
          documentQuad: null,
          sourceSize: { width: image.width, height: image.height },
          rectifiedSize: { width: image.width, height: image.height },
          watermarkPixelRatio: cleaned.ratio,
          ...(this.#paddle
            ? {
                detectorModel: this.#paddle.detectorName,
                recognizerModel: this.#paddle.recognizerName,
                detectorBackend: 'onnx' as const,
                executionProvider: this.#paddle.executionProvider,
              }
            : {}),
          warnings: [],
          timingsMs: { watermark: watermarkMs, recognize: recognizeMs },
        },
        this.#options.cluster.rowOverlapRatio,
        0,
      )
      const assembleMs = now() - assembleStarted
      result.processingMeta.timingsMs.assemble = assembleMs
      result.processingMeta.totalMs = watermarkMs + recognizeMs + assembleMs
      callbacks.onProgress?.({
        stage: 'assemble',
        status: 'done',
        message: `${result.rows.length} rows`,
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

  #throwIfStale(token: number, signal: AbortSignal | undefined): void {
    if (this.#disposed || token !== this.#runToken || signal?.aborted) throw new OcrCancelledError()
  }

  /** Drop the reader. An in-flight `run` rejects with {@link OcrCancelledError}. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#runToken += 1
    this.#readyPromise = null
    this.#paddle?.dispose()
    this.#paddle = null
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

/** Deep-merge partial options over a base, one level into each section. */
export function mergeOptions(
  partial: Partial<OcrOptions>,
  base: OcrOptions = DEFAULT_OPTIONS,
): OcrOptions {
  return {
    ...base,
    ...partial,
    perspective: { ...base.perspective, ...partial.perspective },
    deskew: { ...base.deskew, ...partial.deskew },
    watermark: { ...base.watermark, ...partial.watermark },
    detector: { ...base.detector, ...partial.detector },
    recognizer: { ...base.recognizer, ...partial.recognizer },
    cluster: { ...base.cluster, ...partial.cluster },
  }
}
