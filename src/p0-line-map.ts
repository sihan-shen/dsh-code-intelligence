import type { OffsetRangeP0, PositionP0 } from '@han_05/dsh-context'
import type { CanonicalLineMapP0 } from './p0-types.js'

/** Coordinates preserve the verified text verbatim, including BOM and terminators. */
export function createCanonicalLineMapP0(text: string): CanonicalLineMapP0 {
  const lineStarts = [0]
  const surrogatePairStarts: number[] = []
  for (let offset = 0; offset < text.length; offset++) {
    const code = text.charCodeAt(offset)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(offset + 1)
      if (next >= 0xdc00 && next <= 0xdfff) surrogatePairStarts.push(offset)
    }
    if (code === 13 && text.charCodeAt(offset + 1) === 10) offset++
    if (code === 13 || code === 10 || code === 0x2028 || code === 0x2029) lineStarts.push(offset + 1)
  }
  return Object.freeze({ textLength: text.length, lineStarts: Object.freeze(lineStarts), surrogatePairStarts: Object.freeze(surrogatePairStarts) })
}

/** Index of the last value <= needle. */
function floorIndex(values: readonly number[], needle: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (values[middle] <= needle) low = middle + 1
    else high = middle
  }
  return low - 1
}

function assertOffset(map: CanonicalLineMapP0, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > map.textLength) throw new RangeError('offset is outside canonical text')
  const pair = floorIndex(map.surrogatePairStarts, offset - 1)
  if (pair >= 0 && map.surrogatePairStarts[pair] === offset - 1) throw new RangeError('offset splits a surrogate pair')
}

export function positionAtOffsetP0(map: CanonicalLineMapP0, offset: number): PositionP0 {
  assertOffset(map, offset)
  const index = floorIndex(map.lineStarts, offset)
  return Object.freeze({ line: index + 1, column: offset - map.lineStarts[index] })
}

export function offsetAtPositionP0(map: CanonicalLineMapP0, position: PositionP0): number {
  const { line, column } = position
  if (!Number.isSafeInteger(line) || line < 1 || line > map.lineStarts.length || !Number.isSafeInteger(column) || column < 0) throw new RangeError('invalid canonical position')
  const offset = map.lineStarts[line - 1] + column
  if (line < map.lineStarts.length && offset >= map.lineStarts[line]) throw new RangeError('column extends beyond line')
  assertOffset(map, offset)
  return offset
}

export function assertOffsetRangeP0(map: CanonicalLineMapP0, startOffset: number, endOffset: number): void {
  assertOffset(map, startOffset)
  assertOffset(map, endOffset)
  if (startOffset > endOffset) throw new RangeError('offset range is reversed')
}

/** Inclusive line range, including the last requested line's terminator if present. */
export function lineRangeToOffsetsP0(map: CanonicalLineMapP0, startLine: number, endLine: number): OffsetRangeP0 {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > map.lineStarts.length) throw new RangeError('line range is outside canonical text')
  return Object.freeze({ startOffset: map.lineStarts[startLine - 1], endOffset: map.lineStarts[endLine] ?? map.textLength })
}
