import { describe, expect, it } from 'vitest'

import {
  applyHomography,
  homographyFromQuads,
  invert3x3,
  type Pt,
} from './homography'

const UNIT: readonly [Pt, Pt, Pt, Pt] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
]

describe('homographyFromQuads', () => {
  it('recovers the identity for identical quads', () => {
    const h = homographyFromQuads(UNIT, UNIT)!
    expect(h).not.toBeNull()
    for (const p of UNIT) {
      const q = applyHomography(h, p)!
      expect(q.x).toBeCloseTo(p.x, 6)
      expect(q.y).toBeCloseTo(p.y, 6)
    }
  })

  it('maps all four corners exactly onto a keystoned quad', () => {
    const dst: readonly [Pt, Pt, Pt, Pt] = [
      { x: 12, y: 4 },
      { x: 96, y: 18 },
      { x: 88, y: 110 },
      { x: 2, y: 94 },
    ]
    const h = homographyFromQuads(UNIT, dst)!
    dst.forEach((expected, i) => {
      const got = applyHomography(h, UNIT[i])!
      expect(got.x).toBeCloseTo(expected.x, 6)
      expect(got.y).toBeCloseTo(expected.y, 6)
    })
  })

  it('preserves straight lines — the defining property of a projective map', () => {
    const dst: readonly [Pt, Pt, Pt, Pt] = [
      { x: 10, y: 0 },
      { x: 90, y: 10 },
      { x: 100, y: 100 },
      { x: 0, y: 90 },
    ]
    const h = homographyFromQuads(UNIT, dst)!
    // Three collinear source points must stay collinear after the map.
    const a = applyHomography(h, { x: 0, y: 0 })!
    const b = applyHomography(h, { x: 50, y: 50 })!
    const c = applyHomography(h, { x: 100, y: 100 })!
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    expect(Math.abs(cross)).toBeLessThan(1e-6)
  })

  it('returns null for degenerate (collinear) input', () => {
    const collinear: readonly [Pt, Pt, Pt, Pt] = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]
    expect(homographyFromQuads(collinear, UNIT)).toBeNull()
  })

  it('round-trips through its own inverse', () => {
    const dst: readonly [Pt, Pt, Pt, Pt] = [
      { x: 20, y: 5 },
      { x: 130, y: 25 },
      { x: 115, y: 150 },
      { x: 5, y: 128 },
    ]
    const h = homographyFromQuads(UNIT, dst)!
    const hInv = invert3x3(h)!
    for (const p of [{ x: 37, y: 61 }, { x: 0, y: 0 }, { x: 100, y: 12 }]) {
      const there = applyHomography(h, p)!
      const back = applyHomography(hInv, there)!
      expect(back.x).toBeCloseTo(p.x, 5)
      expect(back.y).toBeCloseTo(p.y, 5)
    }
  })
})

describe('invert3x3', () => {
  it('returns null for a singular matrix', () => {
    expect(invert3x3([1, 2, 3, 2, 4, 6, 7, 8, 9])).toBeNull()
  })
})
