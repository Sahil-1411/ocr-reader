/**
 * Lift a coloured overlay off a photo without a word list.
 *
 * Printed ink is dark in every channel. A red stamp is dark only because of
 * its red channel, so the green and blue channels still show the page: light
 * where the stamp sits on paper, dark where it sits on a letter. A tall run
 * of that red is a side bar, and it is painted out. Everything else is the
 * picture that was under the colour.
 */

import type { WordBox } from '../layout/rows'

/** Green/blue at or above this is paper, including a light red stamp on paper. */
const PAPER = 128
const RED_CHROMA = 45
/** A red run this tall, relative to the page, is a bar rather than a letter. */
const BAR_RUN = 0.03
const BAR_RUN_MIN = 36
/**
 * Print seen *through* the overlay is dark in the channels the overlay leaves
 * alone. A red stamp lifts red only, so `min(green, blue)` still carries the
 * page, and a stroke under the stamp keeps it dark.
 */
const UNDERPRINT = 90

/** A box with more of its samples than this on the overlay is a candidate to drop. */
const STAMP_SHARE = 0.25

/**
 * …but only if it carries less ink than this, because a box with print in it is
 * a word whatever is stamped across it.
 *
 * The margin here is wider than it looks. On the settlements receipt the two
 * genuine overlay blobs sample at exactly 0.000 ink, while the settled date the
 * overlay had landed on — `02/26/26`, read as `02126126` once the slashes went —
 * samples at 0.061. At the old cut of 0.08 that date was discarded and took the
 * whole `833-129990` row with it; anywhere between them keeps the row and still
 * drops the blobs.
 */
const INK_SHARE = 0.04

/**
 * How far red may run ahead of `min(green, blue)` before the stroke is the
 * overlay's own glyph rather than print underneath it.
 *
 * Darkness alone cannot make this call — measured over the sample receipts, the
 * overlay's own strokes and the printed text overlap almost completely on
 * `min(green, blue)` (medians 73–77 against a real-text p90 of 61–75). How far
 * red runs ahead separates them far better: aggregated per word box, the
 * overlay's strokes sit at a median of 68–71 and printed text at 3–4.
 *
 * The cut is nowhere near that per-box median, though, because the per-pixel
 * spread is much wider than the aggregate. Under the dense centre of a stamp,
 * individual strokes of real print run well past 50 — cutting there drops
 * `INSTANT NET DUE` from the weekly invoice, the row sitting under the logo.
 * So the threshold is set where real print stops being excluded, which leaves it
 * rejecting only the stamp's saturated core.
 *
 * The margin watermark is deliberately NOT this function's problem. Its strokes
 * are too dark to pass `isStampCore`, so a box of them is never flagged here
 * whatever this returns; `dropLeadingStrays` in `../layout/rows` strips them
 * positionally instead. Tightening this to catch them costs real rows.
 */
const OVERLAY_DOMINANCE = 80

export interface SuppressedRaster {
  data: Uint8ClampedArray
  /** Fraction of pixels painted out, in [0, 1]. */
  ratio: number
}

export function suppressColoredWatermark(
  width: number,
  height: number,
  source: Uint8ClampedArray,
): SuppressedRaster {
  const data = new Uint8ClampedArray(source)
  const count = width * height
  const red = new Uint8Array(count)
  for (let pixel = 0; pixel < count; pixel += 1) {
    const [r, g, b] = channels(data, pixel)
    if (isRedPixel(r, g, b)) red[pixel] = 1
  }
  const runs = verticalRuns(red, width, height, source)
  const barRun = Math.max(BAR_RUN_MIN, Math.round(height * BAR_RUN))

  let removed = 0
  for (let pixel = 0; pixel < count; pixel += 1) {
    if (!red[pixel]) continue
    const [, green, blue] = channels(source, pixel)
    const stroke = Math.min(green, blue)
    const run = runs[pixel]
    // A long red run is a bar or a stamp blob. A pixel much darker than the
    // rest of that run is the letter the colour crosses, so it stays.
    const erase = run !== undefined && run.length >= barRun && stroke >= run.median - 20
    const level = erase || stroke >= PAPER ? 255 : inkLevel(stroke)
    const offset = pixel * 4
    data[offset] = level
    data[offset + 1] = level
    data[offset + 2] = level
    if (level === 255) removed += 1
  }

  return { data, ratio: count === 0 ? 0 : removed / count }
}

/**
 * A word whose box is coloured overlay and not dark print. The decision uses
 * the original pixels, so a fragment that survived cleaning is still dropped.
 */
