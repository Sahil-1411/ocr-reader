/**
 * What the reader returns, as the page renders it.
 *
 * The reading itself happens in `python/reader/`, which is the only
 * implementation: the browser sends a file and draws the answer. Nothing here
 * imports a reader, so this file is safe to import from React components and
 * tests alike. Pixel coordinates are in the space of the page as rendered at
 * the reader's own resolution, origin top-left, x right and y down.
 */

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

/** Which table was read. Each kind prints its own columns. */
export type ReceiptKind = 'inventory' | 'settlements' | 'invoice' | 'table'

/**
 * One row, cells left to right under the printed header.
 *
 * Every kind of page comes back in this shape. The page has no business
 * knowing that an inventory row has a `game` and a settlement has a
 * `gamePack`: it is given cells and the titles they sit under, which is all it
 * draws. The reader keeps the distinction, where it means something.
 */
export interface TableRow {
  cells: string[]
  /** Mean word confidence in [0, 1]. Omitted from the public JSON. */
  confidence: number
  /**
   * A line printed among the items that is not one, such as the reason
   * `***DAMAGED IN TRANSIT***` above a credited item. Kept as its own row, as
   * printed, with only its column filled.
   */
  label?: boolean
}

/**
 * One table printed on the page, under its own column titles.
 *
 * A page is not one table by nature: an invoice prints its items, and under
 * them the customer's previous balances under titles of their own.
 */
export interface TableBlock {
  /**
   * The heading printed over this table, when it has one of its own. The
   * page's first table is the page's own and has none.
   */
  title?: string
  /** The column titles as printed, left to right. */
  headers: string[]
  rows: TableRow[]
  /** Left edge of each column, in page pixels. */
  columnBounds?: number[]
}

/** One word as the reader placed it, for the viewer's text overlay. */
export interface WordBox {
  text: string
  x: number
  y: number
  width: number
  height: number
  /** Recognition confidence in [0, 1]; 1 for a PDF's own text. */
  confidence: number
}

/**
 * Why a printed line, or part of one, is not in the rows.
 *
 * `note` is text cut out of a line that was kept; every other reason belongs
 * to a whole line the reader left out. A printed divider has no reason of its
 * own: a row of dashes is not data, and logging one would only bury the rest.
 *
 * `unplaced` is the one that might be data. The four the reader works out from
 * the page's geometry — `annotation` (indented away from the items),
 * `page-field` (printed on page after page), `margin` (outside the table) and
 * `legend` (a key to the document's own marks) — are what it would otherwise
 * have called `unplaced`, and each is named in `python/reader/skipped.py`.
 * The wording shown for each comes from the reader, so this list is for
 * reading a single line's reason and not for labelling it.
 */
export type SkipReason =
  | 'note'
  | 'furniture'
  | 'repeated-header'
  | 'summary'
  | 'unplaced'
  | 'annotation'
  | 'page-field'
  | 'legend'
  | 'margin'

/** One line, or one piece of a line, that the reader did not keep. */
export interface SkippedLine {
  reason: SkipReason
  /** What was printed, cells joined left to right in column order. */
  text: string
  /** Mean word confidence in [0, 1]. */
  confidence: number
  /** Top edge in page pixels, so the log reads in printed order. */
  y: number
}

/** A place where the reading contradicts the receipt's own arithmetic. */
export interface ValidationIssue {
  /** Which check failed, for the UI to group by. */
  code:
    | 'inventory-totals'
    | 'inventory-solved'
    | 'inventory-unread'
    | 'settlements-count'
    | 'settlements-unread'
    | 'invoice-total'
    | 'invoice-section-total'
  /** One sentence naming both sides of the contradiction. */
  message: string
  /** Indices into {@link OcrResult.rows} that the check covers, for highlighting. */
  rows: number[]
}

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

export interface ProcessingMeta {
  /** Which reader produced the words: `pdf text` or `recogniser`. */
  reader: string
  /** The page as rendered, which the word boxes are measured in. */
  sourceSize: { width: number; height: number }
  /** Words the reader returned, before they were paired into rows. */
  wordCount: number
  /** Non-fatal problems worth surfacing to the user, validation included. */
  warnings: string[]
}

export interface OcrResult {
  /** Which table was read. The public JSON follows this. */
  kind: ReceiptKind
  /** Printed title read from the ticket, e.g. "WEEKLY PACK SETTLEMENTS". */
  title?: string
  /**
   * The table's column headers as printed on the ticket, left to right. The
   * public JSON keys its rows by these.
   */
  headers: string[]
  /** The page's rows, top to bottom, under {@link headers}. */
  rows: TableRow[]
  /**
   * Every table printed on the page, in printed order, when {@link kind} is
   * `table`. The first is the page's own — the one {@link headers} and
   * {@link rows} carry — and the rest are tables printed under it.
   */
  tables: TableBlock[]
  /** Left edge of each printed column, in page pixels. */
  columnBounds?: number[]
  /**
   * Places where the reading contradicts the receipt's own arithmetic, or where
   * a count was solved from TOTALS or could not be read.
   */
  validation: ValidationIssue[]
  /**
   * Lines the reader printed over: page furniture, totals, dividers, and notes
   * cut out of an item. Logged so a reading can be checked against the page
   * without guessing what became of the rest of it.
   */
  skipped: SkippedLine[]
  processingMeta: ProcessingMeta
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

export const STAGE_NAMES = ['upload', 'read', 'rows'] as const

export type StageName = (typeof STAGE_NAMES)[number]

export type StageStatus = 'start' | 'done' | 'skip' | 'error'

export interface ProgressEvent {
  stage: StageName
  status: StageStatus
  /** Human-readable detail, e.g. `"7 pages"`. */
  message?: string
  /** Milliseconds elapsed in this stage; present on `done` and `skip`. */
  elapsedMs?: number
}
