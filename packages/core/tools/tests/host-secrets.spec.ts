/** Failed custody setup cannot leave a callable model tool behind. */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { protectHostSecretDirectory } from '@deepseek-ai/dsh-sandbox'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { expect, it, vi } from 'vitest'
import Tools, { defineContentToolFixture } from '../src/index.ts'

it('returns an error before the tool body after protection setup fails', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const execute = vi.fn(async () => [])
    ctx.tools.register(defineContentToolFixture({ name: 'synthetic', description: 'Synthetic body', parameters: {}, execute }))
    expect(() => protectHostSecretDirectory(ctx, 'relative')).toThrow(/absolute/)
    const result = await ctx.tools.execute({
      callId: ToolCallId('failed-custody'), name: 'synthetic', arguments: {}, signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
  }
})
