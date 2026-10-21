/** Stdio servers cannot acquire model authority without host-secret confinement. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { protectHostSecretDirectory } from '@deepseek-ai/dsh-sandbox'
import { expect, it } from 'vitest'
import { startConnection, resolveReconnectPolicy } from '../src/connection.ts'

it('refuses an unconfined local MCP server before starting its transport', async () => {
  const ctx = new Context()
  const vault = await mkdtemp(join(tmpdir(), 'dsh-mcp-secrets-'))
  protectHostSecretDirectory(ctx, vault)
  let connection: ReturnType<typeof startConnection> | undefined
  try {
    expect(() => {
      connection = startConnection(ctx, {
        transport: 'stdio', serverName: 'synthetic', command: process.execPath, args: ['-e', 'process.exit(1)'],
        env: {}, cwd: vault, toolCallTimeoutMs: 1000, failOnStartupError: true,
      }, resolveReconnectPolicy({ enabled: false }, 'test'))
    }).toThrow(/host-secret exclusions/)
  } finally {
    await connection?.dispose()
    await ctx.fiber.dispose()
    await rm(vault, { recursive: true, force: true })
  }
})
