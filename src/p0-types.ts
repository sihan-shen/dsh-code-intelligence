import type {
  ExtractionReasonP0, ExtractionStatusP0, FileExtractionStateP0,
  PositionP0, ProviderIdentityP0, RelationTypeP0, RelationshipP0,
  RepoFileSummaryP0, RepositorySnapshotP0, ScanCoverageP0, SymbolKindP0, SymbolP0,
} from '@han_05/dsh-context'

/** File-local handles are unique within one extraction result, never snapshot IDs. */
export type LocalSymbolRefP0 = number
export type LocalSymbolFactP0 = {
  readonly localId: LocalSymbolRefP0
  readonly parentLocalId?: LocalSymbolRefP0
  readonly name: string
  readonly kind: SymbolKindP0
  readonly providerKind?: string
  readonly startOffset: number
  readonly endOffset: number
}
export type LocalRelationEndpointP0 =
  | { readonly kind: 'symbol'; readonly localId: LocalSymbolRefP0 }
  | { readonly kind: 'file' }
  | { readonly kind: 'unresolved'; readonly name?: string; readonly specifier?: string }
export type LocalRelationFactP0 = {
  readonly type: RelationTypeP0
  readonly source: LocalRelationEndpointP0
  readonly target: LocalRelationEndpointP0
  readonly resolution: 'syntactic' | 'heuristic'
}
export type FileExtractionFactsP0 = {
  readonly path: string
  readonly sourceHash: string
  /** Static supports(file) result; failures never remove eligible files. */
  readonly eligible: boolean
  readonly status: ExtractionStatusP0
  readonly reasons: readonly ExtractionReasonP0[]
  readonly diagnosticsCount: number
  readonly diagnosticSummary?: string
  readonly symbols: readonly LocalSymbolFactP0[]
  readonly relationships: readonly LocalRelationFactP0[]
}
/** Compact text-independent line map, including the empty final line after a terminator.
 * F3 is the sole producer / coordinate authority; no TypeScript positions here. */
export type CanonicalLineMapP0 = {
  readonly textLength: number
  readonly lineStarts: readonly number[]
  /** Offsets of high surrogates in valid pairs, to reject split endpoints after text release. */
  readonly surrogatePairStarts: readonly number[]
}
export type VerifiedFileP0 = {
  readonly receipt: RepoFileSummaryP0
  readonly text: string
  readonly lineMap: CanonicalLineMapP0
}
export type BuildControlP0 = {
  readonly signal?: AbortSignal
  /** Epoch milliseconds; cooperative checkpoints, not a hard parse deadline. */
  readonly deadlineMs?: number
}
export type VerifiedReadRequestP0 = BuildControlP0 & {
  readonly path: string
  readonly maxBytes: number
  readonly expectedHash?: string
}
export type VerifiedReaderP0 = (request: VerifiedReadRequestP0) => Promise<VerifiedFileP0>
export type ExtractionLimitsP0 = {
  readonly maxNodes: number
  readonly maxDepth: number
  readonly maxSymbols: number
  readonly maxRelations: number
}
export type FileExtractorP0 = {
  readonly identity: ProviderIdentityP0
  supports(file: RepoFileSummaryP0): boolean
  extract(file: VerifiedFileP0, control?: BuildControlP0): FileExtractionFactsP0 | Promise<FileExtractionFactsP0>
}
export type CollectedFileP0 = {
  readonly receipt: RepoFileSummaryP0
  readonly lineMap: CanonicalLineMapP0
  readonly facts: FileExtractionFactsP0
}
export type SnapshotConfigP0 = {
  readonly workspaceRoot?: string
  readonly deploymentRoot: string
  readonly revision: string
  readonly maxFileBytes: number
  readonly maxFiles: number
  readonly maxTotalBytes: number
  readonly maxDirectories: number
  readonly maxScanEntries: number
  readonly maxIgnoreBytes: number
  readonly maxIgnorePatterns: number
  readonly nestedCheckoutRoots: readonly string[]
}
export type CollectedSnapshotP0 = {
  readonly workspaceFingerprint: string
  readonly revision: string
  readonly files: readonly CollectedFileP0[]
  readonly scanCoverage: ScanCoverageP0
}
export type BuiltIndexP0 = {
  readonly snapshot: RepositorySnapshotP0
  readonly indexFingerprint: string
  readonly providerConfigIdentity: ProviderIdentityP0
  readonly symbols: readonly SymbolP0[]
  readonly relationships: readonly RelationshipP0[]
  readonly fileExtractionStates: readonly FileExtractionStateP0[]
  readonly scanCoverage: ScanCoverageP0
}
export type BuildCandidateP0 = (control?: BuildControlP0) => Promise<BuiltIndexP0>
/** Minimal coordinate dependency signature; implemented by F3, called by F4/F5. */
export type PositionAtOffsetP0 = (lineMap: CanonicalLineMapP0, offset: number) => PositionP0
