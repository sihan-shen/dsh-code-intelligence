import * as ts from 'typescript'
import { EXTRACTION_POLICY_P0, type ExtractionReasonP0, type ProviderIdentityP0, type RepoFileSummaryP0, type SymbolKindP0 } from '@han_05/dsh-context'
import type {
  BuildControlP0,
  ExtractionLimitsP0,
  FileExtractionFactsP0,
  FileExtractorP0,
  LocalRelationEndpointP0,
  LocalRelationFactP0,
  LocalSymbolFactP0,
  VerifiedFileP0,
} from './p0-types.js'

const textEncoder = new TextEncoder()
const SUPPORTED_EXTENSIONS = new Set<string>(EXTRACTION_POLICY_P0.supportedExtensions)
const DEFAULT_LIMITS: ExtractionLimitsP0 = Object.freeze({
  maxNodes: EXTRACTION_POLICY_P0.maxNodes,
  maxDepth: EXTRACTION_POLICY_P0.maxDepth,
  maxSymbols: EXTRACTION_POLICY_P0.maxSymbols,
  maxRelations: EXTRACTION_POLICY_P0.maxRelations,
})

type MutableState = {
  readonly symbols: LocalSymbolFactP0[]
  readonly relationships: LocalRelationFactP0[]
  readonly relationKeys: Set<string>
  readonly reasons: Set<ExtractionReasonP0>
  nextLocalId: number
}

type VariableBindingContext = {
  readonly topLevelExport: boolean
}

type VisitFrame = {
  readonly node: ts.Node
  readonly parentLocalId: number | undefined
  readonly depth: number
  readonly variableBindingContext?: VariableBindingContext
}

function extension(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  return dot <= slash ? '' : path.slice(dot).toLowerCase()
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extension(path)) {
    case '.tsx': return ts.ScriptKind.TSX
    case '.jsx': return ts.ScriptKind.JSX
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS
    default: return ts.ScriptKind.TS
  }
}

function checkedLimits(overrides: Partial<ExtractionLimitsP0> | undefined): ExtractionLimitsP0 {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ExtractionLimitsP0)[]) {
    const value = limits[key]
    const maximum = DEFAULT_LIMITS[key]
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TypeError(`${key} must be an integer between 1 and ${maximum}`)
    }
  }
  return Object.freeze(limits)
}

function identityFor(limits: ExtractionLimitsP0): ProviderIdentityP0 {
  return Object.freeze({
    providerId: 'typescript-ast',
    providerVersion: 'p0-v1',
    extractionConfigVersion: `${EXTRACTION_POLICY_P0.policyVersion};n=${limits.maxNodes};d=${limits.maxDepth};s=${limits.maxSymbols};r=${limits.maxRelations}`,
    typescriptVersion: ts.version,
  })
}

function checkpoint(control: BuildControlP0 | undefined): void {
  control?.signal?.throwIfAborted()
  if (control?.deadlineMs !== undefined) {
    if (!Number.isFinite(control.deadlineMs)) throw new TypeError('deadlineMs must be finite')
    if (Date.now() >= control.deadlineMs) throw new DOMException('AST extraction deadline exceeded', 'TimeoutError')
  }
}

function isControlFailure(error: unknown, control: BuildControlP0 | undefined): boolean {
  return control?.signal?.aborted === true || (error instanceof DOMException && error.name === 'TimeoutError')
}

function byteLengthWithin(value: string, maximum: number): boolean {
  return textEncoder.encode(value).byteLength <= maximum
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind) === true
}

function literalName(name: ts.PropertyName | ts.ModuleName | undefined): string | undefined {
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
  }
  return undefined
}

function declarationKind(node: ts.Node): SymbolKindP0 | undefined {
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isInterfaceDeclaration(node)) return 'interface'
  if (ts.isTypeAliasDeclaration(node)) return 'type'
  if (ts.isEnumDeclaration(node)) return 'enum'
  if (ts.isModuleDeclaration(node)) return 'namespace'
  return undefined
}

