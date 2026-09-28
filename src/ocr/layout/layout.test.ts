/**
 * Tests for the deterministic half of the pipeline.
 *
 * The image stages need a browser (OpenCV/WASM) and a real photo to exercise,
 * but column assignment and text normalisation are pure functions over
 * geometry — which is exactly where a silent bug would be most damaging, since
 * mixing two columns produces output that still *looks* valid.
 */

import { describe, expect, it } from 'vitest'

import { ckmeans1d, gapSplit1d, validateClustering } from './cluster1d'
import { assignColumns, orderWithinColumn, toColumnResults } from './columns'
import { inferFieldType, inferPadWidth, normalizeField, normalizeNumber, DEFAULT_NORMALIZE } from './normalize'
import type { ClusterOptions, Detection } from '../types'

const CLUSTER_OPTS: ClusterOptions = {
  columnCount: 3,
  maxColumns: 8,
  allowFewerColumns: false,
  autoFieldType: false,
  rowOverlapRatio: 0.5,
}

/** Build a detection with just the fields the layout stage reads. */
function det(
  id: number,
  x: number,
  y: number,
  text: string,
  { width = 40, height = 20 }: { width?: number; height?: number } = {},
): Detection {
  return {
    id,
    box: { x, y, width, height },
    polygon: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    angle: 0,
    score: 0.9,
    text,
    rawText: text,
    detScore: 0.9,
    recScore: 0.95,
    confidence: 0.855,
    columnIndex: null,
    rowIndex: null,
  }
}

/** A clean 3-column ticket: 3 columns × 5 rows, evenly spaced. */
function syntheticTicket(): Detection[] {
  const out: Detection[] = []
  const colX = [100, 300, 500]
  let id = 0
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 5; r++) {
      const value = String(c * 5 + r + 1).padStart(2, '0')
      out.push(det(id++, colX[c], 100 + r * 50, value))
    }
  }
  return out
}

describe('ckmeans1d', () => {
  it('finds the exact optimal partition of three separated groups', () => {
    const values = [1, 2, 3, 10, 11, 12, 50, 51, 52]
    const r = ckmeans1d(values, 3)

    expect(r.k).toBe(3)
    expect(r.groups.map((g) => g.length)).toEqual([3, 3, 3])
    expect(r.centers[0]).toBeCloseTo(2)
    expect(r.centers[1]).toBeCloseTo(11)
    expect(r.centers[2]).toBeCloseTo(51)
  })

  it('is deterministic — no seeding, no restarts', () => {
    const values = [5, 1, 9, 3, 7, 2, 8, 4, 6]
    const a = ckmeans1d(values, 3)
    const b = ckmeans1d(values, 3)
    expect(a.assignments).toEqual(b.assignments)
    expect(a.withinSS).toBe(b.withinSS)
  })

  it('minimises variance even when that contradicts visual grouping', () => {
    // Two tight groups plus one spread-out group. The eye says 3/3/3, but that
    // costs SS ≈ 800 while merging the tight pair costs only ≈ 238. The DP finds
    // the true optimum — which is the *wrong* column split. This is not a bug in
    // the DP, it is the reason `validateClustering` and `gapSplit1d` exist.
    const values = [0, 0.1, 0.2, 5, 5.1, 5.2, 40, 60, 80]
    const r = ckmeans1d(values, 3)

    // {0..5.2} | {40} | {60,80}. Note {40,60} | {80} ties it exactly at 200, and
    // the DP's strict-`<` comparison keeps the first minimum it finds.
    expect(r.groups.map((g) => g.length)).toEqual([6, 1, 2])
    expect(r.withinSS).toBeCloseTo(237.54, 1)

    // And the "obvious" 3/3/3 split really is worse by this objective.
    const naiveSS = 0.02 + 0.02 + (400 + 0 + 400)
    expect(r.withinSS).toBeLessThan(naiveSS)

    // Gap-split does not rescue this input either — the 34.8 and 20.0 gaps
    // dominate the 4.8 one, so it agrees with the DP. Spread like this simply
    // is not column-shaped, and no 1-D method will read it as 3/3/3.
    expect(gapSplit1d(values, 3).groups.map((v) => v.length)).toEqual([6, 1, 2])
  })

  it('preserves the mapping back to original (unsorted) indices', () => {
    const values = [50, 1, 51, 2, 10, 11]
    const r = ckmeans1d(values, 3)
    // index 0 (50) and index 2 (51) must land together
    expect(r.assignments[0]).toBe(r.assignments[2])
    // index 1 (1) and index 3 (2) must land together
    expect(r.assignments[1]).toBe(r.assignments[3])
    expect(r.assignments[1]).not.toBe(r.assignments[0])
  })

  it('honours weights', () => {
    const values = [0, 10, 11]
    const heavy = ckmeans1d(values, 2, [100, 1, 1])
    expect(heavy.groups[0]).toEqual([0])
    expect(heavy.groups[1].sort()).toEqual([1, 2])
  })

  it('clamps k to the input size and handles empty input', () => {
    expect(ckmeans1d([], 3).k).toBe(0)
    expect(ckmeans1d([1, 2], 5).k).toBe(2)
    expect(ckmeans1d([7], 3).groups).toEqual([[0]])
  })

  it('does not produce a negative within-cluster sum of squares on identical values', () => {
    const r = ckmeans1d([3, 3, 3, 3], 2)
    expect(r.withinSS).toBeGreaterThanOrEqual(0)
  })
})

