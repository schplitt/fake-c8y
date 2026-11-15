/**
 * Notification 2.0 subscriptions and tokens are tenant data: forks inherit
 * them, `reset()` drops the ones written since, `restore()` brings back the
 * ones of the snapshot, and `snapshot()`/`diff()` contain them. Frames on
 * their way are dropped by a reset.
 */
import { describe, expect, it } from 'vitest'
import { CONSUMER_REMOVED, createWorld } from '../../src'
import type { World } from '../../src'
import { createFakeWebSocket } from '../../src/realtime-entry'

async function call(world: World, method: string, path: string, body?: unknown) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, {
    method,
    headers: { 'accept': 'application/json', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

const names = async (world: World) => (await call(world, 'GET', '/notification2/subscriptions')).body.subscriptions.map((item: { subscription: string }) => item.subscription)

/**
 * A world whose scheduled callbacks run only when `run()` is called.
 */
function manualWorld() {
  const queue: Array<() => void> = []
  const world = createWorld({ schedule: (callback) => queue.push(callback) })
  const run = () => {
    while (queue.length > 0) {
      queue.shift()!()
    }
  }
  return { world, run }
}

describe('notification 2.0 state', () => {
  it('is inherited by forks, with ids that go on from the base', async () => {
    const base = createWorld()
    expect((await call(base, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'baseSub' })).status).toBe(201)
    const fork = base.fork()
    expect(await names(fork)).toEqual(['baseSub'])
    const created = await call(fork, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'forkSub' })
    expect(created.body.id).not.toBe('1')
    expect(await names(fork)).toEqual(['baseSub', 'forkSub'])
    expect(await names(base)).toEqual(['baseSub'])
    expect((await call(fork, 'DELETE', '/notification2/subscriptions/1')).status).toBe(204)
    expect(await names(fork)).toEqual(['forkSub'])
    expect(await names(base)).toEqual(['baseSub'])
  })

  it('is dropped by reset, on a fork and on a plain world', async () => {
    const base = createWorld()
    await call(base, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'baseSub' })
    const fork = base.fork()
    await call(fork, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'agentSub' })
    const token = (await call(fork, 'POST', '/notification2/token', { subscription: 'agentSub', subscriber: 'a' })).body.token
    fork.reset()
    expect(await names(fork)).toEqual(['baseSub'])
    expect(fork.realtime.tokens.has(token)).toBe(false)
    // the same request answers the same after a reset
    expect((await call(fork, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'agentSub' })).status).toBe(201)
    expect((await call(fork, 'POST', '/notification2/token', { subscription: 'agentSub', subscriber: 'a' })).body.token).toBe(token)

    const plain = createWorld()
    await call(plain, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    plain.reset()
    expect(await names(plain)).toEqual([])
  })

  it('is in snapshot, restore, and diff', async () => {
    const base = createWorld()
    const fork = base.fork()
    await call(fork, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'agentSub' })
    await call(fork, 'POST', '/notification2/token', { subscription: 'agentSub', subscriber: 'a' })
    const diff = fork.diff()
    expect(diff.tenants[fork.tenant]!.notificationSubscriptions.created.map((item) => item.subscription)).toEqual(['agentSub'])
    expect(diff).toEqual(fork.diff(base.snapshot()))

    const snapshot = JSON.parse(JSON.stringify(fork.snapshot()))
    expect(snapshot.tenants[0].notificationSubscriptions).toHaveLength(1)
    expect(snapshot.tenants[0].notificationTokens).toHaveLength(1)
    const restored = createWorld()
    restored.restore(snapshot)
    expect(await names(restored)).toEqual(['agentSub'])
    expect(restored.realtime.tokens.size).toBe(1)
    expect(restored.snapshot()).toEqual(snapshot)

    fork.reset()
    fork.restore(snapshot)
    expect(await names(fork)).toEqual(['agentSub'])
  })

  it('goes with a deleted managed object', async () => {
    const world = createWorld()
    const device = world.device()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'mo', subscription: 'sub', source: { id: device } })
    expect((await call(world, 'DELETE', `/inventory/managedObjects/${device}`)).status).toBe(204)
    expect(await names(world)).toEqual([])
  })

  it('drops frames scheduled before a reset and closes sockets whose token is gone', async () => {
    const { world, run } = manualWorld()
    const base = world
    await call(base, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const token = (await call(base, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 'a' })).body.token
    const WebSocket = createFakeWebSocket(base.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    const received: string[] = []
    let closed: unknown[] | undefined
    socket.on('message', (text: string) => received.push(text))
    socket.on('close', (...args: unknown[]) => {
      closed = args
    })
    run()
    expect(socket.readyState).toBe(1)

    await call(base, 'POST', '/inventory/managedObjects', { name: 'from trial 1' })
    expect(base.realtime.pending()).toBe(1)
    base.reset()
    expect(base.realtime.pending()).toBe(0)
    run()
    expect(received).toEqual([])
    // a plain world's reset drops the token too, so its socket is closed
    // with the code that tells the client not to reconnect
    expect(closed).toEqual([CONSUMER_REMOVED.code, CONSUMER_REMOVED.reason])
    expect(CONSUMER_REMOVED.code).toBe(4410)
  })

  it('closes sockets whose token a restore removed with CONSUMER_REMOVED', async () => {
    const { world, run } = manualWorld()
    const snapshot = world.snapshot()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 'a' })).body.token
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    const closes: unknown[][] = []
    socket.on('close', (...args: unknown[]) => closes.push(args))
    run()
    world.restore(snapshot)
    expect(closes).toEqual([[4410, 'notification token removed']])
    expect(socket.readyState).toBe(3)
  })
})

