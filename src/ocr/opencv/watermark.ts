/**
 * Suppressing coloured watermarks while keeping the printed numbers.
 *
 * The requirement is "watermarks must never appear in the final output", and the
 * two obvious readings both fail:
 *
 *   · *Threshold harder.* A red `VOID` stamp printed at 40% opacity over white
 *     is genuinely darker than the page, so any luminance threshold that removes
 *     it also removes the thinner parts of the digits underneath.
 *   · *Filter out red specifically.* Works until the ticket stock changes. The
 *     requirement says "red (or any colored)", so the rule has to be about
 *     colourfulness, not about a hue.
 *
 * The property that actually separates the two is **chroma**. Printed numbers
 * are neutral — black ink sits within a couple of units of the grey axis in
 * CIELAB — while any watermark you can see as coloured is by definition far from
 * it. That holds for red, blue, green, a pink logo, an orange seal.
 *
 * Order of operations
 * -------------------
 *   1. **White-balance first.** A tungsten or shade cast tints the entire frame,
 *      which lifts chroma everywhere and makes a fixed threshold erase the print.
 *   2. **Remove the colour, then estimate the background.** This order matters
 *      and is easy to get backwards: a background estimated from an image that
 *      still contains the watermark *encodes* the watermark, and dividing by it
 *      re-injects it as a halo along its own strokes — often worse than leaving
 *      it alone.
 *   3. **Flatten the lighting** by dividing out that (now watermark-free)
 *      background. This is what makes a single global threshold valid under a
 *      gradient, and it erases soft grey watermarks for free: anything the
 *      closing kernel can absorb divides away to white.
 *   4. **Threshold** for the binary mask, and drop components too large to be a
 *      digit — the rings of a seal, which are neutral enough at the edges to
 *      survive step 2.
 *
 * Two outputs, deliberately
 * -------------------------
 * The stage returns both a continuous-tone `cleanGray` and a binary `ink` mask,
 * because they are consumed by things with opposite needs. The neural detector
 * and recogniser were trained on photographs and use the anti-aliased stroke
 * gradients to tell `6` from `8` and `3` from `9`; handing them a hard binary
 * image measurably degrades them. The deskew estimator and the classical
 * fallback detector, by contrast, want a clean mask and nothing else.
 */

import type { CV } from './loader'
import { coverage, normalizeIllumination } from './preprocess'
import { using, type MatScope } from './scope'
import type { WatermarkOptions } from '../types'

type Mat = InstanceType<CV['Mat']>

export interface WatermarkResult {
  /**
   * Continuous-tone, illumination-flattened greyscale with the watermark
   * removed. This is what the neural stages consume. Registered on the scope.
   */
  cleanGray: Mat
  /** Binary ink mask: 255 where a printed stroke survived. Registered on the scope. */
  ink: Mat
  /** The chroma mask that was removed, for the debug view. */
  colorMask: Mat
  /** Fraction of the page classified as coloured watermark, in [0, 1]. */
  pixelRatio: number
  /** Fraction of candidate ink removed by the colour gate, in [0, 1]. */
  inkRemovedRatio: number
  /** True when the colour gate was disarmed because it was eating the print. */
  colorGateDisarmed: boolean
  warnings: string[]
}

/**
 * Pixels darker than this fraction of full scale are never classified as
 * watermark, however colourful they are.
 *
 * This guards the case the chroma rule gets wrong: where a translucent red stamp
 * crosses a black digit, the blend is a *dark* red, which has high chroma and
 * would be masked away — punching a hole through the stroke exactly where the
 * watermark is heaviest. A watermark over paper is light; ink is dark. Keeping
 * dark pixels regardless costs us a faint coloured tint on some strokes and buys
 * us the strokes themselves.
 */
const INK_LUMINANCE_CEILING = 0.42

/**
 * Apply a grey-world white balance.
 *
 * Assumes the average of the scene is neutral, which for a photo of a mostly
 * white ticket is close to true, and rescales each channel to make it so. Run
 * before measuring chroma: without it, a photo taken under tungsten light reads
 * as uniformly orange and a fixed chroma threshold erases the print along with
 * the watermark. The result is registered on `scope`.
 */
