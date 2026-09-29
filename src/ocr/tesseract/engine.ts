/**
 * Tesseract.js, kept behind a small wrapper so the receipt pipeline asks for
 * words with boxes and nothing else.
 *
 * The library runs LSTM in its own worker and downloads the English model on
 * first use. Callers keep one worker for the life of the page.
 */

import { createWorker, PSM } from 'tesseract.js'

import type { WordBox } from '../layout/rows'

/**
 * Same-origin copies of the reader, served from `public/`. The library's
 * default is a CDN, and a failed download never rejects — `createWorker`
 * swallows it — so a missing local file has to be reported by us.
 */
const READER_OPTIONS = {
  workerPath: '/tesseract/worker.min.js',
  corePath: '/tesseract/tesseract-core-simd-lstm.wasm.js',
  langPath: '/tessdata',
  workerBlobURL: false,
  gzip: true,
} as const

const START_TIMEOUT_MS = 60_000
const RECOGNIZE_TIMEOUT_MS = 90_000

let workerPromise: Promise<Tesseract.Worker> | null = null

export function loadRecognizer(): Promise<Tesseract.Worker> {
  if (!workerPromise) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = createWorker('eng', 1, READER_OPTIONS).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        user_defined_dpi: '300',
      })
      return worker
    })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            'The English reader did not start. /tessdata/eng.traineddata.gz and /tesseract/worker.min.js need to be served with the app.',
          ),
        )
      }, START_TIMEOUT_MS)
    })
    workerPromise = Promise.race([started, timeout])
      .then((worker) => {
        if (timer !== undefined) clearTimeout(timer)
        return worker
      })
      .catch((error: unknown) => {
        if (timer !== undefined) clearTimeout(timer)
        workerPromise = null
        throw error
      })
  }
  return workerPromise
}

export async function terminateRecognizer(): Promise<void> {
  const pending = workerPromise
  workerPromise = null
  if (!pending) return
  const worker = await pending.catch(() => null)
  await worker?.terminate()
}

/** Read one page. `image` is not retained. */
export async function recognizeWords(
  image: OffscreenCanvas | HTMLCanvasElement,
  signal?: AbortSignal,
): Promise<WordBox[]> {
  if (signal?.aborted) throw new Error('OCR run was cancelled')
  const worker = await loadRecognizer()

  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const giveUp = new Promise<never>((_, reject) => {
    const fail = (message: string) => {
      if (settled) return
      reject(new Error(message))
    }
    timer = setTimeout(
      () => fail('Reading the page took too long and was stopped.'),
      RECOGNIZE_TIMEOUT_MS,
    )
    signal?.addEventListener('abort', () => fail('OCR run was cancelled'), { once: true })
  })

  try {
    return await readPage(worker, image, giveUp)
  } catch (error) {
    if (isCancelled(error) || signal?.aborted) throw error
    // A crashed reader has to be replaced. The next image otherwise fails
    // immediately because the dead worker is still the cached one.
    await terminateRecognizer()
    if (
      error instanceof Error &&
      error.message === 'Reading the page took too long and was stopped.'
    ) {
      throw error
    }
    const replacement = await loadRecognizer()
    return readPage(replacement, image, giveUp)
  } finally {
    settled = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === 'OCR run was cancelled'
}

async function readPage(
  worker: Tesseract.Worker,
  image: OffscreenCanvas | HTMLCanvasElement,
  giveUp: Promise<never>,
): Promise<WordBox[]> {
  const recognition = worker.recognize(image, {}, { blocks: true })
  // Cancel and the timeout can win the race while this job is still running.
  void recognition.catch(() => undefined)
  const result = await Promise.race([recognition, giveUp])
  return collectWords(result.data)
}

function collectWords(page: Tesseract.Page): WordBox[] {
  const words: WordBox[] = []
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = word.text.trim()
          if (!text || !word.bbox) continue
          const width = word.bbox.x1 - word.bbox.x0
          const height = word.bbox.y1 - word.bbox.y0
          if (width <= 0 || height <= 0) continue
          words.push({
            text,
            x: word.bbox.x0,
            y: word.bbox.y0,
            width,
            height,
            confidence: clamp01(word.confidence / 100),
          })
        }
      }
    }
  }
  return words
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
