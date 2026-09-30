import { describe, expect, it } from 'vitest'

import { dropOversizedBoxes, extractTable, groupWordsIntoLines } from './table'
import type { WordBox } from './rows'

const CHAR = 10
const LINE_HEIGHT = 14

/** A word laid out as if printed in a monospaced face. */
function word(text: string, column: number, row: number, extras: Partial<WordBox> = {}): WordBox {
  return {
    text,
    x: extras.x ?? column * CHAR,
    y: extras.y ?? row * (LINE_HEIGHT + 6),
    width: extras.width ?? text.length * CHAR,
    height: extras.height ?? LINE_HEIGHT,
    confidence: extras.confidence ?? 0.9,
  }
}

/** Lay a table out from text, one string per cell, columns at fixed offsets. */
function table(columnStarts: number[], rows: string[][]): WordBox[] {
  const words: WordBox[] = []
  rows.forEach((cells, rowIndex) => {
    cells.forEach((cell, columnIndex) => {
      if (!cell) return
      let offset = columnStarts[columnIndex] ?? 0
      for (const token of cell.split(' ')) {
        words.push(word(token, offset, rowIndex))
        offset += token.length + 1
      }
    })
  })
  return words
}

const cellsOf = (row: { cells: { text: string }[] }) => row.cells.map((cell) => cell.text)

describe('extractTable', () => {
  it('reads a table whose headers no vocabulary would recognise', () => {
    // The case the layout-specific reader cannot do: `Vendor / PO / Bin` matches
    // none of its known titles, so it finds no table at all and the page falls
    // through to a reader written for something else entirely.
    const words = table(
      [0, 20, 34],
      [
        ['Vendor', 'PO', 'Bin'],
        ['ACME SUPPLY', '44821', 'A12'],
        ['NORTHWIND LTD', '44822', 'B07'],
        ['GLOBEX CORP', '44823', 'C30'],
        ['INITECH', '44824', 'D02'],
      ],
    )

    const result = extractTable(words)
    expect(result).not.toBeNull()
    expect(result!.headers).toEqual(['Vendor', 'PO', 'Bin'])
    expect(result!.rows.map(cellsOf)).toEqual([
      ['ACME SUPPLY', '44821', 'A12'],
      ['NORTHWIND LTD', '44822', 'B07'],
      ['GLOBEX CORP', '44823', 'C30'],
      ['INITECH', '44824', 'D02'],
    ])
  })

  it('separates numeric columns set too tightly to leave a gap', () => {
    // The inventory sheet's count columns: the space before each is under one
    // character wide, so no clear channel exists. Alignment alone has to carry
    // them — every row starts a number at the same x.
    const words = table(
      [0, 6, 10, 14, 18],
      [
        ['Game', 'Name', 'Int', 'Rec', 'Act'],
        ['815', 'JACKPOT', '000', '002', '000'],
        ['824', 'FRENZY', '000', '002', '000'],
        ['831', 'CASH', '000', '002', '000'],
        ['838', 'MONEY', '000', '002', '000'],
        ['842', 'BUCKS', '000', '003', '000'],
      ],
    )

    const result = extractTable(words)
    expect(result).not.toBeNull()
    expect(result!.headers).toEqual(['Game', 'Name', 'Int', 'Rec', 'Act'])
    expect(result!.rows[0] && cellsOf(result!.rows[0])).toEqual([
      '815',
      'JACKPOT',
      '000',
      '002',
      '000',
    ])
  })

  it('keeps a multi-word column whole instead of splitting it', () => {
    // Names that repeat their shape align their second word across rows, which
    // looks exactly like a column boundary until you notice the two sides are
    // not both filled on the rows with shorter names.
    const words = table(
      [0, 6],
      [
        ['Game', 'Name'],
        ['851', 'X10 HIGH ROLLER'],
        ['852', 'X20 HIGH ROLLER'],
        ['853', 'X50 HIGH ROLLER'],
        ['854', 'WINNINGS'],
        ['855', 'JACKPOT'],
        ['856', 'BINGO'],
      ],
    )

    const result = extractTable(words)
    expect(result).not.toBeNull()
    expect(result!.bounds).toHaveLength(2)
    expect(result!.rows.map(cellsOf)).toContainEqual(['851', 'X10 HIGH ROLLER'])
    expect(result!.rows.map(cellsOf)).toContainEqual(['854', 'WINNINGS'])
  })

  it('returns rows with unnamed columns when no row looks like a header', () => {
    // A bare list of figures. Promoting its first row to a header would lose a
    // row of data and invent titles that were never printed.
    const words = table(
      [0, 20],
      [
        ['1001', '45.00'],
        ['1002', '12.50'],
        ['1003', '99.99'],
        ['1004', '10.00'],
      ],
    )

    const result = extractTable(words)
    expect(result).not.toBeNull()
    expect(result!.headers).toBeNull()
    expect(result!.rows).toHaveLength(4)
    expect(cellsOf(result!.rows[0]!)).toEqual(['1001', '45.00'])
  })

  it('loses no text when it imposes columns on prose', () => {
    // Geometry cannot reliably tell justified prose from a table: both are
    // words at repeating x positions, and this does read column boundaries into
    // a paragraph. What must not happen is text going missing — every word has
    // to land in some cell, so joining a row back together returns the line.
    // Telling the two apart needs the content, which is the next thing to add,
    // and until then reading a paragraph as a wide table is recoverable while
    // dropping half of it is not.
    const lines = [
      'Retailer accounts are settled weekly and any',
      'balance outstanding on the following Wednesday',
      'is carried forward to the next invoice period',
      'together with adjustments raised in that week',
      'unless the retailer has already been notified',
    ]
    const words = table([0], lines.map((line) => [line]))

    const result = extractTable(words)
    expect(result).not.toBeNull()

    // The first line is taken for a header, which is wrong but not lossy — it
    // is still returned, just under `headers` rather than in `rows`.
    const recovered = [
      ...(result!.headers ? [result!.headers.filter(Boolean).join(' ')] : []),
      ...result!.rows.map((row) => cellsOf(row).filter(Boolean).join(' ')),
    ]
    for (const line of lines) {
      expect(recovered).toContain(line)
    }
  })

  it('has nothing to say about a near-empty page', () => {
    expect(extractTable([word('Total', 0, 0)])).toBeNull()
    expect(extractTable([])).toBeNull()
  })
})