export function grayWorldBalance(cv: CV, scope: MatScope, rgb: Mat): Mat {
  const channels = scope.add(new cv.MatVector())
  cv.split(rgb, channels)

  const means: number[] = []
  for (let i = 0; i < 3; i++) {
    means.push(cv.mean(channels.get(i))[0])
  }
  const target = (means[0] + means[1] + means[2]) / 3

  // A near-black or blown-out frame has meaningless channel means; scaling by a
  // huge factor would wreck it. Leave those alone.
  if (target < 8 || means.some((m) => m < 4)) {
    const passthrough = scope.add(new cv.Mat())
    rgb.copyTo(passthrough)
    return passthrough
  }

  const corrected = scope.add(new cv.MatVector())
  const held: Mat[] = []
  for (let i = 0; i < 3; i++) {
    const scaled = scope.add(new cv.Mat())
    // Clamp the gain: a genuinely coloured ticket stock should not be neutralised.
    const gain = Math.max(0.7, Math.min(1.4, target / means[i]))
    channels.get(i).convertTo(scaled, cv.CV_8U, gain, 0)
    held.push(scaled)
    corrected.push_back(scaled)
  }

  const out = scope.add(new cv.Mat())
  cv.merge(corrected, out)
  return out
}

/**
 * Build a mask of colourful pixels.
 *
 * Chroma is `sqrt((a-128)² + (b-128)²)` over OpenCV's 8-bit CIELAB, where 128 is
 * the neutral axis. HSV saturation is deliberately *not* the primary signal: `S`
 * is `(max-min)/max`, so for dark pixels it is dominated by sensor noise and on a
 * dim photo of black ink it reads as high as 0.4 — the exact pixels we must not
 * delete. Saturation is still useful for a bright pale wash, so it is OR-ed in
 * but gated on the pixel being bright enough for `S` to mean anything.
 *
 * The result is registered on `scope`.
 */
export function buildColorMask(
  cv: CV,
  scope: MatScope,
  balancedRgb: Mat,
  luminance: Mat,
  options: WatermarkOptions,
): Mat {
  /* --- CIELAB chroma --- */
  const lab = scope.add(new cv.Mat())
  cv.cvtColor(balancedRgb, lab, cv.COLOR_RGB2Lab)
  const labChannels = scope.add(new cv.MatVector())
  cv.split(lab, labChannels)

  const aF = scope.add(new cv.Mat())
  const bF = scope.add(new cv.Mat())
  labChannels.get(1).convertTo(aF, cv.CV_32F, 1, -128)
  labChannels.get(2).convertTo(bF, cv.CV_32F, 1, -128)

  const a2 = scope.add(new cv.Mat())
  const b2 = scope.add(new cv.Mat())
  cv.multiply(aF, aF, a2)
  cv.multiply(bF, bF, b2)

  const sumSq = scope.add(new cv.Mat())
  cv.add(a2, b2, sumSq)
  const chroma = scope.add(new cv.Mat())
  cv.sqrt(sumSq, chroma)

  const chromaMaskF = scope.add(new cv.Mat())
  cv.threshold(chroma, chromaMaskF, options.chromaThreshold, 255, cv.THRESH_BINARY)
  const chromaMask = scope.add(new cv.Mat())
  chromaMaskF.convertTo(chromaMask, cv.CV_8U)

  /* --- HSV saturation, gated on brightness --- */
  const hsv = scope.add(new cv.Mat())
  cv.cvtColor(balancedRgb, hsv, cv.COLOR_RGB2HSV)
  const hsvChannels = scope.add(new cv.MatVector())
  cv.split(hsv, hsvChannels)

  const satMask = scope.add(new cv.Mat())
  cv.threshold(hsvChannels.get(1), satMask, options.saturationThreshold, 255, cv.THRESH_BINARY)
  const brightMask = scope.add(new cv.Mat())
  cv.threshold(hsvChannels.get(2), brightMask, 110, 255, cv.THRESH_BINARY)
  const brightColored = scope.add(new cv.Mat())
  cv.bitwise_and(satMask, brightMask, brightColored)

  const combined = scope.add(new cv.Mat())
  cv.bitwise_or(chromaMask, brightColored, combined)

  /* --- Protect dark strokes (see INK_LUMINANCE_CEILING) --- */
  const darkMask = scope.add(new cv.Mat())
  cv.threshold(luminance, darkMask, INK_LUMINANCE_CEILING * 255, 255, cv.THRESH_BINARY_INV)
  const notDark = scope.add(new cv.Mat())
  cv.bitwise_not(darkMask, notDark)
  cv.bitwise_and(combined, notDark, combined)

  /* --- Clean up --- */
  const kernel = scope.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)))
  // Close first, so the anti-aliased fringe of a coloured glyph is treated as
  // part of it rather than left behind as a halo of speckle.
  cv.morphologyEx(combined, combined, cv.MORPH_CLOSE, kernel)
  // Then erode by a pixel. JPEG 4:2:0 subsampling smears colour roughly 2 px
  // beyond the ink that produced it, so an un-eroded mask punches holes out of
  // black digits that happen to sit next to the watermark.
  cv.erode(combined, combined, kernel)

  return combined
}

