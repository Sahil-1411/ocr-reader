import { describe, expect, it } from 'vitest'

import {
  findInventoryHeader,
  groupIntoLines,
  inventoryRowsFromWords,
  invoiceRowsFromWords,
  repairGameName,
  settlementRowsFromWords,
  splitLabelValue,
  type WordBox,
} from './rows'

function word(
  text: string,
  x: number,
  y: number,
  extras: Partial<WordBox> = {},
): WordBox {
  return {
    text,
    x,
    y,
    width: extras.width ?? Math.max(16, text.length * 10),
    height: extras.height ?? 18,
    confidence: extras.confidence ?? 0.9,
  }
}

describe('splitLabelValue', () => {
  it('pairs an amount on the right with the words on the left', () => {
    const line = [word('FWD', 20, 100), word('BALANCE', 70, 100), word('0.00', 420, 100, { width: 40 })]
    expect(splitLabelValue(line)).toEqual({ label: 'FWD BALANCE', value: '0.00' })
  })

  it('keeps a credit suffix on the amount', () => {
    const line = [
      word('Cash', 20, 100),
      word('3', 70, 100, { width: 14 }),
      word('Cashes', 100, 100),
      word('40.00', 400, 100, { width: 50 }),
      word('C', 452, 100, { width: 12 }),
    ]
    expect(splitLabelValue(line)).toEqual({ label: 'Cash 3 Cashes', value: '40.00C' })
  })

  it('keeps the game name, including its price, and peels the count columns', () => {
    const line = [
      word('815', 20, 200, { width: 30 }),
      word('$1,000,000', 60, 200, { width: 90 }),
      word('JACKPOT', 160, 200),
      word('000', 420, 200, { width: 30 }),
      word('002', 470, 200, { width: 30 }),
      word('001', 520, 200, { width: 30 }),
      word('000', 570, 200, { width: 30 }),
    ]
    expect(splitLabelValue(line)).toEqual({
      label: '815 $1,000,000 JACKPOT',
      value: '000 002 001 000',
    })
  })

  it('peels a settlement date and leaves the pack code in the label', () => {
    const line = [
      word('879-008949', 20, 80, { width: 100 }),
      word('MEGA', 130, 80),
      word('CASH', 180, 80),
      word('CROSSWORD', 230, 80),
      word('02/23/26', 460, 80, { width: 70 }),
    ]
    expect(splitLabelValue(line)).toEqual({
      label: '879-008949 MEGA CASH CROSSWORD',
      value: '02/23/26',
    })
  })

  it('leaves a heading as a label', () => {
    const line = [
      word('INSTANT', 80, 40),
      word('INVENTORY', 160, 40),
      word('SUMMARY', 270, 40),
    ]
    expect(splitLabelValue(line)).toEqual({
      label: 'INSTANT INVENTORY SUMMARY',
      value: '',
    })
  })

  it('does not steal the day from a written date range', () => {
    const line = [
      word('Feb', 40, 60),
      word('23,', 80, 60, { width: 28 }),
      word('2026', 116, 60, { width: 40 }),
      word('-', 164, 60, { width: 10 }),
      word('Mar', 184, 60),
      word('01,', 230, 60, { width: 28 }),
      word('2026', 266, 60, { width: 40 }),
    ]
    expect(splitLabelValue(line)).toEqual({
      label: 'Feb 23, 2026 - Mar 01, 2026',
      value: '',
    })
  })

  it('takes a retailer id that follows a colon', () => {
    const line = [word('Retailer:', 40, 90, { width: 70 }), word('401243', 120, 90, { width: 60 })]
    expect(splitLabelValue(line)).toEqual({ label: 'Retailer:', value: '401243' })
  })

  it('rejoins an amount that was split at the decimal point', () => {
    const line = [
      word('ON-LINE', 20, 100),
      word('NET', 100, 100),
      word('DUE', 150, 100),
      word('1,381', 400, 100, { width: 50 }),
      word('.74', 452, 100, { width: 24 }),
    ]
    expect(splitLabelValue(line)).toEqual({ label: 'ON-LINE NET DUE', value: '1,381.74' })
  })
})

describe('groupIntoLines', () => {
  it('stacks two rows and reads each left to right', () => {
    const words = [
      word('0.00', 400, 100, { width: 40 }),
      word('BALANCE', 80, 100),
      word('FWD', 20, 100),
      word('DUE', 90, 140),
      word('NET', 40, 142),
      word('8.00', 400, 140, { width: 40 }),
    ]
    const lines = groupIntoLines(words)
    expect(lines.map((line) => line.map((item) => item.text))).toEqual([
      ['FWD', 'BALANCE', '0.00'],
      ['NET', 'DUE', '8.00'],
    ])
  })
})

