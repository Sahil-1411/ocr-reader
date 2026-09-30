/**
 * Turn a PDF text layer into word boxes in the same pixel space as the
 * rendered page.
 *
 * Born-digital invoices already know their own text. Rasterising the page and
 * OCR-ing it scrambles dense columns (item numbers, UPCs, prices). When the
 * file has a real text layer, those positioned strings are the reading.
 */

import type { WordBox } from '../ocr/layout/rows'
import { groupIntoLines } from '../ocr/layout/rows'

export interface PdfTextRun {
  str: string
  /** PDF text matrix: [a, b, c, d, e, f]. */
  transform: readonly number[]
  /** Advance width in PDF user space (not viewport pixels). */
  width: number
  height: number
}

/**
 * Enough real characters that the page is a digital document rather than a
 * scan with an empty or token text layer.
 */
export function textLayerIsUsable(words: readonly WordBox[]): boolean {
  let chars = 0
  for (const word of words) chars += word.text.match(/[A-Za-z0-9]/g)?.length ?? 0
  return words.length >= 8 && chars >= 40
}

export function textItemsToWords(
  items: readonly PdfTextRun[],
  viewportTransform: readonly number[],
): WordBox[] {
  const placed: WordBox[] = []
  // Which run each word was cut from. Words of one run were apart by a space
  // in the PDF's own text, and are never glyphs of one word.
  const runOf = new Map<WordBox, number>()
  items.forEach((item, index) => {
    const box = placeTextRun(item, viewportTransform)
    if (!box) return
    for (const word of splitRun(box)) {
      runOf.set(word, index)
      placed.push(word)
    }
  })
  return mergeGlyphs(placed, runOf)
}

/**
 * Map one PDF text run into viewport pixels.
 *
 * Rotated runs (a diagonal watermark, vertical margin text) are left out so
 * they are not read as table cells.
 */
export function placeTextRun(
  item: PdfTextRun,
  viewportTransform: readonly number[],
): { str: string; x: number; y: number; width: number; height: number } | null {
  const str = item.str.replace(/\s+/g, (spaces) => (spaces.length > 1 ? '  ' : ' '))
  if (!str.trim()) return null
  if (item.transform.length < 6 || viewportTransform.length < 6) return null

  const tx = multiply(viewportTransform, item.transform)
  const angle = Math.atan2(tx[1] ?? 0, tx[0] ?? 0)
  if (Math.abs(angle) > 0.35) return null

  const fontHeight = Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || Math.abs(item.height) || 10
  const scale = Math.hypot(viewportTransform[0] ?? 0, viewportTransform[1] ?? 0) || 1
  const x = tx[4] ?? 0
  const y = (tx[5] ?? 0) - fontHeight
  const measured = Math.abs(item.width) * scale
  const width = measured > 0.5 ? measured : Math.max(fontHeight * 0.45, str.trim().length * fontHeight * 0.5)
  return { str, x, y, width, height: Math.max(fontHeight, 1) }
}

/** pdf.js `Util.transform(viewport, textMatrix)`. */
function multiply(m1: readonly number[], m2: readonly number[]): number[] {
  return [
    (m1[0] ?? 0) * (m2[0] ?? 0) + (m1[2] ?? 0) * (m2[1] ?? 0),
    (m1[1] ?? 0) * (m2[0] ?? 0) + (m1[3] ?? 0) * (m2[1] ?? 0),
    (m1[0] ?? 0) * (m2[2] ?? 0) + (m1[2] ?? 0) * (m2[3] ?? 0),
    (m1[1] ?? 0) * (m2[2] ?? 0) + (m1[3] ?? 0) * (m2[3] ?? 0),
    (m1[0] ?? 0) * (m2[4] ?? 0) + (m1[2] ?? 0) * (m2[5] ?? 0) + (m1[4] ?? 0),
    (m1[1] ?? 0) * (m2[4] ?? 0) + (m1[3] ?? 0) * (m2[5] ?? 0) + (m1[5] ?? 0),
  ]
}

function splitRun(box: { str: string; x: number; y: number; width: number; height: number }): WordBox[] {
  const pieces = box.str.split(/(\s+)/)
  const words = pieces.filter((piece) => piece.trim().length > 0)
  if (words.length === 0) return []
  if (words.length === 1) {
    const text = words[0]?.trim() ?? ''
    if (!text) return []
    return [{ text, x: box.x, y: box.y, width: Math.max(box.width, 1), height: box.height, confidence: 1 }]
  }

  let weight = 0
  for (const piece of pieces) {
    weight += piece.trim().length > 0 ? piece.trim().length : piece.length * 0.45
  }
  const unit = weight > 0 ? box.width / weight : box.width
  const placed: WordBox[] = []
  let cursor = box.x
  for (const piece of pieces) {
    const text = piece.trim()
    if (!text) {
      cursor += piece.length * 0.45 * unit
      continue
    }
    const width = Math.max(1, text.length * unit)
    placed.push({ text, x: cursor, y: box.y, width, height: box.height, confidence: 1 })
    cursor += width
  }
  return placed
}

/**
 * PDFs often emit one glyph at a time. Join glyphs that sit on each other;
 * leave a real word space alone so columns stay apart.
 *
 * A run's spaces are the PDF's own, however narrow its font sets them: in
 * Times `yeast 2 lb` is a word, a space and a one-letter word, not `yeast2`.
 */
function mergeGlyphs(words: readonly WordBox[], runOf: ReadonlyMap<WordBox, number>): WordBox[] {
  if (words.length === 0) return []
  const merged: WordBox[] = []
  for (const line of groupIntoLines(words, 0.45)) {
    let current: WordBox | null = null
    let currentRun: number | undefined
    for (const word of line) {
      if (!current) {
        current = { ...word }
        currentRun = runOf.get(word)
        continue
      }
      const run = runOf.get(word)
      if (run !== undefined && run === currentRun) {
        merged.push(current)
        current = { ...word }
        currentRun = run
        continue
      }
      const gap = word.x - (current.x + current.width)
      const height = Math.max(current.height, word.height, 1)
      const centerDelta = Math.abs(
        current.y + current.height / 2 - (word.y + word.height / 2),
      )
      // A two-line header stacks "Qty" on "Case" with almost the same x.
      // Those are different words. Only glyphs of one word, on one baseline,
      // are joined. A trailing space that makes two columns touch is not a join.
      const sameBaseline = centerDelta <= height * 0.35
      const fragment = current.text.length <= 1 || word.text.length <= 1
      const shouldMerge =
        sameBaseline && (fragment ? gap <= height * 0.2 : gap < -height * 0.05)
      if (shouldMerge) {
        const top = Math.min(current.y, word.y)
        const bottom = Math.max(current.y + current.height, word.y + word.height)
        current = {
          text: current.text + word.text,
          x: current.x,
          y: top,
          width: Math.max(1, word.x + word.width - current.x),
          height: Math.max(1, bottom - top),
          confidence: Math.min(current.confidence, word.confidence),
        }
        currentRun = run
      } else {
        merged.push(current)
        current = { ...word }
        currentRun = run
      }
    }
    if (current) merged.push(current)
  }
  return merged
}
