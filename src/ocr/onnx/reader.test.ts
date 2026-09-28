import { describe, expect, it } from 'vitest'

import { splitLineIntoWords } from './reader'
import type { DetectedBox } from '../types'

function box(x: number, y: number, width: number, height: number): DetectedBox {
  return {
    id: 1,
    box: { x, y, width, height },
    polygon: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    angle: 0,
    score: 0.9,
  }
}

describe('splitLineIntoWords', () => {
  it('splits a recognised line and spaces the words across the box', () => {
    // "SYSTEM FEE 5.00" — 15 characters over 300px, so 20px per character.
    const words = splitLineIntoWords(box(100, 50, 300, 14), 'SYSTEM FEE 5.00', 0.93)

    expect(words.map((w) => w.text)).toEqual(['SYSTEM', 'FEE', '5.00'])
    expect(words.map((w) => Math.round(w.x))).toEqual([100, 240, 320])
    expect(words.map((w) => Math.round(w.width))).toEqual([120, 60, 80])
    expect(words.every((w) => w.y === 50 && w.height === 14)).toBe(true)
    expect(words.every((w) => w.confidence === 0.93)).toBe(true)
  })

  it('keeps the amount in the right half, which is what anchors an invoice row', () => {
    // The whole point of splitting: invoiceRowsFromWords only treats a value as
    // an anchor when it sits past the middle of the page.
    const words = splitLineIntoWords(box(0, 0, 500, 12), 'SYSTEM FEE 5.00', 0.9)
    const amount = words.find((w) => w.text === '5.00')
    expect(amount).toBeDefined()
    expect(amount!.x).toBeGreaterThan(250)
  })

  it('returns nothing for a line the recogniser emptied', () => {
    expect(splitLineIntoWords(box(0, 0, 100, 10), '   ', 0.4)).toEqual([])
    expect(splitLineIntoWords(box(0, 0, 100, 10), '', 0.4)).toEqual([])
  })

  it('handles a single-token line', () => {
    const words = splitLineIntoWords(box(10, 20, 80, 12), 'TOTALS', 0.88)
    expect(words).toHaveLength(1)
    expect(words[0]).toMatchObject({ text: 'TOTALS', x: 10, y: 20, width: 80, height: 12 })
  })

  it('collapses runs of whitespace without shifting the following words', () => {
    // The recogniser sometimes emits a double space where the print has a wide
    // column gap; the tokens after it must still land past that gap.
    const words = splitLineIntoWords(box(0, 0, 220, 10), 'A       B', 0.9)
    expect(words.map((w) => w.text)).toEqual(['A', 'B'])
    expect(Math.round(words[1]!.x)).toBe(196)
  })

  it('ignores a degenerate box rather than emitting zero-width words', () => {
    expect(splitLineIntoWords(box(0, 0, 0, 10), 'TEXT', 0.9)).toEqual([])
    expect(splitLineIntoWords(box(0, 0, 100, 0), 'TEXT', 0.9)).toEqual([])
  })
})