describe('inventoryRowsFromWords', () => {
  it('splits a game line into game, name, int, rec, act, and set', () => {
    const rows = inventoryRowsFromWords([
      word('824', 20, 240, { width: 30 }),
      word('$50,000', 60, 240, { width: 70 }),
      word('FRENZY', 140, 240),
      word('000', 420, 240, { width: 30 }),
      word('002', 470, 240, { width: 30 }),
      word('001', 520, 240, { width: 30 }),
      word('000', 570, 240, { width: 30 }),
      word('815', 20, 200, { width: 30 }),
      word('$1,000,000', 60, 200, { width: 90 }),
      word('JACKPOT', 160, 200),
      word('000', 420, 200, { width: 30 }),
      word('002', 470, 200, { width: 30 }),
      word('001', 520, 200, { width: 30 }),
      word('000', 570, 200, { width: 30 }),
      word('Game', 20, 160),
      word('Name', 80, 160),
      word('Int', 420, 160, { width: 24 }),
      word('Rec', 470, 160, { width: 28 }),
      word('Act', 520, 160, { width: 28 }),
      word('Set', 570, 160, { width: 24 }),
    ])

    expect(rows.map(({ game, name, int, rec, act, set }) => ({ game, name, int, rec, act, set }))).toEqual([
      { game: '815', name: '$1,000,000 JACKPOT', int: '000', rec: '002', act: '001', set: '000' },
      { game: '824', name: '$50,000 FRENZY', int: '000', rec: '002', act: '001', set: '000' },
    ])
  })

  it('keeps counts that sit lower than the name and ignores a watermark digit', () => {
    const rows = inventoryRowsFromWords([
      word('5', 31, 457, { width: 9, height: 3 }),
      word('815', 63, 454, { width: 34, height: 14 }),
      word('$1,000,000', 124, 460, { width: 98, height: 14 }),
      word('JACKPOT', 241, 453, { width: 80, height: 21 }),
      word('000', 368, 467, { width: 40, height: 17 }),
      word('i', 410, 450, { width: 10, height: 13 }),
      word('002', 417, 467, { width: 30, height: 13 }),
      word('000', 478, 467, { width: 30, height: 10 }),
      word('001', 496, 474, { width: 30, height: 14 }),
      word('=', 549, 456, { width: 17, height: 12 }),
      word('824', 59, 480, { width: 33, height: 16 }),
      word('$50,000', 120, 483, { width: 70, height: 17 }),
      word('FRENZY', 196, 481, { width: 80, height: 21 }),
      word('000', 379, 484, { width: 30, height: 18 }),
      word('002', 415, 483, { width: 30, height: 19 }),
      word('000', 459, 489, { width: 31, height: 14 }),
      word('000', 501, 496, { width: 22, height: 17 }),
      word('4', 548, 492, { width: 19, height: 27 }),
    ])

    expect(rows.map(({ game, name, int, rec, act, set }) => ({ game, name, int, rec, act, set }))).toEqual([
      { game: '815', name: '$1,000,000 JACKPOT', int: '000', rec: '002', act: '000', set: '001' },
      { game: '824', name: '$50,000 FRENZY', int: '000', rec: '002', act: '000', set: '000' },
    ])
  })

  it('keeps counts that sit closer to the next game number', () => {
    const rows = inventoryRowsFromWords([
      word('815', 59, 447, { width: 33, height: 22 }),
      word('$1,000,000', 119, 455, { width: 111, height: 19 }),
      word('JACKPOT', 238, 450, { width: 128, height: 27 }),
      word('000', 372, 457, { width: 41, height: 21 }),
      word('002', 420, 460, { width: 55, height: 23 }),
      word('000', 483, 467, { width: 11, height: 16 }),
      word('001', 500, 476, { width: 28, height: 9 }),
      word('824', 60, 480, { width: 32, height: 16 }),
      word('$50,000', 120, 483, { width: 70, height: 17 }),
      word('FRENZY', 196, 479, { width: 150, height: 23 }),
      word('900', 375, 488, { width: 34, height: 18 }),
      word('002', 416, 490, { width: 33, height: 16 }),
      word('000', 457, 485, { width: 33, height: 22 }),
      word('000', 501, 484, { width: 33, height: 20 }),
    ])

    expect(rows.map(({ game, int, rec, act, set }) => ({ game, int, rec, act, set }))).toEqual([
      { game: '815', int: '000', rec: '002', act: '000', set: '001' },
      { game: '824', int: '900', rec: '002', act: '000', set: '000' },
    ])
  })

  it('keeps a totals line and a short game name', () => {
    const rows = inventoryRowsFromWords([
      word('882', 20, 100, { width: 30 }),
      word('10X', 60, 100, { width: 30 }),
      word('003', 420, 100, { width: 30 }),
      word('000', 470, 100, { width: 30 }),
      word('000', 520, 100, { width: 30 }),
      word('000', 570, 100, { width: 30 }),
      word('TOTALS', 20, 140, { width: 70 }),
      word('066', 420, 140, { width: 30 }),
      word('179', 470, 140, { width: 30 }),
      word('000', 520, 140, { width: 30 }),
      word('007', 570, 140, { width: 30 }),
    ])

    expect(rows.map(({ game, name, int, rec, act, set }) => ({ game, name, int, rec, act, set }))).toEqual([
      { game: '882', name: '10X', int: '003', rec: '000', act: '000', set: '000' },
      { game: '', name: 'TOTALS', int: '066', rec: '179', act: '000', set: '007' },
    ])
  })
})

