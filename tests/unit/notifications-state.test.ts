/**
 * Notification 2.0 subscriptions and tokens are tenant data: forks inherit
 * them, `reset()` drops the ones written since, `restore()` brings back the
 * ones of the snapshot, and `snapshot()`/`diff()` contain them. Frames on
 * their way are dropped by a reset.
 */
import { describe, expect, it } from 'vitest'
import { CONSUMER_REMOVED, createClock, createWorld } from '../../src'
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
    const consumer = await open(world, run, 'sub', 'a')
    world.restore(snapshot)
    expect(consumer.closes).toEqual([[4410, 'notification token removed']])
    expect(consumer.socket.readyState).toBe(3)
  })

  it('closes sockets whose subscription a restore removed, also when the token stays', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const consumer = await open(world, run, 'sub', 'a')
    const snapshot = world.snapshot()
    for (const tenant of snapshot.tenants) {
      tenant.notificationSubscriptions = []
    }
    expect(snapshot.tenants.some((tenant) => (tenant.notificationTokens ?? []).length > 0)).toBe(true)
    world.restore(snapshot)
    expect(world.realtime.tokens.has(consumer.token)).toBe(true)
    expect(consumer.closes).toEqual([[CONSUMER_REMOVED.code, CONSUMER_REMOVED.reason]])
  })

  it('does not close a socket that is still connecting; its connect fails instead', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 'a' })).body.token
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    const closes: unknown[][] = []
    socket.on('close', (...args: unknown[]) => closes.push(args))
    socket.on('error', () => {})
    world.reset()
    expect(closes).toEqual([])
    expect(socket.readyState).toBe(0)
    run()
    expect(closes).toEqual([[1008, 'invalid token']])
  })

  it('closes the sockets of a fork with CONSUMER_REMOVED and leaves the base\'s open', async () => {
    const { world: base, run } = manualWorld()
    await call(base, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const onBase = await open(base, run, 'sub', 'base')
    const fork = base.fork()
    const onFork = await open(fork, run, 'sub', 'fork')
    fork.reset()
    expect(onFork.closes).toEqual([[CONSUMER_REMOVED.code, CONSUMER_REMOVED.reason]])
    expect(onBase.closes).toEqual([])

    const snapshot = fork.snapshot()
    const again = await open(fork, run, 'sub', 'fork2')
    fork.restore(snapshot)
    expect(again.closes).toEqual([[CONSUMER_REMOVED.code, CONSUMER_REMOVED.reason]])
    expect(onBase.closes).toEqual([])
    expect(onBase.socket.readyState).toBe(1)
  })
})

