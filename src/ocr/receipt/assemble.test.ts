import { describe, expect, it } from 'vitest'

import type { OcrResult } from '../types'
import { extractReceiptTitle, toPublicJson, withCell } from './assemble'

const settlements: OcrResult = {
  kind: 'settlements',
  headers: ['Game-Pack', 'Name', 'Date Settled'],
  rows: [],
  settlements: [
    { gamePack: '875-010840', name: '$500 STACKED', dateSettled: '02/28/26', confidence: 0.9 },
    { gamePack: '833-129990', name: '200X THE CASH', dateSettled: '', confidence: 0.9 },
  ],
  fields: [],
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
})
