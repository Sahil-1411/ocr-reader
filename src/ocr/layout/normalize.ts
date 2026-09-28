/**
 * Turning raw CTC output into a trustworthy field value.
 *
 * Even a good recogniser emits noise on a photographed receipt: a stray hyphen
 * picked up from a ruling line, an `O` where the crop clipped a `0`, or a box
 * that swallowed two cells. This module is the single place that gets cleaned
 * up, so the rules stay visible and testable rather than smeared across the
 * pipeline.
 *
 * The important design decision here is that **cleanup is per column, not
 * global**. A retailer settlement receipt has a pack code (`879-008949`), a game
 * name (`MEGA CASH CROSSWORD`) and a date (`02/23/26`) side by side; an invoice
 * has labels against amounts that may carry a credit suffix (`40.00C`). A single
 * "it must be a number" rule would throw away most of the document, and a single
 * "leave it alone" rule would miss the repairs that make the numeric columns
 * trustworthy. So each column declares what it holds, and only the matching
 * repairs are applied.
 */

import type { FieldType, RejectionReason } from '../types'

/**
 * Glyphs a recogniser most often confuses with digits.
 *
 * Only ever applied inside a context already known to be numeric. Applying it to
 * free text would turn `MONEY BAGS` into `M0NEY 8AGS`, so `text` and `auto`
 * never touch it.
 */
const DIGIT_CONFUSIONS: Record<string, string> = {
  O: '0',
  o: '0',
  Q: '0',
  D: '0',
  I: '1',
  l: '1',
  i: '1',
  '|': '1',
  '!': '1',
  Z: '2',
  z: '2',
  E: '3',
  A: '4',
  S: '5',
  s: '5',
  G: '6',
  b: '6',
  T: '7',
  B: '8',
  g: '9',
  q: '9',
}

function repairDigits(input: string): { text: string; repaired: boolean } {
  let repaired = false
  let out = ''
  for (const ch of input) {
    const sub = DIGIT_CONFUSIONS[ch]
    if (sub !== undefined) {
      out += sub
      repaired = true
    } else {
      out += ch
    }
  }
  return { text: out, repaired }
}

export interface NormalizeOptions {
  fieldType: FieldType
  /** Reject numeric values outside this inclusive range. `null` disables. */
  valueRange: [number, number] | null
  /** Reject values longer than this many characters. */
  maxLength: number
  /**
   * Pad a `number` field to a fixed width with leading zeros. Lottery number
   * grids are usually printed zero-padded; receipts are not.
   */
  padToWidth: number | null
}

export const DEFAULT_NORMALIZE: NormalizeOptions = {
  fieldType: 'auto',
  valueRange: null,
  maxLength: 64,
  padToWidth: null,
}

export interface NormalizeResult {
  /** The cleaned value, or `''` when the input could not be salvaged. */
  text: string
  /** Set when the input was rejected. */
  rejected: RejectionReason | null
  /** True when a digit-confusion repair changed at least one character. */
  repaired: boolean
}

/**
 * Normalise one recognised string according to its column's field type.
 *
 * Returns `rejected` rather than throwing, so the caller can keep the detection
 * in `rawDetections` with a reason while excluding it from `columns`.
 */
