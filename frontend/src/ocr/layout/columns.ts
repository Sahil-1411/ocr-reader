/**
 * Read a multi-column table (a wholesale invoice, a price list) by lining
 * words up under the printed header.
 *
 * Lottery tickets stay on their own readers. This one exists because a sales
 * invoice has a dozen columns, and treating every line as a label plus one
 * amount — or as a game-pack code — drops every cell past the second.
 */

import type { SkippedLine, SkipReason, TableRow } from '../types'
import { groupIntoLines, type WordBox } from './rows'

export interface ColumnTable {
  headers: string[]
  rows: TableRow[]
  /** Left edge of each column, in the same pixel space as the words. */
  bounds: number[]
  /** Printed lines the reader left out, and notes it cut, in printed order. */
  skipped: SkippedLine[]
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
    (word) =>
      word.text.trim().length > 0 &&
      word.width > 0 &&
      word.height > 0 &&
      // A box that is not on the page cannot sit under a title.
      Number.isFinite(word.x + word.y + word.width + word.height),
  )
  if (usable.length < 4) return null

  const lines = groupIntoLines(usable, overlapRatio)
  const header = findHeader(usable)
  const guided = header ? null : usableGuide(guide)
  if (!header && !guided) return null

  const columns = header?.columns ?? guided?.columns ?? []
  if (columns.length < 3) return null
  // A guide's columns are edges an earlier page learned, not titles printed on
  // this one. Their extents are made up, so nothing is placed by them.
  const titled = header !== null
  const headerWords = new Set(header?.words ?? [])
  const body = lines.filter(
    (line) =>
      !line.some((word) => headerWords.has(word)) &&
      !(header && lineBand(line).top < header.bottom - 2),
  )
  const lineHeight = median(usable.map((word) => word.height)) || 12
  const printed = header ? columnBounds(header.columns) : (guided?.bounds ?? [])
  const layout = learnLayout(body, columns, printed, lineHeight, titled)
  const bounds = layout.bounds
  // One printed line below the last, and no further: a blank line ends an item
  // however close the page sets its lines.
  const reach = Math.min(lineHeight * 1.5, typicalGap(body, layout.items, lineHeight) + lineHeight * 0.75)
  const rows: TableRow[] = []
  // Every line the reader prints over, so the reading can be checked against
  // the page without guessing what became of the rest of it.
  const skipped: SkippedLine[] = []
  const log = (reason: SkipReason, cells: readonly string[], confidence: number, y: number) => {
    const text = cells.map((cell) => cell.trim()).filter((cell) => cell.length > 0).join('  ')
    if (!text) return
    skipped.push({ reason, text, confidence, y })
  }
  let previousBand: { top: number; bottom: number } | null = null
  // A wrapped item name sits just above the numbers. Hold it until that row.
  let leadIn: { cells: string[]; band: { top: number; bottom: number }; confidence: number } | null =
    null
  /** A held name no item claimed is lost with the rest of the page furniture. */
  const dropLeadIn = () => {
    if (leadIn) log('unplaced', leadIn.cells, leadIn.confidence, leadIn.band.top)
    leadIn = null
  }

  for (const line of body) {
    const read = withoutStockNote(
      bucketsForLine(line, columns, bounds, lineHeight, titled).map(joinWords),
    )
    let cells: string[] = read.cells
    const confidence = meanConfidence(line)
    const top = lineBand(line).top
    for (const note of read.notes) log('note', [note], confidence, top)
    const item = isLineItem(cells)
    // A product can be called anything; only a line that is not an item can
    // be page furniture.
    if (!item && isFurniture(cells)) {
      log('furniture', cells, confidence, top)
      continue
    }
    if (isRule(cells)) continue
    if (isRepeatedHeader(cells, columns)) {
      log('repeated-header', cells, confidence, top)
      continue
    }
    if (!cells.some((cell) => cell.trim())) continue
    // Totals are not items, and nothing below a total is the rest of the item
    // above it.
    if (isSummary(cells, item)) {
      log('summary', cells, confidence, top)
      previousBand = null
      dropLeadIn()
      continue
    }

    const band = lineBand(line)
    if (!item) {
      const loose = settleOverflow(
        bucketsForLine(line, columns, bounds, lineHeight, titled, layout),
        layout,
      )
      // A lone speck of punctuation is not a cell.
      const text = loose.map((bucket) => (bucket.some(isInked) ? joinWords(bucket) : ''))
      const placed = placeLine(loose, layout)
      const previous = rows[rows.length - 1]
      const follows =
        previous !== undefined && previousBand !== null && band.top - previousBand.bottom <= reach
      // `***DAMAGED IN TRANSIT***` sits one line under the item before it, which is
      // the shape of a wrapped name, but it is the reason printed over the
      // item after it. A starred line is never the rest of an item: it is kept
      // as a row of its own where it is set in the columns, and dropped where
      // it is not, like any other banner.
      if (isStarred(text)) {
        if (placed === 'text' && text.some((cell) => /[A-Za-z]/.test(cell))) {
          rows.push({ cells: text, confidence, label: true })
        } else {
          log('unplaced', text, confidence, top)
        }
        dropLeadIn()
        previousBand = null
        continue
      }
      if (follows && previous && previousBand && placed === 'text') {
        rows[rows.length - 1] = appendWrap(previous, text)
        previousBand = { top: previousBand.top, bottom: Math.max(previousBand.bottom, band.bottom) }
        continue
      }
      // A coupon or a deposit printed under an item carries its own amount.
      // Appending that to the item's figures would corrupt them, so it is a
      // row of its own.
      if (follows && placed === 'figures') {
        rows.push({ cells: text, confidence })
        previousBand = band
        continue
      }
      if (placed === 'text' && isLeadIn(text)) {
        const closeLead: boolean = leadIn !== null && band.top - leadIn.band.bottom <= reach
        if (closeLead && leadIn) {
          leadIn = {
            cells: combineCells(leadIn.cells, text),
            band: { top: leadIn.band.top, bottom: band.bottom },
            confidence: Math.min(leadIn.confidence, confidence),
          }
        } else {
          dropLeadIn()
          leadIn = { cells: text, band, confidence }
        }
        continue
      }
      // The legal footer, a notes block, a banner: they share the page with
      // the table but they are not part of any item.
      log('unplaced', text, confidence, top)
      dropLeadIn()
      continue
    }
    // A heading one blank line above the item is not its name.
    if (leadIn && band.top - leadIn.band.bottom <= reach) {
      cells = combineCells(leadIn.cells, cells)
      leadIn = null
    }
    dropLeadIn()
    rows.push({ cells, confidence })
    previousBand = band
  }
  dropLeadIn()

  // One item is enough when the columns are known. The last page of a long
  // invoice often carries a single item above the totals, and refusing it sent
  // that page to the label-and-amount reader. Labels do not count: they fill
  // one cell by nature and say nothing about whether this is a table.
  if (!rows.some((row) => !row.label)) return null

  skipped.sort((a, b) => a.y - b.y)
  return { headers: columns.map((column) => column.label), rows, bounds, skipped }
}

