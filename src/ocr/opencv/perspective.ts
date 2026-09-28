/**
 * Finding the ticket in the photo and flattening it.
 *
 * A ticket photographed by hand is a trapezoid. Left uncorrected that costs us
 * twice: the digits at the far edge are compressed and read worse, and — much
 * worse — the columns are no longer vertical, so clustering on x sees three
 * bands that lean into each other. Getting the quad right is what makes the
 * column stage's job easy.
 *
 * The conservative choice throughout is to **skip rather than guess**. A warp
 * onto the wrong quad is far more damaging than no warp at all: it can crop half
 * the numbers away, and nothing downstream can recover from that. Every gate
 * below is therefore a reason to return `null` and leave the image alone.
 */

import type { CV } from './loader'
import { using, type MatScope } from './scope'
import type { PerspectiveOptions, Point, Quad } from '../types'

type Mat = InstanceType<CV['Mat']>

export interface QuadCandidate {
  quad: Quad
  areaRatio: number
  /** Largest deviation of any corner from 90°, in degrees. */
  maxAngleDeviation: number
  score: number
  /**
   * False when the quad is already square-on, so warping would only cost a
   * resample. Skipping is a real decision, not a failure: a bicubic warp of an
   * already-flat page softens every stroke for no geometric gain.
   */
  worthWarping: boolean
  /** Why the warp was judged unnecessary, when `worthWarping` is false. */
  skipReason?: string
}

/**
 * Below this much corner deviation, and with opposite sides this well matched,
 * the page is flat enough that warping is pure loss. Both thresholds are
 * deliberately tight — when in doubt we would rather warp than not.
 */
const SQUARE_ON_ANGLE_DEG = 3
const SQUARE_ON_SIDE_TOLERANCE = 0.05

/**
 * A warp whose output is less than 40% or more than 250% of the source area has
 * almost certainly locked onto the wrong contour. Rejecting is much safer than
 * proceeding: a bad quad crops numbers away, and nothing downstream can recover
 * them.
 */
const MIN_OUTPUT_SCALE = 0.4
const MAX_OUTPUT_SCALE = 2.5

/**
 * Order four arbitrary corners as top-left, top-right, bottom-right, bottom-left.
 *
 * Uses the classic sum/difference trick: `x+y` is smallest at the top-left and
 * largest at the bottom-right, while `x−y` is smallest at the bottom-left and
 * largest at the top-right. It is robust to moderate rotation, which a
 * sort-by-y-then-x is not.
 */
export function orderQuadCorners(points: readonly Point[]): Quad {
  if (points.length !== 4) throw new Error('orderQuadCorners expects exactly 4 points')

  const sums = points.map((p) => p.x + p.y)
  const diffs = points.map((p) => p.x - p.y)

  const argMin = (values: number[]) =>
    values.reduce((best, v, i) => (v < values[best] ? i : best), 0)
  const argMax = (values: number[]) =>
    values.reduce((best, v, i) => (v > values[best] ? i : best), 0)

  const tl = points[argMin(sums)]
  const br = points[argMax(sums)]
  const tr = points[argMax(diffs)]
  const bl = points[argMin(diffs)]

  return { tl, tr, br, bl }
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** |a − b| as a fraction of the larger, so it is scale-free. */
function relativeDifference(a: number, b: number): number {
  const larger = Math.max(a, b)
  return larger > 0 ? Math.abs(a - b) / larger : 0
}

/** Interior angle at `b`, in degrees. */
function cornerAngle(a: Point, b: Point, c: Point): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y }
  const v2 = { x: c.x - b.x, y: c.y - b.y }
  const n1 = Math.hypot(v1.x, v1.y)
  const n2 = Math.hypot(v2.x, v2.y)
  if (n1 < 1e-6 || n2 < 1e-6) return 0
  const cos = (v1.x * v2.x + v1.y * v2.y) / (n1 * n2)
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
}

