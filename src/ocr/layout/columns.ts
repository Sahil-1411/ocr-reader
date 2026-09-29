/**
 * Read a multi-column table (a wholesale invoice, a price list) by lining
 * words up under the printed header.
 *
 * Lottery tickets stay on their own readers. This one exists because a sales
 * invoice has a dozen columns, and treating every line as a label plus one
 * amount — or as a game-pack code — drops every cell past the second.
 */

import type { TableRow } from '../types'
import { groupIntoLines, type WordBox } from './rows'

export interface ColumnTable {
  headers: string[]
  rows: TableRow[]
  /** Left edge of each column, in the same pixel space as the words. */
  bounds: number[]
}

/** Column edges learned from an earlier page of the same document. */
export interface ColumnGuide {
  headers: string[]
  bounds: number[]
}

interface HeaderColumn {
  label: string
  x: number
  right: number
}

/** A printed header this page is not a lottery ticket. */
export function isLotteryHeader(headers: readonly string[]): boolean {
  const norm = headers.map((header) => header.toLowerCase().replace(/[^a-z0-9]/g, ''))
  const has = (pattern: RegExp) => norm.some((header) => pattern.test(header))
  const inventory =
    has(/^games?$/) && has(/^name$/) && has(/^int/) && has(/^rec/) && has(/^act/) && has(/^set/)
  const settlements =
    (has(/gamepack/) || (has(/^game$/) && has(/pack/))) &&
    (has(/datesettled/) || has(/settled/) || has(/^date$/))
  return inventory || settlements
}

/**
 * The column table under the printed header, or null when the page does not
 * have one.
 */
export function readColumnTable(
  words: readonly WordBox[],
  overlapRatio = 0.5,
  guide?: ColumnGuide | null,
): ColumnTable | null {
  const usable = words.filter(
    (word) => word.text.trim().length > 0 && word.width > 0 && word.height > 0,
  )
  if (usable.length < 4) return null

  const lines = groupIntoLines(usable, overlapRatio)
  const header = findHeader(usable)
  const guided = header ? null : usableGuide(guide)
  if (!header && !guided) return null

  const columns = header?.columns ?? guided?.columns ?? []
  if (columns.length < 3) return null
  const bounds = header ? columnBounds(header.columns) : (guided?.bounds ?? [])
  const headerWords = new Set(header?.words ?? [])
  const rows: TableRow[] = []
  const lineHeight = median(usable.map((word) => word.height)) || 12
  let previousBand: { top: number; bottom: number } | null = null
  // A wrapped item name sits just above the numbers. Hold it until that row.
  let leadIn: { cells: string[]; band: { top: number; bottom: number } } | null = null

  for (const line of lines) {
    if (line.some((word) => headerWords.has(word))) continue
    if (header && lineBand(line).top < header.bottom - 2) continue

    let cells: string[] = cellsForLine(line, columns, bounds, lineHeight)
    if (isFurniture(cells) || isRule(cells) || isRepeatedHeader(cells, columns)) continue
    if (!cells.some((cell) => cell.trim())) continue

    const band = lineBand(line)
    const previous = rows[rows.length - 1]
    const follows =
      previousBand !== null && band.top - previousBand.bottom <= lineHeight * 1.5
    if (previous && previousBand && follows && (isWrappedLine(cells) || isNote(cells) || isLeadIn(cells))) {
      rows[rows.length - 1] = appendWrap(previous, cells)
      previousBand = { top: previousBand.top, bottom: Math.max(previousBand.bottom, band.bottom) }
      continue
    }
    if (isLeadIn(cells)) {
      const closeLead: boolean =
        leadIn !== null && band.top - leadIn.band.bottom <= lineHeight * 1.5
      leadIn = closeLead && leadIn
        ? { cells: combineCells(leadIn.cells, cells), band: { top: leadIn.band.top, bottom: band.bottom } }
        : { cells, band }
      continue
    }
    // Totals, tax lines, and the legal footer are not line items. They share
    // the page with the table but they are not another product row.
    if (!isLineItem(cells)) {
      leadIn = null
      continue
    }
    if (leadIn && band.top - leadIn.band.bottom <= lineHeight * 1.6) {
      cells = combineCells(leadIn.cells, cells)
    }
    leadIn = null
    rows.push({ cells, confidence: meanConfidence(line) })
    previousBand = band
  }

  if (rows.length < 2) return null
  const filled = rows.map((row) => row.cells.filter((cell) => cell.trim()).length).sort((a, b) => a - b)
  const medianFilled = filled[Math.floor(filled.length / 2)] ?? 0
  if (medianFilled < 2) return null

  return { headers: columns.map((column) => column.label), rows, bounds }
}

