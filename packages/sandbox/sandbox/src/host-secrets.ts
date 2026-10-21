/** Host-owned secret-directory exclusions shared across application realms. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SandboxExecutionPolicy, SandboxPolicy } from './index.ts'

interface SecretPolicy {
  readonly directories: Set<string>
  started: boolean
  blocked: boolean
  failure: unknown
}
const POLICY = Symbol.for('@deepseek-ai/dsh-sandbox/host-secret-policy-v1')
type PolicyRoot = Context & { [POLICY]?: SecretPolicy }

function policyOf(ctx: Context): SecretPolicy {
  const root = ctx.root as PolicyRoot
  let policy = root[POLICY]
  if (policy === undefined) {
    const created: SecretPolicy = { directories: new Set(), started: false, blocked: false, failure: undefined }
    policy = created
    Object.defineProperty(root, POLICY, { value: created })
    ctx.root.on('internal/dispatch', (_mode, eventName) => {
      if (eventName !== 'tools/execute') return
      created.started = true
      if (created.blocked) throw created.failure
    }, { global: true })
  }
  if (policy.blocked) throw policy.failure
  return policy
}

/** Resolve missing suffixes against the deepest existing ancestor, including symlinked parents. */
function canonical(path: string): string {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  try {
    return realpathSync.native(absolute)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    /* v8 ignore next -- A missing filesystem/drive root cannot be created by this host fixture; refuse it rather than recurse. */
    if (parent === absolute) throw error
    return resolve(canonical(parent), relative(parent, absolute))
  }
}

/** Refuse pre-existing aliases that would leave secret bytes readable outside the protected tree. */
function assertPrivateTree(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    const info = lstatSync(path)
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) {
      throw new Error('host secret directories must not contain symbolic links or hard-linked files')
    }
    if (info.isDirectory()) assertPrivateTree(path)
  }
}

/**
 * Protect a secret directory for the application's lifetime, including after its owner unloads.
 * Registration after model execution or filesystem access starts is rejected: existing processes cannot acquire a new restriction.
 * @param ctx - trusted host owner; child realms share the root application's restrictions.
 * @param directory - existing absolute dedicated secret directory, including staging and locks;
 *   symbolic links inside it and hard-linked files are forbidden.
 * @returns the canonical directory for the owner to retain instead of a mutable symlink alias.
 * @throws on invalid or late registration; model tools remain blocked until a new application starts.
 */
export function protectHostSecretDirectory(ctx: Context, directory: string): string {
  const policy = policyOf(ctx)
  try {
    if (!isAbsolute(directory)) throw new Error('host secret directory must be absolute')
    const path = canonical(directory)
    if (policy.directories.has(path)) return path
    if (policy.started) throw new Error('host secret protection must be registered before model execution starts; restart this application')
    assertPrivateTree(path)
    policy.directories.add(path)
    return path
  } catch (error) {
    policy.blocked = true
    policy.failure = error
    throw error
  }
}

/**
 * Read the application's mandatory secret exclusions; sandbox modes and approvals cannot remove them.
 * @param ctx - consumer in the application's execution world.
 * @returns the registered canonical secret directories.
 */
export function hostSecretDirectories(ctx: Context): readonly string[] {
  return [...policyOf(ctx).directories].map(canonical)
}

/**
 * Reject filesystem access beneath a host secret directory, including symlink aliases.
 * @param ctx - local filesystem consumer.
 * @param path - path about to be used by the host filesystem.
 */
export function assertNoHostSecretAccess(ctx: Context, path: string): void {
  policyOf(ctx).started = true
  const directories = hostSecretDirectories(ctx)
  if (directories.length === 0) return
  const target = canonical(path)
  for (const directory of directories) {
    const suffix = relative(directory, target)
    if (suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))) {
      throw new HarnessError('file access denied: host secret directory', 'HOST_SECRET_DENIED')
    }
  }
}

/**
 * Resolve process confinement without allowing full-access approval to expose host secrets.
 * @param ctx - same-world consumer context.
 * @param policy - resolved caller policy.
 * @returns mandatory confinement, or undefined when full access has no registered host secrets.
 */
export function hostSecretExecutionPolicy(ctx: Context, policy: SandboxExecutionPolicy): SandboxPolicy | undefined {
  policyOf(ctx).started = true
  if (policy.mode !== 'danger-full-access') return { ...policy, mode: policy.mode }
  if (hostSecretDirectories(ctx).length === 0) return undefined
  return { ...policy }
}

/**
 * Refuse a model execution provider that cannot carry the application's secret exclusions.
 * @param ctx - consumer in the same application execution world.
 * @param consumer - provider named in the refusal diagnostic.
 */
export function assertNoHostSecretExclusions(ctx: Context, consumer: string): void {
  const policy = policyOf(ctx)
  policy.started = true
  if (policy.directories.size > 0) {
    throw new HarnessError(`${consumer} does not support registered host-secret exclusions`, 'HOST_SECRET_UNSUPPORTED')
  }
}
