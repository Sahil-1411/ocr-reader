/**
 * Assigning detections to columns, and ordering them within a column.
 *
 * This is the stage that enforces the hard requirement: numbers must never move
 * between columns, and within a column they must come out strictly top to
 * bottom. Everything upstream is best-effort image work; this part has to be
 * deterministic and defensible.
 */

import type { Box, ClusterOptions, ColumnResult, Detection } from '../types'
import {
  ckmeans1d,
  gapSplit1d,
  validateClustering,
  type Cluster1DResult,
  type ClusterProblem,
} from './cluster1d'

const centerX = (b: Box) => b.x + b.width / 2
const centerY = (b: Box) => b.y + b.height / 2

export interface ColumnAssignment {
  /** `columns[i]` holds the detections assigned to column `i`, already ordered. */
  columns: Detection[][]
  /** x-coordinate of each column band, ascending, in the winning anchor's space. */
  centers: number[]
  /** `[min, max]` x observed in each column. */
  ranges: Array<[number, number]>
  /** Which strategy produced the final answer. */
  strategy: 'ckmeans' | 'gap-split' | 'single-column' | 'empty'
  /** Which x-coordinate the split was computed on. */
  anchor: ColumnAnchor
  /** Validation problems worth surfacing, even when the result was accepted. */
  problems: ClusterProblem[]
  /** Minimum inter-column gap over mean column width. Higher is more confident. */
  separationRatio: number
  /**
   * `WSS(k) / WSS(k-1)`. A genuine extra column removes a lot of variance, so
   * this is small; a value near 1 means the k-th split bought almost nothing and
   * the k-column assumption probably does not hold.
   */
  splitGain: number
}

/**
 * Which x-coordinate of a box to cluster on.
 *
 * Centres are the obvious choice and are right for centred print. But ticket
 * numbers are usually *left-aligned*, and when a column mixes `7` with `42` the
 * centres scatter by half a glyph width — which on a tight ticket is comparable
 * to the gap between columns. The left edge is stable in that case. Neither wins
 * universally, so both are tried and the tighter fit is kept.
 */
export type ColumnAnchor = 'center' | 'left'

/**
 * Split detections into vertical columns.
 *
 * Runs the exact 1-D k-means first because it is deterministic and optimal for
 * the variance objective, then sanity-checks it. If the optimal partition is not
 * a *plausible* set of columns — an empty band, overlapping bands, or bands that
 * are not actually separated by whitespace — it falls back to splitting at the
 * largest gaps, which handles unevenly populated columns far better.
 */
export function assignColumns(
  detections: readonly Detection[],
  options: ClusterOptions,
): ColumnAssignment {
  const usable = detections.filter((d) => d.text.length > 0)

  if (usable.length === 0) {
    const width = typeof options.columnCount === 'number' ? options.columnCount : 1
    return {
      columns: Array.from({ length: width }, () => []),
      centers: [],
      ranges: [],
      strategy: 'empty',
      anchor: 'center',
      problems: [],
      separationRatio: 0,
      splitGain: 1,
    }
  }

  if (options.columnCount !== 'auto') {
    return assignWithColumnCount(usable, Math.max(1, Math.floor(options.columnCount)), options)
  }

  /* Auto mode: find how many columns the geometry actually supports.
     Searching downwards and taking the first clean split is deliberate — these
     documents run from a two-column invoice to a six-column inventory table, and
     over-splitting is the more damaging error. A spurious extra column tears one
     real column in half and silently corrupts every row; under-splitting merges
     two columns, which is visible immediately in the output. */
  const ceiling = Math.max(1, Math.min(Math.floor(options.maxColumns), usable.length))

  let fallback: ColumnAssignment | null = null
  for (let k = ceiling; k >= 1; k--) {
    const candidate = assignWithColumnCount(usable, k, options)
    if (candidate.problems.length === 0) return candidate
    // Remember the widest attempt so a document that never splits cleanly still
    // returns its best effort rather than collapsing to a single column.
    if (!fallback) fallback = candidate
  }

  return fallback ?? assignWithColumnCount(usable, 1, options)
}

