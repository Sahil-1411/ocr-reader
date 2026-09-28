/**
 * Cutting detected boxes out of the page for the recogniser.
 *
 * Two details here have an outsized effect on recognition accuracy:
 *
 *   · **Padding.** Detectors are trained to predict a tight box, and CTC models
 *     are trained on crops with a little air around the glyphs. Feeding a
 *     pixel-tight crop reliably clips the ascender of a `7` or the tail of a `9`.
 *     A few percent of margin is close to free and measurably helps.
 *
 *   · **Aspect ratio.** The crop must be resized to the model's input height
 *     with its aspect preserved and then *padded* to the batch width — never
 *     stretched. A CTC recogniser reads a sequence of vertical slices, so
 *     horizontal stretching changes how many slices each glyph occupies and
 *     produces duplicated or dropped characters.
 */

import type { CV } from './loader'
import { using, type MatScope } from './scope'
import type { DetectedBox } from '../types'

type Mat = InstanceType<CV['Mat']>

export interface CropOptions {
  /** Model input height in pixels. */
  targetHeight: number
  /** Maximum width after the aspect-preserving resize. */
  maxWidth: number
  /** Fraction of the box height added as margin on every side. */
  padRatio: number
}

export interface Crop {
  /** Matches the `id` of the `DetectedBox` it came from. */
  id: number
  /** Resized crop, `targetHeight` tall. Registered on the caller's scope. */
  mat: Mat
  /** Width after resizing, before any batch padding. */
  width: number
}

/**
 * Extract and resize every detected box.
 *
 * Boxes with a meaningful rotation are perspective-warped upright rather than
 * axis-aligned-cropped, which would include the wedges of background either
 * side of a slanted line. Results are registered on `scope`.
 */
export function cropForRecognition(
  cv: CV,
  scope: MatScope,
  page: Mat,
  boxes: readonly DetectedBox[],
  options: CropOptions,
): Crop[] {
  const crops: Crop[] = []

  for (const detection of boxes) {
    const mat = cropOne(cv, scope, page, detection, options)
    if (mat) crops.push({ id: detection.id, mat, width: mat.cols })
  }

  return crops
}

function cropOne(
  cv: CV,
  scope: MatScope,
  page: Mat,
  detection: DetectedBox,
  options: CropOptions,
): Mat | null {
  const { box } = detection
  const pad = Math.max(1, Math.round(box.height * options.padRatio))

  const x = Math.max(0, Math.round(box.x) - pad)
  const y = Math.max(0, Math.round(box.y) - pad)
  const right = Math.min(page.cols, Math.round(box.x + box.width) + pad)
  const bottom = Math.min(page.rows, Math.round(box.y + box.height) + pad)

  const width = right - x
  const height = bottom - y
  if (width < 3 || height < 3) return null

  // Rotated enough to be worth warping. Below ~1.5° the axis-aligned crop is
  // indistinguishable and avoids a needless resample.
  const useWarp = Math.abs(detection.angle) > 1.5

  const upright = useWarp
    ? warpUpright(cv, scope, page, detection, options.padRatio)
    : scope.add(page.roi(new cv.Rect(x, y, width, height)).clone())

  if (!upright || upright.cols < 3 || upright.rows < 3) return null

  return resizeToHeight(cv, scope, upright, options.targetHeight, options.maxWidth)
}

/** Warp a rotated detection into an upright crop using its four corners. */
function warpUpright(
  cv: CV,
  scope: MatScope,
  page: Mat,
  detection: DetectedBox,
  padRatio: number,
): Mat | null {
  const [tl, tr, br, bl] = detection.polygon

  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y)

  const targetWidth = Math.round(Math.max(dist(tl, tr), dist(bl, br)))
  const targetHeight = Math.round(Math.max(dist(tl, bl), dist(tr, br)))
  if (targetWidth < 3 || targetHeight < 3) return null

  const padX = targetHeight * padRatio
  const padY = targetHeight * padRatio
  const outWidth = Math.round(targetWidth + padX * 2)
  const outHeight = Math.round(targetHeight + padY * 2)

  const src = scope.add(
    cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]),
  )
  const dst = scope.add(
    cv.matFromArray(4, 1, cv.CV_32FC2, [
      padX, padY,
      outWidth - padX, padY,
      outWidth - padX, outHeight - padY,
      padX, outHeight - padY,
    ]),
  )

  const transform = scope.add(cv.getPerspectiveTransform(src, dst))
  const out = scope.add(new cv.Mat())
  cv.warpPerspective(
    page,
    out,
    transform,
    new cv.Size(outWidth, outHeight),
    cv.INTER_LINEAR,
    cv.BORDER_REPLICATE,
    new cv.Scalar(),
  )
  return out
}

