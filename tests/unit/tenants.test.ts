/**
 * A request never creates a tenant (verified): credentials of an unknown
 * tenant answer 401, and `targetTenant` is not read.
 */
import { expect, it } from 'vitest'
import { createWorld } from '../../src'

it('answers credentials of an unknown tenant with 401 and creates nothing', async () => {
  const base = createWorld()
  base.device({ name: 'own' })
  const fork = base.fork()
  const response = await fork.fetch(new Request(`${fork.baseUrl}/inventory/managedObjects`, { headers: { accept: 'application/json', authorization: `Basic ${btoa('t000000/alice:pw')}` } }))
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ error: 'security/Unauthorized', message: 'Invalid credentials!' })
  expect(fork.diff()).toEqual({ tenants: {}, options: [] })
  expect(fork.snapshot().tenants.map((tenant) => tenant.tenant)).toEqual([fork.tenant])
})

it('ignores targetTenant', async () => {
  const base = createWorld()
  base.device({ name: 'own' })
  const fork = base.fork()
  const response = await fork.fetch(new Request(`${fork.baseUrl}/inventory/managedObjects?targetTenant=t999`, { headers: { accept: 'application/json' } }))
  expect((await response.json()).managedObjects.map((item: { name: string }) => item.name)).toEqual(['own'])
  expect(fork.diff()).toEqual({ tenants: {}, options: [] })
})

it('ignores targetTenant where the spec lists it (editable answers 403 like without it)', async () => {
  const world = createWorld()
  world.options.set('alpha', 'one', { category: 'ctr' })
  const response = await world.fetch(new Request(`${world.baseUrl}/tenant/options/ctr/alpha/editable?targetTenant=${world.tenant}`, {
    method: 'PUT',
    headers: { 'accept': 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ editable: 'false' }),
  }))
  expect(response.status).toBe(403)
  expect((await response.json()).error).toBe('security/Forbidden')
  expect(world.unhandled).toEqual([])
})

it('accepts credentials of the subscribed tenants and of tenants with data', async () => {
  const world = createWorld({ subscriptions: [{ tenant: 't12345', user: 'service_t12345', password: 'p' }, { tenant: 't2', user: 'service_t2', password: 'p' }] })
  world.device({ tenant: 't3', name: 'other' })
  for (const prefix of ['t2', 't3']) {
    const response = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { headers: { accept: 'application/json', authorization: `Basic ${btoa(`${prefix}/u:pw`)}` } }))
    expect(response.status).toBe(200)
  }
})