describe('closeConsumers()', () => {
  async function open(world: World, run: () => void, subscription: string, subscriber: string) {
    const token = (await call(world, 'POST', '/notification2/token', { subscription, subscriber })).body.token as string
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    const closes: unknown[][] = []
    const received: string[] = []
    socket.on('close', (...args: unknown[]) => closes.push(args))
    socket.on('message', (text: string) => received.push(text))
    run()
    expect(socket.readyState).toBe(1)
    return { token, socket, closes, received }
  }

  it('closes matching open sockets with the given code and reason, and keeps their tokens', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'one' })
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'two' })
    const a = await open(world, run, 'one', 'a')
    const b = await open(world, run, 'two', 'b')
    expect(world.realtime.closeConsumers({ subscription: 'one', code: 1011, reason: 'internal error' })).toBe(1)
    expect(a.closes).toEqual([[1011, 'internal error']])
    expect(a.socket.readyState).toBe(3)
    expect(b.closes).toEqual([])
    expect(world.realtime.sockets.size).toBe(1)
    // the subscription and token stay: the client can reconnect with the same token
    expect(world.realtime.tokens.has(a.token)).toBe(true)
    // frames of a persistent subscription wait for the reconnect
    await call(world, 'POST', '/inventory/managedObjects', { name: 'while away' })
    run()
    expect(a.received).toEqual([])
    const WebSocket = createFakeWebSocket(world.realtime)
    const again = new WebSocket(`wss://example.test/notification2/consumer/?token=${a.token}`)
    const received: string[] = []
    again.on('message', (text: string) => received.push(text))
    run()
    expect(again.readyState).toBe(1)
    expect(received).toHaveLength(1)
    expect(received[0]).toContain('while away')
  })

  it('defaults to 1006 for every open socket, filters by tenant, subscriber, and token, and rejects invalid codes', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const a = await open(world, run, 'sub', 'a')
    const b = await open(world, run, 'sub', 'b')
    const c = await open(world, run, 'sub', 'c')
    expect(world.realtime.closeConsumers({ tenant: 'other' })).toBe(0)
    expect(world.realtime.closeConsumers({ subscriber: 'a', code: 4000 })).toBe(1)
    expect(a.closes).toEqual([[4000, '']])
    expect(world.realtime.closeConsumers({ token: b.token })).toBe(1)
    expect(b.closes).toEqual([[1006, '']])
    expect(() => world.realtime.closeConsumers({ code: 999 })).toThrow(RangeError)
    expect(() => world.realtime.closeConsumers({ code: 5000 })).toThrow(RangeError)
    expect(c.closes).toEqual([])
    expect(world.realtime.closeConsumers()).toBe(1)
    expect(c.closes).toEqual([[1006, '']])
    // closed sockets are not closed twice
    expect(world.realtime.closeConsumers()).toBe(0)
  })
})
