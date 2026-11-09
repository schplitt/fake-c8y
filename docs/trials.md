# Trials

An eval runs many trials against the same world, often at the same time. Load the world once, then give every trial a fork:

```ts
import { createWorld } from 'fake-c8y'

const base = createWorld()
loadMyWorld(base) // devices, measurements, users, ...

const results = await Promise.all(questions.map(async (question) => {
  const trial = base.fork({ unsupported: 'platform' })
  await runAgent(trial, question)
  return { question, coverage: trial.coverage(), changes: trial.diff() }
}))
```

## Forks

`world.fork(options?)` returns a new world on top of this one.

- It reads the base's data and writes only to its own copy-on-write overlay. A deleted document leaves a tombstone that hides it in every list, count, query, paging total, child and parent reference, and identity lookup. Lists keep the order a plain world with the same history would have.
- It starts with the base's tenant, user, subscriptions, overrides, services, and next id. It has its own ids, clock, call log, `unhandled` list, overrides, and Notification 2.0 state.
- Forks of the same base do not see each other and hand out the same ids, so trials are deterministic.
- A fork can be forked again.
- `fork()` takes `now`, `clock`, `schedule`, `unsupported`, `onUnsupported`, and `onChange`. Each defaults to the base's. Callbacks get the fork as their world.

The first `fork()` freezes the base (`frozen` is then `true`). Writes to it throw (requests, `device()`, `seed()`, `setUser()`, `reset()`), and its time-based work stops. Reads still work. Load everything before you fork. `override()` and `service()` still work on a frozen base, for the forks created afterwards.

A fork costs a few microseconds and a few kilobytes, whatever the size of the base. Measured with `node --expose-gc scripts/bench-fork.ts <fixtures dir>` at 1,039 devices and 215k measurements: a fork takes 5 µs, a typical write 55 µs, a fork's `diff()` 13 µs, and `reset()` 3 µs, and 100 live forks with one write each take 26 KB each. A full snapshot of the same world takes 230 ms, a restore 240 ms, and a snapshot diff 490 ms.

## Reset

`world.reset(baseline?)` goes back to the baseline: data (also service state, Notification 2.0 subscriptions and tokens), tenant options, overrides, call log, and ids. Registered services stay, and a root world installs them and applies their definition seeds again ([Services](services.md#seeding)). Undelivered notifications are dropped, and sockets whose token is gone are closed. A request still in flight answers 503 and changes nothing.

On a fork, `reset()` goes back to the state the fork started in: its own writes, ids, overrides, and call log are dropped. A clock the fork got as a copy of the base's goes back to the fork's start time, so a replay gets the same ids and times. A clock you passed to `fork({ clock })` stays where it is. A `baseline` is applied on top.

## Snapshots and diffs

`world.snapshot()` returns the data and platform state as plain JSON, with Notification 2.0 subscriptions and tokens, but without overrides and sockets. `world.restore(snapshot)` puts it back. You can store a snapshot as a fixture.

`world.diff(snapshot)` lists what changed since a snapshot, per tenant (`tenants`) and for tenant options (`options`):

- created, updated (with `before` and `after`), and deleted documents per collection;
- external ids, child references (`relations`), service state (`serviceState`), applications and subscriptions, Notification 2.0 subscriptions, and deletes of generated measurements (`deletedMeasurementRanges`);
- audit records as a collection of their own (`auditRecords`), so a grader can check or ignore them.

```ts
const before = world.snapshot()
await runAgent(world)
const { tenants } = world.diff(before)
expect(tenants.t12345?.alarms.updated).toMatchObject([{ after: { status: 'ACKNOWLEDGED' } }])
```

On a fork, `diff()` without an argument lists what the fork changed in its base. It reads only the overlay, so its cost grows with the changes, not with the data. It equals `diff(base.snapshot())`, except that a key deleted and set again (a user, a tenant option) shows as deleted and created, which a snapshot diff cannot see.

## The clock

A question like "alarms of the last 7 days" grades the same way in every trial only if the world, the agent, and the grader agree on the time. `createClock()` gives one clock per trial:

```ts
import { createClock } from 'fake-c8y'

const clock = createClock({ start: '2026-10-24T00:00:00Z' }) // epoch ms also works
const trial = base.fork({ clock })
await runAgent(trial, { now: clock.now }) // make the sandbox's Date read clock.now()
trial.advance(60 * 60_000) // run the work that is due, e.g. bulk operations
grade(trial.diff(), clock.now())
```

- `clock.now()` is `start` plus the wall time since. With `realtime: false` the clock stands still and moves only by `clock.advance(ms)` and `clock.set(time)`.
- `world.tick()` runs the time-based work due by the world's clock: bulk operations create their operations, and monitored devices turn UNAVAILABLE. The world also ticks before every request and every `db` access, so `clock.advance()` alone is enough while the agent runs.
- `world.advance(ms)` moves the world's `clock` and ticks at once, which matters before `diff()` and `snapshot()`. It throws if the world has no `clock`.
- A fork of a base with a `clock` gets its own copy, so `fork.advance()` moves only that fork. A fork's own `now` replaces the base's `clock`.
- Use the same clock for the sandbox's `Date` and for grading. If the agent's code runs on wall time while the data is anchored to `start`, "yesterday" points at a day without data. Seed data relative to `start`, so it lands in the same windows in every trial.

Availability monitoring runs on the clock too. Every device with `c8y_RequiredAvailability` and no data within its interval turns UNAVAILABLE, with an alarm and an audit record, and these show in `diff()` next to the agent's changes. Advancing a world of 100,000 monitored devices without data by 2 hours adds 100,000 managed object updates, 100,000 alarms, and 100,000 audit records. Only real switches are stored, so the diff is the same however often the clock was advanced. Grade the documents the task is about, or seed `c8y_Availability` and data that keep the other devices AVAILABLE for the trial. The rules are in [Emulated API](emulated-api.md#availability).