export function normalizeField(
  raw: string,
  options: NormalizeOptions = DEFAULT_NORMALIZE,
): NormalizeResult {
  // Collapse all whitespace, including the non-breaking space that some
  // recognisers emit for a wide inter-character gap.
  const trimmed = raw.replace(/[\s ]+/g, ' ').trim()

  if (trimmed.length === 0) {
    return { text: '', rejected: 'empty-text', repaired: false }
  }

  // A generous guard against pathological input, well above any real field.
  // The actual `maxLength` is enforced on the *cleaned* value below — checking
  // it here instead would reject `-12-` for being four characters long before
  // the stray ruling-line punctuation has been stripped off it.
  if (trimmed.length > options.maxLength * 4 + 32) {
    return { text: '', rejected: 'out-of-range', repaired: false }
  }

  const result = ((): NormalizeResult => {
    switch (options.fieldType) {
      case 'auto':
        return { text: trimmed, rejected: null, repaired: false }
      case 'text':
        return normalizeText(trimmed)
      case 'code':
        return normalizeCode(trimmed)
      case 'date':
        return normalizeDate(trimmed)
      case 'amount':
        return normalizeAmount(trimmed)
      case 'number':
        return normalizeNumeric(trimmed, options)
    }
  })()

  if (!result.rejected && result.text.length > options.maxLength) {
    return { text: '', rejected: 'out-of-range', repaired: result.repaired }
  }
  return result
}

/**
 * Free text. Keeps the punctuation that actually appears on these receipts —
 * `$`, `&`, `,`, `.`, `!`, `?`, `'`, `/`, `-` — and drops anything else as
 * recogniser noise.
 */