export function isWatermarkWord(
  width: number,
  source: Uint8ClampedArray,
  word: WordBox,
): boolean {
  const x0 = Math.max(0, Math.floor(word.x))
  const y0 = Math.max(0, Math.floor(word.y))
  const x1 = Math.min(width, Math.ceil(word.x + word.width))
  const height = Math.floor(source.length / 4 / width)
  const y1 = Math.min(height, Math.ceil(word.y + word.height))
  let samples = 0
  let colorful = 0
  let ink = 0
  const stepX = Math.max(1, Math.floor((x1 - x0) / 8))
  const stepY = Math.max(1, Math.floor((y1 - y0) / 8))
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const offset = (y * width + x) * 4
      const red = source[offset] ?? 0
      const green = source[offset + 1] ?? 0
      const blue = source[offset + 2] ?? 0
      samples += 1
      if (isStampCore(red, green, blue)) colorful += 1
      else if (isInkPixel(red, green, blue)) ink += 1
    }
  }
  if (samples === 0) return false
  return colorful / samples > STAMP_SHARE && ink / samples < INK_SHARE
}

interface RedRun {
  length: number
  median: number
}

function verticalRuns(
  red: Uint8Array,
  width: number,
  height: number,
  source: Uint8ClampedArray,
): Array<RedRun | undefined> {
  const runs: Array<RedRun | undefined> = new Array(width * height)
  for (let x = 0; x < width; x += 1) {
    let y = 0
    while (y < height) {
      if (!red[y * width + x]) {
        y += 1
        continue
      }
      let end = y + 1
      while (end < height && red[end * width + x]) end += 1
      const strokes: number[] = []
      for (let row = y; row < end; row += 1) {
        const offset = (row * width + x) * 4
        strokes.push(Math.min(source[offset + 1] ?? 0, source[offset + 2] ?? 0))
      }
      const run = { length: end - y, median: median(strokes) }
      for (let row = y; row < end; row += 1) runs[row * width + x] = run
      y = end
    }
  }
  return runs
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function channels(data: Uint8ClampedArray, pixel: number): [number, number, number] {
  const offset = pixel * 4
  return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0]
}

function isRedPixel(red: number, green: number, blue: number): boolean {
  return red > green && red > blue && chroma(red, green, blue) >= RED_CHROMA
}

/** Light red body. Used only to decide that a recognised word is the overlay. */
function isStampCore(red: number, green: number, blue: number): boolean {
  return isRedPixel(red, green, blue) && luminance(red, green, blue) >= 145 && chroma(red, green, blue) >= 70
}

/**
 * A stroke, whether the overlay covers it or not.
 *
 * The neutral-dark test alone has a blind spot that costs whole rows. Where the
 * stamp crosses print, the blend keeps the ink's darkness but picks up enough of
 * the stamp's red to clear `chroma < 40` — measured across the sample receipts,
 * the top few percent of real words land at 43–56. Those pixels counted as
 * neither stamp (too dark) nor ink (too colourful), so a word the stamp covered
 * sampled as mostly-stamp and no-ink and `isWatermarkWord` discarded it, even
 * though the reader had already read it correctly off the cleaned raster. The
 * row it anchored went with it.
 *
 * So ink is also a stroke that is dark in the channels the overlay leaves alone
 * — provided red is not running so far ahead that the stroke is the overlay.
 */
function isInkPixel(red: number, green: number, blue: number): boolean {
  if (luminance(red, green, blue) < 115 && chroma(red, green, blue) < 40) return true
  const underprint = Math.min(green, blue)
  return underprint < UNDERPRINT && red - underprint < OVERLAY_DOMINANCE
}

/**
 * Push mid-grey overlay toward paper and leave a dark stroke dark.
 *
 * The exponent is tempting to raise: cubing preserves more of a covered stroke,
 * and on its own that reads like a strict improvement. Scored against the 45
 * rows of `public/samples/weekly-invoice.jpg` it is not — cubing recovers 36,
 * `t^2.5` 37, and this square ramp 38. Darkening the covered strokes also
 * darkens the watermark's own, and past a point the reader starts preferring
 * the overlay: `Sales Comm` degrades to `_——` and `40.00C` to `40,00C`. Re-run
 * that score before touching this.
 */
function inkLevel(stroke: number): number {
  if (stroke <= 48) return stroke
  const t = (stroke - 48) / (PAPER - 48)
  return Math.round(48 + t * t * (255 - 48))
}

function chroma(red: number, green: number, blue: number): number {
  return Math.max(red, green, blue) - Math.min(red, green, blue)
}

function luminance(red: number, green: number, blue: number): number {
  return 0.299 * red + 0.587 * green + 0.114 * blue
}
