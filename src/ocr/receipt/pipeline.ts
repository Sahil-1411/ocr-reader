/**
 * Receipt pipeline: photo in, label/value rows out.
 *
 *   decode → perspective → watermark → deskew → read → pair
 *
 * Perspective and deskew are skipped when the page is already straight. The
 * watermark stage stays, because the coloured stamp crosses the amounts.
 * Reading happens on the page, not in this worker: Tesseract starts its own
 * worker, and a worker cannot reliably start another one. This module stops
 * once the page is clean and flat.
 */

import { estimateSkew, rotateExpand } from '../opencv/deskew'
import type { CV } from '../opencv/loader'
import { detectDocumentQuad, warpToQuad } from '../opencv/perspective'
import {
  downscaleToMax,
  grayToPage,
  imageDataToMat,
  matToImageData,
} from '../opencv/preprocess'
import { MatScope } from '../opencv/scope'
import { suppressWatermark } from '../opencv/watermark'
import type {
  DebugImage,
  OcrOptions,
  ProgressEvent,
  Quad,
  StageName,
} from '../types'

export interface PreparedReceipt {
  image: ImageData
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

type Mat = InstanceType<CV['Mat']>

export interface ReceiptDeps {
  cv: CV
}

export interface ReceiptCallbacks {
  onProgress?: (event: ProgressEvent) => void
  onDebugImage?: (image: DebugImage) => void
  isCancelled?: () => boolean
}

export class ReceiptCancelled extends Error {
  constructor() {
    super('Pipeline cancelled')
    this.name = 'ReceiptCancelled'
  }
}

const now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()

class StageRecorder {
  readonly timings: Partial<Record<StageName, number>> = {}
  #start = 0
  #current: StageName | null = null
  readonly #callbacks: ReceiptCallbacks

  constructor(callbacks: ReceiptCallbacks) {
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

export async function prepareReceiptPage(
  source: { width: number; height: number; data: Uint8ClampedArray },
  deps: ReceiptDeps,
  options: OcrOptions,
  callbacks: ReceiptCallbacks = {},
): Promise<PreparedReceipt> {
  const { cv } = deps
  const recorder = new StageRecorder(callbacks)
  const warnings: string[] = []
  const scope = new MatScope()

  const checkCancelled = () => {
    if (callbacks.isCancelled?.()) throw new ReceiptCancelled()
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
    recorder.begin('decode')
    const original = scope.add(imageDataToMat(cv, source))
    const sourceSize = { width: original.cols, height: original.rows }
    const { mat: scaled, scale } = downscaleToMax(cv, scope, original, options.maxInputSize)
    recorder.end(
      'decode',
      scale < 1
        ? `downscaled to ${scaled.cols}×${scaled.rows} (×${scale.toFixed(2)})`
        : `${scaled.cols}×${scaled.rows}`,
    )
    emitDebug('decode', 'input', scaled)
    checkCancelled()

    recorder.begin('perspective')
    let rectified: Mat = scaled
    let perspectiveCorrected = false
    let documentQuad: Quad | null = null

    if (!options.perspective.enabled) {
      recorder.skip('perspective', 'disabled')
    } else {
      const candidate = detectDocumentQuad(cv, scaled, options.perspective)
      if (!candidate) {
        recorder.skip('perspective', 'no four-corner document outline found — leaving the image as-is')
      } else if (!candidate.worthWarping) {
        documentQuad = scaleQuad(candidate.quad, 1 / scale)
        recorder.skip('perspective', candidate.skipReason ?? 'the page is already square-on')
      } else {
        try {
          rectified = warpToQuad(cv, scope, scaled, candidate.quad)
          perspectiveCorrected = true
          documentQuad = scaleQuad(candidate.quad, 1 / scale)
          recorder.end(
            'perspective',
            `warped from a quad covering ${(candidate.areaRatio * 100).toFixed(0)}% of the frame`,
          )
          emitDebug('perspective', 'rectified', rectified)
        } catch (error) {
          rectified = scaled
          const message = messageOf(error)
          recorder.skip('perspective', `warp failed: ${message}`)
          warnings.push(`Perspective correction was skipped: ${message}`)
        }
      }
    }
    checkCancelled()

    recorder.begin('watermark')
    const suppression = suppressWatermark(cv, scope, rectified, options.watermark)
    let cleanGray = suppression.cleanGray
    warnings.push(...suppression.warnings)
    const watermarkSuppressed = options.watermark.enabled && !suppression.colorGateDisarmed
    recorder.end(
      'watermark',
      options.watermark.enabled
        ? `${(suppression.pixelRatio * 100).toFixed(1)}% of pixels classified as coloured overlay`
        : 'colour filtering disabled',
    )
    emitDebug('watermark', 'flattened', cleanGray)
    checkCancelled()

    recorder.begin('deskew')
    let rotationAngleDeg = 0
    let tiltCorrected = false
    if (!options.deskew.enabled) {
      recorder.skip('deskew', 'disabled')
    } else {
      const skew = estimateSkew(cv, suppression.ink, options.deskew)
      if (skew.rejected) {
        recorder.skip('deskew', skew.reason ?? 'no reliable angle found')
      } else {
        rotationAngleDeg = skew.angleDeg
        cleanGray = rotateExpand(cv, scope, cleanGray, skew.angleDeg, 255)
        tiltCorrected = true
        recorder.end(
          'deskew',
          `rotated ${skew.angleDeg.toFixed(2)}° (confidence ${skew.confidence.toFixed(2)})`,
        )
        emitDebug('deskew', 'levelled', cleanGray)
      }
    }
    checkCancelled()

    // The older column pipeline has these stages. This path does not.
    recorder.skip('binarize', 'the reader uses the cleaned greyscale page')
    recorder.skip('detect', 'word boxes come from the reader')
    recorder.skip('cluster', 'each line is paired into a label and a value')

    const page = scope.add(grayToPage(cv, cleanGray))
    const image = matToImageData(cv, page)
    return {
      image,
      tiltCorrected,
      perspectiveCorrected,
      watermarkSuppressed,
      rotationAngleDeg,
      documentQuad,
      sourceSize,
      rectifiedSize: { width: cleanGray.cols, height: cleanGray.rows },
      watermarkPixelRatio: suppression.pixelRatio,
      warnings,
      timingsMs: { ...recorder.timings },
    }
  } catch (error) {
    if (!(error instanceof ReceiptCancelled)) {
      recorder.fail('assemble', messageOf(error))
    }
    throw error
  } finally {
    scope.release()
  }
}

function scaleQuad(quad: Quad, factor: number): Quad {
  const scale = (point: { x: number; y: number }) => ({
    x: point.x * factor,
    y: point.y * factor,
  })
  return { tl: scale(quad.tl), tr: scale(quad.tr), br: scale(quad.br), bl: scale(quad.bl) }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'number') return `OpenCV error code ${error}`
  return String(error)
}
