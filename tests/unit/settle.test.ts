/**
 * Waiting for a world's background work: `realtime.status()`,
 * `realtime.settled()`, `realtime.consumers()`, and `world.idle()`, all on
 * the real timers (also under `vi.useFakeTimers()`), also on forks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorld, SettleTimeoutError } from '../../src'
import type { World } from '../../src'
import { createFakeWebSocket } from '../../src/realtime-entry'
import { realNow, scheduleWith, timerSource, waitForQuiet } from '../../src/timers'

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
 * @param subscriber
 */
async function consume(world: World, subscription: string, onFrame: (text: string) => Promise<void> | void = () => {}, ack = true, subscriber = 's') {
  const token = (await call(world, 'POST', '/notification2/token', { subscription, subscriber })).body.token as string
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
  return { socket, received, token }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('realtime.status()', () => {
  it('reports stored frames as backlog, never as unclaimed, and pending() leaves them out', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'nobody' })
    // no consumer has connected yet: nothing is kept
    await call(world, 'POST', '/inventory/managedObjects', { name: 'dropped' })
    expect(world.realtime.status()).toMatchObject({ backlog: 0, unclaimed: 0, unacknowledged: 0 })
    const { socket } = await consume(world, 'nobody')
    socket.close()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'held' })
    expect(world.realtime.status()).toMatchObject({ backlog: 1, unclaimed: 0, unacknowledged: 0 })
    await world.realtime.settled({ timeout: 1000 })
    expect(world.realtime.pending()).toBe(0)
  })

  it('counts a connecting socket in pending()', async () => {
    const queue: Array<() => void> = []
    const world = createWorld({ schedule: (callback) => queue.push(callback) })
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 's' })).body.token as string
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    // the connect callback (scheduled 1) and the socket (connecting 1)
    expect(world.realtime.pending()).toBe(2)
    queue.shift()!()
    expect(world.realtime.pending()).toBe(world.realtime.status().scheduled)
    expect(socket.readyState).toBe(WebSocket.OPEN)
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

  it('does not wait for a token whose consumer is gone (issue #31)', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'stopped' })
    // a service that stopped: no socket will ever connect with its token again
    const { socket } = await consume(world, 'stopped')
    socket.close()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'for nobody' })
    const { status, waitedMs } = await world.realtime.settled({ timeout: 1000 })
    expect(waitedMs).toBeLessThan(500)
    expect(status).toMatchObject({ backlog: 1, unclaimed: 0 })
    expect(world.realtime.status().backlog).toBe(1)
    expect(world.realtime.pending()).toBe(0)
  })

  it('keeps nothing for a subscription no consumer has connected to', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'nobody' })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'dropped' })
    const { status } = await world.realtime.settled({ timeout: 1000 })
    expect(status).toMatchObject({ unclaimed: 0, backlog: 0 })
  })

  it('stays busy until an open consumer acknowledges', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { received } = await consume(world, 'sub', () => gate)
    await call(world, 'POST', '/inventory/managedObjects', { name: 'held by the handler' })
    await expect(world.realtime.settled({ timeout: 50 })).rejects.toThrow('fake-c8y: realtime.settled() timed out after 50 ms (unacknowledged 1)')
    const settled = world.realtime.settled({ timeout: 2000 })
    release()
    const { status } = await settled
    expect(received).toHaveLength(1)
    expect(status).toEqual({ inflight: 0, scheduled: 0, connecting: 0, unacknowledged: 0, backlog: 0, unclaimed: 0 })
  })

  it('delivers the backlog to a consumer that connects later, polled with consumers()', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'late' })
    // connected once, so the subscription keeps a backlog
    const first = await consume(world, 'late')
    first.socket.close()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'before the consumer' })
    await world.realtime.settled({ timeout: 1000 })
    expect(world.realtime.status().backlog).toBe(1)
    // the client connects only after a backoff, longer than the quiet window
    let received: string[] = []
    setTimeout(() => {
      consume(world, 'late').then((consumer) => {
        received = consumer.received
      })
    }, 60)
    await expect.poll(() => world.realtime.consumers({ subscription: 'late' }).length).toBe(1)
    const { status } = await world.realtime.settled({ timeout: 2000 })
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

  it('waits for a consumer that reconnects after reset({ consumers: \'keep\' }), then for its ack', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const first = await consume(world, 'startup')
    const startup = world.checkpoint()
    // the socket dropped and the client is in its backoff when the reset comes
    first.socket.close()
    world.reset({ to: startup, consumers: 'keep' })
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'startup', subscriber: 's' })).body.token as string
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    const received: string[] = []
    socket.on('message', (text: string) => {
      received.push(text)
      socket.send(text.split('\n')[0])
    })
    expect(world.realtime.status().connecting).toBe(1)
    await world.realtime.settled({ timeout: 2000 })
    expect(world.realtime.consumers({ subscription: 'startup' })).toEqual([{ tenant: world.tenant, subscription: 'startup', subscriber: 's', token }])
    await call(world, 'POST', '/inventory/managedObjects', { name: 'after the reconnect' })
    const { status } = await world.realtime.settled({ timeout: 2000 })
    expect(received).toHaveLength(1)
    expect(status).toMatchObject({ connecting: 0, unacknowledged: 0, backlog: 0 })
  })

  it('waits for the ack of a new consumer next to a stale token of the same subscription', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    // the token of a consumer that is gone: no socket uses it
    await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 'gone' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { received } = await consume(world, 'sub', () => gate, true, 'new')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'for the new consumer' })
    await expect(world.realtime.settled({ timeout: 50 })).rejects.toThrow('fake-c8y: realtime.settled() timed out after 50 ms (unacknowledged 1)')
    const settled = world.realtime.settled({ timeout: 2000 })
    release()
    const { status } = await settled
    expect(received).toHaveLength(1)
    expect(status).toMatchObject({ unacknowledged: 0, backlog: 0, unclaimed: 0 })
  })
})