describe('gapSplit1d', () => {
  it('cuts at the largest gaps even when group sizes are wildly uneven', () => {
    // k-means would be tempted to split the 8-element run; gap-split will not.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 200, 400]
    const r = gapSplit1d(values, 3)
    expect(r.groups.map((g) => g.length)).toEqual([8, 1, 1])
  })

  it('returns a single cluster for k=1', () => {
    const r = gapSplit1d([1, 50, 99], 1)
    expect(r.groups.length).toBe(1)
    expect(r.groups[0].length).toBe(3)
  })
})

describe('validateClustering', () => {
  it('accepts three genuinely separated bands', () => {
    const r = ckmeans1d([100, 105, 300, 305, 500, 505], 3)
    expect(validateClustering(r, 3, 6).ok).toBe(true)
  })

  it('rejects a single dense blob sliced into three', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5)
    const r = ckmeans1d(values, 3)
    const v = validateClustering(r, 3, values.length)
    expect(v.ok).toBe(false)
    expect(v.problems).toContain('degenerate-separation')
  })

  it('flags an empty cluster', () => {
    const r = ckmeans1d([1, 2], 3)
    expect(validateClustering(r, 3, 2).ok).toBe(false)
  })
})

describe('assignColumns', () => {
  it('splits a clean ticket into three columns without mixing', () => {
    const a = assignColumns(syntheticTicket(), CLUSTER_OPTS)

    expect(a.strategy).toBe('ckmeans')
    expect(a.columns.map((c) => c.length)).toEqual([5, 5, 5])
    expect(a.columns[0].map((d) => d.text)).toEqual(['01', '02', '03', '04', '05'])
    expect(a.columns[1].map((d) => d.text)).toEqual(['06', '07', '08', '09', '10'])
    expect(a.columns[2].map((d) => d.text)).toEqual(['11', '12', '13', '14', '15'])
  })

  it('keeps columns separate under residual tilt', () => {
    // A few degrees of uncorrected skew shifts each row sideways. Columns must
    // still hold, because the shift is far smaller than the column pitch.
    const shifted = syntheticTicket().map((d, i) =>
      det(d.id, d.box.x + (i % 5) * 6, d.box.y, d.text),
    )
    const a = assignColumns(shifted, CLUSTER_OPTS)
    expect(a.columns.map((c) => c.length)).toEqual([5, 5, 5])
    expect(a.columns[0].map((d) => d.text)).toEqual(['01', '02', '03', '04', '05'])
  })

  it('orders strictly top-to-bottom regardless of input order', () => {
    const shuffled = [...syntheticTicket()].reverse()
    const a = assignColumns(shuffled, CLUSTER_OPTS)
    for (const column of a.columns) {
      const ys = column.map((d) => d.box.y)
      expect(ys).toEqual([...ys].sort((p, q) => p - q))
    }
  })

  it('stamps columnIndex and rowIndex onto every assigned detection', () => {
    const a = assignColumns(syntheticTicket(), CLUSTER_OPTS)
    for (const [i, column] of a.columns.entries()) {
      for (const [r, d] of column.entries()) {
        expect(d.columnIndex).toBe(i + 1)
        expect(d.rowIndex).toBe(r)
      }
    }
  })

  it('ignores detections whose text was rejected upstream', () => {
    const withNoise = [...syntheticTicket(), det(99, 300, 400, '')]
    const a = assignColumns(withNoise, CLUSTER_OPTS)
    expect(a.columns.flat().length).toBe(15)
  })

  it('falls back to gap-split when one column is sparsely populated', () => {
    // 10 in column 1, 8 in column 2, 1 in column 3. Minimising variance wants to
    // carve up the dense columns; the gap structure says otherwise.
    const dets: Detection[] = []
    let id = 0
    for (let i = 0; i < 10; i++) dets.push(det(id++, 100 + (i % 2) * 4, 50 + i * 30, '01'))
    for (let i = 0; i < 8; i++) dets.push(det(id++, 320 + (i % 2) * 4, 50 + i * 30, '02'))
    dets.push(det(id++, 700, 50, '03'))

    const a = assignColumns(dets, CLUSTER_OPTS)
    expect(a.columns.map((c) => c.length)).toEqual([10, 8, 1])
  })

  it('clusters on left edges when centres scatter, and says which anchor won', () => {
    // Left-aligned print mixing 1-digit and 3-digit numbers. The left edges are
    // exactly 0 / 40 / 80, but the centres spread by 30 within each column —
    // comparable to the 40px column pitch. Clustering the centres genuinely
    // finds a different (and wrong) optimum, so the anchor choice decides
    // whether numbers cross columns.
    const dets: Detection[] = []
    let id = 0
    for (const [col, left] of [0, 40, 80].entries()) {
      dets.push(det(id++, left, 10 + col, `${col}`, { width: 20 }))
      dets.push(det(id++, left, 60 + col, `${col}${col}${col}`, { width: 80 }))
    }

    // Confirm the premise: on centres, the optimal split is NOT the true one.
    const centres = dets.map((d) => d.box.x + d.box.width / 2)
    const byCentre = ckmeans1d(centres, 3)
    expect(byCentre.groups.map((g) => g.length)).not.toEqual([2, 2, 2])

    const a = assignColumns(dets, CLUSTER_OPTS)
    expect(a.anchor).toBe('left')
    expect(a.columns.map((c) => c.length)).toEqual([2, 2, 2])
    expect(a.columns[0].map((d) => d.text)).toEqual(['0', '000'])
    expect(a.columns[1].map((d) => d.text)).toEqual(['1', '111'])
    expect(a.columns[2].map((d) => d.text)).toEqual(['2', '222'])
  })

  it('still prefers centres for centred print', () => {
    const a = assignColumns(syntheticTicket(), CLUSTER_OPTS)
    // Uniform box widths make both anchors equivalent, so the deterministic
    // ordering should leave the default in place rather than flapping.
    expect(a.anchor).toBe('center')
  })

  it('flags a single dense column that was sliced into three', () => {
    // One column whose boxes jitter across three x values two pixels apart.
    // This is the case every scale-free metric gets wrong: the three bands have
    // *zero* internal spread, so the split is mathematically perfect —
    // splitGain is 0 and the separation ratio is infinite. Only comparing real
    // box extents reveals that the "columns" sit on top of one another.
    const dets = Array.from({ length: 24 }, (_, i) =>
      det(i, 100 + (i % 3) * 2, 40 + i * 25, '07'),
    )
    const a = assignColumns(dets, CLUSTER_OPTS)

    expect(a.splitGain).toBe(0)
    expect(a.separationRatio).toBe(Infinity)
    expect(a.problems).toContain('overlapping-ranges')
  })

  it('flags a genuinely smeared column via the separation check', () => {
    // Continuously spread x values, so the bands do have internal width and the
    // separation ratio is the metric that catches it.
    const dets = Array.from({ length: 30 }, (_, i) =>
      det(i, 100 + i * 0.5, 40 + i * 20, '07'),
    )
    const a = assignColumns(dets, CLUSTER_OPTS)
    expect(a.problems.length).toBeGreaterThan(0)
  })

  it('never returns fewer than columnCount columns by default', () => {
    const a = assignColumns([det(0, 10, 10, '05')], CLUSTER_OPTS)
    expect(toColumnResults(a, CLUSTER_OPTS)).toHaveLength(3)
  })

  it('returns an all-empty result for no detections', () => {
    const a = assignColumns([], CLUSTER_OPTS)
    expect(a.strategy).toBe('empty')
    expect(toColumnResults(a, CLUSTER_OPTS)).toEqual([
      { columnIndex: 1, numbers: [] },
      { columnIndex: 2, numbers: [] },
      { columnIndex: 3, numbers: [] },
    ])
  })
})