function usableGuide(
  guide: ColumnGuide | null | undefined,
): { columns: HeaderColumn[]; bounds: number[] } | null {
  if (!guide || guide.headers.length < 3 || guide.bounds.length !== guide.headers.length) return null
  const columns = guide.headers.map((label, index) => {
    const x = guide.bounds[index] ?? 0
    const next = guide.bounds[index + 1]
    return { label, x, right: next === undefined ? x + 40 : x + Math.max(12, (next - x) * 0.6) }
  })
  return { columns, bounds: guide.bounds }
}

const HEADER_WORD =
  /^(?:qty|quantity|case|unt|unit|item#?|items?|part#?|upc|sku|description|pack|prc|price|extended|amount|total|ordered|shipped|customer|tax|per|oos|qos|sub-?)$/i

/**
 * The printed column titles, including a header stacked on two baselines
 * (`Qty` over `Case`).
 *
 * Column gaps on these invoices are about as wide as a word space, and a
 * trailing space makes one title's box touch the next column. The thing that
 * stays stable is each title's left edge: stacked words share it, the next
 * column does not.
 */
function findHeader(
  words: readonly WordBox[],
): { columns: HeaderColumn[]; words: WordBox[]; bottom: number } | null {
  const hits = words.filter((word) => HEADER_WORD.test(word.text.trim()) || /upc|part#|description/i.test(word.text))
  if (hits.length < 3) return null

  const height = median(hits.map((word) => word.height)) || 12
  // A wrapped title is two or three lines. The window stops there so the
  // address, phone, and "Total Due" line above the titles stay out.
  const reach = height * 1.3
  let best: WordBox[] = []
  for (const anchor of hits) {
    const anchorCenter = anchor.y + anchor.height / 2
    const group = hits.filter((word) => Math.abs(word.y + word.height / 2 - anchorCenter) <= reach)
    if (group.length > best.length) best = group
  }
  if (best.length < 3) return null

  let top = Infinity
  let bottom = -Infinity
  for (const word of best) {
    top = Math.min(top, word.y)
    bottom = Math.max(bottom, word.y + word.height)
  }
  const band = { top: top - height * 0.35, bottom: bottom + height * 0.35 }
  const headerWords = words.filter((word) => {
    const center = word.y + word.height / 2
    return center >= band.top && center <= band.bottom && word.text.trim().length > 0
  })
  const columns = groupHeaderColumns(headerWords)
  if (columns.length < 3) return null
  const nextLine = words.filter((word) => word.y > bottom && word.y < bottom + height * 3)
  const score = scoreHeader(columns, nextLine, 4)
  if (score < 28) return null
  return { columns, words: headerWords, bottom }
}

/**
 * Split header words into columns.
 *
 * Stacked titles share a left edge (`Qty` over `Case`). A single-line title
 * such as `CASE QTY` is two words separated by a real space. The next column
 * starts further along, even when a trailing space makes the boxes touch.
 */
function groupHeaderColumns(line: readonly WordBox[]): HeaderColumn[] {
  const filtered = [...line]
    .filter((word) => word.text.trim().length > 0)
    .sort((a, b) => a.x - b.x || a.y - b.y)
  if (filtered.length === 0) return []

  const height = median(filtered.map((word) => word.height)) || 12
  // A wrapped title is centered on the line above ("Qty" under "Ordered",
  // "Unit" / "Price" under "Customer"). Join those by overlap. Words that
  // only share a left edge, such as "Qty" over "Case", overlap too.
  const parent = filtered.map((_, index) => index)
  const find = (index: number): number => {
    let cursor = index
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]!]!
      cursor = parent[cursor]!
    }
    return cursor
  }
  const union = (left: number, right: number) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[b] = a
  }
  for (let i = 0; i < filtered.length; i += 1) {
    for (let j = i + 1; j < filtered.length; j += 1) {
      const a = filtered[i]
      const b = filtered[j]
      if (!a || !b) continue
      const centerDelta = Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))
      if (centerDelta <= height * 0.4) continue
      const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      const narrower = Math.min(a.width, b.width)
      if (overlap > 0 && overlap >= narrower * 0.35) union(i, j)
    }
  }

  const buckets = new Map<number, WordBox[]>()
  filtered.forEach((word, index) => {
    const key = find(index)
    const list = buckets.get(key) ?? []
    list.push(word)
    buckets.set(key, list)
  })
  const stacked = [...buckets.values()].sort(
    (a, b) => Math.min(...a.map((word) => word.x)) - Math.min(...b.map((word) => word.x)),
  )

  // `CASE QTY` is two words on one baseline. A title that already wrapped
  // does not absorb the next title, even when the boxes nearly touch.
  const groups: WordBox[][] = []
  for (const stack of stacked) {
    const previous = groups[groups.length - 1]
    if (previous && oneBaseline(previous, height) && oneBaseline(stack, height)) {
      const prevRight = Math.max(...previous.map((word) => word.x + word.width))
      const gap = Math.min(...stack.map((word) => word.x)) - prevRight
      if (gap > 0 && gap <= height * 0.7) {
        previous.push(...stack)
        continue
      }
    }
    groups.push([...stack])
  }

  return groups
    .map((group) => {
      const x = Math.min(...group.map((word) => word.x))
      const right = Math.max(...group.map((word) => word.x + word.width))
      return { label: joinLabel(group), x, right }
    })
    .filter((column) => column.label.length > 0)
}

