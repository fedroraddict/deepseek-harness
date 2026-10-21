/** Synthetic credential custody through model execution and legitimate browser authentication. */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { runRipgrep } from '../../../fs/tool-fs-search/src/search-core.ts'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { provideWorkingDirectoryFixture, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Terminals from '@deepseek-ai/dsh-terminal'
import * as TerminalBash from '@deepseek-ai/dsh-terminal-bash'
import { BrowserAuth } from '../../../client/connection/src/browser-auth.ts'
import { mountRuntime } from '../../../ptc-runtime/ptc-runtime-node/tests/setup.ts'
import { PythonPtcRuntime, resolvePythonBin } from '../../../experimental/ptc-runtime-python/src/index.ts'
import { LocalSandboxProvider } from '../src/index.ts'
import { bwrapProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

const probe = process.platform === 'darwin'
  ? spawnSync('sandbox-exec', [...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'])
  : spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'])
const supported = process.platform !== 'win32' && probe.status === 0
const secret = 'synthetic-human-authentication-secret'

async function fixture(base = tmpdir(), alias = false) {
  const root = await mkdtemp(join(base, 'dsh-host-secrets-'))
  const vault = join(root, 'vault')
  await mkdir(vault)
  const configured = alias ? join(root, 'alias') : vault
  if (alias) await symlink(vault, configured, 'dir')
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(LocalSandboxProvider, { secretDirectories: [configured] })
  const filename = join(configured, 'credentials.yaml')
  await ctx.plugin(Credentials, { path: filename, watch: false })
  await ctx.credentials.set(credentialRef('SYNTHETIC_AUTH'), secret)
  await ctx.plugin(Subprocess)
  await ctx.plugin(FileSystem, { cwd: root })
  return { ctx, root, filename }
}

describe.skipIf(!supported)('host secret custody with a real kernel runner', () => {
  it('retains legitimate browser authentication and rejects a fabricated human source', async () => {
    const { ctx, filename } = await fixture()
    const auth = await BrowserAuth.create(ctx, ctx.credentials, 1)
    const url = new URL(auth.authenticatedUrl('http://127.0.0.1:3080'))
    let cookie = ''
    auth.authorizeIndex({ method: 'GET', url: url.pathname + url.search, headers: { host: url.host } }, {
      writeHead(status, headers) {
        expect(status).toBe(303)
        cookie = headers?.['set-cookie']?.split(';')[0] ?? ''
      }, end() {},
    })
    expect(cookie).not.toBe('')
    const reloaded = await BrowserAuth.create({}, ctx.credentials, 1)
    expect(reloaded.isAuthenticated({ headers: { host: url.host, cookie } })).toBe(true)
    expect(reloaded.isAuthenticated({ headers: { host: url.host, cookie: cookie + 'forged', 'source.kind': 'user' } })).toBe(false)
    expect(reloaded.isAuthenticated({ headers: { host: url.host, 'source.kind': 'user' } })).toBe(false)
    expect(await readFile(filename, 'utf8')).toContain(secret)
    await expect(ctx.fs.resolve(filename)).rejects.toThrow(/host secret/)
  })

  it('keeps credential rotations in the protected directory after a model retargets its configured alias', async () => {
    const { ctx, root } = await fixture(tmpdir(), true)
    const outside = join(root, 'outside')
    await mkdir(outside)
    const { runtime } = await mountRuntime(ctx, {}, { mode: 'workspace-write', workspaceRoot: root })
    const program = `const fs = await import('node:fs'); fs.unlinkSync(${JSON.stringify(join(root, 'alias'))}); fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(join(root, 'alias'))}); return true`
    const changed = await runtime.run(runtime.resolve({ program, cwd: root, bindings: [] }))
    expect(changed.error, JSON.stringify(changed)).toBeUndefined()
    expect(changed.value).toBe(true)
    await ctx.credentials.set(credentialRef('SYNTHETIC_AUTH'), 'rotated-human-secret')
    expect(await readFile(join(root, 'vault', 'credentials.yaml'), 'utf8')).toContain('rotated-human-secret')
    await expect(readFile(join(outside, 'credentials.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates nested safe parent directories outside automatic temporary write grants', async () => {
    const { ctx, root } = await fixture(homedir())
    const target = await ctx.fs.resolve(join(root, 'new', 'deep', 'file.txt'))
    await ctx.fs.writeText(target, 'safe')
    expect(await ctx.fs.readText(target)).toBe('safe')
  })

  it('reads absolute temporary files outside the filesystem working directory', async () => {
    const { ctx } = await fixture(homedir())
    const outside = await mkdtemp(join(tmpdir(), 'dsh-secret-safe-temp-'))
    onTestFinished(() => rm(outside, { recursive: true, force: true }))
    const filename = join(outside, 'safe.txt')
    await writeFile(filename, 'temporary safe text')
    const target = await ctx.fs.resolve(filename)
    expect(await ctx.fs.readText(target)).toBe('temporary safe text')
    expect((await ctx.fs.stat(target))?.type).toBe('file')
    expect((await collect(await ctx.fs.streamText(target))).join('')).toBe('temporary safe text')
  })

  it.each([
    ['per-call', 'workspace-write'], ['per-call', 'danger-full-access'],
    ['persistent-in-memory', 'workspace-write'], ['persistent-in-memory', 'danger-full-access'],
  ] as const)('denies Node PTC secret reads in %s under %s while safe evaluations work', async (executionMode, mode) => {
    const { ctx, root, filename } = await fixture()
    const { runtime } = await mountRuntime(ctx, { executionMode }, { mode, workspaceRoot: root })
    const persistent = executionMode === 'persistent-in-memory'
    const stateOwner = {}
    const read = `const fs = await import('node:fs'); let denied; try { fs.readFileSync(${JSON.stringify(filename)}, 'utf8'); denied = false } catch { denied = true }; ${persistent ? 'denied' : 'return denied'}`
    const result = await runtime.run(runtime.resolve({ program: read, bindings: [], cwd: root, stateOwner }))
    if (process.platform === 'linux' && mode === 'danger-full-access') {
      expect(result.error?.kind).toBe('sandbox-unavailable')
      expect(result.error?.message).toContain('mutable ancestor')
      expect(result.value).toBeUndefined()
      return
    }
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    expect(result.value).toBe(true)
    const allowed = await runtime.run(runtime.resolve({ program: persistent ? '6 * 7' : 'return 6 * 7', bindings: [], cwd: root, stateOwner }))
    expect(allowed.error, JSON.stringify(allowed)).toBeUndefined()
    expect(allowed.value).toBe(42)
  })

  it.skipIf(resolvePythonBin('python3') === undefined).each(['workspace-write', 'danger-full-access'] as const)('denies Python PTC secret reads under %s while safe evaluations work', async (mode) => {
    const { ctx, root, filename } = await fixture()
    const { default: Policy } = await import('@deepseek-ai/dsh-sandbox-policy')
    const { default: Projections } = await import('@deepseek-ai/dsh-session-projection')
    await ctx.plugin(Projections)
    await ctx.plugin(Policy, { mode, workspaceRoot: root })
    await ctx.plugin(PythonPtcRuntime, {})
    const program = `try:\n    open(${JSON.stringify(filename)}).read()\n    return False\nexcept (PermissionError, FileNotFoundError):\n    return True`
    const denied = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program, cwd: root, bindings: [] }))
    if (process.platform === 'linux' && mode === 'danger-full-access') {
      expect(denied.error?.kind).toBe('sandbox-unavailable')
      expect(denied.error?.message).toContain('mutable ancestor')
      expect(denied.value).toBeUndefined()
      return
    }
    expect(denied.error, JSON.stringify(denied)).toBeUndefined()
    expect(denied.value).toBe(true)
    const allowed = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program: 'return 42', cwd: root, bindings: [] }))
    expect(allowed.error, JSON.stringify(allowed)).toBeUndefined()
    expect(allowed.value).toBe(42)
  })

  it.each(['workspace-write', 'danger-full-access'] as const)('denies Bash secret reads under %s', async (mode) => {
    const { ctx, root, filename } = await fixture()
    await mountRuntime(ctx, {}, { mode, workspaceRoot: root })
    const { default: Bash } = await import('@deepseek-ai/dsh-bash-sandbox')
    await ctx.plugin(Bash, {})
    const execute = () => ctx.shell.execute(ctx.shell.resolve({ command: `cat ${JSON.stringify(filename)}`, workdir: root }))
    if (process.platform === 'linux' && mode === 'danger-full-access') {
      await expect(execute()).rejects.toThrow(/mutable ancestor/)
      return
    }
    const execution = await execute()
    const result = await execution.result()
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout.text).not.toContain(secret)
    const safe = await ctx.shell.execute(ctx.shell.resolve({ command: 'printf safe', workdir: root }))
    expect((await safe.result()).stdout.text).toBe('safe')
  })

  it('keeps safe filesystem operations and streaming available outside the credential directory', async () => {
    const { ctx, root, filename } = await fixture()
    const safePath = join(root, 'safe.txt')
    const text = 'safe text\n'.repeat(20_000)
    await writeFile(safePath, text)
    const target = await ctx.fs.resolve(safePath)
    expect(await ctx.fs.readText(target)).toBe(text)
    const chunks: string[] = []
    for await (const chunk of await ctx.fs.streamText(target)) chunks.push(chunk)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
    await ctx.fs.writeText(target, 'updated')
    expect(await readFile(safePath, 'utf8')).toBe('updated')
    const direct = { targetKey: FsTargetKey(filename), displayPath: filename }
    await expect(ctx.fs.readText(direct)).rejects.toThrow(/host secret/)
    await expect(ctx.fs.writeText(direct, 'forged')).rejects.toThrow(/host secret/)
    expect(await ctx.credentials.resolve(credentialRef('SYNTHETIC_AUTH'))).toMatchObject({ value: secret })
  })

  it('confines grep and glob while ordinary host subprocesses remain usable', async () => {
    const { ctx, root, filename } = await fixture()
    const safe = join(root, 'safe.txt')
    await writeFile(safe, 'safe content')
    const exec = { signal: new AbortController().signal }
    const matches = await runRipgrep(ctx, exec, 'grep', ['safe', safe], 1024, 1000, 1024)
    expect(matches.stdout).toContain('safe content')
    const hidden = runRipgrep(ctx, exec, 'glob', ['--files', join(root, 'vault')], 1024, 1000, 1024)
    if (process.platform === 'darwin') await expect(hidden).rejects.toThrow(/Operation not permitted/)
    else expect((await hidden).stdout).not.toContain('credentials.yaml')
    await expect(runRipgrep(ctx, exec, 'grep', ['.', filename], 1024, 1000, 1024)).rejects.toThrow()
    const child = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write("host helper")'], cwd: root, graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    })
    expect((await child.done).exitCode).toBe(0)
    expect(child.collected.stdout?.readFrom(0).text).toBe('host helper')
    expect(await child.waitForExit()).toBe(true)
  })

  it.each(['read', 'write', 'stream'] as const)('blocks a symlink swapped after host resolution during filesystem %s', async (method) => {
    const { ctx, root, filename } = await fixture()
    const safe = join(root, 'safe.txt')
    await writeFile(safe, 'safe')
    const target = await ctx.fs.resolve(safe)
    const original = ctx.sandbox.confine.bind(ctx.sandbox)
    const swap = vi.spyOn(ctx.sandbox, 'confine').mockImplementationOnce(async (...args) => {
      const confined = await original(...args)
      await rm(safe)
      await symlink(filename, safe)
      return confined
    })
    onTestFinished(() => { swap.mockRestore() })
    const operation = method === 'write' ? ctx.fs.writeText(target, 'forged')
      : method === 'stream' ? collect(await ctx.fs.streamText(target)) : ctx.fs.readText(target)
    await expect(operation).rejects.toThrow()
    expect(swap).toHaveBeenCalledOnce()
    expect(await ctx.credentials.resolve(credentialRef('SYNTHETIC_AUTH'))).toMatchObject({ value: secret })
    expect(await readFile(filename, 'utf8')).toContain(secret)
  })

  it.skipIf(spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true']).status !== 0)(
    'confines alternate PowerShell execution with mandatory secret exclusions',
    async () => {
      const { ctx, root, filename } = await fixture()
      await mountRuntime(ctx, {}, { mode: 'workspace-write', workspaceRoot: root })
      const { default: PowerShell } = await import('@deepseek-ai/dsh-pwsh-sandbox')
      await ctx.plugin(PowerShell, {})
      const execution = await ctx.shell.execute(ctx.shell.resolve({ command: `[System.IO.File]::ReadAllText('${filename.replaceAll("'", "''")}')`, workdir: root }))
      const result = await execution.result()
      expect(result.stdout.text).not.toContain(secret)
      expect(result.stderr.text).not.toBe('')
      const safe = await ctx.shell.execute(ctx.shell.resolve({ command: "[Console]::Write('safe')", workdir: root }))
      expect((await safe.result()).stdout.text).toBe('safe')
    },
  )

  it.each(['workspace-write', 'danger-full-access'] as const)('confines persistent Bash terminals under %s', async (mode) => {
    const { ctx, root, filename } = await fixture()
    await mountRuntime(ctx, {}, { mode, workspaceRoot: root })
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(Terminals)
    await ctx.plugin(TerminalBash, { timeoutMs: 10_000, idleSilenceMs: 5_000 })
    const scope = ctx.plugin(() => {})
    const id = SessionId('synthetic-secret-owner')
    const owner: Agent = {
      id, options: {}, session: Session.create(id), inbox: unsupportedInbox(), status: 'idle', ctx: scope.ctx,
      send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(owner)
    const opening = ctx.terminals.spawn(owner, { type: 'shell', cwd: root })
    if (process.platform === 'linux' && mode === 'danger-full-access') {
      await expect(opening).rejects.toThrow(/mutable ancestor/)
      return
    }
    const terminal = await opening
    const denied = ctx.terminals.startSend(owner, terminal.sessionId, { text: `cat ${JSON.stringify(filename)}; printf '\\ncomplete\\n'`, submit: true })
    const output = (await denied.done).viewport
    expect(output).toContain('complete')
    expect(output).not.toContain(secret)
    const safe = ctx.terminals.startSend(owner, terminal.sessionId, { text: 'printf safe', submit: true })
    expect((await safe.done).viewport).toContain('safe')
    expect(await ctx.terminals.kill(owner, terminal.sessionId)).toBe(true)
  })
})

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}