describe('orderWithinColumn', () => {
  it('reads two side-by-side numbers left-to-right within one row', () => {
    const row = [det(1, 160, 100, '22'), det(0, 100, 102, '11')]
    expect(orderWithinColumn(row, CLUSTER_OPTS).map((d) => d.text)).toEqual(['11', '22'])
  })

  it('does not merge vertically adjacent rows that merely touch', () => {
    const items = [det(0, 100, 100, '11'), det(1, 100, 120, '22')]
    expect(orderWithinColumn(items, CLUSTER_OPTS).map((d) => d.text)).toEqual(['11', '22'])
  })

  it('keeps a tall box from dragging its row above an earlier one', () => {
    const items = [
      det(0, 100, 100, 'tall', { height: 80 }),
      det(1, 100, 200, 'below'),
    ]
    expect(orderWithinColumn(items, CLUSTER_OPTS).map((d) => d.text)).toEqual(['tall', 'below'])
  })
})

describe('toColumnResults', () => {
  it('renumbers compactly when allowFewerColumns is set', () => {
    const a = assignColumns(
      [det(0, 100, 10, '01'), det(1, 100, 40, '02')],
      { ...CLUSTER_OPTS, allowFewerColumns: true },
    )
    const results = toColumnResults(a, { ...CLUSTER_OPTS, allowFewerColumns: true })
    expect(results).toEqual([{ columnIndex: 1, numbers: ['01', '02'] }])
  })
})

