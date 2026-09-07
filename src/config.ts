import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  MAX_DIRECTORIES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_IGNORE_BYTES,
  MAX_TOTAL_BYTES,
} from './constants.js'
import type { LspDeploymentConfigV1, LspDeploymentEnvironmentKey, SnapshotConfigV1 } from './types.js'

const CONFIG_KEYS = ['workspaceRoot', 'deploymentRoot', 'revision', 'maxFileBytes', 'maxFiles', 'maxTotalBytes', 'maxDirectories', 'maxIgnoreBytes', 'nestedCheckoutRoots'] as const
const REQUIRED_CONFIG_KEYS = ['deploymentRoot', 'revision', 'maxFileBytes', 'maxFiles', 'maxTotalBytes', 'maxDirectories', 'maxIgnoreBytes', 'nestedCheckoutRoots'] as const
const LSP_CONFIG_KEYS = ['executable', 'fixedArgs', 'environment', 'timeoutMs', 'maxMessageBytes', 'maxStderrBytes', 'graceMs'] as const
const LSP_ENVIRONMENT_KEYS = ['LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP'] as const

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('snapshot config must be an object')
  return value as Record<string, unknown>
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function boundedInteger(value: unknown, name: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} must be an integer between 1 and ${maximum}`)
  return value
}

function safeRelativePath(value: unknown, name: string): string {
  const path = stringValue(value, name)
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) throw new TypeError(`${name} must be repository-relative`)
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new TypeError(`${name} must not contain traversal or empty path segments`)
  return path
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const expectedSet = new Set(expected)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expectedSet.has(key)) throw new TypeError(`${name}.${String(key)} is not allowed`)
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`${name}.${key} is required`)
  }
}

function allowedKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const expectedSet = new Set(expected)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expectedSet.has(key)) throw new TypeError(`${name}.${String(key)} is not allowed`)
  }
}

function canonicalDirectory(value: unknown, name: string): string {
  const path = stringValue(value, name)
  let canonical: string
  try {
    canonical = realpathSync(path)
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new TypeError(`${name} must be an existing directory`)
  }
  return canonical
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

function containedOrEqual(root: string, candidate: string): boolean {
  return root === candidate || contained(root, candidate)
}

function lspString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\r\n]/u.test(value)) throw new TypeError(`${name} must be a non-empty string without NUL or newline`)
  return value
}

function lspEnvironment(value: unknown): Readonly<Partial<Record<LspDeploymentEnvironmentKey, string>>> {
  const object = record(value)
  allowedKeys(object, LSP_ENVIRONMENT_KEYS, 'environment')
  const environment: Partial<Record<LspDeploymentEnvironmentKey, string>> = {}
  for (const key of LSP_ENVIRONMENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue
    const item = lspString(object[key], `environment.${key}`)
    if (/\p{Cc}/u.test(item)) throw new TypeError(`environment.${key} contains control characters`)
    if ((key === 'TMPDIR' || key === 'TEMP' || key === 'TMP') && !isAbsolute(item)) throw new TypeError(`environment.${key} must be an absolute path`)
    environment[key] = item
  }
  return Object.freeze(environment)
}

function lspLimit(value: unknown, name: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} must be an integer between 1 and ${maximum}`)
  return value
}

