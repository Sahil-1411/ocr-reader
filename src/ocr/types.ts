/**
 * Shared type contract for the client-side OCR pipeline.
 *
 * Every module in `src/ocr/**` builds against these types. Nothing here imports
 * OpenCV or ONNX Runtime, so this file is safe to import from the main thread,
 * from the worker, and from React components alike.
 *
 * Coordinate convention
 * ---------------------
 * Unless a field explicitly says otherwise, all pixel coordinates are expressed
 * in the space of the **rectified** image (after perspective warp + deskew), with
 * the origin at the top-left, x growing right and y growing down.
 */

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export interface Point {
  x: number
  y: number
}

/** A document quadrilateral, corners in clockwise order starting top-left. */
export interface Quad {
  tl: Point
  tr: Point
  br: Point
  bl: Point
}

/** Axis-aligned rectangle. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A rotated rectangle as produced by `cv.minAreaRect`. */
export interface RotatedBox {
  center: Point
  size: { width: number; height: number }
  /** Degrees, OpenCV convention. */
  angle: number
}

/* -------------------------------------------------------------------------- */
/* Detection + recognition                                                     */
/* -------------------------------------------------------------------------- */

/** Output of the ONNX text detector, before any recognition has run. */
export interface DetectedBox {
  /** Stable identifier, assigned in detection order. */
  id: number
  /** Axis-aligned bounds — this is what the public JSON reports. */
  box: Box
  /** The four corners of the (possibly rotated) detection, clockwise from top-left. */
  polygon: [Point, Point, Point, Point]
  /** Rotation of the text line in degrees; ~0 for a well-rectified ticket. */
  angle: number
  /** Detector confidence in [0, 1] — mean probability inside the box mask. */
  score: number
}

/** Output of the ONNX CTC recognizer for a single cropped box. */
export interface RecognizedText {
  /** Decoded string, already normalised (see `layout/normalize.ts`). */
  text: string
  /** Raw decoded string before normalisation, kept for debugging. */
  rawText: string
  /** Mean per-character probability in [0, 1]. */
  confidence: number
  /** Per-character probabilities, aligned with `rawText`. */
  charConfidences: number[]
}

/**
 * A fully resolved detection: geometry + text + where it landed in the layout.
 * This is the element type of `OcrResult.rawDetections`.
 */
export interface Detection extends DetectedBox {
  /** Normalised text, e.g. `"12"`. Empty string when recognition produced nothing. */
  text: string
  rawText: string
  /** Detector score, copied from `DetectedBox.score`. */
  detScore: number
  /** Recognizer mean per-character probability. */
  recScore: number
  /** `detScore * recScore` — the score used for filtering. */
  confidence: number
  /** 1-based column this detection was assigned to, or `null` if rejected. */
  columnIndex: number | null
  /** 0-based position within its column, top to bottom, or `null` if rejected. */
  rowIndex: number | null
  /** Set when the detection was dropped, explaining which gate rejected it. */
  rejectedReason?: RejectionReason
}

export type RejectionReason =
  | 'low-detection-score'
  | 'low-recognition-score'
  | 'empty-text'
  | 'not-a-number'
  | 'out-of-range'
  | 'geometry-outlier'
  | 'duplicate'

/* -------------------------------------------------------------------------- */
/* Public result shape                                                         */
/* -------------------------------------------------------------------------- */

export interface ColumnResult {
  /** 1-based, left to right. */
  columnIndex: number
  /**
   * The column's cell values, in strict top-to-bottom order.
   *
   * Named `numbers` because that is the agreed output contract. On a pure number
   * grid it holds exactly that; on a tabular receipt it holds whatever the
   * column contains — a pack code, a game name, a date, an amount. `fieldType`
   * says which.
   */
  numbers: string[]
  /** What this column was found (or declared) to hold. */
  fieldType?: FieldType
  /** Column heading, when one was detected. */
  label?: string
}

export interface ProcessingMeta {
  /* --- the three flags required by the output contract --- */
  tiltCorrected: boolean
  perspectiveCorrected: boolean
  watermarkSuppressed: boolean

  /* --- diagnostics --- */
  /** Rotation applied during deskew, in degrees (positive = counter-clockwise). */
  rotationAngleDeg: number
  /** Corners of the detected document quad in ORIGINAL image coordinates. */
  documentQuad: Quad | null
  sourceSize: { width: number; height: number }
  rectifiedSize: { width: number; height: number }
  /** Fraction of pixels classified as watermark and removed, in [0, 1]. */
  watermarkPixelRatio: number
  detectorModel: string
  recognizerModel: string
  /**
   * Which reader actually ran. `tesseract` is the receipt path. The other two
   * belong to the older column pipeline.
   */
  detectorBackend: 'tesseract' | 'onnx' | 'opencv-fallback'
  /** ONNX Runtime execution provider that was actually used. */
  executionProvider: string
  /** Per-stage wall-clock timings in milliseconds. */
  timingsMs: Partial<Record<StageName, number>>
  totalMs: number
  /** Non-fatal problems worth surfacing to the user. */
  warnings: string[]
}

