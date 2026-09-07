import * as ts from 'typescript'
import { canonicalJson, sha256Utf8, type InternalSymbolEntryV1 } from '@ds-plugins/dsh-context'
import type { RepositorySnapshotStore } from './snapshot.js'
import type { InternalSymbolRelationV1, SymbolAdapterResultV1 } from './types.js'
import { bindAdapterSnapshot } from './symbol-index.js'

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])
const MAX_RELATIONS_PER_KEY = 256

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0
}

function extension(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? '' : path.slice(dot).toLowerCase()
}

function commonJsExportName(node: ts.BinaryExpression, path: string): string | undefined {
  if (!['.js', '.cjs'].includes(extension(path)) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isPropertyAccessExpression(node.left)) return undefined
  const property = node.left
  const directExports = ts.isIdentifier(property.expression) && property.expression.text === 'exports'
  const moduleExports = ts.isPropertyAccessExpression(property.expression)
    && ts.isIdentifier(property.expression.expression)
    && property.expression.expression.text === 'module'
    && property.expression.name.text === 'exports'
  if (!directExports && !moduleExports) return undefined
  return property.name.text.slice(0, 512)
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extension(path)) {
    case '.tsx': return ts.ScriptKind.TSX
    case '.jsx': return ts.ScriptKind.JSX
    case '.js': return ts.ScriptKind.JS
    case '.mjs': return ts.ScriptKind.JS
    case '.cjs': return ts.ScriptKind.JS
    case '.mts': return ts.ScriptKind.TS
    case '.cts': return ts.ScriptKind.TS
    default: return ts.ScriptKind.TS
  }
}

function hasExportModifier(node: ts.Node): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
}

function declarationIsExported(node: ts.Node): boolean {
  if (hasExportModifier(node)) return true
  const parent = node.parent
  return !!parent && ts.isVariableStatement(parent) && hasExportModifier(parent)
}

function declarationName(node: ts.NamedDeclaration): string | undefined {
  if (!node.name) return undefined
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) return node.name.text
  return undefined
}

function position(sourceFile: ts.SourceFile, offset: number): { readonly line: number; readonly column: number } {
  const result = sourceFile.getLineAndCharacterOfPosition(Math.max(0, Math.min(offset, sourceFile.text.length)))
  return { line: result.line + 1, column: result.character }
}

function symbolId(snapshotId: string, path: string, kind: string, name: string, start: { readonly line: number; readonly column: number }, end: { readonly line: number; readonly column: number }, container: string | undefined): string {
  return sha256Utf8(canonicalJson([snapshotId, path, kind, name, start, end, container ?? null]))
}

function moduleText(node: ts.StringLiteralLike): string {
  return node.text.slice(0, 512)
}

function addRelation(relations: Map<string, InternalSymbolRelationV1[]>, key: string, relation: InternalSymbolRelationV1): void {
  const values = relations.get(key) ?? []
  if (values.length >= MAX_RELATIONS_PER_KEY) return
  if (values.some(value => value.kind === relation.kind && value.targetName === relation.targetName && value.targetPath === relation.targetPath)) return
  values.push(Object.freeze(relation))
  relations.set(key, values)
}

