import { describe, expect, it } from 'vitest'

import { assembleReceipt, rowCells, toPublicJson } from '../receipt/assemble'
import { isLotteryHeader, readColumnTable, readColumnTables } from './columns'
import type { WordBox } from './rows'

function word(text: string, x: number, y: number, width = Math.max(12, text.length * 8)): WordBox {
  return { text, x, y, width, height: 14, confidence: 0.95 }
}

/** A wholesale invoice: several columns, item numbers that look like pack codes. */
function salesInvoice(): WordBox[] {
  return [
    word('Capital', 40, 20, 60),
    word('Sales', 110, 20, 50),
    word('INVOICE', 620, 18, 90),
    word('CASE', 20, 70, 40),
    word('QTY', 64, 70, 28),
    word('UNT', 150, 70, 30),
    word('QTY', 184, 70, 28),
    word('ITEM', 280, 70, 36),
    word('PART#', 320, 70, 48),
    word('UPC', 430, 70, 36),
    word('DESCRIPTION', 540, 70, 100),
    word('EXTENDED', 760, 70, 80),
    word('2', 24, 110, 12),
    word('24', 154, 110, 20),
    word('849-1706888', 270, 110, 100),
    word('012345678905', 420, 110, 96),
    word('WIDGET', 540, 110, 56),
    word('NAME', 604, 110, 40),
    word('48.00', 770, 110, 44),
    word('CONTINUED', 540, 132, 80),
    word('1', 24, 170, 12),
    word('6', 154, 170, 12),
    word('674-806801', 270, 170, 90),
    word('098765432109', 420, 170, 96),
    word('BIG', 540, 170, 30),
    word('ISLAND', 578, 170, 56),
    word('19.50', 770, 170, 44),
    word('Page', 40, 420, 36),
    word('1', 80, 420, 10),
    word('of', 96, 420, 16),
    word('7', 116, 420, 10),
  ]
}

/** A word on the wholesale invoice, in its 200-dpi page pixels. */
function wholesaleBox(text: string, x: number, y: number, width: number, height = 33): WordBox {
  return { text, x, y, width, height, confidence: 1 }
}

/** That invoice's column titles, set on two baselines (`Qty` over `Case`). */
function wholesaleHeader(): WordBox[] {
  const box = wholesaleBox
  return [
    box('Qty', 11, 621, 60),
    box('Case', 4, 653, 90),
    box('Qty', 93, 621, 60),
    box('Unt', 93, 653, 70),
    box('Item#', 163, 621, 100),
    box('Part#', 163, 653, 100),
    box('UPC', 351, 636, 60),
    box('Description', 558, 636, 220),
    box('Case/UPC', 999, 636, 160),
    box('Pack', 1231, 636, 80),
    box('Prc', 1353, 621, 60),
    box('Case', 1353, 653, 80),
    box('Prc', 1462, 621, 60),
    box('Unt', 1462, 653, 60),
    box('Extended', 1535, 637, 147, 31),
  ]
}

