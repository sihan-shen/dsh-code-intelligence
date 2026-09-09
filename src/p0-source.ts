import { OUTPUT_POLICY_P0 as O, parseExpandSourceRequestP0, parseExpandSourceResultP0, type ExpandSourceResultP0 } from '@han_05/dsh-context'
import { assertOffsetRangeP0, lineRangeToOffsetsP0, positionAtOffsetP0 } from './p0-line-map.js'
import { checkBuildControlP0, excludedPathP0 } from './p0-reader.js'
import { failureP0, outputBudgetP0, outputBytesP0, receiptP0, requestP0, snapshotP0 } from './p0-query.js'
import type { BuildControlP0, BuiltIndexP0, VerifiedReaderP0 } from './p0-types.js'

/** Owned by the live Session, never by an agent, root call, compiler or index. */
export class SourceBudgetP0 {
  #spent = 0
  constructor(readonly maximum: number | null = O.defaultSessionSourceBytes) {
    if (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 0)) throw new TypeError('Invalid Session source budget')
  }
  get spent(): number { return this.#spent }
  get remaining(): number | null { return this.maximum === null ? null : this.maximum - this.#spent }
  /** Synchronous check-and-debit: no await between balance validation and commit. */
  debit(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid debit')
    const remaining = this.remaining
    if (remaining !== null && bytes > remaining) failureP0('budget-exceeded', 'Session source output budget exceeded; request a smaller explicit range.', {
      limit: 'remainingSessionBytes', requestedOutputBytes: bytes, remainingSessionBytes: remaining,
    })
    this.#spent += bytes
  }
}

/** Prepare and validate data only; tool adapter owns final serialization and debit. */
export async function expandSourceP0(index: BuiltIndexP0, reader: VerifiedReaderP0, raw: unknown, control: BuildControlP0 = {}, nestedRoots: readonly string[] = []): Promise<ExpandSourceResultP0> {
  const request = requestP0(parseExpandSourceRequestP0, raw)
  checkBuildControlP0(control)
  snapshotP0(index, request.snapshotId)
  if (excludedPathP0(request.path, nestedRoots)) failureP0('access-denied', 'Path is excluded by workspace policy.')
  const receipt = receiptP0(index, request.path)
  if (receipt.contentHash !== request.sourceHash) failureP0('stale-source', 'Receipt hash differs; reacquire the receipt after rebuilding the Session.', { reason: 'receipt-hash-mismatch' })
  if (request.blockId !== undefined) failureP0('cache-unavailable', 'Optional cache is unavailable; omit blockId and use the direct source request.')
  const file = await reader({ ...control, path: request.path, expectedHash: receipt.contentHash, maxBytes: receipt.byteLength })
  checkBuildControlP0(control)
  let startOffset: number, endOffset: number
  try {
    const map = file.lineMap
    const range = request.wholeFile ? { startOffset: 0, endOffset: map.textLength }
      : request.offsetRange ?? lineRangeToOffsetsP0(map, request.lineRange!.startLine, request.lineRange!.endLine)
    ;({ startOffset, endOffset } = range)
    assertOffsetRangeP0(map, startOffset, endOffset)
    if (request.paddingLines) {
      const startLine = positionAtOffsetP0(map, startOffset).line
      // end-1 may itself lie inside a surrogate pair: line lookup needs only line starts.
      const lastOffset = endOffset > startOffset ? endOffset - 1 : startOffset
      let endLine = startLine
      while (endLine < map.lineStarts.length && map.lineStarts[endLine] <= lastOffset) endLine++
      ;({ startOffset, endOffset } = lineRangeToOffsetsP0(map, Math.max(1, startLine - request.paddingLines), Math.min(map.lineStarts.length, endLine + request.paddingLines)))
    }
  } catch { return failureP0('invalid-query', 'Source range is outside the file or splits a UTF-16 surrogate pair.') }
  const result: ExpandSourceResultP0 = {
    schemaVersion: 'p0', snapshotId: index.snapshot.snapshotId, path: receipt.path, sourceHash: receipt.contentHash,
    startOffset, endOffset, start: positionAtOffsetP0(file.lineMap, startOffset), end: positionAtOffsetP0(file.lineMap, endOffset), text: file.text.slice(startOffset, endOffset),
  }
  const bytes = outputBytesP0(result)
  if (bytes > O.maxOutputBytes) return outputBudgetP0(bytes)
  try { return parseExpandSourceResultP0(result) } catch { return failureP0('provider-failed', 'Source result violates the shared contract.', { reason: 'contract-invalid' }) }
}
