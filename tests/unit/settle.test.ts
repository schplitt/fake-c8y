/**
 * Waiting for a world's background work: `realtime.status()`,
 * `realtime.settled()`, `world.idle()`, and `waitForRealtimeStartup()`, all
 * on the real timers (also under `vi.useFakeTimers()`), also on forks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorld, SettleTimeoutError } from '../../src'
import type { World } from '../../src'
import { createFakeWebSocket, waitForRealtimeStartup } from '../../src/realtime-entry'
import { scheduleWith, timerSource, waitForQuiet } from '../../src/timers'

async function call(world: World, method: string, path: string, body?: unknown) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, {
    method,
    headers: { 'accept': 'application/json', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

/**
 * A consumer of one subscription: `onFrame` runs for every frame; the frame
 * is acknowledged after it resolves (unless `ack` is false).
 * @param world
 * @param subscription
 * @param onFrame
 * @param ack
 */
async function consume(world: World, subscription: string, onFrame: (text: string) => Promise<void> | void = () => {}, ack = true) {
  const token = (await call(world, 'POST', '/notification2/token', { subscription, subscriber: 's' })).body.token as string
  const WebSocket = createFakeWebSocket(world.realtime)
  const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
  const received: string[] = []
  socket.on('message', async (text: string) => {
    received.push(text)
    await onFrame(text)
    if (ack) {
      socket.send(text.split('\n')[0])
    }
  })
  await new Promise<void>((resolve) => {
    socket.on('open', () => resolve())
  })
  return { socket, received }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('realtime.status()', () => {
  it('counts the backlog of a subscription without a token as unclaimed, not in pending()', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'nobody' })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'held' })
    expect(world.realtime.status()).toMatchObject({ backlog: 0, unclaimed: 1, unacknowledged: 0 })
    expect(world.realtime.pending()).toBe(0)
    // a token claims it: now it is backlog, on its way to the consumer
    await call(world, 'POST', '/notification2/token', { subscription: 'nobody', subscriber: 's' })
    expect(world.realtime.status()).toMatchObject({ backlog: 1, unclaimed: 0 })
    expect(world.realtime.pending()).toBe(1)
  })

  it('counts every scheduled callback, also socket connects and events', async () => {
    const queue: Array<() => void> = []
    const world = createWorld({ schedule: (callback) => queue.push(callback) })
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 's' })).body.token as string
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    expect(world.realtime.status()).toMatchObject({ scheduled: 1, connecting: 1 })
    queue.shift()!()
    expect(world.realtime.status()).toMatchObject({ scheduled: 0, connecting: 0 })
    socket.ping()
    expect(world.realtime.status().scheduled).toBe(1)
    queue.shift()!()
    expect(world.realtime.status().scheduled).toBe(0)
  })
})

