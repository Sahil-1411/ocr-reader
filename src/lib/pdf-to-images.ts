/**
 * Convert a PDF file into one ImageData per page using pdf.js.
 *
 * This runs entirely on-device — no network calls except loading the pdf.js
 * worker from the same origin. Each page is rasterised at a configurable DPI
 * (default 200 — the sweet spot between OCR accuracy and speed) via
 * OffscreenCanvas when available, falling back to a DOM canvas.
 */

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'

import { textItemsToWords, type PdfTextRun } from './pdf-text'
import type { WordBox } from '../ocr/layout/rows'

// Point the worker at the bundled copy inside node_modules so Vite can resolve
// it at build time and the browser loads it from the same origin.
GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href

export interface PdfPage {
  /** 1-based page number. */
  pageNumber: number
  /** Rasterised page pixels. */
  imageData: ImageData
  /** Rendered width in CSS pixels. */
  width: number
  /** Rendered height in CSS pixels. */
  height: number
  /**
   * Words from the PDF text layer, in the same pixel space as `imageData`.
   * Empty when the page is a scan.
   */
  words: WordBox[]
}

/**
 * Render every page of a PDF to `ImageData`.
 *
 * @param file  The user-supplied PDF `File` or `Blob`.
 * @param dpi   Rendering resolution. 200 is a good OCR default.
 * @returns One `PdfPage` per page, in order.
 */
export async function pdfToImages(
  file: Blob,
  dpi = 200,
): Promise<PdfPage[]> {
  const buffer = await file.arrayBuffer()
  const pdf = await getDocument({ data: buffer }).promise
  const pages: PdfPage[] = []

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)

    // Scale so that 72 PDF points → `dpi` pixels.
    const scale = dpi / 72
    const viewport = page.getViewport({ scale })

    const width = Math.round(viewport.width)
    const height = Math.round(viewport.height)
    const words = await pageWords(page, viewport.transform)

    // pdf.js v6 requires a DOM canvas element for the `canvas` render param.
    // OffscreenCanvas is not supported by the pdf.js renderer.
    const el = document.createElement('canvas')
    el.width = width
    el.height = height
    const ctx = el.getContext('2d', { willReadFrequently: true })!

    await page.render({ canvas: el, canvasContext: ctx, viewport }).promise

    const imageData = ctx.getImageData(0, 0, width, height)

    pages.push({ pageNumber: i, imageData, width, height, words })
    page.cleanup()
  }

  await pdf.cleanup()
  return pages
}

/** Positioned text from the page, or an empty list when the layer cannot be read. */
async function pageWords(
  page: { getTextContent: () => Promise<{ items: unknown[] }> },
  viewportTransform: number[],
): Promise<WordBox[]> {
  try {
    const textContent = await page.getTextContent()
    const runs: PdfTextRun[] = []
    for (const item of textContent.items) {
      if (typeof item !== 'object' || item === null || !('str' in item)) continue
      const run = item as {
        str?: unknown
        transform?: unknown
        width?: unknown
        height?: unknown
      }
      if (typeof run.str !== 'string' || !Array.isArray(run.transform)) continue
      runs.push({
        str: run.str,
        transform: run.transform.map((value) => Number(value) || 0),
        width: typeof run.width === 'number' ? run.width : 0,
        height: typeof run.height === 'number' ? run.height : 0,
      })
    }
    return textItemsToWords(runs, viewportTransform)
  } catch {
    return []
  }
}

/**
 * Quick check: does a file look like a PDF?
 * Checks MIME type first, then falls back to the file extension.
 */
export function isPdf(file: File): boolean {
  if (file.type === 'application/pdf') return true
  return /\.pdf$/i.test(file.name)
}
