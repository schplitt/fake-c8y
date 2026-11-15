/**
 * `world.override()`: handlers that answer instead of the world, pass the
 * request on with `ctx.next()`, and count their requests (`ctx.callCount`).
 */
import { describe, expect, it } from 'vitest'
import { compileRoute, createWorld, matchesCall, UnsupportedRequestError } from '../../src'
import type { World } from '../../src'

const json = { 'accept': 'application/json', 'content-type': 'application/json' }

function send(world: World, method: string, path: string, body?: unknown): Promise<Response> {
  return world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: json, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
}

const alarm = (source: string) => ({ source: { id: source }, type: 'hot', text: 'hot', severity: 'MAJOR', time: '2026-11-01T00:00:00.000Z' })

describe('world.override()', () => {
  it('answers instead of the world with the request and the params', async () => {
    const world = createWorld()
    world.override('POST /custom/:name/**', async (request, ctx) => {
      return { method: request.method, name: ctx.params.name, rest: ctx.params._, body: await request.json(), tenant: ctx.tenant, callCount: ctx.callCount }
    })
    const response = await send(world, 'POST', '/custom/pump/a/b', { x: 1 })
    expect(await response.json()).toEqual({ method: 'POST', name: 'pump', rest: 'a/b', body: { x: 1 }, tenant: world.tenant, callCount: 1 })
    expect(world.calls).toHaveLength(1)
    expect(world.calls[0]!.status).toBe(200)
  })

  it('gets every request without a pattern and passes on what it does not answer', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    const seen: string[] = []
    world.override((request, ctx) => {
      const { pathname } = new URL(request.url)
      seen.push(`${request.method} ${pathname} ${ctx.callCount}`)
      if (request.method === 'GET' && pathname === '/custom/health') {
        return { status: 'UP' }
      }
      return ctx.next()
    })
    expect(await (await send(world, 'GET', '/custom/health')).json()).toEqual({ status: 'UP' })
    expect((await send(world, 'GET', `/inventory/managedObjects/${pump}`)).status).toBe(200)
    expect(seen).toEqual(['GET /custom/health 1', `GET /inventory/managedObjects/${pump} 2`])
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

  it('fails the nth request and passes the others on', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    world.override('POST /alarm/alarms', (_request, ctx) => ctx.callCount === 2 ? Response.json({ error: 'general/500' }, { status: 500 }) : ctx.next())
    const statuses = []
    for (let i = 0; i < 3; i++) {
      statuses.push((await send(world, 'POST', '/alarm/alarms', { ...alarm(pump), type: `hot${i}` })).status)
    }
    expect(statuses).toEqual([201, 500, 201])
    expect(world.calls.map((call) => call.status)).toEqual([201, 500, 201])
    expect(world.db.alarms.find()).toHaveLength(2)
  })

  it('counts only the requests the override got', async () => {
    const world = createWorld()
    const counts: number[] = []
    world.override('GET /inventory/managedObjects/:id', (_request, ctx) => {
      counts.push(ctx.callCount)
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

  it('records an UnsupportedRequestError as a feature the fake does not emulate', async () => {
    const world = createWorld()
    world.override('GET /custom/feature', () => {
      throw new UnsupportedRequestError('revert is not supported')
    })
    expect((await send(world, 'GET', '/custom/feature')).status).toBe(501)
    expect(world.unhandled).toMatchObject([{ kind: 'feature', reason: 'revert is not supported' }])
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
      counts.push([ctx.world === base ? 'base' : 'fork', ctx.callCount])
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

describe('network errors (Response.error())', () => {
  it('makes world.fetch() reject with a TypeError and records the call', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    world.override('GET /inventory/managedObjects/:id', () => Response.error())
    const error = await send(world, 'GET', `/inventory/managedObjects/${pump}`).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toBe('fetch failed')
    expect(world.calls).toMatchObject([{ path: `/inventory/managedObjects/${pump}`, status: 0, networkError: true }])
    expect(world.unhandled).toEqual([])
    expect(world.coverage().valid).toBe(true)
  })

  it('keeps what next() wrote when the client sees a network error', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    world.override('POST /alarm/alarms', async (_request, ctx) => {
      await ctx.next()
      return Response.error()
    })
    await expect(send(world, 'POST', '/alarm/alarms', alarm(pump))).rejects.toBeInstanceOf(TypeError)
    expect(world.db.alarms.find()).toHaveLength(1)
    expect(world.calls[0]).toMatchObject({ networkError: true, writes: [{ collection: 'alarms', action: 'created' }] })
  })

  it('comes back from next() as the response, so an outer override passes it on', async () => {
    const world = createWorld()
    const seen: string[] = []
    world.override('GET /inventory/managedObjects', () => Response.error())
    world.override('GET /inventory/**', async (_request, ctx) => {
      const response = await ctx.next()
      seen.push(response.type)
      return response
    })
    await expect(send(world, 'GET', '/inventory/managedObjects')).rejects.toBeInstanceOf(TypeError)
    expect(seen).toEqual(['error'])
    expect(world.calls).toHaveLength(1)
  })

  it('counts what next() stored in the usage statistics', async () => {
    const world = createWorld({ now: () => Date.parse('2026-11-07T10:00:00Z') })
    const pump = world.device({ name: 'Pump' })
    world.override('POST /alarm/alarms', async (_request, ctx) => {
      const response = await ctx.next()
      expect(response.status).toBe(201)
      return Response.error()
    })
    await expect(send(world, 'POST', '/alarm/alarms', alarm(pump))).rejects.toBeInstanceOf(TypeError)
    const statistics = await (await send(world, 'GET', '/tenant/statistics?pageSize=2000')).json() as { usageStatistics: Array<{ alarmsCreatedCount: number }> }
    expect(statistics.usageStatistics.at(-1)?.alarmsCreatedCount).toBe(1)
  })

  it('returns the response from next() (nothing thrown) when an older override fails', async () => {
    const world = createWorld()
    const outcomes: string[] = []
    world.override('GET /inventory/managedObjects', () => Response.error())
    world.override('GET /inventory/managedObjects', async (_request, ctx) => {
      const response = await ctx.next()
      outcomes.push(`${response.type} ${response.status}`)
      return { recovered: true }
    })
    expect(await (await send(world, 'GET', '/inventory/managedObjects')).json()).toEqual({ recovered: true })
    expect(outcomes).toEqual(['error 0'])
    expect(world.calls[0]).toMatchObject({ status: 200 })
    expect(world.calls[0]!.networkError).toBeUndefined()
  })

  it('makes a second next() a 500 of kind error, also after a network error below', async () => {
    const world = createWorld()
    world.override('GET /inventory/managedObjects', () => Response.error())
    world.override('GET /inventory/managedObjects', async (_request, ctx) => {
      await ctx.next()
      return ctx.next()
    })
    expect((await send(world, 'GET', '/inventory/managedObjects')).status).toBe(500)
    expect(world.unhandled).toMatchObject([{ kind: 'error', reason: expect.stringContaining('next() was called twice') }])
  })

  it('rejects with the abort reason, unsent, for an already aborted signal', async () => {
    const world = createWorld()
    world.override('GET /inventory/managedObjects', () => Response.error())
    const controller = new AbortController()
    controller.abort(new Error('early'))
    await expect(world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { signal: controller.signal }))).rejects.toThrow('early')
    expect(world.calls).toEqual([])
  })

  it('works on a fork: its own calls, counts, and a base service fetching there', async () => {
    const base = createWorld({ roles: 'off' })
    base.override('GET /inventory/managedObjects', (_request, ctx) => (ctx.callCount === 1 ? Response.error() : ctx.next()))
    base.service('proxy', async (_request, ctx) => {
      try {
        return await ctx.fetch('/inventory/managedObjects')
      } catch (error) {
        return Response.json({ failed: error instanceof TypeError })
      }
    })
    const fork = base.fork()
    expect(await (await send(fork, 'GET', '/service/proxy/x')).json()).toEqual({ failed: true })
    expect((await send(fork, 'GET', '/service/proxy/x')).status).toBe(200)
    expect(fork.callsTo('GET /inventory/managedObjects').map((call) => [call.parent, call.networkError ?? false])).toEqual([[1, true], [3, false]])
    expect(base.calls).toEqual([])
    expect(fork.coverage().valid).toBe(true)
  })

  it('keeps a throwing handler a 500 of kind error', async () => {
    const world = createWorld()
    world.override('GET /inventory/managedObjects', () => {
      throw new TypeError('boom')
    })
    expect((await send(world, 'GET', '/inventory/managedObjects')).status).toBe(500)
    expect(world.unhandled).toMatchObject([{ kind: 'error' }])
    expect(world.calls[0]!.networkError).toBeUndefined()
  })

  it('rejects a service\'s ctx.fetch(); uncaught, the service answers 500 and the trial stays valid', async () => {
    const world = createWorld()
    world.override('GET /inventory/managedObjects', () => Response.error())
    world.service('caught', async (_request, ctx) => {
      try {
        await ctx.fetch('/inventory/managedObjects')
        return Response.json({ caught: false })
      } catch (error) {
        return Response.json({ caught: error instanceof TypeError })
      }
    })
    world.service('uncaught', async (_request, ctx) => ctx.fetch('/inventory/managedObjects'))
    expect(await (await send(world, 'GET', '/service/caught/x')).json()).toEqual({ caught: true })
    const response = await send(world, 'GET', '/service/uncaught/x')
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'fake-c8y/error', message: expect.stringContaining('GET /inventory/managedObjects was answered with a network error') })
    expect(world.coverage().valid).toBe(true)
    expect(world.calls.map((call) => [call.path, call.status, call.networkError ?? false])).toEqual([
      ['/service/caught/x', 200, false],
      ['/inventory/managedObjects', 0, true],
      ['/service/uncaught/x', 500, false],
      ['/inventory/managedObjects', 0, true],
    ])
  })

  it('recognizes a wrapped network error; the platform mode hides the cause', async () => {
    const world = createWorld({ unsupported: 'platform' })
    world.override('GET /inventory/managedObjects', () => Response.error())
    world.service('wrapping', async (_request, ctx) => {
      try {
        return await ctx.fetch('/inventory/managedObjects')
      } catch (error) {
        throw new Error('inventory unavailable', { cause: error })
      }
    })
    const response = await send(world, 'GET', '/service/wrapping/x')
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'general/Internal Server Error', message: 'Internal server error' })
    expect(world.coverage().valid).toBe(true)
  })

  it('lets a service handler answer with a network error', async () => {
    const world = createWorld()
    world.service('flaky', () => Response.error())
    await expect(send(world, 'GET', '/service/flaky/x')).rejects.toBeInstanceOf(TypeError)
    expect(world.calls[0]).toMatchObject({ service: 'flaky', networkError: true })
    expect(world.coverage().valid).toBe(true)
  })

  it('rejects with the abort reason when the signal fires first', async () => {
    const world = createWorld()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    world.override('GET /custom/slow', async () => {
      await waiting
      return Response.error()
    })
    const controller = new AbortController()
    const answer = world.fetch(new Request(`${world.baseUrl}/custom/slow`, { signal: controller.signal }))
    controller.abort(new Error('stop'))
    await expect(answer).rejects.toThrow('stop')
    release()
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(world.calls[0]).toMatchObject({ aborted: true, networkError: true })
  })
})

