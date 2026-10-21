/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { dirname } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @param secretDirectories - mandatory host secret directories hidden after workspace mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy, secretDirectories: readonly string[] = []): string[] {
  const args = [policy.mode === 'danger-full-access' ? '--bind' : '--ro-bind', '/', '/', '--unshare-pid', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    if (!policy.preserveHostTemp && policy.workspaceRoot !== '/') args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
    if (!policy.preserveHostTemp && policy.workspaceRoot === '/') args.push('--tmpfs', '/tmp')
  }
  // A broad workspace bind must not restore host procfs or host device aliases.
  args.push('--dev', '/dev', '--proc', '/proc')
  for (const directory of secretDirectories) args.push('--tmpfs', directory, '--remount-ro', directory)
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @param secretDirectories - mandatory read/write exclusions that outrank workspace and temp grants.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy, secretDirectories: readonly string[] = []): string[] {
  const forms = ['(version 1)', '(allow default)']
  if (policy.mode !== 'danger-full-access') {
    forms.push('(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`)
  }
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  if (secretDirectories.length > 0) {
    forms.push('(deny process-info* (target others))')
    for (const directory of secretDirectories) {
      forms.push(`(deny file-read* file-write* (subpath ${sbplString(directory)}))`)
      for (let ancestor = dirname(directory); dirname(ancestor) !== ancestor; ancestor = dirname(ancestor)) {
        forms.push(`(deny file-write-unlink (literal ${sbplString(ancestor)}))`)
      }
    }
  }
  return ['-p', forms.join(' ')]
}