/**
 * Remove connected components too large or too elongated to be a digit.
 *
 * Catches what chroma cannot: the neutral-grey core of a heavy seal, a black
 * border rule, a scan streak down one edge. Operates in place on `mask` and
 * returns the number of components removed.
 */
export function dropOversizedComponents(
  cv: CV,
  mask: Mat,
  maxAreaRatio: number,
): number {
  return using((scope) => {
    const labels = scope.add(new cv.Mat())
    const stats = scope.add(new cv.Mat())
    const centroids = scope.add(new cv.Mat())

    const count = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8, cv.CV_32S)
    const pageArea = mask.rows * mask.cols
    const maxArea = pageArea * maxAreaRatio
    const maxExtent = Math.max(mask.rows, mask.cols) * 0.5

    const doomed = new Set<number>()
    for (let i = 1; i < count; i++) {
      const width = stats.intAt(i, cv.CC_STAT_WIDTH)
      const height = stats.intAt(i, cv.CC_STAT_HEIGHT)
      const area = stats.intAt(i, cv.CC_STAT_AREA)
      if (area > maxArea || width > maxExtent || height > maxExtent) doomed.add(i)
    }

    if (doomed.size === 0) return 0

    // One pass over the label image. A per-component `setTo` with a mask would
    // mean one full-image pass per component.
    const labelData = labels.data32S
    const maskData = mask.data
    for (let i = 0; i < labelData.length; i++) {
      if (doomed.has(labelData[i])) maskData[i] = 0
    }

    return doomed.size
  })
}

/**
 * Run the full suppression pass.
 *
 * `rgba` is the rectified colour image. Both returned images are registered on
 * `scope` and share its lifetime.
 */
