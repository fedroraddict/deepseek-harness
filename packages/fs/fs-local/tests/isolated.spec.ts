import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { isolatedFileOperation } from '../src/isolated.ts'
import { isolatedFileStream } from '../src/isolated.ts'
import { Readable } from 'node:stream'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { protectHostSecretDirectory } from '@deepseek-ai/dsh-sandbox'
import { LocalFileSystem } from '../src/index.ts'

class Sandbox extends SandboxProvider {
  async confine(argv: readonly string[]) {
    return { argv: [...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }
  }
}
class Subprocess extends SubprocessRuntime {
  output: string | undefined = JSON.stringify({ ok: true, value: 'text' })
  outcome = { exitCode: 0 as number | null, signal: null as NodeJS.Signals | null }
  beforeDone = () => {}
  stdout: Readable | undefined
  failure: Error | undefined
  spec: SubprocessSpawnSpec | undefined
  terminate = vi.fn()
  waitForExit = vi.fn(async () => true)
  async resolveExecutable() { return process.execPath }
  async terminalEnvironment() { return { platform: 'posix' as const } }
  async spawnTerminal(): Promise<never> { throw new Error('unused') }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spec = spec
    this.beforeDone()
    return {
      stdin: undefined, stdout: this.stdout, stderr: undefined, control: undefined,
      collected: this.output === undefined ? {} : { stdout: { readFrom: () => ({ text: this.output!, nextOffset: 0, lossy: false }) } },
      done: this.failure === undefined ? Promise.resolve(this.outcome) : Promise.reject(this.failure),
      terminate: this.terminate, waitForExit: this.waitForExit,
    }
  }
}
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const target = { targetKey: FsTargetKey('/workspace/file'), displayPath: '/workspace/file' }
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Sandbox)
  await ctx.plugin(Subprocess)
  return { ctx, process: ctx.subprocess as Subprocess }
}
const config = { cwd: process.cwd(), secretWorkerGraceMs: 1000 }

it('requires both local execution providers before filesystem work starts', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await expect(isolatedFileOperation(ctx, config, 'readText', [target])).rejects.toThrow(/requires local sandbox/)
  await ctx.plugin(Sandbox)
  await expect(isolatedFileOperation(ctx, config, 'readText', [target])).rejects.toThrow(/requires local sandbox/)
})

it.each([
  null, 1, {}, { ok: 'yes' }, { ok: true }, { ok: false },
  { ok: false, code: 'UNKNOWN', message: 'bad' },
  { ok: false, code: 'FS_NOT_FOUND', message: 1 },
])('rejects an invalid worker envelope and joins its process: %j', async (value) => {
  const { ctx, process } = await setup()
  process.output = JSON.stringify(value)
  await expect(isolatedFileOperation(ctx, config, 'readText', [target])).rejects.toThrow()
  expect(process.terminate).toHaveBeenCalledOnce()
  expect(process.waitForExit).toHaveBeenCalledOnce()
})

it.each([undefined, 'not json'])('rejects missing or malformed worker output: %s', async (output) => {
  const { ctx, process } = await setup()
  process.output = output
  await expect(isolatedFileOperation(ctx, config, 'readText', [target])).rejects.toThrow()
  expect(process.waitForExit).toHaveBeenCalledOnce()
})

it.each([{ exitCode: 1, signal: null }, { exitCode: null, signal: 'SIGTERM' as const }])('refuses failed workers: %j', async (outcome) => {
  const { ctx, process } = await setup()
  process.outcome = outcome
  await expect(isolatedFileOperation(ctx, config, 'readText', [target])).rejects.toThrow(/worker failed/)
})

