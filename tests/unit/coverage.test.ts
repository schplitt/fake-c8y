/**
 * world.coverage(): did a trial stay inside the emulation?
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'

const get = (world: World, path: string, method = 'GET') => world.fetch(new Request(`${world.baseUrl}${path}`, { method }))

describe('coverage', () => {
  it('stays valid for requests the platform also rejects', async () => {
    const world = createWorld({ unsupported: 'platform' })
    expect((await get(world, '/inventory/managedObjects')).status).toBe(200)
    expect((await get(world, '/inventory/nothingHere')).status).toBe(404)
    expect((await get(world, '/inventory/managedObjects', 'PATCH')).status).toBe(405)
    const service = await get(world, '/service/dtm/assets')
    expect(service.status).toBe(404)
    expect(await service.json()).toMatchObject({ error: 'microservice/Not Found', message: 'Microservice dtm not found.' })
    const coverage = world.coverage()
    expect(coverage.valid).toBe(true)
    expect(coverage.unhandled).toEqual([])
    expect(coverage.platformErrors.map(({ method, path, status }) => [method, path, status])).toEqual([
      ['GET', '/inventory/nothingHere', 404],
      ['PATCH', '/inventory/managedObjects', 405],
      ['GET', '/service/dtm/assets', 404],
    ])
  })

  it('turns invalid for what the fake cannot answer, by kind', async () => {
    const world = createWorld({ unsupported: 'platform' })
    const pump = world.device({ name: 'Pump' })
    expect((await get(world, '/application/applications/1/versions')).status).toBe(501)
    const subscription = { context: 'mo', source: { id: pump }, subscription: 'children', subscriptionFilter: { apis: ['eventsWithChildren'] } }
    expect((await world.fetch(new Request(`${world.baseUrl}/notification2/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) }))).status).toBe(501)
    expect((await get(world, '/nowhere/assets')).status).toBe(501)
    const coverage = world.coverage()
    expect(coverage.valid).toBe(false)
    expect(coverage.unhandled.map(({ path, kind }) => [path, kind])).toEqual([
      ['/application/applications/1/versions', 'endpoint'],
      ['/notification2/subscriptions', 'feature'],
      ['/nowhere/assets', 'outside-spec'],
    ])

    world.reset()
    expect(world.coverage()).toEqual({ valid: true, unhandled: [], platformErrors: [] })
  })

  it('is per fork', async () => {
    const base = createWorld()
    const [a, b] = [base.fork(), base.fork()]
    await get(a!, '/application/applications/1/versions')
    expect(a!.coverage().valid).toBe(false)
    expect(b!.coverage().valid).toBe(true)
  })
})
