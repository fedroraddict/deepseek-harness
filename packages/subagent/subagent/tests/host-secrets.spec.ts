/** External model delegation must not bypass host-secret exclusions. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { protectHostSecretDirectory } from '@deepseek-ai/dsh-sandbox'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Subagents, { NO_START_CAPABILITIES } from '../src/index.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

it('rejects an external provider before it can start a child model process', async () => {
  const ctx = new Context()
  const vault = await mkdtemp(join(tmpdir(), 'dsh-subagent-secrets-'))
  const start = vi.fn(async () => { throw new Error('unsafe child launch attempted') })
  try {
    protectHostSecretDirectory(ctx, vault)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(Subagents)
    const parent = await externalTestParent(ctx)
    ctx.subagents.registerProvider({ name: 'external', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false, start })
    await expect(ctx.subagents.startActivation({
      provider: 'external', label: 'synthetic child', delivery: 'caller', signal: new AbortController().signal,
      request: { parent, prompt: [{ type: 'text', text: 'read a protected file' }] },
    })).rejects.toThrow(/host-secret exclusions/)
    expect(start).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    await rm(vault, { recursive: true, force: true })
  }
})
