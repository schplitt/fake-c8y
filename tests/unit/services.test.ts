/**
 * Service emulations (`world.service()`): microservices at
 * `/service/<contextPath>/**` whose state is tenant data, so it forks,
 * resets, snapshots, restores, and diffs with the world.
 */
import { describe, expect, it } from 'vitest'
import { createClock, createWorld } from '../../src'
import type { C8yServiceHandler, World } from '../../src'

const json = { 'accept': 'application/json', 'content-type': 'application/json' }

async function send(world: World, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: { ...json, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

/**
 * A counter service: `POST /inc` adds one, `GET /count` reads it.
 * @param request
 * @param ctx
 */
const counter: C8yServiceHandler = async (request, ctx) => {
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname === '/inc') {
    const count = ((ctx.state.get('count') as number | undefined) ?? 0) + 1
    ctx.state.set('count', count)
    return Response.json({ count })
  }
  if (request.method === 'GET' && url.pathname === '/count') {
    return Response.json({ count: ctx.state.get('count') ?? 0 })
  }
  return ctx.unsupported(`${request.method} ${url.pathname}`)
}

/**
 * A notes service: `POST /notes` stores the body under a new id.
 * @param request
 * @param ctx
 */
const notes: C8yServiceHandler = async (request, ctx) => {
  const id = ctx.newId()
  ctx.store('notes').set(id, { ...await request.json(), by: ctx.user, at: new Date(ctx.now()).toISOString() })
  return Response.json({ id }, { status: 201 })
}

describe('world.service()', () => {
  it('keeps the state of two services apart in 20 parallel forks', async () => {
    const base = createWorld()
    base.service('counter', counter)
    base.service('notes', notes)
    const forks = Array.from({ length: 20 }, () => base.fork())
    await Promise.all(forks.map(async (fork, index) => {
      for (let i = 0; i <= index; i++) {
        await Promise.all([send(fork, 'POST', '/service/counter/inc'), send(fork, 'POST', '/service/notes/notes', { text: `fork ${index}` })])
      }
    }))
    for (const [index, fork] of forks.entries()) {
      expect((await send(fork, 'GET', '/service/counter/count')).body.count).toBe(index + 1)
      const stored = fork.db.serviceState('notes', 'notes').list()
      expect(stored).toHaveLength(index + 1)
      expect(stored.every(([, note]) => (note as { text: string }).text === `fork ${index}`)).toBe(true)
      expect(fork.coverage().valid).toBe(true)
    }
    // forks of the same base hand out the same ids
    expect(forks[0]!.db.serviceState('notes', 'notes').list()[0]![0]).toBe(forks[1]!.db.serviceState('notes', 'notes').list()[0]![0])
    expect(base.db.serviceState('counter').get('count')).toBeUndefined()
  })

  it('gives the handler the path below the context path, a readable body, and the caller', async () => {
    const world = createWorld({ clock: createClock({ start: '2026-11-01T00:00:00.000Z', realtime: false }) })
    world.service('notes', notes)
    world.service('echo', async (request, ctx) => Response.json({ url: request.url, service: ctx.service, tenant: ctx.tenant, user: ctx.user, serviceUser: ctx.serviceUser }))
    const created = await send(world, 'POST', '/service/notes/notes', { text: 'hi' }, { authorization: `Basic ${btoa(`${world.tenant}/eva:pw`)}` })
    expect(created.status).toBe(201)
    expect(world.db.serviceState('notes', 'notes').get(created.body.id)).toEqual({ text: 'hi', by: 'eva', at: '2026-11-01T00:00:00.000Z' })
    expect((await send(world, 'GET', '/service/echo/a/b?x=1')).body).toEqual({ url: `${world.baseUrl}/a/b?x=1`, service: 'echo', tenant: world.tenant, user: 'test-user', serviceUser: 'service_echo' })
  })

  it('keeps the platform 404 for services nobody registered, also after removing one', async () => {
    const world = createWorld()
    const remove = world.service('counter', counter)
    expect((await send(world, 'GET', '/service/counter/count')).status).toBe(200)
    remove()
    const answer = await send(world, 'GET', '/service/counter/count')
    expect([answer.status, answer.body.error]).toEqual([404, 'microservice/Not Found'])
    expect(world.coverage().valid).toBe(true)
  })

  it('lets forks use the base\'s services and register or replace their own', async () => {
    const base = createWorld()
    base.service('counter', counter)
    const first = base.fork()
    // registered on the frozen base after the first fork: only later forks get it
    base.service('notes', notes)
    const second = base.fork()
    expect((await send(first, 'POST', '/service/notes/notes', {})).status).toBe(404)
    expect((await send(second, 'POST', '/service/notes/notes', {})).status).toBe(201)
    first.service('counter', async () => Response.json({ replaced: true }))
    first.service('own', async () => Response.json({ own: true }))
    expect((await send(first, 'GET', '/service/counter/count')).body).toEqual({ replaced: true })
    expect((await send(second, 'GET', '/service/counter/count')).body).toEqual({ count: 0 })
    expect((await send(second, 'GET', '/service/own/x')).status).toBe(404)
    first.reset()
    // reset keeps services, also the fork's own
    expect((await send(first, 'GET', '/service/own/x')).body).toEqual({ own: true })
  })

  it('drops service state on reset and brings it back with restore', async () => {
    const base = createWorld()
    base.service('counter', counter)
    base.seed({ serviceState: [{ service: 'counter', key: 'count', value: 10 }] })
    const fork = base.fork()
    await send(fork, 'POST', '/service/counter/inc')
    const snapshot = fork.snapshot()
    expect(snapshot.tenants.find((tenant) => tenant.tenant === fork.tenant)!.serviceState).toEqual([['counter/default/count', 11]])
    await send(fork, 'POST', '/service/counter/inc')
    fork.restore(snapshot)
    expect((await send(fork, 'GET', '/service/counter/count')).body.count).toBe(11)
    fork.reset()
    expect((await send(fork, 'GET', '/service/counter/count')).body.count).toBe(10)

    const root = createWorld()
    root.service('counter', counter)
    await send(root, 'POST', '/service/counter/inc')
    root.reset()
    expect((await send(root, 'GET', '/service/counter/count')).body.count).toBe(0)
  })

  it('shows service state changes in diffs', async () => {
    const base = createWorld()
    base.service('counter', counter)
    base.service('notes', notes)
    base.seed({ serviceState: [{ service: 'counter', key: 'count', value: 1 }] })
    const fork = base.fork()
    await send(fork, 'POST', '/service/counter/inc')
    const { body } = await send(fork, 'POST', '/service/notes/notes', { text: 'n' })
    const diff = fork.diff()
    expect(diff).toEqual(fork.diff(base.snapshot()))
    const state = diff.tenants[fork.tenant]!.serviceState
    expect(state.updated).toEqual([{ before: { id: 'counter/default/count', service: 'counter', store: 'default', key: 'count', value: 1 }, after: { id: 'counter/default/count', service: 'counter', store: 'default', key: 'count', value: 2 } }])
    expect(state.created.map((entry) => [entry.service, entry.store, entry.key])).toEqual([['notes', 'notes', body.id]])
  })

  it('writes to the platform as the service user', async () => {
    const base = createWorld()
    const device = base.device({ name: 'pump' })
    base.service('alarms', async (_request, ctx) => {
      const marker = await ctx.fetch('/inventory/managedObjects', { method: 'POST', headers: json, body: JSON.stringify({ name: 'marker' }) })
      const alarm = await ctx.fetch(new Request(`${base.baseUrl}/alarm/alarms`, { method: 'POST', headers: json, body: JSON.stringify({ source: { id: device }, type: 'pump_hot', text: 'hot', severity: 'MAJOR', time: '2026-11-01T00:00:00.000Z' }) }))
      return Response.json({ marker: (await marker.json()).id, alarm: alarm.status })
    }, { user: 'service_alarm-raiser', manifest: { requiredRoles: ['ROLE_INVENTORY_ADMIN', 'ROLE_ALARM_ADMIN'] } })
    const fork = base.fork()
    const { body } = await send(fork, 'POST', '/service/alarms/raise')
    expect(body.alarm).toBe(201)
    const diff = fork.diff().tenants[fork.tenant]!
    expect(diff.managedObjects.created.map((object) => [object.id, object.owner])).toEqual([[body.marker, 'service_alarm-raiser']])
    expect(diff.alarms.created).toHaveLength(1)
    expect(diff.auditRecords.created.map((record) => record.user)).toEqual(['service_alarm-raiser'])
  })

  it('lets services call each other and links every call to its parent', async () => {
    const world = createWorld()
    world.service('counter', counter)
    world.service('front', async (_request, ctx) => {
      await ctx.fetch('/service/counter/inc', { method: 'POST' })
      const count = await (await ctx.fetch('/service/counter/count')).json()
      await ctx.fetch('/inventory/managedObjects?pageSize=1')
      return Response.json(count)
    })
    expect((await send(world, 'GET', '/service/front/go')).body).toEqual({ count: 1 })
    expect(world.calls.map((call) => [call.id, call.parent, call.method, call.path, call.user])).toEqual([
      [1, undefined, 'GET', '/service/front/go', undefined],
      [2, 1, 'POST', '/service/counter/inc', 'service_front'],
      [3, 1, 'GET', '/service/counter/count', 'service_front'],
      [4, 1, 'GET', '/inventory/managedObjects', 'service_front'],
    ])
    world.reset()
    await send(world, 'GET', '/service/front/go')
    expect(world.calls[0]!.id).toBe(1)
  })

  it('gives the handler its own call and the call it was sent for', async () => {
    const world = createWorld()
    const seen: Array<{ service: string, call: { id: number, parent?: number } }> = []
    world.service('inner', async (_request, ctx) => {
      seen.push({ service: ctx.service, call: ctx.call })
      return Response.json({})
    })
    world.service('outer', async (_request, ctx) => {
      seen.push({ service: ctx.service, call: ctx.call })
      await ctx.fetch('/service/inner/x')
      return Response.json({})
    })
    await send(world, 'GET', '/service/outer/x')
    expect(seen).toEqual([{ service: 'outer', call: { id: 1 } }, { service: 'inner', call: { id: 2, parent: 1 } }])
  })

  it('records the status, the duration, and the answering service of every call', async () => {
    const world = createWorld()
    world.service('counter', counter)
    world.service('front', async (_request, ctx) => {
      await ctx.fetch('/service/counter/inc', { method: 'POST' })
      await ctx.fetch('/service/counter/nothing')
      await ctx.fetch('/inventory/managedObjects/404404')
      return Response.json({}, { status: 202 })
    })
    world.service('broken', async () => {
      throw new TypeError('boom')
    })
    await send(world, 'GET', '/service/front/go')
    await send(world, 'GET', '/service/broken/x')
    await send(world, 'GET', '/service/missing/x')
    expect(world.calls.map((call) => [call.path, call.status, call.service])).toEqual([
      ['/service/front/go', 202, 'front'],
      ['/service/counter/inc', 200, 'counter'],
      ['/service/counter/nothing', 501, 'counter'],
      ['/inventory/managedObjects/404404', 404, undefined],
      ['/service/broken/x', 500, 'broken'],
      ['/service/missing/x', 404, undefined],
    ])
    expect(world.calls.every((call) => typeof call.durationMs === 'number' && call.durationMs >= 0)).toBe(true)
    // the unhandled entries carry the same status and duration
    expect(world.unhandled.map((request) => [request.path, request.status, typeof request.durationMs])).toEqual([
      ['/service/counter/nothing', 501, 'number'],
      ['/service/broken/x', 500, 'number'],
    ])
  })

  it('makes the trial invalid when a handler throws or reports unsupported', async () => {
    const world = createWorld()
    world.service('counter', counter)
    world.service('broken', async () => {
      throw new TypeError('boom')
    })
    world.service('swallow', async (_request, ctx) => {
      try {
        ctx.unsupported('swallowed')
      } catch {
        // the trial stays invalid anyway
      }
      return Response.json({})
    })
    expect((await send(world, 'GET', '/service/broken/x')).status).toBe(500)
    expect((await send(world, 'DELETE', '/service/counter/count')).status).toBe(501)
    expect((await send(world, 'GET', '/service/swallow/x')).status).toBe(200)
    const coverage = world.coverage()
    expect(coverage.valid).toBe(false)
    expect(coverage.unhandled.map((request) => [request.path, request.kind, request.reason])).toEqual([
      ['/service/broken/x', 'error', 'TypeError: boom'],
      ['/service/counter/count', 'feature', 'DELETE /count'],
      ['/service/swallow/x', 'feature', 'swallowed'],
    ])
  })

  it('answers 503 and changes nothing when the world is reset while a handler runs', async () => {
    const base = createWorld()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let afterReset: unknown
    base.service('slow', async (_request, ctx) => {
      ctx.state.set('before', 1)
      await waiting
      try {
        ctx.state.set('after', 1)
      } catch (error) {
        afterReset = error
      }
      await ctx.fetch('/inventory/managedObjects', { method: 'POST', headers: json, body: '{}' })
      return Response.json({})
    })
    const fork = base.fork()
    const pending = send(fork, 'POST', '/service/slow/x')
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    fork.reset()
    release()
    expect((await pending).status).toBe(503)
    expect(afterReset).toBeInstanceOf(TypeError)
    expect(fork.diff().tenants).toEqual({})
    expect(fork.calls).toEqual([])
    expect(fork.coverage().valid).toBe(true)
    expect(fork.inflight).toBe(0)
  })

  it('stores values as JSON and lists keys by prefix', async () => {
    const world = createWorld()
    world.service('s', async (_request, ctx) => {
      const store = ctx.store('jobs')
      store.set('a/1', { at: new Date(0) as unknown as string, skip: undefined as unknown as string })
      store.set('a/2', 2)
      store.set('b/1', 3)
      expect(() => store.set('x', undefined as unknown as null)).toThrow(TypeError)
      expect(() => ctx.store('a/b')).toThrow(TypeError)
      const copy = store.get('a/1') as Record<string, unknown>
      copy.changed = true
      return Response.json({ first: store.get('a/1'), list: store.list({ prefix: 'a/' }), limited: store.list({ limit: 1 }).length, deleted: store.delete('b/1'), again: store.delete('b/1') })
    })
    expect((await send(world, 'GET', '/service/s/x')).body).toEqual({
      first: { at: '1970-01-01T00:00:00.000Z' },
      list: [['a/1', { at: '1970-01-01T00:00:00.000Z' }], ['a/2', 2]],
      limited: 1,
      deleted: true,
      again: false,
    })
  })
})
