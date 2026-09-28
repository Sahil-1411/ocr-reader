/**
 * Optimal 1-D clustering (Ckmeans.1d.dp).
 *
 * Assigning detections to columns is a one-dimensional problem: we only care
 * about the x coordinate of each box. In one dimension, k-means has an *exact*
 * solution via dynamic programming — there is no initialisation, no random
 * restarts and no local minimum to get stuck in. Lloyd's algorithm with k-means++
 * seeding gives a different answer depending on the seed; this gives the same
 * provably-optimal answer every time, which is exactly what we want when the
 * hard requirement is "never mix numbers across columns".
 *
 * Formulation
 * -----------
 * Sort the values ascending. In 1-D, every cluster in an optimal solution is a
 * contiguous run of the sorted array, so the problem reduces to choosing k-1 cut
 * points. With
 *
 *     W[i]  = Σ w                 (prefix sums over the sorted values)
 *     WX[i] = Σ w·x
 *     WX2[i]= Σ w·x²
 *
 * the weighted within-cluster sum of squares of the run `[i, j]` is
 *
 *     cost(i, j) = (WX2[j+1] − WX2[i]) − (WX[j+1] − WX[i])² / (W[j+1] − W[i])
 *
 * which is O(1) after the prefix pass. Then
 *
 *     D[m][j] = min over i of ( D[m−1][i] + cost(i, j−1) )
 *
 * is the optimal cost of splitting the first j values into m clusters. We keep a
 * backtrack table to recover the cuts. Complexity is O(k·n²) time and O(k·n)
 * memory — with n in the low hundreds and k = 3 that is well under a millisecond.
 */

export interface Cluster1DResult {
  /** Cluster index per *input* element (not per sorted element), 0-based, left to right. */
  assignments: number[]
  /** Indices into the original input array, grouped by cluster and sorted by value. */
  groups: number[][]
  /** Weighted mean of each cluster, ascending. */
  centers: number[]
  /** `[min, max]` of the values in each cluster. */
  ranges: Array<[number, number]>
  /** Total weighted within-cluster sum of squares — lower is a tighter fit. */
  withinSS: number
  /** Number of clusters actually produced; may be < k when `values` is short. */
  k: number
}

/**
 * Exact k-means on a line.
 *
 * @param values  The 1-D coordinates to cluster.
 * @param k       Desired cluster count. Clamped to `[1, values.length]`.
 * @param weights Optional per-value weights (e.g. box width). Must be positive.
 */
export function ckmeans1d(
  values: readonly number[],
  k: number,
  weights?: readonly number[],
): Cluster1DResult {
  const n = values.length
  if (n === 0) {
    return { assignments: [], groups: [], centers: [], ranges: [], withinSS: 0, k: 0 }
  }

  const kk = Math.max(1, Math.min(Math.floor(k), n))

  // Sort indices by value; all DP below runs in sorted space.
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => values[a] - values[b] || a - b,
  )
  const xs = order.map((i) => values[i])
  const ws = order.map((i) => {
    const w = weights ? weights[i] : 1
    return Number.isFinite(w) && w > 0 ? w : 1
  })

  // Prefix sums. Index i holds the sum over the first i sorted elements.
  const W = new Float64Array(n + 1)
  const WX = new Float64Array(n + 1)
  const WX2 = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    W[i + 1] = W[i] + ws[i]
    WX[i + 1] = WX[i] + ws[i] * xs[i]
    WX2[i + 1] = WX2[i] + ws[i] * xs[i] * xs[i]
  }

  /** Weighted within-cluster sum of squares for the inclusive sorted run [i, j]. */
  const cost = (i: number, j: number): number => {
    if (j < i) return 0
    const w = W[j + 1] - W[i]
    if (w <= 0) return 0
    const sx = WX[j + 1] - WX[i]
    const sxx = WX2[j + 1] - WX2[i]
    // Floating point can push a degenerate (all-equal) run marginally negative.
    return Math.max(0, sxx - (sx * sx) / w)
  }

  // D[m][j] = optimal cost of partitioning the first j sorted values into m clusters.
  // B[m][j] = index where that final cluster starts.
  const D: Float64Array[] = []
  const B: Int32Array[] = []
  for (let m = 0; m <= kk; m++) {
    D.push(new Float64Array(n + 1).fill(Infinity))
    B.push(new Int32Array(n + 1))
  }
  D[0][0] = 0

  for (let m = 1; m <= kk; m++) {
    for (let j = m; j <= n; j++) {
      let best = Infinity
      let bestI = m - 1
      // The final cluster spans sorted indices [i, j-1]; it must be non-empty,
      // and the first i values must be splittable into m-1 non-empty clusters.
      for (let i = m - 1; i < j; i++) {
        const prev = D[m - 1][i]
        if (prev === Infinity) continue
        const c = prev + cost(i, j - 1)
        if (c < best) {
          best = c
          bestI = i
        }
      }
      D[m][j] = best
      B[m][j] = bestI
    }
  }

  // Backtrack the cut points.
  const cuts: number[] = []
  let j = n
  for (let m = kk; m >= 1; m--) {
    const i = B[m][j]
    cuts.unshift(i)
    j = i
  }
  cuts.push(n) // sentinel: end of the last cluster

  const assignments = new Array<number>(n).fill(0)
  const groups: number[][] = []
  const centers: number[] = []
  const ranges: Array<[number, number]> = []

  for (let c = 0; c < kk; c++) {
    const start = cuts[c]
    const end = cuts[c + 1] // exclusive
    const members: number[] = []
    let sw = 0
    let swx = 0
    for (let s = start; s < end; s++) {
      const original = order[s]
      assignments[original] = c
      members.push(original)
      sw += ws[s]
      swx += ws[s] * xs[s]
    }
    groups.push(members)
    centers.push(sw > 0 ? swx / sw : Number.NaN)
    ranges.push(end > start ? [xs[start], xs[end - 1]] : [Number.NaN, Number.NaN])
  }

  return {
    assignments,
    groups,
    centers,
    ranges,
    withinSS: D[kk][n],
    k: kk,
  }
}

