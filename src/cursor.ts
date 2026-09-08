import { canonicalJson, sha256Utf8 } from '@han_05/dsh-context'
import { MAX_CURSOR_BYTES, PROJECTION_POLICY_VERSION } from './constants.js'

export type ProjectionCursorKind = 'repo-map' | 'symbol-query'

export type ProjectionCursorPayload = {
  readonly schemaVersion: 1
  readonly kind: ProjectionCursorKind
  readonly snapshotId: string
  readonly queryHash: string
  readonly offset: number
  readonly limit: number
  readonly policyVersion: typeof PROJECTION_POLICY_VERSION
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decodeBase64url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('cursor encoding is invalid')
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  if (base64url(decoded) !== value) throw new TypeError('cursor encoding is not canonical')
  return decoded
}

function exactPayload(value: unknown): ProjectionCursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('cursor payload must be an object')
  const object = value as Record<string, unknown>
  const keys = ['schemaVersion', 'kind', 'snapshotId', 'queryHash', 'offset', 'limit', 'policyVersion']
  if (Object.keys(object).some(key => !keys.includes(key)) || keys.some(key => !Object.prototype.hasOwnProperty.call(object, key))) throw new TypeError('cursor payload fields are invalid')
  if (object.schemaVersion !== 1 || (object.kind !== 'repo-map' && object.kind !== 'symbol-query') || object.policyVersion !== PROJECTION_POLICY_VERSION) throw new TypeError('cursor payload policy is invalid')
  if (typeof object.snapshotId !== 'string' || typeof object.queryHash !== 'string' || !Number.isSafeInteger(object.offset) || (object.offset as number) < 0 || !Number.isSafeInteger(object.limit) || (object.limit as number) < 1 || (object.limit as number) > 50) throw new TypeError('cursor payload values are invalid')
  return object as ProjectionCursorPayload
}

export function encodeProjectionCursor(payload: ProjectionCursorPayload): string {
  const parsed = exactPayload(payload)
  const json = canonicalJson(parsed)
  const token = `${base64url(json)}.${base64url(sha256Utf8(json))}`
  if (new TextEncoder().encode(token).byteLength > MAX_CURSOR_BYTES) throw new RangeError('cursor exceeds byte budget')
  return token
}

export function decodeProjectionCursor(token: string): ProjectionCursorPayload {
  if (typeof token !== 'string' || new TextEncoder().encode(token).byteLength > MAX_CURSOR_BYTES) throw new TypeError('cursor exceeds byte budget')
  const pieces = token.split('.')
  if (pieces.length !== 2) throw new TypeError('cursor format is invalid')
  const payloadJson = decodeBase64url(pieces[0]!)
  const suppliedDigest = decodeBase64url(pieces[1]!)
  const actualDigest = sha256Utf8(payloadJson)
  if (suppliedDigest !== actualDigest) throw new TypeError('cursor digest is invalid')
  let decoded: unknown
  try { decoded = JSON.parse(payloadJson) } catch { throw new TypeError('cursor payload is invalid') }
  if (canonicalJson(decoded) !== payloadJson) throw new TypeError('cursor payload is not canonical')
  return exactPayload(decoded)
}