describe('realtime.settled()', () => {
  it('waits for notifications caused by the consumer\'s own writes', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub', subscriptionFilter: { apis: ['managedobjects'] } })
    const handled: string[] = []
    await consume(world, 'sub', async (text) => {
      const { name } = JSON.parse(text.split('\n').slice(4).join('\n')) as { name: string }
      // slow handler, which writes once more for the first object
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
      if (name === 'first') {
        await call(world, 'POST', '/inventory/managedObjects', { name: 'caused by first' })
      }
      handled.push(name)
    })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'first' })
    await world.realtime.settled()
    expect(handled).toEqual(['first', 'caused by first'])
    expect(world.realtime.pending()).toBe(0)
  })

  it('works under fake timers', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const { received } = await consume(world, 'sub')
    vi.useFakeTimers()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'during fake timers' })
    await world.realtime.settled({ timeout: 1000 })
    expect(received).toHaveLength(1)
  })

  it('times out under fake timers', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    await consume(world, 'sub', () => {}, false)
    vi.useFakeTimers()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'never acknowledged' })
    await expect(world.realtime.settled({ timeout: 50 })).rejects.toThrow('fake-c8y: realtime.settled() timed out after 50 ms (unacknowledged 1)')
  })

  it('rejects with what is left when a consumer never acknowledges', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    await consume(world, 'sub', () => {}, false)
    await call(world, 'POST', '/inventory/managedObjects', { name: 'never acknowledged' })
    const error = await world.realtime.settled({ timeout: 50 }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SettleTimeoutError)
    expect((error as SettleTimeoutError).message).toBe('fake-c8y: realtime.settled() timed out after 50 ms (unacknowledged 1)')
    expect((error as SettleTimeoutError).status).toMatchObject({ unacknowledged: 1 })
  })

  it('waits for unclaimed frames by default and reports them with unclaimed: ignore', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'nobody' })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'held' })
    await expect(world.realtime.settled({ timeout: 50 })).rejects.toThrow(
      new RegExp(`^fake-c8y: realtime\\.settled\\(\\) timed out after 50 ms \\(unclaimed 1\\); no consumer has a token for ${world.tenant}/nobody: connect one, or pass unclaimed: 'ignore'$`),
    )
    const ignored = await world.realtime.settled({ timeout: 200, unclaimed: 'ignore' })
    expect(ignored.status).toMatchObject({ unclaimed: 1, backlog: 0 })
  })

  it('waits for a consumer that mints its token after the write', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'late' })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'before the token' })
    const waiting = world.realtime.settled({ timeout: 2000 })
    // the client mints its token only after a backoff, longer than the quiet window
    await new Promise((resolve) => {
      setTimeout(resolve, 60)
    })
    const { received } = await consume(world, 'late')
    const { status } = await waiting
    expect(received).toHaveLength(1)
    expect(status).toEqual({ inflight: 0, scheduled: 0, connecting: 0, unacknowledged: 0, backlog: 0, unclaimed: 0 })
  })

  it('waits for a write after a longer await with a larger quietMs', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub', subscriptionFilter: { apis: ['managedobjects'] } })
    const names: string[] = []
    await consume(world, 'sub', (text) => {
      const { name } = JSON.parse(text.split('\n').slice(4).join('\n')) as { name: string }
      names.push(name)
      if (name === 'first') {
        // acknowledged at once, written 40 ms later
        setTimeout(() => {
          call(world, 'POST', '/inventory/managedObjects', { name: 'late write' })
        }, 40)
      }
    })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'first' })
    await world.realtime.settled({ quietMs: 100 })
    expect(names).toEqual(['first', 'late write'])
  })

  it('settles a fork on its own', async () => {
    const base = createWorld()
    await call(base, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const fork = base.fork()
    const { received } = await consume(fork, 'sub')
    await call(fork, 'POST', '/inventory/managedObjects', { name: 'in the fork' })
    await fork.realtime.settled()
    expect(received).toHaveLength(1)
    expect(base.realtime.status()).toMatchObject({ unclaimed: 0, backlog: 0 })
  })
})

describe('world.idle()', () => {
  it('waits for a request in flight', async () => {
    const world = createWorld()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    world.override('GET /inventory/managedObjects', async (_request, ctx) => {
      await gate
      return ctx.next()
    })
    const slow = call(world, 'GET', '/inventory/managedObjects')
    await expect(world.idle({ timeout: 50 })).rejects.toThrow(/^fake-c8y: world\.idle\(\) timed out after 50 ms \(inflight 1\)$/)
    const idle = world.idle({ timeout: 2000 })
    release()
    await idle
    expect((await slow).status).toBe(200)
  })

  it('works under fake timers and counts only the fork\'s own work', async () => {
    const base = createWorld()
    const fork = base.fork()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fork.override('GET /inventory/managedObjects', async (_request, ctx) => {
      await gate
      return ctx.next()
    })
    vi.useFakeTimers()
    const slow = call(fork, 'GET', '/inventory/managedObjects')
    await base.idle({ timeout: 1000 })
    await expect(fork.idle({ timeout: 50 })).rejects.toBeInstanceOf(SettleTimeoutError)
    release()
    await slow
    await fork.idle({ timeout: 1000 })
  })
})

