/**
 * Notification 2.0 subscriptions and tokens are tenant data: forks inherit
 * them, `reset()` drops the ones written since, `restore()` brings back the
 * ones of the snapshot, and `snapshot()`/`diff()` contain them. Frames on
 * their way are dropped by a reset.
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
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
    let closed = false
    socket.on('message', (text: string) => received.push(text))
    socket.on('close', () => {
      closed = true
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
    expect(closed).toBe(true)
  })
})