function joinLabel(words: readonly WordBox[]): string {
  const ordered = [...words].sort((a, b) => a.y - b.y || a.x - b.x)
  let out = ''
  for (const word of ordered) {
    const text = cleanLabel(word.text)
    if (!text || out.split(' ').includes(text)) continue
    if (!out) {
      out = text
      continue
    }
    const glue = out.endsWith('-') || out.endsWith('/') || text.startsWith('-')
    out = glue ? `${out}${text}` : `${out} ${text}`
  }
  return out
}

function oneBaseline(words: readonly WordBox[], height: number): boolean {
  const centers = words.map((word) => word.y + word.height / 2)
  return Math.max(...centers) - Math.min(...centers) <= height * 0.4
}

function scoreHeader(
  columns: readonly HeaderColumn[],
  nextLine: readonly WordBox[] | undefined,
  lineIndex: number,
): number {
  const labels = columns.map((column) => column.label)
  const joined = labels.join(' ')
  if (labels.every((label) => /^\$?[\d.,]+%?$/.test(label))) return 0
  if (/https?:\/\/|www\.|\.com\b|@/.test(joined)) return 0
  if (/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(joined)) return 0

  const textual = labels.filter((label) => /[A-Za-z]/.test(label) && !/^\d/.test(label))
  if (textual.length < labels.length * 0.6) return 0

  let score = 0
  score += 18 * (textual.length / labels.length)
  if (labels.length >= 6) score += 34
  else if (labels.length >= 4) score += 28
  else score += 16

  const upper = textual.filter((label) => label === label.toUpperCase() && /[A-Z]/.test(label)).length
  if (upper >= textual.length * 0.5) score += 12

  const keywords = joined.match(
    /\b(qty|quantity|description|name|unit|price|amount|total|date|item|code|number|pack|cost|order|upc|sku|part|extended|prc|case)\b/gi,
  )
  const keywordCount = keywords?.length ?? 0
  if (keywordCount >= 3) score += 26
  else if (keywordCount >= 2) score += 16
  else if (keywordCount >= 1) score += 8

  if (lineIndex >= 2 && lineIndex <= 24) score += 4

  if (nextLine && nextLine.length >= 2) {
    const nextText = nextLine.map((word) => word.text.trim()).filter((text) => text.length > 0)
    const numeric = nextText.filter((text) => /\d/.test(text)).length
    if (numeric >= 2 && nextText.some((text) => /[A-Za-z]/.test(text))) score += 18
    else if (numeric >= 2) score += 12
  }

  if (labels.length <= 3 && /\b(invoice|statement|receipt|summary|report)\b/i.test(joined)) score -= 24
  if (joined.length > 140 && labels.length <= 3) score -= 12
  // A data row full of item numbers is not a header, even if one cell is a word.
  const longIds = labels.filter((label) => /\d{3,}[-/]\d{3,}/.test(label)).length
  if (longIds >= 1) score -= 30

  return score
}

