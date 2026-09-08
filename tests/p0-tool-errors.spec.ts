import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HarnessError, ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime, { defineTool, type ToolDefinition, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { OUTPUT_POLICY_P0, parseCodeIntelligenceFailureP0 } from '@han_05/dsh-context'
import { CodeIntelligenceErrorP0, registerCodeIntelligenceToolsP0 } from '../src/p0-tool-errors.ts'

const currentSnapshotId = `sha256:${'a'.repeat(64)}`
const stale = (id = currentSnapshotId) => new CodeIntelligenceErrorP0({
  code: 'stale-snapshot', message: 'Snapshot is no longer current.', details: { currentSnapshotId: id },
})
const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function registry() {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() { return () => {} }, section() { return () => {} } } as never)
  const runtime = await ctx.plugin(ToolRuntime)
  cleanup.push(() => runtime.dispose())
  return ctx
}

function fixture(execute: (args: { query: string }, exec: ToolRunContext) => Promise<string>, name = 'p0_query'): ToolDefinition {
  return defineTool({
    name, description: 'Native failure bridge fixture', parameters: { query: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute,
  })
}
function mount(ctx: Context, ...definitions: ToolDefinition[]) {
  const dispose = registerCodeIntelligenceToolsP0(ctx, definitions)
  cleanup.push(dispose)
  return dispose
}
function call(ctx: Context, args: unknown = { query: 'stale' }, callId = 'same-id', signal = new AbortController().signal, name = 'p0_query') {
  return ctx.tools.execute({ callId: ToolCallId(callId), name, arguments: args, signal })
}
function dtoOf(result: ToolExecutionResult) {
  expect(result.isError).toBe(true)
  expect(result).not.toHaveProperty('value')
  const meta = result.meta as { codeIntelligenceFailure: unknown }
  const dto = parseCodeIntelligenceFailureP0(meta.codeIntelligenceFailure)
  expect(result.error).toEqual({ message: dto.message, info: { name: 'CodeIntelligenceErrorP0', code: dto.code } })
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(dto) }])
  expect(parseCodeIntelligenceFailureP0(JSON.parse((result.content[0] as { text: string }).text))).toEqual(dto)
  return dto
}
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('P0 native ToolRuntime failure bridge', () => {
  it('maps defineTool prevalidation without entering body; restores exact shared DTO after content-only post transforms', async () => {
    const ctx = await registry()
    const body = vi.fn(async ({ query }: { query: string }) => {
      if (query === 'invalid') throw new CodeIntelligenceErrorP0({ code: 'invalid-query', message: 'Unsupported query combination.' })
      throw stale()
    })
    const render = vi.fn(() => [{ type: 'text' as const, text: 'success' }])
    const tool = fixture(body)
    mount(ctx, { ...tool, output: { ...tool.output, render } })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      await next()
      return { kind: 'accept', content: [{ type: 'text', text: 'presentation preview' }] }
    })
    const seen: Readonly<ToolExecutionResult>[] = []
    ctx.on('tools/result', (_exec, result) => { seen.push(result) })
    expect(dtoOf(await call(ctx, {})).code).toBe('invalid-query')
    const invalid = await call(ctx, { query: { privateUnboundedInput: 'x'.repeat(10_000) } })
    expect(body).not.toHaveBeenCalled()
    expect(dtoOf(invalid)).toEqual({ code: 'invalid-query', message: 'Invalid code-intelligence query arguments.' })
    expect(Buffer.byteLength(invalid.error!.message)).toBeLessThanOrEqual(OUTPUT_POLICY_P0.maxFailureMessageBytes)
    expect(dtoOf(await call(ctx, { query: 'invalid' })).code).toBe('invalid-query')
    const result = await call(ctx)
    expect(dtoOf(result).details?.currentSnapshotId).toBe(currentSnapshotId)
    expect(render).not.toHaveBeenCalled()
    expect(seen[1]).toBe(invalid)
    expect(seen.at(-1)).toBe(result)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.meta)).toBe(true)
  })

  it('projects actual registry failures through public Session tool/result events and deriveMessages/replay', async () => {
    const ctx = await registry()
    mount(ctx, fixture(async () => { throw stale() }))
    const session = Session.create(SessionId('f2-native-projection'))
    for (const [index, args] of [{}, { query: 'old' }].entries()) {
      const callId = ToolCallId(`projection-${index}`)
      const result = await call(ctx, args, callId)
      const dto = dtoOf(result)
      expect(dto.code).toBe(index === 0 ? 'invalid-query' : 'stale-snapshot')
      // Explicit public session projection fixture, NOT a copied AgentLoop helper.
      // Native host consumption of result.content is the audited boundary.
      const event = session.append('tool/result', {
        turn: 0, step: index,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        error: result.error?.info, meta: result.meta,
      }, { surfaceOp: 'append' })
      expect(event.data.meta).toEqual(result.meta)
      const message = session.deriveMessages().at(-1)!
      expect(message).toEqual(event.data.message)
      const block = message.content[0]
      expect(block).toMatchObject({ type: 'tool-result', isError: true, content: result.content })
      if (block.type !== 'tool-result') throw new Error('Expected public tool-result block')
      expect(parseCodeIntelligenceFailureP0(JSON.parse((block.content[0] as { text: string }).text))).toEqual(dto)
    }
    const replay = Session.create(SessionId('f2-replay'), session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
  })

  it.each([
    ['unknown', new Error('unexpected')],
    ['type', new TypeError('not a business error')],
    ['range', new RangeError('not a query classification')],
    ['timeout', new HarnessError('time budget expired', 'TOOL_TIMEOUT')],
    ['closed', new HarnessError('closed', 'SESSION_CLOSED')],
    ['overload', new HarnessError('busy', 'TOOL_OVERLOADED')],
    ['unbranded', Object.assign(new Error('forged'), { code: 'invalid-query' })],
  ])('leaves %s exceptions identical to undecorated registry behavior', async (_label, error) => {
    const ctx = await registry()
    const body = async () => { throw error }
    mount(ctx, fixture(body))
    ctx.tools.register(fixture(body, 'plain'))
    const actual = await call(ctx)
    const expected = await call(ctx, { query: 'stale' }, 'plain-call', undefined, 'plain')
    expect(actual).toEqual(expected)
    expect(actual.meta).toBeUndefined()
  })

  it('preserves success, output-schema failures and output-render errors', async () => {
    const ctx = await registry()
    const tool = fixture(async ({ query }) => query === 'bad-output' ? 123 as never : query)
    const definition = { ...tool, output: { ...tool.output, render: (_args: unknown, value: unknown) => {
      if (value === 'render-error') throw new Error('output rendering failed')
      return [{ type: 'text' as const, text: String(value) }]
    } } }
    mount(ctx, definition)
    const plain = await registry()
    plain.tools.register(definition)
    for (const query of ['success', 'bad-output', 'render-error']) {
      const result = await call(ctx, { query })
      expect(result).toEqual(await call(plain, { query }))
      expect(result.meta).toBeUndefined()
      if (query === 'bad-output') expect(result.error?.info?.code).toBe('INVALID_TOOL_OUTPUT')
    }
  })

  it('does not replace pre-policy denial/throw or pre-dispatch cancellation', async () => {
    const ctx = await registry()
    const body = vi.fn(async () => { throw stale() })
    mount(ctx, fixture(body))
    const deny = ctx.on('tools/pre-execute', async (_exec, next) => { await next(); return { kind: 'deny', reason: 'blocked by policy' } })
    const result = await call(ctx)
    expect(result).toMatchObject({ isError: true, error: { message: 'blocked by policy' } })
    expect(result.meta).toBeUndefined()
    deny()
    const throwing = ctx.on('tools/pre-execute', async () => { throw new Error('pre-policy error') })
    expect(await call(ctx)).toMatchObject({ isError: true, error: { message: 'pre-policy error' } })
    throwing()
    const controller = new AbortController()
    controller.abort()
    const aborted = await call(ctx, {}, 'aborted', controller.signal)
    expect(aborted.isError).toBe(true)
    expect(aborted.meta).toBeUndefined()
    expect(body).not.toHaveBeenCalled()
  })

  it.each(['block', 'throw', 'timeout', 'foreign-meta'])('does not resurrect a captured DTO after %s replacement', async mode => {
    const ctx = await registry()
    mount(ctx, fixture(async () => { throw stale() }))
    if (mode === 'timeout' || mode === 'foreign-meta') {
      ctx.on('tools/execute', async (_exec, next) => {
        const result = await next()
        return mode === 'timeout'
          ? { isError: true, error: { message: 'deadline', info: { name: 'HarnessError', code: 'TOOL_TIMEOUT' } }, content: [{ type: 'text', text: 'deadline' }] }
          : { ...result, meta: { codeIntelligenceFailure: { nonsense: true } }, content: [{ type: 'text', text: 'authoritative replacement' }] }
      }, { prepend: true })
    } else {
      ctx.on('tools/post-execute', async (_exec, _result, next) => {
        await next()
        if (mode === 'throw') throw new Error('policy failure')
        return { kind: 'block', feedback: [{ type: 'text', text: 'policy block' }] }
      })
    }
    const result = await call(ctx)
    expect(result.isError).toBe(true)
    expect(result.content).not.toEqual([{ type: 'text', text: JSON.stringify(stale().failure) }])
    if (mode !== 'foreign-meta') expect(result.meta).toBeUndefined()
    if (mode === 'block') expect(result.error?.message).toBe('policy block')
  })

  it('isolates concurrent duplicate callIds and retry attempts with distinct snapshot details', async () => {
    const ctx = await registry()
    const entered = gate(), release = gate()
    let count = 0
    mount(ctx, fixture(async ({ query }) => {
      if (query === 'first') { entered.resolve(); await release.promise }
      if (query === 'retry' && count++ > 0) throw new Error('second attempt is unknown')
      throw stale(`sha256:${(query === 'first' ? 'b' : 'c').repeat(64)}`)
    }))
    const first = call(ctx, { query: 'first' })
    await entered.promise
    const second = await call(ctx, { query: 'second' })
    release.resolve()
    expect(dtoOf(await first).details?.currentSnapshotId).toBe(`sha256:${'b'.repeat(64)}`)
    expect(dtoOf(second).details?.currentSnapshotId).toBe(`sha256:${'c'.repeat(64)}`)
    ctx.on('tools/execute', async (exec, next) => {
      const result = await next()
      return (exec.arguments as { query: string }).query === 'retry' ? next() : result
    })
    const retried = await call(ctx, { query: 'retry' })
    expect(retried).toMatchObject({ isError: true, error: { message: 'second attempt is unknown' } })
    expect(retried.meta).toBeUndefined()
  })

  it('ignores unowned definitions even for recognized business/ToolArgsError failures and same-name replacements', async () => {
    const ctx = await registry()
    const dispose = mount(ctx, fixture(async () => { throw stale() }))
    ctx.tools.register(fixture(async () => { throw stale() }, 'foreign'))
    for (const args of [{}, { query: 'stale' }]) {
      const result = await call(ctx, args, 'same-id', undefined, 'foreign')
      expect(result.meta).toBeUndefined()
      expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/^Error:/) })
    }
    dtoOf(await call(ctx))
    await dispose()
    ctx.tools.register(fixture(async () => { throw stale() }))
    expect((await call(ctx)).meta).toBeUndefined()
  })

  it('clears captures on disposal during a pending call and supports clean remount', async () => {
    const ctx = await registry()
    const entered = gate(), release = gate()
    const dispose = mount(ctx, fixture(async () => { entered.resolve(); await release.promise; throw stale() }))
    const pending = call(ctx)
    await entered.promise
    await dispose()
    release.resolve()
    const old = await pending
    expect(old.meta).toBeUndefined()
    expect(old.content[0]).toMatchObject({ text: expect.stringMatching(/^Error:/) })
    mount(ctx, fixture(async () => { throw stale(`sha256:${'d'.repeat(64)}`) }))
    expect(dtoOf(await call(ctx)).details?.currentSnapshotId).toBe(`sha256:${'d'.repeat(64)}`)
  })

  it('cleans up on final result, preserves other metadata and delegates an existing total finalizer', async () => {
    const ctx = await registry()
    let execution: Readonly<ToolRunContext> | undefined
    const previousFinalizer = vi.fn(() => undefined)
    const definition = fixture(async (_args, exec) => { execution = exec; throw stale() })
    mount(ctx, { ...definition, finalizeContent: previousFinalizer })
    ctx.on('tools/execute', async (_exec, next) => {
      const result = await next()
      return { ...result, meta: { otherPlugin: { retained: true } } }
    })
    const result = await call(ctx)
    dtoOf(result)
    expect(result.meta).toMatchObject({ otherPlugin: { retained: true } })
    expect(previousFinalizer).not.toHaveBeenCalled()
    const finalizer = ctx.tools.get('p0_query')!.finalizeContent!
    // tools/result has run: a later callback cannot recover this token's DTO.
    expect(finalizer(execution!, result)).toBeUndefined()
    expect(previousFinalizer).toHaveBeenCalledOnce()
    expect(finalizer(execution!, { ...result, meta: { codeIntelligenceFailure: null } })).toBeUndefined()
  })

  it('preserves cooperative in-flight cancellation exactly like the undecorated registry', async () => {
    const ctx = await registry()
    const entered = gate()
    const body = async (_args: { query: string }, exec: ToolRunContext) => {
      entered.resolve()
      await new Promise<void>(resolve => exec.signal.addEventListener('abort', () => resolve(), { once: true }))
      exec.signal.throwIfAborted()
      return 'unreachable'
    }
    mount(ctx, fixture(body))
    const controller = new AbortController()
    const pending = call(ctx, { query: 'wait' }, 'cancel', controller.signal)
    await entered.promise
    controller.abort(new HarnessError('cancelled by caller', 'TOOL_ABORTED'))
    const result = await pending
    expect(result).toMatchObject({ isError: true, error: { message: 'cancelled by caller', info: { code: 'TOOL_ABORTED' } } })
    expect(result.meta).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'Error: cancelled by caller' }])
  })

  it('does not keep a previous retry DTO when the latest attempt succeeds or has the same routing without the recognized class', async () => {
    for (const last of ['success', 'unrecognized']) {
      const ctx = await registry()
      let count = 0
      mount(ctx, fixture(async () => {
        if (count++ === 0) throw stale()
        if (last === 'success') return 'recovered'
        const error = new HarnessError(stale().message, 'stale-snapshot')
        error.name = 'CodeIntelligenceErrorP0'
        throw error
      }))
      ctx.on('tools/execute', async (_exec, next) => { await next(); return next() }, { prepend: true })
      const result = await call(ctx)
      expect(result.isError).toBe(last !== 'success')
      expect(result.meta).toBeUndefined()
      expect(result.content).toEqual([{ type: 'text', text: last === 'success' ? 'recovered' : `Error: ${stale().message}` }])
    }
  })

  it('wraps an already installed retry policy and projects only the latest recognized business attempt', async () => {
    const ctx = await registry()
    // Installed Cordis consumes waterfall listeners; the bridge must prepend
    // outside this retry so its single continuation sees the final attempt.
    ctx.on('tools/execute', async (_exec, next) => { await next(); return next() })
    let count = 0
    const body = vi.fn(async () => { throw stale(`sha256:${(count++ === 0 ? 'b' : 'c').repeat(64)}`) })
    mount(ctx, fixture(body))
    const result = await call(ctx)
    expect(body).toHaveBeenCalledTimes(2)
    expect(dtoOf(result).details?.currentSnapshotId).toBe(`sha256:${'c'.repeat(64)}`)
  })

  it('owns hooks and definitions through plugin unload, including an already captured post-policy wait', async () => {
    const ctx = await registry()
    const entered = gate(), release = gate()
    const fiber = await ctx.plugin({
      inject: ['tools'],
      apply(owned: Context) {
        registerCodeIntelligenceToolsP0(owned, [fixture(async () => { throw stale() })])
      },
    })
    cleanup.push(() => fiber.dispose())
    const stopPost = ctx.on('tools/post-execute', async (_exec, result, next) => {
      await next()
      expect(result.meta).toBeDefined()
      entered.resolve()
      await release.promise
      return { kind: 'accept', content: [{ type: 'text', text: 'post-policy authoritative content' }] }
    })
    const pending = call(ctx)
    await entered.promise
    await fiber.dispose()
    expect(ctx.tools.get('p0_query')).toBeUndefined()
    release.resolve()
    const result = await pending
    expect(result.content).toEqual([{ type: 'text', text: 'post-policy authoritative content' }])
    // Already-produced registry fields are not revoked on unload, but the
    // snapshotted finalizer must not resurrect the disposed attempt's content.
    stopPost()
    ctx.tools.register(fixture(async () => { throw stale() }))
    expect((await call(ctx)).meta).toBeUndefined()
  })

  it('validates/bounds and freezes caller-owned DTO copies without accepting arbitrary errors', () => {
    const input = { code: 'stale-snapshot' as const, message: 'old', details: { currentSnapshotId } }
    const error = new CodeIntelligenceErrorP0(input)
    input.details.currentSnapshotId = `sha256:${'b'.repeat(64)}`
    expect(error.failure.details?.currentSnapshotId).toBe(currentSnapshotId)
    expect(Object.isFrozen(error.failure.details)).toBe(true)
    expect(error).toBeInstanceOf(HarnessError)
    expect(() => new CodeIntelligenceErrorP0({ code: 'stale-snapshot', message: 'old' })).toThrow(TypeError)
    expect(() => new CodeIntelligenceErrorP0({ code: 'invalid-query', message: 'x'.repeat(OUTPUT_POLICY_P0.maxFailureMessageBytes + 1) })).toThrow(TypeError)
    expect(() => new CodeIntelligenceErrorP0({ code: 'invalid-query', message: 'invalid', details: { reason: 'secret'.repeat(1000) as never } })).toThrow(TypeError)
  })
})