async function open(world: World, run: () => void, subscription: string, subscriber: string, tenant?: string) {
  const headers: Record<string, string> = { 'accept': 'application/json', 'content-type': 'application/json' }
  if (tenant) {
    headers.authorization = `Basic ${btoa(`${tenant}/service_${tenant}:p`)}`
  }
  const response = await world.fetch(new Request(`${world.baseUrl}/notification2/token`, { method: 'POST', headers, body: JSON.stringify({ subscription, subscriber }) }))
  expect(response.status).toBe(200)
  const token = (await response.json() as { token: string }).token
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

const ackId = (frame: string) => frame.split('\n')[0]!

describe('closeConsumers()', () => {
  async function twoSubscriptions() {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'one' })
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'two' })
    return { world, run }
  }

  it('closes the sockets of a subscription with the given code and reason', async () => {
    const { world, run } = await twoSubscriptions()
    const a = await open(world, run, 'one', 'a')
    const b = await open(world, run, 'two', 'b')
    expect(world.realtime.closeConsumers({ subscription: 'one', code: 1011, reason: 'internal error' })).toBe(1)
    expect(a.closes).toEqual([[1011, 'internal error']])
    expect(a.socket.readyState).toBe(3)
    expect(b.closes).toEqual([])
    expect([...world.realtime.sockets]).toEqual([b.socket])
  })

  it('closes every open socket with 1006 and an empty reason by default, each once', async () => {
    const { world, run } = await twoSubscriptions()
    const a = await open(world, run, 'one', 'a')
    const b = await open(world, run, 'two', 'b')
    expect(world.realtime.closeConsumers()).toBe(2)
    expect(a.closes).toEqual([[1006, '']])
    expect(b.closes).toEqual([[1006, '']])
    expect(world.realtime.closeConsumers()).toBe(0)
  })

  it('filters by subscriber and by token', async () => {
    const { world, run } = await twoSubscriptions()
    const a = await open(world, run, 'one', 'a')
    const b = await open(world, run, 'one', 'b')
    const c = await open(world, run, 'one', 'c')
    expect(world.realtime.closeConsumers({ subscriber: 'a', code: 4000 })).toBe(1)
    expect(world.realtime.closeConsumers({ token: b.token })).toBe(1)
    expect(a.closes).toEqual([[4000, '']])
    expect(b.closes).toEqual([[1006, '']])
    expect(c.closes).toEqual([])
  })

  it('filters by tenant', async () => {
    const queue: Array<() => void> = []
    const world = createWorld({ schedule: (callback) => queue.push(callback), subscriptions: [{ tenant: 't12345', user: 'service_t12345', password: 'p' }, { tenant: 't2', user: 'service_t2', password: 'p' }] })
    const run = () => {
      while (queue.length > 0) {
        queue.shift()!()
      }
    }
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const response = await world.fetch(new Request(`${world.baseUrl}/notification2/subscriptions`, { method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json', 'authorization': `Basic ${btoa('t2/service_t2:p')}` }, body: JSON.stringify({ context: 'tenant', subscription: 'sub' }) }))
    expect(response.status).toBe(201)
    const own = await open(world, run, 'sub', 'a')
    const other = await open(world, run, 'sub', 'a', 't2')
    expect(other.socket.token?.tenant).toBe('t2')
    expect(world.realtime.closeConsumers({ tenant: 'unknown' })).toBe(0)
    expect(world.realtime.closeConsumers({ tenant: 't2' })).toBe(1)
    expect(other.closes).toEqual([[1006, '']])
    expect(own.closes).toEqual([])
    expect(own.socket.readyState).toBe(1)
  })

  it('accepts the codes 1000 to 4999 and rejects others before closing anything', async () => {
    const { world, run } = await twoSubscriptions()
    const a = await open(world, run, 'one', 'a')
    for (const code of [999, 5000, 1000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => world.realtime.closeConsumers({ code })).toThrow(RangeError)
    }
    expect(a.closes).toEqual([])
    expect(a.socket.readyState).toBe(1)
    expect(world.realtime.closeConsumers({ code: 1000 })).toBe(1)
    const b = await open(world, run, 'one', 'b')
    expect(world.realtime.closeConsumers({ code: 4999 })).toBe(1)
    expect(a.closes).toEqual([[1000, '']])
    expect(b.closes).toEqual([[4999, '']])
  })

  it('does not close a socket that is still connecting', async () => {
    const { world, run } = await twoSubscriptions()
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'one', subscriber: 'a' })).body.token
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    expect(world.realtime.closeConsumers()).toBe(0)
    run()
    expect(socket.readyState).toBe(1)
  })

  it('ignores a client close() after a server-side close', async () => {
    const { world, run } = await twoSubscriptions()
    const a = await open(world, run, 'one', 'a')
    world.realtime.closeConsumers({ code: 1011 })
    a.socket.close()
    run()
    expect(a.closes).toEqual([[1011, '']])
  })

  it('keeps tokens and subscriptions, so the client reconnects with the same token', async () => {
    const { world, run } = await twoSubscriptions()
    const a = await open(world, run, 'one', 'a')
    world.realtime.closeConsumers()
    expect(world.realtime.tokens.has(a.token)).toBe(true)
    expect(await names(world)).toEqual(['one', 'two'])
    const WebSocket = createFakeWebSocket(world.realtime)
    const again = new WebSocket(`wss://example.test/notification2/consumer/?token=${a.token}`)
    run()
    expect(again.readyState).toBe(1)
  })

  it('gives the next consumer of a persistent subscription the unacknowledged and the meanwhile published frames, in order', async () => {
    const { world, run } = await twoSubscriptions()
    const a = await open(world, run, 'one', 'a')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'acknowledged' })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'delivered' })
    run()
    expect(a.received).toHaveLength(2)
    a.socket.send(ackId(a.received[0]!))
    await call(world, 'POST', '/inventory/managedObjects', { name: 'scheduled' })
    world.realtime.closeConsumers()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'while away' })
    run()
    expect(a.received).toHaveLength(2)
    // held for the next consumer: stored, not live work
    expect(world.realtime.status().backlog).toBe(3)
    expect(world.realtime.pending()).toBe(0)
    const again = await open(world, run, 'one', 'a')
    expect(again.received.map((frame) => JSON.parse(frame.split('\n\n')[1]!).name)).toEqual(['delivered', 'scheduled', 'while away'])
  })

  it('drops the unacknowledged frames of a non-persistent subscription', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'live', nonPersistent: true })
    const a = await open(world, run, 'live', 'a')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'delivered' })
    run()
    expect(a.received).toHaveLength(1)
    world.realtime.closeConsumers()
    const again = await open(world, run, 'live', 'a')
    expect(again.received).toEqual([])
  })

  it('does not requeue frames while another consumer of the subscription stays open', async () => {
    const { world, run } = await twoSubscriptions()
    const a = await open(world, run, 'one', 'a')
    const b = await open(world, run, 'one', 'b')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'delivered' })
    run()
    world.realtime.closeConsumers({ subscriber: 'a' })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'while away' })
    run()
    expect(b.received).toHaveLength(2)
    const again = await open(world, run, 'one', 'a')
    expect(again.received).toEqual([])
    expect(a.received).toHaveLength(1)
  })

  it('closes the sockets of a fork only', async () => {
    const { world: base, run } = manualWorld()
    await call(base, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const onBase = await open(base, run, 'sub', 'base')
    const fork = base.fork()
    const onFork = await open(fork, run, 'sub', 'fork')
    expect(fork.realtime.closeConsumers()).toBe(1)
    expect(onFork.closes).toEqual([[1006, '']])
    expect(onBase.closes).toEqual([])
  })
})