function normalizeText(input: string): NormalizeResult {
  const text = input
    .replace(/[^A-Za-z0-9 $&,.!?'/+%#:-]/g, ' ')
    .replace(/ +/g, ' ')
    .trim()
  if (text.length === 0) return { text: '', rejected: 'not-a-number', repaired: false }
  return { text, rejected: null, repaired: false }
}

/**
 * An identifier: letters, digits and internal hyphens.
 *
 * Digit repair is applied only to groups that are already mostly digits, so a
 * pack code like `879-008949` is corrected while a mixed code such as `TR00045`
 * keeps its letters.
 */
function normalizeCode(input: string): NormalizeResult {
  const cleaned = input.replace(/[^A-Za-z0-9-]/g, '')
  if (cleaned.length === 0) return { text: '', rejected: 'not-a-number', repaired: false }

  let repaired = false
  const parts = cleaned.split('-').map((part) => {
    const digitCount = (part.match(/\d/g) ?? []).length
    // "Mostly digits" means a stray letter is far more likely to be a misread
    // digit than a real letter.
    if (part.length > 0 && digitCount / part.length >= 0.6) {
      const fixed = repairDigits(part)
      repaired = repaired || fixed.repaired
      return fixed.text
    }
    return part
  })

  return { text: parts.join('-'), rejected: null, repaired }
}

/** `MM/DD/YY` or `MM/DD/YYYY`, with digit repair and separator normalisation. */
function normalizeDate(input: string): NormalizeResult {
  // A misread `/` commonly comes back as `1`, `l` or `\`. Normalise separators
  // before repairing digits, or the repair would turn them into digits.
  const separated = input.replace(/[\\|.⁄]/g, '/')
  const fixed = repairDigits(separated.replace(/[^0-9/]/g, ''))

  const match = fixed.text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (!match) return { text: '', rejected: 'not-a-number', repaired: fixed.repaired }

  const [, month, day, year] = match
  const m = Number(month)
  const d = Number(day)
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return { text: '', rejected: 'out-of-range', repaired: fixed.repaired }
  }

  return {
    text: `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${year}`,
    rejected: null,
    repaired: fixed.repaired,
  }
}

/**
 * A monetary amount.
 *
 * The trailing `C` on these receipts marks a credit and is meaningful, so it is
 * preserved rather than stripped — dropping it would silently flip the sign of
 * every cash-out line on the invoice.
 */
function normalizeAmount(input: string): NormalizeResult {
  const upper = input.toUpperCase()
  const credit = /C R?$/.test(upper) || /CR$/.test(upper) || /C$/.test(upper)

  const body = upper.replace(/\s*C\s*R?\s*$/, '')
  const fixed = repairDigits(body.replace(/[^0-9,.-]/g, ''))

  // Allow a leading minus, thousands separators, and at most one decimal point.
  const match = fixed.text.match(/^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/)
  if (!match) return { text: '', rejected: 'not-a-number', repaired: fixed.repaired }

  return {
    text: credit ? `${fixed.text}C` : fixed.text,
    rejected: null,
    repaired: fixed.repaired,
  }
}

/** A bare integer. The strictest rule — this is the lottery-grid case. */
function normalizeNumeric(input: string, options: NormalizeOptions): NormalizeResult {
  const fixed = repairDigits(input)
  let text = fixed.text.replace(/[^\d ]+/g, ' ').replace(/ +/g, ' ').trim()

  if (text.length === 0) {
    return { text: '', rejected: 'not-a-number', repaired: fixed.repaired }
  }

  // A crop that swallowed two values leaves a space. Keep the longest run rather
  // than concatenating, which would invent a number that is not on the page.
  if (text.includes(' ')) {
    const parts = text.split(' ').filter(Boolean)
    let best = parts[0]
    for (const part of parts) if (part.length > best.length) best = part
    text = best
  }

  if (!/^\d+$/.test(text)) {
    return { text: '', rejected: 'not-a-number', repaired: fixed.repaired }
  }

  if (options.valueRange) {
    const value = Number.parseInt(text, 10)
    const [lo, hi] = options.valueRange
    if (!Number.isFinite(value) || value < lo || value > hi) {
      return { text: '', rejected: 'out-of-range', repaired: fixed.repaired }
    }
  }

  if (options.padToWidth && text.length < options.padToWidth) {
    text = text.padStart(options.padToWidth, '0')
  }

  return { text, rejected: null, repaired: fixed.repaired }
}

/**
 * Convenience wrapper for the bare-integer case.
 *
 * Kept as its own entry point because the lottery-grid use case — where every
 * cell really is a two-digit number — is common enough to deserve one.
 */
export function normalizeNumber(
  raw: string,
  options: Partial<NormalizeOptions> = {},
): NormalizeResult {
  return normalizeField(raw, {
    ...DEFAULT_NORMALIZE,
    maxLength: 3,
    ...options,
    // Forced last: this entry point *means* "read it as a bare integer", and a
    // caller spreading DEFAULT_NORMALIZE would otherwise silently reset it.
    fieldType: 'number',
  })
}

/**
 * Guess what a column holds from the values in it.
 *
 * Used only when the caller has not declared a schema. It requires a clear
 * majority before committing to anything stricter than `text`, because a wrong
 * guess actively destroys data — classifying the name column as `amount` would
 * empty it — whereas `text` is always survivable.
 */
export function inferFieldType(values: readonly string[]): FieldType {
  const usable = values.map((v) => v.trim()).filter((v) => v.length > 0)
  if (usable.length < 3) return 'auto'

  const share = (test: RegExp) => usable.filter((v) => test.test(v)).length / usable.length

  if (share(/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/) > 0.8) return 'date'
  if (share(/^-?[\d,]+\.\d{2}\s*C?$/i) > 0.8) return 'amount'
  if (share(/^\d+$/) > 0.9) return 'number'
  if (share(/^[A-Z0-9]+-[A-Z0-9]+$/i) > 0.8) return 'code'
  if (share(/[A-Za-z]/) > 0.5) return 'text'

  return 'auto'
}

/**
 * Infer whether a numeric column is printed zero-padded.
 *
 * Getting this right keeps `"7"` and `"07"` from both appearing in the same
 * column. It abstains unless the evidence is unambiguous.
 */
export function inferPadWidth(texts: readonly string[]): number | null {
  const lengths = texts.filter((t) => /^\d+$/.test(t)).map((t) => t.length)
  if (lengths.length < 4) return null

  const counts = new Map<number, number>()
  for (const len of lengths) counts.set(len, (counts.get(len) ?? 0) + 1)

  const twos = counts.get(2) ?? 0
  const ones = counts.get(1) ?? 0

  if (twos / lengths.length > 0.9 && ones === 0) return 2
  return null
}
