/**
 * Score a reader against `fixtures/ground-truth.json`.
 *
 * Runs under vitest purely because it is the TypeScript runner this repo
 * already has; it is a report, not a pass/fail gate, and asserts only that the
 * files it needs exist. Run it with:
 *
 *     .venv/bin/python python/read_receipt.py frontend/public/samples/weekly-invoice.jpg \
 *       > frontend/tools/out/weekly-invoice.words.json
 *     pnpm --dir frontend exec vitest run tools/score.test.ts
 *
 * The point of routing Python's words through the real row builders rather than
 * reimplementing them is that both readers are then scored through identical
 * downstream code: a difference in the score is a difference in *reading*, not
 * in row assembly. It is also what caught the t^2/t^3 regression — a change can
 * improve every row you happen to look at and still lose ground overall.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  inventoryRowsFromWords,
  invoiceRowsFromWords,
  settlementRowsFromWords,
  type WordBox,
} from '../src/ocr/layout/rows'

const ROOT = join(import.meta.dirname, '..')
/** `SCORE_OUT=tools/out-new pnpm --dir frontend exec vitest run tools/score.test.ts` scores another directory. */
const OUT = process.env.SCORE_OUT ? join(ROOT, process.env.SCORE_OUT) : join(import.meta.dirname, 'out')
const truth = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'ground-truth.json'), 'utf8'),
) as Record<string, TruthEntry>

interface TruthEntry {
  kind: 'inventory' | 'settlements' | 'invoice'
  rows: string[][]
  totals?: string[]
  statedTotal?: number
}

