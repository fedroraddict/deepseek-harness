// @vitest-environment jsdom
/** Built Web Session opening replaces its loading hint with the timed-out error. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { StreamHandle } from '@deepseek-ai/dsh-remote-mock'
import { installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/expected/session-history-open-deadline/history.expected.txt')

installAssembledBootEnv()

describe('assembled Session history opening deadline', () => {
  it('replaces the loading hint with a visible history failure when the follow remains silent', async () => {
    vi.stubGlobal('__DSH_SESSION_OPEN__', { openWarnMs: 40, openTimeoutMs: 40 })
    const { mock } = mountAssembledApp()
    const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
    const historical = await within(tree).findByText('Fixture 历史会话')
    const entered = Promise.withResolvers<StreamHandle>()
    mock.stream('session/follow', (_args, stream) => { entered.resolve(stream) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })

    try {
      await act(async () => {
        fireEvent.click(historical)
        await entered.promise
      })
      const follow = await entered.promise
      const loading = screen.getByText('Loading history…').textContent
      await act(async () => { await vi.advanceTimersByTimeAsync(40) })

      const failure = screen.getByText(/Failed to load history:/).textContent
      expect(screen.queryByText('Loading history…')).toBeNull()
      expect(follow.signal.aborted).toBe(true)
      const output = `opening=${loading ?? '<absent>'}\ntimeout=${failure ?? '<absent>'}\n`
      if (REFRESHING_GOLDEN) {
        mkdirSync(dirname(EXPECTED), { recursive: true })
        writeFileSync(EXPECTED, output)
      }
      await expect(output).toMatchFileSnapshot(EXPECTED)
    } finally {
      vi.useRealTimers()
    }
  })
})