describe('world.idle() with a custom schedule', () => {
  it('ignores frames that are delivered and not acknowledged', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    await consume(world, 'sub', () => {}, false)
    await call(world, 'POST', '/inventory/managedObjects', { name: 'never acknowledged' })
    await world.idle({ timeout: 1000 })
    expect(world.realtime.status()).toMatchObject({ unacknowledged: 1, scheduled: 0 })
  })

  it('is not idle while a schedule that never calls back holds work, until a reset', async () => {
    const world = createWorld({ schedule: () => {} })
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 's' })).body.token as string
    const WebSocket = createFakeWebSocket(world.realtime)
    const pending = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    expect(pending.readyState).toBe(WebSocket.CONNECTING)
    await expect(world.idle({ timeout: 30 })).rejects.toThrow(/^fake-c8y: world\.idle\(\) timed out after 30 ms \(scheduled 1\)$/)
    world.reset()
    await world.idle({ timeout: 1000 })
    expect(world.realtime.status().scheduled).toBe(0)
  })

  it('does not count a queue discarded after a reset, also when it runs later', async () => {
    const queue: Array<() => void> = []
    const world = createWorld({ schedule: (callback) => queue.push(callback) })
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 's' })).body.token as string
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    queue.shift()!()
    socket.ping()
    expect(world.realtime.status().scheduled).toBe(1)
    world.reset()
    expect(world.realtime.status().scheduled).toBe(0)
    await world.idle({ timeout: 1000 })
    // the old callback runs after all: the count stays at 0, not -1
    queue.shift()!()
    expect(world.realtime.status().scheduled).toBe(0)
  })
})

describe('timers', () => {
  it('times out under a frozen Date by the time slept', async () => {
    const real = timerSource(globalThis)
    const frozen = { setTimeout: real.setTimeout, now: () => 0, fake: false }
    const result = await waitForQuiet(() => false, { timeout: 30, quietMs: 10, timers: frozen })
    expect(result).toEqual({ quiet: false, waitedMs: 30 })
  })

  it('schedules after the microtasks without setTimeout, and refuses to wait', async () => {
    const timers = timerSource({ Date })
    expect(timers.setTimeout).toBeUndefined()
    let ran = false
    scheduleWith(timers, () => {
      ran = true
    })
    expect(ran).toBe(false)
    await Promise.resolve()
    expect(ran).toBe(true)
    await expect(waitForQuiet(() => true, { timeout: 10, quietMs: 1, timers })).rejects.toThrow('fake-c8y: waiting needs setTimeout, which this runtime does not have')
  })

  it('recognizes fake timers', () => {
    expect(timerSource(globalThis).fake).toBe(false)
    vi.useFakeTimers()
    expect(timerSource(globalThis).fake).toBe(true)
  })
})

describe('waitForRealtimeStartup()', () => {
  it('works under fake timers', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    await consume(world, 'sub')
    vi.useFakeTimers()
    const result = await waitForRealtimeStartup(world.realtime, () => world.inflight, 1000)
    expect(result).toMatchObject({ settled: true, unconnectedTokens: [] })
  })

  it('reports a timeout instead of returning silently', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 'neverConnects' })
    const result = await waitForRealtimeStartup(world.realtime, () => world.inflight, 50)
    expect(result.settled).toBe(false)
    expect(result.waitedMs).toBeGreaterThanOrEqual(50)
    expect(result.unconnectedTokens).toEqual([{ tenant: world.tenant, subscription: 'sub', subscriber: 'neverConnects' }])
    await expect(waitForRealtimeStartup(world.realtime, () => world.inflight, { timeout: 50, onTimeout: 'throw' }))
      .rejects
      .toThrow(new RegExp(`^fake-c8y: waitForRealtimeStartup\\(\\) timed out after 50 ms \\(unconnectedTokens 1\\); tokens without a connected consumer: ${world.tenant}/sub/neverConnects$`))
  })
})
