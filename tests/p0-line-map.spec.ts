import { describe, expect, it } from 'vitest'
import { assertOffsetRangeP0, createCanonicalLineMapP0, lineRangeToOffsetsP0, offsetAtPositionP0, positionAtOffsetP0 } from '../src/p0-line-map.ts'

describe('P0 canonical line map', () => {
  it('preserves UTF16, BOM, all terminators and the trailing empty line', () => {
    const text = '\uFEFF😀x\r\ny\nz\rA\u2028B\u2029'
    const map = createCanonicalLineMapP0(text)
    expect(map.lineStarts).toEqual([0, 6, 8, 10, 12, 14])
    expect(map.surrogatePairStarts).toEqual([1])
    expect(map.textLength).toBe(14)
    expect(positionAtOffsetP0(map, 5)).toEqual({ line: 1, column: 5 })
    expect(lineRangeToOffsetsP0(map, 1, 1)).toEqual({ startOffset: 0, endOffset: 6 })
    expect(lineRangeToOffsetsP0(map, 6, 6)).toEqual({ startOffset: 14, endOffset: 14 })
    for (let offset = 0; offset <= text.length; offset++) {
      if (offset !== 2) expect(offsetAtPositionP0(map, positionAtOffsetP0(map, offset))).toBe(offset)
    }
    expect(Object.isFrozen(map.lineStarts)).toBe(true)
  })
  it('rejects surrogate splits, invalid positions and out-of-bounds/reversed ranges', () => {
    const map = createCanonicalLineMapP0('😀\r\nx')
    expect(() => positionAtOffsetP0(map, 1)).toThrow(/surrogate/)
    expect(() => assertOffsetRangeP0(map, 0, 1)).toThrow(/surrogate/)
    expect(() => offsetAtPositionP0(map, { line: 1, column: 4 })).toThrow()
    expect(() => assertOffsetRangeP0(map, 4, 2)).toThrow()
    expect(() => positionAtOffsetP0(map, 6)).toThrow()
    expect(() => lineRangeToOffsetsP0(map, 0, 1)).toThrow()
    expect(() => lineRangeToOffsetsP0(map, 1, 3)).toThrow()
  })
  it('represents empty files and empty windows without special cases', () => {
    const map = createCanonicalLineMapP0('')
    expect(map.lineStarts).toEqual([0])
    expect(positionAtOffsetP0(map, 0)).toEqual({ line: 1, column: 0 })
    expect(lineRangeToOffsetsP0(map, 1, 1)).toEqual({ startOffset: 0, endOffset: 0 })
    expect(() => assertOffsetRangeP0(map, 0, 0)).not.toThrow()
  })
})