/**
 * One printed line, split into the text on the left and the text on the right.
 *
 * This is the weekly-invoice shape: a description and an amount.
 */
export interface ReceiptField {
  label: string
  value: string
  /** Mean word confidence in [0, 1]. */
  confidence: number
}

/** Which receipt was read. Each kind has its own row shape. */
export type ReceiptKind = 'inventory' | 'settlements' | 'invoice'

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
    | 'settlements-count'
    | 'invoice-total'
    | 'invoice-section-total'
  /** One sentence naming both sides of the contradiction. */
  message: string
  /** Indices into the kind's row array that the check covers, for highlighting. */
  rows: number[]
}

/**
 * One weekly pack-settlement row: Game-Pack, Name, Date Settled.
 */
export interface SettlementRow {
  gamePack: string
  name: string
  dateSettled: string
  /** Mean word confidence in [0, 1]. Omitted from the public JSON. */
  confidence: number
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

/** The exact JSON handed back to the caller. */
export interface OcrResult {
  /** Which table was read. The public JSON follows this. */
  kind: ReceiptKind
  /**
   * Inventory rows, top to bottom. Filled when {@link kind} is `inventory`.
   */
  rows: InventoryRow[]
  /** Pack-settlement rows. Filled when {@link kind} is `settlements`. */
  settlements: SettlementRow[]
  /**
   * Invoice lines (label and amount) when {@link kind} is `invoice`.
   * On the other kinds this is the unfiltered line split, for the full result.
   */
  fields: ReceiptField[]
  columns: ColumnResult[]
  rawDetections: Detection[]
  /**
   * Places where the reading contradicts the receipt's own arithmetic.
   *
   * Empty means every check the page offers passed, which is a far stronger
   * statement than a confidence score: the totals were recomputed from the rows
   * and agreed. A non-empty list names the rows to check by hand — no value is
   * ever corrected from a failed check, because the arithmetic shows that two
   * figures disagree without showing which one is wrong.
   */
  validation: ValidationIssue[]
  processingMeta: ProcessingMeta
}

/* -------------------------------------------------------------------------- */
/* Pipeline stages + progress                                                  */
/* -------------------------------------------------------------------------- */

export const STAGE_NAMES = [
  'init',
  'decode',
  'perspective',
  'deskew',
  'watermark',
  'binarize',
  'detect',
  'recognize',
  'cluster',
  'assemble',
] as const

export type StageName = (typeof STAGE_NAMES)[number]

export type StageStatus = 'start' | 'done' | 'skip' | 'error'

export interface ProgressEvent {
  stage: StageName
  status: StageStatus
  /** Human-readable detail, e.g. `"no document quad found — skipping warp"`. */
  message?: string
  /** Fractional progress within the stage, in [0, 1]. Only some stages report this. */
  progress?: number
  /** Milliseconds elapsed in this stage; present on `done` and `skip`. */
  elapsedMs?: number
}

/** A snapshot of an intermediate image, for the debug viewer. */
export interface DebugImage {
  stage: StageName
  label: string
  width: number
  height: number
  /** RGBA, length === width * height * 4. Transferable. */
  data: Uint8ClampedArray
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a column contains. Drives which cleanup rules are safe to apply to it.
 *
 * Lives here rather than beside the cleanup code because it is part of the
 * public contract: a caller declares a document's shape with it, and it comes
 * back on every `ColumnResult`.
 */
export type FieldType =
  /** Trim and collapse whitespace; change nothing else. */
  | 'auto'
  /** Free text such as a game name. */
  | 'text'
  /** An identifier such as `879-008949`. */
  | 'code'
  /** A calendar date such as `02/23/26`. */
  | 'date'
  /** A monetary value such as `1,381.74` or `40.00C` (C = credit). */
  | 'amount'
  /** A bare integer such as `07`. */
  | 'number'

export interface ColumnSpec {
  /** What this column holds; drives which cleanup rules are safe. */
  fieldType: FieldType
  /** Optional heading, echoed into `ColumnResult.label`. */
  label?: string
}

export interface PerspectiveOptions {
  enabled: boolean
  /**
   * The quad must cover at least this fraction of the frame to be accepted as
   * the document. Guards against locking onto a logo or a sub-rectangle.
   */
  minAreaRatio: number
  /** Reject quads whose corner angles deviate from 90° by more than this. */
  maxCornerAngleDeviationDeg: number
  /** `approxPolyDP` epsilon as a fraction of the contour perimeter. */
  approxEpsilonRatio: number
  /** Longest edge of the downscaled image used for quad search. */
  workingSize: number
}

export interface DeskewOptions {
  enabled: boolean
  /** Angles beyond this are treated as a detection failure and ignored. */
  maxAngleDeg: number
  /** Skip the rotation entirely below this angle — it is not worth resampling. */
  minAngleDeg: number
  /** Step of the coarse projection-profile sweep, in degrees. */
  coarseStepDeg: number
  /** Step of the refinement sweep, in degrees. */
  fineStepDeg: number
}

export interface WatermarkOptions {
  enabled: boolean
  /**
   * Pixels whose LAB chroma exceeds this are treated as coloured ink
   * (watermark) and removed. Black/grey print has near-zero chroma.
   */
  chromaThreshold: number
  /** HSV saturation above which a pixel is considered coloured. */
  saturationThreshold: number
  /**
   * Kernel size for the morphological closing that estimates the page
   * background. Must exceed the stroke width of the printed glyphs.
   */
  backgroundKernel: number
  /** Keep only strokes darker than this fraction of the local background. */
  inkRatio: number
  /** Remove connected components larger than this fraction of the page area. */
  maxComponentAreaRatio: number
}

export interface DetectorOptions {
  /** Longest side the detector input is resized to; rounded to a multiple of 32. */
  limitSideLen: number
  /** Binarisation threshold applied to the DBNet probability map. */
  binaryThreshold: number
  /** Minimum mean-probability score for a box to survive. */
  boxThreshold: number
  /** Vatti unclip ratio used to expand the shrunk DBNet polygon. */
  unclipRatio: number
  /** Drop boxes whose shorter side is below this many pixels. */
  minBoxSize: number
  /** Hard cap on the number of contours considered. */
  maxCandidates: number
}

export interface RecognizerOptions {
  /**
   * Restrict the CTC argmax to digits (and blank). Hugely improves accuracy on
   * number-only tickets; disable to read arbitrary text.
   */
  digitsOnly: boolean
  /** Model input height in pixels. */
  inputHeight: number
  /** Maximum model input width after aspect-preserving resize. */
  maxInputWidth: number
  /** How many crops to push through the model per forward pass. */
  batchSize: number
}

export interface ClusterOptions {
  /**
   * How many vertical columns to resolve.
   *
   * `'auto'` searches `1..maxColumns` and keeps the count best supported by the
   * geometry. Use it when one pipeline has to handle documents with different
   * layouts — these receipts run to 2, 3 and 6 columns. Pin an integer when you
   * know the layout; it is strictly more reliable than letting it be inferred.
   */
  columnCount: number | 'auto'
  /** Upper bound for the `'auto'` search. */
  maxColumns: number
  /**
   * What each column holds, left to right, for per-column cleanup. Shorter than
   * the column count is fine — unlisted columns fall back to `autoFieldType`.
   */
  columnSpecs?: ColumnSpec[]
  /**
   * When no `columnSpecs` entry covers a column, infer its type from its
   * contents. Off by default: a wrong guess destroys data, and the conservative
   * `auto` cleanup is always survivable.
   */
  autoFieldType: boolean
  /**
   * When true, the pipeline may return fewer columns than `columnCount` if the
   * geometry clearly does not support that many. When false, it always emits
   * exactly `columnCount` entries (padding with empty arrays).
   */
  allowFewerColumns: boolean
  /**
   * Two boxes belong to the same row when their vertical overlap exceeds this
   * fraction of the shorter box's height.
   */
  rowOverlapRatio: number
}

/**
 * Which reader turns the cleaned page into words.
 *
 * `tesseract` runs entirely from files served with the app. `paddle` downloads
 * ~12 MB of PP-OCR weights on first use and caches them, and reads photographed
 * print more accurately — the watermark's damage shows up in Tesseract as
 * character substitutions (`/` as `1`, `8` as `6`) that a model trained on
 * photographs is less prone to.
 */
export type ReaderEngine = 'tesseract' | 'paddle'

export interface OcrOptions {
  perspective: PerspectiveOptions
  deskew: DeskewOptions
  watermark: WatermarkOptions
  detector: DetectorOptions
  recognizer: RecognizerOptions
  cluster: ClusterOptions
  /** Which reader to use. See {@link ReaderEngine}. */
  reader: ReaderEngine
  /** Drop detections below this combined confidence. */
  minConfidence: number
  /** Emit `DebugImage`s for every stage. Costs memory and a few ms per stage. */
  debug: boolean
  /** Longest side the source image is downscaled to before processing. */
  maxInputSize: number
}

/* -------------------------------------------------------------------------- */
/* Model registry                                                              */
/* -------------------------------------------------------------------------- */

export interface ModelSource {
  id: string
  /** Human-readable name surfaced in `processingMeta`. */
  name: string
  /** Ordered list of URLs; the first that loads wins. */
  urls: string[]
  /** Approximate download size, used for progress reporting. */
  approxBytes: number
}

export interface ModelBundle {
  detector: ModelSource
  recognizer: ModelSource
  /** URL of the recognizer's character dictionary, one character per line. */
  charsetUrl: string
  /**
   * Whether the dictionary needs a CTC blank prepended at index 0. PaddleOCR
   * dictionaries do; some exported models bake the blank in already.
   */
  prependBlank: boolean
}

/* -------------------------------------------------------------------------- */
/* Worker protocol                                                             */
/* -------------------------------------------------------------------------- */

export type WorkerRequest =
  | { type: 'init'; id: number; options: OcrOptions }
  | {
      type: 'run'
      id: number
      image: { width: number; height: number; data: ArrayBuffer }
      options: OcrOptions
    }
  | { type: 'cancel'; id: number }

export type WorkerResponse =
  | { type: 'progress'; id: number; event: ProgressEvent }
  | { type: 'debug'; id: number; image: DebugImage }
  | { type: 'prepared'; id: number; page: PreparedPageMessage }
  | { type: 'result'; id: number; result: OcrResult }
  | { type: 'error'; id: number; message: string; stack?: string }
  | { type: 'ready'; id: number; executionProvider: string }

/** Cleaned page handed from the worker to the reader on the main thread. */
export interface PreparedPageMessage {
  width: number
  height: number
  data: ArrayBuffer
  tiltCorrected: boolean
  perspectiveCorrected: boolean
  watermarkSuppressed: boolean
  rotationAngleDeg: number
  documentQuad: Quad | null
  sourceSize: { width: number; height: number }
  rectifiedSize: { width: number; height: number }
  watermarkPixelRatio: number
  warnings: string[]
  timingsMs: Partial<Record<StageName, number>>
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

export const DEFAULT_OPTIONS: OcrOptions = {
  perspective: {
    enabled: true,
    minAreaRatio: 0.25,
    maxCornerAngleDeviationDeg: 35,
    approxEpsilonRatio: 0.02,
    workingSize: 720,
  },
  deskew: {
    enabled: true,
    maxAngleDeg: 20,
    minAngleDeg: 0.25,
    coarseStepDeg: 1,
    fineStepDeg: 0.1,
  },
  watermark: {
    enabled: true,
    chromaThreshold: 18,
    saturationThreshold: 60,
    backgroundKernel: 31,
    inkRatio: 0.82,
    maxComponentAreaRatio: 0.06,
  },
  detector: {
    // These mirror the PP-OCRv5 mobile detector preset in
    // `models/registry.ts`, which is the default bundle. DB post-processing
    // thresholds are specific to a set of weights and are NOT interchangeable —
    // PP-OCRv6-tiny, for instance, wants 0.2 / 0.4 / 1.4, and running it with
    // these values drops most boxes and looks like a broken model. `App.tsx`
    // re-derives them from the active bundle via `applyDetectorPreset`, so
    // these are only the starting point.
    // PP-OCRv5's own config says 960, which suits a roughly square page. A
    // 2000px receipt scaled to 960 leaves body text around 10px tall, well under
    // what the recogniser needs, so the default is raised and rounded by the
    // detector to its stride.
    limitSideLen: 1600,
    binaryThreshold: 0.3,
    boxThreshold: 0.6,
    unclipRatio: 1.5,
    minBoxSize: 3,
    maxCandidates: 1000,
  },
  recognizer: {
    // Off by default. Restricting the decode to 0-9 is a large accuracy win on a
    // pure number grid, but it destroys every other kind of column — a game
    // name, a date, an amount with a credit suffix. Turn it on only when the
    // document really is nothing but digits.
    digitsOnly: false,
    // Fixed at 48 in the en_PP-OCRv5 graph; feeding 32 throws.
    inputHeight: 48,
    maxInputWidth: 320,
    batchSize: 8,
  },
  cluster: {
    columnCount: 'auto',
    maxColumns: 8,
    allowFewerColumns: true,
    autoFieldType: false,
    rowOverlapRatio: 0.5,
  },
  // Tesseract by default: it needs no network, and PP-OCR's 12 MB of weights
  // should be a choice rather than a surprise on first load.
  reader: 'tesseract',
  minConfidence: 0.35,
  debug: false,
  // Receipts are tall and narrow and their print is small. Downscaling a
  // 2000px-tall receipt to 1600 throws away resolution the recogniser needs,
  // and the cost of not doing so is a few hundred milliseconds.
  maxInputSize: 2400,
}
