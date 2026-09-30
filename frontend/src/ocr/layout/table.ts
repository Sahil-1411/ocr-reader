/**
 * Read a table off a page without being told what the table is.
 *
 * The readers beside this one each know a layout. `columns.ts` starts a table
 * only when it recognises at least three printed titles from a fixed list —
 * `qty`, `upc`, `description`, `price` and so on — and `rows.ts` has a builder
 * per lottery receipt, anchored on a three-digit game number, a pack code or a
 * date. Both work well on the pages they were written for and produce nothing
 * useful for any other. A vendor invoice headed `Vendor / PO / Weight / Bin`
 * has no recognised title, so it falls through to the lottery readers and comes
 * back as label-and-amount rows.
 *
 * This module takes the layout from the page instead.
 *
 * The signal is a gap that survives the whole table. Words within a line are
 * separated by spaces, so a single line is full of gaps and says nothing; but a
 * gap at the same x on *every* line is not a space, it is the channel between
 * two columns. Stacking every line's occupancy and looking for x ranges no word
 * ever enters finds the column boundaries of an arbitrary table, with no
 * vocabulary and no assumption about what the columns mean.
 *
 * What this cannot do, and does not pretend to: tell a table from justified
 * prose. Both are words at repeating x positions, and given a paragraph this
 * will read column boundaries into it. Nothing is lost when it does — every
 * word lands in a cell, so joining a row back together returns the line — but
 * the columns are meaningless. Separating the two needs the content, not the
 * geometry, and that judgement belongs to the caller, which knows whether it
 * asked for a table.
 */

import type { WordBox } from './rows'

export interface TableCell {
  text: string
  /** The words this cell was built from, for callers that need the geometry. */
  words: WordBox[]
}

export interface TableRow {
  cells: TableCell[]
  /** Mean confidence of the words in the row, in [0, 1]. */
  confidence: number
  /** Top of the row in page coordinates, so callers can keep reading order. */
  y: number
}

export interface DetectedTable {
  /**
   * The header row's text, when the page has one this module could identify.
   * Null when it could not, in which case rows are still returned — a table
   * with unnamed columns is far more useful than no table.
   */
  headers: string[] | null
  rows: TableRow[]
  /** Left edge of each column, in page coordinates. */
  bounds: number[]
}

export interface TableOptions {
  /**
   * How much of a line's height two words may differ by and still share a row.
   * Amounts are often printed a little below their label.
   */
  rowOverlapRatio: number
  /**
   * A gap must be at least this many times the median character width to count
   * as a column channel rather than a word space.
   *
   * Character width rather than height because that is what a space is measured
   * in, and it holds across font sizes on the same page.
   */
  minGapChars: number
  /**
   * Fraction of body lines allowed to intrude into a channel before it stops
   * being one.
   *
   * Not zero: one line of the table is often a title or a note that runs across
   * the columns, and a single such line should not erase a boundary the other
   * forty agree on.
   */
  intrusionTolerance: number
  /**
   * How far apart two cells' left edges may be and still be the same column,
   * in character widths.
   *
   * Loose enough to absorb the jitter in a recogniser's box edges, tight enough
   * that the four count columns on the inventory sheet — about four characters
   * apart — stay separate.
   */
  edgeToleranceChars: number
  /**
   * Fraction of lines a left-edge cluster must appear on to be a column.
   *
   * The line between a table and a page of text. In a table the same boundaries
   * are used by nearly every row — the inventory sheet's count columns are
   * started by 42 of its 49 rows. In prose each line begins its words wherever
   * the previous one happened to end, so any given x is shared by a couple of
   * lines at most; at a low threshold those coincidences become columns and
   * five lines of text are carved into six.
   *
   * Set above what coincidence produces and below what a real column shows. The
   * cost is a genuinely sparse column — one filled on a third of the rows — and
   * that is the right trade: merging it into its neighbour loses the boundary,
   * while inventing columns out of prose loses the text.
   */
  minColumnSupport: number
  /**
   * Fraction of lines that must have a clear space immediately before a
   * boundary for it to be a column edge rather than a word break.
   */
  minClearFraction: number
  /**
   * Fraction of table rows that must start a cell on a boundary for alignment
   * alone to establish it as a column, without any clear space before it.
   */
  strongEdgeSupport: number
  /**
   * How often two adjacent columns must both hold something, over the rows
   * where either does, for them to be separate columns rather than one that
   * was split.
   */
  minCoOccupancy: number
}

