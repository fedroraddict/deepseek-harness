import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { assertNoHostSecretAccess, assertNoHostSecretExclusions, hostSecretDirectories, hostSecretExecutionPolicy, protectHostSecretDirectory } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('keeps root-owned exclusions across child realms and rejects registration after execution starts', () => {
  const ctx = context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-secret-policy-'))
  roots.push(root)
  const vault = join(root, 'vault')
  mkdirSync(vault)
  mkdirSync(join(vault, 'nested'))
  writeFileSync(join(vault, 'nested', 'key'), 'synthetic secret')
  protectHostSecretDirectory(ctx, vault)
  const child = ctx.extend({})
  expect(hostSecretDirectories(child)).toEqual(hostSecretDirectories(ctx))
  expect(() => protectHostSecretDirectory(context(), 'relative')).toThrow(/absolute/)
  expect(() =>{  assertNoHostSecretAccess(child, join(vault, 'key')) }).toThrow(/host secret/)
  expect(() =>{  assertNoHostSecretAccess(ctx, join(root, 'vault-sibling', 'file')) }).not.toThrow()
  const alias = join(root, 'alias')
  symlinkSync(vault, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() =>{  assertNoHostSecretAccess(child, join(alias, 'missing', 'key')) }).toThrow(/host secret/)
  expect(() => protectHostSecretDirectory(ctx, vault)).not.toThrow()
  expect(() => protectHostSecretDirectory(ctx, join(root, 'other'))).toThrow(/before model execution/)
})

it('never lets a full-access approval remove registered secret exclusions', () => {
  const ctx = context()
  const full = { mode: 'danger-full-access' as const, workspaceRoot: process.cwd() }
  expect(hostSecretExecutionPolicy(ctx, full)).toBeUndefined()
  const protectedCtx = context()
  const vault = mkdtempSync(join(tmpdir(), 'dsh-secret-policy-vault-'))
  roots.push(vault)
  protectHostSecretDirectory(protectedCtx, vault)
  expect(hostSecretExecutionPolicy(protectedCtx, full)).toEqual(full)
  expect(hostSecretExecutionPolicy(ctx, { ...full, mode: 'read-only' })).toEqual({ ...full, mode: 'read-only' })
})

it('refuses to add credentials to a world that has already launched unconfined work', () => {
  const ctx = context()
  hostSecretExecutionPolicy(ctx, { mode: 'danger-full-access', workspaceRoot: process.cwd() })
  expect(() => protectHostSecretDirectory(ctx, join(tmpdir(), 'vault'))).toThrow(/before model execution/)
})

it.skipIf(process.platform === 'win32')('fails closed on symlink cycles and resolves suffixes beyond regular files', () => {
  const ctx = context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-secret-path-error-'))
  roots.push(root)
  mkdirSync(join(root, 'vault'))
  protectHostSecretDirectory(ctx, join(root, 'vault'))
  const file = join(root, 'file')
  writeFileSync(file, 'file')
  expect(() =>{  assertNoHostSecretAccess(ctx, join(file, 'child')) }).not.toThrow()
  symlinkSync(join(root, 'b'), join(root, 'a'))
  symlinkSync(join(root, 'a'), join(root, 'b'))
  expect(() =>{  assertNoHostSecretAccess(ctx, join(root, 'a')) }).toThrow(/ELOOP/)
})

it.each(['hard-link', 'symbolic-link'] as const)('rejects a secret directory containing a pre-existing %s alias', (kind) => {
  const ctx = context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-secret-alias-'))
  roots.push(root)
  const vault = join(root, 'vault')
  mkdirSync(vault)
  const outside = join(root, 'outside')
  writeFileSync(outside, 'synthetic secret')
  if (kind === 'hard-link') linkSync(outside, join(vault, 'alias'))
  else symlinkSync(root, join(vault, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => protectHostSecretDirectory(ctx, vault)).toThrow(/symbolic links or hard-linked files/)
  expect(() => hostSecretDirectories(ctx)).toThrow(/symbolic links or hard-linked files/)
})

it.skipIf(process.platform === 'win32')('leaves no-follow filesystem access unchanged when exclusions are unconfigured', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-unprotected-link-'))
  roots.push(root)
  const cycle = join(root, 'cycle')
  symlinkSync(cycle, cycle)
  expect(() =>{  assertNoHostSecretAccess(context(), cycle) }).not.toThrow()
})

it('refuses unsupported execution with registered exclusions and seals unprotected execution before startup', () => {
  const vault = mkdtempSync(join(tmpdir(), 'dsh-unsupported-consumer-'))
  roots.push(vault)
  const protectedCtx = context()
  protectHostSecretDirectory(protectedCtx, vault)
  expect(() =>{  assertNoHostSecretExclusions(protectedCtx, 'External model') }).toThrow(/does not support registered host-secret exclusions/)
  const ordinary = context()
  expect(() =>{  assertNoHostSecretExclusions(ordinary, 'External model') }).not.toThrow()
  expect(() => protectHostSecretDirectory(ordinary, vault)).toThrow(/before model execution/)
})

it('shares custody state across separately loaded copies of the sandbox package', async () => {
  const ctx = context()
  const vault = mkdtempSync(join(tmpdir(), 'dsh-secret-module-copy-'))
  roots.push(vault)
  protectHostSecretDirectory(ctx, vault)
  vi.resetModules()
  const copy = await import('../src/host-secrets.ts')
  expect(copy.hostSecretDirectories(ctx)).toEqual(hostSecretDirectories(ctx))
  expect(() => { copy.assertNoHostSecretAccess(ctx, join(vault, 'key')) }).toThrow(/host secret/)
  expect(() => { assertNoHostSecretExclusions(ctx, 'External model') }).toThrow(/host-secret exclusions/)
  expect(() => copy.protectHostSecretDirectory(ctx, join(vault, 'late'))).toThrow(/before model execution/)
  expect(() => { ctx.emit('internal/dispatch', 'waterfall', 'tools/execute', [], undefined) }).toThrow(/before model execution/)
})

it('blocks model tool dispatch after protection configuration fails, even if the plugin loader continues', () => {
  const ctx = context()
  expect(hostSecretDirectories(ctx)).toEqual([])
  expect(() => { ctx.emit('internal/dispatch', 'waterfall', 'tools/execute', [], undefined) }).not.toThrow()
  expect(() => protectHostSecretDirectory(ctx, 'relative')).toThrow(/absolute/)
  expect(() => hostSecretExecutionPolicy(ctx, { mode: 'read-only', workspaceRoot: '/' })).toThrow(/absolute/)
  expect(() => { ctx.emit('internal/dispatch', 'waterfall', 'tools/execute', [], undefined) }).toThrow(/absolute/)
  expect(() => { ctx.emit('internal/dispatch', 'emit', 'unrelated', [], undefined) }).not.toThrow()
})