describe('inventoryRowsFromWords against the printed header', () => {
  const COLUMNS = [420, 470, 520, 570]

  /** The header line plus three clean rows, so the count columns are known. */
  function sheet(...extra: WordBox[]): WordBox[] {
    const clean = (game: string, name: string, y: number) => [
      word(game, 20, y, { width: 30 }),
      word(name, 60, y),
      ...COLUMNS.map((x) => word('000', x, y, { width: 30 })),
    ]
    return [
      word('Game', 20, 100),
      word('Name', 60, 100),
      word('Int', 420, 100, { width: 30 }),
      word('Rec', 470, 100, { width: 30 }),
      word('Act', 520, 100, { width: 30 }),
      word('Set', 570, 100, { width: 30 }),
      ...clean('801', 'ALPHA', 140),
      ...clean('802', 'BRAVO', 180),
      ...clean('803', 'CHARLIE', 220),
      ...extra,
    ]
  }

  const counts = (rows: ReturnType<typeof inventoryRowsFromWords>) =>
    rows.map(({ game, name, int, rec, act, set }) => ({ game, name, int, rec, act, set }))

  it('finds the header labels as printed', () => {
    const header = findInventoryHeader(sheet())
    expect(header?.labels).toEqual(['Game', 'Name', 'Int', 'Rec', 'Act', 'Set'])
  })

  it('splits a hyphenated blob of three counts across their columns', () => {
    const rows = inventoryRowsFromWords(
      sheet(
        word('868', 20, 260, { width: 30 }),
        word('LUCKY', 60, 260),
        word('005000-000', 420, 260, { width: 130 }),
        word('001', 570, 260, { width: 30 }),
      ),
    )
    expect(counts(rows).at(-1)).toEqual({
      game: '868',
      name: 'LUCKY',
      int: '005',
      rec: '000',
      act: '000',
      set: '001',
    })
  })

  it('splits twelve digits read as one blob plus a stray into four counts', () => {
    const rows = inventoryRowsFromWords(
      sheet(
        word('870', 20, 260, { width: 30 }),
        word('BINGO', 60, 260),
        word('000-00500000', 420, 260, { width: 160 }),
        word('1', 590, 260, { width: 10 }),
      ),
    )
    expect(counts(rows).at(-1)).toMatchObject({ game: '870', int: '000', rec: '005', act: '000', set: '001' })
  })

  it('bins a count to its header column even when a neighbour is missing', () => {
    const rows = inventoryRowsFromWords(
      sheet(
        word('871', 20, 260, { width: 30 }),
        word('DELTA', 60, 260),
        word('002', 470, 260, { width: 30 }),
        word('004', 570, 260, { width: 30 }),
      ),
    )
    expect(counts(rows).at(-1)).toMatchObject({ game: '871', int: '', rec: '002', act: '', set: '004' })
  })

  it('keeps a game whose counts were not read at all', () => {
    const rows = inventoryRowsFromWords(
      sheet(word('872', 20, 260, { width: 30 }), word('ECHO', 60, 260)),
    )
    expect(counts(rows).at(-1)).toEqual({ game: '872', name: 'ECHO', int: '', rec: '', act: '', set: '' })
  })

  it('drops a margin fragment printed before the game number', () => {
    const rows = inventoryRowsFromWords(
      sheet(
        word('SHIP', -40, 260, { width: 40 }),
        word('863', 20, 260, { width: 30 }),
        word('FOXTROT', 60, 260),
        ...COLUMNS.map((x) => word('001', x, 260, { width: 30 })),
      ),
    )
    expect(counts(rows).at(-1)).toEqual({
      game: '863',
      name: 'FOXTROT',
      int: '001',
      rec: '001',
      act: '001',
      set: '001',
    })
  })

  it('reads a number in the name column as part of the name, not a game', () => {
    const rows = inventoryRowsFromWords(
      sheet(
        word('873', 20, 260, { width: 30 }),
        word('777', 60, 260, { width: 30 }),
        word('GOLF', 100, 260),
        ...COLUMNS.map((x) => word('000', x, 260, { width: 30 })),
      ),
    )
    expect(rows.map((row) => row.game)).toEqual(['801', '802', '803', '873'])
    expect(rows.at(-1)?.name).toBe('777 GOLF')
  })

  it('ends at TOTALS and ignores numbers printed below it', () => {
    const rows = inventoryRowsFromWords(
      sheet(
        word('TOTALS', 20, 260, { width: 60 }),
        ...COLUMNS.map((x) => word('000', x, 260, { width: 30 })),
        word('401', 20, 320, { width: 30 }),
        word('Retailer', 60, 320),
      ),
    )
    expect(rows.map((row) => row.game || row.name)).toEqual(['801', '802', '803', 'TOTALS'])
  })
})

