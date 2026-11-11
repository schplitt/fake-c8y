/**
 * `C8yRequest.writes`: the documents each request wrote, so an eval can tell
 * who changed what by following `parent` up to the service that sent it.
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'

const json = { 'accept': 'application/json', 'content-type': 'application/json' }

describe('the writes of a request', () => {
  it('lists the documents a request created, updated, and deleted, in order', async () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    const send = (method: string, path: string, body?: unknown) => world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: json, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))

    const created = await (await send('POST', '/inventory/managedObjects', { name: 'Plan' })).json() as { id: string }
    await send('PUT', `/inventory/managedObjects/${created.id}`, { name: 'Plan 2' })
    const alarm = await (await send('POST', '/alarm/alarms', { source: { id: pump }, type: 'hot', text: 'hot', severity: 'MAJOR', time: '2026-11-01T00:00:00.000Z' })).json() as { id: string }
    await send('DELETE', `/inventory/managedObjects/${created.id}`)
    await send('GET', `/inventory/managedObjects/${pump}`)

    expect(world.calls.map((call) => call.writes)).toEqual([
      [{ collection: 'managedObjects', id: created.id, action: 'created' }],
      [{ collection: 'managedObjects', id: created.id, action: 'updated' }],
      [{ collection: 'alarms', id: alarm.id, action: 'created' }],
      [{ collection: 'managedObjects', id: created.id, action: 'deleted' }],
      undefined,
    ])
  })

  it('records a service\'s write on its own request, the child of the service call', async () => {
    const world = createWorld()
    world.service('planner', async (_request, ctx) => ctx.fetch('/inventory/managedObjects', { method: 'POST', headers: json, body: JSON.stringify({ type: 'plan' }) }), { manifest: { requiredRoles: ['ROLE_INVENTORY_ADMIN'] } })

    await world.fetch(new Request(`${world.baseUrl}/service/planner/plans`, { method: 'POST' }))

    const [outer, inner] = world.calls
    expect(outer!.writes).toBeUndefined()
    expect(inner!.parent).toBe(outer!.id)
    expect(inner!.writes).toEqual([{ collection: 'managedObjects', id: expect.any(String), action: 'created' }])
  })

  it('leaves out what seeding wrote', () => {
    const world = createWorld()
    world.device({ name: 'Pump' })

    expect(world.calls).toEqual([])
  })
})