interface ReaderOutput {
  image: string
  passes: Array<{ scale: number; words: WordBox[] }>
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const amount = (s: string) => s.toUpperCase().replace(/[^0-9.C]/g, '')

/**
 * Ensembling has to happen on rows, not on words.
 *
 * Pooling two passes' words looks like the obvious way to combine them and
 * wrecks the result: every line appears twice at slightly different
 * coordinates, the row builders pair a label from one pass with an amount from
 * the other, and the invoice drops from 40 correct rows to 3. Each pass is
 * assembled on its own and the finished rows are merged by their natural key.
 */
function mergeRows<T>(passes: T[][], keyOf: (row: T) => string, better: (a: T, b: T) => T): T[] {
  const merged = new Map<string, T>()
  for (const rows of passes) {
    for (const row of rows) {
      const id = keyOf(row)
      if (!id) continue
      const existing = merged.get(id)
      merged.set(id, existing ? better(existing, row) : row)
    }
  }
  return [...merged.values()]
}

/** How many of the four count columns came back in the shape the sheet prints. */
const countsWellFormed = (r: { int: string; rec: string; act: string; set: string }) =>
  [r.int, r.rec, r.act, r.set].filter((v) => /^\d{3}$/.test(v)).length

function scoreSettlements(passes: WordBox[][], entry: TruthEntry) {
  const rows = mergeRows(
    passes.map((words) => settlementRowsFromWords(words, 0.5)),
    (r) => r.gamePack,
    (a, b) => (b.confidence > a.confidence ? b : a),
  )
  const byPack = new Map(rows.map((r) => [r.gamePack, r]))
  const found = entry.rows.filter(([pack]) => byPack.has(pack ?? ''))
  const dates = entry.rows.filter(
    ([pack, , date]) => byPack.get(pack ?? '')?.dateSettled === date,
  )
  const names = entry.rows.filter(([pack, name]) => byPack.get(pack ?? '')?.name === name)
  return {
    rows: rows.length,
    of: entry.rows.length,
    found: found.length,
    exact: dates.length,
    namesExact: names.length,
    missing: entry.rows.filter(([p]) => !byPack.has(p ?? '')).map(([p]) => p),
    nameMismatches: entry.rows
      .filter(([pack, name]) => byPack.has(pack ?? '') && byPack.get(pack ?? '')?.name !== name)
      .map(([pack, name]) => `${pack}: "${byPack.get(pack ?? '')?.name}" (printed "${name}")`),
  }
}

function scoreInventory(passes: WordBox[][], entry: TruthEntry) {
  const rows = mergeRows(
    passes.map((words) => inventoryRowsFromWords(words, 0.5)),
    (r) => r.game || r.name.toUpperCase(),
    // Prefer the pass whose counts came back whole; fall back to confidence.
    (a, b) => {
      const scoreA = countsWellFormed(a)
      const scoreB = countsWellFormed(b)
      if (scoreB !== scoreA) return scoreB > scoreA ? b : a
      return b.confidence > a.confidence ? b : a
    },
  )
  const byGame = new Map(rows.filter((r) => r.game).map((r) => [r.game, r]))
  let allFour = 0
  for (const [game, , int, rec, act, set] of entry.rows) {
    const got = byGame.get(game ?? '')
    if (got && got.int === int && got.rec === rec && got.act === act && got.set === set) {
      allFour += 1
    }
  }
  const totals = rows.find((r) => !r.game && /^totals$/i.test(r.name))
  const [tInt, tRec, tAct, tSet] = entry.totals ?? []
  return {
    rows: rows.length,
    of: entry.rows.length,
    found: entry.rows.filter(([g]) => byGame.has(g ?? '')).length,
    countsExact: allFour,
    namesExact: entry.rows.filter(([g, name]) => byGame.get(g ?? '')?.name === name).length,
    totalsExact:
      !!totals && totals.int === tInt && totals.rec === tRec && totals.act === tAct && totals.set === tSet,
    nameMismatches: entry.rows
      .filter(([g, name]) => byGame.has(g ?? '') && byGame.get(g ?? '')?.name !== name)
      .map(([g, name]) => `${g}: "${byGame.get(g ?? '')?.name}" (printed "${name}")`),
    missing: entry.rows.filter(([g]) => !byGame.has(g ?? '')).map(([g]) => g),
    spurious: rows.filter((r) => r.game && !entry.rows.some(([g]) => g === r.game)).map((r) => r.game),
  }
}

/**
 * The invoice has no key to merge on — `Promo`, `Sales Comm`, `Adjustments` and
 * `Selling Bonus` each appear twice, so a label cannot identify a row. Merging
 * on position would assume both passes read the same number of rows, which is
 * exactly what fails. So the best single pass wins.
 */
function scoreInvoice(passes: WordBox[][], entry: TruthEntry) {
  const scored = passes.map((words) => {
    const rows = invoiceRowsFromWords(words, 0.5)
    const pool = entry.rows.map(([label, value]) => ({ label, value, used: false }))
    let exact = 0
    for (const row of rows) {
      const hit = pool.find(
        (t) =>
          !t.used && key(t.label ?? '') === key(row.label) && amount(t.value ?? '') === amount(row.value),
      )
      if (hit) {
        hit.used = true
        exact += 1
      }
    }
    return { rows, exact }
  })
  const best = scored.reduce((a, b) => (b.exact > a.exact ? b : a))
  const rows = best.rows
  const pool = entry.rows.map(([label, value]) => ({ label, value, used: false }))
  let exact = 0
  for (const row of rows) {
    const hit = pool.find(
      (t) => !t.used && key(t.label ?? '') === key(row.label) && amount(t.value ?? '') === amount(row.value),
    )
    if (hit) {
      hit.used = true
      exact += 1
    }
  }
  return {
    rows: rows.length,
    of: entry.rows.length,
    exact,
    unmatched: pool.filter((t) => !t.used).map((t) => `${t.label} | ${t.value}`),
  }
}

describe('reader score against ground truth', () => {
  it('has a ground-truth fixture for every sample receipt', () => {
    const samples = readdirSync(join(ROOT, 'public', 'samples')).filter((f) => f.endsWith('.jpg'))
    for (const sample of samples) expect(Object.keys(truth)).toContain(sample)
  })

  it('scores whatever reader output is present in tools/out', () => {
    if (!existsSync(OUT)) {
      console.log(
        '\nNo tools/out — nothing to score yet. Produce some with:\n' +
          '  .venv/bin/python python/read_receipt.py frontend/public/samples/<image> > frontend/tools/out/<image>.words.json\n',
      )
      return
    }

    const files = readdirSync(OUT).filter((f) => f.endsWith('.words.json'))
    expect(files.length).toBeGreaterThan(0)

    const report: Record<string, unknown> = {}
    for (const file of files) {
      const output = JSON.parse(readFileSync(join(OUT, file), 'utf8')) as ReaderOutput
      const sample = file.replace(/\.words\.json$/, '')
      const entry = truth[sample] ?? truth[`${sample}.jpg`]
      if (!entry) {
        report[file] = 'no ground truth for this image'
        continue
      }
      const passes = output.passes.map((pass) => pass.words)
      report[file] = {
        scales: output.passes.map((pass) => pass.scale),
        ...(entry.kind === 'settlements'
          ? scoreSettlements(passes, entry)
          : entry.kind === 'inventory'
            ? scoreInventory(passes, entry)
            : scoreInvoice(passes, entry)),
      }
    }

    console.log('\n' + JSON.stringify(report, null, 1) + '\n')
  })
})
