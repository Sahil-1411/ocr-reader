/**
 * Pair words into the receipt JSON. No image work lives here, so the same
 * builders serve both readers and `frontend/tools/score.test.ts`.
 */

import { isLotteryHeader, readColumnTables, type ColumnGuide } from '../layout/columns'
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
    table: /\b(?:invoice|statement|bill|order)\b/i,
  }

  const secondaryKeywords =
    /\b(?:pack\s+settlements?|weekly\s+pack|instant\s+inventory|inventory\s+summary|weekly\s+invoice|settlement\s+report)\b/i

  for (const line of topLines) {
    const rawText = line.map((w) => w.text).join(' ').trim()
    const text = cleanTitle(rawText)
    if (!text || text.length < 3) continue

    // Skip URLs, retailer lines, pure dates/times, and column headers
    if (/^https?:\/\/|www\.|\\.com\b/i.test(text)) continue
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
  const best = scored[0]?.text
  if (!best) return undefined
  return invoiceHeading(best) ?? best
}

/** A street address or a date range on the same line as the title is not the title. */
function invoiceHeading(text: string): string | undefined {
  if (/\bweekly\s+invoice\b/i.test(text)) {
    const heading = 'WEEKLY INVOICE'
    if (text.length > heading.length + 4) return heading
  }
  const match = /\binvoice\s*#?\s*:?\s*(\d{4,})/i.exec(text)
  if (!match) return undefined
  const heading = `Invoice # ${match[1]}`
  if (text.length <= heading.length + 4) return undefined
  return heading
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

function padCells(cells: readonly string[], width: number): string[] {
  const padded = cells.slice(0, width)
  while (padded.length < width) padded.push('')
  return padded
}

/**
 * The weekly lottery invoice names these lines. A sales invoice must not be
 * kept on the label/amount reader just because it also prints the word "invoice".
 */
const WEEKLY_INVOICE_MARKS = [
  'fwdbalance',
  'onlinenetdue',
  'instantnetdue',
  'totalduebywed',
  'systemfee',
  'nongameadjustments',
]

function looksLikeWeeklyInvoice(fields: readonly { label: string }[]): boolean {
  const labels = fields.map((field) => field.label.toLowerCase().replace(/[^a-z0-9]/g, ''))
  return WEEKLY_INVOICE_MARKS.filter((mark) => labels.some((label) => label.includes(mark))).length >= 2
}

/** The same check on the raw words, for a photo whose amounts did not pair cleanly. */
function pageLooksLikeWeeklyInvoice(words: readonly WordBox[]): boolean {
  const ordered = [...words].sort((a, b) => a.y - b.y || a.x - b.x)
  const flat = ordered.map((word) => word.text.toLowerCase().replace(/[^a-z0-9]/g, '')).join('')
  return WEEKLY_INVOICE_MARKS.filter((mark) => flat.includes(mark)).length >= 2
}

export function assembleReceipt(
  words: readonly WordBox[],
  facts: ReadFacts,
  rowOverlapRatio: number,
  guide?: ColumnGuide | null,
): OcrResult {
  const rows = inventoryRowsFromWords(words, rowOverlapRatio)
  const settlements = settlementRowsFromWords(words, rowOverlapRatio)
  const invoice = invoiceRowsFromWords(words, rowOverlapRatio)
  // Every table the page prints. The first is the page's own; the rest are
  // printed under it, such as an invoice's `Previous Balances`.
  const tables = readColumnTables(words, rowOverlapRatio, guide)
  const table = tables[0] ?? null
  // A wholesale invoice's item numbers look like game-pack codes, so the
  // lottery readers will claim the page and keep only two cells. A real column
  // header wins unless this is actually a lottery ticket.
  const weeklyInvoice = looksLikeWeeklyInvoice(invoice) || pageLooksLikeWeeklyInvoice(words)
  const kind =
    table && !isLotteryHeader(table.headers) && !findInventoryHeader(words) && !weeklyInvoice
      ? 'table'
      : chooseReceiptKind(rows, settlements, invoice)
  const fields = kind === 'invoice' ? invoice : []
  const warnings: string[] = []
  if (words.length === 0) {
    warnings.push('No words were read. The page may be blank after watermark removal.')
  }

  const solved = kind === 'inventory' ? solveInventoryCounts(rows) : { rows: [], issues: [] }
  const keptRows = solved.rows
  const keptSettlements = kind === 'settlements' ? settlements : []
  const tableRows = kind === 'table' && table ? table.rows : []

  // Checked against the rows that are actually returned, so an issue's row
  // indices address the same array the caller sees.
  const validation =
    kind === 'inventory'
      ? [...solved.issues, ...validateInventory(keptRows)]
      : kind === 'settlements'
        ? validateSettlements(keptSettlements, statedPackTotal(words))
        : kind === 'invoice'
          ? validateInvoice(fields)
          : []
  // Surfaced in both places: `validation` for a UI that can highlight rows, and
  // `warnings` so a caller that only reads the meta still learns about it.
  warnings.push(...validation.map((issue) => issue.message))

  const headers = kind === 'table' && table ? table.headers : extractTableHeaders(words, kind)

  const title = extractReceiptTitle(words, kind)

  return {
    kind,
    title,
    headers,
    rows: keptRows,
    settlements: keptSettlements,
    fields,
    tableRows,
    ...(kind === 'table' && table ? { columnBounds: table.bounds } : {}),
    tables:
      kind === 'table'
        ? tables.map(({ title, headers: own, rows: cells, bounds }) => ({
            ...(title ? { title } : {}),
            headers: own,
            rows: cells,
            columnBounds: bounds,
          }))
        : [],
    validation,
    // Only the column reader keeps a log; a page read some other way has no
    // account of what it left out.
    skipped: kind === 'table' ? tables.flatMap((each) => each.skipped).sort((a, b) => a.y - b.y) : [],
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
    case 'table':
      return result.tableRows.map((row) => padCells(row.cells, result.headers.length))
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
    case 'table':
      return {
        ...result,
        tableRows: result.tableRows.map((row, index) => {
          if (index !== rowIndex) return row
          const cells = padCells(row.cells, result.headers.length)
          const next = cells[cellIndex]
          if (next === undefined) return row
          cells[cellIndex] = value
          return { ...row, cells }
        }),
      }
    default: {
      const unreachable: never = result.kind
      return unreachable
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Dynamic Table Header Extraction                                            */
/* -------------------------------------------------------------------------- */

/**
 * Read the actual printed column headers from the OCR'd words.
 *
 * Uses a **generic scoring approach** so it works for any document —
 * not just the three predefined receipt types. Each text line in the
 * upper portion of the page is scored on how likely it is to be a
 * table header row, and the highest-scoring line's actual text is used.
 *
 * Falls back to `defaultHeaders(kind)` only when no plausible header
 * line is found in the document.
 */
function extractTableHeaders(
  words: readonly WordBox[],
  kind: ReceiptKind,
): string[] {
  if (words.length === 0) return defaultHeaders(kind)

  // Inventory has its own specialised header finder. A weekly invoice prints
  // no column titles; guessing one turns a body line into the header.
  if (kind === 'inventory') {
    return findInventoryHeader(words)?.labels ?? defaultHeaders(kind)
  }
  if (kind === 'invoice') return defaultHeaders(kind)

  const lines = groupIntoLines(words)
  if (lines.length === 0) return defaultHeaders(kind)

  // ── Generic header detection via scoring ────────────────────────────────
  // Score every line in the upper portion and pick the best candidate.

  interface Candidate {
    line: WordBox[]
    index: number
    score: number
  }

  const candidates: Candidate[] = []
  // Scan the upper 40% of lines (headers are always near the top)
  const scanLimit = Math.min(lines.length, Math.max(20, Math.floor(lines.length * 0.4)))

  for (let lineIdx = 0; lineIdx < scanLimit; lineIdx++) {
    const line = lines[lineIdx]!
    if (line.length < 2) continue

    const rawText = line.map((w) => w.text.trim()).filter((t) => t.length > 0)
    if (rawText.length < 2) continue
    const joined = rawText.join(' ')

    // ── Reject obvious non-headers ──
    // Pure numeric lines (all tokens are numbers/amounts)
    if (rawText.every((t) => /^\$?[\d.,]+%?$/.test(t))) continue
    // URLs, emails
    if (/https?:\/\/|www\.|\.com\b|@/.test(joined)) continue
    // Address patterns (street numbers followed by text)
    if (/^\d{2,5}\s+[A-Za-z]/.test(joined) && rawText.length <= 4) continue
    // Phone/fax patterns
    if (/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(joined)) continue
    // Date/time only lines
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(joined)) continue

    // ── Score the line ──
    let score = 0

    // 1. Text-heavy words (not numbers) → strong header signal
    const textWords = rawText.filter((t) => !/^\$?[\d.,]+%?$/.test(t) && /[A-Za-z]/.test(t))
    const textRatio = textWords.length / rawText.length
    if (textRatio >= 0.5) score += 20 * textRatio

    // 2. Multiple distinct column groups (separated by big gaps) → strong signal
    const labels = extractLabelTokens(line)
    if (labels.length >= 4) score += 30
    else if (labels.length >= 3) score += 25
    else if (labels.length >= 2) score += 10

    // 3. Uppercase/title-case → headers tend to be capitalised
    const upperCount = textWords.filter((t) => t === t.toUpperCase() && /[A-Z]/.test(t)).length
    const titleCount = textWords.filter((t) => /^[A-Z]/.test(t)).length
    if (textWords.length > 0) {
      if (upperCount >= textWords.length * 0.5) score += 15
      else if (titleCount >= textWords.length * 0.5) score += 8
    }

    // 4. Contains common header keywords → strong bonus
    const headerKeywords = /\b(qty|quantity|description|name|unit|price|amount|total|date|item|code|no\.?|number|size|pack|disc|cost|order|list|settled|game|credit|debit|balance|status|type|ref|id|sku|upc)\b/i
    const keywordMatches = (joined.match(new RegExp(headerKeywords.source, 'gi')) || []).length
    if (keywordMatches >= 3) score += 25
    else if (keywordMatches >= 2) score += 18
    else if (keywordMatches >= 1) score += 10

    // 5. Line position: headers for tables are usually between lines 3-20
    if (lineIdx >= 2 && lineIdx <= 20) score += 5
    if (lineIdx >= 4 && lineIdx <= 14) score += 5

    // 6. Followed by a data-like line → strong evidence this is the header
    if (lineIdx + 1 < lines.length) {
      const nextLine = lines[lineIdx + 1]!
      const nextText = nextLine.map((w) => w.text.trim()).filter((t) => t.length > 0)
      const nextNumeric = nextText.filter((t) => /^\$?[\d.,]+%?$/.test(t)).length
      const nextHasMixed = nextText.some((t) => /[A-Za-z]/.test(t)) && nextNumeric >= 1
      if (nextHasMixed && nextText.length >= 2) score += 20
      else if (nextNumeric >= 2) score += 15
    }

    // 7. Short individual token lengths (headers tend to be short labels)
    const avgLen = textWords.reduce((s, t) => s + t.length, 0) / Math.max(1, textWords.length)
    if (avgLen <= 12) score += 5
    if (avgLen <= 8) score += 5

    // ── Penalise non-header patterns ──
    // Document titles (short lines with title-like words)
    if (rawText.length <= 3 && /\b(invoice|settlement|inventory|summary|report|receipt|statement|bill)\b/i.test(joined)) {
      score -= 30
    }
    // Company names / single-entity lines
    if (rawText.length <= 2 && labels.length <= 1) score -= 20
    // Lines with long sentences (descriptions, not headers)
    if (joined.length > 120 && labels.length <= 2) score -= 15
    // Lines that are just a single long string (not columnar)
    if (labels.length <= 1) score -= 25

    if (score > 15) {
      candidates.push({ line, index: lineIdx, score })
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]!
    const labels = splitHeaderLabels(best.line, lines.slice(best.index + 1))
    if (labels.length >= 2) return labels
  }

  return defaultHeaders(kind)
}

/**
 * Column titles from one header line.
 *
 * A real column gap can be about as wide as the space inside a two-word
 * title (`DATE SETTLED`). The rows under the header repeat a left edge for
 * each column, so a title word is grouped with the edge it sits over.
 * `GAME-PACK` and `NAME` land on different edges. `DATE` and `SETTLED` land
 * on the same one.
 */
function splitHeaderLabels(
  line: readonly WordBox[],
  following: readonly (readonly WordBox[])[],
): string[] {
  const starts = repeatedLeftEdges(following)
  const filtered = [...line]
    .filter((word) => word.text.trim().length > 0)
    .sort((a, b) => a.x - b.x)
  if (filtered.length === 0) return []
  if (starts.length < 2) return extractLabelTokens(line)

  const height = filtered.reduce((sum, word) => sum + word.height, 0) / filtered.length || 12
  const slack = height * 0.5
  const groups: WordBox[][] = []
  for (const word of filtered) {
    const index = columnStartIndex(word.x, starts, slack)
    const previous = groups[groups.length - 1]
    if (previous && columnStartIndex(previous[0]!.x, starts, slack) === index) {
      previous.push(word)
      continue
    }
    groups.push([word])
  }
  return groups.map(joinHeaderWords)
}

/** Left edges that show up on at least half of the rows under the header. */
function repeatedLeftEdges(lines: readonly (readonly WordBox[])[]): number[] {
  const usable = lines.filter((line) => line.some((word) => word.text.trim().length > 0)).slice(0, 8)
  if (usable.length < 2) return []

  const edges: number[] = []
  let heightSum = 0
  let heightCount = 0
  for (const line of usable) {
    for (const word of line) {
      if (!word.text.trim()) continue
      edges.push(word.x)
      heightSum += word.height
      heightCount += 1
    }
  }
  if (edges.length === 0) return []

  const height = heightCount > 0 ? heightSum / heightCount : 12
  const tolerance = Math.max(10, height * 0.8)
  edges.sort((a, b) => a - b)
  const clusters: { sum: number; count: number }[] = []
  for (const x of edges) {
    const last = clusters[clusters.length - 1]
    if (last && x - last.sum / last.count <= tolerance) {
      last.sum += x
      last.count += 1
      continue
    }
    clusters.push({ sum: x, count: 1 })
  }

  const minCount = Math.max(2, Math.ceil(usable.length * 0.5))
  return clusters.filter((cluster) => cluster.count >= minCount).map((cluster) => cluster.sum / cluster.count)
}

function columnStartIndex(x: number, starts: readonly number[], slack: number): number {
  let best = 0
  for (let index = 0; index < starts.length; index += 1) {
    if ((starts[index] ?? 0) <= x + slack) best = index
  }
  return best
}

function joinHeaderWords(words: readonly WordBox[]): string {
  let current = ''
  for (const word of words) {
    const next = word.text.trim()
    if (!next) continue
    if (!current) {
      current = next
      continue
    }
    const sep = next.startsWith('-') || current.endsWith('-') ? '' : ' '
    current = `${current}${sep}${next}`
  }
  return current
}

/**
 * Given a line of words that is believed to be a column header, collapse
 * closely-spaced words into multi-word labels and return the list.
 *
 * e.g. `["GAME", "-", "PACK", "NAME", "DATE", "SETTLED"]`
 *   →  `["GAME-PACK", "NAME", "DATE SETTLED"]`
 */
function extractLabelTokens(line: readonly WordBox[]): string[] {
  if (line.length === 0) return []
  const sorted = [...line].sort((a, b) => a.x - b.x)

  // Filter out pure whitespace tokens
  const filtered = sorted.filter((w) => w.text.trim().length > 0)
  if (filtered.length === 0) return []

  // Compute inter-word gaps.
  const gaps: number[] = []
  for (let i = 1; i < filtered.length; i++) {
    const prev = filtered[i - 1]!
    const curr = filtered[i]!
    gaps.push(Math.max(0, curr.x - (prev.x + prev.width)))
  }

  if (gaps.length === 0) {
    return [filtered.map((w) => w.text.trim()).join(' ')]
  }

  // Find the gap threshold that separates column spacing from within-word spacing.
  const avgHeight = filtered.reduce((s, w) => s + w.height, 0) / filtered.length
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] ?? 0
  // Threshold: at least 1.8× the median gap, or 40% of average text height
  const threshold = Math.max(medianGap * 1.8, avgHeight * 0.4)

  const labels: string[] = []
  let current = filtered[0]!.text.trim()
  for (let i = 0; i < gaps.length; i++) {
    const gap = gaps[i]!
    const nextWord = filtered[i + 1]!.text.trim()
    if (gap >= threshold) {
      // New column
      labels.push(current)
      current = nextWord
    } else {
      // Same column header (multi-word), join with space or keep hyphen
      const sep = nextWord.startsWith('-') || current.endsWith('-') ? '' : ' '
      current = current + sep + nextWord
    }
  }
  labels.push(current)
  return labels
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
    case 'table':
      return ['Column']
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