/**
 * Split the sorted values at the `k-1` largest gaps.
 *
 * This is the fallback when the DP result fails validation. It optimises a
 * different objective — maximum separation rather than minimum variance — and so
 * behaves better when the columns have very unequal populations (e.g. a short
 * third column), which is precisely where plain k-means tends to split the
 * largest cluster in half and merge the two small ones.
 */
export function gapSplit1d(
  values: readonly number[],
  k: number,
): Cluster1DResult {
  const n = values.length
  if (n === 0) {
    return { assignments: [], groups: [], centers: [], ranges: [], withinSS: 0, k: 0 }
  }
  const kk = Math.max(1, Math.min(Math.floor(k), n))

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => values[a] - values[b] || a - b,
  )
  const xs = order.map((i) => values[i])

  // Candidate cuts, ranked by the gap they straddle.
  const gaps: Array<{ at: number; size: number }> = []
  for (let i = 1; i < n; i++) gaps.push({ at: i, size: xs[i] - xs[i - 1] })
  gaps.sort((a, b) => b.size - a.size || a.at - b.at)

  const cutSet = new Set(gaps.slice(0, kk - 1).map((g) => g.at))
  const cuts = [0, ...Array.from(cutSet).sort((a, b) => a - b), n]

  const assignments = new Array<number>(n).fill(0)
  const groups: number[][] = []
  const centers: number[] = []
  const ranges: Array<[number, number]> = []
  let withinSS = 0

  for (let c = 0; c < cuts.length - 1; c++) {
    const start = cuts[c]
    const end = cuts[c + 1]
    const members: number[] = []
    let sum = 0
    for (let s = start; s < end; s++) {
      assignments[order[s]] = c
      members.push(order[s])
      sum += xs[s]
    }
    const count = end - start
    const mean = count > 0 ? sum / count : Number.NaN
    for (let s = start; s < end; s++) withinSS += (xs[s] - mean) ** 2
    groups.push(members)
    centers.push(mean)
    ranges.push(count > 0 ? [xs[start], xs[end - 1]] : [Number.NaN, Number.NaN])
  }

  return { assignments, groups, centers, ranges, withinSS, k: groups.length }
}

/** Why a clustering was rejected, for `processingMeta.warnings`. */
export type ClusterProblem =
  | 'empty-cluster'
  | 'overlapping-ranges'
  | 'degenerate-separation'
  | 'severe-imbalance'

export interface ClusterValidation {
  ok: boolean
  problems: ClusterProblem[]
  /**
   * Smallest gap between adjacent cluster ranges, divided by the mean cluster
   * width. Values below ~0.5 mean the "columns" are not really separated.
   */
  separationRatio: number
}

/**
 * Sanity-check a candidate column split.
 *
 * A mathematically optimal partition is still wrong if the data simply is not
 * three columns — the DP will happily slice one dense column into three. These
 * checks catch that.
 */
export function validateClustering(
  result: Cluster1DResult,
  expectedK: number,
  totalCount: number,
): ClusterValidation {
  const problems: ClusterProblem[] = []

  if (result.k < expectedK || result.groups.some((g) => g.length === 0)) {
    problems.push('empty-cluster')
  }

  // Ranges must be strictly ordered: column i must end before column i+1 begins.
  for (let i = 1; i < result.ranges.length; i++) {
    const prev = result.ranges[i - 1]
    const cur = result.ranges[i]
    if (!Number.isFinite(prev[1]) || !Number.isFinite(cur[0])) continue
    if (cur[0] <= prev[1]) {
      problems.push('overlapping-ranges')
      break
    }
  }

  // Compare the inter-cluster gaps against the intra-cluster spreads. Real
  // columns are separated by much more whitespace than they are wide internally.
  const widths = result.ranges
    .filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]))
    .map((r) => r[1] - r[0])
  const meanWidth = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0

  let minGap = Infinity
  for (let i = 1; i < result.ranges.length; i++) {
    const prev = result.ranges[i - 1]
    const cur = result.ranges[i]
    if (!Number.isFinite(prev[1]) || !Number.isFinite(cur[0])) continue
    minGap = Math.min(minGap, cur[0] - prev[1])
  }
  if (!Number.isFinite(minGap)) minGap = 0

  const separationRatio = meanWidth > 0 ? minGap / meanWidth : minGap > 0 ? Infinity : 0
  if (result.k > 1 && separationRatio < 0.15) {
    problems.push('degenerate-separation')
  }

  // A column holding under 10% of the expected even share is suspicious, though
  // it is a warning rather than a hard failure — short columns do happen.
  if (totalCount > 0 && result.k > 1) {
    const evenShare = totalCount / result.k
    if (result.groups.some((g) => g.length > 0 && g.length < evenShare * 0.1)) {
      problems.push('severe-imbalance')
    }
  }

  const fatal = problems.filter(
    (p) => p === 'empty-cluster' || p === 'overlapping-ranges' || p === 'degenerate-separation',
  )
  return { ok: fatal.length === 0, problems, separationRatio }
}
