import { describe, expect, it } from 'vitest'

import { toCsv, toDocumentJson, type ExportPage } from './export'
import { toPublicJson, withCell } from '../ocr/receipt/assemble'
import type { OcrResult } from '../ocr/types'

function table(headers: string[], rows: string[][], extra: Partial<OcrResult> = {}): OcrResult {
  return {
    kind: 'table',
    headers,
    rows: [],
    settlements: [],
    fields: [],
    tableRows: rows.map((cells) => ({ cells, confidence: 1 })),
    validation: [],
    processingMeta: {
      reader: 'pdf text',
      watermarkSuppressed: false,
      watermarkPixelRatio: 0,
      wordCount: 0,
      sourceSize: { width: 1700, height: 2200 },
      timingsMs: {},
      totalMs: 0,
      warnings: [],
    },
    ...extra,
  }
}

const HEADERS = ['QTY', 'DESCRIPTION', 'PRICE']

describe('toDocumentJson', () => {
  it('exports one page exactly as the page reads', () => {
    const result = table(HEADERS, [['1', 'MINT SNUFF', '31.20']], { title: 'Invoice # 1001' })
    expect(toDocumentJson([{ page: 1, result }], 1)).toEqual(toPublicJson(result))
  })

  it('exports every page as one table, each row with its page', () => {
    const pages: ExportPage[] = [
      { page: 1, result: table(HEADERS, [['1', 'MINT SNUFF', '31.20'], ['2', 'LEAF BAG', '17.35']], { title: 'Invoice # 1001' }) },
      { page: 2, result: table(HEADERS, [['1', 'HERB CAN', '52.40']]) },
    ]
    expect(toDocumentJson(pages, 2)).toEqual({
      kind: 'table',
      title: 'Invoice # 1001',
      pages: 2,
      headers: HEADERS,
      rows: [
        { page: 1, QTY: '1', DESCRIPTION: 'MINT SNUFF', PRICE: '31.20' },
        { page: 1, QTY: '2', DESCRIPTION: 'LEAF BAG', PRICE: '17.35' },
        { page: 2, QTY: '1', DESCRIPTION: 'HERB CAN', PRICE: '52.40' },
      ],
    })
  })

  it('carries each page’s edits and its label rows', () => {
    const second = table(HEADERS, [['', '***DAMAGED IN TRANSIT***', ''], ['-1', 'LEAF BAG', '6.15']])
    second.tableRows[0]!.label = true
    const pages: ExportPage[] = [
      { page: 1, result: withCell(table(HEADERS, [['1', 'MINT SNUF', '31.20']]), 0, 1, 'MINT SNUFF') },
      { page: 2, result: second },
    ]
    expect(toDocumentJson(pages, 2)?.rows).toEqual([
      { page: 1, QTY: '1', DESCRIPTION: 'MINT SNUFF', PRICE: '31.20' },
      { page: 2, QTY: '', DESCRIPTION: '***DAMAGED IN TRANSIT***', PRICE: '' },
      { page: 2, QTY: '-1', DESCRIPTION: 'LEAF BAG', PRICE: '6.15' },
    ])
  })

  it('says so when the pages are different kinds of table', () => {
    const invoice: OcrResult = { ...table(['label', 'value'], []), kind: 'invoice' }
    const json = toDocumentJson(
      [
        { page: 1, result: table(HEADERS, [['1', 'MINT SNUFF', '31.20']]) },
        { page: 2, result: { ...invoice, fields: [{ label: 'TOTAL DUE', value: '31.20', confidence: 1 }] } },
      ],
      2,
    )
    expect(json?.kind).toBe('mixed')
    expect(json?.headers).toEqual([...HEADERS, 'label', 'value'])
  })

  it('has nothing to export before any page is read', () => {
    expect(toDocumentJson([], 3)).toBeNull()
    expect(toCsv([], 3)).toBe('')
  })
})