describe('readColumnTable', () => {
  it('fills every printed column, including values past the item number', () => {
    const table = readColumnTable(salesInvoice())
    expect(table?.headers).toEqual([
      'CASE QTY',
      'UNT QTY',
      'ITEM PART#',
      'UPC',
      'DESCRIPTION',
      'EXTENDED',
    ])
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ['2', '24', '849-1706888', '012345678905', 'WIDGET NAME CONTINUED', '48.00'],
      ['1', '6', '674-806801', '098765432109', 'BIG ISLAND', '19.50'],
    ])
  })

  it('reuses an earlier page header when this page does not repeat it', () => {
    const first = readColumnTable(salesInvoice())
    expect(first).not.toBeNull()
    const continued = salesInvoice().filter((item) => item.y > 80)
    const table = readColumnTable(continued, 0.5, {
      headers: first?.headers ?? [],
      bounds: first?.bounds ?? [],
    })
    expect(table?.headers).toEqual(first?.headers)
    expect(table?.rows.map((row) => row.cells[2])).toEqual(['849-1706888', '674-806801'])
  })

  it('splits a two-line wholesale header into the printed columns', () => {
    const box = wholesaleBox
    const words: WordBox[] = [
      ...wholesaleHeader(),
      box('1000', 9, 701, 60),
      box('0795A', 159, 701, 75),
      box('855553008221', 286, 702, 140),
      box('50CS', 465, 701, 60),
      box('NEON', 540, 701, 60),
      box('LIGHTERS', 630, 701, 120),
      box('BOX#00822', 988, 702, 120),
      box('20/50CT', 1224, 702, 93),
      box('3.45', 1381, 702, 53),
      box('0.069', 1456, 702, 69),
      box('T', 1531, 702, 14),
      box('3450.00', 1594, 702, 93),
      box('6', 54, 771, 15),
      box('2882H', 159, 771, 75),
      box('840048220523', 286, 772, 140),
      box('1CS', 465, 772, 44),
      box('JUUL', 516, 772, 59),
      box('PODS', 581, 772, 59),
      box('6PK', 646, 772, 44),
      box('(5%)', 697, 772, 59),
      box('$24.99', 762, 772, 88),
      box('MENTHOL', 856, 772, 102),
      box('BX#22052-6PK-', 988, 772, 173),
      box('6/4CT', 1224, 772, 67),
      box('67.36', 1368, 772, 67),
      box('16.840', 1455, 772, 70),
      box('T', 1531, 772, 13),
      box('404.16', 1607, 772, 80),
      box('(.7ML', 465, 807, 63),
      box('PER', 541, 807, 38),
      box('POD,', 592, 807, 51),
      box('18', 9, 911, 40),
      box('885418', 159, 911, 75),
      box('840170618113', 286, 911, 140),
      box('1CS', 465, 911, 44),
      box('MINT', 540, 911, 50),
      box('RL#61809', 988, 911, 120),
      box('18/5PK', 1224, 911, 80),
      box('*', 1337, 911, 13),
      box('20.91', 1381, 911, 53),
      box('4.182', 1456, 911, 69),
      box('T', 1531, 911, 14),
      box('376.38', 1594, 911, 80),
      box('1', 54, 980, 15),
      box('10004', 159, 980, 75),
      box('OH', 465, 980, 30),
      box('(1-7', 540, 980, 50),
      box('PLT)', 600, 980, 50),
      box('SURCHARGE', 660, 980, 110),
      box('***', 1224, 980, 40),
      box('150.00', 1381, 980, 60),
      box('150.00', 1594, 980, 70),
    ]
    const table = readColumnTable(words)
    expect(table?.headers).toEqual([
      'Qty Case',
      'Qty Unt',
      'Item# Part#',
      'UPC',
      'Description',
      'Case/UPC',
      'Pack',
      'Prc Case',
      'Prc Unt',
      'Extended',
    ])
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ['1000', '', '0795A', '855553008221', '50CS NEON LIGHTERS', 'BOX#00822', '20/50CT', '3.45', '0.069 T', '3450.00'],
      ['6', '', '2882H', '840048220523', '1CS JUUL PODS 6PK (5%) $24.99 MENTHOL (.7ML PER POD,', 'BX#22052-6PK-', '6/4CT', '67.36', '16.840 T', '404.16'],
      ['18', '', '885418', '840170618113', '1CS MINT', 'RL#61809', '18/5PK', '* 20.91', '4.182 T', '376.38'],
      ['1', '', '10004', '', 'OH (1-7 PLT) SURCHARGE', '', '***', '150.00', '', '150.00'],
    ])
  })

  it('keeps a wrapped header title as one column', () => {
    const scale = 2
    const height = 9.8 * scale
    const box = (text: string, pdfX: number, pdfBaseline: number, pdfWidth: number): WordBox => ({
      text,
      x: pdfX * scale,
      y: (560 - pdfBaseline) * scale,
      width: pdfWidth * scale,
      height,
      confidence: 1,
    })
    const header: WordBox[] = [
      box('Items', 17.3, 524.1, 25.6),
      box('Ordered', 207.3, 530, 38.1),
      box('Qty', 218.1, 518.1, 16.3),
      box('Shipped', 257.2, 530, 38.7),
      box('Qty', 268.3, 518.1, 16.3),
      box('OOS', 307.7, 524.1, 21.8),
      box('Customer', 341.4, 530, 45.7),
      box('Price', 352.2, 518.1, 24),
      box('Customer', 398.9, 536, 45.7),
      box('Unit', 412.1, 524.1, 19.1),
      box('Price', 409.7, 512.2, 24),
      box('Tax', 462.9, 536, 16.9),
      box('Per', 463.4, 524.1, 15.8),
      box('Unit', 461.8, 512.2, 19.1),
      box('Total', 504.2, 530, 23.4),
      box('Tax', 507.4, 518.1, 16.9),
      box('Sub-', 562.6, 530, 21.8),
      box('Total', 561, 518.1, 23.4),
    ]
    const item = (name: string, nameBaseline: number, packBaseline: number, qtyBaseline: number): WordBox[] => [
      box(name, 17.3, nameBaseline, 170.5),
      box('Case (30/Unit)', 17.3, packBaseline, 63.2),
      box('5', 223.6, qtyBaseline, 5.4),
      box('5', 273.8, qtyBaseline, 5.4),
      box('0', 315.8, qtyBaseline, 5.4),
      box('$615.00', 346.5, qtyBaseline, 35.4),
      box('$20.50', 406.7, qtyBaseline, 30),
      box('$3.49', 459.1, qtyBaseline, 24.5),
      box('$522.75', 498.2, qtyBaseline, 35.4),
      box('$3,075.00', 540.9, qtyBaseline, 40),
      box('T', 581, qtyBaseline, 8),
    ]
    const table = readColumnTable([
      ...header,
      ...item('Backwoods 2/2.99 Truewraps Aromatic', 486.8, 474.9, 480.8),
      ...item('Backwoods 2/2.99 Truewraps Original', 447, 435, 441),
    ])
    expect(table?.headers).toEqual([
      'Items',
      'Ordered Qty',
      'Shipped Qty',
      'OOS',
      'Customer Price',
      'Customer Unit Price',
      'Tax Per Unit',
      'Total Tax',
      'Sub-Total',
    ])
    expect(table?.rows.map((row) => row.cells)).toEqual([
      [
        'Backwoods 2/2.99 Truewraps Aromatic Case (30/Unit)',
        '5',
        '5',
        '0',
        '$615.00',
        '$20.50',
        '$3.49',
        '$522.75',
        '$3,075.00 T',
      ],
      [
        'Backwoods 2/2.99 Truewraps Original Case (30/Unit)',
        '5',
        '5',
        '0',
        '$615.00',
        '$20.50',
        '$3.49',
        '$522.75',
        '$3,075.00 T',
      ],
    ])
  })

  it('keeps a starred reason line as its own row instead of gluing it to the item above', () => {
    // A credit section prints the reason over each returned item. The reason
    // is one line under the item before it, which is the shape of a wrapped
    // name, and it used to end up as the tail of that item's description.
    const box = wholesaleBox
    const table = readColumnTable([
      ...wholesaleHeader(),
      box('***SHORT', 465, 700, 140),
      box('PRODUCT***', 620, 700, 170),
      box('-2', 40, 735, 29),
      box('2204C', 159, 735, 75),
      box('012345000017', 286, 735, 140),
      box('CARAMEL', 465, 735, 115),
      box('COCOA', 595, 735, 90),
      box('BAR', 700, 735, 55),
      box('BX#10203-REG', 988, 735, 172),
      box('12/18CT', 1224, 735, 93),
      box('18.40', 1381, 735, 53),
      box('1.022', 1456, 735, 69),
      box('-36.80', 1594, 735, 93),
      box('***DAMAGED', 465, 770, 165),
      box('CASE***', 645, 770, 110),
      box('-7', 40, 805, 29),
      box('0005', 159, 805, 60),
      box('CORN', 465, 805, 70),
      box('CHIPS', 550, 805, 80),
      box('(9.5OZ)', 645, 805, 105),
      box('BAG***', 988, 805, 90),
      box('***', 1224, 805, 45),
      box('*', 1337, 805, 13),
      box('2.95', 1381, 805, 53),
      box('-20.65', 1594, 805, 93),
      box('--------------------', 465, 840, 300),
    ])
    expect(table?.rows.map((row) => [row.cells, row.label ?? false])).toEqual([
      [['', '', '', '', '***SHORT PRODUCT***', '', '', '', '', ''], true],
      [['-2', '', '2204C', '012345000017', 'CARAMEL COCOA BAR', 'BX#10203-REG', '12/18CT', '18.40', '1.022', '-36.80'], false],
      [['', '', '', '', '***DAMAGED CASE***', '', '', '', '', ''], true],
      [['-7', '', '0005', '', 'CORN CHIPS (9.5OZ)', 'BAG***', '***', '* 2.95', '', '-20.65'], false],
    ])
  })

  it('drops an out-of-stock note instead of gluing it to the description', () => {
    // The invoice prints the note under the item it belongs to, where a
    // wrapped name would sit, so it used to end up as the tail of the
    // description. Starred or not, the words are an order note, not a name.
    const table = readColumnTable([
      word('QTY', 20, 70, 28),
      word('ITEM', 80, 70, 36),
      word('DESCRIPTION', 240, 70, 100),
      word('PRICE', 480, 70, 44),
      word('AMOUNT', 560, 70, 56),
      word('8', 30, 110, 8),
      word('353789', 80, 110, 48),
      word('ALP', 240, 110, 24),
      word('NIC', 272, 110, 24),
      word('POUCH', 304, 110, 40),
      word('19.50', 484, 110, 40),
      word('156.00', 572, 110, 48),
      word('OUT', 240, 132, 24),
      word('OF', 272, 132, 16),
      word('STOCK', 296, 132, 40),
      word('3', 30, 170, 8),
      word('383612', 80, 170, 48),
      word('ZYN', 240, 170, 24),
      word('SPEARMINT', 272, 170, 72),
      word('19.50', 484, 170, 40),
      word('58.50', 572, 170, 40),
      word('***NO', 240, 192, 40),
      word('STOCK***', 288, 192, 64),
    ])
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ['8', '353789', 'ALP NIC POUCH', '19.50', '156.00'],
      ['3', '383612', 'ZYN SPEARMINT', '19.50', '58.50'],
    ])
  })

  it('logs what it left out: notes, totals, and page furniture', () => {
    const table = readColumnTable([
      word('QTY', 20, 70, 28),
      word('ITEM', 80, 70, 36),
      word('DESCRIPTION', 240, 70, 100),
      word('PRICE', 480, 70, 44),
      word('AMOUNT', 560, 70, 56),
      word('8', 30, 110, 8),
      word('353789', 80, 110, 48),
      word('ALP', 240, 110, 24),
      word('NIC', 272, 110, 24),
      word('POUCH', 304, 110, 40),
      word('19.50', 484, 110, 40),
      word('156.00', 572, 110, 48),
      word('OUT', 240, 132, 24),
      word('OF', 272, 132, 16),
      word('STOCK', 296, 132, 40),
      word('3', 30, 170, 8),
      word('383612', 80, 170, 48),
      word('ZYN', 240, 170, 24),
      word('SPEARMINT', 272, 170, 72),
      word('19.50', 484, 170, 40),
      word('58.50', 572, 170, 40),
      word('TOTAL', 240, 210, 44),
      word('214.50', 572, 210, 48),
      word('Page', 40, 260, 36),
      word('1', 80, 260, 10),
      word('of', 96, 260, 16),
      word('2', 116, 260, 10),
    ])
    expect(table?.skipped.map(({ reason, text }) => [reason, text])).toEqual([
      ['note', 'OUT OF STOCK'],
      ['summary', 'TOTAL  214.50'],
      ['furniture', 'Page  1 of 2'],
    ])
    // The log reads in printed order, and every entry carries its confidence.
    expect(table?.skipped.every((line) => line.confidence > 0 && line.y > 0)).toBe(true)
  })

  it('joins a token the reader split, and keeps a space the page printed', () => {
    const table = readColumnTable([
      word('QTY', 20, 70, 28),
      word('ITEM', 80, 70, 36),
      word('DESCRIPTION', 240, 70, 100),
      word('PRICE', 480, 70, 44),
      word('AMOUNT', 560, 70, 56),
      word('2', 30, 110, 8),
      // `849-1706888` read as two boxes a glyph's margin apart.
      word('849-', 80, 110, 32),
      word('1706888', 113, 110, 56),
      word('CIGAR', 240, 110, 40),
      word('TUBES', 288, 110, 40),
      // A printed space before the minus, a whole character wide.
      word('32S', 336, 110, 24),
      word('-120', 368, 110, 32),
      // `3.45` split at the point.
      word('3', 492, 110, 8),
      word('.45', 501, 110, 24),
      word('6.90', 580, 110, 32),
      // A credit's minus split off its quantity.
      word('-', 26, 150, 6),
      word('1', 33, 150, 8),
      word('674-806801', 80, 150, 80),
      word('BIG', 240, 150, 24),
      word('ISLAND', 272, 150, 48),
      word('19.50', 484, 150, 40),
      word('-19.50', 572, 150, 48),
    ])
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ['2', '849-1706888', 'CIGAR TUBES 32S -120', '3.45', '6.90'],
      ['-1', '674-806801', 'BIG ISLAND', '19.50', '-19.50'],
    ])
  })

  it('adds a lot number printed under the item code to that code', () => {
    // Five-digit item numbers read like quantities; the title says they are codes.
    const table = readColumnTable([
      word('QTY', 20, 70, 28),
      word('ITEM#', 80, 70, 40),
      word('DESCRIPTION', 240, 70, 100),
      word('PRICE', 480, 70, 44),
      word('AMOUNT', 560, 70, 56),
      word('2', 30, 110, 8),
      word('10452', 80, 110, 40),
      word('WIDGET', 240, 110, 48),
      word('BLUE', 296, 110, 32),
      word('3.45', 492, 110, 32),
      word('6.90', 580, 110, 32),
      word('LOT', 80, 128, 24),
      word('A12', 112, 128, 24),
      word('1', 30, 160, 8),
      word('20881', 80, 160, 40),
      word('GADGET', 240, 160, 48),
      word('24.99', 484, 160, 40),
      word('24.99', 572, 160, 40),
    ])
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ['2', '10452 LOT A12', 'WIDGET BLUE', '3.45', '6.90'],
      ['1', '20881', 'GADGET', '24.99', '24.99'],
    ])
  })

  it('reads a table printed under the invoice as a table of its own', () => {
    // The invoice prints its items, and under them `Previous Balances` with
    // titles of its own. Read under the invoice's columns, its dates became
    // descriptions and its balances quantities; it is its own table.
    const box = wholesaleBox
    const tables = readColumnTables([
      box('No', 49, 350, 31),
      box('Code', 135, 350, 56),
      box('Description', 497, 350, 123),
      box('Price', 1100, 350, 56),
      box('Quantity', 1430, 350, 101),
      box('Total', 1700, 350, 60),
      box('1', 55, 400, 14),
      box('12262', 135, 400, 76),
      box('4 SEASONS MOTOR OIL', 497, 400, 300),
      box('$17.95', 1100, 400, 76),
      box('3', 1480, 400, 14),
      box('$53.85', 1700, 400, 76),
      // Its own heading, then titles with the figures set well right of them.
      box('Previous', 711, 600, 135),
      box('Balances', 853, 600, 135),
      box('Date', 318, 660, 54),
      box('Invoice', 825, 660, 87),
      box('Balance', 1325, 660, 96),
      box('08/06/2026', 293, 710, 104),
      box('93354', 1041, 710, 58),
      box('$52.65', 1561, 710, 64),
      box('08/13/2026', 293, 750, 104),
      box('93363', 1041, 750, 58),
      box('$35.90', 1561, 750, 64),
    ])

    expect(tables.map((table) => [table.title, table.headers])).toEqual([
      [undefined, ['No', 'Code', 'Description', 'Price', 'Quantity', 'Total']],
      ['Previous Balances', ['Date', 'Invoice', 'Balance']],
    ])
    expect(tables[0]?.rows.map((row) => row.cells)).toEqual([
      ['1', '12262', '4 SEASONS MOTOR OIL', '$17.95', '3', '$53.85'],
    ])
    expect(tables[1]?.rows.map((row) => row.cells)).toEqual([
      ['08/06/2026', '93354', '$52.65'],
      ['08/13/2026', '93363', '$35.90'],
    ])
  })

  it('keeps a short UPC in its own column, not on the end of the size', () => {
    // Printed as on the wholesale invoice: the size and the UPC are a space
    // and a bit apart, which makes them one field, and the UPC starts well
    // left of its own title. A UPC four digits shorter than its neighbours'
    // has its centre left of the title, and used to be read as part of the
    // size — `5CT 04254418`, with the UPC column left empty.
    const box = wholesaleBox
    const table = readColumnTable([
      box('ITEM', 66, 621, 100),
      box('QTY', 251, 621, 40),
      box('DESCRIPTION', 409, 621, 146),
      box('SIZE/FM', 952, 621, 93),
      box('UPC', 1157, 621, 40),
      box('RETAIL', 1377, 621, 80),
      box('EXTENSION', 2031, 621, 120),
      // A twelve-digit UPC: its centre falls right of the title.
      box('182352', 66, 700, 115),
      box('18', 259, 700, 37),
      box('COPENHAGEN', 336, 700, 191),
      box('5CT', 990, 700, 56),
      box('073100025891', 1067, 700, 230),
      box('6.99', 1394, 700, 76),
      box('513.90', 2048, 700, 114),
      // An eight-digit UPC, printed from the same left edge.
      box('155986', 66, 740, 115),
      box('18', 259, 740, 37),
      box('GRIZZLY', 336, 740, 133),
      box('5CT', 990, 740, 56),
      box('04254418', 1067, 740, 153),
      box('6.85', 1394, 740, 76),
      box('502.20', 2048, 740, 114),
      box('18615', 86, 780, 95),
      box('36', 259, 780, 37),
      box('KODIAK', 336, 780, 114),
      box('5CT', 990, 780, 56),
      box('04223418', 1067, 780, 153),
      box('8.35', 1394, 780, 76),
      box('1229.76', 2028, 780, 134),
    ])
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ['182352', '18', 'COPENHAGEN', '5CT', '073100025891', '6.99', '513.90'],
      ['155986', '18', 'GRIZZLY', '5CT', '04254418', '6.85', '502.20'],
      ['18615', '36', 'KODIAK', '5CT', '04223418', '8.35', '1229.76'],
    ])
  })

  it('keeps two money columns apart when a figure is printed under each', () => {
    // `Unit Price` and `Sold Price` are set a space apart, close enough to
    // read as one wrapped title. The rows below settle it: each carries its
    // own figure, in its own column, with a clear gutter between them.
    const header = [
      word('SKU', 60, 70, 30),
      word('Product', 150, 70, 58),
      word('Name', 212, 70, 42),
      word('/', 258, 70, 8),
      word('Description', 270, 70, 88),
      word('Qty', 440, 70, 26),
      word('Unit', 500, 70, 32),
      word('Price', 536, 70, 40),
      word('Sold', 584, 70, 36),
      word('Price', 624, 70, 40),
      word('Amount', 700, 70, 56),
    ]
    const item = (y: number, sku: string, name: string, qty: string, money: string) => [
      word(sku, 60, y, 72),
      word(name, 160, y, 120),
      word(qty, 455, y, 10),
      word(money, 530, y, 44),
      word(money, 618, y, 44),
      word(money, 710, y, 44),
    ]
    const table = readColumnTable([
      ...header,
      ...item(110, '484124656693', 'DETOX-CHAMP-ACAI', '1', '47.88'),
      ...item(140, '888235520193', 'DETOX-CHAMP-BERRY', '1', '47.88'),
      ...item(170, '395403510073', 'DETOX-CHAMP-GRAPE', '1', '48.00'),
    ])

    expect(table?.headers).toEqual([
      'SKU',
      'Product Name /Description',
      'Qty',
      'Unit Price',
      'Sold Price',
      'Amount',
    ])
    // Each figure stays in its column rather than being run together.
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ['484124656693', 'DETOX-CHAMP-ACAI', '1', '47.88', '47.88', '47.88'],
      ['888235520193', 'DETOX-CHAMP-BERRY', '1', '47.88', '47.88', '47.88'],
      ['395403510073', 'DETOX-CHAMP-GRAPE', '1', '48.00', '48.00', '48.00'],
    ])
  })

  it('keeps figures under titles set at the left of their columns', () => {
    // `Price` and `Amount` start their columns; the figures end them, clear of
    // every title. The edges the titles suggest put both figures under Amount.
    const table = readColumnTable([
      word('Qty', 20, 70, 24),
      word('Item', 70, 70, 32),
      word('Description', 150, 70, 88),
      word('Price', 420, 70, 40),
      word('Amount', 560, 70, 48),
      word('12', 24, 110, 16),
      word('849-1706888', 70, 110, 72),
      word('Copy', 150, 110, 32),
      word('paper', 186, 110, 40),
      word('38.99', 470, 110, 40),
      word('467.88', 620, 110, 48),
      word('3', 32, 140, 8),
      word('220-4411', 70, 140, 64),
      word('Toner', 150, 140, 40),
      word('cartridge', 194, 140, 72),
      word('142.50', 462, 140, 48),
      word('427.50', 620, 140, 48),
    ])
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ['12', '849-1706888', 'Copy paper', '38.99', '467.88'],
      ['3', '220-4411', 'Toner cartridge', '142.50', '427.50'],
    ])
  })

  it('does not treat a lottery settlement header as a generic table', () => {
    expect(isLotteryHeader(['Game-Pack', 'Name', 'Date Settled'])).toBe(true)
    expect(isLotteryHeader(['CASE QTY', 'ITEM PART#', 'DESCRIPTION'])).toBe(false)
  })
})

