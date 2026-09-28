/**
 * Getting pixels into and out of OpenCV, and the shared illumination work.
 *
 * Everything here returns a `Mat` the caller owns and must delete, or takes a
 * `MatScope` that will own it. The convention is stated on each function.
 */

import type { CV } from './loader'
import { using, type MatScope } from './scope'

// The package's own `Mat` type. Aliased so call sites stay readable.
type Mat = InstanceType<CV['Mat']>

/**
 * Wrap `ImageData` as an RGBA `Mat`. The pixel data is copied, so the source
 * buffer can be transferred or reused afterwards.
 *
 * Caller owns the result.
 */
export function imageDataToMat(
  cv: CV,
  image: { width: number; height: number; data: Uint8ClampedArray },
): Mat {
  const mat = new cv.Mat(image.height, image.width, cv.CV_8UC4)
  mat.data.set(image.data)
  return mat
}

/**
 * Convert any `Mat` to RGBA `ImageData` for display.
 *
 * Handles 1-, 3- and 4-channel inputs so debug snapshots can be taken at any
 * point in the pipeline without the caller having to know the current format.
 */
export function matToImageData(cv: CV, src: Mat): ImageData {
  return using((scope) => {
    let rgba: Mat
    const channels = src.channels()

    if (channels === 4) {
      rgba = src
    } else if (channels === 3) {
      rgba = scope.add(new cv.Mat())
      cv.cvtColor(src, rgba, cv.COLOR_RGB2RGBA)
    } else {
      rgba = scope.add(new cv.Mat())
      cv.cvtColor(src, rgba, cv.COLOR_GRAY2RGBA)
    }

    // `mat.data` is a live view onto the WASM heap; copy before it is freed.
    const copy = new Uint8ClampedArray(rgba.data)
    return new ImageData(copy, src.cols, src.rows)
  })
}

/** Longest-side downscale. Returns the original when no resize is needed. */
export function downscaleToMax(
  cv: CV,
  scope: MatScope,
  src: Mat,
  maxSize: number,
): { mat: Mat; scale: number } {
  const longest = Math.max(src.cols, src.rows)
  if (longest <= maxSize) return { mat: src, scale: 1 }

  const scale = maxSize / longest
  const out = scope.add(new cv.Mat())
  cv.resize(
    src,
    out,
    new cv.Size(Math.max(1, Math.round(src.cols * scale)), Math.max(1, Math.round(src.rows * scale))),
    0,
    0,
    // INTER_AREA is the correct filter for shrinking — it box-averages instead
    // of point-sampling, so thin printed strokes survive instead of aliasing away.
    cv.INTER_AREA,
  )
  return { mat: out, scale }
}

/**
 * Perceptual luminance, via the L channel of CIELAB.
 *
 * `COLOR_RGBA2GRAY` applies the Rec.601 luma weights, which under-weight blue
 * and make a saturated blue watermark look much darker than it reads to the
 * eye. L\* is perceptually uniform, so a later "is this stroke dark?" threshold
 * behaves consistently across ink colours.
 *
 * The result is registered on `scope`.
 */
export function luminance(cv: CV, scope: MatScope, rgba: Mat): Mat {
  const rgb = scope.add(new cv.Mat())
  cv.cvtColor(rgba, rgb, rgba.channels() === 4 ? cv.COLOR_RGBA2RGB : cv.COLOR_GRAY2RGB)

  const lab = scope.add(new cv.Mat())
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab)

  const channels = scope.add(new cv.MatVector())
  cv.split(lab, channels)

  // Clone before the vector is deleted — `MatVector.get` hands back a view that
  // the vector's destructor will invalidate.
  const l = scope.add(channels.get(0).clone())
  return l
}

/**
 * Estimate the page background by morphological closing.
 *
 * Closing with a kernel larger than the glyph stroke width removes the dark
 * strokes entirely, leaving a smooth surface that follows the lighting. It is a
 * better background model than a heavy blur, which would be dragged darker by
 * the very strokes it is meant to ignore.
 *
 * The result is registered on `scope`.
 */
export function estimateBackground(
  cv: CV,
  scope: MatScope,
  gray: Mat,
  kernelSize: number,
): Mat {
  // Ellipse rather than rectangle: a rectangular kernel leaves faint axis-aligned
  // ridges that survive the division and read as false strokes.
  const size = Math.max(3, kernelSize | 1) // morphology needs an odd size
  const kernel = scope.add(
    cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(size, size)),
  )
  const background = scope.add(new cv.Mat())
  cv.morphologyEx(gray, background, cv.MORPH_CLOSE, kernel)
  return background
}

/**
 * Flatten uneven lighting by dividing the image by its own background.
 *
 * The result is a normalised image where 255 means "as bright as the local page"
 * and lower values mean "darker than the page here" — so a single global
 * threshold becomes meaningful again even under a strong lighting gradient.
 *
 * This also erases soft, large-scale grey watermarks for free: anything the
 * closing kernel can absorb into the background model divides away to white.
 *
 * The result is registered on `scope`.
 */
export function normalizeIllumination(
  cv: CV,
  scope: MatScope,
  gray: Mat,
  kernelSize: number,
): Mat {
  const background = estimateBackground(cv, scope, gray, kernelSize)

  const grayF = scope.add(new cv.Mat())
  gray.convertTo(grayF, cv.CV_32F)
  const bgF = scope.add(new cv.Mat())
  background.convertTo(bgF, cv.CV_32F)

  // Guard the denominator: a genuinely black background pixel would otherwise
  // produce a division by zero and a NaN that propagates through the threshold.
  const one = scope.add(new cv.Mat(bgF.rows, bgF.cols, cv.CV_32F, new cv.Scalar(1)))
  cv.max(bgF, one, bgF)

  const ratio = scope.add(new cv.Mat())
  cv.divide(grayF, bgF, ratio, 255)

  const out = scope.add(new cv.Mat())
  ratio.convertTo(out, cv.CV_8U)
  return out
}

/**
 * Render a binary mask as a printable page: white background, black ink.
 *
 * Kept for the debug view and for any consumer that genuinely wants a hard
 * mask. **Do not feed this to the neural stages** — see {@link grayToPage}.
 *
 * Caller owns the result.
 */
export function maskToPage(cv: CV, mask: Mat): Mat {
  return using((scope) => {
    const inverted = scope.add(new cv.Mat())
    cv.bitwise_not(mask, inverted) // ink 255 → 0, background 0 → 255

    const rgb = new cv.Mat()
    cv.cvtColor(inverted, rgb, cv.COLOR_GRAY2RGB)
    return rgb
  })
}

/**
 * Replicate a continuous-tone greyscale page across three channels.
 *
 * This is the handoff format for the ONNX detector and recogniser. Both were
 * trained on photographs, and the CRNN in particular relies on the anti-aliased
 * gradient along a stroke edge to separate `6` from `8`, `3` from `9` and `5`
 * from `6`. Handing them a hard-thresholded image throws that signal away and
 * measurably increases substitution errors — so the binary mask stays on the
 * classical side of the pipeline and the networks get real grey levels.
 *
 * Caller owns the result.
 */
export function grayToPage(cv: CV, gray: Mat): Mat {
  const rgb = new cv.Mat()
  cv.cvtColor(gray, rgb, cv.COLOR_GRAY2RGB)
  return rgb
}

/** Fraction of non-zero pixels in a mask, in [0, 1]. */
export function coverage(cv: CV, mask: Mat): number {
  const total = mask.rows * mask.cols
  if (total === 0) return 0
  return cv.countNonZero(mask) / total
}
