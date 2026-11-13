/**
 * Trials on forks: a request still in flight when the harness resets the
 * fork must not change the next trial, and forks are independent of each
 * other and of their base (clock, callbacks, overrides).
 */
import { describe, expect, it } from 'vitest'
import { createClock, createWorld } from '../../src'
import type { World } from '../../src'

/**
 * A binary upload body (`POST /inventory/binaries`).
 * @param content - File content
 */
function binaryUpload(content: Uint8Array<ArrayBuffer> | string): FormData {
  const form = new FormData()
  form.append('object', JSON.stringify({ name: 'upload', type: 'application/octet-stream' }))
  form.append('file', new Blob([content]), 'upload.bin')
  return form
}

const START = '2026-10-24T00:00:00.000Z'
const json = { 'accept': 'application/json', 'content-type': 'application/json' }

function frozenClock() {
  return createClock({ start: START, realtime: false })
}

describe('reset() while a request is in flight', () => {
  it('keeps the request out of the next trial', async () => {
    const base = createWorld({ clock: frozenClock() })
    base.device({ name: 'd' })
    const fork = base.fork()
    const pending = fork.fetch(new Request(`${fork.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'stale' }) }))
    fork.reset()
    expect((await pending).status).toBe(503)
    expect(fork.diff().tenants).toEqual({})
    expect(fork.calls).toEqual([])
    expect(fork.coverage().valid).toBe(true)
    // the next trial gets the ids the stale request would have taken
    const fresh = await fork.fetch(new Request(`${fork.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'fresh' }) }))
    const replay = base.fork()
    const same = await replay.fetch(new Request(`${replay.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'fresh' }) }))
    expect((await fresh.json()).id).toBe((await same.json()).id)
  })

  it('keeps a binary upload out of the next trial, at any point of the request', async () => {
    for (let ticks = 0; ticks < 6; ticks++) {
      const base = createWorld({ clock: frozenClock() })
      const fork = base.fork()
      const pending = fork.fetch(new Request(`${fork.baseUrl}/inventory/binaries`, { method: 'POST', headers: { accept: 'application/json' }, body: binaryUpload(new Uint8Array([1, 2, 3])) }))
      for (let i = 0; i < ticks; i++) {
        await Promise.resolve()
      }
      fork.reset()
      const response = await pending
      expect([201, 503]).toContain(response.status)
      expect(fork.diff().tenants).toEqual({})
      expect(fork.calls).toEqual([])
    }
  })

  it('keeps the request out of a restored state too', async () => {
    const world = createWorld({ clock: frozenClock() })
    const snapshot = world.snapshot()
    const pending = world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'stale' }) }))
    world.restore(snapshot)
    expect((await pending).status).toBe(503)
    expect(world.snapshot()).toEqual(snapshot)
  })
})

describe('forks have their own state', () => {
  it('get a clock of their own at the base time', async () => {
    const base = createWorld({ clock: frozenClock() })
    const a = base.fork()
    const b = base.fork()
    a.advance(86_400_000)
    const created = await b.fetch(new Request(`${b.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'x' }) }))
    expect((await created.json()).creationTime).toBe(START)
    const later = await a.fetch(new Request(`${a.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'y' }) }))
    expect((await later.json()).creationTime).toBe('2026-10-25T00:00:00.000Z')
  })

  it('set their own clock back to the fork\'s start on reset, so a replay is exact', async () => {
    const base = createWorld({ clock: frozenClock() })
    const device = base.device({ name: 'd', c8y_RequiredAvailability: { responseInterval: 10 } })
    const trial = base.fork()
    const run = async () => {
      const created = await trial.fetch(new Request(`${trial.baseUrl}/alarm/alarms`, { method: 'POST', headers: json, body: JSON.stringify({ source: { id: device }, type: 'a', text: 'a', severity: 'MAJOR', time: START }) }))
      const { id, creationTime } = await created.json()
      trial.advance(25 * 60_000)
      return { id, creationTime, diff: trial.diff() }
    }
    const first = await run()
    trial.reset()
    expect(await run()).toEqual(first)
    // a clock passed to fork() belongs to the caller
    const clock = frozenClock()
    const own = base.fork({ clock })
    own.advance(60_000)
    own.reset()
    expect(clock.now()).toBe(Date.parse(START) + 60_000)
  })

  it('also with a clock not made by createClock()', () => {
    let time = Date.parse(START)
    const clock = { now: () => time, advance: (ms: number) => {
      time += ms
    }, set: (value: number | string) => {
      time = typeof value === 'number' ? value : Date.parse(value)
    } }
    const base = createWorld({ clock })
    const a = base.fork()
    const b = base.fork()
    a.advance(1000)
    expect(a.db.managedObjects.get(a.device())!.creationTime).toBe('2026-10-24T00:00:01.000Z')
    expect(b.db.managedObjects.get(b.device())!.creationTime).toBe(START)
  })

  it('pass the world to callbacks', async () => {
    const changed: unknown[] = []
    const unsupported: unknown[] = []
    const forks: World[] = []
    const base = createWorld({ unsupported: (_request, world) => Response.json({ from: world === forks[0] ? 'a' : 'other' }, { status: 501 }), onChange: (world) => changed.push(world), onUnsupported: (_request, world) => unsupported.push(world) })
    const a = base.fork()
    const b = base.fork()
    forks.push(a)
    changed.length = 0
    b.setUser(null)
    expect(changed).toEqual([b])
    const answer = await a.fetch(new Request(`${a.baseUrl}/application/applications/1/versions`))
    expect(await answer.json()).toEqual({ from: 'a' })
    expect(unsupported).toEqual([a])
  })

  it('give overrides the fork they serve and a body they can read', async () => {
    const base = createWorld()
    base.device({ name: 'base' })
    base.override('POST /service/svc/**', async (request, { world }) => {
      const body = await request.json() as { name: string }
      world.device({ name: body.name })
      return { names: world.db.managedObjects.find().map((item) => item.name) }
    })
    const a = base.fork()
    const b = base.fork()
    const send = (world: typeof a, name: string) => world.fetch(new Request(`${world.baseUrl}/service/svc/create`, { method: 'POST', headers: json, body: JSON.stringify({ name }) }))
    expect(await (await send(a, 'in-a')).json()).toEqual({ names: ['base', 'in-a'] })
    expect(await (await send(b, 'in-b')).json()).toEqual({ names: ['base', 'in-b'] })
    // a fork's reset keeps the overrides it got from its base
    a.reset()
    expect(await (await send(a, 'again')).json()).toEqual({ names: ['base', 'again'] })
  })

  it('apply an override registered on a frozen base to forks created after it', async () => {
    const base = createWorld()
    const early = base.fork()
    base.override('GET /service/late', () => ({ late: true }))
    const late = base.fork()
    expect((await late.fetch(new Request(`${late.baseUrl}/service/late`))).status).toBe(200)
    expect((await early.fetch(new Request(`${early.baseUrl}/service/late`))).status).toBe(404)
  })

  it('let an override report a request as not emulated', async () => {
    const { UnsupportedRequestError } = await import('../../src')
    const world = createWorld({ unsupported: 'platform' })
    world.override('/service/svc/**', () => {
      throw new UnsupportedRequestError('the service does not emulate this')
    })
    expect((await world.fetch(new Request(`${world.baseUrl}/service/svc/x`))).status).toBe(501)
    expect(world.coverage().unhandled.map((request) => [request.kind, request.reason])).toEqual([['feature', 'the service does not emulate this']])
  })

  it('mute async operations until they settle', async () => {
    const world = createWorld({ schedule: () => {} })
    await world.fetch(new Request(`${world.baseUrl}/notification2/subscriptions`, { method: 'POST', headers: json, body: JSON.stringify({ context: 'tenant', subscription: 'all' }) }))
    await world.muted(async () => {
      await Promise.resolve()
      await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'quiet' }) }))
    })
    expect(world.realtime.backlog.size).toBe(0)
    await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'loud' }) }))
    expect(world.realtime.backlog.size).toBe(1)
  })
})
