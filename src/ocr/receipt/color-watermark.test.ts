import { describe, expect, it } from 'vitest'

import { isWatermarkWord, suppressColoredWatermark } from './color-watermark'

function pixel(data: Uint8ClampedArray, index: number): [number, number, number] {
  return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0]
}

describe('suppressColoredWatermark', () => {
  it('whitens a light red stamp and keeps dark neutral ink', () => {
    const data = new Uint8ClampedArray([
      250, 130, 130, 255,
      255, 255, 255, 255,
      40, 40, 40, 255,
    ])
    const cleaned = suppressColoredWatermark(3, 1, data)
    expect(pixel(cleaned.data, 0)).toEqual([255, 255, 255])
    expect(pixel(cleaned.data, 8)).toEqual([40, 40, 40])
    expect(cleaned.ratio).toBeGreaterThan(0)
  })

  it('turns ink under the stamp into a dark stroke and leaves the ink beside it', () => {
    const data = new Uint8ClampedArray([
      250, 130, 130, 255,
      180, 40, 40, 255,
      30, 30, 30, 255,
    ])
    const cleaned = suppressColoredWatermark(3, 1, data)
    expect(pixel(cleaned.data, 0)).toEqual([255, 255, 255])
    const stroke = pixel(cleaned.data, 4)
    expect(stroke[0]).toBe(stroke[1])
    expect(stroke[1]).toBe(stroke[2])
    expect(stroke[0]).toBeLessThan(80)
    expect(pixel(cleaned.data, 8)).toEqual([30, 30, 30])
  })

  it('whitens a tall red bar and keeps a short red stroke', () => {
    const width = 3
    const height = 80
    const data = new Uint8ClampedArray(width * height * 4)
    data.fill(255)
    for (let y = 0; y < height; y += 1) {
      const offset = (y * width + 2) * 4
      data[offset] = 170
      data[offset + 1] = 70
      data[offset + 2] = 70
    }
    for (let y = 0; y < 8; y += 1) {
      const offset = (y * width) * 4
      data[offset] = 180
      data[offset + 1] = 70
      data[offset + 2] = 70
    }
    const cleaned = suppressColoredWatermark(width, height, data)
    expect(pixel(cleaned.data, (40 * width + 2) * 4)).toEqual([255, 255, 255])
    const letter = pixel(cleaned.data, 0)
    expect(letter[0]).toBeLessThan(255)
    const crossed = (20 * width + 2) * 4
    data[crossed] = 160
    data[crossed + 1] = 30
    data[crossed + 2] = 30
    const kept = suppressColoredWatermark(width, height, data)
    const stroke = pixel(kept.data, crossed)
    expect(stroke[0]).toBeLessThan(80)
  })

  it('does not punch a hole through ink that sits beside the stamp', () => {
    const data = new Uint8ClampedArray([
      250, 130, 130, 255,
      30, 30, 30, 255,
    ])
    const cleaned = suppressColoredWatermark(2, 1, data)
    expect(pixel(cleaned.data, 4)).toEqual([30, 30, 30])
  })

  it('keeps a reddish letter that is darker than the stamp', () => {
    const data = new Uint8ClampedArray([
      180, 100, 100, 255,
      255, 255, 255, 255,
    ])
    const cleaned = suppressColoredWatermark(2, 1, data)
    const letter = pixel(cleaned.data, 0)
    expect(letter[0]).toBe(letter[1])
    expect(letter[1]).toBe(letter[2])
    expect(letter[0]).toBeGreaterThan(48)
    expect(letter[0]).toBeLessThan(255)
  })

  it('whitens the pink edge attached to the stamp', () => {
    const data = new Uint8ClampedArray([
      250, 130, 130, 255,
      210, 160, 155, 255,
    ])
    const cleaned = suppressColoredWatermark(2, 1, data)
    expect(pixel(cleaned.data, 0)).toEqual([255, 255, 255])
    expect(pixel(cleaned.data, 4)).toEqual([255, 255, 255])
  })
})

describe('isWatermarkWord', () => {
  it('flags a box that is only the coloured stamp', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 250
      data[i + 1] = 130
      data[i + 2] = 130
      data[i + 3] = 255
    }
    expect(
      isWatermarkWord(4, data, { text: 'overlay', x: 0, y: 0, width: 4, height: 4, confidence: 0.4 }),
    ).toBe(true)
  })

  it('keeps a box of dark print', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 20
      data[i + 1] = 20
      data[i + 2] = 20
      data[i + 3] = 255
    }
    expect(
      isWatermarkWord(4, data, { text: '336.00', x: 0, y: 0, width: 4, height: 4, confidence: 0.9 }),
    ).toBe(false)
  })

  it('keeps an amount the stamp covers completely', () => {
    // The case that silently deleted rows: every pixel of the box is stamped,
    // so there is no bare-paper print anywhere in it. The strokes are only
    // visible as stamp-over-ink, which used to count as neither colour nor ink.
    const size = 8
    const data = stamped(size, size, (x) => (x === 3 || x === 4 ? INK : PAPER))
    expect(
      isWatermarkWord(size, data, {
        text: '336.00',
        x: 0,
        y: 0,
        width: size,
        height: size,
        confidence: 0.86,
      }),
    ).toBe(false)
  })

  it('still flags the stamp glyph itself, which has no print under it', () => {
    // The overlay's own letterform: stamped where the glyph is, bare paper
    // elsewhere, and nothing dark anywhere.
    const size = 8
    const data = new Uint8ClampedArray(size * size * 4)
    data.fill(255)
    for (let y = 0; y < size; y += 1) {
      for (let x = 2; x < 6; x += 1) {
        const offset = (y * size + x) * 4
        data[offset] = STAMP_ON_PAPER[0]
        data[offset + 1] = STAMP_ON_PAPER[1]
        data[offset + 2] = STAMP_ON_PAPER[2]
      }
    }
    expect(
      isWatermarkWord(size, data, {
        text: 'VOID',
        x: 0,
        y: 0,
        width: size,
        height: size,
        confidence: 0.31,
      }),
    ).toBe(true)
  })
})

/*
 * Sampled off `public/samples/weekly-invoice.jpg` rather than modelled, because
 * a modelled blend gets the chroma badly wrong: compositing a 38%-alpha stamp
 * over pure black predicts a strongly red (93, 22, 27), while the real stamp
 * over the real `SYSTEM FEE` print measures (73, 35, 32) — much closer to
 * neutral, since a translucent stamp over thick ink is still mostly ink.
 */

/** The stamp over bare paper. */
const STAMP_ON_PAPER: readonly [number, number, number] = [240, 170, 174]
/** The stamp over print — the darkest decile of the `SYSTEM` word box. */
const STAMP_ON_INK: readonly [number, number, number] = [73, 35, 32]
const PAPER = 0
const INK = 1

/** Fill a box with stamp-over-paper, except where `column` asks for ink. */
function stamped(
  width: number,
  height: number,
  column: (x: number) => number,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = column(x) === INK ? STAMP_ON_INK : STAMP_ON_PAPER
      const offset = (y * width + x) * 4
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
      data[offset + 3] = 255
    }
  }
  return data
}