describe('client close()', () => {
  async function persistent() {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    return { world, run }
  }

  const name = (frame: string) => JSON.parse(frame.split('\n\n')[1]!).name

  it('keeps the unacknowledged frames for the next consumer, before the ones published meanwhile, with their ack ids', async () => {
    const { world, run } = await persistent()
    const a = await open(world, run, 'sub', 'a')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'A' })
    run()
    expect(a.received).toHaveLength(1)
    a.socket.close()
    run()
    expect(a.closes).toEqual([[1000, '']])
    for (const next of ['B', 'C', 'D']) {
      await call(world, 'POST', '/inventory/managedObjects', { name: next })
    }
    const again = await open(world, run, 'sub', 'a')
    expect(again.received.map(name)).toEqual(['A', 'B', 'C', 'D'])
    expect(ackId(again.received[0]!)).toBe(ackId(a.received[0]!))
  })

  it('does the same on terminate()', async () => {
    const { world, run } = await persistent()
    const a = await open(world, run, 'sub', 'a')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'A' })
    run()
    a.socket.terminate()
    run()
    const again = await open(world, run, 'sub', 'a')
    expect(again.received).toEqual(a.received)
  })

  it('does not redeliver acknowledged frames', async () => {
    const { world, run } = await persistent()
    const a = await open(world, run, 'sub', 'a')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'acknowledged' })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'delivered' })
    run()
    a.socket.send(ackId(a.received[0]!))
    a.socket.close()
    run()
    const again = await open(world, run, 'sub', 'a')
    expect(again.received.map(name)).toEqual(['delivered'])
  })

  it('keeps nothing after an unsubscribe', async () => {
    const { world, run } = await persistent()
    const a = await open(world, run, 'sub', 'a')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'A' })
    run()
    expect((await call(world, 'POST', `/notification2/unsubscribe?token=${a.token}`)).status).toBe(200)
    run()
    expect(a.closes).toEqual([[1000, '']])
    expect(world.realtime.status().backlog).toBe(0)
    const again = await open(world, run, 'sub', 'a')
    expect(again.received).toEqual([])
  })

  it('keeps nothing across a reset', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const start = world.checkpoint()
    const a = await open(world, run, 'sub', 'a')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'A' })
    run()
    a.socket.close()
    run()
    expect(world.realtime.status().backlog).toBe(1)
    world.reset({ to: start })
    expect(await names(world)).toEqual(['sub'])
    expect(world.realtime.status().backlog).toBe(0)
    const again = await open(world, run, 'sub', 'a')
    expect(again.received).toEqual([])
  })

  it('drops the unacknowledged frames of a non-persistent subscription', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'live', nonPersistent: true })
    const a = await open(world, run, 'live', 'a')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'A' })
    run()
    a.socket.close()
    run()
    const again = await open(world, run, 'live', 'a')
    expect(again.received).toEqual([])
  })

  it('emits one close 1000 for a socket that is still connecting, and no error or open', async () => {
    const { world, run } = await persistent()
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 'a' })).body.token
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    const events: unknown[][] = []
    socket.on('close', (...args: unknown[]) => events.push(['close', ...args]))
    socket.on('error', () => events.push(['error']))
    socket.on('open', () => events.push(['open']))
    socket.close()
    expect(world.realtime.status().connecting).toBe(0)
    run()
    expect(events).toEqual([['close', 1000, '']])
    expect(socket.readyState).toBe(3)
    expect(world.realtime.sockets.size).toBe(0)
    expect(world.realtime.pending()).toBe(0)
  })

  it('emits one close 1000 for a connecting socket on the real schedule, and settled() resolves', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 'a' })).body.token
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    const events: unknown[][] = []
    socket.on('close', (...args: unknown[]) => events.push(['close', ...args]))
    socket.on('error', () => events.push(['error']))
    socket.on('open', () => events.push(['open']))
    socket.close()
    await world.realtime.settled({ timeout: 1000 })
    expect(events).toEqual([['close', 1000, '']])
  })

  it('redelivers with the ws flavor too', async () => {
    const { world, run } = await persistent()
    const WebSocket = createFakeWebSocket(world.realtime, { flavor: 'ws' })
    const connect = async () => {
      const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 'a' })).body.token
      const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
      const received: string[] = []
      socket.on('message', (data: Uint8Array, isBinary: boolean) => {
        expect(isBinary).toBe(false)
        expect(typeof data).not.toBe('string')
        received.push(new TextDecoder().decode(data))
      })
      run()
      return { socket, received }
    }
    const a = await connect()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'A' })
    run()
    a.socket.close()
    run()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'B' })
    const again = await connect()
    expect(again.received.map(name)).toEqual(['A', 'B'])
    expect(ackId(again.received[0]!)).toBe(ackId(a.received[0]!))
  })
})

