/**
 * The interface the pipeline expects from its neural stages.
 *
 * Declared separately from the implementations so `pipeline.ts` never imports
 * ONNX Runtime directly. That keeps the orchestration testable with stub
 * detectors and recognisers, and it is what lets the pipeline fall back to the
 * classical OpenCV detector without any branching in its own code.
 */

import type { BatchNormalization, Crop } from '../opencv/crop'
import type { CV } from '../opencv/loader'
import type { DetectedBox, DetectorOptions, RecognizedText, RecognizerOptions } from '../types'

type Mat = InstanceType<CV['Mat']>

export interface TextDetector {
  /** Reported in `processingMeta.detectorModel`. */
  readonly name: string
  /**
   * Find text boxes in `page`, an RGB `Mat`.
   * Returned coordinates are in `page`'s own pixel space.
   */
  detect(cv: CV, page: Mat, options: DetectorOptions): Promise<DetectedBox[]>
  dispose(): void
}

export interface TextRecognizer {
  /** Reported in `processingMeta.recognizerModel`. */
  readonly name: string
  /** How crops must be scaled and centred before they reach the model. */
  readonly normalization: BatchNormalization
  /** The input height the model was trained at. */
  readonly inputHeight: number
  /**
   * Read each crop. The returned array is index-aligned with `crops`, so a
   * failed crop yields an entry with empty text rather than a shorter array.
   */
  recognize(
    cv: CV,
    crops: readonly Crop[],
    options: RecognizerOptions,
  ): Promise<RecognizedText[]>
  dispose(): void
}

/** What `initRuntime` reports back about the environment it set up. */
export interface RuntimeInfo {
  /** The execution provider actually in use, e.g. `webgpu` or `wasm`. */
  executionProvider: string
  /** Threads the WASM backend was given. 1 when cross-origin isolation is off. */
  threads: number
  /** Whether SIMD is available. */
  simd: boolean
  /** Non-fatal notes about the setup, surfaced in `processingMeta.warnings`. */
  warnings: string[]
}