function memberKind(node: ts.Node): SymbolKindP0 | undefined {
  const parent = node.parent
  if (parent === undefined) return undefined
  const classMember = ts.isClassLike(parent)
  const interfaceMember = ts.isInterfaceDeclaration(parent)
  if (!classMember && !interfaceMember) return undefined
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return 'method'
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return 'property'
  return undefined
}

function endpointKey(endpoint: LocalRelationEndpointP0): string {
  switch (endpoint.kind) {
    case 'file': return 'f'
    case 'symbol': return `s:${endpoint.localId}`
    case 'unresolved': return `u:${endpoint.name === undefined ? '-' : `n${endpoint.name.length}:${endpoint.name}`}:${endpoint.specifier === undefined ? '-' : `p${endpoint.specifier.length}:${endpoint.specifier}`}`
  }
}

function frozenEndpoint(endpoint: LocalRelationEndpointP0): LocalRelationEndpointP0 {
  return Object.freeze(endpoint)
}

function unsupported(file: VerifiedFileP0): FileExtractionFactsP0 {
  return Object.freeze({
    path: file.receipt.path,
    sourceHash: file.receipt.contentHash,
    eligible: false,
    status: 'unsupported',
    reasons: Object.freeze([]),
    diagnosticsCount: 0,
    symbols: Object.freeze([]),
    relationships: Object.freeze([]),
  })
}

function failed(file: VerifiedFileP0): FileExtractionFactsP0 {
  return Object.freeze({
    path: file.receipt.path,
    sourceHash: file.receipt.contentHash,
    eligible: true,
    status: 'failed',
    reasons: Object.freeze(['extraction-failed'] as const),
    diagnosticsCount: 0,
    symbols: Object.freeze([]),
    relationships: Object.freeze([]),
  })
}

