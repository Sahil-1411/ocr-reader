import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'

import { textItemsToWords, type PdfTextRun } from './pdf-text'
import type { ColumnGuide } from '../ocr/layout/columns'
import { assembleReceipt } from '../ocr/receipt/assemble'
import type { OcrResult } from '../ocr/types'

const require = createRequire(import.meta.url)
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
).href

/** A PDF with one page per content stream, and `/F1` bound to `font`. */
function pdfFrom(streams: readonly string[], font = 'Helvetica'): Uint8Array {
  const pages = streams.map((_, index) => 4 + index * 2)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`,
    ...streams.flatMap((stream, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ]),
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new TextEncoder().encode(body)
}

function invoicePdf(): Uint8Array {
  return pdfFrom([
    [
      'BT',
      '/F1 11 Tf',
      '1 0 0 1 36 720 Tm (CASE QTY) Tj',
      '1 0 0 1 110 720 Tm (UNT QTY) Tj',
      '1 0 0 1 190 720 Tm (ITEM PART#) Tj',
      '1 0 0 1 310 720 Tm (UPC) Tj',
      '1 0 0 1 400 720 Tm (DESCRIPTION) Tj',
      '1 0 0 1 520 720 Tm (EXTENDED) Tj',
      '1 0 0 1 40 700 Tm (2) Tj',
      '1 0 0 1 116 700 Tm (24) Tj',
      '1 0 0 1 190 700 Tm (849-1706888) Tj',
      '1 0 0 1 300 700 Tm (012345678905) Tj',
      '1 0 0 1 400 700 Tm (WIDGET NAME) Tj',
      '1 0 0 1 520 700 Tm (48.00) Tj',
      '1 0 0 1 40 680 Tm (1) Tj',
      '1 0 0 1 116 680 Tm (6) Tj',
      '1 0 0 1 190 680 Tm (674-806801) Tj',
      '1 0 0 1 300 680 Tm (098765432109) Tj',
      '1 0 0 1 400 680 Tm (BIG ISLAND) Tj',
      '1 0 0 1 520 680 Tm (19.50) Tj',
      'ET',
    ].join('\n'),
  ])
}

/**
 * Pages from a line-printer invoice: Courier on a fixed character grid, each
 * word its own text object at its own column, the way such systems export.
 * Each page is its lines as printed, one string per line, spaces and all.
 */
function gridPdf(...pages: ReadonlyArray<readonly string[]>): Uint8Array {
  const size = 9.12
  const advance = size * 0.6
  const streams = pages.map((lines) => {
    const ops = ['BT', `/F1 ${size} Tf`]
    lines.forEach((line, row) => {
      const baseline = 720 - row * 10.32
      for (const match of line.matchAll(/\S+/g)) {
        const x = 11.04 + (match.index ?? 0) * advance
        ops.push(`1 0 0 1 ${x.toFixed(2)} ${baseline.toFixed(2)} Tm (${match[0]}) Tj`)
      }
    })
    ops.push('ET')
    return ops.join('\n')
  })
  return pdfFrom(streams, 'Courier')
}

/**
 * Read every page's text layer the way the app does, at its 200 dpi, with a
 * table's columns carried to the next page as the app carries them.
 */
async function readPages(data: Uint8Array): Promise<OcrResult[]> {
  const pdf = await getDocument({ data, disableFontFace: true }).promise
  const results: OcrResult[] = []
  let guide: ColumnGuide | null = null
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number)
    const viewport = page.getViewport({ scale: 200 / 72 })
    const text = await page.getTextContent()
    const runs: PdfTextRun[] = []
    for (const item of text.items) {
      if (!('str' in item) || !item.str) continue
      runs.push({
        str: item.str,
        transform: item.transform.map((value: number) => Number(value) || 0),
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
      })
    }
    const words = textItemsToWords(runs, viewport.transform)
    const result = assembleReceipt(
      words,
      {
        reader: 'pdf text',
        watermarkSuppressed: false,
        watermarkPixelRatio: 0,
        sourceSize: { width: viewport.width, height: viewport.height },
        timingsMs: {},
      },
      0.5,
      guide,
    )
    if (result.kind === 'table' && result.columnBounds?.length === result.headers.length) {
      guide = { headers: result.headers, bounds: result.columnBounds }
    }
    results.push(result)
  }
  return results
}

async function readPdf(data: Uint8Array): Promise<OcrResult> {
  const [first] = await readPages(data)
  if (!first) throw new Error('the PDF has no pages')
  return first
}

/**
 * One item line on that grid: quantities and prices right-aligned under their
 * titles, the name from column 26.
 */
function gridItem(order: string, ship: string, name: string, unit: string, extended: string): string {
  const line = Array.from({ length: 102 }, () => ' ')
  const put = (text: string, at: number) => {
    ;[...text].forEach((char, index) => {
      line[at + index] = char
    })
  }
  put(order, 6 - order.length)
  put(ship, 14 - ship.length)
  put(name, 26)
  put(unit, 86 - unit.length)
  put(extended, 102 - extended.length)
  return line.join('').trimEnd()
}

/** A line of text starting at `column` on the grid. */
function gridText(column: number, text: string): string {
  return `${' '.repeat(column)}${text}`
}

const GRID_HEADER = [
  ' ORDER   SHIP             DESCRIPTION                                              UNIT       EXTENDED',
  '  QTY    QTY                                                                       PRICE        PRICE',
]

describe('pdf text layer invoice', () => {
  it('reads positioned invoice cells into the response columns', async () => {
    const result = await readPdf(invoicePdf())
    expect(result.kind).toBe('table')
    expect(result.tableRows.map((row) => row.cells)).toEqual([
      ['2', '24', '849-1706888', '012345678905', 'WIDGET NAME', '48.00'],
      ['1', '6', '674-806801', '098765432109', 'BIG ISLAND', '19.50'],
    ])
  })

  it('reads a line-printer invoice exactly as printed', async () => {
    // The DESCRIPTION title is one short word at the far left of text that runs
    // half the page, so edges taken from the titles alone cut through it: every
    // code printed after a double space landed under UNIT PRICE. The banner and
    // the notes under the last item were glued onto it, and `32S -120` lost
    // its space. All the items are invented; only the layout is real.
    const result = await readPdf(
      gridPdf([
        ...GRID_HEADER,
        gridItem('1', '1', 'MINT SNUFF ROLL5 #40117', '31.20', '31.20'),
        gridItem('1', '1', 'HERB CAN  #508812', '52.40', '52.40'),
        gridItem('2', '2', 'GOLD LEAF RED 16 OZ BAG  #201', '17.35', '34.70'),
        gridItem('2', '2', 'GOLD LEAF RED 6 OZ BAG  #207', '6.15', '12.30'),
        gridItem('2', '2', 'ROLLING PAPER 32S -120 COUNT  # 47011002', '22.80', '45.60'),
        gridItem('1', '1', 'PALMA LEAF  4/5 PK #66120', '28.90', '28.90'),
        gridItem('1', '1', 'ROBUSTO 1200CC  BX20', '180.50', '180.50'),
        gridText(28, '$12.00   OFF ROBUSTO 1200CC  BX20'),
        gridItem('10', '10', 'FILTER TUBES 200 COUNT SLV4 #FT200', '9.75', '97.50'),
        gridItem('1', '1', 'CEDAR BOX TORO MADURO GORDO RESERVE BX20', '214.60', '214.60'),
        gridText(16, '-------***-----NEW PRICES------***--------'),
        gridText(16, '09/01 PRICE CHANGES ON ALL CEDAR, ROBUSTO, PALMA AND LEAF ITEMS,'),
        '',
        gridText(20, '***  C O N T I N U E D  N E X T  P A G E  ***'),
      ]),
    )
    expect(result.kind).toBe('table')
    expect(result.headers).toEqual(['ORDER QTY', 'SHIP QTY', 'DESCRIPTION', 'UNIT PRICE', 'EXTENDED PRICE'])
    expect(result.tableRows.map((row) => row.cells)).toEqual([
      ['1', '1', 'MINT SNUFF ROLL5 #40117', '31.20', '31.20'],
      ['1', '1', 'HERB CAN #508812', '52.40', '52.40'],
      ['2', '2', 'GOLD LEAF RED 16 OZ BAG #201', '17.35', '34.70'],
      ['2', '2', 'GOLD LEAF RED 6 OZ BAG #207', '6.15', '12.30'],
      ['2', '2', 'ROLLING PAPER 32S -120 COUNT # 47011002', '22.80', '45.60'],
      ['1', '1', 'PALMA LEAF 4/5 PK #66120', '28.90', '28.90'],
      ['1', '1', 'ROBUSTO 1200CC BX20 $12.00 OFF ROBUSTO 1200CC BX20', '180.50', '180.50'],
      ['10', '10', 'FILTER TUBES 200 COUNT SLV4 #FT200', '9.75', '97.50'],
      ['1', '1', 'CEDAR BOX TORO MADURO GORDO RESERVE BX20', '214.60', '214.60'],
    ])
  })

  it('reads a last page that holds a single item', async () => {
    const result = await readPdf(
      gridPdf([
        ...GRID_HEADER,
        gridItem('1', '1', 'HERB CAN  #508812', '52.40', '52.40'),
        '',
        `${gridText(18, 'THANK YOU FOR YOUR ORDER').padEnd(74)}TOTAL AMOUNT${'52.40'.padStart(16)}`,
      ]),
    )
    expect(result.kind).toBe('table')
    expect(result.tableRows.map((row) => row.cells)).toEqual([
      ['1', '1', 'HERB CAN #508812', '52.40', '52.40'],
    ])
  })

  it('reads a page without a header by the columns of the page before', async () => {
    // Page 1's names are short, so nothing on it says how far a name may
    // run. Page 2 has no titles of its own and longer names, codes after a
    // double space among them; they stay names.
    const [first, second] = await readPages(
      gridPdf(
        [
          ...GRID_HEADER,
          gridItem('1', '1', 'MINT SNUFF', '31.20', '31.20'),
          gridItem('2', '2', 'LEAF BAG', '17.35', '34.70'),
        ],
        [
          gridItem('1', '1', 'HERB BLUE CAN  #508812', '52.40', '52.40'),
          gridItem('1', '1', 'WINTER MINT LONG CUT TOBACCO POUCH  #60431', '5.85', '5.85'),
          gridItem('10', '10', 'FILTER TUBES 200 COUNT SLV4 #FT200', '9.75', '97.50'),
        ],
      ),
    )
    expect(first?.kind).toBe('table')
    expect(second?.kind).toBe('table')
    expect(second?.tableRows.map((row) => row.cells)).toEqual([
      ['1', '1', 'HERB BLUE CAN #508812', '52.40', '52.40'],
      ['1', '1', 'WINTER MINT LONG CUT TOBACCO POUCH #60431', '5.85', '5.85'],
      ['10', '10', 'FILTER TUBES 200 COUNT SLV4 #FT200', '9.75', '97.50'],
    ])
  })

  it('keeps each line printed among the items where it belongs', async () => {
    const result = await readPdf(
      gridPdf([
        ...GRID_HEADER,
        gridItem('2', '2', 'DESK LAMP LED 20/40CT', '4.15', '8.30'),
        // The rest of the name.
        gridText(26, 'ASSORTED COLORS'),
        gridItem('1', '1', 'ROBUSTO 1200CC  BX20', '180.50', '180.50'),
        // Part of the item's name too, indented under it.
        gridText(28, '$12.00   OFF ROBUSTO 1200CC  BX20'),
        // Its own amount: a row of its own, not added to the item's figures.
        `${gridText(26, 'MFG COUPON $1.00 OFF')}${' '.repeat(50)}-1.00`,
        // The reason for the credit below: a label, not the end of the coupon.
        gridText(26, '***DAMAGED IN TRANSIT***'),
        gridItem('-1', '-1', 'LEAF BAG  #207', '6.15', '-6.15'),
        // An item, whatever it is called.
        gridItem('1', '1', 'DISCONTINUED PAGE MARKERS', '3.60', '3.60'),
        // A total, a note after a blank line, and a banner: none of them items.
        gridText(26, 'TOTAL CASES 5'),
        '',
        gridText(26, 'ALL SALES FINAL - NO RETURNS'),
        gridText(20, '***  C O N T I N U E D  T O  N E X T  P A G E  ***'),
      ]),
    )
    expect(result.tableRows.map((row) => [row.cells, row.label ?? false])).toEqual([
      [['2', '2', 'DESK LAMP LED 20/40CT ASSORTED COLORS', '4.15', '8.30'], false],
      [['1', '1', 'ROBUSTO 1200CC BX20 $12.00 OFF ROBUSTO 1200CC BX20', '180.50', '180.50'], false],
      [['', '', 'MFG COUPON $1.00 OFF', '', '-1.00'], false],
      [['', '', '***DAMAGED IN TRANSIT***', '', ''], true],
      [['-1', '-1', 'LEAF BAG #207', '6.15', '-6.15'], false],
      [['1', '1', 'DISCONTINUED PAGE MARKERS', '3.60', '3.60'], false],
    ])
  })
})