/** Resize to an exact height, preserving aspect and capping the width. */
function resizeToHeight(
  cv: CV,
  scope: MatScope,
  src: Mat,
  targetHeight: number,
  maxWidth: number,
): Mat {
  const ratio = src.cols / src.rows
  const width = Math.max(1, Math.min(maxWidth, Math.round(targetHeight * ratio)))

  const out = scope.add(new cv.Mat())
  cv.resize(
    src,
    out,
    new cv.Size(width, targetHeight),
    0,
    0,
    // Shrinking is the normal case for a phone photo, so area-average; when the
    // crop is small and we are enlarging, cubic keeps the strokes smooth.
    src.rows > targetHeight ? cv.INTER_AREA : cv.INTER_CUBIC,
  )
  return out
}

export interface BatchNormalization {
  /** Subtracted from each channel after scaling to [0, 1]. */
  mean: readonly [number, number, number]
  /** Divides each channel after the mean is subtracted. */
  std: readonly [number, number, number]
  /** Number of channels the model expects: 1 for grayscale, 3 for colour. */
  channels: 1 | 3
  /**
   * Channel order fed to the model.
   *
   * PP-OCR is trained through `cv2.imread`, so its weights were fitted with the
   * ImageNet mean/std applied to the **B, G, R** planes in that index order.
   * Reproducing that apparently-wrong pairing is required, not optional — and it
   * matters most here, because on a red-watermark ticket the R and B channels
   * carry exactly the signal being suppressed.
   */
  channelOrder: 'rgb' | 'bgr'
  /**
   * Value written into the right-hand padding, in **normalised** space.
   *
   * PaddleOCR builds its batch with `np.zeros` and writes the normalised crop
   * into the left of it, so the padding is normalised 0 — which under
   * `(x/255 - 0.5)/0.5` is mid-grey, pixel 127.5. Padding with normalised white
   * or black instead makes the model read phantom strokes and emit trailing
   * garbage characters. That is not a marginal effect in this app: every crop is
   * one or two digits, so the padding is most of the tensor.
   */
  padValue: number
}

/**
 * Pack crops into one NCHW `Float32Array`.
 *
 * Every crop in a batch must be the same width, so they are right-padded to the
 * widest member. The padding value is the normalised colour of *white paper*,
 * not zero: a CTC recogniser trained on dark-on-light crops reads a black strip
 * as a run of glyph-like ink and often emits phantom characters at the end.
 *
 * Returns the tensor plus the padded width, which the caller needs to interpret
 * the output sequence length.
 */
export function packBatch(
  cv: CV,
  crops: readonly Crop[],
  height: number,
  normalization: BatchNormalization,
): { data: Float32Array; width: number; count: number } {
  const count = crops.length
  if (count === 0) return { data: new Float32Array(0), width: 0, count: 0 }

  const width = Math.max(...crops.map((c) => c.mat.cols))
  const { channels, mean, std, padValue, channelOrder } = normalization
  const planeSize = height * width
  const data = new Float32Array(count * channels * planeSize)

  // Fill everything with the pad value first, then overwrite the crop region.
  // `Float32Array` is already zero-filled, so this is a no-op in the common
  // `padValue === 0` case and correct for any other choice.
  if (padValue !== 0) data.fill(padValue)

  using((scope) => {
    for (let n = 0; n < count; n++) {
      const source = crops[n].mat
      const converted = scope.add(new cv.Mat())

      if (channels === 1) {
        if (source.channels() === 1) source.copyTo(converted)
        else {
          cv.cvtColor(
            source,
            converted,
            source.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY,
          )
        }
      } else {
        if (source.channels() === 3) source.copyTo(converted)
        else {
          cv.cvtColor(
            source,
            converted,
            source.channels() === 4 ? cv.COLOR_RGBA2RGB : cv.COLOR_GRAY2RGB,
          )
        }
      }

      const pixels = converted.data
      const cropWidth = converted.cols
      const base = n * channels * planeSize

      // For a 3-channel BGR model, plane 0 must receive the source's B channel.
      // The source Mat is RGB, so the plane index is reversed rather than the
      // mean/std, which stay in their published B,G,R order.
      const planeFor = (c: number) =>
        channels === 3 && channelOrder === 'bgr' ? 2 - c : c

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < cropWidth; x++) {
          const srcIndex = (y * cropWidth + x) * channels
          for (let c = 0; c < channels; c++) {
            const value = pixels[srcIndex + planeFor(c)] / 255
            data[base + c * planeSize + y * width + x] = (value - mean[c]) / std[c]
          }
        }
      }
    }
  })

  return { data, width, count }
}
