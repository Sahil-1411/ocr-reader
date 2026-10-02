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

/** A table printed under the pages' own, gathered across the pages it is on. */
export interface ExtraTable {
  title: string
  /** That title as a file name's tail: `previous-balances`. */
  slug: string
  /** Its heading and its columns, which is what makes it itself across pages. */
  key: string
  headers: string[]
  rows: Array<{ page: number; cells: string[] }>
}

export interface ReadDocument {
  pages: DocumentPage[]
  extraTables: ExtraTable[]
}

/** One read page of the document, as the app holds it: edits and all. */
export interface ExportPage {
  /** 1-based, as the document numbers its pages. */
  page: number
  result: OcrResult
}

/** A page the reader produced no rows for, and why. */
export interface PageFailure {
  page: number
  message: string
}

/** Which export to ask for, and in what shape. */
export interface ExportRequest {
  /** The document's rows, the log of what was left out, or one extra table. */
  what: 'data' | 'log' | 'table'
  format: 'csv' | 'json'
  pages: readonly ExportPage[]
  /** Pages in the document, which may be more than were read. */
  total: number
  /** Extra tables to leave out of the data export, by key. */
  dropped?: readonly string[]
  failures?: readonly PageFailure[]
  /** Which extra table, when `what` is `table`. */
  key?: string
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

  const body = (await response.json()) as {
    document: string
    pages: PageJson[]
    extraTables: ExtraTable[]
  }
  return {
    extraTables: body.extraTables ?? [],
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

/**
 * One export, shaped by the reader.
 *
 * The pages are posted back rather than read again because the app may have
 * had a cell typed into it or a table taken out, and the export is of what is
 * on screen. The shaping itself — a row's page beside it, two columns that
 * share a title, the n-th `PRICE` of a page under the document's n-th — is
 * the reader's, so there is one answer and not two.
 */
export async function requestExport(request: ExportRequest, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${READER}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      what: request.what,
      format: request.format,
      total: request.total,
      dropped: request.dropped ?? [],
      failures: request.failures ?? [],
      ...(request.key ? { key: request.key } : {}),
      pages: request.pages.map(({ page, result }) => ({
        page,
        kind: result.kind,
        ...(result.title ? { title: result.title } : {}),
        headers: result.headers,
        rows: result.rows,
        tables: result.tables,
        skipped: result.skipped,
      })),
    }),
  })
  if (!response.ok) await failure(response)
  return request.format === 'csv'
    ? await response.text()
    : JSON.stringify(await response.json(), null, 2)
}
