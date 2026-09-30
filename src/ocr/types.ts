/**
 * Shared type contract for reading a receipt.
 *
 * Nothing here imports a reader, so this file is safe to import from React
 * components and tests alike. Pixel coordinates are in the space of the image
 * that was read, origin top-left, x right and y down.
 */

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

/** Which receipt was read. Each kind has its own row shape. */
export type ReceiptKind = 'inventory' | 'settlements' | 'invoice' | 'table'

/** One weekly-invoice line: a description and an amount. */
export interface ReceiptField {
  label: string
  value: string
  /** Mean word confidence in [0, 1]. */
  confidence: number
}

/** One weekly pack-settlement row: Game-Pack, Name, Date Settled. */
export interface SettlementRow {
  gamePack: string
  name: string
  dateSettled: string
  /** Mean word confidence in [0, 1]. Omitted from the public JSON. */
  confidence: number
}

/**
 * One row of a multi-column document, cells left to right under the printed
 * header. Used for wholesale invoices and other tables that are not a lottery
 * ticket.
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
 * One instant-inventory row, matching the printed header
 * Game / Name / Int / Rec / Act / Set.
 */
export interface InventoryRow {
  game: string
  name: string
  int: string
  rec: string
  act: string
  set: string
  /** Mean word confidence in [0, 1]. Omitted from the public JSON. */
  confidence: number
}

/**
 * A place where the reading contradicts the receipt's own arithmetic.
 *
 * Lives here rather than beside the checks in `receipt/validate.ts` because
 * `OcrResult` carries it and this module deliberately imports nothing.
 */
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
  /** Indices into the kind's row array that the check covers, for highlighting. */
  rows: number[]
}

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

export interface ProcessingMeta {
  /**
   * Which reader produced the words, e.g. `python (http://127.0.0.1:8756)` or
   * `tesseract (Python reader not running)` after a fallback.
   */
  reader: string
  watermarkSuppressed: boolean
  /** Fraction of pixels classified as watermark and removed, in [0, 1]. */
  watermarkPixelRatio: number
  sourceSize: { width: number; height: number }
  /** Words the reader returned, before they were paired into rows. */
  wordCount: number
  /** Per-stage wall-clock timings in milliseconds. */
  timingsMs: Partial<Record<StageName, number>>
  totalMs: number
  /** Non-fatal problems worth surfacing to the user, validation included. */
  warnings: string[]
}

export interface OcrResult {
  /** Which table was read. The public JSON follows this. */
  kind: ReceiptKind
  /** Printed title read from the ticket, e.g. "WEEKLY PACK SETTLEMENTS". */
  title?: string
  /**
   * The table's column headers as printed on the ticket, left to right — e.g.
   * `Game, Name, Int, Rec, Act, Set`. The public JSON keys its rows by these.
   */
  headers: string[]
  /** Inventory rows, top to bottom. Filled when {@link kind} is `inventory`. */
  rows: InventoryRow[]
  /** Pack-settlement rows. Filled when {@link kind} is `settlements`. */
  settlements: SettlementRow[]
  /** Invoice lines. Filled when {@link kind} is `invoice`. */
  fields: ReceiptField[]
  /** Column-aligned rows. Filled when {@link kind} is `table`. */
  tableRows: TableRow[]
  /**
   * Left edge of each printed column, in page pixels. Present for a column
   * table so a later page of the same PDF can reuse the header.
   */
  columnBounds?: number[]
  /**
   * Places where the reading contradicts the receipt's own arithmetic, or where
   * a count was solved from TOTALS or could not be read. Empty means every
   * check the page offers passed.
   */
  validation: ValidationIssue[]
  processingMeta: ProcessingMeta
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

export const STAGE_NAMES = ['init', 'watermark', 'recognize', 'assemble'] as const

export type StageName = (typeof STAGE_NAMES)[number]

export type StageStatus = 'start' | 'done' | 'skip' | 'error'

export interface ProgressEvent {
  stage: StageName
  status: StageStatus
  /** Human-readable detail, e.g. `"the Python reader does this itself"`. */
  message?: string
  /** Milliseconds elapsed in this stage; present on `done` and `skip`. */
  elapsedMs?: number
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Which reader turns the page into words.
 *
 * `python` sends the image to `tools/serve.py` on localhost, which reads it with
 * PP-OCR — the more accurate of the two. When the server is not running the
 * client says so and falls back to `tesseract`, which runs entirely from files
 * served with the app.
 */
export type ReaderEngine = 'python' | 'tesseract'

export interface OcrOptions {
  reader: ReaderEngine
  /**
   * Two words belong to the same row when their vertical overlap exceeds this
   * fraction of the shorter word's height.
   */
  rowOverlapRatio: number
  /** Longest side the source image is downscaled to before processing. */
  maxInputSize: number
}

export const DEFAULT_OPTIONS: OcrOptions = {
  reader: 'python',
  rowOverlapRatio: 0.5,
  // Receipts are tall and narrow and their print is small. Downscaling a
  // 2000px-tall receipt to 1600 throws away resolution the recogniser needs,
  // and the cost of not doing so is a few hundred milliseconds.
  maxInputSize: 2400,
}
