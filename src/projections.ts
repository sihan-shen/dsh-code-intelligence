import {
  canonicalJson,
  parseRepoMapPageV1,
  parseSymbolQueryResultV1,
  sha256Utf8,
  type RepoMapPageV1,
  type RepositorySnapshotV1,
  type SymbolQueryResultV1,
} from '@ds-plugins/dsh-context'
import { MAX_OUTPUT_BYTES, PROJECTION_POLICY_VERSION } from './constants.js'
import { decodeProjectionCursor, encodeProjectionCursor, type ProjectionCursorKind } from './cursor.js'
import type { InternalSymbolIndexStore } from './symbol-index.js'

const MAX_QUERY_BYTES = 256
const MAX_CURSOR_BYTES = 1024
const MAX_LIMIT = 50
const MAX_SUMMARY_BYTES = 1_024

function compareText(first: string, second: string): number { return first < second ? -1 : first > second ? 1 : 0 }

function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength }

function truncateUtf8(value: string, maximum: number): string {
  if (utf8Length(value) <= maximum) return value
  let result = ''
  for (const character of value) {
    if (utf8Length(result + character) > maximum - 1) break
    result += character
  }
  return `${result}…`
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('limit must be an integer between 1 and 50')
}

function validateCursor(cursor: string | undefined): void {
  if (cursor !== undefined && utf8Length(cursor) > MAX_CURSOR_BYTES) throw new RangeError('cursor exceeds byte budget')
}

function validateSnapshot(snapshot: RepositorySnapshotV1): void {
  if (snapshot.schemaVersion !== 1 || typeof snapshot.snapshotId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(snapshot.snapshotId)) throw new TypeError('snapshot is invalid')
}

function validateCursorFor(cursor: string | undefined, kind: ProjectionCursorKind, snapshotId: string, queryHash: string, limit: number): number {
  if (!cursor) return 0
  const decoded = decodeProjectionCursor(cursor)
  if (decoded.kind !== kind || decoded.snapshotId !== snapshotId || decoded.queryHash !== queryHash || decoded.limit !== limit || decoded.policyVersion !== PROJECTION_POLICY_VERSION) throw new TypeError('cursor is stale or does not match request')
  return decoded.offset
}

function withinOutput(value: unknown): boolean { return utf8Length(JSON.stringify(value)) <= MAX_OUTPUT_BYTES }

function pageWithBudget<T extends { readonly items?: readonly unknown[]; readonly matches?: readonly unknown[] }>(
  make: (count: number) => T,
  requested: number,
): T {
  for (let count = requested; count >= 1; count -= 1) {
    const candidate = make(count)
    if (withinOutput(candidate)) return candidate
  }
  throw new RangeError('one projection item exceeds the output byte budget')
}

function fileSummary(path: string, index: InternalSymbolIndexStore): string {
  const entries = index.entriesForPath(path)
  const symbols = entries
    .map(entry => `${truncateUtf8(entry.name, 128)}(${truncateUtf8(entry.kind, 64)})`)
    .sort(compareText)
  const suffix = symbols.length > 24 ? `, … +${symbols.length - 24} more` : ''
  return truncateUtf8(`${symbols.length} symbols: ${symbols.slice(0, 24).join(', ')}${suffix}`, MAX_SUMMARY_BYTES)
}

function allRepoItems(snapshot: RepositorySnapshotV1, index: InternalSymbolIndexStore) {
  if (index.snapshotId !== snapshot.snapshotId) throw new TypeError('symbol index does not match snapshot')
  return [...snapshot.files]
    .sort((first, second) => compareText(first.path, second.path))
    .map(file => ({ path: file.path, sourceHash: file.contentHash, summary: fileSummary(file.path, index) }))
}

export type RepoMapOptionsV1 = { readonly limit: number; readonly cursor?: string }
export type SymbolQueryV1 = { readonly query: string; readonly limit: number; readonly cursor?: string }

