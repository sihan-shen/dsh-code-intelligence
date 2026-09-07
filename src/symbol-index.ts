import { canonicalJson, sha256Utf8, type InternalSymbolEntryV1, type RepositorySnapshotV1 } from '@ds-plugins/dsh-context'
import type { InternalSymbolRelationV1, SymbolAdapterResultV1 } from './types.js'

const adapterSnapshots = new WeakMap<object, RepositorySnapshotV1>()
const INDEX_CONSTRUCTION_TOKEN = Symbol('dsh-internal-symbol-index-construction')

export function bindAdapterSnapshot(adapter: SymbolAdapterResultV1, snapshot: RepositorySnapshotV1): void {
  adapterSnapshots.set(adapter, snapshot)
}

type SymbolPosition = { readonly line: number; readonly column: number }

function validatePosition(value: unknown, path: string): SymbolPosition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  const object = value as Record<string, unknown>
  for (const key of Object.keys(object)) if (key !== 'line' && key !== 'column') throw new TypeError(`unknown ${path} field: ${key}`)
  if (!Number.isSafeInteger(object.line) || (object.line as number) < 1 || !Number.isSafeInteger(object.column) || (object.column as number) < 0) throw new TypeError(`${path} is invalid`)
  return { line: object.line as number, column: object.column as number }
}

function freezeEntry(entry: InternalSymbolEntryV1, start: SymbolPosition, end: SymbolPosition): InternalSymbolEntryV1 {
  return Object.freeze({
    symbolId: entry.symbolId,
    path: entry.path,
    sourceHash: entry.sourceHash,
    start: Object.freeze(start),
    end: Object.freeze(end),
    kind: entry.kind,
    name: entry.name,
    ...(entry.container === undefined ? {} : { container: entry.container }),
    score: entry.score,
  })
}

function freezeRelation(relation: InternalSymbolRelationV1): InternalSymbolRelationV1 {
  const allowedKeys = new Set(['kind', 'targetName', 'targetPath'])
  for (const key of Object.keys(relation)) if (!allowedKeys.has(key)) throw new TypeError(`unknown symbol relation field: ${key}`)
  if (relation.kind !== 'imports' && relation.kind !== 'exports' && relation.kind !== 'contains' && relation.kind !== 'calls') throw new TypeError('symbol relation kind is invalid')
  if (typeof relation.targetName !== 'string' || relation.targetName.length === 0 || relation.targetName.length > 512 || relation.targetName.includes('\0')) throw new TypeError('symbol relation targetName is invalid')
  if (relation.targetPath !== undefined && (typeof relation.targetPath !== 'string' || relation.targetPath.length > 512 || relation.targetPath.includes('\0'))) throw new TypeError('symbol relation targetPath is invalid')
  return Object.freeze({ kind: relation.kind, targetName: relation.targetName, ...(relation.targetPath === undefined ? {} : { targetPath: relation.targetPath }) })
}

function validateEntry(snapshotId: string, snapshot: RepositorySnapshotV1 | undefined, entry: InternalSymbolEntryV1): InternalSymbolEntryV1 {
  const allowedKeys = new Set(['symbolId', 'path', 'sourceHash', 'start', 'end', 'kind', 'name', 'container', 'score'])
  for (const key of Object.keys(entry)) if (!allowedKeys.has(key)) throw new TypeError(`unknown symbol entry field: ${key}`)
  if (!/^sha256:[0-9a-f]{64}$/.test(entry.sourceHash)) throw new TypeError('symbol sourceHash must be a sha256 hash')
  if (snapshot) {
    const file = snapshot.files.find(candidate => candidate.path === entry.path)
    if (!file) throw new Error(`symbol path is not present in snapshot: ${entry.path}`)
    if (file.contentHash !== entry.sourceHash) throw new Error(`symbol source hash does not match snapshot: ${entry.path}`)
  }
  const start = validatePosition(entry.start, 'symbol start')
  const end = validatePosition(entry.end, 'symbol end')
  if (end.line < start.line || (end.line === start.line && end.column < start.column)) throw new TypeError('symbol end position is invalid')
  if (typeof entry.kind !== 'string' || entry.kind.length === 0 || typeof entry.name !== 'string' || entry.name.length === 0) throw new TypeError('symbol kind and name are required')
  if (entry.container !== undefined && (typeof entry.container !== 'string' || entry.container.length === 0)) throw new TypeError('symbol container is invalid')
  if (typeof entry.score !== 'number' || !Number.isFinite(entry.score)) throw new TypeError('symbol score is invalid')
  if (entry.symbolId !== sha256Utf8(canonicalJson([snapshotId, entry.path, entry.kind, entry.name, start, end, entry.container ?? null]))) throw new TypeError('symbolId does not match canonical symbol identity')
  return freezeEntry(entry, start, end)
}

