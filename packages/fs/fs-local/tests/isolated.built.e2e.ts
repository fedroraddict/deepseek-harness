/** Plain-Node smoke for the published filesystem worker and mandatory secret exclusions. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

const root = new URL('../../../../', import.meta.url)
const artifact = new URL('../lib/index.js', import.meta.url)

it.skipIf(!existsSync(artifact) || process.platform === 'win32')('isolates built filesystem workers under plain Node', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-built-secret-fs-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'vault'))
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, root).href)
  const script = `
    import { Context } from ${moduleUrl('vendor/cordis/lib/index.js')};
    import Credentials from ${moduleUrl('packages/credentials/credentials-local/lib/index.js')};
    import Sandbox from ${moduleUrl('packages/sandbox/sandbox-local/lib/index.js')};
    import Subprocess from ${moduleUrl('packages/subprocess/subprocess-local/lib/index.js')};
    import FileSystem from ${moduleUrl('packages/fs/fs-local/lib/index.js')};
    const ctx = new Context();
    try {
      await ctx.plugin(Credentials, { path: ${JSON.stringify(join(directory, 'vault', 'credentials.yaml'))}, watch: false });
      await ctx.plugin(Sandbox, { secretDirectories: [${JSON.stringify(join(directory, 'vault'))}] });
      await ctx.plugin(Subprocess);
      await ctx.plugin(FileSystem, { cwd: ${JSON.stringify(directory)} });
      const target = await ctx.fs.resolve('safe.txt');
      await ctx.fs.writeText(target, 'safe');
      const allowed = await ctx.fs.readText(target);
      let denied = false;
      try { await ctx.fs.resolve('vault/credentials.yaml'); } catch (error) { denied = error.code === 'HOST_SECRET_DENIED'; }
      console.log(JSON.stringify({ allowed, denied }));
    } finally { await ctx.fiber.dispose(); }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: fileURLToPath(root), env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 30_000,
  })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.signal, result.stderr).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout.trim())).toEqual({ allowed: 'safe', denied: true })
})
