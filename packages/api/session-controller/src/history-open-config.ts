/** Shared validation for one Session's opening history-window timing. */
import z from '@deepseek-ai/schemastery'

/**
 * Timing for the opening frame of one Session's history window. Both bounds
 * apply to that frame only: later live frames of an open window are unbounded,
 * so a long silence mid-transcript is never cut by this policy.
 */
export interface SessionOpenConfig {
  /**
   * Delay before reporting an opening window that has not arrived, without
   * cancelling it. Default: 10000. Never observed when the window arrives, the
   * open fails, or {@link openTimeoutMs} expires first.
   */
  openWarnMs?: number
  /**
   * Deadline in ms for a Session's opening window before the open fails into
   * the `error` state. Default: 30000.
   */
  openTimeoutMs?: number
}

// Browsers and Node share this maximum signed 32-bit timer delay.
const MAX_TIMER_MS = 2_147_483_647

/** Schema shared by the Host plugin and the Client's opening-timing parser. */
export const SessionOpenConfigSchema: z<SessionOpenConfig, Required<SessionOpenConfig>> = z.object({
  openWarnMs: z.natural().min(1).max(MAX_TIMER_MS).default(10_000),
  openTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(30_000),
})

/**
 * Validate opening timing and supply every default before the first open.
 * @param config - Host plugin configuration or served-page bootstrap data.
 * @returns validated, complete opening timing.
 */
export function resolveSessionOpenConfig(config: unknown = {}): Required<SessionOpenConfig> {
  return SessionOpenConfigSchema(config as SessionOpenConfig)
}