describe('normalizeNumber', () => {
  it('passes a clean two-digit number through', () => {
    expect(normalizeNumber('42').text).toBe('42')
  })

  it('repairs digit lookalikes in digits-only mode', () => {
    const r = normalizeNumber('O7')
    expect(r.text).toBe('07')
    expect(r.repaired).toBe(true)
  })

  it('leaves lookalikes alone in a free-text column', () => {
    // The same repair that rescues `O7` would wreck `MONEY BAGS`, so it is
    // scoped to columns already known to be numeric.
    const r = normalizeField('MONEY BAGS', { ...DEFAULT_NORMALIZE, fieldType: 'text' })
    expect(r.text).toBe('MONEY BAGS')
    expect(r.repaired).toBe(false)
  })

  it('strips punctuation picked up from ruling lines', () => {
    expect(normalizeNumber('-12-').text).toBe('12')
  })

  it('keeps the longest run rather than concatenating a double crop', () => {
    expect(normalizeNumber('7 42').text).toBe('42')
  })

  it('rejects empty and non-numeric input with a reason', () => {
    expect(normalizeNumber('').rejected).toBe('empty-text')
    expect(normalizeNumber('---').rejected).toBe('not-a-number')
  })

  it('rejects readings that are too long', () => {
    expect(normalizeNumber('12345').rejected).toBe('out-of-range')
  })

  it('enforces a value range when given one', () => {
    const opts = { valueRange: [1, 80] as [number, number] }
    expect(normalizeNumber('42', opts).text).toBe('42')
    expect(normalizeNumber('99', opts).rejected).toBe('out-of-range')
  })

  it('zero-pads when asked', () => {
    expect(normalizeNumber('7', { ...DEFAULT_NORMALIZE, padToWidth: 2 }).text).toBe('07')
  })
})

