/** Host opening timing is included in its served-page globals. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionOpenConfig } from '../src/history-open-config.ts'
import { createSessionTestController } from './test-remote.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

/** Structural webServer fake: the Session Controller only needs the service present. */
const fakeWebServer = { register: () => () => {}, tapIndex: () => () => {}, port: 0 } satisfies Partial<WebServer>

async function mounted(open?: SessionOpenConfig): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('webServer', fakeWebServer as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  createSessionTestController(ctx, { ...defaults, ...open === undefined ? {} : { open } })
  return ctx
}

describe('Session opening timing on the served page', () => {
  it('publishes the resolved defaults as a page global', async () => {
    const ctx = await mounted()
    const rows: IndexInjection[] = []
    await vi.waitFor(() => {
      rows.length = 0
      ctx.emit('webserver/index-inject', rows)
      expect(rows.some(row => row.kind === 'global' && row.name === '__DSH_SESSION_OPEN__')).toBe(true)
    })
    expect(rows).toEqual(expect.arrayContaining([{
      kind: 'global',
      name: '__DSH_SESSION_OPEN__',
      value: { openWarnMs: 10_000, openTimeoutMs: 30_000 },
    }]))
  })

  it('publishes deployment overrides verbatim', async () => {
    const ctx = await mounted({ openWarnMs: 2_000, openTimeoutMs: 5_000 })
    const rows: IndexInjection[] = []
    await vi.waitFor(() => {
      rows.length = 0
      ctx.emit('webserver/index-inject', rows)
      expect(rows.some(row => row.kind === 'global' && row.name === '__DSH_SESSION_OPEN__')).toBe(true)
    })
    expect(rows).toEqual(expect.arrayContaining([{
      kind: 'global',
      name: '__DSH_SESSION_OPEN__',
      value: { openWarnMs: 2_000, openTimeoutMs: 5_000 },
    }]))
  })
})