describe('toCsv', () => {
  it('writes one page as before, without a page column', () => {
    const result = table(HEADERS, [['1', 'MINT SNUFF, ROLL', '31.20']])
    expect(toCsv([{ page: 1, result }], 1)).toBe('QTY,DESCRIPTION,PRICE\r\n1,"MINT SNUFF, ROLL",31.20')
  })

  it('writes every page under one header with the page first', () => {
    const csv = toCsv([
      { page: 1, result: table(HEADERS, [['1', 'CAN "BLUE"', '31.20']]) },
      { page: 2, result: table(HEADERS, [['2', 'LEAF BAG', '17.35']]) },
    ], 2)
    expect(csv.split('\r\n')).toEqual([
      'Page,QTY,DESCRIPTION,PRICE',
      '1,1,"CAN ""BLUE""",31.20',
      '2,2,LEAF BAG,17.35',
    ])
  })

  it('keeps two columns that share a title', () => {
    const headers = ['QTY', 'DESCRIPTION', 'PRICE', 'PRICE']
    const csv = toCsv([
      { page: 1, result: table(headers, [['2', 'LEAF BAG', '17.35', '34.70']]) },
      { page: 2, result: table(headers, [['1', 'HERB CAN', '52.40', '52.40']]) },
    ], 2)
    expect(csv.split('\r\n')).toEqual([
      'Page,QTY,DESCRIPTION,PRICE,PRICE',
      '1,2,LEAF BAG,17.35,34.70',
      '2,1,HERB CAN,52.40,52.40',
    ])
  })

  it('puts each cell under its own title when a page is set out differently', () => {
    const csv = toCsv([
      { page: 1, result: table(HEADERS, [['1', 'MINT SNUFF', '31.20']]) },
      { page: 2, result: table(['DESCRIPTION', 'QTY', 'AMOUNT'], [['HERB CAN', '1', '52.40']]) },
    ], 2)
    expect(csv.split('\r\n')).toEqual([
      'Page,QTY,DESCRIPTION,PRICE,AMOUNT',
      '1,1,MINT SNUFF,31.20,',
      '2,1,HERB CAN,,52.40',
    ])
  })

  it('names the page column apart from a printed Page column', () => {
    const headers = ['Page', 'DESCRIPTION']
    const csv = toCsv([
      { page: 1, result: table(headers, [['A1', 'MINT SNUFF']]) },
      { page: 2, result: table(headers, [['A2', 'HERB CAN']]) },
    ], 2)
    expect(csv.split('\r\n')[0]).toBe('PDF Page,Page,DESCRIPTION')
  })
})

describe('exporting part of a longer document', () => {
  it('keeps the document’s shape when only one of its pages was read, and names the rest', () => {
    const json = toDocumentJson([{ page: 3, result: table(HEADERS, [['1', 'HERB CAN', '52.40']]) }], 5)
    expect(json).toEqual({
      kind: 'table',
      pages: 5,
      missingPages: [1, 2, 4, 5],
      headers: HEADERS,
      rows: [{ page: 3, QTY: '1', DESCRIPTION: 'HERB CAN', PRICE: '52.40' }],
    })
    expect(toCsv([{ page: 3, result: table(HEADERS, [['1', 'HERB CAN', '52.40']]) }], 5).split('\r\n')).toEqual([
      'Page,QTY,DESCRIPTION,PRICE',
      '3,1,HERB CAN,52.40',
    ])
  })

  it('lets a blank page say nothing about the table’s kind or columns', () => {
    const blank: OcrResult = { ...table(['Game', 'Name', 'Int', 'Rec', 'Act', 'Set'], []), kind: 'inventory' }
    const pages: ExportPage[] = [
      { page: 1, result: table(HEADERS, [['1', 'MINT SNUFF', '31.20']]) },
      { page: 2, result: blank },
    ]
    const json = toDocumentJson(pages, 2)
    expect(json?.kind).toBe('table')
    expect(json?.headers).toEqual(HEADERS)
    expect(toCsv(pages, 2).split('\r\n')[0]).toBe('Page,QTY,DESCRIPTION,PRICE')
  })
})

describe('columns that could collide', () => {
  it('keeps both columns of a repeated title in JSON', () => {
    const headers = ['QTY', 'PRICE', 'PRICE']
    const json = toDocumentJson(
      [
        { page: 1, result: table(headers, [['2', '17.35', '34.70']]) },
        { page: 2, result: table(headers, [['1', '52.40', '52.40']]) },
      ],
      2,
    )
    expect(json?.headers).toEqual(['QTY', 'PRICE', 'PRICE (2)'])
    expect(json?.rows[0]).toEqual({ page: 1, QTY: '2', PRICE: '17.35', 'PRICE (2)': '34.70' })
  })

  it('does not let a printed page column overwrite the page number', () => {
    const headers = ['page', 'DESCRIPTION']
    const json = toDocumentJson(
      [
        { page: 1, result: table(headers, [['A1', 'MINT SNUFF']]) },
        { page: 2, result: table(headers, [['A2', 'HERB CAN']]) },
      ],
      2,
    )
    expect(json?.rows).toEqual([
      { pdfPage: 1, page: 'A1', DESCRIPTION: 'MINT SNUFF' },
      { pdfPage: 2, page: 'A2', DESCRIPTION: 'HERB CAN' },
    ])
  })

  it('keeps a cell the page printed no title for', () => {
    // A settlements page whose `Date Settled` title was not read still has dates.
    const settled = (gamePack: string, name: string, dateSettled: string): OcrResult => ({
      ...table(['Game-Pack', 'Name'], []),
      kind: 'settlements',
      settlements: [{ gamePack, name, dateSettled, confidence: 1 }],
    })
    const csv = toCsv(
      [
        { page: 1, result: settled('875-010840', 'STACKED', '02/28/26') },
        { page: 2, result: settled('833-129990', 'CASH', '02/27/26') },
      ],
      2,
    )
    expect(csv.split('\r\n')).toEqual([
      'Page,Game-Pack,Name,Column 3',
      '1,875-010840,STACKED,02/28/26',
      '2,833-129990,CASH,02/27/26',
    ])
  })
})
