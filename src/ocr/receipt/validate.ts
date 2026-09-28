/**
 * Check a reading against the receipt's own arithmetic.
 *
 * The watermark destroys glyphs outright in places — a count column printed
 * under the logo comes back as `550/000 FEN`, and no recogniser invents what is
 * not in the pixels. What matters for a financial document is therefore not a
 * headline accuracy number but whether the reading can say *which* rows it got
 * wrong: a silent 97% is worse to work from than a 97% with the other 3% marked,
 * because the first has to be checked line by line and the second does not.
 *
 * These receipts carry the checks already. Every kind restates its own contents
 * somewhere — a totals row, a footer count, a section subtotal repeated in the
 * header — so a misread digit contradicts something else on the same page.
 *
 * Nothing here corrects a value. A failed check means one of the two sides is
 * wrong and the arithmetic cannot say which, so guessing would turn a visible
 * error into an invisible one.
 */

import type {
  InventoryRow,
  ReceiptField,
  SettlementRow,
  ValidationIssue,
} from '../types'

export type { ValidationIssue }

/** Money as an integer number of cents, or null when the text is not an amount. */
function cents(text: string): number | null {
  const token = text.trim().replace(/[$,\s]/g, '')
  const credit = /[cC]$/.test(token)
  const body = credit ? token.slice(0, -1) : token
  if (!/^\d+(?:\.\d{1,2})?$/.test(body)) return null
  const value = Math.round(Number(body) * 100)
  if (!Number.isFinite(value)) return null
  return credit ? -value : value
}

function money(value: number): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** A count column, or null when the reader mangled it past use. */
function count(text: string): number | null {
  const token = text.trim()
  if (!/^\d{1,3}$/.test(token)) return null
  return Number(token)
}

function isTotalsRow(row: InventoryRow): boolean {
  return /^totals$/i.test(row.name.trim())
}

/**
 * Inventory: the TOTALS row restates each column's sum.
 *
 * A single unreadable count breaks the identity, which is the point — it says
 * the column is not to be trusted without saying which row spoiled it. Rows
 * whose count did not parse at all are named separately, since those are the
 * likely culprits and the caller can check them first.
 */
export function validateInventory(rows: readonly InventoryRow[]): ValidationIssue[] {
  const totals = rows.findIndex(isTotalsRow)
  if (totals === -1) return []
  const totalsRow = rows[totals]
  if (!totalsRow) return []

  const issues: ValidationIssue[] = []
  const columns = ['int', 'rec', 'act', 'set'] as const

  for (const column of columns) {
    const stated = count(totalsRow[column])
    if (stated === null) continue

    let sum = 0
    const unreadable: number[] = []
    rows.forEach((row, index) => {
      if (index === totals) return
      const value = count(row[column])
      if (value === null) unreadable.push(index)
      else sum += value
    })

    if (sum === stated) continue
    const blame = unreadable.length
      ? ` ${unreadable.length} row${unreadable.length === 1 ? '' : 's'} had no readable ${column} count.`
      : ''
    issues.push({
      code: 'inventory-totals',
      message:
        `The ${column} column adds up to ${sum}, but the TOTALS row says ${stated}.${blame}`,
      rows: unreadable.length ? unreadable : [totals],
    })
  }

  return issues
}

/**
 * Settlements: the footer states how many packs were settled.
 *
 * The count is printed as `Packs Total Settled : 25` below the table, on a line
 * with no pack code of its own, so it never becomes a row — the caller passes it
 * in separately.
 */
export function validateSettlements(
  rows: readonly SettlementRow[],
  statedTotal: number | null,
): ValidationIssue[] {
  if (statedTotal === null || rows.length === statedTotal) return []
  const missing = statedTotal - rows.length
  return [
    {
      code: 'settlements-count',
      message:
        `The receipt settles ${statedTotal} packs but ${rows.length} rows were read` +
        `${missing > 0 ? ` — ${missing} row${missing === 1 ? ' is' : 's are'} missing` : ''}.`,
      rows: [],
    },
  ]
}

/** Find a field by label, ignoring case, spacing and the reader's punctuation. */
function findField(
  fields: readonly ReceiptField[],
  label: string,
): { index: number; field: ReceiptField } | null {
  const want = label.toLowerCase().replace(/[^a-z0-9]/g, '')
  const index = fields.findIndex(
    (field) => field.label.toLowerCase().replace(/[^a-z0-9]/g, '') === want,
  )
  const field = index === -1 ? undefined : fields[index]
  return field ? { index, field } : null
}

/**
 * Invoice: two independent identities.
 *
 * The header block totals itself — `TOTAL DUE BY WED` is the sum of the six
 * lines above it — and each section's closing line restates the header figure
 * for that section, so `Instant Net Due` at the foot of the INSTANT block must
 * equal `INSTANT NET DUE` at the top of the page. The second check is the one
 * that catches a digit lost to the watermark far down the page, where there is
 * nothing else to compare against.
 */
export function validateInvoice(fields: readonly ReceiptField[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const parts = [
    'FWD BALANCE',
    'ON-LINE NET DUE',
    'INSTANT NET DUE',
    'NON-GAME ADJUSTMENTS',
    'SYSTEM FEE',
    'OTHER RETAILER INCENTIVES',
  ]
  const total = findField(fields, 'TOTAL DUE BY WED')
  if (total) {
    const found = parts.map((label) => findField(fields, label)).filter((hit) => hit !== null)
    const stated = cents(total.field.value)
    const addends = found.map((hit) => cents(hit.field.value))
    // Only meaningful with the whole block read; a missing line would look
    // exactly like a misread one.
    if (stated !== null && found.length === parts.length && addends.every((v) => v !== null)) {
      const sum = addends.reduce((a: number, b) => a + (b ?? 0), 0)
      if (sum !== stated) {
        issues.push({
          code: 'invoice-total',
          message:
            `The header lines add up to ${money(sum)}, but TOTAL DUE BY WED says ` +
            `${money(stated)}.`,
          rows: [...found.map((hit) => hit.index), total.index],
        })
      }
    }
  }

  for (const [header, footer] of [
    ['ON-LINE NET DUE', 'On-line Net Due'],
    ['INSTANT NET DUE', 'Instant Net Due'],
  ] as const) {
    // Same text ignoring case, so search from each end to tell them apart.
    const want = header.toLowerCase().replace(/[^a-z0-9]/g, '')
    const first = fields.findIndex(
      (f) => f.label.toLowerCase().replace(/[^a-z0-9]/g, '') === want,
    )
    const last = fields.map((f) => f.label.toLowerCase().replace(/[^a-z0-9]/g, '')).lastIndexOf(want)
    if (first === -1 || last === -1 || first === last) continue

    const top = cents(fields[first]?.value ?? '')
    const bottom = cents(fields[last]?.value ?? '')
    if (top === null || bottom === null || top === bottom) continue
    issues.push({
      code: 'invoice-section-total',
      message:
        `${header} is ${money(top)} at the top of the page but ${footer} is ` +
        `${money(bottom)} at the foot of its section.`,
      rows: [first, last],
    })
  }

  return issues
}
