/** Search routes its ordinary foreground process through mandatory custody policy. */
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider, protectHostSecretDirectory } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runRipgrep } from '../src/search-core.ts'

class Sandbox extends SandboxProvider {
  policy: SandboxPolicy | undefined
  async confine(argv: readonly string[], policy: SandboxPolicy) {
    this.policy = policy
    return { argv: ['guarded', ...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }
  }
}

class Processes extends SubprocessRuntime {
  spec: SubprocessSpawnSpec | undefined
  async resolveExecutable(command: string) { return command }
  async terminalEnvironment() { return { platform: 'posix' as const } }
  async spawnTerminal(): Promise<never> { throw new Error('unused terminal') }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spec = spec
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: 'safe output', nextOffset: 11, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true,
    }
  }
}

it('uses a read-only guarded argv when the application has protected directories', async () => {
  const ctx = new Context()
  const vault = await mkdtemp(join(tmpdir(), 'dsh-search-secret-'))
  try {
    protectHostSecretDirectory(ctx, vault)
    await ctx.plugin(Sandbox)
    await ctx.plugin(Processes)
    const result = await runRipgrep(ctx, { signal: new AbortController().signal }, 'grep', ['safe', 'safe.txt'], 1024, 1000, 1024)
    expect(result.stdout).toBe('safe output')
    expect((ctx.sandbox as Sandbox).policy?.mode).toBe('read-only')
    expect((ctx.subprocess as Processes).spec?.argv[0]).toBe('guarded')
  } finally {
    await ctx.fiber.dispose()
    await rm(vault, { recursive: true, force: true })
  }
})
