/**
 * Turn word boxes into label/value rows.
 *
 * Receipts are rows, not columns. Each printed line has a description on the
 * left and a value (an amount, a date, or a run of counts) on the right. The
 * reader only returns words, so this module does the two geometric steps:
 * stack words that share a baseline, then split that line.
 */

import type { InventoryRow, ReceiptField, ReceiptKind, SettlementRow } from '../types'

export interface WordBox {
  text: string
  x: number
  y: number
  width: number
  height: number
  /** Recognition confidence in [0, 1]. */
  confidence: number
}

const AMOUNT =
  /^\$?\d{1,3}(?:,\d{3})+(?:\.\d{2})?[A-Za-z]?$|^\$?\d+\.\d{2}[A-Za-z]?$/
const DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/
const TIME = /^\d{1,2}:\d{2}(?::\d{2})?$/
const COUNT = /^\d{1,3}$/
/** Instant game numbers on these sheets are three digits, e.g. `815`. */
const GAME = /^\d{3}$/
const LONG_ID = /^\d{4,8}$/
const DECIMAL_TAIL = /^\.\d{2}[A-Za-z]?$/
const CREDIT = /^[Cc]$/

/** Strip wrapping punctuation that is not part of a number or a date. */
/**
 * A count with whatever the reader hung off its ends removed.
 *
 * Where the watermark touches a count column the reader tends to bracket the
 * digits rather than lose them: `(000`, `000’`, `000.`. `tokenCore` strips only
 * the separators it expects between words, so those stay and the token fails
 * `isCount` — which drops the line below four counts, and then the tightest run
 * of four reaches back and swallows the game number instead. One stray quote
 * costs the whole row.
 */
function countValue(text: string): string | null {
  const token = tokenCore(text).replace(/^\D+|\D+$/g, '')
  return isCount(token) ? token : null
}

/** Strip punctuation off both ends, keeping the word or number inside. */
function stripEdges(text: string): string {
  return tokenCore(text).replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, '')
}

function tokenCore(text: string): string {
  return text.trim().replace(/^[,:;]+|[,:;]+$/g, '')
}

function isAmount(token: string): boolean {
  return AMOUNT.test(token)
}

function isDate(token: string): boolean {
  return DATE.test(token)
}

function isTime(token: string): boolean {
  return TIME.test(token)
}

function isCount(token: string): boolean {
  return COUNT.test(token)
}

function isDecimalTail(token: string): boolean {
  return DECIMAL_TAIL.test(token)
}

function isCreditMark(token: string): boolean {
  return CREDIT.test(token)
}

function isLongId(token: string): boolean {
  return LONG_ID.test(token)
}

/**
 * A token that can sit in a trailing value, judged with its neighbours.
 * A bare `C` only counts when it is the credit suffix of an amount, and a
 * longer integer only counts when it is the whole-dollar half of `.74`.
 */
function isValueToken(words: readonly WordBox[], index: number): boolean {
  const token = tokenCore(words[index]?.text ?? '')
  if (
    isAmount(token) ||
    isDate(token) ||
    isTime(token) ||
    isCount(token) ||
    isDecimalTail(token)
  ) {
    return true
  }
  if (isCreditMark(token) && index > 0 && isAmount(tokenCore(words[index - 1]?.text ?? ''))) {
    return true
  }
  if (
    isLongId(token) &&
    index + 1 < words.length &&
    isDecimalTail(tokenCore(words[index + 1]?.text ?? ''))
  ) {
    return true
  }
  return false
}