export class InternalSymbolIndexStore {
  readonly #snapshotId: string
  readonly #adapter: Pick<SymbolAdapterResultV1, 'adapterId' | 'adapterVersion'>
  readonly #entries: readonly InternalSymbolEntryV1[]
  readonly #byPath: ReadonlyMap<string, readonly InternalSymbolEntryV1[]>
  readonly #relations: Readonly<Record<string, readonly InternalSymbolRelationV1[]>>

  private constructor(token: symbol, snapshotId: string, adapter: SymbolAdapterResultV1, entries: readonly InternalSymbolEntryV1[], resolvedSnapshot: RepositorySnapshotV1) {
    if (token !== INDEX_CONSTRUCTION_TOKEN) throw new Error('InternalSymbolIndexStore must be created by its trusted factory')
    if (resolvedSnapshot.snapshotId !== snapshotId) throw new Error('snapshot does not match requested snapshot')
    const frozenEntries = entries.map(entry => validateEntry(snapshotId, resolvedSnapshot, entry))
    const ids = new Set<string>()
    for (const entry of frozenEntries) {
      if (ids.has(entry.symbolId)) throw new Error(`duplicate symbol ID: ${entry.symbolId}`)
      ids.add(entry.symbolId)
    }
    const compareText = (first: string, second: string): number => first < second ? -1 : first > second ? 1 : 0
    const sorted = [...frozenEntries].sort((first, second) => compareText(first.path, second.path) || first.start.line - second.start.line || first.start.column - second.start.column || compareText(first.kind, second.kind) || compareText(first.name, second.name) || compareText(first.symbolId, second.symbolId))
    const byPath = new Map<string, readonly InternalSymbolEntryV1[]>()
    for (const entry of sorted) byPath.set(entry.path, Object.freeze([...(byPath.get(entry.path) ?? []), entry]))
    const relations: Record<string, readonly InternalSymbolRelationV1[]> = {}
    for (const key of Object.keys(adapter.relations).sort(compareText)) relations[key] = Object.freeze(adapter.relations[key].map(freezeRelation))
    this.#snapshotId = snapshotId
    this.#adapter = Object.freeze({ adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion })
    this.#entries = Object.freeze(sorted)
    this.#byPath = byPath
    this.#relations = Object.freeze(relations)
    Object.freeze(this)
  }

  static fromTrusted(snapshotId: string, adapter: SymbolAdapterResultV1, entries: readonly InternalSymbolEntryV1[]): InternalSymbolIndexStore {
    const snapshot = adapterSnapshots.get(adapter)
    if (!snapshot) throw new Error('trusted snapshot receipt is required for symbol index')
    if (snapshot.snapshotId !== snapshotId) throw new Error('adapter snapshot does not match requested snapshot')
    return new InternalSymbolIndexStore(INDEX_CONSTRUCTION_TOKEN, snapshotId, adapter, entries, snapshot)
  }

  get snapshotId(): string { return this.#snapshotId }
  get adapterId(): string { return this.#adapter.adapterId }
  get adapterVersion(): string { return this.#adapter.adapterVersion }
  get entries(): readonly InternalSymbolEntryV1[] { return this.#entries }

  entriesForPath(path: string): readonly InternalSymbolEntryV1[] {
    return this.#byPath.get(path) ?? Object.freeze([])
  }

  searchCandidates(query: string): readonly InternalSymbolEntryV1[] {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return this.#entries
    return this.#entries.filter(entry => `${entry.name} ${entry.kind} ${entry.path} ${entry.container ?? ''}`.toLowerCase().includes(normalized))
  }

  relationsFor(symbolId: string): readonly InternalSymbolRelationV1[] {
    return this.#relations[symbolId] ?? Object.freeze([])
  }

  relationsForPath(path: string): readonly InternalSymbolRelationV1[] {
    return this.#relations[`file:${path}`] ?? Object.freeze([])
  }
}

export function buildSymbolIndex(snapshotId: string, adapter: SymbolAdapterResultV1, entries: readonly InternalSymbolEntryV1[]): InternalSymbolIndexStore {
  return InternalSymbolIndexStore.fromTrusted(snapshotId, adapter, entries)
}
