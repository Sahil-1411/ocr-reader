import { describe, expect, it } from 'vitest'

import type { OcrResult } from '../types'
import { toPublicJson, withCell } from './assemble'

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
