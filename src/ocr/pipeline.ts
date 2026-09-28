/**
 * The pipeline: photo in, structured JSON out.
 *
 * Stage order, and why it is this order:
 *
 *   decode → perspective → watermark → deskew → detect → recognize → cluster
 *
 *   · **Perspective before everything.** Every later stage assumes the page is
 *     flat. Deskewing a trapezoid is meaningless — there is no single angle that
 *     levels it — and an ink threshold tuned on a foreshortened edge is wrong.
 *
 *   · **Watermark before deskew**, which looks backwards but is not: the skew
 *     estimator needs a clean binary mask of *the printed text*, and running it
 *     against the raw page would have it lock onto the diagonal of the watermark
 *     stamp instead. Suppressing first costs nothing, because the mask is needed
 *     downstream anyway, and it is what makes the angle estimate trustworthy.
 *     The mask is then rotated alongside the page rather than recomputed.
 *
 *   · **Detect on the cleaned page, not the original.** The detector never sees
 *     the watermark at all, which is how the requirement "watermarks must never
 *     appear in the final output" is met structurally rather than by filtering
 *     bad readings afterwards.
 *
 * Every stage is individually skippable and every skip is recorded, so a result
 * always says what actually happened to the image rather than what was intended.
 */

import { cropForRecognition, type Crop } from './opencv/crop'
import { estimateSkew, rotateExpand } from './opencv/deskew'
import { detectTextBoxesClassical } from './opencv/fallback-detect'
import type { CV } from './opencv/loader'
import { detectDocumentQuad, warpToQuad } from './opencv/perspective'
import {
  downscaleToMax,
  grayToPage,
  imageDataToMat,
  matToImageData,
} from './opencv/preprocess'
import { MatScope, using } from './opencv/scope'
import { suppressWatermark } from './opencv/watermark'
import type { TextDetector, TextRecognizer } from './onnx/contracts'
import { assignColumns, toColumnResults } from './layout/columns'
import {
  DEFAULT_NORMALIZE,
  inferFieldType,
  inferPadWidth,
  normalizeField,
} from './layout/normalize'
import type {
  DebugImage,
  Detection,
  DetectedBox,
  FieldType,
  OcrOptions,
  OcrResult,
  ProcessingMeta,
  ProgressEvent,
  Quad,
  StageName,
} from './types'

type Mat = InstanceType<CV['Mat']>

export interface PipelineDeps {
  cv: CV
  detector: TextDetector | null
  recognizer: TextRecognizer | null
  executionProvider: string
}

export interface PipelineCallbacks {
  onProgress?: (event: ProgressEvent) => void
  onDebugImage?: (image: DebugImage) => void
  /** Checked between stages; throws `PipelineCancelled` when it returns true. */
  isCancelled?: () => boolean
}

export class PipelineCancelled extends Error {
  constructor() {
    super('Pipeline cancelled')
    this.name = 'PipelineCancelled'
  }
}

/** Wall-clock that works identically on the main thread and in a worker. */
const now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

/**
 * Tracks stage timing and progress reporting so the body of `runPipeline`
 * stays about the image work rather than about bookkeeping.
 */
class StageRecorder {
  readonly timings: Partial<Record<StageName, number>> = {}
  #start = 0
  #current: StageName | null = null
  readonly #callbacks: PipelineCallbacks

  constructor(callbacks: PipelineCallbacks) {
    this.#callbacks = callbacks
  }

  begin(stage: StageName): void {
    this.#current = stage
    this.#start = now()
    this.#callbacks.onProgress?.({ stage, status: 'start' })
  }

  end(stage: StageName, message?: string): void {
    const elapsed = now() - this.#start
    this.timings[stage] = elapsed
    this.#callbacks.onProgress?.({ stage, status: 'done', message, elapsedMs: elapsed })
    this.#current = null
  }

  skip(stage: StageName, message: string): void {
    const elapsed = this.#current === stage ? now() - this.#start : 0
    this.timings[stage] = elapsed
    this.#callbacks.onProgress?.({ stage, status: 'skip', message, elapsedMs: elapsed })
    this.#current = null
  }

  fail(stage: StageName, message: string): void {
    this.#callbacks.onProgress?.({ stage, status: 'error', message })
    this.#current = null
  }
}

/**
 * Run the whole pipeline.
 *
 * `image` is consumed only for the initial `Mat`; the caller keeps ownership of
 * its buffer. Every OpenCV allocation is tied to a single scope and released on
 * the way out, including on the error path.
 */