export const DEFAULT_TABLE_OPTIONS: TableOptions = {
  rowOverlapRatio: 0.5,
  minGapChars: 1.6,
  intrusionTolerance: 0.12,
  edgeToleranceChars: 1.2,
  minColumnSupport: 0.45,
  minClearFraction: 0.65,
  strongEdgeSupport: 0.5,
  minCoOccupancy: 0.6,
}

/* -------------------------------------------------------------------------- */
/* Outliers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Drop boxes that cannot be a word on a printed line.
 *
 * These receipts carry watermark text running vertically down both margins. The
 * reader picks it up as words whose boxes are as tall as twenty printed lines,
 * and they wreck both halves of this module: vertically they overlap every line
 * they cross, so line grouping fuses a whole block of rows into one; and
 * horizontally they sit in the margins on every line at once, which closes the
 * channels that would otherwise separate the columns. On the inventory sheet
 * that was the difference between one detected column and six.
 *
 * The test is proportion, not position or content. A word on a line is about as
 * tall as its neighbours; a box several times the median height is a different
 * kind of object, whatever it says. That holds for rotated margin text, for a
 * logo the reader tried to read, and for two lines the detector merged.
 */
export function dropOversizedBoxes(
  words: readonly WordBox[],
  maxHeightRatio = 2.5,
): WordBox[] {
  if (words.length < 4) return [...words]
  const typical = median(words.map((word) => word.height))
  if (typical <= 0) return [...words]
  return words.filter((word) => word.height <= typical * maxHeightRatio)
}

/* -------------------------------------------------------------------------- */
/* Lines                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Group words into printed lines.
 *
 * By vertical overlap rather than by a fixed band, because a line's words are
 * not all the same height — a `$` or a tall digit sits proud of lowercase text —
 * and a band wide enough for that merges two tightly-set lines.
 */
export function groupWordsIntoLines(
  words: readonly WordBox[],
  overlapRatio: number,
): WordBox[][] {
  const ordered = [...words].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: WordBox[][] = []

  for (const word of ordered) {
    const line = lines.find((candidate) => {
      const top = Math.min(...candidate.map((w) => w.y))
      const bottom = Math.max(...candidate.map((w) => w.y + w.height))
      const overlap = Math.min(bottom, word.y + word.height) - Math.max(top, word.y)
      return overlap > 0 && overlap >= Math.min(word.height, bottom - top) * overlapRatio
    })
    if (line) line.push(word)
    else lines.push([word])
  }

  for (const line of lines) line.sort((a, b) => a.x - b.x)
  return lines.sort((a, b) => (a[0]?.y ?? 0) - (b[0]?.y ?? 0))
}

/* -------------------------------------------------------------------------- */
/* Column detection                                                            */
/* -------------------------------------------------------------------------- */

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Width of one character, taken from the words themselves. */
function characterWidth(words: readonly WordBox[]): number {
  const widths = words
    .filter((word) => word.text.trim().length > 0)
    .map((word) => word.width / word.text.trim().length)
    .filter((width) => width > 0)
  return median(widths) || 6
}

/**
 * Find the x ranges no word occupies, across the table as a whole.
 *
 * This is the whole idea of the module. A word space shows up as a gap on one
 * line and is covered by text on the next; a column channel is empty on all of
 * them. Occupancy is counted per line rather than per word so that a line with
 * many words in one column does not outvote a line with few.
 */