describe('repairGameName', () => {
  it('restores a dollar sign read as S before a price', () => {
    expect(repairGameName('S50 OR S100! 2026 EDITION')).toBe('$50 OR $100! 2026 EDITION')
  })

  it('restores thousands commas read as dots', () => {
    expect(repairGameName('$1.000.000 JACKPOT')).toBe('$1,000,000 JACKPOT')
  })

  it('reads an O inside a price as a zero', () => {
    expect(repairGameName('$2O0,000 PLATINUM')).toBe('$200,000 PLATINUM')
  })

  it('leaves words that merely start with S alone', () => {
    expect(repairGameName('SUPER 7S')).toBe('SUPER 7S')
  })
})

describe('settlementRowsFromWords', () => {
  it('reads a game-pack, a name, and the date settled', () => {
    const rows = settlementRowsFromWords([
      word('879-008949', 20, 80, { width: 110 }),
      word('MEGA', 140, 80),
      word('CASH', 190, 80),
      word('CROSSWORD', 240, 78),
      word('02/23/26', 460, 86, { width: 70 }),
      word('862-021236', 20, 120, { width: 110 }),
      word('$1,000', 140, 120, { width: 60 }),
      word('MAYHEM', 210, 122),
      word('02/23/26', 460, 128, { width: 70 }),
    ])

    expect(rows.map(({ gamePack, name, dateSettled }) => ({ gamePack, name, dateSettled }))).toEqual([
      { gamePack: '879-008949', name: 'MEGA CASH CROSSWORD', dateSettled: '02/23/26' },
      { gamePack: '862-021236', name: '$1,000 MAYHEM', dateSettled: '02/23/26' },
    ])
  })

  it('joins a pack code that was split across two words', () => {
    const rows = settlementRowsFromWords([
      word('881', 20, 80, { width: 30 }),
      word('023234', 54, 80, { width: 60 }),
      word('DIAMONDS', 130, 80),
      word('&', 220, 80, { width: 12 }),
      word('GOLD', 240, 80),
      word('02/23/26', 460, 84, { width: 70 }),
    ])

    expect(rows.map(({ gamePack, name, dateSettled }) => ({ gamePack, name, dateSettled }))).toEqual([
      { gamePack: '881-023234', name: 'DIAMONDS & GOLD', dateSettled: '02/23/26' },
    ])
  })

  it('keeps a single-letter word inside the name', () => {
    const rows = settlementRowsFromWords([
      word('869-004512', 20, 80, { width: 110 }),
      word('100X', 140, 80, { width: 40 }),
      word('X', 192, 80, { width: 12 }),
      word('THE', 216, 80, { width: 30 }),
      word('CASH', 258, 80),
      word('02/23/26', 460, 84, { width: 70 }),
    ])
    expect(rows[0]?.name).toBe('100X X THE CASH')
  })

  it('drops a stray mark stranded between the name and the date', () => {
    const rows = settlementRowsFromWords([
      word('862-021236', 20, 80, { width: 110 }),
      word('$1,000', 140, 80, { width: 60 }),
      word('MAYHEM', 210, 80),
      word('1', 380, 80, { width: 8 }),
      word('02/23/26', 460, 84, { width: 70 }),
    ])
    expect(rows[0]?.name).toBe('$1,000 MAYHEM')
  })

  /** Four settlement lines 40px apart, each with its pack code and date. */
  const table = () => [
    word('02/23/26', 300, 20, { width: 70 }),
    word('-', 380, 20, { width: 8 }),
    word('03/01/26', 395, 20, { width: 70 }),
    ...['879-008949', '862-021236', '869-004512', '881-023234'].flatMap((pack, index) => [
      word(pack, 20, 80 + index * 40, { width: 110 }),
      word(`GAME${index + 1}`, 140, 80 + index * 40),
      word('02/23/26', 460, 82 + index * 40, { width: 70 }),
    ]),
  ]

  it('keeps a row whose date could not be read', () => {
    const words = table().filter((w) => !(w.text === '02/23/26' && w.y === 162))
    const rows = settlementRowsFromWords(words)
    expect(rows.map((row) => [row.gamePack, row.dateSettled])).toEqual([
      ['879-008949', '02/23/26'],
      ['862-021236', '02/23/26'],
      ['869-004512', ''],
      ['881-023234', '02/23/26'],
    ])
  })

  it('keeps a row whose pack code could not be read', () => {
    const words = table().map((w) => (w.text === '862-021236' ? { ...w, text: '8G2-O2' } : w))
    const rows = settlementRowsFromWords(words)
    expect(rows).toHaveLength(4)
    expect(rows[1]).toMatchObject({ gamePack: '', dateSettled: '02/23/26' })
    expect(rows[1]?.name).toContain('GAME2')
  })

  it('keeps a row with a split pack code and no date', () => {
    const words = table()
      .filter((w) => !(w.text === '02/23/26' && w.y === 202))
      .flatMap((w) =>
        w.text === '881-023234'
          ? [word('881', 20, w.y, { width: 30 }), word('023234', 54, w.y, { width: 60 })]
          : [w],
      )
    const rows = settlementRowsFromWords(words)
    expect(rows[3]).toMatchObject({ gamePack: '881-023234', name: 'GAME4', dateSettled: '' })
  })

  it('does not turn the date range above the table into a row', () => {
    expect(settlementRowsFromWords(table())).toHaveLength(4)
  })
})