function quadArea(q: Quad): number {
  // Shoelace over the ordered corners.
  const p = [q.tl, q.tr, q.br, q.bl]
  let sum = 0
  for (let i = 0; i < 4; i++) {
    const a = p[i]
    const b = p[(i + 1) % 4]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

/**
 * Canny thresholds derived from the image median.
 *
 * Fixed thresholds fail across the range of exposures a phone produces — a dim
 * photo yields no edges at all, a bright one yields a solid mess. Anchoring to
 * the median adapts automatically; the 0.66/1.33 multipliers are the widely
 * used defaults.
 */
function autoCannyThresholds(cv: CV, scope: MatScope, gray: Mat): [number, number] {
  const hist = scope.add(new cv.Mat())
  const matVec = scope.add(new cv.MatVector())
  matVec.push_back(gray)
  const mask = scope.add(new cv.Mat())

  cv.calcHist(matVec, [0], mask, hist, [256], [0, 256])

  const total = gray.rows * gray.cols
  let cumulative = 0
  let median = 128
  for (let i = 0; i < 256; i++) {
    cumulative += hist.floatAt(i, 0)
    if (cumulative >= total / 2) {
      median = i
      break
    }
  }

  return [Math.max(0, 0.66 * median), Math.min(255, 1.33 * median)]
}

/**
 * Find the document quad, in the coordinates of `rgba`.
 *
 * Returns `null` when no candidate passes every gate — which is the correct and
 * common outcome for a tightly cropped scan that is already flat.
 */
export function detectDocumentQuad(
  cv: CV,
  rgba: Mat,
  options: PerspectiveOptions,
): QuadCandidate | null {
  return using((scope) => {
    /* Work small. Quad finding needs shape, not detail, and a 720 px pass is
       roughly 5× faster than full resolution with no loss of accuracy. */
    const longest = Math.max(rgba.cols, rgba.rows)
    const scale = longest > options.workingSize ? options.workingSize / longest : 1

    const small = scope.add(new cv.Mat())
    if (scale < 1) {
      cv.resize(
        rgba,
        small,
        new cv.Size(Math.round(rgba.cols * scale), Math.round(rgba.rows * scale)),
        0,
        0,
        cv.INTER_AREA,
      )
    } else {
      rgba.copyTo(small)
    }

    const gray = scope.add(new cv.Mat())
    cv.cvtColor(small, gray, small.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY)

    // Blur before edges, or paper texture and print both register as contour.
    const blurred = scope.add(new cv.Mat())
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)

    const [lo, hi] = autoCannyThresholds(cv, scope, blurred)
    const edges = scope.add(new cv.Mat())
    cv.Canny(blurred, edges, lo, hi)

    // Close gaps where a specular highlight broke the ticket's edge.
    const kernel = scope.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)))
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel)

    const contours = scope.add(new cv.MatVector())
    const hierarchy = scope.add(new cv.Mat())
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    const imageArea = small.rows * small.cols
    const candidates: QuadCandidate[] = []

    // Rank by area and only examine the largest few — the ticket is the big
    // thing in frame, and approxPolyDP over hundreds of contours is wasteful.
    const byArea: Array<{ index: number; area: number }> = []
    for (let i = 0; i < contours.size(); i++) {
      byArea.push({ index: i, area: cv.contourArea(contours.get(i)) })
    }
    byArea.sort((a, b) => b.area - a.area)

    for (const { index, area } of byArea.slice(0, 12)) {
      if (area < imageArea * options.minAreaRatio) break // sorted — nothing later is bigger

      const contour = contours.get(index)
      const peri = cv.arcLength(contour, true)
      const approx = scope.add(new cv.Mat())
      cv.approxPolyDP(contour, approx, options.approxEpsilonRatio * peri, true)

      if (approx.rows !== 4) continue
      if (!cv.isContourConvex(approx)) continue

      const pts: Point[] = []
      for (let i = 0; i < 4; i++) {
        pts.push({ x: approx.intAt(i, 0), y: approx.intAt(i, 1) })
      }
      const quad = orderQuadCorners(pts)

      // Reject slivers: every edge must have real length.
      const edgeLengths = [
        dist(quad.tl, quad.tr),
        dist(quad.tr, quad.br),
        dist(quad.br, quad.bl),
        dist(quad.bl, quad.tl),
      ]
      if (Math.min(...edgeLengths) < Math.max(small.rows, small.cols) * 0.1) continue

      const angles = [
        cornerAngle(quad.bl, quad.tl, quad.tr),
        cornerAngle(quad.tl, quad.tr, quad.br),
        cornerAngle(quad.tr, quad.br, quad.bl),
        cornerAngle(quad.br, quad.bl, quad.tl),
      ]
      const maxAngleDeviation = Math.max(...angles.map((a) => Math.abs(a - 90)))
      if (maxAngleDeviation > options.maxCornerAngleDeviationDeg) continue

      const areaRatio = quadArea(quad) / imageArea

      // Prefer big and rectangular. The angle term is normalised against the
      // tolerance so the two contributions stay comparable.
      const score =
        areaRatio * 2 - (maxAngleDeviation / options.maxCornerAngleDeviationDeg) * 0.5

      // Is this quad actually distorted, or is the page already flat?
      const topBottom = relativeDifference(edgeLengths[0], edgeLengths[2])
      const leftRight = relativeDifference(edgeLengths[1], edgeLengths[3])
      const squareOn =
        maxAngleDeviation <= SQUARE_ON_ANGLE_DEG &&
        topBottom <= SQUARE_ON_SIDE_TOLERANCE &&
        leftRight <= SQUARE_ON_SIDE_TOLERANCE

      candidates.push({
        quad,
        areaRatio,
        maxAngleDeviation,
        score,
        worthWarping: !squareOn,
        skipReason: squareOn
          ? `the page is already square-on (corners within ${maxAngleDeviation.toFixed(1)}° of ` +
            `90°, opposite sides match within ${(Math.max(topBottom, leftRight) * 100).toFixed(1)}%)`
          : undefined,
      })
    }

    if (candidates.length === 0) return null

    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]

    // Scale back to the caller's coordinate space.
    const unscale = (p: Point): Point => ({ x: p.x / scale, y: p.y / scale })
    return {
      ...best,
      quad: {
        tl: unscale(best.quad.tl),
        tr: unscale(best.quad.tr),
        br: unscale(best.quad.br),
        bl: unscale(best.quad.bl),
      },
    }
  })
}

