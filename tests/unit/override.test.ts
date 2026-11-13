/**
 * `world.override()`: handlers that answer instead of the world, pass the
 * request on with `ctx.next()`, and count their matches (`ctx.matchCount`).
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'

const json = { 'accept': 'application/json', 'content-type': 'application/json' }

function send(world: World, method: string, path: string, body?: unknown): Promise<Response> {
  return world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: json, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
}

const alarm = (source: string) => ({ source: { id: source }, type: 'hot', text: 'hot', severity: 'MAJOR', time: '2026-11-01T00:00:00.000Z' })

describe('world.override()', () => {
  it('answers instead of the world with the request, the params, and the call', async () => {
    const world = createWorld()
    world.override('POST /custom/:name/**', async (request, ctx) => {
      expect(ctx.call).toBe(world.calls[0])
      return { name: ctx.params.name, rest: ctx.params._, body: await request.json(), parsed: ctx.call.body, tenant: ctx.tenant, matchCount: ctx.matchCount }
    })
    const response = await send(world, 'POST', '/custom/pump/a/b', { x: 1 })
    expect(await response.json()).toEqual({ name: 'pump', rest: 'a/b', body: { x: 1 }, parsed: { x: 1 }, tenant: world.tenant, matchCount: 1 })
    expect(world.calls).toHaveLength(1)
    expect(world.calls[0]!.status).toBe(200)
  })

  it('passes a request on with next(): one call, written by the platform', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    world.override('POST /alarm/alarms', (_request, ctx) => ctx.next())
    const response = await send(world, 'POST', '/alarm/alarms', alarm(pump))
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(world.db.alarms.find()).toHaveLength(1)
    expect(world.calls).toHaveLength(1)
    expect(world.calls[0]).toMatchObject({ status: 201, writes: [{ collection: 'alarms', action: 'created' }] })
  })

  it('fails the nth match and passes the others on', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    world.override('POST /alarm/alarms', (_request, ctx) => ctx.matchCount === 2 ? Response.json({ error: 'general/500' }, { status: 500 }) : ctx.next())
    const statuses = []
    for (let i = 0; i < 3; i++) {
      statuses.push((await send(world, 'POST', '/alarm/alarms', { ...alarm(pump), type: `hot${i}` })).status)
    }
    expect(statuses).toEqual([201, 500, 201])
    expect(world.calls.map((call) => call.status)).toEqual([201, 500, 201])
    expect(world.db.alarms.find()).toHaveLength(2)
  })

  it('counts only the requests the override matched', async () => {
    const world = createWorld()
    const counts: number[] = []
    world.override('GET /inventory/managedObjects/:id', (_request, ctx) => {
      counts.push(ctx.matchCount)
      return ctx.next()
    })
    const pump = world.device({ name: 'Pump' })
    await send(world, 'GET', `/inventory/managedObjects/${pump}`)
    await send(world, 'GET', '/inventory/managedObjects')
    await send(world, 'GET', `/inventory/managedObjects/${pump}`)
    expect(counts).toEqual([1, 2])
  })

  it('changes the answer after next()', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    world.override('GET /inventory/managedObjects/:id', async (_request, ctx) => {
      const response = await ctx.next()
      return { ...(await response.json() as object), name: 'Renamed' }
    })
    const response = await send(world, 'GET', `/inventory/managedObjects/${pump}`)
    expect(await response.json()).toMatchObject({ id: pump, name: 'Renamed' })
    expect(world.db.managedObjects.get(pump)?.name).toBe('Pump')
  })

  it('keeps what next() wrote when the client sees an error', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    const before = world.snapshot()
    world.override('POST /alarm/alarms', async (_request, ctx) => {
      await ctx.next()
      return new Response(null, { status: 503 })
    })
    expect((await send(world, 'POST', '/alarm/alarms', alarm(pump))).status).toBe(503)
    expect(world.calls[0]).toMatchObject({ status: 503, writes: [{ collection: 'alarms', action: 'created' }] })
    expect(world.diff(before).tenants[world.tenant]?.alarms?.created).toHaveLength(1)
  })

  it('reaches the next older override, then the platform', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    const order: string[] = []
    world.override('GET /inventory/managedObjects/:id', async (_request, ctx) => {
      order.push('inner')
      return ctx.next()
    })
    world.override('GET /inventory/**', async (_request, ctx) => {
      order.push('outer')
      const response = await ctx.next()
      order.push(`outer got ${response.status}`)
      return response
    })
    expect((await send(world, 'GET', `/inventory/managedObjects/${pump}`)).status).toBe(200)
    expect(order).toEqual(['outer', 'inner', 'outer got 200'])
    expect(world.calls).toHaveLength(1)
  })

  it('stops matching once removed', async () => {
    const world = createWorld()
    const remove = world.override('GET /custom/x', () => ({ from: 'override' }))
    expect(await (await send(world, 'GET', '/custom/x')).json()).toEqual({ from: 'override' })
    remove()
    // a path the fake does not know
    expect((await send(world, 'GET', '/custom/x')).status).toBe(501)
  })

  it('records an unemulated request passed on with next() as unhandled', async () => {
    const world = createWorld()
    world.override('GET /application/applications/:id/versions', async (_request, ctx) => {
      const response = await ctx.next()
      expect(response.status).toBe(501)
      return []
    })
    const response = await send(world, 'GET', '/application/applications/1/versions')
    expect(response.status).toBe(200)
    expect(world.unhandled).toMatchObject([{ path: '/application/applications/1/versions', kind: 'endpoint', status: 200 }])
  })

  it('reaches a registered service through next()', async () => {
    const world = createWorld()
    world.service('svc', () => Response.json({ from: 'service' }))
    world.override('/service/svc/**', (_request, ctx) => ctx.next())
    expect(await (await send(world, 'GET', '/service/svc/x')).json()).toEqual({ from: 'service' })
    expect(world.calls[0]).toMatchObject({ status: 200, service: 'svc' })
  })

  it('answers a second next() with a 500', async () => {
    const world = createWorld()
    world.override('GET /inventory/managedObjects', async (_request, ctx) => {
      await ctx.next()
      return ctx.next()
    })
    expect((await send(world, 'GET', '/inventory/managedObjects')).status).toBe(500)
    expect(world.unhandled).toMatchObject([{ kind: 'error', reason: expect.stringContaining('next() was called twice') }])
  })

  it('records ctx.unsupported() as a feature the fake does not emulate', async () => {
    const world = createWorld()
    world.override('GET /custom/feature', (_request, ctx) => {
      try {
        ctx.unsupported('revert is not supported')
      } catch {
        // the request stays unhandled
      }
      return ctx.unsupported('revert is not supported')
    })
    expect((await send(world, 'GET', '/custom/feature')).status).toBe(501)
    expect(world.unhandled).toMatchObject([{ kind: 'feature', reason: 'revert is not supported' }, { kind: 'feature' }])
  })

  it('answers next() after a reset with a 503 and writes nothing', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    let passed: Response | undefined
    world.override('POST /alarm/alarms', async (_request, ctx) => {
      entered()
      await waiting
      passed = await ctx.next()
      return passed
    })
    const answer = send(world, 'POST', '/alarm/alarms', alarm(pump))
    await reached
    world.reset()
    release()
    expect((await answer).status).toBe(503)
    expect(passed?.status).toBe(503)
    expect(world.db.alarms.find()).toEqual([])
    expect(world.calls).toEqual([])
  })

  it('counts per world: a fork starts at 1, reset() starts over', async () => {
    const base = createWorld()
    const counts: Array<[string, number]> = []
    base.override('GET /custom/count', (_request, ctx) => {
      counts.push([ctx.world === base ? 'base' : 'fork', ctx.matchCount])
      return {}
    })
    await send(base, 'GET', '/custom/count')
    await send(base, 'GET', '/custom/count')
    const fork = base.fork()
    await send(fork, 'GET', '/custom/count')
    const other = base.fork()
    await send(other, 'GET', '/custom/count')
    await send(fork, 'GET', '/custom/count')
    fork.reset()
    await send(fork, 'GET', '/custom/count')
    expect(counts).toEqual([['base', 1], ['base', 2], ['fork', 1], ['fork', 1], ['fork', 2], ['fork', 1]])
  })

  it('passes a request on to the fork that got it, for an override of the base', async () => {
    const base = createWorld()
    const pump = base.device({ name: 'Pump' })
    base.override('POST /alarm/alarms', (_request, ctx) => ctx.next())
    const fork = base.fork()
    expect((await send(fork, 'POST', '/alarm/alarms', alarm(pump))).status).toBe(201)
    expect(fork.db.alarms.find()).toHaveLength(1)
    expect(base.db.alarms.find()).toEqual([])
    expect(fork.diff().tenants[fork.tenant]?.alarms?.created).toHaveLength(1)
  })
})
