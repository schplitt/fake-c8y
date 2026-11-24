/**
 * An open consumer socket with no frame either way (message, ack, ping) for
 * 5 minutes of real time closes with 1001. The real time comes from
 * `realNow()`, mocked here; the world clock and fake timers do not move it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClock, createWorld } from '../../src'
import type { World } from '../../src'
import { createFakeWebSocket } from '../../src/realtime-entry'

let fakeNow = 0

vi.mock('../../src/timers', async (original) => ({
  ...(await original<typeof import('../../src/timers')>()),
  realNow: () => fakeNow,
}))

const MINUTE = 60_000

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
 * A world whose scheduled callbacks run only when `run()` is called, with a
 * persistent subscription `sub`.
 * @param clock
 */
async function manualWorld(clock?: ReturnType<typeof createClock>) {
  const queue: Array<() => void> = []
  const schedule = (callback: () => void) => {
    queue.push(callback)
  }
  const world = createWorld({ schedule, ...(clock ? { clock } : {}) })
  const run = () => {
    while (queue.length > 0) {
      queue.shift()!()
    }
  }
  await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
  return { world, run, schedule }
}

async function open(world: World, run: () => void, subscriber = 'a') {
  const token = (await call(world, 'POST', '/notification2/token', { subscription: 'sub', subscriber })).body.token
  const WebSocket = createFakeWebSocket(world.realtime)
  const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
  const closes: unknown[][] = []
  const received: string[] = []
  socket.on('close', (...args: unknown[]) => closes.push(args))
  socket.on('message', (text: string) => received.push(text))
  run()
  expect(socket.readyState).toBe(1)
  return { socket, closes, received }
}

function publish(world: World) {
  world.realtime.publish(world.tenant, 'managedobjects', 'CREATE', { id: '9000000', name: 'x' }, undefined)
}

const ackId = (frame: string) => frame.split('\n')[0]!

beforeEach(() => {
  fakeNow = 1_000_000
})

afterEach(() => {
  vi.useRealTimers()
})

