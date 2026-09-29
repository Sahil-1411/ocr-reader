/**
 * Pair words into the receipt JSON. No image work lives here, so the same
 * builders serve both readers and `tools/score.test.ts`.
 */

import {
  chooseReceiptKind,
  findInventoryHeader,
  groupIntoLines,
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

/** Clean extracted title string. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/WEEKLYINVOICE/i, 'WEEKLY INVOICE')
    .replace(/PACKSETTLEMENTS?/i, 'PACK SETTLEMENTS')
    .replace(/INVENTORYSUMMARY/i, 'INVENTORY SUMMARY')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Extract printed header/title text directly from the receipt image words. */
export function extractReceiptTitle(
  words: readonly WordBox[],
  kind: ReceiptKind,
): string | undefined {
  if (words.length === 0) return undefined
  const lines = groupIntoLines(words)

  // Title is located in the upper region of the ticket (typically the first 16 lines)
  const topLines = lines.slice(0, 16)

  interface ScoredLine {
    text: string
    score: number
  }

  const scored: ScoredLine[] = []

  const kindKeywords: Record<ReceiptKind, RegExp> = {
    settlements: /\bsettlements?\b/i,
    inventory: /\binventory\b/i,
    invoice: /\binvoice\b/i,
  }

  const secondaryKeywords =
    /\b(?:pack\s+settlements?|weekly\s+pack|instant\s+inventory|inventory\s+summary|weekly\s+invoice|settlement\s+report)\b/i

  for (const line of topLines) {
    const rawText = line.map((w) => w.text).join(' ').trim()
    const text = cleanTitle(rawText)
    if (!text || text.length < 3) continue

    // Skip URLs, retailer lines, pure dates/times, and column headers
    if (/^https?:\/\/|www\.|\.com\b/i.test(text)) continue
    if (/^retailer\b|^store\b|^terminal\b/i.test(text)) continue
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text)) continue
    if (/^(?:game|name|int|rec|act|set|game-pack|date settled)/i.test(text)) continue

    let score = 0

    // Match for the kind
    if (kindKeywords[kind].test(text)) {
      score += 50
    }

    // Strong compound match
    if (secondaryKeywords.test(text)) {
      score += 40
    }

    // Font height weight (larger font on ticket indicates main header)
    const avgHeight = line.reduce((sum, w) => sum + w.height, 0) / line.length
    score += Math.min(30, avgHeight)

    // Uppercase header boost
    if (text === text.toUpperCase() && /[A-Z]/.test(text)) {
      score += 15
    }

    // Noise reduction
    if (/scholarship|lottery/i.test(text) && !kindKeywords[kind].test(text)) {
      score -= 20
    }

    if (score > 30) {
      scored.push({ text, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.text
}

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

  const title = extractReceiptTitle(words, kind)

  return {
    kind,
    title,
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

/** `result` with one cell of `rowCells(result)` replaced by `value`. */
export function withCell(
  result: OcrResult,
  rowIndex: number,
  cellIndex: number,
  value: string,
): OcrResult {
  const replace = <T>(rows: readonly T[], keys: readonly (keyof T)[]): T[] =>
    rows.map((row, index) => {
      const key = keys[cellIndex]
      return index === rowIndex && key !== undefined ? { ...row, [key]: value } : row
    })
  switch (result.kind) {
    case 'inventory':
      return { ...result, rows: replace(result.rows, ['game', 'name', 'int', 'rec', 'act', 'set']) }
    case 'settlements':
      return {
        ...result,
        settlements: replace(result.settlements, ['gamePack', 'name', 'dateSettled']),
      }
    case 'invoice':
      return { ...result, fields: replace(result.fields, ['label', 'value']) }
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
  title?: string
  headers: string[]
  rows: Record<string, string>[]
} {
  const { headers, title } = result
  return {
    kind: result.kind,
    ...(title ? { title } : {}),
    headers,
    rows: rowCells(result).map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
    ),
  }
}