/**
 * Warp `src` so that `quad` becomes the full frame.
 *
 * The output size comes from the longest opposing edges, which preserves the
 * scale of the least-foreshortened part of the ticket rather than averaging the
 * distortion across it.
 *
 * The result is registered on `scope`.
 */
export function warpToQuad(cv: CV, scope: MatScope, src: Mat, quad: Quad): Mat {
  const width = Math.round(Math.max(dist(quad.tl, quad.tr), dist(quad.bl, quad.br)))
  const height = Math.round(Math.max(dist(quad.tl, quad.bl), dist(quad.tr, quad.br)))

  if (width < 8 || height < 8) {
    throw new Error(`warpToQuad: degenerate target size ${width}×${height}`)
  }

  // Sanity-check the implied output against the source. A quad that produces a
  // wildly different area was almost certainly fitted to the wrong contour, and
  // warping onto it would silently crop numbers out of the frame.
  const sourceArea = src.cols * src.rows
  const outputScale = sourceArea > 0 ? (width * height) / sourceArea : 1
  if (outputScale < MIN_OUTPUT_SCALE || outputScale > MAX_OUTPUT_SCALE) {
    throw new Error(
      `warpToQuad: the detected quad implies an output ${outputScale.toFixed(2)}× the source ` +
        `area, outside the plausible range [${MIN_OUTPUT_SCALE}, ${MAX_OUTPUT_SCALE}] — ` +
        'treating it as a mis-detection rather than warping onto it',
    )
  }

  const srcPts = scope.add(
    cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad.tl.x, quad.tl.y,
      quad.tr.x, quad.tr.y,
      quad.br.x, quad.br.y,
      quad.bl.x, quad.bl.y,
    ]),
  )
  const dstPts = scope.add(
    cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      width - 1, 0,
      width - 1, height - 1,
      0, height - 1,
    ]),
  )

  const transform = scope.add(cv.getPerspectiveTransform(srcPts, dstPts))
  const out = scope.add(new cv.Mat())

  cv.warpPerspective(
    src,
    out,
    transform,
    new cv.Size(width, height),
    cv.INTER_LINEAR,
    // Replicate rather than a constant fill: a black border would be read as a
    // very dark "stroke" by the ink threshold and hunted as text.
    cv.BORDER_REPLICATE,
    new cv.Scalar(),
  )

  return out
}