describe('inferPadWidth', () => {
  it('detects padded printing', () => {
    expect(inferPadWidth(['01', '02', '10', '42', '07', '99'])).toBe(2)
  })

  it('does not pad when single digits are present', () => {
    expect(inferPadWidth(['1', '2', '10', '42', '7', '99'])).toBeNull()
  })

  it('abstains on too little evidence', () => {
    expect(inferPadWidth(['01', '02'])).toBeNull()
  })
})

describe('normalizeField — receipt column types', () => {
  it('preserves a game name verbatim', () => {
    expect(normalizeField('MEGA CASH CROSSWORD', { ...DEFAULT_NORMALIZE, fieldType: 'text' }).text)
      .toBe('MEGA CASH CROSSWORD')
  })

  it('keeps the $ and comma in a game name', () => {
    expect(normalizeField('$1,000,000 JACKPOT', { ...DEFAULT_NORMALIZE, fieldType: 'text' }).text)
      .toBe('$1,000,000 JACKPOT')
  })

  it('repairs digits inside a pack code without touching its letters', () => {
    const r = normalizeField('879-OO8949', { ...DEFAULT_NORMALIZE, fieldType: 'code' })
    expect(r.text).toBe('879-008949')
    expect(r.repaired).toBe(true)
  })

  it('leaves a mostly-alphabetic code group alone', () => {
    expect(normalizeField('TR-00045', { ...DEFAULT_NORMALIZE, fieldType: 'code' }).text)
      .toBe('TR-00045')
  })

  it('normalises a date and repairs its digits', () => {
    expect(normalizeField('O2/23/26', { ...DEFAULT_NORMALIZE, fieldType: 'date' }).text)
      .toBe('02/23/26')
  })

  it('rejects an impossible date rather than guessing', () => {
    expect(normalizeField('19/45/26', { ...DEFAULT_NORMALIZE, fieldType: 'date' }).rejected)
      .toBe('out-of-range')
  })

  it('keeps the credit suffix on an amount', () => {
    // Dropping the C would silently flip the sign of every cash-out line.
    expect(normalizeField('40.00C', { ...DEFAULT_NORMALIZE, fieldType: 'amount' }).text)
      .toBe('40.00C')
  })

  it('keeps thousands separators in an amount', () => {
    expect(normalizeField('1,381.74', { ...DEFAULT_NORMALIZE, fieldType: 'amount' }).text)
      .toBe('1,381.74')
  })

  it('auto mode changes nothing but whitespace', () => {
    expect(normalizeField('  000   002  000 001 ', DEFAULT_NORMALIZE).text)
      .toBe('000 002 000 001')
  })
})

describe('inferFieldType', () => {
  it('spots a date column', () => {
    expect(inferFieldType(['02/23/26', '02/27/26', '02/24/26', '02/28/26'])).toBe('date')
  })

  it('spots an amount column', () => {
    expect(inferFieldType(['336.00', '40.00C', '242.50', '1,381.74'])).toBe('amount')
  })

  it('spots a pack-code column', () => {
    expect(inferFieldType(['879-008949', '862-021236', '881-023234', '874-005639'])).toBe('code')
  })

  it('spots a name column', () => {
    expect(inferFieldType(['MEGA CASH CROSSWORD', '$1,000 MAYHEM', 'DIAMONDS & GOLD', 'FIRE & ICE']))
      .toBe('text')
  })

  it('spots a bare-number column', () => {
    expect(inferFieldType(['815', '824', '831', '832', '833'])).toBe('number')
  })

  it('abstains on too little evidence rather than guessing wrong', () => {
    expect(inferFieldType(['02/23/26', '02/27/26'])).toBe('auto')
  })
})