it('preserves filesystem error codes and joins the worker on cancellation', async () => {
  const { ctx, process } = await setup()
  process.output = JSON.stringify({ ok: false, code: 'FS_STALE_VERSION', message: 'file changed' })
  await expect(isolatedFileOperation(ctx, config, 'editText', [target])).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  const controller = new AbortController()
  process.beforeDone = () => { controller.abort(new Error('cancelled')) }
  await expect(isolatedFileOperation(ctx, config, 'writeText', [target], controller.signal)).rejects.toThrow('cancelled')
  expect(process.waitForExit).toHaveBeenCalledTimes(2)
})

it.each([null, 1, {}, { bytes: 1 }])('rejects invalid byte results: %j', async (value) => {
  const { ctx, process } = await setup()
  process.output = JSON.stringify({ ok: true, value })
  await expect(isolatedFileOperation(ctx, config, 'readBytes', [target])).rejects.toThrow(/invalid filesystem worker bytes/)
})

it('uses the host working directory when no local cwd was supplied', async () => {
  const { ctx } = await setup()
  await expect(isolatedFileOperation(ctx, { secretWorkerGraceMs: 1000 }, 'readText', [target])).resolves.toBe('text')
})

it('streams split frames in order and joins its worker when consumption ends early', async () => {
  const { ctx, process } = await setup()
  process.stdout = Readable.from(['{"ok":true,"val', 'ue":"first"}\n{"ok":true,"value":"second"}\n{"ok":true,"done":true}\n'])
  const chunks: string[] = []
  for await (const chunk of isolatedFileStream(ctx, config, target)) chunks.push(chunk)
  expect(chunks).toEqual(['first', 'second'])
  expect(process.waitForExit).toHaveBeenCalledOnce()
  process.stdout = Readable.from(['{"ok":true,"value":"first"}\n{"ok":true,"value":"second"}\n'])
  for await (const chunk of isolatedFileStream(ctx, config, target)) {
    expect(chunk).toBe('first')
    break
  }
  expect(process.terminate).toHaveBeenCalledTimes(2)
  expect(process.waitForExit).toHaveBeenCalledTimes(2)
})

it.each([
  'not JSON\n', '{}\n', '{"ok":true,"value":5}\n', '{"ok":true,"value":"unfinished"}',
  '{"ok":true,"done":true}\n{"ok":true,"value":"late"}\n',
  'x'.repeat(1024 * 1024 + 1),
])('rejects malformed or oversized stream frames and joins the worker', async (output) => {
  const { ctx, process } = await setup()
  process.stdout = Readable.from([output])
  await expect(collect(isolatedFileStream(ctx, config, target))).rejects.toThrow()
  expect(process.waitForExit).toHaveBeenCalledOnce()
})