describe('world.callsTo() and matchesCall()', () => {
  it('returns the recorded calls matching a pattern', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    await send(world, 'GET', `/inventory/managedObjects/${pump}`)
    await send(world, 'POST', '/alarm/alarms', alarm(pump))
    await send(world, 'GET', `/inventory/managedObjects/${pump}?withParents=true`)
    await send(world, 'GET', '/inventory/managedObjects')
    expect(world.callsTo('GET /inventory/managedObjects/:id').map((call) => call.id)).toEqual([1, 3])
    expect(world.callsTo('/inventory/**')).toHaveLength(3)
    expect(world.callsTo('post /alarm/alarms')).toMatchObject([{ method: 'POST', status: 201 }])
    expect(world.callsTo('DELETE /alarm/alarms')).toEqual([])
    expect(matchesCall('GET /inventory/*/:id', world.calls[3]!)).toBe(false)
    expect(matchesCall('GET /inventory/managedObjects', world.calls[3]!)).toBe(true)
  })

  it('matches encoded / and ? inside a segment like override() does', async () => {
    const world = createWorld()
    const matched: string[] = []
    world.override('GET /custom/:id/c', (_request, ctx) => {
      matched.push(ctx.params.id!)
      return {}
    })
    await send(world, 'GET', '/custom/a%2Fb/c')
    await send(world, 'GET', '/custom/a%3Fb/c')
    expect(matched).toEqual(['a/b', 'a?b'])
    expect(world.callsTo('GET /custom/:id/c')).toHaveLength(2)
    expect(world.callsTo('GET /custom/:id')).toEqual([])
    expect(world.callsTo('GET /custom/a/b/c')).toEqual([])
    expect(matchesCall('GET /custom/*/c', world.calls[1]!)).toBe(true)
  })

  it('matches :param and * mid-path, compiled routes, and calls of network errors and aborts', async () => {
    const world = createWorld()
    world.override('GET /custom/fail/**', () => Response.error())
    world.override('GET /custom/slow', async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
      return {}
    })
    await send(world, 'GET', '/custom/fail/x/y').catch(() => undefined)
    const controller = new AbortController()
    const slow = world.fetch(new Request(`${world.baseUrl}/custom/slow`, { signal: controller.signal })).catch(() => undefined)
    controller.abort()
    await slow
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
    expect(world.callsTo('GET /custom/:what/x/*')).toMatchObject([{ networkError: true }])
    expect(world.callsTo('/custom/*')).toMatchObject([{ aborted: true }])
    const route = compileRoute('GET /custom/:what/*/y')
    expect(world.calls.filter((call) => matchesCall(route, call))).toHaveLength(1)
  })

  it('matches unhandled requests and platform errors too', async () => {
    const world = createWorld()
    await send(world, 'GET', '/application/applications/1/versions')
    await send(world, 'GET', '/inventory/nothing/here')
    const { unhandled, platformErrors } = world.coverage()
    expect(matchesCall('GET /application/applications/:id/versions', unhandled[0]!)).toBe(true)
    expect(platformErrors.filter((call) => matchesCall('/inventory/**', call))).toHaveLength(1)
  })

  it('counts per fork', async () => {
    const base = createWorld()
    await send(base, 'GET', '/inventory/managedObjects')
    const fork = base.fork()
    await send(fork, 'GET', '/inventory/managedObjects')
    await send(fork, 'GET', '/inventory/managedObjects')
    expect(base.callsTo('/inventory/**')).toHaveLength(1)
    expect(fork.callsTo('/inventory/**')).toHaveLength(2)
  })

  it('starts over after a reset', async () => {
    const world = createWorld()
    await send(world, 'GET', '/inventory/managedObjects')
    world.reset()
    expect(world.callsTo('/inventory/**')).toEqual([])
  })
})