describe('assembleReceipt column tables', () => {
  it('keeps a sales invoice out of the settlement reader', () => {
    const result = assembleReceipt(
      salesInvoice(),
      {
        reader: 'pdf text',
        watermarkSuppressed: false,
        watermarkPixelRatio: 0,
        sourceSize: { width: 900, height: 500 },
        timingsMs: {},
      },
      0.5,
    )
    expect(result.kind).toBe('table')
    expect(result.validation).toEqual([])
    expect(toPublicJson(result).rows[0]).toMatchObject({
      'ITEM PART#': '849-1706888',
      UPC: '012345678905',
      DESCRIPTION: 'WIDGET NAME CONTINUED',
      EXTENDED: '48.00',
    })
  })

  it('keeps a last page that prints only a category recap out of the label reader', () => {
    // The last page of a wholesale invoice repeats the column titles over a
    // recap of the order by category — no items at all. Refusing the page sent
    // it to the label-and-amount reader, which paired the letterhead with
    // whatever figure was nearest: `TEL 419 248-3393 … 12285.73`.
    const page = [
      // Letterhead, above the printed column titles.
      word('TEL', 40, 20, 30),
      word('419', 76, 20, 28),
      word('248-3393', 110, 20, 70),
      word('12285.73', 520, 20, 64),
      // The invoice's own column titles.
      word('ITEM', 80, 70, 36),
      word('QTY', 160, 70, 28),
      word('DESCRIPTION', 240, 70, 100),
      word('PRICE', 480, 70, 44),
      word('AMOUNT', 560, 70, 56),
      // A recap of the order by category, under titles of its own.
      word('CATEGORY', 80, 120, 70),
      word('DESCRIPTION', 160, 120, 100),
      word('LINES', 290, 120, 44),
      word('UNITS', 340, 120, 44),
      word('YOUR', 520, 120, 36),
      word('COST', 560, 120, 36),
      word('JUUL', 80, 150, 36),
      word('4', 300, 150, 8),
      word('42', 345, 150, 16),
      word('2,564.28', 540, 150, 64),
      word('SNUS', 80, 175, 36),
      word('24', 296, 175, 16),
      word('274', 342, 175, 24),
      word('5,460.00', 540, 175, 64),
      word('INVOICE', 80, 210, 60),
      word('TOTAL:', 145, 210, 50),
      word('13,134.09', 530, 210, 72),
    ]

    // A page of this table that carries no items, not a page without a table.
    const table = readColumnTable(page)
    expect(table?.headers[0]).toBe('ITEM')
    expect(table?.rows).toEqual([])

    const result = assembleReceipt(
      page,
      {
        reader: 'pdf text',
        watermarkSuppressed: false,
        watermarkPixelRatio: 0,
        sourceSize: { width: 700, height: 300 },
        timingsMs: {},
      },
      0.5,
    )
    expect(result.kind).toBe('table')
    expect(rowCells(result)).toEqual([])
    // Nothing is lost quietly. The recap is read as the table it is, under
    // titles of its own, rather than piled into the log a line at a time —
    // `LINES` and `UNITS` are two columns because the page prints a figure
    // under each. The total is not a row of it, so it stays in the log.
    expect(result.tables[1]).toMatchObject({
      headers: ['CATEGORY', 'DESCRIPTION', 'LINES', 'UNITS', 'YOUR COST'],
    })
    expect(result.tables[1]?.rows.map((row) => row.cells)).toEqual([
      ['JUUL', '', '4', '42', '2,564.28'],
      ['SNUS', '', '24', '274', '5,460.00'],
    ])
    expect(result.skipped.map(({ reason, text }) => [reason, text])).toEqual([
      ['summary', 'INVOICE  TOTAL:  13,134.09'],
    ])
  })

  it('still reads a pack settlement as settlements', () => {
    const words: WordBox[] = [
      word('Game-Pack', 20, 40, 80),
      word('Name', 220, 40, 40),
      word('Date', 460, 40, 36),
      word('Settled', 500, 40, 56),
      word('875-010840', 20, 80, 90),
      word('$500', 220, 80, 40),
      word('STACKED', 270, 80, 70),
      word('02/28/26', 460, 80, 70),
      word('833-129990', 20, 120, 90),
      word('200X', 220, 120, 40),
      word('CASH', 270, 120, 40),
      word('02/27/26', 460, 120, 70),
      word('881-023234', 20, 160, 90),
      word('GAME', 220, 160, 40),
      word('FOUR', 270, 160, 40),
      word('02/26/26', 460, 160, 70),
    ]
    const result = assembleReceipt(
      words,
      {
        reader: 'test',
        watermarkSuppressed: false,
        watermarkPixelRatio: 0,
        sourceSize: { width: 600, height: 400 },
        timingsMs: {},
      },
      0.5,
    )
    expect(result.kind).toBe('settlements')
    expect(result.settlements.map((row) => row.gamePack)).toEqual([
      '875-010840',
      '833-129990',
      '881-023234',
    ])
  })

  it('keeps a pack size out of the one-letter column beside it', () => {
    // A foodservice confirmation, at the 200 dpi the app reads a text layer
    // at. ITEM DESCRIPTION is titled over the left of text that runs to within
    // six pixels of TEMP, whose own values are a single letter; and the reason
    // for a quantity change, and the order's own P.O. field, are printed in
    // the table's own columns. Every size ran into TEMP, which read
    // `18-12-1. D`; the reason was glued onto the item numbers above it; and
    // the P.O. field was held as the first item's name and merged into it.
    const line = (
      y: number,
      cells: ReadonlyArray<readonly [text: string, x: number, right: number]>,
    ): WordBox[] =>
      cells.map(([text, x, right]) => ({ text, x, y, width: right - x, height: 23.8, confidence: 1 }))
    const table = readColumnTable([
      ...line(474, [['MFG', 78, 120], ['ITEM', 316, 372], ['ORDER', 1114, 1184], ['SHIP', 1212, 1268], ['UNIT', 1324, 1380]]),
      ...line(508, [['NUMBER', 78, 162], ['NUMBER', 316, 400], ['ITEM', 666, 724], ['DESCRIPTION', 731, 890], ['TEMP', 1044, 1100], ['QTY', 1128, 1170], ['QTY', 1212, 1254], ['PRICE', 1324, 1394]]),
      // The order's P.O. field, set in the first two columns one line above
      // the first item — exactly where a wrapped name would be.
      ...line(641, [['P.O.:', 64, 134], ['WEB6842382', 302, 442]]),
      // A size set after a double space, reaching under TEMP.
      ...line(674, [['768123', 64, 148], ['633383', 302, 386], ['LIV', 568, 614], ['FHE', 621, 667], ['BLUE', 674, 735], ['RASPBERRY', 742, 881], ['EX', 888, 918], ['18-12-1.', 946, 1065], ['D', 1071, 1086], ['2', 1142, 1156], ['2', 1212, 1226], ['$403.9200', 1268, 1394]]),
      // The same size a space after the name, so the line is one field.
      ...line(707, [['783188', 64, 148], ['743029', 302, 386], ['LIV', 568, 614], ['FHE', 621, 667], ['EXTRA', 674, 751], ['STRENGTH,', 758, 896], ['CH', 903, 934], ['18-12-1.', 941, 1064], ['D', 1071, 1086], ['1', 1142, 1156], ['1', 1212, 1226], ['$403.9200', 1268, 1394]]),
      ...line(1072, [['10033334', 64, 176], ['455422', 302, 386], ['PVM', 568, 614], ['AIR', 621, 667], ['AIRHEADS', 674, 797], ['SINGLES', 804, 912], ['W', 919, 934], ['12-36-0.', 941, 1064], ['D', 1071, 1086], ['1', 1142, 1156], ['0*', 1212, 1240], ['$82.0800', 1282, 1394]]),
      // The reason, indented into the gutter after the first column.
      ...line(1106, [['REASON', 204, 293], ['FOR', 300, 344], ['QUANTITY', 351, 470], ['ADJUSTMENT:', 476, 640], ['REPEATED', 646, 765], ['SUPPLIER', 772, 891], ['SHORTAGE', 897, 1016]]),
      ...line(1138, [['10033339', 64, 176], ['455428', 302, 386], ['PVM', 568, 614], ['AIR', 621, 667], ['AIRHEADS', 674, 797], ['SINGLES', 804, 912], ['W', 919, 934], ['12-36-0.', 941, 1064], ['D', 1071, 1086], ['1', 1142, 1156], ['1', 1212, 1226], ['$82.0800', 1282, 1394]]),
      // A unit after the size, the two of them a space apart.
      ...line(1172, [['61034403', 64, 176], ['757234', 302, 386], ['COL', 568, 616], ['AJX', 623, 671], ['AJAX', 678, 741], ['CLN', 748, 796], ['12/21OZ', 803, 915], ['N', 922, 938], ['12-21', 945, 1024], ['OZ', 1031, 1063], ['D', 1070, 1086], ['1', 1142, 1156], ['1', 1212, 1226], ['$14.4400', 1282, 1394]]),
      ...line(1238, [['2011506', 64, 162], ['498109', 302, 386], ['ASB', 568, 615], ['AGO', 622, 668], ['CORN', 675, 737], ['STARCH', 744, 838], ['12-16', 845, 922], ['OZ', 929, 960], ['D', 1072, 1086], ['10', 1128, 1156], ['10', 1198, 1226], ['$23.0400', 1282, 1394]]),
      // A one-letter unit, a space from both the size and the temperature.
      ...line(1304, [['302705', 64, 148], ['601558', 302, 386], ['MW', 568, 600], ['UBB', 608, 656], ['HB', 663, 696], ['SR', 703, 735], ['BLU', 743, 791], ['RASP', 798, 863], ['BBL', 870, 919], ['12-12-2', 926, 1039], ['O', 1047, 1063], ['D', 1070, 1086], ['1', 1142, 1156], ['1', 1212, 1226], ['$156.9600', 1268, 1394]]),
      ...line(1338, [['14843000', 64, 176], ['693401', 302, 386], ['GCD', 568, 614], ['BUL', 621, 667], ['BUGLES', 674, 766], ['CTC', 773, 819], ['CRISPY', 826, 918], ['6-3', 946, 992], ['OZ', 999, 1030], ['D', 1072, 1086], ['2', 1142, 1156], ['2', 1212, 1226], ['$10.9600', 1282, 1394]]),
    ])
    // The titles are stacked on two baselines a line pitch apart, further
    // than a word is tall: `MFG` over `NUMBER`, `ORDER` over `QTY`.
    expect(table?.headers).toEqual([
      'MFG NUMBER',
      'ITEM NUMBER',
      'ITEM DESCRIPTION',
      'TEMP',
      'ORDER QTY',
      'SHIP QTY',
      'UNIT PRICE',
    ])
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ['768123', '633383', 'LIV FHE BLUE RASPBERRY EX 18-12-1.', 'D', '2', '2', '$403.9200'],
      ['783188', '743029', 'LIV FHE EXTRA STRENGTH, CH 18-12-1.', 'D', '1', '1', '$403.9200'],
      ['10033334', '455422', 'PVM AIR AIRHEADS SINGLES W 12-36-0.', 'D', '1', '0*', '$82.0800'],
      ['10033339', '455428', 'PVM AIR AIRHEADS SINGLES W 12-36-0.', 'D', '1', '1', '$82.0800'],
      ['61034403', '757234', 'COL AJX AJAX CLN 12/21OZ N 12-21 OZ', 'D', '1', '1', '$14.4400'],
      ['2011506', '498109', 'ASB AGO CORN STARCH 12-16 OZ', 'D', '10', '10', '$23.0400'],
      ['302705', '601558', 'MW UBB HB SR BLU RASP BBL 12-12-2 O', 'D', '1', '1', '$156.9600'],
      ['14843000', '693401', 'GCD BUL BUGLES CTC CRISPY 6-3 OZ', 'D', '2', '2', '$10.9600'],
    ])
    // Neither the P.O. field nor the reason belongs to an item, and neither
    // is lost either.
    expect(table?.skipped.map((entry) => entry.text)).toEqual([
      'P.O.:  WEB6842382',
      'REASON FOR QUANTITY ADJUSTMENT: REPEATED SUPPLIER SHORTAGE',
    ])
  })

  it('parts a description from a size column set hard against it', () => {
    // A wholesale invoice set on a character grid. SIZE/FM is right-aligned
    // under its own title and DESCRIPTION runs up to it, so the longest
    // description and the widest size leave nine tenths of a pixel between
    // them — narrower than the narrowest strip a gutter search will take. The
    // edge stayed where the titles guessed it and cut the names in three:
    // `*ACME POD 5%` | `CLASSIC TIN $23.99 6/4CT`.
    //
    // The category headings and the banner are set to a measure of their own,
    // eleven characters into a description whose items start flush, and were
    // read as the end of the item above. A third of the items carry a `*`,
    // which sets them one character left of the rest; that alone had the
    // column reading as ragged, with no left edge to measure an indent from.
    //
    // The grid and the layout are the invoice's own; the items are invented.
    const PITCH = 19.21
    const GLYPH = 19.05
    const grid = (
      y: number,
      cells: ReadonlyArray<readonly [text: string, column: number]>,
    ): WordBox[] =>
      cells.map(([text, column]) => ({
        text,
        x: 66 + column * PITCH,
        y,
        width: text.length * GLYPH,
        height: 30.6,
        confidence: 1,
      }))
    const title = (
      y: number,
      cells: ReadonlyArray<readonly [text: string, x: number, right: number]>,
    ): WordBox[] =>
      cells.map(([text, x, right]) => ({ text, x, y, width: right - x, height: 22.2, confidence: 1 }))

    const table = readColumnTable([
      ...title(454, [
        ['ITEM', 110, 163],
        ['QTY', 251, 291],
        ['DESCRIPTION', 409, 555],
        ['SIZE/FM', 952, 1045],
        ['UPC', 1157, 1197],
        ['RETAIL', 1377, 1457],
      ]),
      // A banner across the table, set to the headings' own measure.
      ...grid(493, [
        ['********', 24],
        ['THANK', 34],
        ['YOU', 40],
        ['FOR', 44],
        ['YOUR', 48],
        ['ORDER', 53],
        ['********', 60],
      ]),
      // Starred: a character left of the rest. Its description ends at the
      // column the widest size begins in.
      ...grid(693, [
        ['374256', 0],
        ['18', 10],
        ['*ACME', 13],
        ['POD', 19],
        ['5%', 23],
        ['CLASSIC', 26],
        ['TIN', 34],
        ['$23.99', 38],
        ['6/4CT', 46],
        ['23.99', 68],
      ]),
      ...grid(726, [
        ['374793', 0],
        ['6', 11],
        ['ACME', 14],
        ['POD', 19],
        ['5%', 23],
        ['CLASSIC', 26],
        ['TIN', 34],
        ['1-PACK', 38],
        ['8/1CT', 46],
        ['108400482196', 52],
        ['55.75', 68],
      ]),
      // A category heading over the items that follow it.
      ...grid(826, [
        ['HARBOR', 24],
        ['FILTERED', 31],
        ['CIGARS', 40],
      ]),
      // The widest size: it begins where the longest description ends.
      ...grid(859, [
        ['240945', 0],
        ['5', 11],
        ['*HARBOR', 13],
        ['FILTERED', 21],
        ['CIGARS', 30],
        ['GRAPE', 37],
        ['10/20CT', 44],
        ['844504001480', 52],
        ['9.99', 69],
      ]),
      ...grid(893, [
        ['NOVA', 24],
        ['ELECTRONIC', 30],
      ]),
      ...grid(926, [
        ['345397', 0],
        ['9', 11],
        ['NOVA', 14],
        ['PLUS', 19],
        ['POUCH', 24],
        ['CITRS', 30],
        ['CHLL', 36],
        ['9MG', 41],
        ['5CT', 48],
        ['840170618281', 52],
        ['27.69', 68],
      ]),
    ])

    expect(table?.headers).toEqual(['ITEM', 'QTY', 'DESCRIPTION', 'SIZE/FM', 'UPC', 'RETAIL'])
    expect(table?.rows.map((row) => row.cells)).toEqual([
      ['374256', '18', '*ACME POD 5% CLASSIC TIN $23.99', '6/4CT', '', '23.99'],
      ['374793', '6', 'ACME POD 5% CLASSIC TIN 1-PACK', '8/1CT', '108400482196', '55.75'],
      ['240945', '5', '*HARBOR FILTERED CIGARS GRAPE', '10/20CT', '844504001480', '9.99'],
      ['345397', '9', 'NOVA PLUS POUCH CITRS CHLL 9MG', '5CT', '840170618281', '27.69'],
    ])
    // The headings and the banner belong to no item, and are not lost either.
    // The banner's trailing rule falls in a column of its own, where a cell of
    // pure punctuation is not a cell; what it says is kept.
    expect(table?.skipped.map((entry) => entry.text)).toEqual([
      '******** THANK YOU FOR YOUR ORDER',
      'HARBOR FILTERED CIGARS',
      'NOVA ELECTRONIC',
    ])
  })
})