function usableGuide(
  guide: ColumnGuide | null | undefined,
): { columns: HeaderColumn[]; bounds: number[] } | null {
  if (!guide || guide.headers.length < 3 || guide.bounds.length !== guide.headers.length) return null
  // A guide knows where each column begins and nothing about its title, so
  // a guided column spans to the next edge; no word is placed by that span.
  const columns = guide.headers.map((label, index) => {
    const x = guide.bounds[index] ?? 0
    return { label, x, right: guide.bounds[index + 1] ?? x }
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
  const bandOf = (group: readonly WordBox[]) => {
    let top = Infinity
    let bottom = -Infinity
    for (const word of group) {
      top = Math.min(top, word.y)
      bottom = Math.max(bottom, word.y + word.height)
    }
    const band = { top: top - height * 0.35, bottom: bottom + height * 0.35 }
    const inBand = words.filter((word) => {
      const center = word.y + word.height / 2
      return center >= band.top && center <= band.bottom && word.text.trim().length > 0
    })
    return { bottom, words: inBand }
  }
  // Largest group first. A band that carries an amount is not titles: it is
  // the totals block, `MERCHANDISE TOTAL 173.53 / SALES TAX / INVOICE TOTAL`,
  // which has as many header words as the real header, or more.
  const groups = hits
    .map((anchor) => {
      const anchorCenter = anchor.y + anchor.height / 2
      return hits.filter((word) => Math.abs(word.y + word.height / 2 - anchorCenter) <= reach)
    })
    .sort((a, b) => b.length - a.length)
  const best = groups.find(
    (group) => !bandOf(group).words.some((word) => /^\$?[\d,]*\d\.\d{2}$/.test(word.text.trim())),
  )
  if (!best || best.length < 3) return null

  const { bottom, words: headerWords } = bandOf(best)
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
  // Line by line, and left to right within a line: a recogniser can set the
  // second word of `UNIT PRICE` a pixel or two higher than the first.
  const byTop = [...words].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: WordBox[][] = []
  for (const word of byTop) {
    const row = rows[rows.length - 1]
    const centre = word.y + word.height / 2
    const above = row?.[0]
    if (row && above && Math.abs(centre - (above.y + above.height / 2)) <= above.height * 0.4) row.push(word)
    else rows.push([word])
  }
  const ordered = rows.flatMap((row) => row.sort((a, b) => a.x - b.x))
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

/**
 * The words of one line, sorted into the columns they are printed in.
 *
 * `continuing` is passed for a line that is not an item: a wrapped name that
 * runs on under the next title is still the name, so a phrase that starts in a
 * column of words stays there whole.
 */
function bucketsForLine(
  line: readonly WordBox[],
  columns: readonly HeaderColumn[],
  bounds: readonly number[],
  lineHeight: number,
  titled: boolean,
  continuing?: TableLayout,
): WordBox[][] {
  const buckets: WordBox[][] = columns.map(() => [])
  for (const field of fieldsOnLine(line, lineHeight)) {
    const start = columnIndex(field.find(isInked) ?? field[0]!, bounds)
    if (continuing?.profiles[start]?.kind === 'text') {
      buckets[start]?.push(...field)
      continue
    }
    const hits = titled
      ? columns.flatMap((column, index) => (horizontalOverlap(field, column) > 0 ? [index] : []))
      : []
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
  return buckets
}

/**
 * Give words that run short of their column back to the words before them.
 *
 * On a line that is not an item, words that start before a column's own text
 * does, straight after words in a column of names or codes, are the tail of
 * those words: `ASSORTED COLORS COUNTER DISPLAY` wrapped under a description
 * reaches under PACK without being a pack size.
 */
function settleOverflow(buckets: readonly WordBox[][], layout: TableLayout): WordBox[][] {
  const settled = buckets.map((bucket) => [...bucket])
  let owner = -1
  settled.forEach((bucket, index) => {
    const inked = bucket.filter(isInked)
    if (inked.length === 0) return
    const profile = layout.profiles[index]
    const short = profile && Math.min(...inked.map((word) => word.x)) < profile.left - layout.charWidth
    if (owner >= 0 && short && profile.kind !== 'figure' && /[A-Za-z]/.test(joinWords(inked))) {
      settled[owner]!.push(...bucket)
      settled[index] = []
      return
    }
    owner = !profile || profile.kind !== 'figure' ? index : -1
  })
  return settled
}

/** A word with a letter or digit in it; a lone speck of punctuation is not one. */
function isInked(word: WordBox): boolean {
  return /[A-Za-z0-9]/.test(word.text)
}

/* -------------------------------------------------------------------------- */
/* Learning the columns from the rows                                          */
/* -------------------------------------------------------------------------- */

/**
 * What a column holds. Words wrap onto a second line and codes can carry one
 * (a lot number under the item code); figures never do, so a line that lands
 * in a column of figures is a total or an amount of its own.
 */
type ColumnKind = 'text' | 'code' | 'figure'

/** What the item rows say about one column. */
interface ColumnProfile {
  /** Where the leftmost item row starts this column's text. */
  left: number
  /** Where the rightmost item row ends it. */
  right: number
  /** Whether most item rows start the column at the same x, to within a character. */
  aligned: boolean
  kind: ColumnKind
  /** A figure column of amounts rather than counts: prices, not quantities or pack sizes. */
  money: boolean
}

interface TableLayout {
  bounds: number[]
  /** Per column; undefined where no item row filled it, so nothing is known. */
  profiles: Array<ColumnProfile | undefined>
  charWidth: number
  /** The lines recognised as item rows. */
  items: ReadonlySet<readonly WordBox[]>
}

/**
 * Settle the column edges against the rows, and learn what each column holds.
 *
 * The printed titles place the columns only roughly. A description column is
 * titled with one short word over text that runs half the page, and prices
 * are right-aligned under titles that sit anywhere over them. The edges
 * `columnBounds` guesses from the titles alone cut straight through the
 * description on some invoices, and every item code printed after a double
 * space — `HERB CAN  #508812` — then lands under UNIT PRICE.
 *
 * The item rows know better. A real boundary is a gutter every item leaves
 * empty; so when the rows put what belongs to one column on the other side of
 * a guessed edge, the edge moves into the gutter they leave between the two.
 * An edge the rows agree with stays close to where it was: see
 * `refineBounds` for the small nudges it may still get.
 *
 * A page read with a guide has no titles to be rough about: its edges were
 * settled on the page that printed them, and they are used as they are.
 */
function learnLayout(
  body: readonly WordBox[][],
  columns: readonly HeaderColumn[],
  printed: readonly number[],
  lineHeight: number,
  titled: boolean,
): TableLayout {
  // Item rows are recognisable under rough edges: a quantity and a price
  // survive a boundary in the wrong place, only the text between them moves.
  // A totals line has that shape too, and is not an item.
  const items = body.filter((line) => {
    const cells = bucketsForLine(line, columns, printed, lineHeight, titled).map(joinWords)
    return isLineItem(cells) && !isSummary(cells, true)
  })
  const charWidth = characterWidth(items.flat()) || lineHeight * 0.5
  if (items.length === 0) return { bounds: [...printed], profiles: [], charWidth, items: new Set() }

  const bounds = titled ? refineBounds(printed, columns, items, charWidth, lineHeight) : [...printed]
  const filled: WordBox[][][] = columns.map(() => [])
  for (const line of items) {
    bucketsForLine(line, columns, bounds, lineHeight, titled).forEach((bucket, index) => {
      if (bucket.length > 0) filled[index]?.push(bucket)
    })
  }
  const profiles = filled.map((cells, index): ColumnProfile | undefined => {
    if (cells.length === 0) return undefined
    const lefts = cells.map((cell) => Math.min(...cell.map((word) => word.x)))
    const left = Math.min(...lefts)
    return {
      left,
      right: Math.max(...cells.map((cell) => Math.max(...cell.map((word) => word.x + word.width)))),
      // Most rows, not all: one odd row does not make a set column ragged.
      aligned: lefts.filter((x) => x - left <= charWidth).length >= lefts.length * 0.75,
      kind: kindOf(cells.map(joinWords), columns[index]?.label ?? ''),
      money: cells.filter((cell) => /\d\.\d{2}/.test(joinWords(cell))).length >= cells.length * 0.5,
    }
  })
  return { bounds, profiles, charWidth, items: new Set(items) }
}

/**
 * The kind most of a column's cells are.
 *
 * A five-digit item number reads like a quantity, and nothing in `20881`
 * says which it is. The title does: under `Item#`, `Code` or `UPC` a number
 * is a code, and a lot number printed under it is part of the item.
 */
function kindOf(cells: readonly string[], label: string): ColumnKind {
  const share = (test: (cell: string) => boolean) =>
    cells.filter(test).length / Math.max(1, cells.length)
  const coded = CODE_TITLE.test(label) && !QUANTITY_TITLE.test(label) && !MONEY_TITLE.test(label)
  // Under a code title a whole number is a code; an amount is still an amount.
  const figure = coded ? (cell: string) => isFigure(cell) && /\d\.\d/.test(cell) : isFigure
  if (share(figure) >= 0.5) return 'figure'
  if (share((cell) => /[A-Za-z]{2,}/.test(cell)) >= 0.5) return 'text'
  return 'code'
}

const CODE_TITLE = /#|\b(?:item|code|sku|part|upc|ean|ref|style|model|no|number)\b/i
const QUANTITY_TITLE = /\b(?:qty|quantity|count|units?|ord(?:ered)?|ship(?:ped)?)\b/i
/** `Item Price`, `Item Subtotal`: the item's money, not its code. */
const MONEY_TITLE = /\b(?:price|prc|cost|amount|amt|total|subtotal|ext(?:ended)?|value|charge)\b/i

/**
 * A quantity or an amount: `2`, `-7`, `19.62`, `(12.00)`, `$ 1,120.00`, and
 * with the marks printed beside them, `0.069 T` or `* 3.21`. Six digits and
 * more with no decimal point are a code, not a quantity: `012345000017`.
 */
function isFigure(text: string): boolean {
  const core = text.trim().replace(/^[*\s]+/, '').replace(/\s+[A-Z*]$/, '')
  return isQuantity(core) || /^[(-]?\$?\s?-?[\d,]*\d\.\d{1,4}\)?-?$/.test(core)
}

/**
 * A count of items: `2`, `1,000`, and a credit or return as printed, `-2`,
 * `(2)` or `2-`. Six digits and more are a code.
 */
function isQuantity(text: string): boolean {
  return /^(?:-?(?:\d{1,5}|\d{1,3}(?:,\d{3})+)|\(\d{1,5}\)|\d{1,5}-)$/.test(text.trim())
}

/**
 * The usual space below an item row, from the page itself.
 *
 * Measured under the items only: a totals block or a paragraph of terms is
 * often set tighter than the table, and learning from it would make an item's
 * own second line look a line too far away. With nothing to measure, the
 * reach is a line and a half as before.
 */
function typicalGap(
  lines: readonly WordBox[][],
  items: ReadonlySet<readonly WordBox[]>,
  lineHeight: number,
): number {
  const ordered = [...lines].sort((a, b) => lineBand(a).top - lineBand(b).top)
  const gaps: number[] = []
  for (let index = 1; index < ordered.length; index += 1) {
    if (!items.has(ordered[index - 1]!)) continue
    const gap = lineBand(ordered[index]!).top - lineBand(ordered[index - 1]!).bottom
    // Lines that overlap are one printed line set on two baselines.
    if (gap > -lineHeight * 0.5) gaps.push(Math.max(0, gap))
  }
  if (gaps.length === 0) return lineHeight
  // The tighter gaps, not the middle one: on a page grouped by category half
  // the items are followed by a blank line and a heading, and the middle gap
  // is then a blank line.
  return [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * 0.25)] ?? lineHeight
}

/**
 * Move an edge when the item rows show it on the wrong side of what a column
 * owns, into the gutter they leave between the two columns.
 *
 * What a column owns: a phrase set under its title and no other, whatever the
 * edges say. Then what the titles cannot tell, phrases under no title: a
 * figure belongs to the column of figures whose title it follows; an item
 * code set off after the name, `CAN  #508812` or tab-set far right of a
 * short DESCRIPTION, is the end of the words before it, when the next column
 * holds figures or starts its own text further on. And words are never a
 * figure column's, so a name running on into the quantities marks the edge
 * as short.
 *
 * An edge with each side's own on its own side is right, even when a wider
 * gap exists elsewhere, and is only nudged: out of an item's ink, and after a
 * column of words to three characters short of the next column's ink. Either
 * way it stays in its gutter, so nothing on this page changes side.
 *
 * Occupancy is counted per line, as in `table.ts`: a gutter is an x range no
 * item row puts a word in, with ink on both sides of it between the two
 * titles, after everything the left column owns and before everything the
 * right one owns. A word space shows up as a gap on one row and is covered on
 * the next, so across many rows only the gutter survives. With few rows a
 * double space can survive too, which is why the widest run is taken, and on
 * a tie the one nearer the right column's own ink.
 *
 * When no gutter a character and a half wide exists, any clear strip between
 * the two sides' own will do: one tightly set row pins the edge there. Failing
 * that, one row in ten may intrude, and on a page of three items or more one
 * row; failing that too, the printed edge stands.
 */
function refineBounds(
  printed: readonly number[],
  columns: readonly HeaderColumn[],
  items: readonly WordBox[][],
  charWidth: number,
  lineHeight: number,
): number[] {
  const owned: WordBox[][][] = columns.map(() => [])
  const strays: WordBox[][] = []
  for (const line of items) {
    for (const field of fieldsOnLine(line, lineHeight)) {
      const hits = columns.flatMap((column, index) =>
        horizontalOverlap(field, column) > 0 ? [index] : [],
      )
      if (hits.length === 1) owned[hits[0]!]!.push(field)
      else if (hits.length === 0) strays.push(field)
    }
  }
  const titleBefore = (field: readonly WordBox[]) => {
    const start = Math.min(...field.map((word) => word.x))
    return columns.reduce((found, column, at) => (column.x <= start ? at : found), -1)
  }
  const kindsOf = () =>
    owned.map((fields, index) =>
      fields.length > 0 ? kindOf(fields.map(joinWords), columns[index]?.label ?? '') : undefined,
    )
  let kinds = kindsOf()
  // A short figure under a centred or left-set title can clear the title
  // entirely: `4.75` right-aligned under RATE, every price under a PRICE
  // title printed at the column's left edge. It is the figure column's whose
  // title it follows.
  for (const field of strays) {
    if (!isFigure(joinWords(field))) continue
    const index = titleBefore(field)
    if (index >= 0 && (kinds[index] ?? 'figure') === 'figure') owned[index]!.push(field)
  }
  kinds = kindsOf()
  // A lettered stray after a column of words is the end of those words when
  // the next column holds figures, or when it stops short of where the next
  // column's own text starts: `HONEY MUSTARD  12OZ` before a PACK column.
  const nextStarts = owned.map((fields) => Math.min(Infinity, ...fields.flat().map((word) => word.x)))
  for (const field of strays) {
    if (!/[A-Za-z#]/.test(joinWords(field))) continue
    const index = titleBefore(field)
    if (index < 0 || kinds[index] !== 'text') continue
    const end = Math.max(...field.map((word) => word.x + word.width))
    const short = end < (nextStarts[index + 1] ?? Infinity) - charWidth
    if (kinds[index + 1] === 'figure' || (kinds[index + 1] !== undefined && short)) owned[index]!.push(field)
  }
  const ownedWords = new Set(owned.flat(2))
  const ends = owned.map((fields) =>
    Math.max(-Infinity, ...fields.flat().map((word) => word.x + word.width)),
  )
  const starts = owned.map((fields) => Math.min(Infinity, ...fields.flat().map((word) => word.x)))
  const centre = (word: WordBox) => word.x + word.width / 2
  // How many item rows have ink over each stretch of x, as a sweep over word
  // edges rather than a counter per pixel: a PDF can park hidden text far off
  // the page, and the work should not grow with how far.
  const edges: Array<{ x: number; step: number }> = []
  for (const line of items) {
    // A row covers a stretch once, however many of its words overlap there.
    for (const [start, end] of union(line.map((word) => [word.x, word.x + word.width] as const))) {
      edges.push({ x: start, step: 1 }, { x: end, step: -1 })
    }
  }
  edges.sort((a, b) => a.x - b.x || a.step - b.step)
  const coverage: Array<{ start: number; end: number; rows: number }> = []
  let rows = 0
  edges.forEach((edge, index) => {
    rows += edge.step
    const next = edges[index + 1]
    if (next && next.x > edge.x) coverage.push({ start: edge.x, end: next.x, rows })
  })

  const minGap = Math.max(2, charWidth * 1.5)
  /**
   * Clear runs inside [from, to) with ink on both sides, widest first.
   *
   * A run that reaches either end of the window is not between two columns:
   * it is the empty stretch beside a column no item row filled, or the space
   * between a title and numbers set well to its right.
   */
  const gutters = (from: number, to: number, allowed: number, narrowest = minGap) => {
    const inked = union(
      coverage
        .filter((stretch) => stretch.rows > allowed && stretch.end > from && stretch.start < to)
        .map((stretch) => [Math.max(stretch.start, from), Math.min(stretch.end, to)] as const),
    )
    const found: Array<{ start: number; end: number }> = []
    for (let index = 1; index < inked.length; index += 1) {
      found.push({ start: inked[index - 1]![1], end: inked[index]![0] })
    }
    // Widest first; within a pixel, the one nearer the right column's ink.
    return found
      .filter((run) => run.end - run.start >= narrowest)
      .sort((a, b) => {
        const wider = b.end - b.start - (a.end - a.start)
        return Math.abs(wider) < 1 ? b.end - a.end : wider
      })
  }

  // One row in ten may run into the gutter, and on a short page one row: a
  // single description set to within a space of its price must not cost the
  // page its boundary, and every later page read by the guide with it.
  const tolerance = Math.max(Math.floor(items.length * 0.1), items.length >= 3 ? 1 : 0)
  const bounds = [...printed]
  for (let index = 1; index < bounds.length; index += 1) {
    const edge = bounds[index]!
    // Words are never a figure column's. A name that runs on into the
    // quantities under no title of its own, `MARLBORO RED KS BOX  2`, shows
    // the edge is short of the gutter.
    const intruders =
      kinds[index] === 'figure'
        ? items
            .flat()
            .filter(
              (word) =>
                !ownedWords.has(word) &&
                /[A-Za-z]{2,}/.test(word.text) &&
                centre(word) >= edge &&
                centre(word) < (printed[index + 1] ?? Infinity),
            )
        : []
    const sorted =
      intruders.length === 0 &&
      owned[index - 1]!.every((field) => field.every((word) => centre(word) < edge)) &&
      owned[index]!.every((field) => field.every((word) => centre(word) >= edge))
    // An edge that parts each side's own is roughly right and stays near
    // where it is, but two places are not good enough. In an item's ink,
    // where a title's shoulder can put it, a wrapped name a little longer than
    // the items would cross it. And after a column of words, anywhere short
    // of the next column: this page's names may all be short, but the edge is
    // the guide the next page is read with, and that page's may not be. Such
    // an edge is nudged into the nearest gutter a few characters away, when
    // both columns own enough ink to say where the gutter is.
    const inInk = coverage.some((stretch) => stretch.rows > 0 && stretch.start < edge && edge < stretch.end)
    const nudge =
      sorted &&
      (inInk || kinds[index - 1] === 'text') &&
      owned[index - 1]!.length > 0 &&
      owned[index]!.length > 0
    if (sorted && !nudge) continue

    const from = Math.max(bounds[index - 1]! + 1, columns[index - 1]?.x ?? -Infinity)
    // No further than the right column's own ink: its figures usually start
    // under its title, and any further the window takes in the next column's
    // gutter too. Figures set wholly right of a left-aligned title are the
    // exception, and the window reaches them.
    const reachRight = Number.isFinite(starts[index]!) ? starts[index]! + charWidth : -Infinity
    const to = Math.min(
      printed[index + 1] ?? Infinity,
      Math.max(columns[index]?.right ?? Infinity, reachRight),
    )
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(from < to)) continue

    // A pixel of slack either way, for boxes that touch.
    const after = Math.max(ends[index - 1]!, ...intruders.map((word) => word.x + word.width)) - 1
    const before = starts[index]! + 1
    const distance = (run: { start: number; end: number }) =>
      edge < run.start ? run.start - edge : edge > run.end ? edge - run.end : 0
    // Only an edge in the wrong place may use the tolerance for an intruding row.
    // In order: a clear gutter; any clear strip at all between the two sides'
    // own ink, when that is all a tightly set row leaves (it pins the edge);
    // and only then a gutter that tolerates an intruding row.
    const searches: Array<[allowed: number, narrowest: number]> = nudge
      ? [[0, charWidth]]
      : [
          [0, minGap],
          [0, 1],
          [tolerance, minGap],
        ]
    for (const [allowed, narrowest] of searches) {
      const admissible = gutters(from, to, allowed, narrowest).filter(
        (run) => run.start >= after && run.end <= before,
      )
      const gutter = nudge
        ? admissible
            .filter((run) => distance(run) <= charWidth * 3)
            .sort((a, b) => distance(a) - distance(b))[0]
        : admissible[0]
      if (!gutter) continue
      // Words run on and figures do not: a description can be longer on the
      // next page, an amount only a digit or two wider. So after a column of
      // words the edge sits three characters short of the next column's ink,
      // where the guide the next page reads with keeps a longer name on its
      // side, and a page scanned a few millimetres left of the one before
      // still keeps its figures on theirs.
      const width = gutter.end - gutter.start
      bounds[index] =
        kinds[index - 1] === 'text'
          ? gutter.end - Math.min(width / 2, charWidth * 3)
          : (gutter.start + gutter.end) / 2
      break
    }
  }
  return bounds
}

/**
 * Where a line that is not an item sits among the columns.
 *
 * - `text`: it is set in the item rows' columns of words, codes and counts,
 *   as the rest of an item is. A wrapped description starts where
 *   descriptions start, or further in: the `$10.00 OFF …` line under a cigar
 *   box is indented under the name it belongs to. A lot number starts where
 *   the item codes start, and a catch weight sits under the pack size.
 * - `figures`: words in those columns and then an amount under a column of
 *   amounts, as a coupon or a deposit printed under an item is.
 * - null: anything else. A banner (`*** CONTINUED NEXT PAGE ***`) or a block of
 *   notes starts out in the gutter between two columns, because it was never
 *   set to them. Words under a column of figures are a total or a footnote.
 *
 * A column no item row filled carries no evidence about words, and lets them
 * through; a figure there is an amount of the line's own, like any other.
 * Specks of punctuation are ignored: they say nothing about where a line was
 * set.
 */
function placeLine(buckets: readonly WordBox[][], layout: TableLayout): 'text' | 'figures' | null {
  const slack = layout.charWidth
  let worded = false
  let figures = false
  let filled = 0
  for (const [index, bucket] of buckets.entries()) {
    const inked = bucket.filter(isInked)
    if (inked.length === 0) continue
    filled += 1
    const profile = layout.profiles[index]
    const text = joinWords(inked)
    if (profile?.kind === 'figure' && !profile.money && isFigure(text)) continue
    if (profile?.kind === 'figure' || (!profile && isFigure(text))) {
      if (!worded || !isFigure(text)) return null
      figures = true
      continue
    }
    if (figures) return null
    if (profile) {
      const start = Math.min(...inked.map((word) => word.x))
      const end = Math.max(...inked.map((word) => word.x + word.width))
      // Centred or ragged text can start anywhere the column's text spans.
      const fits =
        profile.kind === 'code' || profile.aligned
          ? start >= profile.left - slack && start <= profile.right + slack
          : end >= profile.left - slack && start <= profile.right + slack
      if (!fits) return null
    }
    worded = true
  }
  // A continuation is a line or two of a name with its sizes, not a row of
  // its own: past three filled columns it is something else.
  if (!worded || filled > 3) return null
  return figures ? 'figures' : 'text'
}

/** The stretches covered by any of `spans`, merged and in order. */
function union(spans: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = []
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** Width of one character, from the words themselves. */
function characterWidth(words: readonly WordBox[]): number {
  return median(
    words
      .filter((word) => word.text.trim().length > 0)
      .map((word) => word.width / word.text.trim().length)
      .filter((width) => width > 0),
  )
}

function horizontalOverlap(field: readonly WordBox[], column: HeaderColumn): number {
  const x = Math.min(...field.map((word) => word.x))
  const right = Math.max(...field.map((word) => word.x + word.width))
  return Math.min(right, column.right) - Math.max(x, column.x)
}

/**
 * Words separated by a real space stay one field. A column gap starts the next.
 *
 * Except after a lone currency sign: accounting layouts set `$` at the left of
 * the cell and the figure at its right, and the sign is part of the amount.
 */
function fieldsOnLine(line: readonly WordBox[], lineHeight: number): WordBox[][] {
  const ordered = [...line].sort((a, b) => a.x - b.x || a.y - b.y)
  const fields: WordBox[][] = []
  for (const word of ordered) {
    const current = fields[fields.length - 1]
    const previous = current?.[current.length - 1]
    const gap = previous ? word.x - (previous.x + previous.width) : 0
    const sign = current?.length === 1 && /^[$€£]$/.test(previous?.text.trim() ?? '')
    if (current && (gap <= lineHeight * 0.8 || sign)) current.push(word)
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

/**
 * The shape of an item name printed on its own line, above or below the
 * quantities: one or two cells in the leading columns, words not figures.
 */
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

function isLineItem(cells: readonly string[]): boolean {
  // Stars flag an item (`*10234` backordered), they do not make it another thing.
  const filled = cells
    .map((cell) => cell.trim().replace(/^\*+|\*+$/g, '').trim())
    .filter((cell) => cell.length > 0)
  if (filled.length < 2) return false
  const hasQty = filled.some(isQuantity)
  // A price is in a cell of figures. `$10.00 OFF …` under an item mentions
  // money; it is not priced. Two amounts under rough edges can share a cell,
  // and a recogniser can read `$` as `S`: both are still priced.
  const hasMoney = filled.some((cell) => !/[A-Za-z]{2,}/.test(cell) && /\d\.\d{2}/.test(cell))
  const hasCode = filled.some((cell) => /^[A-Za-z0-9-]{4,24}$/.test(cell) && /\d/.test(cell))
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

/**
 * A line set off with stars: `***SHORT PRODUCT***`, `* PRICE CHANGE`. Not a
 * name that merely starts with a starred tag, `*NEW* MARLBORO SPECIAL BLEND`,
 * which is the item's own name printed above its figures.
 */
function isStarred(cells: readonly string[]): boolean {
  const text = cells.map((cell) => cell.trim()).filter((cell) => cell.length > 0).join(' ')
  return /^\*+[^*]+\*+$/.test(text) || /^\*+\s/.test(text)
}

/** Words a totals block is made of, and nothing an item is called. */
const SUMMARY_WORD =
  /^(?:sub|sub-?totals?|totals?|tax(?:es|able)?|sales|shipping|ship|freight|handling|discounts?|disc|balance|due|amount|amt|grand|net|payments?|paid|credits?|deposits?|pieces|pcs|cases|items|qty|quantity|units|merchandise|invoice|order|of|and|the)$/i
/**
 * A word that makes a line with a figure on it a total: `SALES TAX 13.88`,
 * `TOTAL DAIRY 272.20`, `Estimated tax to be collected: $13.44`. Not a
 * discount or a deposit: printed under an item, those are the item's.
 */
const SUMMARY_KEY =
  /^(?:sub-?totals?|totals?|tax(?:es)?|balance|freight|shipping|handling|payments?|paid|grand|due)$/i
/**
 * With a quantity and an amount a totals line has an item's shape, and then
 * only a total or a balance says otherwise: `1  FREIGHT  25.00  25.00` is a
 * charge on the invoice, `TOTAL  4  4  173.53` is not.
 */
const SUMMARY_TOTAL = /^(?:sub-?totals?|totals?|grand|balance|due)$/i

/**
 * A line of the totals block, or a category's subtotal within the table.
 *
 * A line that is not an item is a total when it names one and carries a
 * figure: `MERCHANDISE TOTAL 173.53`, `TOTAL CASES 14`, `GROUP TOTAL****
 * 272.20`. Without a figure it may be the wrapped end of a name, `GRAND TOTAL
 * AND TAX`, and is left to be placed.
 *
 * A line shaped like an item is a total when all its words are totals words,
 * `TOTAL  4  4  173.53`; or when it is a short line naming a total with one
 * amount and no item code, `DAIRY TOTAL  6  272.20`, where an item priced
 * each and in all would carry two.
 */
function isSummary(cells: readonly string[], item: boolean): boolean {
  const words = cells
    .join(' ')
    .split(/[^A-Za-z-]+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => /[A-Za-z]/.test(word))
  if (words.length === 0) return false
  const figured = cells.some((cell) => cell.split(/\s+/).some((token) => isFigure(token)))
  if (!item) return figured && words.some((word) => SUMMARY_KEY.test(word))
  if (!words.some((word) => SUMMARY_TOTAL.test(word))) return false
  if (words.every((word) => SUMMARY_WORD.test(word))) return true
  const amounts = cells.filter((cell) => /\d\.\d{2}/.test(cell) && !/[A-Za-z]{2,}/.test(cell)).length
  const coded = cells.some((cell) => /^[A-Za-z0-9-]{4,24}$/.test(cell.trim()) && /\d/.test(cell))
  return words.length <= 3 && amounts === 1 && !coded
}

/**
 * `OUT OF STOCK` and `NO STOCK`, which the invoice prints under an item, or
 * beside it, as a note on the order. The words say nothing about what the
 * product is, so they are cut out before the line is placed: on its own line
 * the note then has no cells left and is dropped like any blank line, and on
 * an item's own line the description keeps only the item's name.
 *
 * The reader can set the phrase with or without its spaces, and a note is
 * often starred — `***OUT OF STOCK***` — so a cell left with nothing but
 * decoration is emptied too.
 */
const STOCK_NOTE = /\bout\s*of\s*stock\b|\bno\s*stock\b/i
const STOCK_NOTES = new RegExp(STOCK_NOTE.source, 'gi')

/** `cells` without any stock note, beside the notes that were cut out of them. */
function withoutStockNote(cells: readonly string[]): { cells: string[]; notes: string[] } {
  if (!cells.some((cell) => STOCK_NOTE.test(cell))) return { cells: [...cells], notes: [] }
  const notes: string[] = []
  const kept = cells.map((cell) => {
    if (!STOCK_NOTE.test(cell)) return cell
    notes.push(...(cell.match(STOCK_NOTES) ?? []))
    const cut = cell.replace(STOCK_NOTES, ' ').replace(/\s+/g, ' ').trim()
    return /[A-Za-z0-9]/.test(cut) ? cut : ''
  })
  return { cells: kept, notes }
}

function isRule(cells: readonly string[]): boolean {
  const text = cells.join('').replace(/\s/g, '')
  return text.length >= 4 && /^[-_=.*]+$/.test(text)
}

function isFurniture(cells: readonly string[]): boolean {
  const text = cells.join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return true
  // `Page 2`, `Page: 1 of 2`, `*** PAGE 1 OF 2 ***`, `Pg 1/2`. A bare `PG 13`
  // could be a film rating in a name, and stays.
  const bare = text.replace(/[*=_~]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (/^page\s*:?\s*\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(bare)) return true
  if (/^pg\.?\s*:?\s*\d+\s*(?:of|\/)\s*\d+$|^pg\.\s*\d+$/i.test(bare)) return true
  // `*** CONTINUED ***` set off as a banner. Undecorated, the word can be the
  // last line of a wrapped name, and stays.
  const letters = text.replace(/[^A-Za-z]/g, '').toLowerCase()
  if (/^(?:continued|continues|contd)$/.test(letters) && /[*=-]/.test(text)) return true
  return isPageContinuation(text)
}

const PAGE_REFERENCE =
  /(?:continu(?:e|es|ed|ing)|contd|cont)(?:on|to|from)?(?:the)?(?:next|following|previous|prior|last)?page|(?:on|to|from)(?:the)?(?:next|following|previous|prior)page/g

/**
 * `Continued on next page` and its kin, however it is set: `CONT'D ON NEXT
 * PAGE`, `CONTINUED FROM PAGE 1`, `MORE ITEMS ON NEXT PAGE`.
 *
 * Matched on the letters alone, because the banner is often letter-spaced for
 * emphasis — `*** C O N T I N U E D  N E X T  P A G E ***` — which no phrase
 * pattern over the words matches. The match has to begin a word, so an item
 * called `DISCONTINUED PAGE MARKERS` is not a banner. A bare `CONTINUED` is
 * left alone: on its own it is as likely to be the end of a wrapped name.
 */
function isPageContinuation(text: string): boolean {
  let letters = ''
  const startsWord: boolean[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (!/[A-Za-z]/.test(char)) continue
    startsWord.push(index === 0 || !/[A-Za-z]/.test(text[index - 1]!))
    letters += char.toLowerCase()
  }
  for (const match of letters.matchAll(PAGE_REFERENCE)) {
    if (startsWord[match.index]) return true
  }
  return false
}

function appendWrap(row: TableRow, cells: readonly string[]): TableRow {
  return {
    ...row,
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
  let previous: WordBox | null = null
  for (const word of ordered) {
    const text = word.text.trim()
    if (!text) continue
    if (!out || !previous) {
      out = text
      previous = word
      continue
    }
    // A reader can break `849-1706888` in two at the hyphen, or `3.45` at the
    // point, and the halves are only a glyph's own margin apart. `24'S -115
    // COUNT` is printed with a space before the minus, and the gap says so;
    // gluing on the character alone deleted it. Measured in characters, not
    // box height: a recogniser's box is as tall as the ink, a PDF's as the font.
    const gap = word.x - (previous.x + previous.width)
    const glyph = Math.max(previous.width / previous.text.trim().length, word.width / text.length)
    const prev = out[out.length - 1]
    // Nobody prints `12 .50`: a decimal tail after a digit is always the same
    // figure. And a token that ends in a hyphen or slash, `849-`, goes on:
    // the reader split it, and a jittered box can leave half a glyph between.
    // A dash on its own is punctuation, `plan - Gold`, unless a figure
    // follows it closely: `-` `2` is a minus the reader split off.
    const decimals = /^\.\d/.test(text) && /\d$/.test(out) && gap < glyph
    const lone = previous.text.trim() === '-'
    const runsOn = (prev === '-' || prev === '/') && !lone && gap < glyph * 0.6
    const joiner = text.startsWith('-') || text.startsWith('.') || (lone && /^\d/.test(text))
    out = decimals || runsOn || (joiner && gap <= glyph * 0.35) ? `${out}${text}` : `${out} ${text}`
    previous = word
  }
  return out
}

function cleanLabel(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
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
