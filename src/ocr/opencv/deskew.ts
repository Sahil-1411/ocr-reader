/**
 * Estimating and removing residual in-plane tilt.
 *
 * Perspective correction gets the page flat; it does not get the text level,
 * because the quad it found is only as square as the ticket's printed border.
 * A couple of degrees left over is enough to matter: over a 900 px tall column,
 * 2° drags the bottom number 31 px sideways, which starts to blur the gap
 * between columns that the clustering stage depends on.
 *
 * Method
 * ------
 * Projection-profile variance maximisation, coarse to fine. Rotate the ink mask
 * by a trial angle, sum each row, and score the resulting profile: when the text
 * is level, every row is either dense with strokes or empty, so the profile is
 * spiky and its sum-of-squares is large. Tilt smears the strokes across
 * neighbouring rows and flattens it.
 *
 * This beats the two common alternatives on document photos:
 *
 *   · `minAreaRect` over dilated text is fast but is dominated by whichever blob
 *     is largest, so a border rule or a stray mark swings it wildly.
 *   · `HoughLinesP` finds the ruling lines beautifully — on tickets that have
 *     ruling lines. On a plain column of numbers there is nothing to find.
 *
 * The profile method only needs the text itself, which is the one thing we are
 * guaranteed to have.
 */

import { REDUCE_SUM, REDUCE_TO_SINGLE_COLUMN } from './constants'
import type { CV } from './loader'
import { using, type MatScope } from './scope'
import type { DeskewOptions } from '../types'

type Mat = InstanceType<CV['Mat']>

/** Longest side used for the angle search. Precision comes from the sweep, not resolution. */
const WORKING_SIZE = 480

export interface SkewEstimate {
  /** Degrees. Positive means the content is rotated clockwise and needs +angle to correct. */
  angleDeg: number
  /**
   * How much better the winning angle scored than the median trial, as a ratio.
   * Below ~1.05 the profile is flat and the estimate is not trustworthy.
   */
  confidence: number
  /** True when the estimate was rejected and `angleDeg` is 0. */
  rejected: boolean
  reason?: string
}

/**
 * Score one candidate angle.
 *
 * The score is the sum of squares of the row sums. Rotating a binary mask keeps
 * the total ink roughly constant, so a larger sum-of-squares means the same ink
 * is concentrated into fewer rows — exactly the alignment signal we want.
 */
function profileScore(cv: CV, scope: MatScope, mask: Mat, angleDeg: number): number {
  const center = new cv.Point(mask.cols / 2, mask.rows / 2)
  const m = scope.add(cv.getRotationMatrix2D(center, angleDeg, 1))

  const rotated = scope.add(new cv.Mat())
  cv.warpAffine(
    mask,
    rotated,
    m,
    new cv.Size(mask.cols, mask.rows),
    cv.INTER_NEAREST, // preserve the binary values; interpolation would blur the profile
    cv.BORDER_CONSTANT,
    new cv.Scalar(0),
  )

  // Collapse each row to a single sum. CV_32S keeps the accumulation exact.
  const profile = scope.add(new cv.Mat())
  cv.reduce(rotated, profile, REDUCE_TO_SINGLE_COLUMN, REDUCE_SUM, cv.CV_32S)

  const data = profile.data32S
  let score = 0
  for (let i = 0; i < data.length; i++) {
    const v = data[i] / 255 // back to "pixels per row"
    score += v * v
  }
  return score
}

/**
 * Estimate the skew of a binary ink mask.
 *
 * `mask` is the output of watermark suppression — strokes as 255 on a 0
 * background.
 */
