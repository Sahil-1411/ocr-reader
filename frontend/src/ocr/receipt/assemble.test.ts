import { describe, expect, it } from 'vitest'

import type { OcrResult } from '../types'
import { assembleReceipt, extractReceiptTitle, toPublicJson, withCell } from './assemble'

const settlements: OcrResult = {
  kind: 'settlements',
  headers: ['Game-Pack', 'Name', 'Date Settled'],
  rows: [],
  settlements: [
    { gamePack: '875-010840', name: '$500 STACKED', dateSettled: '02/28/26', confidence: 0.9 },
    { gamePack: '833-129990', name: '200X THE CASH', dateSettled: '', confidence: 0.9 },
  ],
  fields: [],
  tableRows: [],
  validation: [],
  processingMeta: {
    reader: 'python',
    watermarkSuppressed: false,
    watermarkPixelRatio: 0,
    sourceSize: { width: 1, height: 1 },
    wordCount: 0,
    timingsMs: {},
    totalMs: 0,
    warnings: [],
  },
}

describe('withCell', () => {
  it('fills a missing cell and the JSON carries it', () => {
    const edited = withCell(settlements, 1, 2, '02/26/26')
    expect(toPublicJson(edited).rows[1]).toEqual({
      'Game-Pack': '833-129990',
      Name: '200X THE CASH',
      'Date Settled': '02/26/26',
    })
    expect(settlements.settlements[1]?.dateSettled).toBe('')
  })

  it('leaves the other rows untouched', () => {
    const edited = withCell(settlements, 1, 0, '833-129991')
    expect(edited.settlements[0]).toBe(settlements.settlements[0])
  })
})

describe('extractReceiptTitle', () => {
  it('extracts WEEKLY PACK SETTLEMENTS from settlement words', () => {
    const words = [
      { text: 'Arkansas', x: 300, y: 100, width: 200, height: 50, confidence: 0.95 },
      { text: 'Scholarship', x: 290, y: 160, width: 130, height: 40, confidence: 0.95 },
      { text: 'Lottery', x: 430, y: 160, width: 80, height: 40, confidence: 0.95 },
      { text: 'Retailer:', x: 300, y: 220, width: 100, height: 30, confidence: 0.95 },
      { text: '401243', x: 410, y: 220, width: 90, height: 30, confidence: 0.95 },
      { text: 'WEEKLY', x: 120, y: 280, width: 150, height: 50, confidence: 0.96 },
      { text: 'PACK', x: 290, y: 280, width: 100, height: 50, confidence: 0.96 },
      { text: 'SETTLEMENTS', x: 410, y: 280, width: 280, height: 50, confidence: 0.96 },
    ]
    expect(extractReceiptTitle(words, 'settlements')).toBe('WEEKLY PACK SETTLEMENTS')
  })

  it('extracts INSTANT INVENTORY SUMMARY from inventory words', () => {
    const words = [
      { text: 'Retailer:', x: 300, y: 100, width: 100, height: 30, confidence: 0.95 },
      { text: 'INSTANT', x: 60, y: 160, width: 120, height: 45, confidence: 0.95 },
      { text: 'INVENTORY', x: 200, y: 160, width: 160, height: 45, confidence: 0.95 },
      { text: 'SUMMARY', x: 380, y: 160, width: 140, height: 45, confidence: 0.95 },
    ]
    expect(extractReceiptTitle(words, 'inventory')).toBe('INSTANT INVENTORY SUMMARY')
  })

  it('uses the invoice number when the address shares that line', () => {
    const words = [
      { text: '1471', x: 40, y: 40, width: 40, height: 16, confidence: 1 },
      { text: 'E.', x: 86, y: 40, width: 16, height: 16, confidence: 1 },
      { text: '9', x: 108, y: 40, width: 12, height: 16, confidence: 1 },
      { text: 'Mile', x: 126, y: 40, width: 36, height: 16, confidence: 1 },
      { text: 'Rd.', x: 168, y: 40, width: 28, height: 16, confidence: 1 },
      { text: 'Invoice#:', x: 420, y: 40, width: 80, height: 16, confidence: 1 },
      { text: '476147ÍO]O', x: 508, y: 40, width: 90, height: 16, confidence: 1 },
    ]
    expect(extractReceiptTitle(words, 'table')).toBe('Invoice # 476147')
  })

  it('keeps WEEKLY INVOICE when the date range shares that line', () => {
    const words = [
      { text: 'Feb', x: 40, y: 20, width: 30, height: 16, confidence: 1 },
      { text: 'Mon.', x: 76, y: 20, width: 36, height: 16, confidence: 1 },
      { text: '23.', x: 118, y: 20, width: 24, height: 16, confidence: 1 },
      { text: 'WEEKLY', x: 160, y: 20, width: 70, height: 16, confidence: 1 },
      { text: 'INVOICE', x: 236, y: 20, width: 80, height: 16, confidence: 1 },
      { text: 'Arkansas', x: 330, y: 20, width: 80, height: 16, confidence: 1 },
      { text: '2026', x: 416, y: 20, width: 40, height: 16, confidence: 1 },
    ]
    expect(extractReceiptTitle(words, 'invoice')).toBe('WEEKLY INVOICE')
  })
})