describe('idle consumer sockets', () => {
  it('close with 1001 and an empty reason after 5 minutes, not at 4:59', async () => {
    const { world, run } = await manualWorld()
    const consumer = await open(world, run)
    fakeNow += 5 * MINUTE - 1
    world.tick()
    run()
    expect(consumer.closes).toEqual([])
    fakeNow += 1
    world.tick()
    run()
    expect(consumer.closes).toEqual([[1001, '']])
    expect(consumer.socket.readyState).toBe(3)
    expect(world.realtime.consumers()).toEqual([])
  })

  it.each([
    ['a delivered message', (world: World, _consumer: Awaited<ReturnType<typeof open>>) => publish(world)],
    ['an ack', (_world: World, consumer: Awaited<ReturnType<typeof open>>) => consumer.socket.send('1')],
    ['a ping', (_world: World, consumer: Awaited<ReturnType<typeof open>>) => consumer.socket.ping()],
  ])('restarts the 5 minutes on %s', async (_name, activity) => {
    const { world, run } = await manualWorld()
    const consumer = await open(world, run)
    fakeNow += 4 * MINUTE
    activity(world, consumer)
    run()
    fakeNow += 4 * MINUTE
    world.tick()
    run()
    expect(consumer.closes).toEqual([])
    fakeNow += MINUTE
    world.tick()
    run()
    expect(consumer.closes).toEqual([[1001, '']])
  })

  it('is checked on a request', async () => {
    const { world, run } = await manualWorld()
    const consumer = await open(world, run)
    fakeNow += 5 * MINUTE
    await call(world, 'GET', '/inventory/managedObjects')
    run()
    expect(consumer.closes).toEqual([[1001, '']])
  })

  it('is not checked on activity of another socket, only on a tick', async () => {
    const { world, run } = await manualWorld()
    const idle = await open(world, run, 'a')
    fakeNow += MINUTE
    const busy = await open(world, run, 'b')
    fakeNow += 4 * MINUTE
    busy.socket.ping()
    run()
    expect(idle.closes).toEqual([])
    world.tick()
    run()
    expect(idle.closes).toEqual([[1001, '']])
    expect(busy.closes).toEqual([])
  })

  it('closes through the schedule, and settled() waits for the close', async () => {
    const { world, run } = await manualWorld()
    const consumer = await open(world, run)
    fakeNow += 5 * MINUTE
    world.tick()
    expect(consumer.closes).toEqual([])
    expect(consumer.socket.readyState).toBe(1)
    expect(world.realtime.status().scheduled).toBe(1)
    run()
    expect(consumer.closes).toEqual([[1001, '']])

    const real = createWorld()
    await call(real, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const token = (await call(real, 'POST', '/notification2/token', { subscription: 'sub', subscriber: 'a' })).body.token
    const WebSocket = createFakeWebSocket(real.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    const closes: unknown[][] = []
    socket.on('close', (...args: unknown[]) => closes.push(args))
    await real.realtime.settled()
    expect(socket.readyState).toBe(1)
    fakeNow += 5 * MINUTE
    real.tick()
    expect(closes).toEqual([])
    await real.realtime.settled()
    expect(closes).toEqual([[1001, '']])
  })

  it('does not close a socket touched after the close was scheduled', async () => {
    const { world, run } = await manualWorld()
    const consumer = await open(world, run)
    fakeNow += 5 * MINUTE
    world.tick()
    consumer.socket.send('1')
    run()
    expect(consumer.closes).toEqual([])
    expect(consumer.socket.readyState).toBe(1)
  })

  it('puts unacknowledged frames back into the backlog for a reconnect', async () => {
    const { world, run } = await manualWorld()
    const consumer = await open(world, run)
    publish(world)
    publish(world)
    run()
    expect(consumer.received.map(ackId)).toEqual(['1', '2'])
    consumer.socket.send('1')
    fakeNow += 5 * MINUTE
    world.tick()
    run()
    expect(consumer.closes).toEqual([[1001, '']])
    expect(world.realtime.status()).toMatchObject({ backlog: 1, unacknowledged: 0 })
    const again = await open(world, run)
    expect(again.received.map(ackId)).toEqual(['2'])
  })

  it('closes a socket held at the cap with a silent client, and keeps its held frames', async () => {
    const { world, run } = await manualWorld()
    const consumer = await open(world, run)
    for (let i = 0; i < 1002; i++) {
      publish(world)
    }
    run()
    expect(consumer.received).toHaveLength(1000)
    fakeNow += 5 * MINUTE
    world.tick()
    run()
    expect(consumer.closes).toEqual([[1001, '']])
    expect(world.realtime.status().backlog).toBe(1002)
  })

  it('restarts the timers of the sockets that stay on reset', async () => {
    const { world, run } = await manualWorld()
    const consumer = await open(world, run)
    fakeNow += 4 * MINUTE
    world.reset({ consumers: 'keep' })
    run()
    fakeNow += 4 * MINUTE
    world.tick()
    run()
    expect(consumer.closes).toEqual([])
    fakeNow += MINUTE
    world.tick()
    run()
    expect(consumer.closes).toEqual([[1001, '']])
  })

  it('never closes on a frozen base, but does on a fork', async () => {
    const { world: base, run, schedule } = await manualWorld()
    const onBase = await open(base, run, 'a')
    const fork = base.fork({ schedule })
    const onFork = await open(fork, run, 'b')
    fakeNow += 10 * MINUTE
    base.tick()
    run()
    expect(onBase.closes).toEqual([])
    fork.tick()
    run()
    expect(onFork.closes).toEqual([[1001, '']])
    expect(onBase.closes).toEqual([])
  })

  it('never closes on a frozen base on activity of another of its sockets', async () => {
    const { world: base, run, schedule } = await manualWorld()
    const idle = await open(base, run, 'a')
    const busy = await open(base, run, 'b')
    base.fork({ schedule })
    fakeNow += 10 * MINUTE
    busy.socket.ping()
    run()
    expect(idle.closes).toEqual([])
    expect(idle.socket.readyState).toBe(1)
  })

  it('is not aged by the world clock or by fake timers', async () => {
    // realNow is mocked here; settle.test.ts covers the real realNow under fake timers

    const { world, run } = await manualWorld(createClock({ start: '2026-01-01T00:00:00Z' }))
    const consumer = await open(world, run)
    world.advance(10 * MINUTE)
    run()
    vi.useFakeTimers()
    vi.advanceTimersByTime(10 * MINUTE)
    world.tick()
    run()
    expect(consumer.closes).toEqual([])
    expect(consumer.socket.readyState).toBe(1)
  })
})
