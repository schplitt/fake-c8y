/**
 * Real timers for waiting on a world (`realtime.settled()`, `world.idle()`,
 * `waitForRealtimeStartup()`) and for the default Notification 2.0 delivery.
 * They are captured when fake-c8y is loaded, so fake timers installed later
 * (Vitest's `vi.useFakeTimers()`, sinon) do not stop the fake platform.
 * In a runtime without `setTimeout` (an isolate) the import still works; only
 * waiting needs it.
 */

type SetTimeout = (callback: () => void, ms: number) => unknown

/**
 * The timers of a global object: `setTimeout`, `Date.now`, and whether
 * either is a fake (`@sinonjs/fake-timers`, which Vitest and Jest use, marks
 * its `setTimeout` and `Date` with a `clock` property).
 */
export interface TimerSource {
  setTimeout: SetTimeout | undefined
  now: () => number
  fake: boolean
}

/**
 * Reads the timers of a global object (exported for tests).
 * @param global - Usually `globalThis`
 * @param global.setTimeout - Its `setTimeout`, if it has one
 * @param global.Date - Its `Date`
 */
export function timerSource(global: { setTimeout?: unknown, Date: DateConstructor }): TimerSource {
  const setTimer = typeof global.setTimeout === 'function' ? global.setTimeout as SetTimeout & { clock?: unknown } : undefined
  return {
    setTimeout: setTimer ? (callback, ms) => setTimer.call(global, callback, ms) : undefined,
    now: global.Date.now.bind(global.Date),
    fake: (setTimer !== undefined && 'clock' in setTimer) || 'clock' in global.Date,
  }
}

// captured once, when fake-c8y is loaded
const captured: TimerSource = timerSource(globalThis)

/**
 * The timers to wait with: the ones captured at load, or, when those were
 * already fake (fake timers installed before fake-c8y was loaded), the
 * current global ones if they are real by now.
 */
function realTimers(): TimerSource {
  if (!captured.fake) {
    return captured
  }
  const current = timerSource(globalThis)
  if (!current.fake) {
    return current
  }
  throw new TypeError('fake-c8y: fake timers were installed before fake-c8y was loaded, so it has no real timers to wait with. Import fake-c8y before calling vi.useFakeTimers() (for example at the top of the setup file), or call vi.useRealTimers() before waiting.')
}

/**
 * Runs a callback later on the real `setTimeout` (0 ms), or after the
 * current microtasks where there is none.
 * @param callback - The callback
 */
export function scheduleReal(callback: () => void): void {
  // fake timers installed before fake-c8y was loaded: the global at call time
  scheduleWith(captured.fake ? timerSource(globalThis) : captured, callback)
}

/**
 * `scheduleReal()` on a given timer source (exported for tests).
 * @param timers - The timer source
 * @param callback - The callback
 */
export function scheduleWith(timers: TimerSource, callback: () => void): void {
  if (timers.setTimeout) {
    timers.setTimeout(callback, 0)
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
   * Milliseconds the condition must hold without interruption.
   */
  quietMs: number
  /**
   * Milliseconds between two checks.
   * @default 2
   */
  interval?: number
  /**
   * Timers to wait with (for tests).
   * @default the real timers
   */
  timers?: TimerSource
}

/**
 * Checks `quiet()` on the real timers until it held for `quietMs` (at least
 * two consecutive checks), or until the timeout passed.
 * The elapsed time is the larger of the wall time and the time slept, so the
 * timeout also ends under a frozen `Date` (isolates with virtual timers).
 * @param quiet - Whether the world is quiet right now
 * @param options - Timeout, quiet period, interval
 * @returns Whether it got quiet, and the milliseconds waited
 */
export async function waitForQuiet(quiet: () => boolean, options: QuietWaitOptions): Promise<{ quiet: boolean, waitedMs: number }> {
  const timers = options.timers ?? realTimers()
  const setTimer = timers.setTimeout
  if (!setTimer) {
    throw new TypeError('fake-c8y: waiting needs setTimeout, which this runtime does not have')
  }
  const interval = options.interval ?? 2
  const needed = Math.max(2, Math.ceil(options.quietMs / interval))
  const start = timers.now()
  let slept = 0
  let quietChecks = 0
  const elapsed = () => Math.max(timers.now() - start, slept)
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
 * has the counts of what was still open at the last check, the same ones the
 * message lists.
 */
export class SettleTimeoutError extends Error {
  override readonly name = 'SettleTimeoutError'
  /**
   * Counts of what was still open when the wait gave up: the fields of
   * `realtime.status()` for `settled()`, `inflight` and `scheduled` for
   * `idle()`, and `inflight`, `scheduled`, `connecting`, and
   * `unconnectedTokens` (a count) for `waitForRealtimeStartup()`.
   */
  readonly status: Readonly<Record<string, number>>

  constructor(what: string, timeout: number, status: Readonly<Record<string, number>>, detail = '') {
    const open = Object.entries(status).filter(([, count]) => count > 0).map(([field, count]) => `${field} ${count}`)
    super(`fake-c8y: ${what} timed out after ${timeout} ms (${open.length > 0 ? open.join(', ') : 'nothing open at the last check'})${detail}`)
    this.status = status
  }
}
