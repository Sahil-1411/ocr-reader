/**
 * The reader, over HTTP.
 *
 * Everything that turns a file into rows lives in `python/reader/`: the PDF's
 * text layer, the recogniser for a scan, the column and row builders, the
 * checks. This module posts the file and hands back what came home, so the app
 * has one reader rather than two implementations of the same rules that drift
 * apart.
 *
 * `/document` and `/page` are served by `python/serve.py`, which in dev is
 * reached through Vite's proxy and in production is the same origin as the
 * page.
 */

import type { OcrResult, SkippedLine, TableBlock, ValidationIssue, WordBox } from './types'

/** One page of a document, as read. */
export interface DocumentPage {
  /** 1-based, as the document numbers its pages. */
  page: number
  result: OcrResult
  /** The words the page was read from, for the viewer's text overlay. */
  words: WordBox[]
  /** Where to fetch the picture of this page. */
  imageUrl: string
  /** The same page, small enough for the strip of pages. */
  thumbnailUrl: string
  size: { width: number; height: number }
}

export interface ReadDocument {
  pages: DocumentPage[]
}

/** The reader is not running, or refused the file. Carries what it said. */
export class ReaderError extends Error {}

interface PageJson {
  page: number
  kind: OcrResult['kind']
  reader: string
  size: { width: number; height: number }
  title?: string
  headers: string[]
  rows: Array<{ cells: string[]; confidence: number; label?: boolean }>
  columnBounds?: number[]
  tables: TableBlock[]
  validation: ValidationIssue[]
  skipped: SkippedLine[]
  warnings: string[]
  wordCount: number
  words: WordBox[]
}

/** Where `python/serve.py` answers. Same origin in dev and in production. */
const READER = ''

/**
 * The picture of one page.
 *
 * `width` asks the reader for a picture no wider than it needs: the thumbnail
 * strip wants seven small ones, the viewer wants one at full size. Left out,
 * the page comes at the resolution it was read at.
 */
export function pageImageUrl(documentId: string, page: number, width?: number): string {
  const size = width ? `&w=${width}` : ''
  return `${READER}/page?doc=${encodeURIComponent(documentId)}&n=${page}${size}`
}

/** Whether the reader is up, so the app can say so before a file is chosen. */
export async function readerIsReady(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${READER}/health`, { signal })
    return response.ok
  } catch {
    return false
  }
}

async function failure(response: Response): Promise<never> {
  let detail = `${response.status} ${response.statusText}`
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) detail = body.error
  } catch {
    // A non-JSON body (a proxy's error page) leaves the status as the detail.
  }
  throw new ReaderError(detail)
}

/** Read one file — a PDF or an image — and return every page of it. */
export async function readDocument(file: Blob, signal?: AbortSignal): Promise<ReadDocument> {
  let response: Response
  try {
    response = await fetch(`${READER}/document`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ReaderError(
      'The reader is not running. Start it with `pnpm reader` and try again.',
    )
  }
  if (!response.ok) await failure(response)

  const body = (await response.json()) as { document: string; pages: PageJson[] }
  return {
    pages: body.pages.map((page) => ({
      page: page.page,
      size: page.size,
      words: page.words,
      imageUrl: pageImageUrl(body.document, page.page),
      thumbnailUrl: pageImageUrl(body.document, page.page, 200),
      result: {
        kind: page.kind,
        ...(page.title ? { title: page.title } : {}),
        headers: page.headers,
        rows: page.rows,
        tables: page.tables,
        ...(page.columnBounds ? { columnBounds: page.columnBounds } : {}),
        validation: page.validation,
        skipped: page.skipped,
        processingMeta: {
          reader: page.reader,
          sourceSize: page.size,
          wordCount: page.wordCount,
          warnings: page.warnings,
        },
      },
    })),
  }
}
