/**
 * Real timers for waiting on a world (`realtime.settled()`, `world.idle()`,
 * `waitForRealtimeStartup()`) and for the default Notification 2.0 delivery.
 * They are captured when fake-c8y is loaded, so fake timers installed later
 * (Vitest's `vi.useFakeTimers()`, sinon) do not stop the fake platform.
 * In a runtime without `setTimeout` (an isolate) the import still works; only
 * waiting needs it.
 */

const realSetTimeout: ((callback: () => void, ms: number) => unknown) | undefined = typeof globalThis.setTimeout === 'function'
  ? globalThis.setTimeout.bind(globalThis)
  : undefined

const realNow: () => number = Date.now.bind(Date)

/**
 * Runs a callback later on the real `setTimeout` (0 ms), or after the
 * current microtasks where there is none.
 * @param callback - The callback
 */
export function scheduleReal(callback: () => void): void {
  if (realSetTimeout) {
    realSetTimeout(callback, 0)
  } else {
    Promise.resolve().then(callback)
  }
}

export interface QuietWaitOptions {
  /**
   * Milliseconds to wait at most.
   */
  timeout: number
  /**
   * Milliseconds between two checks.
   * @default 2
   */
  interval?: number
  /**
   * Consecutive quiet checks needed.
   * @default 3
   */
  quietChecks?: number
}

/**
 * Checks `quiet()` on the real timers until it held for `quietChecks`
 * consecutive checks, or until the timeout passed.
 * The elapsed time is the larger of the wall time and the time slept, so the
 * timeout also ends under a frozen `Date` (isolates with virtual timers).
 * @param quiet - Whether the world is quiet right now
 * @param options - Timeout, interval, quiet checks
 * @returns Whether it got quiet, and the milliseconds waited
 */
export async function waitForQuiet(quiet: () => boolean, options: QuietWaitOptions): Promise<{ quiet: boolean, waitedMs: number }> {
  const setTimer = realSetTimeout
  if (!setTimer) {
    throw new TypeError('fake-c8y: waiting needs setTimeout, which this runtime does not have')
  }
  const interval = options.interval ?? 2
  const needed = options.quietChecks ?? 3
  const start = realNow()
  let slept = 0
  let quietChecks = 0
  const elapsed = () => Math.max(realNow() - start, slept)
  while (true) {
    await new Promise<void>((resolve) => {
      setTimer(resolve, interval)
    })
    slept += interval
    quietChecks = quiet() ? quietChecks + 1 : 0
    if (quietChecks >= needed) {
      return { quiet: true, waitedMs: elapsed() }
    }
    if (elapsed() >= options.timeout) {
      return { quiet: false, waitedMs: elapsed() }
    }
  }
}

/**
 * A wait for a world (`realtime.settled()`, `world.idle()`, or
 * `waitForRealtimeStartup()` with `onTimeout: 'throw'`) timed out. `status`
 * says what was still on its way.
 */
export class SettleTimeoutError extends Error {
  override readonly name = 'SettleTimeoutError'
  /**
   * What was still on its way when the wait gave up.
   */
  readonly status: Readonly<Record<string, number>>

  constructor(what: string, timeout: number, status: Readonly<Record<string, number>>, detail = '') {
    const open = Object.entries(status).filter(([, count]) => count > 0).map(([field, count]) => `${field} ${count}`)
    super(`fake-c8y: ${what} timed out after ${timeout} ms (${open.length > 0 ? open.join(', ') : 'nothing pending at the last check'})${detail}`)
    this.status = status
  }
}
