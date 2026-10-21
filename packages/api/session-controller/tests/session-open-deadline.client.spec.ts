/** Opening history waits are bounded without imposing a live-frame deadline. */
import { describe, expect, onTestFinished, vi } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { StreamHandle } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { resolveSessionOpenConfig } from '../src/history-open-config.ts'
import type { SessionFollowRequest } from '../src/types.ts'
import { ev, historyValue, plainTurn } from './event-script.client.ts'
import { sessionBench } from './remote/bench.client.ts'
import { FOLLOW, followScript, followSnapshot, history, pushEvent } from './remote/session.client.ts'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
const SID = 'fk-open-deadline' as SessionId

function useClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })
}

function observeWarning() {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  return warn
}

describe('opening timing resolution', () => {
  it('supplies defaults and preserves explicit overrides', () => {
    expect(resolveSessionOpenConfig()).toEqual({ openWarnMs: 10_000, openTimeoutMs: 30_000 })
    expect(resolveSessionOpenConfig({ openTimeoutMs: 5 })).toEqual({ openWarnMs: 10_000, openTimeoutMs: 5 })
    expect(resolveSessionOpenConfig({ openWarnMs: 3, openTimeoutMs: 9 })).toEqual({ openWarnMs: 3, openTimeoutMs: 9 })
  })

  it.each([0, -1, 0.5, 2_147_483_648, NaN, Infinity])('rejects invalid timer delay %s', (delay) => {
    expect(() => resolveSessionOpenConfig({ openWarnMs: delay })).toThrow()
    expect(() => resolveSessionOpenConfig({ openTimeoutMs: delay })).toThrow()
  })
})

describe('Session opening deadline', () => {
  it('cancels the silent follow at the deadline and permits a fresh open', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID, { open: { openWarnMs: 10, openTimeoutMs: 40 } })
    const warn = observeWarning()
    useClock()
    const entered = Promise.withResolvers<StreamHandle>()
    mock.stream(FOLLOW, (_args, stream) => { entered.resolve(stream) })
    const opening = session.open()
    const abandoned = await entered.promise

    await vi.advanceTimersByTimeAsync(9)
    expect(warn).not.toHaveBeenCalled()
    expect(session.getSnapshot().openState).toBe('loading')
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(29)
    expect(abandoned.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(session.getSnapshot().openState).toBe('error')
    await opening

    expect(abandoned.signal.aborted).toBe(true)
    expect(session.getSnapshot()).toMatchObject({ openState: 'error', openError: { code: 'session/open-timeout' } })
    expect(vi.getTimerCount()).toBe(0)
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(3), 2, 'question', 'answer'))))
    await session.open()
    expect(session.getSnapshot().openState).toBe('open')
    expect(mock.log.requests(FOLLOW)).toHaveLength(2)

    abandoned.push(followSnapshot(historyValue(plainTurn(SessionSeq(10), 9, 'late', 'late')), { address: { kind: 'session', sessionId: SID } }))
    await vi.advanceTimersByTimeAsync(100)
    expect(session.eventSource.getSnapshot().entries.at(-1)?.event.seq).toBe(8)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('warns without failing and clears both timers once the window arrives', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID, { open: { openWarnMs: 10, openTimeoutMs: 40 } })
    const warn = observeWarning()
    useClock()
    const entered = Promise.withResolvers<{ stream: StreamHandle; request: SessionFollowRequest }>()
    mock.stream(FOLLOW, ([request], stream) => { entered.resolve({ stream, request: request as SessionFollowRequest }) })
    const opening = session.open()
    const { stream, request } = await entered.promise
    await vi.advanceTimersByTimeAsync(10)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`session "${SID}"`))
    stream.push(followSnapshot(historyValue(plainTurn(SessionSeq(1), 1, 'question', 'answer')), request))
    await opening
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(100)
    expect(session.getSnapshot().openState).toBe('open')
    await pushEvent(mock, ev.user(SessionSeq(7), 'later'))
    expect(session.eventSource.getSnapshot().entries.at(-1)?.event.seq).toBe(7)
    expect(warn).toHaveBeenCalledOnce()
  })

  for (const openWarnMs of [30, 40]) {
    it(`does not warn when warning delay ${String(openWarnMs)} is at or after the deadline`, async ({ mock, start }) => {
      const session = await sessionBench(mock, start, SID, { open: { openWarnMs, openTimeoutMs: 30 } })
      const warn = observeWarning()
      useClock()
      const entered = Promise.withResolvers<undefined>()
      mock.stream(FOLLOW, () => { entered.resolve(undefined) })
      const opening = session.open()
      await entered.promise
      await vi.advanceTimersByTimeAsync(30)
      await opening
      expect(session.getSnapshot().openState).toBe('error')
      expect(warn).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })
  }

  it('cancels the opening and clears its timers when disposed before the deadline', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID, { open: { openWarnMs: 10, openTimeoutMs: 40 } })
    const warn = observeWarning()
    useClock()
    const entered = Promise.withResolvers<StreamHandle>()
    mock.stream(FOLLOW, (_args, stream) => { entered.resolve(stream) })
    const opening = session.open()
    const stream = await entered.promise
    await session.dispose()
    await opening
    expect(stream.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(warn).not.toHaveBeenCalled()
    expect(session.getSnapshot().openError).toBeNull()
  })
})