export async function runPipeline(
  image: { width: number; height: number; data: Uint8ClampedArray },
  deps: PipelineDeps,
  options: OcrOptions,
  callbacks: PipelineCallbacks = {},
): Promise<OcrResult> {
  const { cv } = deps
  const started = now()
  const recorder = new StageRecorder(callbacks)
  const warnings: string[] = []
  const scope = new MatScope()
  const columnFieldTypes: FieldType[] = []

  const checkCancelled = () => {
    if (callbacks.isCancelled?.()) throw new PipelineCancelled()
  }

  const emitDebug = (stage: StageName, label: string, mat: Mat) => {
    if (!options.debug || !callbacks.onDebugImage) return
    try {
      const snapshot = matToImageData(cv, mat)
      callbacks.onDebugImage({
        stage,
        label,
        width: snapshot.width,
        height: snapshot.height,
        data: snapshot.data,
      })
    } catch {
      /* a debug snapshot must never break a run */
    }
  }

  try {
    /* ---------------------------------------------------------------- decode */
    recorder.begin('decode')
    const original = scope.add(imageDataToMat(cv, image))
    const sourceSize = { width: original.cols, height: original.rows }

    const { mat: scaled, scale } = downscaleToMax(cv, scope, original, options.maxInputSize)
    recorder.end(
      'decode',
      scale < 1
        ? `downscaled to ${scaled.cols}×${scaled.rows} (×${scale.toFixed(2)})`
        : undefined,
    )
    emitDebug('decode', 'input', scaled)
    checkCancelled()

    /* ----------------------------------------------------------- perspective */
    recorder.begin('perspective')
    let rectified: Mat = scaled
    let perspectiveCorrected = false
    let documentQuad: Quad | null = null

    if (!options.perspective.enabled) {
      recorder.skip('perspective', 'disabled in settings')
    } else {
      const candidate = detectDocumentQuad(cv, scaled, options.perspective)
      if (!candidate) {
        recorder.skip(
          'perspective',
          'no four-corner document outline found — leaving the image as-is',
        )
      } else if (!candidate.worthWarping) {
        // Found the page, but it is already flat. Warping would cost a resample
        // and soften every stroke for no geometric gain.
        documentQuad = scaleQuad(candidate.quad, 1 / scale)
        recorder.skip('perspective', candidate.skipReason ?? 'the page is already square-on')
      } else {
        try {
          rectified = warpToQuad(cv, scope, scaled, candidate.quad)
          perspectiveCorrected = true
          // Report the quad in the ORIGINAL image's coordinates.
          documentQuad = scaleQuad(candidate.quad, 1 / scale)
          recorder.end(
            'perspective',
            `warped from a quad covering ${(candidate.areaRatio * 100).toFixed(0)}% of the frame`,
          )
          emitDebug('perspective', 'rectified', rectified)
        } catch (error) {
          rectified = scaled
          recorder.skip('perspective', `warp failed: ${messageOf(error)}`)
          warnings.push(`Perspective correction was skipped: ${messageOf(error)}`)
        }
      }
    }
    checkCancelled()

    /* ------------------------------------------------------------- watermark */
    recorder.begin('watermark')
    const suppression = suppressWatermark(cv, scope, rectified, options.watermark)
    // Two outputs with opposite consumers: `ink` (binary) drives deskew and the
    // classical detector; `cleanGray` (continuous tone) feeds the neural stages,
    // which need real grey levels along the stroke edges.
    let ink = suppression.ink
    let cleanGray = suppression.cleanGray
    warnings.push(...suppression.warnings)

    const watermarkSuppressed =
      options.watermark.enabled && !suppression.colorGateDisarmed
    recorder.end(
      'watermark',
      options.watermark.enabled
        ? `${(suppression.pixelRatio * 100).toFixed(1)}% of pixels classified as coloured overlay`
        : 'colour filtering disabled — thresholding only',
    )
    emitDebug('watermark', 'colour mask', suppression.colorMask)
    emitDebug('watermark', 'flattened', cleanGray)
    emitDebug('watermark', 'ink mask', ink)
    checkCancelled()

    /* ---------------------------------------------------------------- deskew */
    recorder.begin('deskew')
    let rotationAngleDeg = 0
    let tiltCorrected = false

    if (!options.deskew.enabled) {
      recorder.skip('deskew', 'disabled in settings')
    } else {
      const skew = estimateSkew(cv, ink, options.deskew)
      if (skew.rejected) {
        recorder.skip('deskew', skew.reason ?? 'no reliable angle found')
      } else {
        rotationAngleDeg = skew.angleDeg
        // Rotate both working images so they stay in the same coordinate frame.
        // White border for the page (a dark fill would read as ink), black for
        // the mask (a white fill would read as one enormous stroke), and nearest
        // neighbour for the mask so it stays binary.
        cleanGray = rotateExpand(cv, scope, cleanGray, skew.angleDeg, 255)
        ink = rotateExpand(cv, scope, ink, skew.angleDeg, 0, cv.INTER_NEAREST)
        tiltCorrected = true
        recorder.end(
          'deskew',
          `rotated ${skew.angleDeg.toFixed(2)}° (confidence ${skew.confidence.toFixed(2)})`,
        )
        emitDebug('deskew', 'levelled', ink)
      }
    }
    checkCancelled()

    /* -------------------------------------------------------------- binarize */
    recorder.begin('binarize')
    const cleanPage = scope.add(grayToPage(cv, cleanGray))
    recorder.end('binarize')
    emitDebug('binarize', 'clean page', cleanPage)
    checkCancelled()

    /* ---------------------------------------------------------------- detect */
    recorder.begin('detect')
    let boxes: DetectedBox[] = []
    let detectorBackend: ProcessingMeta['detectorBackend'] = 'onnx'
    let detectorModel = deps.detector?.name ?? 'none'

    if (deps.detector) {
      try {
        boxes = await deps.detector.detect(cv, cleanPage, options.detector)
      } catch (error) {
        warnings.push(
          `The neural text detector failed (${messageOf(error)}); fell back to connected-component detection.`,
        )
        boxes = []
      }
    }

    if (boxes.length === 0) {
      const classical = detectTextBoxesClassical(cv, ink)
      if (classical.length > 0 || !deps.detector) {
        if (deps.detector && classical.length > 0) {
          warnings.push(
            'The neural detector found nothing; used connected-component detection instead.',
          )
        }
        boxes = classical
        detectorBackend = 'opencv-fallback'
        detectorModel = 'opencv-connected-components'
      }
    }

    recorder.end('detect', `${boxes.length} candidate boxes (${detectorBackend})`)
    if (options.debug) emitDebug('detect', 'detections', drawBoxes(cv, cleanPage, boxes))
    checkCancelled()

    /* ------------------------------------------------------------- recognize */
    recorder.begin('recognize')
    const detections: Detection[] = []

    if (boxes.length === 0) {
      recorder.skip('recognize', 'nothing was detected')
      warnings.push(
        'No text was detected. The page may be blank after suppression — try disabling watermark suppression or lowering the detector threshold.',
      )
    } else if (!deps.recognizer) {
      recorder.skip('recognize', 'no recogniser is loaded')
      warnings.push(
        'The text recogniser could not be loaded, so boxes were found but not read. ' +
          'rawDetections contains the geometry; columns are empty.',
      )
      for (const box of boxes) {
        detections.push(emptyDetection(box, 'empty-text'))
      }
    } else {
      const recognizerScope = new MatScope()
      try {
        const crops = cropForRecognition(cv, recognizerScope, cleanPage, boxes, {
          targetHeight: deps.recognizer.inputHeight,
          maxWidth: options.recognizer.maxInputWidth,
          padRatio: 0.12,
        })

        const readings = await deps.recognizer.recognize(cv, crops, options.recognizer)
        checkCancelled()

        const byId = new Map<number, Crop>(crops.map((c) => [c.id, c]))

        for (const box of boxes) {
          const index = crops.findIndex((c) => c.id === box.id)
          if (index === -1 || !byId.has(box.id)) {
            detections.push(emptyDetection(box, 'empty-text'))
            continue
          }

          const reading = readings[index]
          if (!reading) {
            detections.push(emptyDetection(box, 'empty-text'))
            continue
          }

          // Only the conservative cleanup here — trim and collapse whitespace.
          // Column-specific rules cannot be applied yet, because which column a
          // box belongs to is not known until after clustering, and the right
          // rule for a date column would destroy the game-name column.
          const cleaned = normalizeField(reading.text, DEFAULT_NORMALIZE)

          const confidence = box.score * reading.confidence
          const belowThreshold = confidence < options.minConfidence

          detections.push({
            ...box,
            text: cleaned.rejected || belowThreshold ? '' : cleaned.text,
            rawText: reading.rawText,
            detScore: box.score,
            recScore: reading.confidence,
            confidence,
            columnIndex: null,
            rowIndex: null,
            rejectedReason:
              cleaned.rejected ?? (belowThreshold ? 'low-recognition-score' : undefined),
          })
        }
      } finally {
        recognizerScope.release()
      }

      const kept = detections.filter((d) => d.text.length > 0).length
      recorder.end('recognize', `${kept} of ${detections.length} boxes produced text`)
    }
    checkCancelled()

    /* --------------------------------------------------------------- cluster */
    recorder.begin('cluster')
    const assignment = assignColumns(detections, options.cluster)

    /* Now that each box has a column, apply that column's cleanup rules. A pack
       code, a game name, a date and a credit amount each need different repairs,
       and applying any one of them document-wide would destroy the other three. */
    assignment.columns.forEach((column, index) => {
      const spec = options.cluster.columnSpecs?.[index]
      const fieldType: FieldType =
        spec?.fieldType ??
        (options.cluster.autoFieldType ? inferFieldType(column.map((d) => d.text)) : 'auto')

      // Zero-padding is only a sensible question for a bare-integer column.
      const padToWidth =
        fieldType === 'number' ? inferPadWidth(column.map((d) => d.text)) : null

      for (const detection of column) {
        const normalized = normalizeField(detection.text, {
          ...DEFAULT_NORMALIZE,
          fieldType,
          padToWidth,
        })
        if (normalized.rejected) {
          detection.rejectedReason = normalized.rejected
          detection.text = ''
        } else {
          detection.text = normalized.text
        }
      }

      columnFieldTypes[index] = fieldType
    })

    const columns = toColumnResults(assignment, options.cluster).map((column, index) => ({
      ...column,
      fieldType: columnFieldTypes[index],
      label: options.cluster.columnSpecs?.[index]?.label,
    }))

    for (const problem of assignment.problems) {
      warnings.push(clusterWarning(problem, assignment.strategy))
    }
    recorder.end(
      'cluster',
      `${assignment.strategy}, separation ${assignment.separationRatio.toFixed(2)}`,
    )

    /* -------------------------------------------------------------- assemble */
    recorder.begin('assemble')
    const meta: ProcessingMeta = {
      tiltCorrected,
      perspectiveCorrected,
      watermarkSuppressed,
      rotationAngleDeg,
      documentQuad,
      sourceSize,
      rectifiedSize: { width: cleanGray.cols, height: cleanGray.rows },
      watermarkPixelRatio: suppression.pixelRatio,
      detectorModel,
      recognizerModel: deps.recognizer?.name ?? 'none',
      detectorBackend,
      executionProvider: deps.executionProvider,
      timingsMs: recorder.timings,
      totalMs: now() - started,
      warnings,
    }
    recorder.end('assemble')

    return {
      kind: 'invoice',
      rows: [],
      settlements: [],
      fields: [],
      columns,
      rawDetections: detections,
      // This pipeline returns columns rather than receipt rows, so none of the
      // receipt-level identities apply to it.
      validation: [],
      processingMeta: meta,
    }
  } catch (error) {
    if (!(error instanceof PipelineCancelled)) {
      recorder.fail('assemble', messageOf(error))
    }
    throw error
  } finally {
    // The single most important line in this file: without it, every run leaks
    // several megabytes of WASM heap that the JS garbage collector cannot see.
    scope.release()
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function emptyDetection(box: DetectedBox, reason: Detection['rejectedReason']): Detection {
  return {
    ...box,
    text: '',
    rawText: '',
    detScore: box.score,
    recScore: 0,
    confidence: 0,
    columnIndex: null,
    rowIndex: null,
    rejectedReason: reason,
  }
}

function scaleQuad(quad: Quad, factor: number): Quad {
  const s = (p: { x: number; y: number }) => ({ x: p.x * factor, y: p.y * factor })
  return { tl: s(quad.tl), tr: s(quad.tr), br: s(quad.br), bl: s(quad.bl) }
}

function clusterWarning(problem: string, strategy: string): string {
  switch (problem) {
    case 'empty-cluster':
      return `One or more columns came out empty (${strategy}). The photo may be cropping a column.`
    case 'overlapping-ranges':
      return `The column bands overlap horizontally (${strategy}); residual tilt or perspective is the usual cause.`
    case 'degenerate-separation':
      return `The detected numbers are not clearly separated into columns (${strategy}); the split may be arbitrary.`
    case 'severe-imbalance':
      return `The columns hold very unequal counts (${strategy}); check for a partly cropped column.`
    default:
      return `Column clustering reported "${problem}" (${strategy}).`
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  // OpenCV throws bare integers that index into an internal exception table;
  // surfacing "7602320" helps nobody, so name the source at least.
  if (typeof error === 'number') return `OpenCV error code ${error}`
  return String(error)
}

/** Draw detection boxes over the page for the debug strip. Caller owns the result. */
function drawBoxes(cv: CV, page: Mat, boxes: readonly DetectedBox[]): Mat {
  return using((scope) => {
    const canvas = new cv.Mat()
    page.copyTo(canvas)

    for (const box of boxes) {
      const strong = box.score >= 0.7
      const color = strong ? new cv.Scalar(20, 120, 255) : new cv.Scalar(255, 140, 0)
      cv.rectangle(
        canvas,
        new cv.Point(Math.round(box.box.x), Math.round(box.box.y)),
        new cv.Point(
          Math.round(box.box.x + box.box.width),
          Math.round(box.box.y + box.box.height),
        ),
        color,
        2,
      )
    }

    scope.keep(canvas)
    return canvas
  })
}