export function estimateSkew(cv: CV, mask: Mat, options: DeskewOptions): SkewEstimate {
  if (!options.enabled) {
    return { angleDeg: 0, confidence: 0, rejected: true, reason: 'disabled' }
  }

  return using((scope) => {
    /* Work small — the sweep runs dozens of rotations. */
    const longest = Math.max(mask.cols, mask.rows)
    const scale = longest > WORKING_SIZE ? WORKING_SIZE / longest : 1
    const small = scope.add(new cv.Mat())
    if (scale < 1) {
      cv.resize(
        mask,
        small,
        new cv.Size(Math.round(mask.cols * scale), Math.round(mask.rows * scale)),
        0,
        0,
        cv.INTER_NEAREST,
      )
    } else {
      mask.copyTo(small)
    }

    const inkPixels = cv.countNonZero(small)
    if (inkPixels < 40) {
      return {
        angleDeg: 0,
        confidence: 0,
        rejected: true,
        reason: 'not enough ink to estimate an angle',
      }
    }

    /* Coarse sweep across the full allowed range. */
    const coarse: Array<{ angle: number; score: number }> = []
    for (
      let angle = -options.maxAngleDeg;
      angle <= options.maxAngleDeg + 1e-9;
      angle += options.coarseStepDeg
    ) {
      coarse.push({ angle, score: profileScore(cv, scope, small, angle) })
    }

    let best = coarse[0]
    for (const c of coarse) if (c.score > best.score) best = c

    /* Fine sweep in a ±1 coarse-step window around the winner. */
    let fineBest = best
    const window = options.coarseStepDeg
    for (
      let angle = best.angle - window;
      angle <= best.angle + window + 1e-9;
      angle += options.fineStepDeg
    ) {
      if (Math.abs(angle) > options.maxAngleDeg) continue
      const score = profileScore(cv, scope, small, angle)
      if (score > fineBest.score) fineBest = { angle, score }
    }

    /* Confidence: how much the winner beats a typical trial. A page of solid
       text with no structure scores about the same at every angle, and we would
       rather do nothing than rotate on noise. */
    const scores = coarse.map((c) => c.score).sort((a, b) => a - b)
    const median = scores[Math.floor(scores.length / 2)] || 1
    const confidence = fineBest.score / median

    if (confidence < 1.02) {
      return {
        angleDeg: 0,
        confidence,
        rejected: true,
        reason: 'the projection profile is flat — no reliable text baseline',
      }
    }

    // `warpAffine` takes a counter-clockwise angle, and that is the angle that
    // levels the text, so the correction is the trial angle itself.
    const angleDeg = fineBest.angle

    if (Math.abs(angleDeg) < options.minAngleDeg) {
      return {
        angleDeg: 0,
        confidence,
        rejected: true,
        reason: `estimated ${angleDeg.toFixed(2)}° — below the ${options.minAngleDeg}° floor, not worth resampling`,
      }
    }

    return { angleDeg, confidence, rejected: false }
  })
}

/**
 * Rotate about the centre, growing the canvas so nothing is cropped.
 *
 * Rotating in place would slice the corners off, and on a tightly framed ticket
 * those corners hold numbers. The result is registered on `scope`.
 */
export function rotateExpand(
  cv: CV,
  scope: MatScope,
  src: Mat,
  angleDeg: number,
  borderValue = 255,
  /**
   * Pass `INTER_NEAREST` for a binary mask — linear interpolation would produce
   * intermediate greys and stop it being a mask.
   */
  interpolation?: number,
): Mat {
  const center = new cv.Point(src.cols / 2, src.rows / 2)
  const m = scope.add(cv.getRotationMatrix2D(center, angleDeg, 1))

  const cos = Math.abs(m.doubleAt(0, 0))
  const sin = Math.abs(m.doubleAt(0, 1))
  const newWidth = Math.ceil(src.rows * sin + src.cols * cos)
  const newHeight = Math.ceil(src.rows * cos + src.cols * sin)

  // Shift the transform so the rotated content is centred in the larger canvas.
  const data = m.data64F
  data[2] += newWidth / 2 - center.x
  data[5] += newHeight / 2 - center.y

  const out = scope.add(new cv.Mat())
  cv.warpAffine(
    src,
    out,
    m,
    new cv.Size(newWidth, newHeight),
    interpolation ?? cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    // White for a page, black for a mask — a dark fill on a page would be read
    // as ink, and a white fill on a mask would be read as one enormous stroke.
    new cv.Scalar(borderValue, borderValue, borderValue, 255),
  )
  return out
}
