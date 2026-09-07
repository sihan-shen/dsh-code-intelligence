export const SNAPSHOT_SCHEMA_VERSION = 1 as const
export const SNAPSHOT_POLICY_VERSION = 'dsh-snapshot-v1' as const
export const MAX_FILE_BYTES = 1_048_576
export const MAX_FILES = 10_000
export const MAX_TOTAL_BYTES = 67_108_864
export const MAX_DIRECTORIES = 20_000
export const MAX_IGNORE_BYTES = 262_144
export const MAX_IGNORE_PATTERNS = 4_096

export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
export const PROJECTION_POLICY_VERSION = 'dsh-projection-v1' as const
export const MAX_OUTPUT_BYTES = 65_536
export const MAX_CURSOR_BYTES = 1_024
