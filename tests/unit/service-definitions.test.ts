/**
 * Service definitions (`defineService()`, `world.service(definition)`): the
 * checks, the optional handler, the seed in every subscribed tenant (also
 * on a frozen base and after `reset()`), registering again, and
 * `world.services`.
 */
import { describe, expect, it } from 'vitest'
import { createWorld, defineService } from '../../src'
import type { C8yServiceDefinition, C8yServiceHandler, World } from '../../src'

const json = { 'accept': 'application/json', 'content-type': 'application/json' }

async function send(world: World, method: string, path: string, body?: unknown, login?: string) {
  const headers: Record<string, string> = { ...json, ...(login ? { authorization: `Basic ${btoa(`${login}:pw`)}` } : {}) }
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

/**
 * `POST /inc` adds one to `count`, `GET /count` reads it.
 * @param request
 * @param ctx
 */
const counterHandler: C8yServiceHandler = async (request, ctx) => {
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname === '/inc') {
    const count = ((ctx.state.get('count') as number | undefined) ?? 0) + 1
    ctx.state.set('count', count)
    return Response.json({ count })
  }
  return Response.json({ count: ctx.state.get('count') ?? 0, tenant: ctx.tenant })
}

const manifest = { name: 'counter-service', contextPath: 'counter', requiredRoles: ['ROLE_INVENTORY_READ'] }

const counter = defineService({
  manifest,
  seed: {
    state: [{ key: 'count', value: 10 }],
    managedObjects: [{ type: 'counter_Configuration', name: 'Counter configuration' }],
  },
  handler: counterHandler,
})

const configurations = (world: World, tenant = world.tenant) => world.db.tenant(tenant).managedObjects.find({ type: 'counter_Configuration' })

describe('defineService()', () => {
  it('takes the context path from the manifest and returns the definition frozen', () => {
    expect(counter.contextPath).toBe('counter')
    expect(Object.isFrozen(counter)).toBe(true)
    // a checked definition comes back as it is
    expect(defineService(counter)).toBe(counter)
    expect(defineService({ contextPath: 'counter', manifest }).contextPath).toBe('counter')
    expect(defineService({ contextPath: 'plain' }).manifest).toBeUndefined()
  })

  it('rejects a context path that differs from the manifest or is missing', () => {
    expect(() => defineService({ contextPath: 'ticket', manifest: { contextPath: 'tickets' } })).toThrow('fake-c8y: service ticket: contextPath \'ticket\' differs from manifest.contextPath \'tickets\'')
    expect(() => defineService({ manifest: { name: 'nameless' } })).toThrow('needs a contextPath, or a manifest with one')
    expect(() => defineService({ contextPath: 'a/b' })).toThrow('invalid service context path \'a/b\'')
    // the short form checks it too
    expect(() => createWorld().service('ticket', counterHandler, { manifest: { contextPath: 'tickets' } })).toThrow('differs from manifest.contextPath')
  })

  it('checks the handler and the seed and names the service', () => {
    expect(() => defineService({ contextPath: 'tickets', handler: 'nope' as unknown as C8yServiceHandler })).toThrow('fake-c8y: service tickets: handler must be a function')
    expect(() => defineService({ contextPath: 'tickets', seed: { state: [{ store: 'a/b', key: 'k', value: 1 }] } })).toThrow('fake-c8y: service tickets: seed: invalid store name \'a/b\'')
    expect(() => defineService({ contextPath: 'tickets', seed: { state: [{ key: 'k', value: undefined as unknown as null }] } })).toThrow('fake-c8y: service tickets: seed: the value of \'k\' is not JSON')
    // a seed function is checked per tenant, when it is applied
    const perTenant = defineService({ contextPath: 'tickets', seed: () => ({ state: [{ store: '', key: 'k', value: 1 }] }) })
    expect(() => createWorld().service(perTenant)).toThrow(`fake-c8y: service tickets: seed for ${createWorld().tenant}: invalid store name ''`)
  })
})

