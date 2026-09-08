import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { ToolArgsError, type ToolDefinition, type ToolExecutionResult, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { parseCodeIntelligenceFailureP0, type CodeIntelligenceFailureP0 } from '@han_05/dsh-context'

/** Caller-safe business errors only. Translate known shared-parser errors at the caller;
 * arbitrary TypeError/RangeError and host control-flow errors are not business failures. */
export class CodeIntelligenceErrorP0 extends HarnessError {
  readonly failure: CodeIntelligenceFailureP0

  constructor(failure: CodeIntelligenceFailureP0) {
    const dto = parseCodeIntelligenceFailureP0(failure)
    super(dto.message, dto.code)
    this.name = 'CodeIntelligenceErrorP0'
    if (dto.details) Object.freeze(dto.details)
    this.failure = Object.freeze(dto)
  }
}

export const CODE_INTELLIGENCE_FAILURE_META_P0 = 'codeIntelligenceFailure' as const
const invalidArguments = new CodeIntelligenceErrorP0({
  code: 'invalid-query', message: 'Invalid code-intelligence query arguments.',
}).failure

type Attempt = {
  expected?: { name: string; code: string; message: string }
  failure?: CodeIntelligenceFailureP0
  projected?: string
}

function matches(result: Readonly<ToolExecutionResult>, expected: Attempt['expected']): boolean {
  return !!expected && result.isError && result.error.info?.name === expected.name
    && result.error.info.code === expected.code && result.error.message === expected.message
}

/** Register a small set of owned definitions and the native failure bridge as one
 * Cordis effect. Decorates OUTSIDE defineTool, so schema prevalidation is captured.
 * Caller plugins must declare `inject: ['tools']` (or use an injected context).
 * This prepended hook must remain outside retry policies: Cordis consumes its
 * waterfall listeners, so a retry's second next() does not re-enter inner hooks.
 * Do not subsequently prepend a retry policy outside this bridge.
 * No default tools are wired here; this does not provide run_code/PTC failures.
 * The returned disposer (also owned by ctx) unregisters everything and clears captures.
 */
export function registerCodeIntelligenceToolsP0(ctx: Context, definitions: readonly ToolDefinition[]): () => Promise<void> {
  return ctx.effect(function* () {
    let active = true
    const attempts = new Map<ToolExecutionToken, Attempt>()
    // Yield first so cleanup also runs if a later registration fails.
    yield () => { active = false; attempts.clear() }
    yield ctx.on('tools/result', exec => { attempts.delete(exec.token) })
    yield ctx.on('tools/execute', async (exec, next) => {
      attempts.delete(exec.token)
      const result = await next()
      const attempt = attempts.get(exec.token)
      if (!active || !attempt?.failure || !matches(result, attempt.expected) || !result.isError) return result
      const dto = attempt.failure
      attempt.projected = JSON.stringify(dto)
      return {
        ...result,
        error: { message: dto.message, info: { name: 'CodeIntelligenceErrorP0', code: dto.code } },
        meta: {
          ...(result.meta && typeof result.meta === 'object' && !Array.isArray(result.meta) ? result.meta : {}),
          [CODE_INTELLIGENCE_FAILURE_META_P0]: { ...dto },
        },
        content: [{ type: 'text', text: attempt.projected }],
      }
    }, { prepend: true })
    for (const definition of definitions) {
      yield ctx.tools.register({
        ...definition,
        async execute(args, exec) {
          const attempt: Attempt = {}
          // Body entry, not a name lookup, proves scoped ownership. A retry gets a
          // fresh record even when the registry token and callId are unchanged.
          if (active) attempts.set(exec.token, attempt)
          try {
            return await definition.execute(args, exec)
          } catch (error) {
            if (active && attempts.get(exec.token) === attempt) {
              if (error instanceof CodeIntelligenceErrorP0) attempt.failure = error.failure
              else if (error instanceof ToolArgsError && error.code === 'INVALID_ARGS') attempt.failure = invalidArguments
              if (attempt.failure && error instanceof HarnessError) {
                attempt.expected = { name: error.name, code: error.code, message: error.message }
              }
            }
            throw error
          }
        },
        finalizeContent(exec, result) {
          const attempt = attempts.get(exec.token)
          // A post-policy replacement must remain authoritative. Only repair
          // content if this attempt's authored DTO AND routing fields survived.
          if (active && attempt?.projected && attempt.failure && matches(result, {
            name: 'CodeIntelligenceErrorP0', code: attempt.failure.code, message: attempt.failure.message,
          })) {
            try {
              const meta = result.meta
              if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
                const dto = parseCodeIntelligenceFailureP0(meta[CODE_INTELLIGENCE_FAILURE_META_P0])
                if (JSON.stringify(dto) === attempt.projected) return [{ type: 'text', text: attempt.projected }]
              }
            } catch { /* Foreign/malformed metadata is not an adapter failure. */ }
          }
          // Preserve any existing definition-owned finalizer, whose public
          // contract likewise requires a synchronous total implementation.
          return definition.finalizeContent?.(exec, result)
        },
      })
    }
  }, 'code-intelligence P0 native failures')
}
