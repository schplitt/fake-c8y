/**
 * `world.checkpoint()` and `world.reset({ to, consumers })`: going back to a
 * state taken later than the baseline, on the same world. By default a reset
 * closes the Notification 2.0 consumers whose subscription the state reset to
 * does not have; `consumers: 'keep'` closes none. Tokens are stateless, so a
 * token minted after the checkpoint (as a client does on every reconnect)
 * still connects.
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { C8yResetOptions, World } from '../../src'
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

async function consumer(world: World, run: () => void, subscription: string, expiresInMinutes?: number, subscriber = 's') {
  const token = (await call(world, 'POST', '/notification2/token', { subscription, subscriber, ...(expiresInMinutes ? { expiresInMinutes } : {}) })).body.token as string
  const WebSocket = createFakeWebSocket(world.realtime)
  const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
  const received: string[] = []
  const state = { closed: false, code: undefined as unknown, reason: undefined as unknown }
  socket.on('message', (text: string) => received.push(text))
  socket.on('close', (code: unknown, reason: unknown) => {
    state.closed = true
    state.code = code
    state.reason = reason
  })
  run()
  expect(socket.readyState).toBe(1)
  return { token, socket, received, state }
}

const names = async (world: World) => (await call(world, 'GET', '/inventory/managedObjects?pageSize=100')).body.managedObjects.map((item: { name: string }) => item.name)

describe('checkpoint', () => {
  it('goes back to the data, ids, options, overrides, and call log of the checkpoint', async () => {
    const world = createWorld()
    world.device({ name: 'seeded' })
    world.override('GET /tenant/currentTenant', () => ({ name: 'startup' }))
    world.options.set('mode', 'startup')
    const startup = world.checkpoint()

    const first = await call(world, 'POST', '/inventory/managedObjects', { name: 'test 1' })
    world.override('GET /tenant/currentTenant', () => ({ name: 'test' }))
    world.options.set('mode', 'test')
    expect(await names(world)).toEqual(['seeded', 'test 1'])

    world.reset({ to: startup })
    expect(world.calls).toEqual([])
    expect(await names(world)).toEqual(['seeded'])
    expect(world.options.get('mode')).toBe('startup')
    expect((await call(world, 'GET', '/tenant/currentTenant')).body.name).toBe('startup')
    // a replay gets the same ids
    const again = await call(world, 'POST', '/inventory/managedObjects', { name: 'test 1' })
    expect(again.body.id).toBe(first.body.id)

    // the baseline is unchanged: a plain reset still goes back to it
    world.reset()
    expect(await names(world)).toEqual([])
  })

  it('applies state fields on top without changing the baseline', async () => {
    const world = createWorld()
    const startup = world.checkpoint()
    world.reset({ to: startup, tenantOptions: { mode: 'x' } })
    expect(world.options.get('mode')).toBe('x')
    world.reset()
    expect(world.options.get('mode')).toBeUndefined()
  })

  it('belongs to its world, and a frozen base takes none', () => {
    const world = createWorld()
    const other = createWorld()
    expect(() => world.reset({ to: other.checkpoint() })).toThrow(/checkpoint of this world/)
    world.fork()
    expect(() => world.checkpoint()).toThrow(/frozen/)
  })

  it('works on a fork, whose plain reset still goes back to the fork\'s start', async () => {
    const base = createWorld()
    base.device({ name: 'base' })
    const fork = base.fork()
    fork.device({ name: 'startup' })
    const startup = fork.checkpoint()
    fork.device({ name: 'test' })
    fork.reset({ to: startup })
    expect(await names(fork)).toEqual(['base', 'startup'])
    fork.reset()
    expect(await names(fork)).toEqual(['base'])
    expect(await names(base)).toEqual(['base'])
  })

  it('keeps a fork\'s diff() against its base, also after reset({ to }) and in a tenant the fork created', async () => {
    const base = createWorld()
    base.device({ name: 'base' })
    const start = base.snapshot()
    const fork = base.fork()
    fork.device({ name: 'before checkpoint' })
    fork.device({ name: 'other tenant', tenant: 't9' })
    const startup = fork.checkpoint()
    fork.device({ name: 'after checkpoint' })
    expect(fork.diff()).toEqual(fork.diff(start))
    const created = (diff: ReturnType<World['diff']>, tenant: string) => diff.tenants[tenant]?.managedObjects.created.map((item) => (item as unknown as { name: string }).name)
    expect(created(fork.diff(), fork.tenant)).toEqual(['before checkpoint', 'after checkpoint'])
    expect(created(fork.diff(), 't9')).toEqual(['other tenant'])
    fork.reset({ to: startup })
    expect(fork.diff()).toEqual(fork.diff(start))
    expect(created(fork.diff(), fork.tenant)).toEqual(['before checkpoint'])
  })

  it('a second checkpoint goes back to its own state', async () => {
    const world = createWorld()
    world.device({ name: 'a' })
    world.checkpoint()
    world.device({ name: 'b' })
    const second = world.checkpoint()
    world.device({ name: 'c' })
    world.reset({ to: second })
    expect(await names(world)).toEqual(['a', 'b'])
  })

  it('keeps the baseline with { to: undefined } and with only consumers', () => {
    const world = createWorld({ tenant: 't42', tenantOptions: { mode: 'baseline' } })
    // a JavaScript caller (TypeScript with exactOptionalPropertyTypes rejects it)
    world.reset({ to: undefined } as unknown as C8yResetOptions)
    expect(world.tenant).toBe('t42')
    expect(world.options.get('mode')).toBe('baseline')
    world.reset({ consumers: 'keep' })
    expect(world.options.get('mode')).toBe('baseline')
  })

  it('still goes back to a checkpoint after restore()', async () => {
    const world = createWorld()
    world.device({ name: 'startup' })
    const startup = world.checkpoint()
    world.device({ name: 'test' })
    const later = world.snapshot()
    world.reset()
    world.restore(later)
    expect(await names(world)).toEqual(['startup', 'test'])
    world.reset({ to: startup })
    expect(await names(world)).toEqual(['startup'])
  })

  it('removes the application of a service removed after the checkpoint', async () => {
    const world = createWorld()
    const remove = world.service('pumps', () => Response.json({ ok: true }), { manifest: {} })
    const startup = world.checkpoint()
    remove()
    world.reset({ to: startup })
    expect((await call(world, 'GET', '/application/applications?name=pumps')).body.applications).toEqual([])
  })

  it('keeps services registered after the checkpoint', async () => {
    const world = createWorld()
    const startup = world.checkpoint()
    world.service('svc', () => Response.json({ ok: true }), { manifest: {} })
    world.reset({ to: startup })
    expect((await call(world, 'GET', '/service/svc/x')).body).toEqual({ ok: true })
  })
})

describe('reset({ to, consumers })', () => {
  it('keeps an open consumer with a token minted after the checkpoint (reconnect)', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const startup = world.checkpoint()

    // the client reconnects with a new token during a test
    const before = await consumer(world, run, 'startup')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'test 1' })
    world.reset({ to: startup, consumers: 'keep' })
    expect(before.state.closed).toBe(false)

    // still delivered to after the reset
    await call(world, 'POST', '/inventory/managedObjects', { name: 'test 2' })
    run()
    expect(before.received.some((frame) => frame.includes('test 2'))).toBe(true)

    // a new token of another subscriber does not collide with the kept one
    const next = (await call(world, 'POST', '/notification2/token', { subscription: 'startup', subscriber: 's2' })).body.token as string
    expect(next).not.toBe(before.token)

    // and it stays across further resets
    world.reset({ to: startup, consumers: 'keep' })
    expect(before.state.closed).toBe(false)
  })

  it('closes consumers of subscriptions created after the checkpoint by default, as a dropped connection', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const startup = world.checkpoint()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'test' })
    const kept = await consumer(world, run, 'startup')
    const dropped = await consumer(world, run, 'test')
    world.reset({ to: startup })
    expect(kept.state.closed).toBe(false)
    expect(dropped.state.closed).toBe(true)
    expect([dropped.state.code, dropped.state.reason]).toEqual([1006, ''])
    expect((await call(world, 'GET', '/notification2/subscriptions')).body.subscriptions.map((item: { subscription: string }) => item.subscription)).toEqual(['startup'])
  })

  it('closes nothing with keep, also consumers of subscriptions created after the checkpoint', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const startup = world.checkpoint()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'test' })
    const kept = await consumer(world, run, 'startup')
    const orphan = await consumer(world, run, 'test')
    world.reset({ to: startup, consumers: 'keep' })
    expect(kept.state.closed).toBe(false)
    expect(orphan.state.closed).toBe(false)
    expect((await call(world, 'GET', '/notification2/subscriptions')).body.subscriptions.map((item: { subscription: string }) => item.subscription)).toEqual(['startup'])
    // it gets frames again once its subscription exists
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'test' })
    await call(world, 'POST', '/inventory/managedObjects', { name: 'after reset' })
    run()
    expect(orphan.received.some((frame) => frame.includes('after reset'))).toBe(true)
  })

  it('keeps a consumer open with keep when its subscription was deleted since the checkpoint', async () => {
    const { world, run } = manualWorld()
    const id = (await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })).body.id
    const open = await consumer(world, run, 'startup')
    const startup = world.checkpoint()
    expect((await call(world, 'DELETE', `/notification2/subscriptions/${id}`)).status).toBe(204)
    // deleting the subscription through the API closes nothing
    expect(open.state.closed).toBe(false)
    world.reset({ to: startup, consumers: 'keep' })
    expect(open.state.closed).toBe(false)
    await call(world, 'POST', '/inventory/managedObjects', { name: 'after reset' })
    run()
    expect(open.received).toHaveLength(1)
  })

  it('closes a consumer whose subscription the checkpoint has not, though its token stays valid', async () => {
    const { world, run } = manualWorld()
    const id = (await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })).body.id
    const open = await consumer(world, run, 'startup')
    expect((await call(world, 'DELETE', `/notification2/subscriptions/${id}`)).status).toBe(204)
    const startup = world.checkpoint()
    world.reset({ to: startup })
    expect([open.state.code, open.state.reason]).toEqual([1006, ''])
    // the token still connects; the socket waits for a subscription of that name
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const WebSocket = createFakeWebSocket(world.realtime)
    const again = new WebSocket(`wss://example.test/notification2/consumer/?token=${open.token}`)
    run()
    expect(again.readyState).toBe(1)
  })

  it('keeps consumers whose subscription the checkpoint has by default, also with a token minted after it', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const early = await consumer(world, run, 'startup')
    const startup = world.checkpoint()
    const late = await consumer(world, run, 'startup', undefined, 'late')
    world.reset({ to: startup })
    expect(early.state.closed).toBe(false)
    expect(late.state.closed).toBe(false)
  })

  it('drops undelivered frames but keeps delivering to the kept socket', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const startup = world.checkpoint()
    const open = await consumer(world, run, 'startup')
    await call(world, 'POST', '/inventory/managedObjects', { name: 'in flight' })
    expect(world.realtime.pending()).toBe(1)
    world.reset({ to: startup, consumers: 'keep' })
    run()
    expect(open.received).toEqual([])
    expect(open.state.closed).toBe(false)
    await call(world, 'POST', '/inventory/managedObjects', { name: 'after' })
    run()
    expect(open.received.some((frame) => frame.includes('after'))).toBe(true)
  })

  it('keeps the socket of a reconnect, and the replaced token still connects', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const first = await consumer(world, run, 'startup')
    const startup = world.checkpoint()
    // reconnect: the old socket closes, a new token is minted
    first.socket.close()
    run()
    // another expiry gives another token of the same subscriber
    const second = await consumer(world, run, 'startup', 60)
    expect(second.token).not.toBe(first.token)
    world.reset({ to: startup, consumers: 'keep' })
    expect(second.state.closed).toBe(false)
    expect(world.realtime.consumers().map((item) => item.token)).toEqual([second.token])
    // tokens are stateless: the replaced one is still valid (once the
    // subscriber's open socket is closed, else 409)
    second.socket.close()
    run()
    const WebSocket = createFakeWebSocket(world.realtime)
    const again = new WebSocket(`wss://example.test/notification2/consumer/?token=${first.token}`)
    run()
    expect(again.readyState).toBe(1)
  })

  it('gives consumers of one subscription different tokens, also after a reset', async () => {
    const world = createWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const startup = world.checkpoint()
    const a = (await call(world, 'POST', '/notification2/token', { subscription: 'startup', subscriber: 'a' })).body.token
    world.reset({ to: startup })
    const b = (await call(world, 'POST', '/notification2/token', { subscription: 'startup', subscriber: 'b' })).body.token
    expect(b).not.toBe(a)
  })

  it('keeps a socket that is still connecting with a token minted after the checkpoint', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const startup = world.checkpoint()
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'startup', subscriber: 's' })).body.token as string
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    world.reset({ to: startup, consumers: 'keep' })
    run()
    expect(socket.readyState).toBe(1)
  })

  it('lets a newer token of the same consumer that is not connected yet connect after the reset, once the open socket closed', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const connected = await consumer(world, run, 'startup')
    // a second client of the same subscriber minted its token but has not connected yet
    const pending = (await call(world, 'POST', '/notification2/token', { subscription: 'startup', subscriber: 's', expiresInMinutes: 60 })).body.token as string
    expect(pending).not.toBe(connected.token)
    const startup = world.checkpoint()
    world.reset({ to: startup, consumers: 'keep' })
    expect(connected.state.closed).toBe(false)
    const WebSocket = createFakeWebSocket(world.realtime)
    // a second open socket of the same subscriber is refused (409)
    const refused = new WebSocket(`wss://example.test/notification2/consumer/?token=${pending}`)
    run()
    expect(refused.readyState).toBe(3)
    connected.socket.close()
    run()
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${pending}`)
    run()
    expect(socket.readyState).toBe(1)
  })

  it('keeps consumers on a fork\'s plain reset', async () => {
    const queue: Array<() => void> = []
    const run = () => {
      while (queue.length > 0) {
        queue.shift()!()
      }
    }
    const base = createWorld({ schedule: (callback) => queue.push(callback) })
    await call(base, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const fork = base.fork()
    const open = await consumer(fork, run, 'startup')
    fork.reset({ consumers: 'keep' })
    expect(open.state.closed).toBe(false)
    await call(fork, 'POST', '/inventory/managedObjects', { name: 'after' })
    run()
    expect(open.received.some((frame) => frame.includes('after'))).toBe(true)
  })

  it('accepts a token minted before snapshot and restore, and gives another subscriber another token', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 's' })
    const first = (await call(world, 'POST', '/notification2/token', { subscription: 's', subscriber: 'a' })).body.token as string
    const snapshot = world.snapshot()
    world.reset()
    world.restore(snapshot)
    const next = (await call(world, 'POST', '/notification2/token', { subscription: 's', subscriber: 'b' })).body.token as string
    expect(next).not.toBe(first)
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${first}`)
    run()
    expect(socket.token?.subscriber).toBe('a')
  })

  it('replays subscription ids the same after keeping a reconnected consumer', async () => {
    const { world, run } = manualWorld()
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'startup' })
    const startup = world.checkpoint()
    const first = (await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'x' })).body.id
    world.reset({ to: startup, consumers: 'keep' })
    await consumer(world, run, 'startup')
    world.reset({ to: startup, consumers: 'keep' })
    const again = (await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'x' })).body.id
    expect(again).toBe(first)
  })
})
