import { parseIsoTime } from './utils'

/**
 * A clock for one trial: the world, the agent's sandbox, and the grader read
 * the same time from it.
 */
export interface Clock {
  /**
   * Current time in epoch milliseconds. A plain function, so it can be passed
   * on as `now: clock.now`.
   */
  now: () => number
  /**
   * Jumps forward (or back, with a negative value) by `ms` milliseconds.
   */
  advance: (ms: number) => void
  /**
   * Jumps to a time; with `realtime`, the clock keeps running from there.
   */
  set: (time: number | string) => void
  /**
   * A new clock at the same time that runs the same way and moves on its
   * own (`world.fork()` gives a fork without a clock of its own this copy).
   * Optional for clocks not made by `createClock()`.
   */
  copy?: () => Clock
}

export interface ClockOptions {
  /**
   * Time the clock starts at: epoch milliseconds or an ISO date.
   */
  start: number | string
  /**
   * Whether the clock runs with wall time after `start`. If `false` it stands
   * still and moves only by `advance()` and `set()`.
   * @default true
   */
  realtime?: boolean
}

/**
 * Creates a clock for one trial. It starts at a fixed time, so data seeded
 * relative to `start` (an alarm "yesterday", measurements of "the last 7
 * days") means the same thing in every trial, however late the trial runs.
 *
 * Use the same clock everywhere the trial reads time: pass it to the world or
 * fork (`createWorld({ clock })`, `base.fork({ clock })`), make it the agent's
 * `Date` and `Date.now` in its sandbox, and grade relative to it. If the
 * sandbox runs on wall time while the world runs on the clock, "yesterday" in
 * the agent's code points at a different day than the data.
 * @param options - Start time and whether the clock runs
 * @example
 * ```ts
 * const clock = createClock({ start: '2026-10-24T00:00:00Z' })
 * const trial = base.fork({ clock })
 * await runAgent(trial, { now: clock.now })
 * trial.advance(60 * 60_000) // settle: bulk operations run up to an hour later
 * grade(trial.diff())
 * ```
 */
export function createClock(options: ClockOptions): Clock {
  const realtime = options.realtime ?? true
  const toMs = (time: number | string) => {
    const ms = typeof time === 'number' ? time : parseIsoTime(time)
    if (Number.isNaN(ms)) {
      throw new TypeError(`fake-c8y: invalid clock time ${String(time)}`)
    }
    return ms
  }
  // the clock's time at the wall time `since` (realtime) or always (frozen)
  let at = toMs(options.start)
  let since = Date.now()
  const now = () => (realtime ? at + Date.now() - since : at)
  return {
    now,
    copy: () => createClock({ start: now(), realtime }),
    advance: (ms) => {
      at += ms
    },
    set: (time) => {
      at = toMs(time)
      since = Date.now()
    },
  }
}