/** One attempt at splitting into exactly `k` columns. */
function assignWithColumnCount(
  usable: readonly Detection[],
  k: number,
  options: ClusterOptions,
): ColumnAssignment {

  const anchors: Record<ColumnAnchor, number[]> = {
    center: usable.map((d) => centerX(d.box)),
    left: usable.map((d) => d.box.x),
  }

  // Fewer detections than columns: there is nothing to split.
  if (usable.length < k || k === 1) {
    const xs = anchors.center
    const ordered = orderWithinColumn(usable, options)
    const columns: Detection[][] = Array.from({ length: k }, () => [])
    columns[0] = ordered
    return {
      columns,
      centers: [mean(xs)],
      ranges: [[Math.min(...xs), Math.max(...xs)]],
      strategy: 'single-column',
      anchor: 'center',
      problems: usable.length < k ? ['empty-cluster'] : [],
      separationRatio: 0,
      splitGain: 1,
    }
  }

  /* Try both anchors, and for each the optimal split and the gap split. */
  interface Candidate {
    result: Cluster1DResult
    anchor: ColumnAnchor
    strategy: ColumnAssignment['strategy']
    check: ReturnType<typeof validateClustering>
    /** Unexplained variance, in [0, 1]. Scale-free, so anchors compare fairly. */
    unexplained: number
    splitGain: number
  }

  const candidates: Candidate[] = []

  for (const anchor of ['center', 'left'] as const) {
    const xs = anchors[anchor]
    const total = totalSumOfSquares(xs)

    const optimal = ckmeans1d(xs, k)
    // How much the k-th split actually bought, versus k-1 clusters. Ckmeans
    // always returns exactly k non-empty clusters when n ≥ k, so "no empty
    // cluster" is no evidence that k columns exist — this is.
    const coarser = k > 1 ? ckmeans1d(xs, k - 1) : null
    const splitGain =
      coarser && coarser.withinSS > 0 ? optimal.withinSS / coarser.withinSS : 0

    candidates.push({
      result: optimal,
      anchor,
      strategy: 'ckmeans',
      check: validateClustering(optimal, k, usable.length),
      unexplained: total > 0 ? optimal.withinSS / total : 0,
      splitGain,
    })

    const gap = gapSplit1d(xs, k)
    candidates.push({
      result: gap,
      anchor,
      strategy: 'gap-split',
      check: validateClustering(gap, k, usable.length),
      unexplained: total > 0 ? gap.withinSS / total : 0,
      splitGain,
    })
  }

  /* Prefer a candidate that passes validation; among those, the best-separated;
     and break remaining ties on the tighter fit. A split that merely minimises
     variance is not necessarily a set of columns, so separation leads. */
  const valid = candidates.filter((c) => c.check.ok)
  const pool = valid.length > 0 ? valid : candidates
  pool.sort(
    (a, b) =>
      b.check.separationRatio - a.check.separationRatio ||
      a.unexplained - b.unexplained ||
      // Deterministic final tie-break, so the same input always gives the same
      // answer regardless of array order.
      (a.strategy === 'ckmeans' ? -1 : 1) - (b.strategy === 'ckmeans' ? -1 : 1),
  )
  const winner = pool[0]

  const chosen: Cluster1DResult = winner.result
  const strategy = winner.strategy
  const problems = [...winner.check.problems]
  const separationRatio = winner.check.separationRatio

  // Flag a split that removed almost no variance — three numbers in one column
  // will still be "split into three columns" without tripping any other check.
  if (k > 1 && winner.splitGain > 0.85 && !problems.includes('degenerate-separation')) {
    problems.push('degenerate-separation')
  }

  const columns: Detection[][] = Array.from({ length: k }, () => [])
  chosen.groups.forEach((members, columnIdx) => {
    for (const memberIdx of members) columns[columnIdx].push(usable[memberIdx])
  })

  const ordered = columns.map((column) => orderWithinColumn(column, options))

  /* The decisive check: do the actual BOXES of adjacent columns overlap?
     Everything above reasons about a single anchor coordinate, and both the
     separation ratio and the range check are scale-free — three "columns" whose
     anchors differ by two pixels have zero within-band spread, so they score as
     infinitely well separated even though the boxes sit almost entirely on top
     of one another. Comparing real horizontal extents is what actually backs the
     promise that numbers never cross columns. */
  if (overlapsHorizontally(ordered)) problems.push('overlapping-ranges')

  // Stamp the assignment back onto each detection so `rawDetections` carries it.
  ordered.forEach((column, columnIdx) => {
    column.forEach((detection, rowIdx) => {
      detection.columnIndex = columnIdx + 1
      detection.rowIndex = rowIdx
    })
  })

  return {
    columns: ordered,
    centers: chosen.centers,
    ranges: chosen.ranges,
    strategy,
    anchor: winner.anchor,
    problems,
    separationRatio,
    splitGain: winner.splitGain,
  }
}