export function findColumnChannels(
  lines: readonly WordBox[][],
  options: TableOptions,
): Array<{ start: number; end: number }> {
  const words = lines.flat()
  if (words.length === 0) return []

  const left = Math.floor(Math.min(...words.map((w) => w.x)))
  const right = Math.ceil(Math.max(...words.map((w) => w.x + w.width)))
  const span = right - left
  if (span <= 0) return []

  // One counter per pixel column. Pages here are hundreds to a few thousand
  // pixels wide, so this stays small and avoids any bucketing artefact.
  const hits = new Uint32Array(span)
  for (const line of lines) {
    // A line that covers the same x twice must still only count once, or a
    // column holding two words per row looks busier than it is.
    const covered = new Uint8Array(span)
    for (const word of line) {
      const from = Math.max(0, Math.floor(word.x) - left)
      const to = Math.min(span, Math.ceil(word.x + word.width) - left)
      for (let index = from; index < to; index += 1) covered[index] = 1
    }
    for (let index = 0; index < span; index += 1) if (covered[index]) hits[index] += 1
  }

  const allowed = Math.floor(lines.length * options.intrusionTolerance)
  const minGap = Math.max(2, characterWidth(words) * options.minGapChars)

  const channels: Array<{ start: number; end: number }> = []
  let runStart: number | null = null
  for (let index = 0; index < span; index += 1) {
    const empty = hits[index]! <= allowed
    if (empty && runStart === null) runStart = index
    if (!empty && runStart !== null) {
      if (index - runStart >= minGap) channels.push({ start: left + runStart, end: left + index })
      runStart = null
    }
  }
  // A trailing run reaches the right edge of the content and is not a channel
  // between columns, so it is dropped.

  return channels
}

/**
 * Column boundaries, from where cells start rather than from the space between
 * them.
 *
 * Channels alone under-segment. A channel has to survive every row, so two
 * columns whose content varies in width close the gap between them on some
 * line and disappear: on the settlements receipt the pack code and the game
 * name merge into one column, and on the inventory sheet the four count columns
 * merge into one. Widening the tolerance until they separate pulls the
 * boundaries around instead, because the channel edges then follow whichever
 * rows happen to be shortest.
 *
 * Left edges are far steadier. A printed table aligns its cells, so every game
 * number starts at the same x, every name starts at the same x, and each of the
 * four count columns has its own. Clustering those edges recovers all six
 * columns of the inventory sheet, which no channel threshold does.
 *
 * Support is counted in lines, not words, and a cluster has to appear on enough
 * of them to be a column rather than a coincidence — otherwise every ragged
 * indent in a note becomes a boundary.
 */