function columnBounds(columns: readonly HeaderColumn[]): number[] {
  const first = columns[0]
  if (!first) return [0]
  const bounds = [Math.min(0, first.x - 4)]
  for (let index = 0; index < columns.length - 1; index += 1) {
    const current = columns[index]
    const next = columns[index + 1]
    if (!current || !next) continue
    // A trailing space can make this title's box reach into the next column.
    const right = Math.min(current.right, next.x - 1)
    const labelWidth = Math.max(1, current.right - current.x)
    const gap = next.x - right
    // A short title with a wide hole after it (UPC, then Description) only
    // keeps a small shoulder. The next column's text starts in that hole,
    // left of its own title. A long title keeps every word until the next title.
    const roomyGap = gap > labelWidth * 1.5
    const shoulder = right + Math.min(gap * 0.22, labelWidth * 0.45)
    bounds.push(roomyGap ? shoulder : next.x - 1)
  }
  return bounds
}

function cellsForLine(
  line: readonly WordBox[],
  columns: readonly HeaderColumn[],
  bounds: readonly number[],
  lineHeight: number,
): string[] {
  const cells = blank(columns.length)
  const buckets: WordBox[][] = columns.map(() => [])
  for (const field of fieldsOnLine(line, lineHeight)) {
    const hits = columns.flatMap((column, index) =>
      horizontalOverlap(field, column) > 0 ? [index] : [],
    )
    // A name that starts under its title stays there, even when the words
    // run into the gap. A phrase that crosses two titles is split per word.
    if (hits.length === 1) {
      buckets[hits[0]!]?.push(...field)
      continue
    }
    for (const word of field) {
      buckets[columnIndex(word, bounds)]?.push(word)
    }
  }
  for (let index = 0; index < buckets.length; index += 1) {
    cells[index] = joinWords(buckets[index] ?? [])
  }
  return cells
}

function horizontalOverlap(field: readonly WordBox[], column: HeaderColumn): number {
  const x = Math.min(...field.map((word) => word.x))
  const right = Math.max(...field.map((word) => word.x + word.width))
  return Math.min(right, column.right) - Math.max(x, column.x)
}

/** Words separated by a real space stay one field. A column gap starts the next. */
function fieldsOnLine(line: readonly WordBox[], lineHeight: number): WordBox[][] {
  const ordered = [...line].sort((a, b) => a.x - b.x || a.y - b.y)
  const fields: WordBox[][] = []
  for (const word of ordered) {
    const current = fields[fields.length - 1]
    const previous = current?.[current.length - 1]
    const gap = previous ? word.x - (previous.x + previous.width) : 0
    if (current && gap <= lineHeight * 0.8) current.push(word)
    else fields.push([word])
  }
  return fields
}

function combineCells(above: readonly string[], below: readonly string[]): string[] {
  return below.map((cell, index) => {
    const lead = above[index]?.trim() ?? ''
    const base = cell.trim()
    if (!lead) return cell
    if (!base) return lead
    return `${lead} ${base}`
  })
}

/** The item name printed on its own line, above or below the quantities. */
function isLeadIn(cells: readonly string[]): boolean {
  const filled = cells.flatMap((cell, index) => (cell.trim() ? [{ text: cell.trim(), index }] : []))
  if (filled.length === 0 || filled.length > 2) return false
  if (filled.some((cell) => /^\d{1,5}$/.test(cell.text))) return false
  if (filled.some((cell) => /^\$?[\d,]+\.\d{2}\b/.test(cell.text))) return false
  return filled.every((cell) => cell.index <= 1)
}