describe('world.service(definition)', () => {
  it('registers the same definition on several worlds, each with its own state', async () => {
    const a = createWorld()
    const b = createWorld({ tenant: 't9' })
    a.service(counter)
    b.service(counter)
    expect((await send(a, 'POST', '/service/counter/inc')).body.count).toBe(11)
    expect((await send(b, 'GET', '/service/counter/count')).body).toEqual({ count: 10, tenant: 't9' })
    expect(a.services.get('counter')).toBe(counter)
    expect([...b.services.keys()]).toEqual(['counter'])
  })

  it('accepts a plain definition and checks it', async () => {
    const world = createWorld()
    const plain: C8yServiceDefinition = { contextPath: 'plain', handler: async () => Response.json({ plain: true }) }
    const remove = world.service(plain)
    expect(world.service(plain)).toBe(remove)
    expect((await send(world, 'GET', '/service/plain/x')).body).toEqual({ plain: true })
    expect(world.services.get('plain')).toMatchObject({ contextPath: 'plain' })
    expect(() => world.service({ manifest: { contextPath: 'x' }, contextPath: 'y' })).toThrow('fake-c8y: service y:')
  })

  it('answers 501 without a handler, as a request the world does not emulate', async () => {
    const world = createWorld()
    world.service({ ...counter, handler: undefined })
    expect(world.db.applications.find({ name: 'counter-service' })).toHaveLength(1)
    const answer = await send(world, 'GET', '/service/counter/count')
    expect(answer.status).toBe(501)
    expect(world.calls.map((call) => [call.path, call.service, call.status])).toEqual([['/service/counter/count', 'counter', 501]])
    expect(world.coverage().unhandled.map((request) => [request.kind, request.reason])).toEqual([['feature', 'service counter is registered without a handler']])
    expect(world.coverage().valid).toBe(false)
  })

  it('lets a fork supply the handler for a definition its base registered without one', async () => {
    const base = createWorld()
    const definition = defineService({ ...counter, handler: undefined })
    base.service(definition)
    const fork = base.fork()
    fork.service(definition, { handler: counterHandler })
    expect(fork.diff().tenants).toEqual({})
    expect((await send(fork, 'POST', '/service/counter/inc')).body.count).toBe(11)
    fork.reset()
    expect((await send(fork, 'GET', '/service/counter/count')).body.count).toBe(10)
    expect(fork.diff().tenants).toEqual({})
    // the base and other forks keep answering 501
    expect((await send(base.fork(), 'GET', '/service/counter/count')).status).toBe(501)
  })

  it('seeds state and service-owned managed objects in every subscribed tenant', async () => {
    const world = createWorld({ tenant: 't1' })
    world.service(defineService({
      manifest,
      tenants: ['t1', 't2'],
      seed: (tenant) => ({ state: [{ store: 'meta', key: 'tenant', value: tenant }], managedObjects: [{ type: 'counter_Configuration', name: `config of ${tenant}` }] }),
      handler: counterHandler,
    }))
    for (const tenant of ['t1', 't2']) {
      expect(world.db.tenant(tenant).serviceState('counter', 'meta').list()).toEqual([['tenant', tenant]])
      expect(configurations(world, tenant).map((object) => [object.name, object.owner])).toEqual([[`config of ${tenant}`, 'service_counter-service']])
    }
    // seeding writes no audit records and sends no requests
    expect(world.calls).toEqual([])
    expect(world.db.auditRecords.find({})).toEqual([])
  })

  it('puts the seed into the base data of forks created after a registration on a frozen base', async () => {
    const base = createWorld()
    const early = base.fork()
    base.service(counter)
    expect(base.db.serviceState('counter').get('count')).toBe(10)
    const fork = base.fork()
    expect(fork.diff().tenants).toEqual({})
    expect(configurations(fork)).toHaveLength(1)
    expect((await send(fork, 'POST', '/service/counter/inc')).body.count).toBe(11)
    expect(fork.diff().tenants[fork.tenant]!.serviceState.updated).toHaveLength(1)
    fork.reset()
    expect(fork.diff().tenants).toEqual({})
    expect(early.db.serviceState('counter').get('count')).toBeUndefined()
    expect(configurations(early)).toEqual([])
  })

  it('applies the seed again on a root world\'s reset', async () => {
    const world = createWorld()
    world.service(counter)
    world.seed({ serviceState: [{ service: 'counter', key: 'extra', value: true }] })
    await send(world, 'POST', '/service/counter/inc')
    world.reset()
    expect(world.db.serviceState('counter').list()).toEqual([['count', 10]])
    expect(configurations(world)).toHaveLength(1)
    // the same ids as at the first registration after a reset, so repeatable
    const first = configurations(world)[0]!.id
    world.reset()
    expect(configurations(world).map((object) => object.id)).toEqual([first])
  })

  it('seeds a fork\'s own registration on the fork, and again on its reset', async () => {
    const base = createWorld()
    const fork = base.fork()
    fork.service(counter)
    expect(fork.diff().tenants[fork.tenant]!.serviceState.created.map((entry) => entry.key)).toEqual(['count'])
    await send(fork, 'POST', '/service/counter/inc')
    fork.reset()
    expect(fork.db.serviceState('counter').get('count')).toBe(10)
    expect(configurations(fork)).toHaveLength(1)
  })

  it('changes nothing when the same definition is registered again', async () => {
    const world = createWorld()
    const remove = world.service(counter)
    await send(world, 'POST', '/service/counter/inc')
    expect(world.service(counter)).toBe(remove)
    expect(world.db.serviceState('counter').get('count')).toBe(11)
    expect(configurations(world)).toHaveLength(1)
    // another handler for the same definition: only the handler changes
    world.service(counter, { handler: async () => Response.json({ other: true }) })
    expect((await send(world, 'GET', '/service/counter/count')).body).toEqual({ other: true })
    expect(configurations(world)).toHaveLength(1)
  })

  it('replaces a registration whole with a different definition of the same context path', async () => {
    const world = createWorld()
    const first = world.service(counter)
    world.service(defineService({ manifest: { ...manifest, name: 'counter-v2' }, seed: { state: [{ key: 'count', value: 100 }] }, handler: counterHandler }))
    const applications = world.db.applications.find({ type: 'MICROSERVICE' }).filter((application) => application.contextPath === 'counter')
    expect(applications.map((application) => application.name)).toEqual(['counter-v2'])
    expect((await send(world, 'GET', '/service/counter/count')).body.count).toBe(100)
    expect(world.services.get('counter')!.manifest!.name).toBe('counter-v2')
    // the replaced registration's remover does nothing any more
    first()
    expect(world.services.has('counter')).toBe(true)
  })

  it('gives an inherited registration back when a fork removes its own', async () => {
    const base = createWorld()
    const definition = defineService({ ...counter, handler: undefined })
    base.service(definition)
    const fork = base.fork()
    const remove = fork.service(definition, { handler: counterHandler })
    remove()
    expect((await send(fork, 'GET', '/service/counter/count')).status).toBe(501)
    expect(fork.diff().tenants).toEqual({})
    expect(fork.services.get('counter')).toBe(definition)
  })
})

describe('world.seed({ serviceState })', () => {
  it('throws for a service that is not registered', () => {
    const world = createWorld()
    expect(() => world.seed({ serviceState: [{ service: 'tickets', key: 'k', value: 1 }] })).toThrow('fake-c8y: seed(): service tickets is not registered')
    world.service(counter)
    world.seed({ serviceState: [{ service: 'counter', store: 'extra', key: 'k', value: 1 }] })
    expect(world.db.serviceState('counter', 'extra').get('k')).toBe(1)
  })
})
