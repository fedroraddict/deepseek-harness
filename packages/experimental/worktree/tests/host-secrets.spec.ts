/** Full-access worktree subprocesses retain mandatory secret exclusions. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { protectHostSecretDirectory } from '@deepseek-ai/dsh-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, vi } from 'vitest'
import { runCommand } from '../src/process.ts'

it('requires confinement for full-access worktree commands with registered secrets', async () => {
  const ctx = new Context()
  const vault = await mkdtemp(join(tmpdir(), 'dsh-worktree-secrets-'))
  await ctx.plugin(LocalSubprocessRuntime)
  protectHostSecretDirectory(ctx, vault)
  const failure = new Error('mandatory confinement refused')
  ctx.provide('sandbox', { confine: vi.fn().mockRejectedValue(failure) })
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  try {
    await expect(runCommand(ctx, { timeoutMs: 30000, graceMs: 1000, maxOutputBytes: 4096 },
      { mode: 'danger-full-access', workspaceRoot: vault }, vault,
      [process.execPath, '-e', 'process.exit(0)'], new AbortController().signal)).rejects.toBe(failure)
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    await rm(vault, { recursive: true, force: true })
  }
})
