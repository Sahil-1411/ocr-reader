import { describe, expect, it } from 'vitest'

import { looksLikeOnnx, parseCharset } from './cache'

function bytes(...values: number[]): ArrayBuffer {
  // Pad past the 16-byte minimum so the length gate is not what is under test.
  const arr = new Uint8Array(64)
  arr.set(values)
  return arr.buffer
}

function ascii(text: string): ArrayBuffer {
  const arr = new Uint8Array(Math.max(64, text.length))
  for (let i = 0; i < text.length; i++) arr[i] = text.charCodeAt(i)
  return arr.buffer
}

describe('looksLikeOnnx', () => {
  it('accepts a protobuf starting with the ir_version field tag', () => {
    expect(looksLikeOnnx(bytes(0x08, 0x07, 0x12, 0x0b))).toBe(true)
  })

  it('rejects an HTML error page served with a 200', () => {
    expect(looksLikeOnnx(ascii('<!DOCTYPE html><html><body>404'))).toBe(false)
  })

  it('rejects a Git LFS pointer file', () => {
    expect(
      looksLikeOnnx(ascii('version https://git-lfs.github.com/spec/v1\noid sha256:abc')),
    ).toBe(false)
  })

  it('rejects a JSON error body', () => {
    expect(looksLikeOnnx(ascii('{"error":"not found"}'))).toBe(false)
  })

  it('rejects a truncated download', () => {
    expect(looksLikeOnnx(new Uint8Array([0x08, 0x07]).buffer)).toBe(false)
  })
})

describe('parseCharset', () => {
  it('reads one character per line', () => {
    expect(parseCharset('0\n1\n2\n')).toEqual(['0', '1', '2'])
  })

  it('preserves a space entry rather than trimming it away', () => {
    // A trimmed space would shift every later index by one — the classic
    // "text is almost right" CTC bug.
    const charset = parseCharset('a\n \nb\n')
    expect(charset).toEqual(['a', ' ', 'b'])
    expect(charset[1]).toBe(' ')
  })

  it('handles CRLF line endings', () => {
    expect(parseCharset('0\r\n1\r\n2\r\n')).toEqual(['0', '1', '2'])
  })

  it('does not invent a trailing empty entry', () => {
    expect(parseCharset('x\ny\n')).toHaveLength(2)
    expect(parseCharset('x\ny')).toHaveLength(2)
  })

  it('returns an empty array for empty input', () => {
    expect(parseCharset('')).toEqual([])
  })
})
