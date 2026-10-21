/** The Client plugin applies opening timing supplied by the served page. */
import { afterEach, describe, expect, onTestFinished, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { FOLLOW, sessionWorld } from './remote/session.client.ts'

const SELF = '@deepseek-ai/dsh-api-session-controller'
const ROSTER = webApp.closure([SELF])
const it = createClientTest({ roster: ROSTER })
const EVENTS = '$events'
const SID = 'fk-page-config' as SessionId

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Deliver one Remote event the way the Host forwards it: an emit frame on the `$events` stream. */
async function emit(mock: RemoteMock, event: string, ...args: unknown[]): Promise<void> {
  mock.streams.push(EVENTS, { type: 'emit', event, args })
  await mock.streams.drained(EVENTS)
}

describe('Session opening timing from the served page', () => {
  it('bounds the open with the page-provided deadline', async ({ mock, start }) => {
    vi.stubGlobal('__DSH_SESSION_OPEN__', { openWarnMs: 10, openTimeoutMs: 40 })
    mock.load(sessionWorld)
    const client = await start()
    const entered = Promise.withResolvers<undefined>()
    mock.stream(FOLLOW, () => { entered.resolve(undefined) })
    await emit(mock, 'api-session/added', { sessionId: SID, updatedAt: 1, running: false, blank: true })

    const sessions = client.ctx.get('sessions')
    if (sessions === undefined) throw new Error('expected the Client Session service')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    const reference = sessions.retain(SID, { source: 'gateway' })
    onTestFinished(() => { reference.release() })
    await entered.promise
    await vi.advanceTimersByTimeAsync(40)
    await reference.ready
    const snapshot = reference.binding.session.getSnapshot()
    expect(snapshot.openState).toBe('error')
    expect(snapshot.openError?.message).toContain('within 40ms')
  })
})
