/**
 * Pair words into the receipt JSON. No image work lives here, so the same
 * builders serve both readers and `tools/score.test.ts`.
 */

import {
  chooseReceiptKind,
  findInventoryHeader,
  INVENTORY_HEADERS,
  inventoryRowsFromWords,
  invoiceRowsFromWords,
  settlementRowsFromWords,
  type WordBox,
} from '../layout/rows'
import type { OcrResult, ProcessingMeta, ReceiptKind } from '../types'
import {
  solveInventoryCounts,
  validateInventory,
  validateInvoice,
  validateSettlements,
} from './validate'

/** The settlements table's printed header: `Game-Pack  Name  Date Settled`. */
const SETTLEMENT_HEADERS = ['Game-Pack', 'Name', 'Date Settled'] as const
/** The invoice prints no column header; these name its two sides. */
const INVOICE_HEADERS = ['label', 'value'] as const

/**
 * The pack count the settlements receipt prints below its table.
 *
 * `Packs Total Settled : 25` sits on a line with no pack code, so it never
 * becomes a row and has to be read back off the words. The reader splits it
 * unpredictably around the colon, so the digits are taken from the first
 * number that follows the phrase rather than from a fixed token position.
 */
function statedPackTotal(words: readonly WordBox[]): number | null {
  const ordered = [...words].sort((a, b) => a.y - b.y || a.x - b.x)
  const text = ordered.map((word) => word.text).join(' ')
  const match = /packs?\s*total\s*settled\s*:?\s*(\d{1,4})/i.exec(text)
  if (!match) return null
  const total = Number(match[1])
  return Number.isFinite(total) ? total : null
}

/** What the client knows about the read before the words become rows. */
type ReadFacts = Omit<ProcessingMeta, 'wordCount' | 'totalMs' | 'warnings'>

export function assembleReceipt(
  words: readonly WordBox[],
  facts: ReadFacts,
  rowOverlapRatio: number,
): OcrResult {
  const rows = inventoryRowsFromWords(words, rowOverlapRatio)
  const settlements = settlementRowsFromWords(words, rowOverlapRatio)
  const invoice = invoiceRowsFromWords(words, rowOverlapRatio)
  const kind = chooseReceiptKind(rows, settlements, invoice)
  const fields = kind === 'invoice' ? invoice : []
  const warnings: string[] = []
  if (words.length === 0) {
    warnings.push('No words were read. The page may be blank after watermark removal.')
  }

  const solved = kind === 'inventory' ? solveInventoryCounts(rows) : { rows: [], issues: [] }
  const keptRows = solved.rows
  const keptSettlements = kind === 'settlements' ? settlements : []

  // Checked against the rows that are actually returned, so an issue's row
  // indices address the same array the caller sees.
  const validation =
    kind === 'inventory'
      ? [...solved.issues, ...validateInventory(keptRows)]
      : kind === 'settlements'
        ? validateSettlements(keptSettlements, statedPackTotal(words))
        : validateInvoice(fields)
  // Surfaced in both places: `validation` for a UI that can highlight rows, and
  // `warnings` so a caller that only reads the meta still learns about it.
  warnings.push(...validation.map((issue) => issue.message))

  const headers =
    kind === 'inventory'
      ? (findInventoryHeader(words)?.labels ?? defaultHeaders(kind))
      : defaultHeaders(kind)

  return {
    kind,
    headers,
    rows: keptRows,
    settlements: keptSettlements,
    fields,
    validation,
    processingMeta: { ...facts, wordCount: words.length, totalMs: 0, warnings },
  }
}

/** Each row's cells, left to right in the order the ticket prints its columns. */
export function rowCells(result: OcrResult): string[][] {
  switch (result.kind) {
    case 'inventory':
      return result.rows.map(({ game, name, int, rec, act, set }) => [game, name, int, rec, act, set])
    case 'settlements':
      return result.settlements.map(({ gamePack, name, dateSettled }) => [gamePack, name, dateSettled])
    case 'invoice':
      return result.fields.map(({ label, value }) => [label, value])
    default: {
      const unreachable: never = result.kind
      return unreachable
    }
  }
}

/** The printed headers for `kind`, used when the page's own were not read. */
function defaultHeaders(kind: ReceiptKind): string[] {
  switch (kind) {
    case 'inventory':
      return [...INVENTORY_HEADERS]
    case 'settlements':
      return [...SETTLEMENT_HEADERS]
    case 'invoice':
      return [...INVOICE_HEADERS]
    default: {
      const unreachable: never = kind
      return unreachable
    }
  }
}

/**
 * The JSON shown in the app: one kind, and only that kind's columns, each row
 * keyed by the column header exactly as the ticket prints it.
 */
export function toPublicJson(result: OcrResult): {
  kind: ReceiptKind
  headers: string[]
  rows: Record<string, string>[]
} {
  const { headers } = result
  return {
    kind: result.kind,
    headers,
    rows: rowCells(result).map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
    ),
  }
}