function gapBetween(left: WordBox, right: WordBox): number {
  return right.x - (left.x + left.width)
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function lineHeight(words: readonly WordBox[]): number {
  return median(words.map((word) => word.height)) || 1
}

/** A gap wide enough to be the space between a label and its value. */
function isColumnGap(gap: number, height: number, gaps: readonly number[]): boolean {
  if (gap < Math.max(14, height * 0.9)) return false
  const rest = gaps.filter((value) => value !== gap)
  const typical = median(rest.length > 0 ? rest : gaps)
  return gap >= typical * 2
}

function joinParts(words: readonly WordBox[]): string {
  let out = ''
  for (const word of words) {
    const text = word.text.trim()
    if (!text) continue
    const glue = out.length > 0 && !CREDIT.test(text) && !text.startsWith('.')
    out = glue ? `${out} ${text}` : `${out}${text}`
  }
  return out
}

function meanConfidence(words: readonly WordBox[]): number {
  if (words.length === 0) return 0
  const sum = words.reduce((total, word) => total + word.confidence, 0)
  return sum / words.length
}

/**
 * Split one baseline into a label and a value.
 *
 * Amounts, dates and times are values wherever they trail the line. A run of
 * short integers (the inventory counts) is a value only when at least two of
 * them trail the line, or a single one is separated by a wide gap — so the
 * `3` in `Cash 3 Sales` stays in the label.
 */
export function splitLabelValue(words: readonly WordBox[]): { label: string; value: string } {
  if (words.length === 0) return { label: '', value: '' }
  if (words.length === 1) {
    const only = words[0]?.text.trim() ?? ''
    return isValueToken(words, 0) ? { label: '', value: only } : { label: only, value: '' }
  }

  const gaps = words.slice(1).map((word, index) => gapBetween(words[index]!, word))
  const height = lineHeight(words)

  let start = words.length
  while (start > 0 && isValueToken(words, start - 1)) start -= 1

  if (start < words.length && acceptSuffix(words, start, gaps, height)) {
    return {
      label: joinParts(words.slice(0, start)),
      value: joinParts(words.slice(start)),
    }
  }

  const peeledId = peelTrailingId(words, gaps, height)
  if (peeledId !== null) {
    return {
      label: joinParts(words.slice(0, peeledId)),
      value: joinParts(words.slice(peeledId)),
    }
  }

  const atGap = dominantGap(gaps, height)
  if (atGap !== null) {
    return {
      label: joinParts(words.slice(0, atGap)),
      value: joinParts(words.slice(atGap)),
    }
  }

  return { label: joinParts(words), value: '' }
}

function acceptSuffix(
  words: readonly WordBox[],
  start: number,
  gaps: readonly number[],
  height: number,
): boolean {
  const suffix = words.slice(start)
  const gapBefore = start > 0 ? (gaps[start - 1] ?? 0) : Number.POSITIVE_INFINITY
  let strong = false
  let counts = 0
  for (const word of suffix) {
    const token = tokenCore(word.text)
    if (isAmount(token) || isDate(token) || isTime(token) || isDecimalTail(token)) strong = true
    if (isCount(token)) counts += 1
  }
  if (strong) return true
  if (counts >= 2) return true
  return counts === 1 && isColumnGap(gapBefore, height, gaps)
}

/** A retailer id after a colon, or across a wide gap, is a value. Years are not. */
function peelTrailingId(
  words: readonly WordBox[],
  gaps: readonly number[],
  height: number,
): number | null {
  const last = words.length - 1
  const token = tokenCore(words[last]?.text ?? '')
  if (!isLongId(token) || last === 0) return null
  const previous = words[last - 1]?.text.trim() ?? ''
  const gap = gaps[last - 1] ?? 0
  if (previous.endsWith(':') || isColumnGap(gap, height, gaps)) return last
  return null
}

/**
 * When nothing on the right looks like a value, split at a gap that is much
 * wider than the spaces inside the line. Headings, whose spaces are even,
 * stay as a single label.
 */
function dominantGap(gaps: readonly number[], height: number): number | null {
  if (gaps.length === 0) return null
  let maxIndex = 0
  for (let i = 1; i < gaps.length; i += 1) {
    if ((gaps[i] ?? 0) > (gaps[maxIndex] ?? 0)) maxIndex = i
  }
  const max = gaps[maxIndex] ?? 0
  const rest = gaps.filter((_, index) => index !== maxIndex)
  const typical = median(rest)
  if (max < Math.max(16, height)) return null
  if (rest.length > 0 && max < typical * 2.5) return null
  return maxIndex + 1
}

function centerY(word: WordBox): number {
  return word.y + word.height / 2
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

function verticalOverlap(word: WordBox, band: { top: number; bottom: number }): number {
  const top = Math.max(word.y, band.top)
  const bottom = Math.min(word.y + word.height, band.bottom)
  return Math.max(0, bottom - top)
}

/**
 * Group words onto shared baselines.
 *
 * Words are considered in top-to-bottom order and join the line they overlap
 * most, so a slightly raised count still stays on its row.
 */
export function groupIntoLines(
  words: readonly WordBox[],
  overlapRatio = 0.5,
): WordBox[][] {
  const ordered = [...words].sort((a, b) => centerY(a) - centerY(b) || a.x - b.x)
  const lines: WordBox[][] = []

  for (const word of ordered) {
    let best: WordBox[] | null = null
    let bestOverlap = 0
    const from = Math.max(0, lines.length - 4)
    for (let i = lines.length - 1; i >= from; i -= 1) {
      const line = lines[i]
      if (!line) continue
      const band = lineBand(line)
      const overlap = verticalOverlap(word, band)
      const shorter = Math.min(word.height, band.bottom - band.top)
      const ratio = shorter > 0 ? overlap / shorter : 0
      if (ratio >= overlapRatio && overlap > bestOverlap) {
        best = line
        bestOverlap = overlap
      }
    }
    if (best) best.push(word)
    else lines.push([word])
  }

  for (const line of lines) line.sort((a, b) => a.x - b.x)
  lines.sort((a, b) => lineBand(a).top - lineBand(b).top)
  return lines
}

/**
 * Read an instant-inventory line into the printed columns.
 *
 * The four counts on the right are Int, Rec, Act, Set. The first token of
 * what remains is the game number when it is three digits; everything after
 * that is the name. A `TOTALS` line has no game number.
 * Returns null for headings and for lines that are not this table.
 */
export function inventoryRowFromLine(words: readonly WordBox[]): InventoryRow | null {
  const ordered = [...words].sort((a, b) => a.x - b.x || a.y - b.y)
  const counts = tightCountRun(ordered)
  if (!counts) return null

  const countWords = new Set(counts)
  const firstCount = counts[0]
  const labelWords = ordered.filter(
    (word) => !countWords.has(word) && firstCount && word.x < firstCount.x,
  )
  let start = 0
  while (start < labelWords.length) {
    const token = stripEdges(labelWords[start]?.text ?? '')
    if (GAME.test(token) || isTotals(token)) break
    // Three, not two: the margin watermark yields `|SE` and `|€2` as often as
    // it yields `iZ`, and a name never begins this far left anyway — the game
    // number does, and it breaks this loop before any of the name is reached.
    if (token.length <= 3) {
      start += 1
      continue
    }
    break
  }
  const body = labelWords.slice(start)
  if (body.length === 0) return null

  const first = stripEdges(body[0]?.text ?? '')
  const game = GAME.test(first) ? first : ''
  const name = joinParts(game ? body.slice(1) : body)
  if (!game && !isTotals(name)) return null

  const [int = '', rec = '', act = '', set = ''] = counts.map(
    (word) => countValue(word.text) ?? tokenCore(word.text),
  )
  return {
    game,
    name,
    int,
    rec,
    act,
    set,
    confidence: meanConfidence(ordered),
  }
}

function isTotals(token: string): boolean {
  return /^totals$/i.test(token)
}

/**
 * The Int/Rec/Act/Set columns are four short integers packed together.
 * A game number is also three digits, and a watermark glyph can look like a
 * fifth count further right, so the run is the tightest group of four rather
 * than whatever happens to sit at the end of the line.
 */
/**
 * Split a run of counts the reader joined into a single token.
 *
 * The four count columns are printed close together, and where the watermark
 * crosses the gaps between them the reader stops seeing the gaps at all:
 * `000 001 000 000` comes back as `000001000000`, and a lighter touch leaves
 * `000.001` with the space read as a point. Either way the line then has fewer
 * than four counts and the whole row is dropped.
 *
 * The split is unambiguous because every count is exactly three digits, so a
 * token whose digits divide into threes is expanded back out and spaced across
 * the box it came from. A comma is deliberately not a separator here — that is
 * how money is written, and `350,000` in a game's name must not become counts.
 */
function expandMergedCounts(words: readonly WordBox[]): WordBox[] {
  const expanded: WordBox[] = []
  for (const word of words) {
    const token = tokenCore(word.text)
    if (isCount(token) || !/^\d{3}(?:[.\s]?\d{3})+$/.test(token)) {
      expanded.push(word)
      continue
    }
    const digits = token.replace(/\D/g, '')
    const parts = digits.length / 3
    if (!Number.isInteger(parts) || parts < 2 || parts > 4) {
      expanded.push(word)
      continue
    }
    const span = word.width / parts
    for (let index = 0; index < parts; index += 1) {
      expanded.push({
        ...word,
        text: digits.slice(index * 3, index * 3 + 3),
        x: word.x + span * index,
        width: span,
      })
    }
  }
  return expanded
}

function tightCountRun(words: readonly WordBox[]): WordBox[] | null {
  const counts = expandMergedCounts(words).filter((word) => countValue(word.text) !== null)
  if (counts.length < 4) return null

  let best: WordBox[] | null = null
  let bestSpan = Number.POSITIVE_INFINITY
  for (let index = 0; index + 3 < counts.length; index += 1) {
    const group = counts.slice(index, index + 4)
    const first = group[0]
    const last = group[3]
    if (!first || !last) continue
    const span = last.x - first.x
    if (span < bestSpan) {
      best = group
      bestSpan = span
    }
  }
  return best
}

function rowPitch(anchors: readonly WordBox[]): number {
  const centers = anchors.map(centerY).sort((a, b) => a - b)
  const gaps: number[] = []
  for (let index = 1; index < centers.length; index += 1) {
    const gap = (centers[index] ?? 0) - (centers[index - 1] ?? 0)
    if (gap > 4) gaps.push(gap)
  }
  if (gaps.length === 0) return Math.max(24, lineHeight(anchors) * 1.6)
  return median(gaps)
}

/**
 * Inventory rows only, top to bottom. Header and footer text are left out.
 *
 * Printed counts sit a little below the game name, and the diagonal watermark
 * adds tall boxes that overlap the next line. Anchoring each row on its game
 * number (or TOTALS) keeps those boxes from gluing two games into one line.
 */
export function inventoryRowsFromWords(
  words: readonly WordBox[],
  overlapRatio = 0.5,
): InventoryRow[] {
  const usable = words.filter(
    (word) => word.text.trim().length > 0 && word.width > 0 && word.height > 0,
  )
  const right = usable.reduce((max, word) => Math.max(max, word.x + word.width), 0)
  // The game number is a column, so every real one shares a left edge. A game
  // *name* can be three digits too — `859` is called `777` on this receipt — and
  // it would otherwise anchor a second row on the same line, splitting the game
  // away from its counts. Anchoring on the column rather than on the pattern
  // alone keeps the name out of it.
  const gameLike = usable.filter(
    (word) => GAME.test(stripEdges(word.text)) && word.x <= right * 0.45,
  )
  const columnX = median(gameLike.map((word) => word.x))
  // Asymmetric, because the two things that push a game number off the column
  // push it in opposite directions. Margin watermark merging into the number
  // (`£879`, `877.`) extends its box leftwards, sometimes by three characters;
  // a three-digit game *name* sits to the right of the column, where the name
  // field starts. So be generous to the left and strict to the right.
  const columnHeight = lineHeight(gameLike)
  const slackLeft = Math.max(48, columnHeight * 3)
  const slackRight = Math.max(16, columnHeight)
  const anchors = usable.filter((word) => {
    if (isTotals(stripEdges(word.text))) return true
    if (!GAME.test(stripEdges(word.text)) || word.x > right * 0.45) return false
    const offset = word.x - columnX
    return offset >= -slackLeft && offset <= slackRight
  })
  if (anchors.length === 0) {
    const rows: InventoryRow[] = []
    for (const line of groupIntoLines(usable, overlapRatio)) {
      const row = inventoryRowFromLine(line)
      if (row) rows.push(row)
    }
    return rows
  }

  const rows: InventoryRow[] = []
  for (const line of assignToAnchors(usable, anchors, overlapRatio, 0.35 + overlapRatio)) {
    const row = inventoryRowFromLine(line)
    if (row) rows.push(row)
  }
  return rows
}

const PACK = /^\d{3}-\d{5,8}$/

function pageRight(words: readonly WordBox[]): number {
  return words.reduce((max, word) => Math.max(max, word.x + word.width), 0)
}

/**
 * Group words onto anchors.
 *
 * A word between two rows stays with the row above: the value is often printed
 * a little lower than the label, and the next row's anchor is closer in raw
 * distance.
 */
function assignToAnchors(
  words: readonly WordBox[],
  anchors: readonly WordBox[],
  overlapRatio: number,
  belowRatio: number,
): WordBox[][] {
  if (anchors.length === 0) return []
  const pitch = rowPitch(anchors)
  const below = pitch * belowRatio
  const above = pitch * Math.min(0.35, 0.1 + overlapRatio * 0.4)
  const groups = new Map<WordBox, WordBox[]>()
  for (const anchor of anchors) groups.set(anchor, [anchor])

  for (const word of words) {
    if (groups.has(word)) continue
    let best: WordBox | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    const cy = centerY(word)
    for (const anchor of anchors) {
      const delta = cy - centerY(anchor)
      if (delta < -above || delta > below) continue
      const distance = delta >= -above * 0.5 ? Math.abs(delta) : Math.abs(delta) + pitch * 0.75
      if (distance < bestDistance) {
        best = anchor
        bestDistance = distance
      }
    }
    if (best) groups.get(best)?.push(word)
  }

  return [...anchors]
    .sort((a, b) => centerY(a) - centerY(b) || a.x - b.x)
    .map((anchor) => groups.get(anchor) ?? [])
}

/**
 * Drop stray tokens stranded in the left margin, before the label proper.
 *
 * The receipts carry watermark text running vertically down both margins, and
 * the reader picks fragments of it out as words: `12`, `Ne`, `[>`, `5%`. Sitting
 * to the left of the label, they get glued onto the front of it — `12 SYSTEM
 * FEE` instead of `SYSTEM FEE`.
 *
 * The giveaway is the gap. Measured on the weekly invoice, a stray sits 56-57px
 * from the label while the label's own words are 5-6px apart, so the leading gap
 * is an order of magnitude out. The threshold is scaled by the text height
 * rather than fixed in pixels, since the same receipt photographed closer has
 * proportionally larger gaps throughout.
 *
 * `cleanLabel` already had a rule for this, comparing each word against a
 * fraction of the median x. It missed by under two pixels on both of the lines
 * above — with the amount excluded, the median of three words lands on the
 * middle one, which puts the cut just inside the stray's right edge.
 */
function dropLeadingStrays(ordered: readonly WordBox[]): readonly WordBox[] {
  let kept = ordered
  // One stray can hide behind another, so strip until the front looks attached.
  while (kept.length >= 2) {
    const head = kept[0]
    if (!head) break
    // Only ever a fragment: a real first word this far out is a label, not noise.
    if (head.text.trim().length > 3) break

    const gaps: number[] = []
    for (let index = 1; index < kept.length; index += 1) {
      const previous = kept[index - 1]
      const current = kept[index]
      if (!previous || !current) continue
      gaps.push(current.x - (previous.x + previous.width))
    }
    const leading = gaps[0]
    if (leading === undefined) break

    const rest = gaps.slice(1).sort((a, b) => a - b)
    // `typical` is only meaningful once at least two gaps follow the leading
    // one. With a single gap it may well be a second stray's, which is the same
    // order as the leading gap and pushes the threshold out of reach — the row
    // then keeps both strays, which is how `Adjustments` came back as
    // `Ec Adjustments`. Below that, the height floor decides alone.
    const typical = rest.length >= 2 ? rest[Math.floor(rest.length / 2)] : undefined
    const height = kept.reduce((max, word) => Math.max(max, word.height), 0)
    const threshold = Math.max(height * 1.5, typical === undefined ? 0 : typical * 3)
    if (leading <= threshold) break

    kept = kept.slice(1)
  }
  return kept
}

function cleanLabel(words: readonly WordBox[]): string {
  // Tokens with nothing alphanumeric in them — a bare `|` off the margin rule —
  // are discarded further down anyway, but leaving them in first distorts the
  // spacing that `dropLeadingStrays` reads: a `|` sitting hard against a stray
  // makes the leading gap look like ordinary word spacing.
  const sorted = [...words]
    .filter((word) => /[A-Za-z0-9&$]/.test(word.text))
    .sort((a, b) => a.x - b.x || a.y - b.y)
  const ordered = dropLeadingStrays(sorted)
  const xs = ordered.map((word) => word.x).sort((a, b) => a - b)
  const column = xs[Math.floor(xs.length / 2)] ?? 0
  const margin = column * 0.45
  const kept: string[] = []
  for (const word of ordered) {
    if (ordered.length >= 3 && word.x + word.width < margin) continue
    const token = word.text.trim().replace(/^[^A-Za-z0-9&$/]+|[^A-Za-z0-9&$/]+$/g, '')
    if (!token) continue
    if (token.length === 1 && !/^[0-9&]$/.test(token)) continue
    if (!/[A-Za-z0-9&$]/.test(token)) continue
    kept.push(token)
  }
  return kept.join(' ')
}

function findPack(words: readonly WordBox[]): { code: string; used: Set<WordBox> } | null {
  const ordered = [...words].sort((a, b) => a.x - b.x || a.y - b.y)
  for (let index = 0; index < ordered.length; index += 1) {
    const word = ordered[index]
    if (!word) continue
    const token = tokenCore(word.text)
    if (PACK.test(token)) return { code: token, used: new Set([word]) }
    const next = ordered[index + 1]
    if (!next) continue
    if (next.x - (word.x + word.width) > 24) continue
    const joined = `${token}${tokenCore(next.text)}`.replace(/\s+/g, '')
    const normalized = joined.replace(/^(\d{3})(\d{5,8})$/, '$1-$2')
    if (PACK.test(normalized)) return { code: normalized, used: new Set([word, next]) }
  }
  return null
}

/**
 * Weekly pack settlements: a game-pack code and a name on the left, a date
 * on the right. Header and footer lines, which have no pack code, are left out.
 */
export function settlementRowsFromWords(
  words: readonly WordBox[],
  overlapRatio = 0.5,
): SettlementRow[] {
  const usable = words.filter(
    (word) => word.text.trim().length > 0 && word.width > 0 && word.height > 0,
  )
  const right = pageRight(usable)
  // The x guard matters more now that the date is read from digits alone: a
  // pack code's own suffix can arrange into a valid month and day, and only its
  // position on the left keeps it from anchoring a row of its own.
  const anchors = usable.filter(
    (word) => settledDate(word.text) !== null && word.x >= right * 0.4,
  )
  const rows: SettlementRow[] = []
  for (const line of assignToAnchors(usable, anchors, overlapRatio, 0.42)) {
    const ordered = [...line].sort((a, b) => a.x - b.x || a.y - b.y)
    const dateWord = [...ordered]
      .reverse()
      .find((word) => word.x >= right * 0.4 && settledDate(word.text) !== null)
    const pack = findPack(ordered)
    if (!dateWord || !pack) continue
    const used = new Set(pack.used)
    used.add(dateWord)
    const name = cleanLabel(ordered.filter((word) => !used.has(word) && word.x < dateWord.x))
    if (!name) continue
    rows.push({
      gamePack: pack.code,
      name,
      dateSettled: settledDate(dateWord.text) ?? tokenCore(dateWord.text),
      confidence: meanConfidence(ordered),
    })
  }
  return rows
}

/**
 * A settled date, including the forms the watermark drives the reader into.
 *
 * Where the overlay sits on the date column the separators are the first thing
 * to go. `02/27/26` comes back as `02127126` with both slashes read as ones, as
 * `0227126` with one dropped and the other turned into a digit, or as `0228/26`
 * with one simply missing. The pack code and the game name on the same line
 * survive intact, so rejecting these throws away a whole settlement for the sake
 * of two slashes — eight of the twenty-five rows on the sample receipt.
 *
 * Rather than guess which characters were slashes, this works from the digits
 * and lets the calendar decide: an arrangement is a date if it yields a month of
 * 1-12 and a day of 1-31, and the ones that do not are rejected. That is what
 * keeps a six-digit amount like `$200,000` out — it would need month 20.
 *
 * Returns the date normalised to `MM/DD/YY`, or null.
 */
function settledDate(text: string): string | null {
  const digits = tokenCore(text).replace(/\D/g, '')
  const arrangements: string[] = []
  if (digits.length === 6) {
    arrangements.push(digits)
  } else if (digits.length === 7) {
    // One separator dropped entirely, the other read as a digit. Either could
    // be the survivor, so try both and let the calendar pick.
    arrangements.push(digits.slice(0, 2) + digits.slice(3))
    arrangements.push(digits.slice(0, 4) + digits.slice(5))
  } else if (digits.length === 8) {
    // Both separators read as digits, each sitting where the slash was.
    arrangements.push(digits.slice(0, 2) + digits.slice(3, 5) + digits.slice(6))
  }

  for (const candidate of arrangements) {
    const month = Number(candidate.slice(0, 2))
    const day = Number(candidate.slice(2, 4))
    if (month < 1 || month > 12 || day < 1 || day > 31) continue
    return `${candidate.slice(0, 2)}/${candidate.slice(2, 4)}/${candidate.slice(4)}`
  }
  return null
}

function isMoney(token: string): boolean {
  return /^\d{1,3}(?:,\d{3})+(?:\.\d{2})?$/.test(token) || /^\d+\.\d{2}$/.test(token)
}

/**
 * An invoice amount, including the forms the reader mangles: a cent sign, a
 * trailing credit C, `000` for zero, and cents with the point dropped (`29300`).
 * Returns null when the token is not an amount.
 */
function invoiceAmount(text: string): string | null {
  const token = tokenCore(text)
    .replace(/[“”"'‘’`]+/g, '')
    .replace(/€/g, 'C')
    .replace(/[|\\™*%[\](){}]+/g, '')
    .replace(/^(\d+\.\d{2})\d$/, '$1')
  // `4,577.00C` read with the thousands comma as a dot: `4.577.00C`.
  const splitThousands = token.match(/^(\d)\.(\d{3})\.(\d{2})([cC¢])?$/)
  if (splitThousands) {
    const credit = splitThousands[4] ? 'C' : ''
    return `${splitThousands[1]}${splitThousands[2]}.${splitThousands[3]}${credit}`
  }
  // `9,900.00` read as `9.90000`.
  const commaAsDot = token.match(/^(\d)\.(\d{2})(\d{2,})$/)
  if (commaAsDot) {
    const digits = `${commaAsDot[1]}${commaAsDot[2]}${commaAsDot[3]}`
    return `${digits.slice(0, -2)}.${digits.slice(-2)}`
  }

  let body = token
  let credit = ''
  if (/[¢cC]$/.test(body)) {
    credit = 'C'
    body = body.slice(0, -1)
  }
  if (isMoney(body)) return `${body}${credit}`
  // `40.00C` read with the decimal point as a comma, which is what the reader
  // does where the watermark sits on the point. A thousands group is always
  // three digits, so two digits after a comma can only be cents.
  if (/^\d+,\d{2}$/.test(body)) return `${body.replace(',', '.')}${credit}`
  if (/^[0oO]{2,3}$/.test(body)) return `0.00${credit}`
  if (/^\d{4,7}$/.test(body)) return `${body.slice(0, -2)}.${body.slice(-2)}${credit}`
  return null
}

/**
 * Weekly invoice: a description on the left and an amount on the right.
 * Section headings, which have no amount, are left out.
 */
export function invoiceRowsFromWords(
  words: readonly WordBox[],
  overlapRatio = 0.5,
): ReceiptField[] {
  const usable = words.filter(
    (word) => word.text.trim().length > 0 && word.width > 0 && word.height > 0,
  )
  const right = pageRight(usable)
  const anchors = usable.filter((word) => {
    if (word.x < right * 0.5) return false
    if (isDecimalTail(tokenCore(word.text))) return false
    const bareDigits = /^\d{4,7}$/.test(tokenCore(word.text))
    if (bareDigits && word.x < right * 0.68) return false
    return invoiceAmount(word.text) !== null
  })
  const rows: ReceiptField[] = []
  for (const line of assignToAnchors(usable, anchors, overlapRatio, 0.42)) {
    const ordered = [...line].sort((a, b) => a.x - b.x || a.y - b.y)
    const amount = [...ordered].reverse().find((word) => invoiceAmount(word.text) !== null)
    if (!amount) continue
    let value = invoiceAmount(amount.text) ?? ''
    const amountIndex = ordered.indexOf(amount)
    const next = ordered[amountIndex + 1]
    const nextToken = tokenCore(next?.text ?? '')
    const nextIsTail =
      (isDecimalTail(nextToken) && !value.includes('.')) ||
      (isCreditMark(nextToken) && !/[A-Za-z]$/.test(value))
    if (next && isDecimalTail(nextToken) && !value.includes('.')) {
      value = `${value}${nextToken}`
    } else if (next && isCreditMark(nextToken) && !/[A-Za-z]$/.test(value)) {
      value = `${value}${nextToken.toUpperCase()}`
    }
    const label = cleanLabel(
      ordered.filter(
        (word) =>
          word !== amount && word !== (nextIsTail ? next : undefined) && word.x + word.width <= amount.x + 2,
      ),
    )
    if (!label) continue
    rows.push({ label, value, confidence: meanConfidence(ordered) })
  }
  return rows
}

/** Pick the table that this page actually is. */
export function chooseReceiptKind(
  inventory: readonly InventoryRow[],
  settlements: readonly SettlementRow[],
  invoice: readonly ReceiptField[],
): ReceiptKind {
  const inventoryScore = inventory.length + (inventory.some((row) => isTotals(row.name)) ? 2 : 0)
  if (inventoryScore >= 3 && inventoryScore >= settlements.length) return 'inventory'
  if (settlements.length >= 3 && settlements.length >= invoice.length) return 'settlements'
  if (invoice.length > 0) return 'invoice'
  if (settlements.length > 0) return 'settlements'
  return 'inventory'
}

/** Word boxes in, receipt rows out, top to bottom. */
export function fieldsFromWords(
  words: readonly WordBox[],
  overlapRatio = 0.5,
): ReceiptField[] {
  const usable = words.filter(
    (word) => word.text.trim().length > 0 && word.width > 0 && word.height > 0,
  )
  const fields: ReceiptField[] = []
  for (const line of groupIntoLines(usable, overlapRatio)) {
    const { label, value } = splitLabelValue(line)
    if (label.length === 0 && value.length === 0) continue
    fields.push({ label, value, confidence: meanConfidence(line) })
  }
  return fields
}