describe('ctx.call', () => {
  it('is the recorded call: method, decoded path, query, parsed body, headers', async () => {
    const world = createWorld()
    let seen: unknown
    world.override('/custom/**', (_request, ctx) => {
      seen = { call: ctx.call, same: ctx.call === world.calls.at(-1), hasStatus: 'status' in ctx.call }
      return {}
    })
    await world.fetch(new Request(`${world.baseUrl}/custom/a%20b?x=1&x=2&y=3`, { method: 'POST', headers: { ...json, 'x-http-method': 'PUT', 'X-Mixed-Case': 'v' }, body: JSON.stringify({ n: 1 }) }))
    expect(seen).toMatchObject({
      call: { id: 1, method: 'PUT', path: '/custom/a b', query: { x: '1', y: '3' }, body: { n: 1 }, headers: { 'content-type': 'application/json', 'x-mixed-case': 'v' } },
      same: false,
      hasStatus: false,
    })
  })

  it('is a copy: changing it leaves the call log as it was', async () => {
    const world = createWorld()
    world.override('POST /custom/x', (_request, ctx) => {
      ctx.call.query.y = 'changed'
      ctx.call.headers.added = 'yes'
      ;(ctx.call.body as { n: number }).n = 2
      return {}
    })
    await world.fetch(new Request(`${world.baseUrl}/custom/x?y=1`, { method: 'POST', headers: json, body: JSON.stringify({ n: 1 }) }))
    expect(world.calls[0]).toMatchObject({ query: { y: '1' }, body: { n: 1 } })
    expect(world.calls[0]!.headers.added).toBeUndefined()
  })

  it('has the text of a text body and no body for multipart', async () => {
    const world = createWorld()
    const bodies: unknown[] = []
    world.override('POST /custom/**', (_request, ctx) => {
      bodies.push(ctx.call.body)
      return {}
    })
    await world.fetch(new Request(`${world.baseUrl}/custom/text`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' }))
    const multipart = '--b\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b--\r\n'
    await world.fetch(new Request(`${world.baseUrl}/custom/multipart`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=b' }, body: multipart }))
    expect(bodies).toEqual(['hello', undefined])
  })

  it('has no body for binary uploads; the request copy has the bytes', async () => {
    const world = createWorld()
    let seen: unknown
    world.override('POST /custom/upload', async (request, ctx) => {
      seen = { body: ctx.call.body, bytes: [...new Uint8Array(await request.arrayBuffer())] }
      return {}
    })
    await world.fetch(new Request(`${world.baseUrl}/custom/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) }))
    expect(seen).toEqual({ body: undefined, bytes: [1, 2, 3] })
  })
})