it('preserves a streamed filesystem error and rejects a missing completion frame', async () => {
  const { ctx, process } = await setup()
  process.stdout = Readable.from(['{"ok":false,"code":"FS_NOT_TEXT","message":"binary"}\n'])
  await expect(collect(isolatedFileStream(ctx, config, target))).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  process.stdout = Readable.from(['{"ok":true,"value":"partial"}\n'])
  await expect(collect(isolatedFileStream(ctx, config, target))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
})

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

it('preserves absent metadata, byte values, and mutation results across the worker wire', async () => {
  const { ctx, process } = await setup()
  process.output = JSON.stringify({ ok: true, value: { absent: true } })
  expect(await isolatedFileOperation(ctx, config, 'stat', [target])).toBeUndefined()
  expect(await isolatedFileOperation(ctx, config, 'lstat', [target])).toBeUndefined()
  process.output = JSON.stringify({ ok: true, value: { bytes: 'c2FmZQ==' } })
  expect(new TextDecoder().decode(await isolatedFileOperation(ctx, config, 'readBytes', [target]))).toBe('safe')
  expect(new TextDecoder().decode(await isolatedFileOperation(ctx, config, 'readByteRange', [target]))).toBe('safe')
  const created = { operation: 'create', version: 'new-version', before: null, after: 'safe' }
  process.output = JSON.stringify({ ok: true, value: created })
  expect(await isolatedFileOperation(ctx, config, 'writeText', [target, 'safe'])).toEqual(created)
  const edited = { version: 'edited-version', before: 'safe', after: 'updated' }
  process.output = JSON.stringify({ ok: true, value: edited })
  expect(await isolatedFileOperation(ctx, config, 'editText', [target, { oldString: 'safe', newString: 'updated' }])).toEqual(edited)
  process.output = JSON.stringify({ ok: true, value: [{ name: 'file', type: 'file', target, version: 'version', size: 4 }] })
  expect(await isolatedFileOperation(ctx, config, 'listDir', [target])).toHaveLength(1)
})

it('rejects invalid metadata and malformed base64 instead of projecting invalid filesystem values', async () => {
  const { ctx, process } = await setup()
  process.output = JSON.stringify({ ok: true, value: { type: 'file', version: 1 } })
  await expect(isolatedFileOperation(ctx, config, 'stat', [target])).rejects.toThrow(/invalid filesystem worker result/)
  process.output = JSON.stringify({ ok: true, value: { bytes: 'not base64' } })
  await expect(isolatedFileOperation(ctx, config, 'readBytes', [target])).rejects.toThrow(/invalid filesystem worker bytes/)
})

it('joins streamed workers after process failure and cancellation between chunks', async () => {
  const { ctx, process } = await setup()
  process.stdout = Readable.from([])
  process.failure = new Error('worker exited unexpectedly')
  await expect(collect(isolatedFileStream(ctx, config, target))).rejects.toThrow('worker exited unexpectedly')
  process.failure = undefined
  process.stdout = Readable.from(['{"ok":true,"value":"first"}\n{"ok":true,"done":true}\n'])
  const controller = new AbortController()
  const iterator = isolatedFileStream(ctx, config, target, controller.signal)[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toBe('first')
  controller.abort(new Error('stream cancelled'))
  await expect(iterator.next()).rejects.toThrow('stream cancelled')
  expect(process.waitForExit).toHaveBeenCalledTimes(2)
})

it.each([
  'null\n', '{"ok":"yes"}\n', '{"ok":false}\n', '{"ok":false,"code":"FS_IO_ERROR","message":3}\n',
  `${'x'.repeat(1024 * 1024 + 1)}\n`,
])('rejects invalid stream envelopes before exposing text', async (output) => {
  const { ctx, process } = await setup()
  process.stdout = Readable.from([output])
  await expect(collect(isolatedFileStream(ctx, config, target))).rejects.toThrow()
  expect(process.waitForExit).toHaveBeenCalledOnce()
})

it('requires a stream pipe and a successful worker exit after its completion frame', async () => {
  const { ctx, process } = await setup()
  await expect(collect(isolatedFileStream(ctx, config, target))).rejects.toThrow(/text pipe/)
  process.stdout = Readable.from(['{"ok":true,"done":true}\n'])
  process.outcome = { exitCode: 1, signal: null }
  await expect(collect(isolatedFileStream(ctx, config, target))).rejects.toThrow(/worker failed/)
})

it('lets the worker report a non-directory ancestor instead of binding a nonexistent directory', async () => {
  const { ctx, process } = await setup()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-worker-file-parent-'))
  try {
    const file = join(directory, 'file')
    await writeFile(file, 'safe')
    process.output = JSON.stringify({ ok: false, code: 'FS_NOT_DIRECTORY', message: 'not a directory' })
    const invalid = { targetKey: FsTargetKey(join(file, 'nested', 'target')), displayPath: 'invalid target' }
    await expect(isolatedFileOperation(ctx, config, 'writeText', [invalid, 'safe'])).rejects.toMatchObject({ code: 'FS_NOT_DIRECTORY' })
    expect(process.waitForExit).toHaveBeenCalledOnce()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('refuses an ancestor that cannot be inspected before starting a worker', async () => {
  const { ctx, process } = await setup()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-worker-cycle-'))
  try {
    const cycle = join(directory, 'cycle')
    await symlink(cycle, cycle)
    const invalid = { targetKey: FsTargetKey(join(cycle, 'target')), displayPath: 'cycle target' }
    await expect(isolatedFileOperation(ctx, config, 'writeText', [invalid, 'safe'])).rejects.toMatchObject({ code: 'ELOOP' })
    expect(process.waitForExit).not.toHaveBeenCalled()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('routes protected filesystem metadata, bytes, mutations, and streams through the private worker', async () => {
  const { ctx, process } = await setup()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-filesystem-routing-'))
  const vault = join(directory, 'vault')
  await mkdir(vault)
  try {
    protectHostSecretDirectory(ctx, vault)
    await ctx.plugin(LocalFileSystem, { cwd: directory })
    const safe = await ctx.fs.resolve('safe.txt')
    process.output = JSON.stringify({ ok: true, value: { version: 'version', type: 'file', size: 4 } })
    expect(await ctx.fs.stat(safe)).toMatchObject({ type: 'file', size: 4 })
    expect(await ctx.fs.lstat('safe.txt')).toMatchObject({ type: 'file' })
    process.output = JSON.stringify({ ok: true, value: 'safe' })
    expect(await ctx.fs.readText(safe)).toBe('safe')
    process.output = JSON.stringify({ ok: true, value: { bytes: 'c2FmZQ==' } })
    expect(new TextDecoder().decode(await ctx.fs.readBytes(safe, undefined, 1024))).toBe('safe')
    expect(new TextDecoder().decode(await ctx.fs.readByteRange(safe, { offset: 0, length: 4 }))).toBe('safe')
    process.output = JSON.stringify({ ok: true, value: [] })
    expect(await ctx.fs.listDir(await ctx.fs.resolve(directory))).toEqual([])
    process.output = JSON.stringify({ ok: true, value: { operation: 'create', version: 'created', before: null, after: 'safe' } })
    expect(await ctx.fs.writeText(safe, 'safe')).toMatchObject({ operation: 'create', after: 'safe' })
    process.output = JSON.stringify({ ok: true, value: { version: 'edited', before: 'safe', after: 'updated' } })
    expect(await ctx.fs.editText(safe, { oldString: 'safe', newString: 'updated', replaceAll: false })).toMatchObject({ after: 'updated' })
    process.stdout = Readable.from(['{"ok":true,"value":"safe"}\n{"ok":true,"done":true}\n'])
    expect(await collect(await ctx.fs.streamText(safe))).toEqual(['safe'])
    await expect(ctx.fs.resolve(join(vault, 'credentials.yaml'))).rejects.toThrow(/host secret/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
  'rejects unbounded worker termination grace: %s',
  (secretWorkerGraceMs) => {
    const ctx = new Context()
    contexts.push(ctx)
    const options = { secretWorkerGraceMs, diffBasisMaxBytes: 1024, cwd: process.cwd() }
    expect(() => new LocalFileSystem(ctx, options)).toThrow(/secretWorkerGraceMs/)
  },
)

it('refuses successful results when worker shutdown cannot be confirmed', async () => {
  const { ctx, process } = await setup()
  process.waitForExit.mockResolvedValueOnce(false)
  await expect(isolatedFileOperation(ctx, config, 'readText', [target])).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  process.stdout = Readable.from(['{"ok":true,"done":true}\n'])
  process.waitForExit.mockResolvedValueOnce(false)
  await expect(collect(isolatedFileStream(ctx, config, target))).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
})

it('resolves worker termination grace for direct provider construction', () => {
  const ctx = new Context()
  contexts.push(ctx)
  const local = new LocalFileSystem(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 1024 })
  expect(local.config.secretWorkerGraceMs).toBe(1000)
})

it('uses an in-memory TypeScript cache inside read-only source workers', async () => {
  const { ctx, process } = await setup()
  await isolatedFileOperation(ctx, config, 'readText', [target])
  expect(process.spec?.env?.TSX_DISABLE_CACHE).toBe('1')
})