describe('realtime.consumers()', () => {
  it('lists open sockets, filtered like closeConsumers(), and drops closed ones', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'a' })
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'b' })
    const first = await consume(world, 'a', undefined, true, 'one')
    const second = await consume(world, 'b', undefined, true, 'two')
    // a token without a socket is not a consumer
    await call(world, 'POST', '/notification2/token', { subscription: 'a', subscriber: 'never' })
    expect(world.realtime.consumers()).toEqual([
      { tenant: world.tenant, subscription: 'a', subscriber: 'one', token: first.token },
      { tenant: world.tenant, subscription: 'b', subscriber: 'two', token: second.token },
    ])
    expect(world.realtime.consumers({ subscription: 'b' })).toEqual([{ tenant: world.tenant, subscription: 'b', subscriber: 'two', token: second.token }])
    expect(world.realtime.consumers({ subscriber: 'one', token: first.token })).toHaveLength(1)
    expect(world.realtime.consumers({ subscriber: 'one', token: second.token })).toEqual([])
    expect(world.realtime.consumers({ tenant: 'other' })).toEqual([])
    // plain new objects
    world.realtime.consumers()[0]!.subscriber = 'changed'
    expect(world.realtime.consumers()[0]!.subscriber).toBe('one')
    world.realtime.closeConsumers({ subscription: 'a' })
    second.socket.close()
    expect(world.realtime.consumers()).toEqual([])
  })

  it('lists only a fork\'s own sockets on the fork', async () => {
    const base = createWorld()
    await call(base, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const inBase = await consume(base, 'sub', undefined, true, 'base')
    const fork = base.fork()
    const inFork = await consume(fork, 'sub', undefined, true, 'fork')
    expect(fork.realtime.consumers()).toEqual([{ tenant: fork.tenant, subscription: 'sub', subscriber: 'fork', token: inFork.token }])
    expect(base.realtime.consumers()).toEqual([{ tenant: base.tenant, subscription: 'sub', subscriber: 'base', token: inBase.token }])
  })

  it('leaves out sockets still connecting', async () => {
    const queue: Array<() => void> = []
    const world = createWorld({ schedule: (callback) => queue.push(callback) })
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 's' })).body.token as string
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    expect(socket.readyState).toBe(WebSocket.CONNECTING)
    expect(world.realtime.consumers()).toEqual([])
    queue.shift()!()
    expect(world.realtime.consumers()).toEqual([{ tenant: world.tenant, subscription: 'sub', subscriber: 's', token }])
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

  it('keeps realNow() on the real time under fake timers (idle sockets)', () => {
    const before = realNow()
    vi.useFakeTimers()
    vi.advanceTimersByTime(10 * 60_000)
    expect(Date.now() - before).toBeGreaterThanOrEqual(10 * 60_000)
    expect(realNow() - before).toBeLessThan(60_000)
  })

  it('recognizes fake timers', () => {
    expect(timerSource(globalThis).fake).toBe(false)
    vi.useFakeTimers()
    expect(timerSource(globalThis).fake).toBe(true)
  })
})