function relationTarget(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

type FileExtraction = {
  readonly entries: InternalSymbolEntryV1[]
  readonly relations: Map<string, InternalSymbolRelationV1[]>
}

function extractFile(snapshotId: string, path: string, sourceHash: string, source: string): FileExtraction {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path))
  const entries: InternalSymbolEntryV1[] = []
  const relations = new Map<string, InternalSymbolRelationV1[]>()
  const emitted = new Map<string, InternalSymbolEntryV1>()

  const addEntry = (node: ts.Node, kind: string, name: string, container: string | undefined, force = false): InternalSymbolEntryV1 | undefined => {
    if (!force && !container && !declarationIsExported(node)) return undefined
    const start = position(sourceFile, node.getStart(sourceFile))
    const end = position(sourceFile, node.end)
    const dedupeKey = `${path}\u0000${kind}\u0000${name}\u0000${container ?? ''}`
    const existing = emitted.get(dedupeKey)
    if (existing) return existing
    const entry = Object.freeze({
      symbolId: symbolId(snapshotId, path, kind, name, start, end, container),
      path,
      sourceHash,
      start: Object.freeze(start),
      end: Object.freeze(end),
      kind,
      name,
      ...(container ? { container } : {}),
      score: 0,
    })
    emitted.set(dedupeKey, entry)
    entries.push(entry)
    return entry
  }

  const visit = (node: ts.Node, container: string | undefined, containerEntry: InternalSymbolEntryV1 | undefined): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) addRelation(relations, `file:${path}`, { kind: 'imports', targetName: moduleText(node.moduleSpecifier) })
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) addRelation(relations, `file:${path}`, { kind: 'exports', targetName: moduleText(node.moduleSpecifier) })
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) addRelation(relations, `file:${path}`, { kind: 'exports', targetName: element.name.text.slice(0, 512) })
      }
    } else if (ts.isExportAssignment(node)) {
      addRelation(relations, `file:${path}`, { kind: 'exports', targetName: 'default' })
    } else if (ts.isBinaryExpression(node)) {
      const name = commonJsExportName(node, path)
      if (name) {
        addEntry(node, 'variable', name, undefined, true)
        addRelation(relations, `file:${path}`, { kind: 'exports', targetName: name })
      }
    } else if (ts.isCallExpression(node)) {
      const targetName = relationTarget(node.expression)
      if (targetName) addRelation(relations, `file:${path}`, { kind: 'calls', targetName: targetName.slice(0, 512) })
    }

    let nextContainer = container
    let nextContainerEntry = containerEntry
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = declarationName(node)
      const entry = name ? addEntry(node, 'class', name, container) : undefined
      if (entry) {
        nextContainer = container ? `${container}.${name}` : name
        nextContainerEntry = entry
        if (containerEntry) addRelation(relations, containerEntry.symbolId, { kind: 'contains', targetName: name! })
      }
    } else if (ts.isFunctionDeclaration(node)) {
      const name = declarationName(node)
      const entry = name ? addEntry(node, 'function', name, container) : undefined
      if (entry) {
        nextContainer = container ? `${container}.${name}` : name
        nextContainerEntry = entry
        if (containerEntry) addRelation(relations, containerEntry.symbolId, { kind: 'contains', targetName: name! })
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      const name = declarationName(node)
      const entry = name ? addEntry(node, 'interface', name, container) : undefined
      if (entry && containerEntry) addRelation(relations, containerEntry.symbolId, { kind: 'contains', targetName: name! })
    } else if (ts.isTypeAliasDeclaration(node)) {
      const name = declarationName(node)
      const entry = name ? addEntry(node, 'type', name, container) : undefined
      if (entry && containerEntry) addRelation(relations, containerEntry.symbolId, { kind: 'contains', targetName: name! })
    } else if (ts.isEnumDeclaration(node)) {
      const name = declarationName(node)
      const entry = name ? addEntry(node, 'enum', name, container) : undefined
      if (entry && containerEntry) addRelation(relations, containerEntry.symbolId, { kind: 'contains', targetName: name! })
    } else if (ts.isVariableStatement(node)) {
      const exported = declarationIsExported(node)
      for (const declaration of node.declarationList.declarations) {
        const name = declarationName(declaration)
        if (!name) continue
        const entry = addEntry(declaration, 'variable', name, container, exported || !!container)
        if (entry && containerEntry) addRelation(relations, containerEntry.symbolId, { kind: 'contains', targetName: name })
      }
    } else if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const name = declarationName(node)
      const entry = name && containerEntry ? addEntry(node, 'method', name, container, true) : undefined
      if (entry && containerEntry) {
        addRelation(relations, containerEntry.symbolId, { kind: 'contains', targetName: name! })
        nextContainer = container ? `${container}.${name}` : name
        nextContainerEntry = entry
      }
    } else if (ts.isModuleDeclaration(node)) {
      const name = declarationName(node)
      const entry = name ? addEntry(node, 'namespace', name, container) : undefined
      if (entry) {
        nextContainer = container ? `${container}.${name}` : name
        nextContainerEntry = entry
      }
    }

    ts.forEachChild(node, child => visit(child, nextContainer, nextContainerEntry))
  }

  visit(sourceFile, undefined, undefined)
  return { entries, relations }
}

export async function extractFallbackSymbols(store: RepositorySnapshotStore): Promise<SymbolAdapterResultV1> {
  const snapshot = store.snapshot
  const entries: InternalSymbolEntryV1[] = []
  const relations = new Map<string, InternalSymbolRelationV1[]>()
  for (const file of snapshot.files) {
    if (!SUPPORTED_EXTENSIONS.has(extension(file.path))) continue
    const source = await store.readVerifiedFile(file.path, file.contentHash)
    const result = extractFile(snapshot.snapshotId, file.path, file.contentHash, source)
    entries.push(...result.entries)
    for (const [key, values] of result.relations) {
      for (const relation of values) addRelation(relations, key, relation)
    }
  }
  entries.sort((first, second) => compareText(first.path, second.path) || first.start.line - second.start.line || first.start.column - second.start.column || compareText(first.kind, second.kind) || compareText(first.name, second.name) || compareText(first.symbolId, second.symbolId))
  const frozenRelations: Record<string, readonly InternalSymbolRelationV1[]> = {}
  for (const key of [...relations.keys()].sort()) frozenRelations[key] = Object.freeze([...relations.get(key)!])
  const result = Object.freeze({
    adapterId: 'typescript-ast-fallback',
    adapterVersion: 'typescript-5.9.3',
    entries: Object.freeze(entries),
    relations: Object.freeze(frozenRelations),
  })
  bindAdapterSnapshot(result, snapshot)
  return result
}