function columnIndex(word: WordBox, bounds: readonly number[]): number {
  const anchor = word.x + word.width / 2
  let index = 0
  for (let cursor = 0; cursor < bounds.length; cursor += 1) {
    if (anchor >= (bounds[cursor] ?? 0)) index = cursor
  }
  // The taxable flag is a one-letter mark on the unit-price column. Its box
  // overlaps the following amount column by a few pixels.
  const boundary = bounds[index] ?? 0
  if (index > 0 && word.text === 'T' && word.x < boundary + word.height * 0.5) index -= 1
  // A price-change star sits in the gap just left of the price column.
  const nextBoundary = bounds[index + 1]
  if (
    word.text === '*' &&
    nextBoundary !== undefined &&
    nextBoundary - (word.x + word.width) <= word.height * 0.6
  ) {
    index += 1
  }
  return index
}

function isWrappedLine(cells: readonly string[]): boolean {
  const filledAt = cells.flatMap((cell, index) => (cell.trim() ? [index] : []))
  if (filledAt.length === 0 || filledAt.length > 2) return false
  const first = filledAt[0] ?? 0
  // A new item starts in the leading columns. A wrap only continues a
  // description (or a note) further to the right.
  return first >= 2
}

function isLineItem(cells: readonly string[]): boolean {
  const filled = cells.map((cell) => cell.trim()).filter((cell) => cell.length > 0)
  if (filled.length < 2) return false
  const hasQty = filled.some((cell) => /^\d{1,5}$/.test(cell))
  const hasMoney = filled.some((cell) => /\d+\.\d{2}/.test(cell))
  const hasCode = filled.some((cell) => /^[A-Za-z0-9-]{4,16}$/.test(cell) && /\d/.test(cell))
  // A blank case qty still leaves an item code and a price. A footer line
  // has neither a bare quantity nor a single code cell.
  return (hasQty && (hasMoney || hasCode)) || (hasMoney && hasCode)
}

function isRepeatedHeader(cells: readonly string[], columns: readonly HeaderColumn[]): boolean {
  const got = cells.map(normalize).filter((cell) => cell.length > 0)
  const want = columns.map((column) => normalize(column.label)).filter((cell) => cell.length > 0)
  if (got.length < 3 || want.length < 3) return false
  let hits = 0
  for (const cell of got) {
    if (want.some((header) => header === cell)) hits += 1
  }
  return hits >= 3 && hits >= Math.min(got.length, want.length) * 0.6
}

function isNote(cells: readonly string[]): boolean {
  const text = cells.map((cell) => cell.trim()).filter((cell) => cell.length > 0).join(' ')
  return text.startsWith('*')
}

function isRule(cells: readonly string[]): boolean {
  const text = cells.join('').replace(/\s/g, '')
  return text.length >= 4 && /^[-_=.*]+$/.test(text)
}

function isFurniture(cells: readonly string[]): boolean {
  const text = cells.join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return true
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(text)) return true
  if (/continued on (the )?next page/i.test(text)) return true
  return false
}

function appendWrap(row: TableRow, cells: readonly string[]): TableRow {
  return {
    confidence: row.confidence,
    cells: row.cells.map((cell, index) => {
      const extra = cells[index]?.trim() ?? ''
      if (!extra) return cell
      return cell.trim() ? `${cell} ${extra}` : extra
    }),
  }
}

function joinWords(words: readonly WordBox[]): string {
  const ordered = [...words].sort((a, b) => a.x - b.x || a.y - b.y)
  let out = ''
  for (const word of ordered) {
    const text = word.text.trim()
    if (!text) continue
    if (!out) {
      out = text
      continue
    }
    const prev = out[out.length - 1]
    const glue = prev === '-' || prev === '/' || text.startsWith('-') || text.startsWith('.')
    out = glue ? `${out}${text}` : `${out} ${text}`
  }
  return out
}

function cleanLabel(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function blank(count: number): string[] {
  return Array.from({ length: count }, () => '')
}

function lineBand(line: readonly WordBox[]): { top: number; bottom: number } {
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const word of line) {
    top = Math.min(top, word.y)
    bottom = Math.max(bottom, word.y + word.height)
  }
  return { top, bottom }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function meanConfidence(words: readonly WordBox[]): number {
  if (words.length === 0) return 0
  const sum = words.reduce((total, word) => total + word.confidence, 0)
  return sum / words.length
}
