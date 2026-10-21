/** Kernel-confined filesystem operations when the host holds authentication secrets. */
import { constants } from 'node:buffer'
import { stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, FsVersion, FsTargetKey } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { Config, LocalFileSystem } from './index.ts'

const ERROR_CODES = {
  FS_NOT_FOUND: true, FS_NOT_DIRECTORY: true, FS_NOT_TEXT: true, FS_NOT_REGULAR_FILE: true,
  FS_TOO_LARGE: true, FS_PERMISSION_DENIED: true, FS_SANDBOX_DENIED: true, FS_IO_ERROR: true,
  FS_STALE_VERSION: true, FS_NOT_OBSERVED: true, FS_AMBIGUOUS_EDIT: true, FS_EDIT_NOT_FOUND: true, FS_ABORTED: true,
} satisfies Record<FsErrorCode, true>

type Method = 'stat' | 'lstat' | 'listDir' | 'readText' | 'readBytes' | 'readByteRange' | 'writeText' | 'editText'

const metadata = z.object({ version: z.string().transform(FsVersion), type: z.enum(['file', 'directory', 'other']), size: z.number().nonnegative().optional() }).strict()
const absent = z.object({ absent: z.literal(true) }).strict().transform(() => undefined)
const bytes = z.object({ bytes: z.base64() }).strict().transform(value => new Uint8Array(Buffer.from(value.bytes, 'base64')))
const edit = z.object({ version: z.string().transform(FsVersion), before: z.string(), after: z.string() }).strict()
const resultSchemas = {
  stat: z.union([metadata, absent]),
  lstat: z.union([metadata.extend({ type: z.enum(['file', 'directory', 'symlink', 'other']) }), absent]),
  readText: z.string(), readBytes: bytes, readByteRange: bytes,
  listDir: z.array(z.object({
    name: z.string(), type: z.enum(['file', 'directory', 'other']),
    target: z.object({ targetKey: z.string().transform(FsTargetKey), displayPath: z.string() }).strict(),
    version: z.string().transform(FsVersion).optional(), size: z.number().nonnegative().optional(),
  }).strict()),
  writeText: edit.extend({ operation: z.enum(['create', 'update']), before: z.string().nullable() }),
  editText: edit,
} satisfies Record<Method, z.ZodType>

/**
 * Run the existing local provider in a fresh kernel-confined process; its own Context has no host secrets.
 * Kernel enforcement covers path changes between host resolution and the worker's filesystem syscalls.
 * @param ctx - host filesystem context with same-world sandbox and subprocess providers.
 * @param config - local provider parameters for the worker.
 * @param method - fixed provider operation, never model-supplied executable code.
 * @param args - typed operation arguments with cancellation handled by the parent.
 * @param signal - cancels preparation and joins the worker before rejecting.
 * @returns the provider's JSON result; byte results are reconstructed from the private transport's base64 field.
 */
export async function isolatedFileOperation<K extends Method>(
  ctx: Context, config: Config, method: K, args: unknown[], signal?: AbortSignal,
): Promise<Awaited<ReturnType<LocalFileSystem[K]>>> {
  const child = await startWorker(ctx, config, method, args, signal)
  try {
    const outcome = await child.done
    signal?.throwIfAborted()
    if (outcome.exitCode !== 0) {
      throw new FsError('file access denied: host secret filesystem worker failed', 'FS_SANDBOX_DENIED')
    }
    const output = child.collected.stdout?.readFrom(0).text
    if (output === undefined) throw new Error('host secret filesystem worker returned no output')
    const result: unknown = JSON.parse(output)
    if (typeof result !== 'object' || result === null || !('ok' in result)) throw new Error('invalid filesystem worker response')
    if (result.ok === false) {
      if ('code' in result && typeof result.code === 'string' && Object.hasOwn(ERROR_CODES, result.code)
        && 'message' in result && typeof result.message === 'string') {
        throw new FsError(result.message, result.code as FsErrorCode)
      }
      throw new FsError('file access denied by host secret filesystem worker', 'FS_SANDBOX_DENIED')
    }
    if (result.ok !== true || !('value' in result)) throw new Error('invalid filesystem worker result')
    const parsed = resultSchemas[method].safeParse(result.value)
    if (!parsed.success) throw new Error(`invalid filesystem worker ${method === 'readBytes' || method === 'readByteRange' ? 'bytes' : 'result'}`)
    // The method selects its matching wire validator before the generic return projection.
    return parsed.data as Awaited<ReturnType<LocalFileSystem[K]>>
  } finally {
    child.terminate()
    if (!await child.waitForExit()) throw new FsError('host secret filesystem worker did not confirm shutdown', 'FS_IO_ERROR')
  }
}

