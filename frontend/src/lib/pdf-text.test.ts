import { describe, expect, it } from 'vitest'

import { placeTextRun, textItemsToWords, textLayerIsUsable } from './pdf-text'

describe('placeTextRun', () => {
  it('maps a PDF baseline into viewport pixels', () => {
    const scale = 2
    const pageHeight = 792
    const viewport = [scale, 0, 0, -scale, 0, pageHeight * scale]
    const placed = placeTextRun(
      { str: 'Hello', transform: [12, 0, 0, 12, 72, 700], width: 36, height: 12 },
      viewport,
    )
    expect(placed).toMatchObject({ str: 'Hello', x: 144, y: 160, width: 72, height: 24 })
  })

  it('drops rotated watermark text', () => {
    const viewport = [2, 0, 0, -2, 0, 1584]
    const placed = placeTextRun(
      { str: 'COPY', transform: [0, 12, -12, 0, 100, 400], width: 40, height: 12 },
      viewport,
    )
    expect(placed).toBeNull()
  })
})

describe('textItemsToWords', () => {
  it('joins glyphs of one word and keeps a real space', () => {
    const viewport = [1, 0, 0, -1, 0, 100]
    const glyph = (str: string, x: number) => ({
      str,
      transform: [10, 0, 0, 10, x, 80] as number[],
      width: 6,
      height: 10,
    })
    const words = textItemsToWords(
      [glyph('8', 10), glyph('4', 16), glyph('9', 22), glyph('CASE', 40), glyph('QTY', 80)],
      viewport,
    )
    expect(words.map((word) => word.text)).toEqual(['849', 'CASE', 'QTY'])
  })

  it('reads a row the PDF draws twice once', () => {
    // Some invoices set a shaded row's text a second time in the same place.
    // Both copies are the same ink, so the reading is the row, not each word
    // doubled: `DETOX CHAMP`, never `DETOXDETOX CHAMPCHAMP`.
    const viewport = [1, 0, 0, -1, 0, 200]
    const run = (str: string, x: number, width: number) => ({
      str,
      transform: [12, 0, 0, 12, x, 150] as number[],
      width,
      height: 12,
    })
    const words = textItemsToWords(
      [
        run('DETOX CHAMP', 20, 80),
        run('DETOX CHAMP', 20, 80),
        run('47.88', 160, 36),
        run('47.88', 160, 36),
      ],
      viewport,
    )
    expect(words.map((word) => word.text)).toEqual(['DETOX', 'CHAMP', '47.88'])
  })

  it('keeps a word the page really does print twice over', () => {
    // `11` is two glyphs side by side, not one glyph printed twice.
    const viewport = [1, 0, 0, -1, 0, 200]
    const glyph = (str: string, x: number) => ({
      str,
      transform: [10, 0, 0, 10, x, 150] as number[],
      width: 6,
      height: 10,
    })
    const words = textItemsToWords([glyph('1', 20), glyph('1', 26)], viewport)
    expect(words.map((word) => word.text)).toEqual(['11'])
  })

  it('splits a run on spaces without gluing the words back together', () => {
    const viewport = [1, 0, 0, -1, 0, 200]
    const words = textItemsToWords(
      [{ str: 'CASE QTY', transform: [12, 0, 0, 12, 20, 150], width: 70, height: 12 }],
      viewport,
    )
    expect(words.map((word) => word.text)).toEqual(['CASE', 'QTY'])
    expect((words[1]?.x ?? 0) > (words[0]?.x ?? 0) + (words[0]?.width ?? 0)).toBe(true)
  })
})

describe('textLayerIsUsable', () => {
  it('accepts a page of real words and rejects a stub', () => {
    const word = (text: string, x: number) => ({ text, x, y: 0, width: 40, height: 10, confidence: 1 })
    const page = ['INVOICE', '849-1706888', 'WIDGET', 'NAME', '012345678905', '48.00', 'CASE', 'QTY'].map(
      (text, index) => word(text, index * 50),
    )
    expect(textLayerIsUsable(page)).toBe(true)
    expect(textLayerIsUsable([word('x', 0)])).toBe(false)
  })
})