function extractFacts(file: VerifiedFileP0, limits: ExtractionLimitsP0, control: BuildControlP0 | undefined): FileExtractionFactsP0 {
  checkpoint(control)
  const sourceFile = ts.createSourceFile(file.receipt.path, file.text, ts.ScriptTarget.Latest, true, scriptKind(file.receipt.path))
  checkpoint(control)

  const parseDiagnostics = (sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  const state: MutableState = {
    symbols: [],
    relationships: [],
    relationKeys: new Set(),
    reasons: new Set(parseDiagnostics.length > 0 ? ['syntax-diagnostics'] : []),
    nextLocalId: 1,
  }

  const markCapacity = (): void => { state.reasons.add('capacity-limit') }

  const addRelation = (type: LocalRelationFactP0['type'], source: LocalRelationEndpointP0, target: LocalRelationEndpointP0, resolution: LocalRelationFactP0['resolution']): void => {
    const key = `${type}\u0000${endpointKey(source)}\u0000${endpointKey(target)}\u0000${resolution}`
    if (state.relationKeys.has(key)) return
    if (state.relationships.length >= limits.maxRelations) {
      markCapacity()
      return
    }
    const relation = Object.freeze({ type, source: frozenEndpoint(source), target: frozenEndpoint(target), resolution }) as LocalRelationFactP0
    state.relationKeys.add(key)
    state.relationships.push(relation)
  }

  const addUnresolvedRelation = (type: 'imports' | 'exports' | 'calls', name: string | undefined, specifier: string | undefined): void => {
    if ((name !== undefined && !byteLengthWithin(name, EXTRACTION_POLICY_P0.maxNameBytes))
      || (specifier !== undefined && !byteLengthWithin(specifier, EXTRACTION_POLICY_P0.maxNameBytes))) {
      markCapacity()
      return
    }
    const target = Object.freeze({
      kind: 'unresolved' as const,
      ...(name !== undefined ? { name } : {}),
      ...(specifier !== undefined ? { specifier } : {}),
    })
    addRelation(type, { kind: 'file' }, target, type === 'calls' ? 'heuristic' : 'syntactic')
  }

  const addSymbol = (rangeNode: ts.Node, name: string, kind: SymbolKindP0, parentLocalId: number | undefined): number | undefined => {
    if (!byteLengthWithin(name, EXTRACTION_POLICY_P0.maxNameBytes)) {
      markCapacity()
      return undefined
    }
    if (state.symbols.length >= limits.maxSymbols) {
      markCapacity()
      return undefined
    }
    let startOffset: number
    try {
      startOffset = rangeNode.getStart(sourceFile)
    } catch {
      state.reasons.add('invalid-fact')
      return undefined
    }
    const endOffset = rangeNode.end
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || startOffset < 0 || endOffset < startOffset || endOffset > file.text.length) {
      state.reasons.add('invalid-fact')
      return undefined
    }
    const localId = state.nextLocalId++
    const fact = Object.freeze({
      localId,
      ...(parentLocalId === undefined ? {} : { parentLocalId }),
      name,
      kind,
      startOffset,
      endOffset,
    })
    state.symbols.push(fact)
    if (parentLocalId !== undefined) addRelation('contains', { kind: 'symbol', localId: parentLocalId }, { kind: 'symbol', localId }, 'syntactic')
    return localId
  }

  const addTopLevelRelationship = (node: ts.Node): void => {
    if (ts.isExportSpecifier(node)) {
      const declaration = node.parent.parent
      if (ts.isExportDeclaration(declaration) && declaration.parent === sourceFile) {
        const specifier = declaration.moduleSpecifier && ts.isStringLiteralLike(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : undefined
        addUnresolvedRelation('exports', node.name.text, specifier)
      }
      return
    }
    if (ts.isNamespaceExport(node)) {
      const declaration = node.parent
      if (ts.isExportDeclaration(declaration) && declaration.parent === sourceFile) {
        const specifier = declaration.moduleSpecifier && ts.isStringLiteralLike(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : undefined
        addUnresolvedRelation('exports', node.name.text, specifier)
      }
      return
    }
    if (node.parent !== sourceFile) return
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) addUnresolvedRelation('imports', undefined, node.moduleSpecifier.text)
      return
    }
    if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined
      if (node.exportClause === undefined && specifier !== undefined) addUnresolvedRelation('exports', undefined, specifier)
      return
    }
    if (ts.isExportAssignment(node)) {
      if (!node.isExportEquals) addUnresolvedRelation('exports', 'default', undefined)
      return
    }
    const kind = declarationKind(node)
    if (kind === undefined || !hasModifier(node, ts.SyntaxKind.ExportKeyword)) return
    if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
      addUnresolvedRelation('exports', 'default', undefined)
      return
    }
    const name = literalName((node as ts.NamedDeclaration).name as ts.PropertyName | ts.ModuleName | undefined)
    if (name !== undefined) addUnresolvedRelation('exports', name, undefined)
  }

  const addCallRelationship = (node: ts.Node): void => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (ts.isIdentifier(callee)) {
      if (callee.text !== 'require') addUnresolvedRelation('calls', callee.text, undefined)
    } else if (ts.isPropertyAccessExpression(callee)) {
      addUnresolvedRelation('calls', callee.name.text, undefined)
    }
  }

  const variableIsTopLevelExport = (declaration: ts.VariableDeclaration): boolean => {
    const declarationList = declaration.parent
    const statement = declarationList.parent
    return ts.isVariableDeclarationList(declarationList)
      && ts.isVariableStatement(statement)
      && statement.parent === sourceFile
      && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  }

  let scheduledNodes = 1
  const stack: VisitFrame[] = [{ node: sourceFile, parentLocalId: undefined, depth: 0 }]
  while (stack.length > 0) {
    checkpoint(control)
    const frame = stack.pop()!
    const node = frame.node
    addTopLevelRelationship(node)
    addCallRelationship(node)

    let childParentLocalId = frame.parentLocalId
    const kind = declarationKind(node)
    if (kind !== undefined) {
      const name = literalName((node as ts.NamedDeclaration).name as ts.PropertyName | ts.ModuleName | undefined)
      if (name !== undefined) childParentLocalId = addSymbol(node, name, kind, frame.parentLocalId) ?? frame.parentLocalId
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        const localId = addSymbol(node, node.name.text, 'variable', frame.parentLocalId)
        if (variableIsTopLevelExport(node)) addUnresolvedRelation('exports', node.name.text, undefined)
        if (localId !== undefined) childParentLocalId = localId
      }
    } else if (ts.isBindingElement(node) && frame.variableBindingContext !== undefined) {
      if (ts.isIdentifier(node.name)) {
        const localId = addSymbol(node, node.name.text, 'variable', frame.parentLocalId)
        if (frame.variableBindingContext.topLevelExport) addUnresolvedRelation('exports', node.name.text, undefined)
        if (localId !== undefined) childParentLocalId = localId
      }
    } else {
      const supportedMemberKind = memberKind(node)
      if (supportedMemberKind !== undefined) {
        const name = literalName((node as ts.NamedDeclaration).name as ts.PropertyName | undefined)
        if (name !== undefined) childParentLocalId = addSymbol(node, name, supportedMemberKind, frame.parentLocalId) ?? frame.parentLocalId
      } else if (ts.isEnumMember(node) && ts.isEnumDeclaration(node.parent)) {
        const name = literalName(node.name)
        if (name !== undefined) childParentLocalId = addSymbol(node, name, 'enum-member', frame.parentLocalId) ?? frame.parentLocalId
      }
    }

    if (frame.depth >= limits.maxDepth) {
      if (ts.forEachChild(node, child => child) !== undefined) markCapacity()
      continue
    }

    const children: VisitFrame[] = []
    ts.forEachChild(node, child => {
      checkpoint(control)
      if (scheduledNodes >= limits.maxNodes) {
        markCapacity()
        return child
      }
      scheduledNodes++
      let variableBindingContext: VariableBindingContext | undefined
      if (ts.isVariableDeclaration(node) && child === node.name && !ts.isIdentifier(node.name)) {
        variableBindingContext = { topLevelExport: variableIsTopLevelExport(node) }
      } else if (ts.isBindingElement(node) && child === node.name && !ts.isIdentifier(node.name)) {
        variableBindingContext = frame.variableBindingContext
      } else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
        variableBindingContext = frame.variableBindingContext
      }
      children.push({
        node: child,
        parentLocalId: childParentLocalId,
        depth: frame.depth + 1,
        ...(variableBindingContext === undefined ? {} : { variableBindingContext }),
      })
      return undefined
    })
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index])
  }

  checkpoint(control)
  const reasons = Object.freeze([...state.reasons].sort())
  return Object.freeze({
    path: file.receipt.path,
    sourceHash: file.receipt.contentHash,
    eligible: true,
    status: reasons.length === 0 ? 'complete' : 'partial',
    reasons,
    diagnosticsCount: parseDiagnostics.length,
    symbols: Object.freeze(state.symbols),
    relationships: Object.freeze(state.relationships),
  })
}

export class TypeScriptAstExtractorP0 implements FileExtractorP0 {
  readonly identity: ProviderIdentityP0
  readonly #limits: ExtractionLimitsP0

  constructor(limits?: Partial<ExtractionLimitsP0>) {
    this.#limits = checkedLimits(limits)
    this.identity = identityFor(this.#limits)
    Object.freeze(this)
  }

  supports(file: RepoFileSummaryP0): boolean {
    return SUPPORTED_EXTENSIONS.has(extension(file.path))
  }

  extract(file: VerifiedFileP0, control?: BuildControlP0): FileExtractionFactsP0 {
    checkpoint(control)
    if (!this.supports(file.receipt)) return unsupported(file)
    try {
      return extractFacts(file, this.#limits, control)
    } catch (error) {
      checkpoint(control)
      if (isControlFailure(error, control)) {
        if (control?.signal?.aborted) control.signal.throwIfAborted()
        throw error
      }
      return failed(file)
    }
  }
}

export function createTypeScriptAstExtractorP0(limits?: Partial<ExtractionLimitsP0>): TypeScriptAstExtractorP0 {
  return new TypeScriptAstExtractorP0(limits)
}