export function suppressWatermark(
  cv: CV,
  scope: MatScope,
  rgba: Mat,
  options: WatermarkOptions,
): WatermarkResult {
  const warnings: string[] = []

  const rgb = scope.add(new cv.Mat())
  cv.cvtColor(rgba, rgb, rgba.channels() === 4 ? cv.COLOR_RGBA2RGB : cv.COLOR_GRAY2RGB)

  /* 1. White balance, then take perceptual luminance from L*. */
  const balanced = options.enabled ? grayWorldBalance(cv, scope, rgb) : rgb

  const lab = scope.add(new cv.Mat())
  cv.cvtColor(balanced, lab, cv.COLOR_RGB2Lab)
  const labChannels = scope.add(new cv.MatVector())
  cv.split(lab, labChannels)
  const luminance = scope.add(labChannels.get(0).clone())

  /* 2. Remove the colour from the luminance image BEFORE estimating the
        background, so the background model never contains the watermark. */
  const decolored = scope.add(new cv.Mat())
  luminance.copyTo(decolored)

  let colorMask: Mat
  let pixelRatio = 0

  if (options.enabled) {
    colorMask = buildColorMask(cv, scope, balanced, luminance, options)
    pixelRatio = coverage(cv, colorMask)

    // Fill the masked pixels from their brightest neighbours rather than with a
    // flat white. A hard white patch creates a step edge that the background
    // estimator then has to smooth over, reintroducing the halo we are avoiding.
    const fillKernel = scope.add(
      cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9)),
    )
    const dilated = scope.add(new cv.Mat())
    cv.dilate(luminance, dilated, fillKernel)
    dilated.copyTo(decolored, colorMask)
  } else {
    colorMask = scope.add(cv.Mat.zeros(rgba.rows, rgba.cols, cv.CV_8U))
  }

  /* 3. Flatten the lighting. This is `cleanGray` — continuous tone, which is
        what the neural stages need. */
  const cleanGray = normalizeIllumination(cv, scope, decolored, options.backgroundKernel)

  /* 4. Threshold for the binary mask. Otsu picks the split point from the
        histogram, which beats a fixed cut when the print is faint, while
        `inkRatio` caps how bright a stroke may be so Otsu cannot drift onto the
        paper texture. */
  const otsu = scope.add(new cv.Mat())
  const otsuLevel = cv.threshold(
    cleanGray,
    otsu,
    0,
    255,
    cv.THRESH_BINARY_INV + cv.THRESH_OTSU,
  )

  const cap = options.inkRatio * 255
  let ink: Mat
  if (otsuLevel > cap) {
    ink = scope.add(new cv.Mat())
    cv.threshold(cleanGray, ink, cap, 255, cv.THRESH_BINARY_INV)
    warnings.push(
      `Otsu chose ${Math.round(otsuLevel)}, above the ink cap ${Math.round(cap)}; used the cap ` +
        'instead — the page may be very faint or nearly blank.',
    )
  } else {
    ink = otsu
  }

  /* 4a. Safeguard: measure what the colour gate cost us. If suppression removed
         most of the ink, the *print* is probably coloured rather than the
         watermark, and we have just emptied the page. */
  let inkRemovedRatio = 0
  let colorGateDisarmed = false

  if (options.enabled) {
    const uncolored = scope.add(new cv.Mat())
    cv.threshold(luminance, uncolored, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU)
    const inkBefore = cv.countNonZero(uncolored)
    const inkAfter = cv.countNonZero(ink)
    inkRemovedRatio = inkBefore > 0 ? Math.max(0, (inkBefore - inkAfter) / inkBefore) : 0

    if (inkRemovedRatio > 0.65 && inkBefore > 0) {
      colorGateDisarmed = true
      // Redo the flatten and threshold without the colour step.
      const plainGray = normalizeIllumination(cv, scope, luminance, options.backgroundKernel)
      plainGray.copyTo(cleanGray)
      cv.threshold(cleanGray, ink, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU)
      warnings.push(
        `Colour suppression removed ${(inkRemovedRatio * 100).toFixed(0)}% of all ink, which ` +
          'suggests the numbers themselves are printed in colour rather than black. Colour ' +
          'filtering was skipped for this image — raise the chroma threshold if the watermark ' +
          'is still showing through.',
      )
    }
  }

  /* 5. Drop anything too big to be a digit. */
  const removed = dropOversizedComponents(cv, ink, options.maxComponentAreaRatio)
  if (removed > 0) {
    warnings.push(
      `Removed ${removed} oversized component${removed === 1 ? '' : 's'} (logo, seal or border rule).`,
    )
  }

  /* 6. Despeckle. A 2×2 opening clears isolated noise without thinning a
        two-pixel stroke to nothing, which a 3×3 would. */
  const speckKernel = scope.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2)))
  cv.morphologyEx(ink, ink, cv.MORPH_OPEN, speckKernel)

  if (coverage(cv, ink) < 0.0008) {
    warnings.push(
      'Almost no ink survived suppression. Try lowering "ink darkness", raising the chroma ' +
        'threshold, or disabling watermark suppression.',
    )
  }

  return {
    cleanGray,
    ink,
    colorMask,
    pixelRatio,
    inkRemovedRatio,
    colorGateDisarmed,
    warnings,
  }
}
