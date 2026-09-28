import { describe, expect, it } from 'vitest'

import { validateInventory, validateInvoice, validateSettlements } from './validate'
import type { InventoryRow, ReceiptField, SettlementRow } from '../types'

function inv(
  game: string,
  int: string,
  rec: string,
  act: string,
  set: string,
  name = 'GAME',
): InventoryRow {
  return { game, name, int, rec, act, set, confidence: 0.9 }
}

function field(label: string, value: string): ReceiptField {
  return { label, value, confidence: 0.9 }
}

function settlement(gamePack: string): SettlementRow {
  return { gamePack, name: 'GAME', dateSettled: '02/23/26', confidence: 0.9 }
}

describe('validateInventory', () => {
  it('passes when every column adds up to the TOTALS row', () => {
    const rows = [
      inv('882', '003', '000', '000', '000'),
      inv('883', '003', '000', '000', '001'),
      inv('', '006', '000', '000', '001', 'TOTALS'),
    ]
    expect(validateInventory(rows)).toEqual([])
  })

  it('reports the column that does not add up, and blames the unreadable row', () => {
    const rows = [
      inv('882', '003', '000', '000', '000'),
      // The watermark ate this count, so the column can no longer be summed.
      inv('883', '00S', '000', '000', '001'),
      inv('', '006', '000', '000', '001', 'TOTALS'),
    ]
    const issues = validateInventory(rows)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('inventory-totals')
    expect(issues[0]?.message).toContain('adds up to 3')
    expect(issues[0]?.message).toContain('TOTALS row says 6')
    // Points at the unreadable row rather than at TOTALS.
    expect(issues[0]?.rows).toEqual([1])
  })

  it('stays quiet when the page has no TOTALS row to check against', () => {
    expect(validateInventory([inv('882', '003', '000', '000', '000')])).toEqual([])
  })
})

describe('validateSettlements', () => {
  it('passes when the row count matches the printed total', () => {
    expect(validateSettlements([settlement('862-021236')], 1)).toEqual([])
  })

  it('reports how many rows are missing', () => {
    const issues = validateSettlements([settlement('862-021236')], 3)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('settlements-count')
    expect(issues[0]?.message).toContain('settles 3 packs but 1 rows were read')
    expect(issues[0]?.message).toContain('2 rows are missing')
  })

  it('stays quiet when the footer total was not read', () => {
    expect(validateSettlements([settlement('862-021236')], null)).toEqual([])
  })
})

describe('validateInvoice', () => {
  /** The real header block from public/samples/weekly-invoice.jpg. */
  const header = (total: string, instant = '2,782.43') => [
    field('FWD BALANCE', '0.00'),
    field('ON-LINE NET DUE', '1381.74'),
    field('INSTANT NET DUE', instant),
    field('NON-GAME ADJUSTMENTS', '0.00'),
    field('SYSTEM FEE', '5.00'),
    field('OTHER RETAILER INCENTIVES', '0.00'),
    field('TOTAL DUE BY WED', total),
  ]

  it('passes on the real header figures', () => {
    expect(validateInvoice(header('4169.17'))).toEqual([])
  })

  it('catches a misread digit in the header block', () => {
    // 2,762.43 instead of 2,782.43 — the error the watermark actually produced.
    const issues = validateInvoice(header('4169.17', '2762.43'))
    expect(issues.map((i) => i.code)).toContain('invoice-total')
    expect(issues[0]?.message).toContain('4149.17')
    expect(issues[0]?.message).toContain('4169.17')
  })

  it('catches a section footer that disagrees with its header line', () => {
    const issues = validateInvoice([
      ...header('4169.17'),
      field('Instant Net Due', '2762.43'),
    ])
    const section = issues.find((i) => i.code === 'invoice-section-total')
    expect(section).toBeDefined()
    expect(section?.message).toContain('2782.43')
    expect(section?.message).toContain('2762.43')
  })

  it('accepts a section footer that agrees', () => {
    const issues = validateInvoice([...header('4169.17'), field('Instant Net Due', '2,782.43')])
    expect(issues).toEqual([])
  })

  it('stays quiet when a header line is missing rather than wrong', () => {
    // A missing line and a misread one look identical to a sum, so the check
    // has to abstain rather than report a total that is merely incomplete.
    const rows = header('4169.17').filter((f) => f.label !== 'SYSTEM FEE')
    expect(validateInvoice(rows).filter((i) => i.code === 'invoice-total')).toEqual([])
  })

  it('reads a credit amount as negative', () => {
    const issues = validateInvoice([
      field('FWD BALANCE', '0.00'),
      field('ON-LINE NET DUE', '100.00C'),
      field('INSTANT NET DUE', '0.00'),
      field('NON-GAME ADJUSTMENTS', '0.00'),
      field('SYSTEM FEE', '0.00'),
      field('OTHER RETAILER INCENTIVES', '0.00'),
      field('TOTAL DUE BY WED', '-100.00'),
    ])
    expect(issues).toEqual([])
  })
})