describe('backlog before a first connect', () => {
  const name = (frame: string) => JSON.parse(frame.split('\n\n')[1]!).name

  async function persistent() {
    const { world, run } = manualWorld()
    const id = (await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })).body.id as string
    return { world, run, id }
  }

  it('drops a write before any consumer connected', async () => {
    const { world, run } = await persistent()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'early' })
    expect(world.realtime.status()).toMatchObject({ backlog: 0, unclaimed: 0 })
    const a = await open(world, run, 'sub', 'a')
    run()
    expect(a.received).toEqual([])
  })

  it('keeps a write after a consumer connected and closed, for a new token of the same subscriber', async () => {
    const { world, run } = await persistent()
    const a = await open(world, run, 'sub', 'a')
    a.socket.close()
    run()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'kept' })
    expect(world.realtime.status()).toMatchObject({ backlog: 1, unclaimed: 0 })
    const again = await open(world, run, 'sub', 'a')
    expect(again.token).not.toBe(a.token)
    expect(again.received.map(name)).toEqual(['kept'])
  })

  it('keeps nothing after an unsubscribe until a consumer connects again', async () => {
    const { world, run } = await persistent()
    const a = await open(world, run, 'sub', 'a')
    expect((await call(world, 'POST', `/notification2/unsubscribe?token=${a.token}`)).status).toBe(200)
    run()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'dropped' })
    expect(world.realtime.status().backlog).toBe(0)
    const b = await open(world, run, 'sub', 'a')
    expect(b.received).toEqual([])
    await call(world, 'POST', '/inventory/managedObjects', { name: 'live' })
    run()
    expect(b.received.map(name)).toEqual(['live'])
    b.socket.send(ackId(b.received[0]!))
    b.socket.close()
    run()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'kept' })
    const c = await open(world, run, 'sub', 'a')
    expect(c.received.map(name)).toEqual(['kept'])
  })

  it('is forgotten by reset(), restore(), and a fork', async () => {
    const { world, run } = await persistent()
    const start = world.checkpoint()
    const snapshot = world.snapshot()
    const connectOnce = async () => {
      const a = await open(world, run, 'sub', 'a')
      a.socket.close()
      run()
    }
    await connectOnce()
    world.reset({ to: start })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'after reset' })
    expect(world.realtime.status().backlog).toBe(0)

    await connectOnce()
    world.restore(snapshot)
    await call(world, 'POST', '/inventory/managedObjects', { name: 'after restore' })
    expect(world.realtime.status().backlog).toBe(0)

    await connectOnce()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'on the base' })
    expect(world.realtime.status().backlog).toBe(1)
    const fork = world.fork()
    await call(fork, 'POST', '/inventory/managedObjects', { name: 'on the fork' })
    expect(fork.realtime.status().backlog).toBe(0)
  })

  it('counts a consumer kept open across reset({ to, consumers: \'keep\' }) as connected', async () => {
    const { world, run } = await persistent()
    const start = world.checkpoint()
    const a = await open(world, run, 'sub', 'a')
    world.reset({ to: start, consumers: 'keep' })
    expect(a.socket.readyState).toBe(1)
    a.socket.close()
    run()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'kept' })
    expect(world.realtime.status().backlog).toBe(1)
  })

  it('keeps the backlog after an unsubscribe while another consumer is open', async () => {
    const { world, run } = await persistent()
    const a = await open(world, run, 'sub', 'a')
    const b = await open(world, run, 'sub', 'b')
    expect((await call(world, 'POST', `/notification2/unsubscribe?token=${a.token}`)).status).toBe(200)
    run()
    b.socket.close()
    run()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'kept' })
    expect(world.realtime.status().backlog).toBe(1)
    const again = await open(world, run, 'sub', 'b')
    expect(again.received.map(name)).toEqual(['kept'])
  })

  it('counts a socket that stays open across restore() as connected', async () => {
    const { world, run } = await persistent()
    const a = await open(world, run, 'sub', 'a')
    // the snapshot still has the socket's token
    world.restore(world.snapshot())
    expect(a.socket.readyState).toBe(1)
    a.socket.close()
    run()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'kept' })
    expect(world.realtime.status().backlog).toBe(1)
  })

  it('keeps the backlog when the subscription is deleted', async () => {
    const { world, run, id } = await persistent()
    const a = await open(world, run, 'sub', 'a')
    a.socket.close()
    run()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'kept' })
    expect((await call(world, 'DELETE', `/notification2/subscriptions/${id}`)).status).toBe(204)
    expect(world.realtime.status().backlog).toBe(1)
  })
})

