/**
 * Connected-component text detection, without a neural network.
 *
 * This is the fallback for when the ONNX detector cannot be loaded — a blocked
 * CDN, a corporate proxy, an offline device. It is not a general text detector
 * and would do poorly on a photograph of a street sign, but on the specific
 * problem here it is well suited: a clean binary mask of isolated printed digits
 * on a flat page, which is precisely what the watermark stage hands us.
 *
 * Method: take every connected component, keep the ones shaped like a glyph,
 * then merge glyphs that sit on the same baseline and close enough together to
 * be one number. Both thresholds are derived from the *median glyph height* of
 * this particular image rather than fixed pixel counts, so it adapts to
 * resolution and font size automatically.
 */

import type { CV } from './loader'
import { using } from './scope'
import type { DetectedBox, Box, Point } from '../types'

type Mat = InstanceType<CV['Mat']>

export interface FallbackDetectOptions {
  /** Ignore components shorter than this fraction of the page height. */
  minHeightRatio: number
  /** Ignore components taller than this fraction of the page height. */
  maxHeightRatio: number
  /** Keep components whose height is within this factor of the median. */
  heightTolerance: number
  /** Merge glyphs separated by less than this multiple of the median height. */
  gapRatio: number
  /** Two glyphs share a line when they overlap vertically by this much. */
  overlapRatio: number
  /** Hard cap on components examined, as a runaway guard on a noisy mask. */
  maxComponents: number
}

export const DEFAULT_FALLBACK_OPTIONS: FallbackDetectOptions = {
  minHeightRatio: 0.008,
  maxHeightRatio: 0.12,
  heightTolerance: 2.2,
  gapRatio: 0.55,
  overlapRatio: 0.45,
  maxComponents: 6000,
}

interface Glyph {
  x: number
  y: number
  width: number
  height: number
  area: number
}

/**
 * Detect number-shaped boxes in a binary ink mask.
 *
 * `mask` has strokes as 255 on a 0 background. Returned boxes are in mask
 * coordinates.
 */
export function detectTextBoxesClassical(
  cv: CV,
  mask: Mat,
  options: FallbackDetectOptions = DEFAULT_FALLBACK_OPTIONS,
): DetectedBox[] {
  const glyphs = extractGlyphs(cv, mask, options)
  if (glyphs.length === 0) return []

  const medianHeight = median(glyphs.map((g) => g.height))
  if (medianHeight <= 0) return []

  // Drop outliers now that we know the typical glyph size. A page number, a
  // barcode or a logo fragment will be well outside this band.
  const kept = glyphs.filter(
    (g) =>
      g.height <= medianHeight * options.heightTolerance &&
      g.height >= medianHeight / options.heightTolerance,
  )
  if (kept.length === 0) return []

  const groups = mergeIntoNumbers(kept, medianHeight, options)

  return groups.map((box, id) => ({
    id,
    box,
    polygon: boxToPolygon(box),
    angle: 0,
    // No probability map to draw a real score from. A flat, honestly-mediocre
    // value keeps this path from outranking the neural detector in any
    // comparison, and the recogniser's own score still gates the output.
    score: 0.6,
  }))
}

function extractGlyphs(cv: CV, mask: Mat, options: FallbackDetectOptions): Glyph[] {
  return using((scope) => {
    const labels = scope.add(new cv.Mat())
    const stats = scope.add(new cv.Mat())
    const centroids = scope.add(new cv.Mat())

    const count = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8, cv.CV_32S)

    const pageHeight = mask.rows
    const minHeight = Math.max(4, pageHeight * options.minHeightRatio)
    const maxHeight = pageHeight * options.maxHeightRatio

    const glyphs: Glyph[] = []
    const limit = Math.min(count, options.maxComponents + 1)

    for (let i = 1; i < limit; i++) {
      const x = stats.intAt(i, cv.CC_STAT_LEFT)
      const y = stats.intAt(i, cv.CC_STAT_TOP)
      const width = stats.intAt(i, cv.CC_STAT_WIDTH)
      const height = stats.intAt(i, cv.CC_STAT_HEIGHT)
      const area = stats.intAt(i, cv.CC_STAT_AREA)

      if (height < minHeight || height > maxHeight) continue
      if (width < 2) continue

      // Digits are taller than wide, but never extremely so. This rejects the
      // long thin runs left by a ruling line or a scan streak.
      const aspect = width / height
      if (aspect > 2.5 || aspect < 0.05) continue

      // A glyph fills a reasonable share of its bounding box. A hollow outline
      // or a sparse dotted artefact does not.
      const fill = area / (width * height)
      if (fill < 0.12 || fill > 0.97) continue

      glyphs.push({ x, y, width, height, area })
    }

    return glyphs
  })
}

/**
 * Merge glyphs that belong to the same printed number.
 *
 * Sorts by baseline then by x, and walks left to right joining glyphs that share
 * a line and sit within `gapRatio × medianHeight` of each other. That gap is the
 * whole heuristic: inside "12" the two digits nearly touch, while the next
 * number along is a word-space away.
 */
function mergeIntoNumbers(
  glyphs: readonly Glyph[],
  medianHeight: number,
  options: FallbackDetectOptions,
): Box[] {
  const maxGap = medianHeight * options.gapRatio

  // Group into lines first, so a glyph cannot merge with one on the row below
  // that happens to be horizontally adjacent.
  const sorted = [...glyphs].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: Glyph[][] = []

  for (const glyph of sorted) {
    const line = lines.find((l) => sharesLine(l, glyph, options.overlapRatio))
    if (line) line.push(glyph)
    else lines.push([glyph])
  }

  const boxes: Box[] = []

  for (const line of lines) {
    line.sort((a, b) => a.x - b.x)

    let current: Glyph[] = []
    const flush = () => {
      if (current.length === 0) return
      boxes.push(boundingBox(current))
      current = []
    }

    for (const glyph of line) {
      if (current.length === 0) {
        current.push(glyph)
        continue
      }
      const prev = current[current.length - 1]
      const gap = glyph.x - (prev.x + prev.width)
      if (gap <= maxGap) current.push(glyph)
      else {
        flush()
        current.push(glyph)
      }
    }
    flush()
  }

  return boxes
}

function sharesLine(line: readonly Glyph[], glyph: Glyph, overlapRatio: number): boolean {
  const top = Math.min(...line.map((g) => g.y))
  const bottom = Math.max(...line.map((g) => g.y + g.height))
  const overlap = Math.min(bottom, glyph.y + glyph.height) - Math.max(top, glyph.y)
  if (overlap <= 0) return false
  const shorter = Math.min(bottom - top, glyph.height)
  return shorter > 0 && overlap / shorter >= overlapRatio
}

function boundingBox(glyphs: readonly Glyph[]): Box {
  const x = Math.min(...glyphs.map((g) => g.x))
  const y = Math.min(...glyphs.map((g) => g.y))
  const right = Math.max(...glyphs.map((g) => g.x + g.width))
  const bottom = Math.max(...glyphs.map((g) => g.y + g.height))
  return { x, y, width: right - x, height: bottom - y }
}

export function boxToPolygon(box: Box): [Point, Point, Point, Point] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ]
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
