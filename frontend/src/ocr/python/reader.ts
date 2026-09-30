/**
 * Read a receipt through `python/serve.py`.
 *
 * The Python reader exists because PP-OCR reads these receipts more accurately
 * than Tesseract and cannot run in the browser — see `ReaderEngine` in
 * `../types` for the measurements and the reason.
 *
 * The split of work is deliberate. Python returns word boxes and stops there;
 * the rows are still built by `layout/rows.ts`, which is tested and which a
 * second implementation would only drift from. That also means the two readers
 * are directly comparable, because everything downstream of them is identical —
 * `frontend/tools/score.test.ts` relies on exactly that.
 *
 * Python also does its own watermark suppression (a port of
 * `receipt/color-watermark.ts`), so the caller sends the original image and
 * skips its own pass rather than cleaning the page twice.
 *
 * The default URL is empty: the browser calls `/read` on the same host. Vite
 * proxies that to `127.0.0.1:8756` during development, and `--live` serves the
 * built page and `/read` on one port. Set `VITE_PYTHON_READER_URL` when the
 * API lives on a different host.
 */

import type { WordBox } from '../layout/rows'

/** Same origin, unless `VITE_PYTHON_READER_URL` names another host. */
export const DEFAULT_PYTHON_READER_URL = readerBaseUrl()

function readerBaseUrl(): string {
  const configured = import.meta.env.VITE_PYTHON_READER_URL
  if (typeof configured === 'string' && configured.length > 0) {
    return configured.replace(/\/$/, '')
  }
  return ''
}

interface PythonReadResult {
  words: WordBox[]
  watermarkPixelRatio: number
  elapsedMs: number
}

export class PythonReaderUnavailableError extends Error {
  constructor(url: string, cause: string) {
    super(
      `The Python reader${url ? ` at ${url}` : ''} did not answer (${cause}). From the repo root, start it with ` +
        '`.venv/bin/python python/serve.py --warm`, or switch the reader back to Tesseract.',
    )
    this.name = 'PythonReaderUnavailableError'
  }
}

/** True when the server is up. Used to fail fast with a useful message. */
export async function pythonReaderHealthy(
  url: string = DEFAULT_PYTHON_READER_URL,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Post the image and get its words back.
 *
 * Sent as a PNG rather than the original file because the caller holds decoded
 * `ImageData` by this point — it has already been through the app's downscale —
 * and re-encoding is cheaper than keeping the original bytes alive alongside it.
 * PNG rather than JPEG so the watermark suppression on the Python side sees the
 * same pixels the browser did, without a second generation of JPEG artefacts
 * around exactly the thin strokes that are hardest to read.
 */
export async function readWithPython(
  image: ImageData,
  url: string = DEFAULT_PYTHON_READER_URL,
  signal?: AbortSignal,
): Promise<PythonReadResult> {
  const blob = await imageDataToPng(image)

  let response: Response
  try {
    response = await fetch(`${url}/read`, {
      method: 'POST',
      body: blob,
      headers: { 'Content-Type': 'image/png' },
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new PythonReaderUnavailableError(url, error instanceof Error ? error.message : String(error))
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`The Python reader returned ${response.status}: ${detail.slice(0, 300)}`)
  }

  const payload = (await response.json()) as {
    words?: unknown
    watermarkPixelRatio?: number
    elapsedMs?: number
  }
  if (!Array.isArray(payload.words)) {
    throw new Error('The Python reader returned no words array')
  }

  return {
    words: payload.words.filter(isWordBox),
    watermarkPixelRatio: payload.watermarkPixelRatio ?? 0,
    elapsedMs: payload.elapsedMs ?? 0,
  }
}

/** The wire format is JSON from another process, so nothing is assumed about it. */
function isWordBox(value: unknown): value is WordBox {
  if (typeof value !== 'object' || value === null) return false
  const word = value as Record<string, unknown>
  return (
    typeof word.text === 'string' &&
    typeof word.x === 'number' &&
    typeof word.y === 'number' &&
    typeof word.width === 'number' &&
    typeof word.height === 'number' &&
    typeof word.confidence === 'number' &&
    Number.isFinite(word.x) &&
    Number.isFinite(word.y) &&
    word.width > 0 &&
    word.height > 0
  )
}

async function imageDataToPng(image: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare the image for the Python reader')
  context.putImageData(image, 0, 0)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Could not encode the image for the Python reader'))
    }, 'image/png')
  })
}