describe('assembleReceipt settlement headers', () => {
  it('keeps Name apart from Game-Pack when the column gap is only a word space', () => {
    const word = (text: string, x: number, y: number, width: number) => ({
      text,
      x,
      y,
      width,
      height: 28,
      confidence: 0.97,
    })
    const result = assembleReceipt(
      [
        word('Game-Pack', 69, 649, 139),
        word('Name', 228, 649, 72),
        word('Date', 577, 647, 59),
        word('Settled', 651, 647, 88),
        word('879-008949', 64, 684, 154),
        word('MEGA', 230, 684, 72),
        word('CASH', 310, 684, 62),
        word('CROSSWORD', 387, 684, 163),
        word('02/23/26', 579, 686, 110),
        word('862-021236', 63, 722, 152),
        word('MAYHEM', 228, 722, 80),
        word('02/23/26', 575, 724, 113),
        word('881-023234', 62, 762, 156),
        word('DIAMONDS', 230, 762, 90),
        word('02/23/26', 578, 764, 110),
      ],
      {
        reader: 'tesseract',
        watermarkSuppressed: false,
        watermarkPixelRatio: 0,
        sourceSize: { width: 805, height: 2000 },
        timingsMs: {},
      },
      0.5,
    )
    expect(result.kind).toBe('settlements')
    expect(result.headers).toEqual(['Game-Pack', 'Name', 'Date Settled'])
  })
})

describe('assembleReceipt weekly invoice photos', () => {
  it('stays a label and amount table when the page names the weekly lines', () => {
    const word = (text: string, x: number, y: number, width = 40) => ({
      text,
      x,
      y,
      width,
      height: 14,
      confidence: 0.95,
    })
    const result = assembleReceipt(
      [
        word('WEEKLY', 40, 20, 70),
        word('INVOICE', 116, 20, 80),
        word('QTY', 40, 60, 30),
        word('PACK', 90, 60, 40),
        word('TOTAL', 150, 60, 50),
        word('FWD', 40, 100, 30),
        word('BALANCE', 76, 100, 70),
        word('0.00', 400, 100, 40),
        word('ON-LINE', 40, 130, 60),
        word('NET', 106, 130, 30),
        word('DUE', 142, 130, 30),
        word('1381.74', 380, 130, 60),
        word('INSTANT', 40, 160, 60),
        word('NET', 106, 160, 30),
        word('DUE', 142, 160, 30),
        word('2782.43', 380, 160, 60),
      ],
      {
        reader: 'tesseract',
        watermarkSuppressed: false,
        watermarkPixelRatio: 0,
        sourceSize: { width: 500, height: 800 },
        timingsMs: {},
      },
      0.5,
    )
    expect(result.kind).toBe('invoice')
    expect(result.headers).toEqual(['label', 'value'])
    expect(result.title).toBe('WEEKLY INVOICE')
    expect(toPublicJson(result).rows[0]).toEqual({ label: 'FWD BALANCE', value: '0.00' })
  })
})