describe('invoiceRowsFromWords', () => {
  it('drops a margin-watermark fragment stranded before the label', () => {
    // Boxes measured off public/samples/weekly-invoice.jpg. "12" and "Ne" are
    // fragments of the vertical watermark running down the left margin; without
    // the gap rule they read as "12 SYSTEM FEE" and "Ne NON-GAME ADJUSTMENTS".
    // The old x-fraction rule missed both by under two pixels.
    const rows = invoiceRowsFromWords([
      word('Ne', 14, 437, { width: 34, height: 13 }),
      word('NON-GAME', 105, 437, { width: 82, height: 13 }),
      word('ADJUSTMENTS', 193, 437, { width: 105, height: 13 }),
      word('0.00', 421, 437, { width: 30, height: 12 }),
      word('12', 16, 459, { width: 33, height: 13 }),
      word('SYSTEM', 105, 459, { width: 56, height: 13 }),
      word('FEE', 166, 460, { width: 25, height: 12 }),
      word('5.00', 421, 462, { width: 30, height: 12 }),
    ])

    expect(rows.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: 'NON-GAME ADJUSTMENTS', value: '0.00' },
      { label: 'SYSTEM FEE', value: '5.00' },
    ])
  })

  it('keeps a short leading word that is part of the label', () => {
    // Same shape, but the first token sits at the label's own left edge with an
    // ordinary word gap, so it must survive.
    const rows = invoiceRowsFromWords([
      word('Cash', 105, 40, { width: 38, height: 13 }),
      word('3', 148, 40, { width: 10, height: 13 }),
      word('Sales', 163, 40, { width: 40, height: 13 }),
      word('336.00', 421, 42, { width: 44, height: 12 }),
    ])

    expect(rows.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: 'Cash 3 Sales', value: '336.00' },
    ])
  })

  it('pairs each description with the amount on its right', () => {
    const rows = invoiceRowsFromWords([
      word('FWD', 20, 40),
      word('BALANCE', 70, 40),
      word('0.00', 420, 46, { width: 40 }),
      word('ON-LINE', 20, 80),
      word('NET', 100, 80),
      word('DUE', 150, 82),
      word('1,381', 400, 88, { width: 50 }),
      word('.74', 452, 88, { width: 24 }),
      word('ONLINE', 80, 130),
      word('GAMES', 160, 130),
    ])

    expect(rows.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: 'FWD BALANCE', value: '0.00' },
      { label: 'ON-LINE NET DUE', value: '1,381.74' },
    ])
  })

  it('keeps a zero, a credit mark, and a cents amount the reader joined together', () => {
    const rows = invoiceRowsFromWords([
      word('E', 8, 40, { width: 10 }),
      word('Scholarship', 40, 40, { width: 90 }),
      word('RAFFLE', 140, 40),
      word('Sales', 210, 40),
      word('000', 460, 42, { width: 30 }),
      word('Cash', 20, 90),
      word('3', 70, 90, { width: 14 }),
      word('Cashes', 100, 90),
      word('40.00¢', 450, 92, { width: 60 }),
      word('Fast', 20, 140),
      word('Play', 70, 140),
      word('Sales', 120, 140),
      word('29300', 450, 144, { width: 50 }),
    ])

    expect(rows.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: 'Scholarship RAFFLE Sales', value: '0.00' },
      { label: 'Cash 3 Cashes', value: '40.00C' },
      { label: 'Fast Play Sales', value: '293.00' },
    ])
  })

  it('repairs a thousands mark read as a dot and ignores a retailer id', () => {
    const rows = invoiceRowsFromWords([
      word('Retailer', 40, 40, { width: 70 }),
      word('401243', 260, 40, { width: 70 }),
      word('Packs', 40, 100),
      word('Settled', 100, 100),
      word('9.90000', 420, 100, { width: 70 }),
      word('L/T', 40, 150, { width: 30 }),
      word('Cashes', 80, 150),
      word('4.577.00C', 420, 152, { width: 90 }),
    ])

    expect(rows.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: 'Packs Settled', value: '9900.00' },
      { label: 'L/T Cashes', value: '4577.00C' },
    ])
  })

  it('keeps the words the reader returned, including a short token on the left', () => {
    const rows = invoiceRowsFromWords([
      word('5', 36, 668, { width: 17, height: 16 }),
      word('4', 149, 671, { width: 8, height: 11 }),
      word('Cashes', 164, 661, { width: 50, height: 31 }),
      word('0.00', 415, 670, { width: 31, height: 12 }),
    ])

    expect(rows.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: '4 Cashes', value: '0.00' },
    ])
  })

  it('reads amounts the stamp left trailing junk on', () => {
    const rows = invoiceRowsFromWords([
      word('ON-LINENETDUE', 104, 40, { width: 140 }),
      word('138174]', 389, 40, { width: 70 }),
      word('NON-GAME', 97, 100, { width: 80 }),
      word('ADJUSTMENTS', 193, 100),
      word('0.003', 421, 100, { width: 40 }),
      word('SYSTEM', 101, 160),
      word('FEE', 168, 160),
      word('5.00%', 421, 160, { width: 40 }),
      word('Sales', 106, 220),
      word('Comm', 150, 220),
      word('9393c', 399, 220, { width: 50 }),
      word('Cashing', 105, 280),
      word('Comm', 168, 280),
      word('3.83C|*', 408, 280, { width: 60 }),
      word('Cashes', 126, 340),
      word('1,980.00€', 375, 340, { width: 80 }),
    ])

    expect(rows.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: 'ON-LINENETDUE', value: '1381.74' },
      { label: 'NON-GAME ADJUSTMENTS', value: '0.00' },
      { label: 'SYSTEM FEE', value: '5.00' },
      { label: 'Sales Comm', value: '93.93C' },
      { label: 'Cashing Comm', value: '3.83C' },
      { label: 'Cashes', value: '1,980.00C' },
    ])
  })

  it('leaves out a footer fragment whose only figure is a stray zero', () => {
    const rows = invoiceRowsFromWords([
      word('fully', 61, 1779),
      word('TERETE', 138, 1779),
      word('(0)', 466, 1787, { width: 24 }),
      word('LIT', 91, 400, { width: 23 }),
      word('Cashes', 122, 400),
      word('4,577.00C', 375, 400, { width: 80 }),
    ])

    expect(rows.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: 'LIT Cashes', value: '4,577.00C' },
    ])
  })
})