export function parseLspDeploymentConfig(value: unknown, snapshotRoot: unknown): LspDeploymentConfigV1 {
  const object = record(value)
  exactKeys(object, LSP_CONFIG_KEYS, 'lsp deployment config')
  const cwd = canonicalDirectory(snapshotRoot, 'snapshotRoot')
  const executableInput = lspString(object.executable, 'executable')
  if (!isAbsolute(executableInput)) throw new TypeError('executable must be an absolute path')
  if (/\s|[;&|<>$`]/u.test(executableInput)) throw new TypeError('executable must not be a shell string')

  let inputStat: ReturnType<typeof lstatSync>
  let canonicalExecutable: string
  try {
    inputStat = lstatSync(executableInput)
    canonicalExecutable = realpathSync(executableInput)
  } catch {
    throw new TypeError('executable must be an existing regular executable file')
  }
  if (inputStat.isSymbolicLink()) throw new TypeError('executable symlinks are not allowed')
  if (!inputStat.isFile()) throw new TypeError('executable must be a regular file')
  if (executableInput !== canonicalExecutable) throw new TypeError('executable must be canonical')
  if (!contained(cwd, canonicalExecutable)) throw new TypeError('executable must be inside the deployment root')
  if ((inputStat.mode & 0o111) === 0) throw new TypeError('executable must have an execute bit')

  const fixedArgsValue = object.fixedArgs
  if (!Array.isArray(fixedArgsValue)) throw new TypeError('fixedArgs must be an array')
  const fixedArgs = fixedArgsValue.map((item, index) => lspString(item, `fixedArgs[${index}]`))

  const config = {
    executable: canonicalExecutable,
    fixedArgs: Object.freeze(fixedArgs),
    environment: lspEnvironment(object.environment),
    cwd,
    timeoutMs: lspLimit(object.timeoutMs, 'timeoutMs', 60_000),
    maxMessageBytes: lspLimit(object.maxMessageBytes, 'maxMessageBytes', 262_144),
    maxStderrBytes: lspLimit(object.maxStderrBytes, 'maxStderrBytes', 65_536),
    graceMs: lspLimit(object.graceMs, 'graceMs', 5_000),
  } satisfies LspDeploymentConfigV1
  return Object.freeze(config)
}

function validateRelativeDeploymentRoot(root: string): void {
  if (root === '.') return
  if (root.includes('\\')) throw new TypeError('relative deploymentRoot must use repository-relative path syntax')
  const parts = root.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new TypeError('relative deploymentRoot must not contain traversal or empty path segments')
  }
}

/** Validate the session-relative snapshot policy before Cordis starts the plugin. */
export function parseCodeIntelligenceConfig(value: unknown): SnapshotConfigV1 {
  const object = record(value)
  const allowed = new Set<string>(CONFIG_KEYS)
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw new TypeError(`unknown snapshot config key: ${key}`)
  for (const key of REQUIRED_CONFIG_KEYS) if (!Object.prototype.hasOwnProperty.call(object, key)) throw new TypeError(`snapshot config requires ${key}`)
  const workspaceRootInput = object.workspaceRoot
  let workspaceRootInputPath: string | undefined
  if (workspaceRootInput !== undefined) {
    const workspacePath = stringValue(workspaceRootInput, 'workspaceRoot')
    if (!isAbsolute(workspacePath)) throw new TypeError('workspaceRoot must be an absolute path')
    workspaceRootInputPath = workspacePath
  }
  const root = stringValue(object.deploymentRoot, 'deploymentRoot')
  if (!isAbsolute(root)) validateRelativeDeploymentRoot(root)
  const nestedCheckoutRoots = object.nestedCheckoutRoots
  if (!Array.isArray(nestedCheckoutRoots)) throw new TypeError('nestedCheckoutRoots must be an array')
  const normalizedNestedRoots = nestedCheckoutRoots.map((item, index) => safeRelativePath(item, `nestedCheckoutRoots[${index}]`))
  if (new Set(normalizedNestedRoots).size !== normalizedNestedRoots.length) throw new TypeError('nestedCheckoutRoots must not contain duplicates')
  const config = {
    ...(workspaceRootInputPath === undefined ? {} : { workspaceRoot: workspaceRootInputPath }),
    deploymentRoot: root,
    revision: stringValue(object.revision, 'revision'),
    maxFileBytes: boundedInteger(object.maxFileBytes, 'maxFileBytes', MAX_FILE_BYTES),
    maxFiles: boundedInteger(object.maxFiles, 'maxFiles', MAX_FILES),
    maxTotalBytes: boundedInteger(object.maxTotalBytes, 'maxTotalBytes', MAX_TOTAL_BYTES),
    maxDirectories: boundedInteger(object.maxDirectories, 'maxDirectories', MAX_DIRECTORIES),
    maxIgnoreBytes: boundedInteger(object.maxIgnoreBytes, 'maxIgnoreBytes', MAX_IGNORE_BYTES),
    nestedCheckoutRoots: normalizedNestedRoots,
  } satisfies SnapshotConfigV1
  return Object.freeze({ ...config, nestedCheckoutRoots: Object.freeze([...config.nestedCheckoutRoots]) })
}

export function parseSnapshotConfig(value: unknown): SnapshotConfigV1 {
  const config = parseCodeIntelligenceConfig(value)
  const workspaceRoot = config.workspaceRoot === undefined
    ? undefined
    : canonicalDirectory(config.workspaceRoot, 'workspaceRoot')
  if (!isAbsolute(config.deploymentRoot) && workspaceRoot === undefined) {
    throw new TypeError('relative deploymentRoot requires an explicit workspaceRoot')
  }
  const rootPath = isAbsolute(config.deploymentRoot)
    ? config.deploymentRoot
    : resolve(workspaceRoot!, config.deploymentRoot)
  const canonicalRoot = canonicalDirectory(rootPath, 'deploymentRoot')
  if (workspaceRoot !== undefined && !containedOrEqual(workspaceRoot, canonicalRoot)) {
    throw new TypeError('deploymentRoot must be inside workspaceRoot')
  }
  return Object.freeze({
    ...config,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    deploymentRoot: canonicalRoot,
  })
}

/** Cordis standard-schema entry for Loader-stage Code Intelligence validation. */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: '@ds-plugins/dsh-code-intelligence',
    validate(value: unknown) {
      try {
        return { value: parseCodeIntelligenceConfig(value) }
      } catch (error) {
        return {
          issues: [{ message: error instanceof Error ? error.message : 'invalid configuration' }],
        }
      }
    },
  },
}