describe('token expiry', () => {
  const START = Date.parse('2026-01-01T00:00:00.000Z')
  const MINUTE = 60_000
  const name = (frame: string) => JSON.parse(frame.split('\n\n')[1]!).name

  async function clockWorld() {
    const queue: Array<() => void> = []
    const world = createWorld({ clock: createClock({ start: START, realtime: false }), schedule: (callback) => queue.push(callback) })
    const run = () => {
      while (queue.length > 0) {
        queue.shift()!()
      }
    }
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    return { world, run }
  }

  async function token(world: World, body: Record<string, unknown> = {}) {
    const response = await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 'a', ...body })
    expect(response.status).toBe(200)
    expect(Object.keys(response.body)).toEqual(['token'])
    return response.body.token as string
  }

  function connect(world: World, run: () => void, value: string) {
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${value}`)
    const events: unknown[][] = []
    const received: string[] = []
    socket.on('open', () => events.push(['open']))
    socket.on('error', () => events.push(['error']))
    socket.on('close', (...args: unknown[]) => events.push(['close', ...args]))
    socket.on('message', (text: string) => received.push(text))
    run()
    return { socket, events, received }
  }

  it('refuses an expired token like an unknown one', async () => {
    const { world, run } = await clockWorld()
    const value = await token(world, { expiresInMinutes: 5 })
    expect(world.realtime.tokens.get(value)!.expires).toBe(START + 5 * MINUTE)
    world.advance(6 * MINUTE)
    expect(connect(world, run, value).events).toEqual([['error'], ['close', 1008, 'invalid token']])
  })

  it('keeps a socket open past expiry, and it still receives', async () => {
    const { world, run } = await clockWorld()
    const consumer = connect(world, run, await token(world, { expiresInMinutes: 5 }))
    expect(consumer.events).toEqual([['open']])
    world.advance(6 * MINUTE)
    await call(world, 'POST', '/inventory/managedObjects', { name: 'late' })
    run()
    expect(consumer.socket.readyState).toBe(1)
    expect(consumer.received.map(name)).toEqual(['late'])
  })

  it('lets a new token of the same consumer connect after expiry, with the backlog', async () => {
    const { world, run } = await clockWorld()
    const value = await token(world, { expiresInMinutes: 5 })
    const first = connect(world, run, value)
    first.socket.close()
    run()
    await call(world, 'POST', '/inventory/managedObjects', { name: 'away' })
    world.advance(6 * MINUTE)
    expect(connect(world, run, value).events).toEqual([['error'], ['close', 1008, 'invalid token']])
    const again = connect(world, run, await token(world))
    expect(again.events).toEqual([['open']])
    expect(again.received.map(name)).toEqual(['away'])
  })

  it('expires after 1440 minutes without expiresInMinutes', async () => {
    const { world, run } = await clockWorld()
    const value = await token(world)
    world.advance(1439 * MINUTE)
    const before = connect(world, run, value)
    expect(before.events).toEqual([['open']])
    before.socket.close()
    run()
    world.advance(MINUTE)
    expect(connect(world, run, value).events).toEqual([['error'], ['close', 1008, 'invalid token']])
  })

  it('follows the now option of the world', async () => {
    let now = START
    const queue: Array<() => void> = []
    const world = createWorld({ now: () => now, schedule: (callback) => queue.push(callback) })
    const run = () => queue.splice(0).forEach((callback) => callback())
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const value = await token(world, { expiresInMinutes: 5 })
    expect(world.realtime.tokens.get(value)!.expires).toBe(START + 5 * MINUTE)
    now += 5 * MINUTE
    expect(connect(world, run, value).events).toEqual([['error'], ['close', 1008, 'invalid token']])
  })

  it('uses the clock of a fork', async () => {
    const { world, run } = await clockWorld()
    const value = await token(world, { expiresInMinutes: 5 })
    const late = world.fork({ clock: createClock({ start: START + 10 * MINUTE, realtime: false }) })
    expect(connect(late, run, value).events).toEqual([['error'], ['close', 1008, 'invalid token']])
    const early = world.fork({ clock: createClock({ start: START, realtime: false }) })
    expect(connect(early, run, value).events).toEqual([['open']])
  })

  it('keeps expires in a snapshot; a token without it never expires', async () => {
    const { world, run } = await clockWorld()
    const value = await token(world, { expiresInMinutes: 5 })
    const snapshot = world.snapshot()
    const tokensOf = (state: typeof snapshot) => state.tenants.find((item) => item.tenant === world.tenant)!
    expect(tokensOf(snapshot).notificationTokens).toEqual([[value, { tenant: world.tenant, subscription: 'sub', subscriber: 'a', expires: START + 5 * MINUTE }]])
    world.restore(snapshot)
    expect(world.realtime.tokens.get(value)!.expires).toBe(START + 5 * MINUTE)

    const old = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot
    tokensOf(old).notificationTokens = [[value, { tenant: world.tenant, subscription: 'sub', subscriber: 'a' }]]
    world.restore(old)
    world.advance(10 * 1440 * MINUTE)
    expect(connect(world, run, value).events).toEqual([['open']])
  })

  it('keeps expires and the open socket across reset({ to, consumers: \'keep\' })', async () => {
    const { world, run } = await clockWorld()
    const start = world.checkpoint()
    const value = await token(world, { expiresInMinutes: 5 })
    const consumer = connect(world, run, value)
    world.advance(6 * MINUTE)
    world.reset({ to: start, consumers: 'keep' })
    run()
    expect(consumer.socket.readyState).toBe(1)
    expect(world.realtime.tokens.get(value)!.expires).toBe(START + 5 * MINUTE)
    await call(world, 'POST', '/inventory/managedObjects', { name: 'after reset' })
    run()
    expect(consumer.received.map(name)).toEqual(['after reset'])
  })

  it('never expires a token whose expiresInMinutes is too large, also after a JSON snapshot round trip', async () => {
    const { world, run } = await clockWorld()
    const value = await token(world, { expiresInMinutes: '9'.repeat(400) })
    expect(connect(world, run, value).events).toEqual([['open']])
    world.restore(JSON.parse(JSON.stringify(world.snapshot())))
    expect(connect(world, run, value).events).toEqual([['open']])
  })
})