export function columnBoundsFrom(
  lines: readonly WordBox[][],
  options: TableOptions,
): number[] {
  const words = lines.flat()
  if (words.length === 0) return []

  const tolerance = Math.max(2, characterWidth(words) * options.edgeToleranceChars)

  // Each line contributes a left edge at most once per cluster, so a line with
  // several words in one column cannot manufacture support on its own.
  const edges = lines
    .flatMap((line, lineIndex) => line.map((word) => ({ x: word.x, lineIndex })))
    .sort((a, b) => a.x - b.x)

  const clusters: Array<{ xs: number[]; lines: Set<number> }> = []
  for (const edge of edges) {
    const current = clusters[clusters.length - 1]
    const last = current?.xs[current.xs.length - 1]
    if (current && last !== undefined && edge.x - last <= tolerance) {
      current.xs.push(edge.x)
      current.lines.add(edge.lineIndex)
    } else {
      clusters.push({ xs: [edge.x], lines: new Set([edge.lineIndex]) })
    }
  }

  const required = Math.max(2, Math.ceil(lines.length * options.minColumnSupport))
  const kept = clusters.filter((cluster) => cluster.lines.size >= required)
  if (kept.length === 0) return [Math.min(...words.map((word) => word.x))]

  // The cluster's own left edge, not its mean: a boundary has to sit at or
  // before the first character of every cell it owns, or that cell falls into
  // the column to its left.
  const candidates = kept.map((cluster) => Math.min(...cluster.xs)).sort((a, b) => a - b)

  // Left edges alone over-segment, for the mirror of the reason channels
  // under-segment. Inside a column of free text the words also line up: enough
  // game names begin with a three-letter word that the position after it looks
  // like a column, and `RED WHITE & BLUE 7S` splits into three.
  //
  // A real boundary has a clear space before it — that is what makes it a
  // column rather than a word break. Requiring both signals keeps the count
  // columns, whose preceding space is empty on every row, and drops the splits
  // inside a name, where the preceding space is occupied by whichever name is
  // longest.
  const gap = Math.max(2, characterWidth(words) * options.minGapChars)

  // Judged against the rows that belong to the table, not against every line on
  // the page. A title, an address block and a footer all run straight across
  // the columns, and on the inventory sheet there are enough of them to
  // out-vote forty tidy rows and erase the four count columns. A line counts as
  // a table row when its words start on two or more of the candidates — which
  // is what participating in a column structure means, without any assumption
  // about what the columns hold.
  const structural = lines.filter(
    (line) =>
      line.filter((word) => candidates.some((b) => Math.abs(word.x - b) <= tolerance)).length >= 2,
  )
  const jury = structural.length >= 3 ? structural : lines

  // Two kinds of evidence, and alignment is the stronger one.
  //
  // The inventory sheet's count columns are set so tightly that the space
  // before each is under a character wide — `clear` for them is 0.04, they
  // effectively touch. But 42 of its 49 rows start a word at exactly the same
  // x, which is not something that happens by accident. Demanding a clear gap
  // as well would throw away four real columns to guard against a split that
  // the alignment evidence already rules out.
  //
  // So a boundary that most rows start a cell on is a column, spacing
  // notwithstanding. Only the weaker candidates — the ones that come from a few
  // game names happening to share a first-word length — have to show that the
  // space before them is genuinely clear.
  const first = candidates[0]
  const support = new Map(kept.map((cluster) => [Math.min(...cluster.xs), cluster.lines.size]))

  const bounds = candidates.filter((boundary, index) => {
    if (index === 0) return true
    const aligned = (support.get(boundary) ?? 0) / Math.max(1, jury.length)
    if (aligned >= options.strongEdgeSupport) return true

    const clear = jury.filter(
      (line) => !line.some((word) => word.x < boundary && word.x + word.width > boundary - gap),
    ).length
    return clear / jury.length >= options.minClearFraction
  })

  const consolidated = mergeSplitColumns(bounds, jury, options)
  return consolidated.length > 0 ? consolidated : first === undefined ? [] : [first]
}

/**
 * Put back together columns that are really one.
 *
 * A wide free-text column defeats both of the tests above. Game names repeat
 * their shape — `X10 HIGH ROLLER`, `X20 HIGH ROLLER`, `X50 HIGH ROLLER` — so
 * the second word aligns across many rows, and when a shorter name leaves that
 * space empty it looks clear as well. The split passes on the evidence
 * available at that point and `X50 | HIGH ROLLER` comes back as two cells.
 *
 * What separates it from a real boundary is how the two sides behave together.
 * Genuine neighbours are both filled on nearly every row — a count column has a
 * number on all of them. Two halves of a split name are both filled only when
 * the name happens to have enough words, and on the rest one side is empty. So
 * a pair that rarely co-occurs is one column, and is merged.
 */