/** Start one private filesystem worker with bounded collection or a backpressured text pipe. */
async function startWorker(
  ctx: Context, config: Config, method: Method | 'streamText', args: unknown[], signal?: AbortSignal,
): Promise<SubprocessHandle> {
  const sandbox = ctx.get('sandbox')
  const subprocess = ctx.get('subprocess')
  if (sandbox === undefined || subprocess === undefined) {
    throw new FsError('file access denied: host secret protection requires local sandbox and subprocess providers', 'FS_SANDBOX_DENIED')
  }
  const source = new URL(import.meta.url).pathname.endsWith('.ts')
  /* v8 ignore next -- isolated.built.e2e.ts exercises the built artifact URL under plain Node. */
  const entry = new URL(source ? './index.ts' : './index.js', import.meta.url).href
  /* v8 ignore next -- isolated.built.e2e.ts exercises the installed Cordis URL under plain Node. */
  const context = source ? new URL('../../../../vendor/cordis/src/index.ts', import.meta.url).href : import.meta.resolve('@deepseek-ai/cordis')
  const script = `
    import { Context } from ${JSON.stringify(context)};
    import { LocalFileSystem } from ${JSON.stringify(entry)};
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const { config, method, args } = JSON.parse(input);
    const ctx = new Context();
    await (async () => { try {
      const fs = new LocalFileSystem(ctx, config);
      if (method === 'streamText') {
        for await (const chunk of await fs.streamText(...args)) {
          if (!process.stdout.write(JSON.stringify({ ok: true, value: chunk }) + '\\n')) await new Promise(resolve => process.stdout.once('drain', resolve));
        }
        process.stdout.write(JSON.stringify({ ok: true, done: true }) + '\\n');
        return;
      }
      const value = await fs[method](...args);
      process.stdout.write(JSON.stringify({ ok: true, value: value === undefined ? { absent: true } : value instanceof Uint8Array ? { bytes: Buffer.from(value).toString('base64') } : value }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, message: error.message, code: error.code }) + (method === 'streamText' ? '\\n' : ''));
    } finally { await ctx.fiber.dispose(); } })();
  `
  const argv = [process.execPath]
  if (source) {
    const tsconfig = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tsconfig.base.json')
    const registration = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register({ tsconfig: ${JSON.stringify(tsconfig)} });`
    argv.push('--import', `data:text/javascript,${encodeURIComponent(registration)}`)
  }
  argv.push('--input-type=module', '--eval', script)
  const target = args[0] as { targetKey: string }
  const mutation = method === 'writeText' || method === 'editText'
  const workspaceRoot = mutation ? await existingParent(dirname(target.targetKey)) : config.cwd ?? process.cwd()
  const confined = await sandbox.confine(argv, { mode: mutation ? 'workspace-write' : 'read-only', workspaceRoot, preserveHostTemp: true }, signal)
  // No ambient loader, inspector, or credential environment reaches this private worker.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
  /* v8 ignore else -- Plain-Node artifact workers do not load TypeScript; the built smoke covers that branch. */
  if (source) env.TSX_DISABLE_CACHE = '1'
  return subprocess.spawn({
    argv: confined.argv, cwd: config.cwd ?? process.cwd(), env, signal, graceMs: config.secretWorkerGraceMs as number,
    stdio: {
      stdin: { data: JSON.stringify({ config, method, args }) },
      stdout: method === 'streamText' ? 'pipe' : { maxBytes: constants.MAX_STRING_LENGTH, spill: { maxBytes: 0 } },
      stderr: { maxBytes: constants.MAX_STRING_LENGTH, spill: { maxBytes: 0 } },
    },
  })
}

/**
 * Stream decoded text through a kernel-confined worker without collecting the whole file.
 * @param ctx - host context owning the sandbox and subprocess providers.
 * @param config - filesystem settings passed to the worker.
 * @param target - resolved filesystem target.
 * @param signal - cancellation during startup or streaming.
 * @returns ordered decoded text chunks; breaking iteration terminates and joins the worker.
 */
export async function* isolatedFileStream(
  ctx: Context, config: Config, target: unknown, signal?: AbortSignal,
): AsyncIterable<string> {
  const child = await startWorker(ctx, config, 'streamText', [target], signal)
  const completion = child.done.catch((error: unknown) => { throw error })
  // Observe failure while the pipe is still being read; completion is awaited below.
  void completion.catch((_workerFailed: unknown) => {})
  try {
    if (child.stdout === undefined) throw new Error('filesystem worker did not supply a text pipe')
    let finished = false
    for await (const line of workerLines(child.stdout)) {
      signal?.throwIfAborted()
      const result: unknown = JSON.parse(line)
      if (typeof result !== 'object' || result === null || !('ok' in result)) throw new Error('invalid filesystem stream response')
      if (result.ok === false) {
        if ('code' in result && typeof result.code === 'string' && Object.hasOwn(ERROR_CODES, result.code)
          && 'message' in result && typeof result.message === 'string') {
          throw new FsError(result.message, result.code as FsErrorCode)
        }
        throw new FsError('file access denied by host secret filesystem worker', 'FS_SANDBOX_DENIED')
      }
      if (result.ok !== true || finished) throw new Error('invalid filesystem stream result')
      if ('done' in result && result.done === true) finished = true
      else if ('value' in result && typeof result.value === 'string') yield result.value
      else throw new Error('invalid filesystem stream text')
    }
    const outcome = await completion
    signal?.throwIfAborted()
    if (!finished || outcome.exitCode !== 0) {
      throw new FsError('file access denied: host secret filesystem worker failed', 'FS_SANDBOX_DENIED')
    }
  } finally {
    child.terminate()
    if (!await child.waitForExit()) throw new FsError('host secret filesystem worker did not confirm shutdown', 'FS_IO_ERROR')
  }
}

/** Decode bounded JSON lines while preserving pipe backpressure across consumer yields. */
async function* workerLines(stdout: Readable): AsyncIterable<string> {
  stdout.setEncoding('utf8')
  let pending = ''
  for await (const chunk of stdout as AsyncIterable<string>) {
    pending += chunk
    let end: number
    while ((end = pending.indexOf('\n')) !== -1) {
      if (end > 1024 * 1024) throw new Error('filesystem stream frame exceeds the protocol limit')
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      yield line
    }
    if (pending.length > 1024 * 1024) throw new Error('filesystem stream frame exceeds the protocol limit')
  }
  if (pending.length > 0) throw new Error('incomplete filesystem stream frame')
}

/** Anchor recursive creation at an existing directory without changing the requested target. */
async function existingParent(path: string): Promise<string> {
  let directory = path
  while (true) {
    try {
      if ((await stat(directory)).isDirectory()) return directory
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
    const parent = dirname(directory)
    /* v8 ignore next -- Local roots exist; this guard also refuses an unavailable drive root. */
    if (parent === directory) throw new Error('filesystem worker has no existing parent directory')
    directory = parent
  }
}