export function buildRepoMap(snapshot: RepositorySnapshotV1, index: InternalSymbolIndexStore, options: RepoMapOptionsV1): RepoMapPageV1 {
  validateSnapshot(snapshot)
  validateLimit(options.limit)
  validateCursor(options.cursor)
  const queryHash = sha256Utf8('')
  const offset = validateCursorFor(options.cursor, 'repo-map', snapshot.snapshotId, queryHash, options.limit)
  const items = allRepoItems(snapshot, index)
  if (offset > items.length) throw new TypeError('cursor offset is stale')
  const remaining = items.length - offset
  const count = Math.min(options.limit, remaining)
  const make = (pageCount: number): RepoMapPageV1 => {
    const end = offset + pageCount
    const truncated = end < items.length
    const nextCursor = truncated ? encodeProjectionCursor({ schemaVersion: 1, kind: 'repo-map', snapshotId: snapshot.snapshotId, queryHash, offset: end, limit: options.limit, policyVersion: PROJECTION_POLICY_VERSION }) : undefined
    return { schemaVersion: 1, snapshotId: snapshot.snapshotId, items: items.slice(offset, end), totalItems: items.length, truncated, ...(nextCursor ? { nextCursor } : {}) }
  }
  const page = count === 0 ? make(0) : pageWithBudget(make, count)
  return parseRepoMapPageV1(page)
}

function terms(value: string): string[] {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .map(item => item.toLowerCase())
    .filter(Boolean)
}

function queryScore(entry: InternalSymbolIndexStore['entries'][number], query: string, index: InternalSymbolIndexStore): number {
  const queryTerms = terms(query)
  const name = entry.name.toLowerCase()
  const pathTerms = new Set(terms(entry.path))
  const relationTerms = new Set(index.relationsFor(entry.symbolId).flatMap(relation => terms(relation.targetName)))
  const nameTerms = new Set(terms(entry.name))
  let score = 0
  if (name === query.trim().toLowerCase()) score += 1_000
  if (name.startsWith(query.trim().toLowerCase())) score += 500
  for (const term of queryTerms) {
    if (nameTerms.has(term)) score += 100
    if (pathTerms.has(term)) score += 40
    if (relationTerms.has(term)) score += 20
  }
  return score
}

export function querySymbols(snapshot: RepositorySnapshotV1, index: InternalSymbolIndexStore, request: SymbolQueryV1): SymbolQueryResultV1 {
  validateSnapshot(snapshot)
  validateLimit(request.limit)
  validateCursor(request.cursor)
  if (typeof request.query !== 'string' || utf8Length(request.query) > MAX_QUERY_BYTES) throw new RangeError('query exceeds 256 UTF-8 bytes')
  const queryHash = sha256Utf8(request.query)
  const offset = validateCursorFor(request.cursor, 'symbol-query', snapshot.snapshotId, queryHash, request.limit)
  if (index.snapshotId !== snapshot.snapshotId) throw new TypeError('symbol index does not match snapshot')
  const matches = [...index.entries]
    .map(entry => ({ ...entry, score: queryScore(entry, request.query, index) }))
    .filter(entry => entry.score > 0)
    .sort((first, second) => second.score - first.score || compareText(first.path, second.path) || first.start.line - second.start.line || first.start.column - second.start.column || compareText(first.name, second.name) || compareText(first.symbolId, second.symbolId))
  if (offset > matches.length) throw new TypeError('cursor offset is stale')
  const remaining = matches.length - offset
  const count = Math.min(request.limit, remaining)
  const make = (pageCount: number): SymbolQueryResultV1 => {
    const end = offset + pageCount
    const truncated = end < matches.length
    const nextCursor = truncated ? encodeProjectionCursor({ schemaVersion: 1, kind: 'symbol-query', snapshotId: snapshot.snapshotId, queryHash, offset: end, limit: request.limit, policyVersion: PROJECTION_POLICY_VERSION }) : undefined
    return { schemaVersion: 1, snapshotId: snapshot.snapshotId, matches: matches.slice(offset, end), totalMatches: matches.length, truncated, ...(nextCursor ? { nextCursor } : {}) }
  }
  const result = count === 0 ? make(0) : pageWithBudget(make, count)
  return parseSymbolQueryResultV1(result)
}