function mergeSplitColumns(
  bounds: readonly number[],
  lines: readonly WordBox[][],
  options: TableOptions,
): number[] {
  if (bounds.length < 2 || lines.length === 0) return [...bounds]

  const kept: number[] = [bounds[0]!]
  for (let index = 1; index < bounds.length; index += 1) {
    const boundary = bounds[index]!
    const previous = kept[kept.length - 1]!
    const next = bounds[index + 1] ?? Number.POSITIVE_INFINITY

    const occupied = (from: number, to: number, line: readonly WordBox[]) =>
      line.some((word) => {
        const centre = word.x + word.width / 2
        return centre >= from && centre < to
      })

    let both = 0
    let either = 0
    for (const line of lines) {
      const left = occupied(previous, boundary, line)
      const right = occupied(boundary, next, line)
      if (left || right) either += 1
      if (left && right) both += 1
    }

    if (either > 0 && both / either < options.minCoOccupancy) continue
    kept.push(boundary)
  }
  return kept
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

function columnOf(word: WordBox, bounds: readonly number[]): number {
  // By the word's own centre, so a cell whose text slightly overhangs its
  // channel still lands in the column it is printed in.
  const centre = word.x + word.width / 2
  let index = 0
  for (let candidate = 0; candidate < bounds.length; candidate += 1) {
    if (centre >= (bounds[candidate] ?? 0)) index = candidate
    else break
  }
  return index
}

function buildRow(line: readonly WordBox[], bounds: readonly number[]): TableRow {
  const cells: TableCell[] = bounds.map(() => ({ text: '', words: [] }))
  for (const word of line) {
    const cell = cells[columnOf(word, bounds)]
    if (cell) cell.words.push(word)
  }
  for (const cell of cells) {
    cell.words.sort((a, b) => a.x - b.x)
    cell.text = cell.words.map((word) => word.text.trim()).filter(Boolean).join(' ')
  }
  const confidences = line.map((word) => word.confidence)
  return {
    cells,
    confidence: confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : 0,
    y: Math.min(...line.map((word) => word.y)),
  }
}

/**
 * Pick the header row, if the page has one.
 *
 * Identified by shape rather than by vocabulary: a header names its columns, so
 * it is the first row at or near the top of the table that fills most of the
 * columns and whose cells are words rather than numbers. When no row looks like
 * that — a bare list of figures, a page whose titles were lost to a watermark —
 * this returns null and the columns stay unnamed, which is a better answer than
 * promoting a row of data to a header.
 */
function findHeaderRow(rows: readonly TableRow[], columnCount: number): number | null {
  if (columnCount < 2) return null
  const limit = Math.min(rows.length, 6)

  for (let index = 0; index < limit; index += 1) {
    const row = rows[index]
    if (!row) continue
    const filled = row.cells.filter((cell) => cell.text.length > 0)
    if (filled.length < Math.max(2, Math.ceil(columnCount * 0.6))) continue
    // A title is a word. A row where most filled cells parse as numbers is data,
    // however near the top of the page it sits.
    const numeric = filled.filter((cell) => /^[\d.,$%()+-]+$/.test(cell.text)).length
    if (numeric / filled.length > 0.34) continue
    return index
  }
  return null
}

/**
 * Read whatever table is on the page.
 *
 * Returns null only when there is too little on the page to be a table at all.
 */
export function extractTable(
  words: readonly WordBox[],
  options: TableOptions = DEFAULT_TABLE_OPTIONS,
): DetectedTable | null {
  const usable = dropOversizedBoxes(
    words.filter((word) => word.text.trim().length > 0 && word.width > 0 && word.height > 0),
  )
  if (usable.length < 4) return null

  const lines = groupWordsIntoLines(usable, options.rowOverlapRatio)
  if (lines.length === 0) return null

  // Boundaries come from the lines that could be table rows. A one-word line is
  // a title, a page number or a note; including it would let its single run of
  // text close a channel the actual rows agree on.
  const body = lines.filter((line) => line.length >= 2)
  const bounds = columnBoundsFrom(body.length >= 2 ? body : lines, options)
  if (bounds.length === 0) return null

  const rows = lines.map((line) => buildRow(line, bounds))
  const headerIndex = findHeaderRow(rows, bounds.length)
  const headers =
    headerIndex === null ? null : rows[headerIndex]!.cells.map((cell) => cell.text)

  return {
    headers,
    rows: headerIndex === null ? rows : rows.slice(headerIndex + 1),
    bounds,
  }
}
