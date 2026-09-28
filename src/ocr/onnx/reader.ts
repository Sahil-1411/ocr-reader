/**
 * PP-OCRv5 as a drop-in replacement for the Tesseract reader.
 *
 * The neural stages were written against the older column pipeline, which no
 * longer runs: they speak OpenCV `Mat`s and return detected boxes plus decoded
 * strings. Everything downstream of the reader — the watermark word filter, the
 * row builders, the validation — speaks `WordBox[]`. This module is the adapter
 * between the two, so swapping readers changes one line in `client.ts` and
 * nothing else, and the accuracy work in `layout/rows.ts` applies to both.
 *
 * Why bother when Tesseract already reads these pages: Tesseract's remaining
 * errors are all character-level and all in the places the watermark has
 * thinned the print — `/` read as `1` in a date, `8` as `6` in an amount, `L/T`
 * as `LIT`. That is the failure mode PP-OCR's recogniser is trained against,
 * being a photograph model rather than a scan model.
 *
 * The two readers are not ranked here. `client.ts` picks, and
 * `harness.html` scores them against the sample receipts.
 *
 * Everything is imported dynamically. ONNX Runtime and OpenCV together are far
 * larger than the rest of the app, and a user who never turns this on should
 * never download them.
 */

import type { WordBox } from '../layout/rows'
import type { DetectedBox, ModelBundle, OcrOptions } from '../types'

export interface PaddleReader {
  /** Reported in `processingMeta.detectorModel` / `recognizerModel`. */
  readonly detectorName: string
  readonly recognizerName: string
  /** The ONNX Runtime execution provider actually in use, e.g. `webgpu`. */
  readonly executionProvider: string
  /** Non-fatal notes from runtime setup, for `processingMeta.warnings`. */
  readonly warnings: readonly string[]
  /** Read one page. Mirrors `tesseract/engine.ts#recognizeWords`. */
  recognizeWords(image: ImageData): Promise<WordBox[]>
  dispose(): void
}

export interface PaddleReaderCallbacks {
  /** Weight download progress, so a 12 MB first run is not a frozen screen. */
  onProgress?: (message: string) => void
}

/**
 * Load the models and stand up a reader.
 *
 * Resolves only once both models are in memory and their sessions are built, so
 * the caller can treat the returned reader as ready.
 */
export async function createPaddleReader(
  bundle: ModelBundle,
  options: OcrOptions,
  callbacks: PaddleReaderCallbacks = {},
): Promise<PaddleReader> {
  const report = (message: string) => callbacks.onProgress?.(message)

  report('loading OpenCV…')
  const [{ loadOpenCV }, { initRuntime }, { createDetector }, { createRecognizer }] =
    await Promise.all([
      import('../opencv/loader'),
      import('./runtime'),
      import('./detector'),
      import('./recognizer'),
    ])

  const cv = await loadOpenCV()

  report('starting the inference runtime…')
  const runtime = await initRuntime()

  report('downloading the text detector…')
  const detector = await createDetector(bundle, options.detector)

  report('downloading the text recogniser…')
  let recognizer
  try {
    recognizer = await createRecognizer(bundle, options.recognizer)
  } catch (error) {
    // The detector session holds WASM memory; a half-built reader must not keep it.
    detector.dispose()
    throw error
  }

  const { cropForRecognition } = await import('../opencv/crop')
  const { MatScope } = await import('../opencv/scope')
  const { imageDataToMat } = await import('../opencv/preprocess')

  let disposed = false

  return {
    detectorName: detector.name,
    recognizerName: recognizer.name,
    executionProvider: runtime.executionProvider,
    warnings: runtime.warnings,

    async recognizeWords(image: ImageData): Promise<WordBox[]> {
      if (disposed) throw new Error('The PP-OCR reader has already been disposed')

      const scope = new MatScope()
      try {
        const rgba = scope.add(imageDataToMat(cv, image))
        // The detector wants three channels; the cleaned raster arrives as RGBA.
        const page = scope.add(new cv.Mat())
        cv.cvtColor(rgba, page, rgba.channels() === 4 ? cv.COLOR_RGBA2RGB : cv.COLOR_GRAY2RGB)

        const boxes = await detector.detect(cv, page, options.detector)
        if (boxes.length === 0) return []

        const crops = cropForRecognition(cv, scope, page, boxes, {
          targetHeight: recognizer.inputHeight,
          maxWidth: options.recognizer.maxInputWidth,
          padRatio: 0.12,
        })
        const readings = await recognizer.recognize(cv, crops, options.recognizer)

        const byId = new Map(boxes.map((box) => [box.id, box]))
        const words: WordBox[] = []
        crops.forEach((crop, index) => {
          const box = byId.get(crop.id)
          const reading = readings[index]
          if (!box || !reading) return
          words.push(...splitLineIntoWords(box, reading.text, reading.confidence))
        })
        return words
      } finally {
        scope.release()
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      detector.dispose()
      recognizer.dispose()
    },
  }
}

/**
 * Cut a recognised line into the words the row builders expect.
 *
 * PP-OCR detects lines, not words: `SYSTEM FEE 5.00` arrives as one box with
 * one string. The row builders need the pieces separately, because they tell a
 * label from an amount by where it sits across the page — `invoiceRowsFromWords`
 * anchors on a value in the right half, and `cleanLabel` measures the gaps
 * between words to spot a watermark fragment.
 *
 * Each token is given the share of the box its characters occupy, spaces
 * included. That is exact for the monospaced print on these receipts and close
 * enough elsewhere, since what the builders compare is which side of the page a
 * token is on and how far it sits from its neighbour — both of which survive a
 * few pixels of drift in a proportional font.
 */
export function splitLineIntoWords(
  box: DetectedBox,
  text: string,
  score: number,
): WordBox[] {
  const line = text.trim()
  if (!line) return []

  const { x, y, width, height } = box.box
  const span = line.length
  if (span === 0 || width <= 0 || height <= 0) return []

  const words: WordBox[] = []
  const token = /\S+/g
  let match: RegExpExecArray | null
  while ((match = token.exec(line)) !== null) {
    const piece = match[0]
    words.push({
      text: piece,
      x: x + (width * match.index) / span,
      y,
      width: (width * piece.length) / span,
      height,
      confidence: score,
    })
  }
  return words
}