describe('dropOversizedBoxes', () => {
  it('drops a box far taller than the printed lines', () => {
    // Watermark text running down the margin: one box as tall as many rows. It
    // overlaps every line it crosses, so leaving it in fuses them into one row.
    const body = Array.from({ length: 8 }, (_, row) => word('CELL', 0, row))
    const margin = word('ARKANSASSCHOLARSHIP', 0, 0, { x: 2, height: LINE_HEIGHT * 20, width: 12 })

    const kept = dropOversizedBoxes([...body, margin])
    expect(kept).toHaveLength(body.length)
    expect(kept.some((w) => w.text === 'ARKANSASSCHOLARSHIP')).toBe(false)
  })

  it('leaves an ordinary page alone', () => {
    const words = Array.from({ length: 6 }, (_, row) => word('CELL', 0, row))
    expect(dropOversizedBoxes(words)).toHaveLength(6)
  })
})

describe('groupWordsIntoLines', () => {
  it('groups by vertical overlap, not by a fixed band', () => {
    // An amount printed a little below its label still belongs to its row.
    const label = word('SYSTEM', 0, 0)
    const amount = word('5.00', 30, 0, { y: 3 })
    const next = word('OTHER', 0, 1)

    const lines = groupWordsIntoLines([label, amount, next], 0.5)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.map((w) => w.text)).toEqual(['SYSTEM', '5.00'])
    expect(lines[1]!.map((w) => w.text)).toEqual(['OTHER'])
  })
})
