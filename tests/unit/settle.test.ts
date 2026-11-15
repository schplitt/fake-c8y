/**
 * Waiting for a world's background work: `realtime.status()`,
 * `realtime.settled()`, `world.idle()`, and `waitForRealtimeStartup()`, all
 * on the real timers (also under `vi.useFakeTimers()`), also on forks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorld, SettleTimeoutError } from '../../src'
import type { World } from '../../src'
import { createFakeWebSocket, waitForRealtimeStartup } from '../../src/realtime-entry'

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

  it('rejects with what is left when a consumer never acknowledges', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    await consume(world, 'sub', () => {}, false)
    await call(world, 'POST', '/inventory/managedObjects', { name: 'never acknowledged' })
    const error = await world.realtime.settled({ timeout: 50 }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SettleTimeoutError)
    expect((error as SettleTimeoutError).message).toMatch(/realtime\.settled\(\) timed out after 50 ms \(unacknowledged 1\)/)
    expect((error as SettleTimeoutError).status).toMatchObject({ unacknowledged: 1 })
  })

  it('ignores unclaimed frames by default and waits for them with unclaimed: wait', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'nobody' })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'held' })
    await world.realtime.settled({ timeout: 200 })
    await expect(world.realtime.settled({ timeout: 50, unclaimed: 'wait' })).rejects.toThrow(/unclaimed 1/)
    // a consumer that connects later claims and acknowledges it
    const waiting = world.realtime.settled({ timeout: 2000, unclaimed: 'wait' })
    const { received } = await consume(world, 'nobody')
    await waiting
    expect(received).toHaveLength(1)
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
    await expect(world.idle({ timeout: 50 })).rejects.toThrow(/world\.idle\(\) timed out after 50 ms \(inflight 1\)/)
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
    const result = await waitForRealtimeStartup(world.realtime, () => world.inflight, { timeout: 50 })
    expect(result.settled).toBe(false)
    expect(result.waitedMs).toBeGreaterThanOrEqual(50)
    expect(result.unconnectedTokens).toEqual([{ tenant: world.tenant, subscription: 'sub', subscriber: 'neverConnects' }])
    await expect(waitForRealtimeStartup(world.realtime, () => world.inflight, { timeout: 50, onTimeout: 'throw' }))
      .rejects
      .toThrow(/waitForRealtimeStartup\(\) timed out after 50 ms \(unconnectedTokens 1\); tokens without a connected consumer: t12345\/sub\/neverConnects/)
  })
})