/**
 * True when any two adjacent columns' boxes overlap horizontally.
 *
 * A small tolerance is allowed because a detector box often includes a pixel or
 * two of margin, and a hair of overlap between a wide box and its neighbour is
 * not evidence of a bad split. Overlap beyond a fifth of the typical box width
 * is.
 */
function overlapsHorizontally(columns: readonly Detection[][]): boolean {
  const extents = columns
    .map((column) => {
      if (column.length === 0) return null
      return {
        left: Math.min(...column.map((d) => d.box.x)),
        right: Math.max(...column.map((d) => d.box.x + d.box.width)),
        width: mean(column.map((d) => d.box.width)),
      }
    })
    .filter((e): e is { left: number; right: number; width: number } => e !== null)

  for (let i = 1; i < extents.length; i++) {
    const prev = extents[i - 1]
    const cur = extents[i]
    const tolerance = Math.max(2, Math.min(prev.width, cur.width) * 0.2)
    if (prev.right - cur.left > tolerance) return true
  }
  return false
}

/** Σ(x − x̄)² — the denominator for a scale-free goodness-of-fit ratio. */
function totalSumOfSquares(values: readonly number[]): number {
  if (values.length === 0) return 0
  const m = mean(values)
  let sum = 0
  for (const v of values) sum += (v - m) ** 2
  return sum
}

/**
 * Order one column strictly top to bottom.
 *
 * Boxes are first grouped into rows — two boxes share a row when they overlap
 * vertically by more than `rowOverlapRatio` of the shorter one — then rows are
 * emitted top-down and, within a row, left-to-right. Plain `sort by y` would be
 * enough for a single number per line, but it scrambles the order the moment a
 * column holds a pair of numbers side by side, and it is unstable when two boxes
 * sit at the same y by a fraction of a pixel.
 */
export function orderWithinColumn(
  column: readonly Detection[],
  options: ClusterOptions,
): Detection[] {
  if (column.length <= 1) return [...column]

  const sorted = [...column].sort((a, b) => {
    const dy = a.box.y - b.box.y
    if (Math.abs(dy) > 1e-6) return dy
    return centerX(a.box) - centerX(b.box)
  })

  const rows: Detection[][] = []
  for (const detection of sorted) {
    const row = rows[rows.length - 1]
    if (row && sharesRow(row, detection, options.rowOverlapRatio)) {
      row.push(detection)
    } else {
      rows.push([detection])
    }
  }

  for (const row of rows) row.sort((a, b) => centerX(a.box) - centerX(b.box))

  // Rows are already top-down from the sort, but re-sort by row centre so a tall
  // box that opened a row early cannot drag the row above a shorter later one.
  rows.sort((a, b) => rowCenter(a) - rowCenter(b))

  return rows.flat()
}

function sharesRow(
  row: readonly Detection[],
  candidate: Detection,
  overlapRatio: number,
): boolean {
  // Compare against the row's current vertical extent, not just its first member,
  // so a chain of slightly-offset boxes does not drift into one giant row.
  const top = Math.min(...row.map((d) => d.box.y))
  const bottom = Math.max(...row.map((d) => d.box.y + d.box.height))
  const cTop = candidate.box.y
  const cBottom = cTop + candidate.box.height

  const overlap = Math.min(bottom, cBottom) - Math.max(top, cTop)
  if (overlap <= 0) return false

  const shorter = Math.min(bottom - top, cBottom - cTop)
  return shorter > 0 && overlap / shorter >= overlapRatio
}

function rowCenter(row: readonly Detection[]): number {
  return mean(row.map((d) => centerY(d.box)))
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/**
 * Project a column assignment into the public output shape.
 *
 * When `allowFewerColumns` is false the array always has exactly
 * `columnCount` entries, padding with empty `numbers` arrays — a consumer
 * indexing `columns[2]` should never get `undefined` because the photo happened
 * to clip the third column.
 */
export function toColumnResults(
  assignment: ColumnAssignment,
  options: ClusterOptions,
): ColumnResult[] {
  const results: ColumnResult[] = assignment.columns.map((column, i) => ({
    columnIndex: i + 1,
    numbers: column.map((d) => d.text),
  }))

  if (options.allowFewerColumns || options.columnCount === 'auto') {
    return results
      .filter((c) => c.numbers.length > 0)
      .map((c, i) => ({ ...c, columnIndex: i + 1 }))
  }

  while (results.length < options.columnCount) {
    results.push({ columnIndex: results.length + 1, numbers: [] })
  }
  return results.slice(0, options.columnCount)
}
