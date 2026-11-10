// Role enforcement (`roles: 'enforce'`): the role matrix, ownership,
// inventory roles on an object and its parents, service and bootstrap users,
// and the callers that stay unrestricted.
import { describe, expect, it } from 'vitest'
import { createWorld, defineService } from '../../src'
import type { World } from '../../src'

const OWN = ['ROLE_USER_MANAGEMENT_OWN_READ', 'ROLE_USER_MANAGEMENT_OWN_ADMIN']

function as(world: World, user: string | undefined) {
  return async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (user !== undefined) {
      headers.authorization = `Basic ${btoa(`${world.tenant}/${user}:pw`)}`
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
    }
    const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
}

function setup(roles: 'enforce' | 'off' = 'enforce') {
  const world = createWorld({ roles, ids: 'sequential' })
  const group = world.managedObject({ name: 'Plant', c8y_IsDeviceGroup: {} })
  const pump = world.device({ name: 'Pump' })
  const sensor = world.device({ name: 'Sensor' })
  const other = world.device({ name: 'Other' })
  world.seed({
    users: [
      { userName: 'nobody', roles: OWN },
      { userName: 'reader', roles: OWN, groups: ['readers'] },
      { userName: 'eventadmin', roles: [...OWN, 'ROLE_EVENT_ADMIN'] },
      { userName: 'creator', roles: [...OWN, 'ROLE_INVENTORY_CREATE'] },
      { userName: 'plant', roles: OWN, inventoryAssignments: [{ managedObject: group, roles: ['Reader'] }] },
      { userName: 'manager', roles: OWN, inventoryAssignments: [{ managedObject: group, roles: ['Manager'] }] },
    ],
  })
  // Plant > Pump (asset) > Sensor (device)
  world.seed({
    events: [{ source: pump, type: 'door' }, { source: other, type: 'door' }],
    alarms: [{ source: pump, type: 'hot' }, { source: other, type: 'hot' }],
  })
  return { world, group, pump, sensor, other }
}

async function link(world: World, parent: string, kind: string, child: string) {
  const response = await as(world, undefined)('POST', `/inventory/managedObjects/${parent}/${kind}`, { managedObject: { id: child } })
  expect(response.status).toBe(201)
}

describe('role enforcement', () => {
  it('answers 403 like the platform without the role', async () => {
    const { world, pump } = setup()
    const nobody = as(world, 'nobody')
    expect(await nobody('GET', `/inventory/managedObjects/${pump}`)).toEqual({ status: 403, body: { error: 'security/Forbidden', message: 'Access Denied', info: 'https://cumulocity.com/api/core/' } })
    // lists of data documents say it differently
    expect((await nobody('GET', '/event/events')).body.message).toBe('Access is denied')
    expect((await nobody('GET', '/tenant/options')).status).toBe(403)
    expect((await nobody('POST', '/event/events', {})).status).toBe(403)
    // an unknown id answers 404 first
    expect((await nobody('GET', '/event/events/999')).status).toBe(404)
    // open to every user: the inventory list (empty), the current user and tenant
    expect((await nobody('GET', '/inventory/managedObjects')).body.managedObjects).toEqual([])
    expect((await nobody('GET', '/user/currentUser')).status).toBe(200)
    expect((await nobody('GET', '/tenant/currentTenant')).status).toBe(200)
    expect((await nobody('GET', '/alarm/alarms/count')).body).toBe(0)
  })

  it('checks read and admin roles separately', async () => {
    const { world, pump } = setup()
    const admin = as(world, 'eventadmin')
    // an admin role writes but does not read (verified)
    const created = await admin('POST', '/event/events', { source: { id: pump }, type: 't', text: 'x', time: '2026-01-01T00:00:00Z' })
    expect(created.status).toBe(201)
    expect((await admin('GET', `/event/events/${created.body.id}`)).status).toBe(403)
    expect((await admin('POST', '/event/events', {})).status).toBe(422)
    const reader = as(world, 'reader')
    expect((await reader('GET', '/event/events')).body.events).toHaveLength(3)
    expect((await reader('POST', '/event/events', { source: { id: pump }, type: 't', text: 'x', time: '2026-01-01T00:00:00Z' })).status).toBe(403)
    expect((await reader('GET', `/inventory/managedObjects/${pump}`)).status).toBe(200)
  })

  it('lets the owner change its own objects and their data', async () => {
    const { world, other } = setup()
    const creator = as(world, 'creator')
    const own = await creator('POST', '/inventory/managedObjects', { name: 'Mine', c8y_IsDevice: {} })
    expect(own.body.owner).toBe('creator')
    // without the create role, ownership alone
    expect((await as(world, undefined)('DELETE', `/user/${world.tenant}/users/creator/roles/ROLE_INVENTORY_CREATE`)).status).toBe(204)
    expect((await creator('PUT', `/inventory/managedObjects/${own.body.id}`, { name: 'Mine 2' })).status).toBe(200)
    const event = await creator('POST', '/event/events', { source: { id: own.body.id }, type: 't', text: 'x', time: '2026-01-01T00:00:00Z' })
    expect(event.status).toBe(201)
    expect((await creator('GET', `/event/events/${event.body.id}`)).status).toBe(200)
    expect((await creator('GET', `/identity/globalIds/${own.body.id}/externalIds`)).status).toBe(200)
    // the inventory list shows owned objects; data lists do not count ownership (verified)
    expect((await creator('GET', '/inventory/managedObjects')).body.managedObjects.map((mo: any) => mo.id)).toEqual([own.body.id])
    expect((await creator('GET', `/event/events?source=${own.body.id}`)).status).toBe(403)
    // another object stays closed, also as a child
    expect((await creator('POST', `/inventory/managedObjects/${own.body.id}/childDevices`, { managedObject: { id: other } })).status).toBe(403)
    expect((await creator('DELETE', `/inventory/managedObjects/${own.body.id}`)).status).toBe(204)
  })

  it('applies inventory roles to the object and its descendants', async () => {
    const { world, group, pump, sensor, other } = setup()
    await link(world, group, 'childAssets', pump)
    await link(world, pump, 'childDevices', sensor)
    const plant = as(world, 'plant')
    for (const id of [group, pump, sensor]) {
      expect((await plant('GET', `/inventory/managedObjects/${id}`)).status).toBe(200)
    }
    expect((await plant('GET', `/inventory/managedObjects/${other}`)).status).toBe(403)
    expect((await plant('GET', '/inventory/managedObjects?pageSize=10')).body.managedObjects.map((mo: any) => mo.id).sort()).toEqual([group, pump, sensor].sort())
    // with an assignment the data lists answer, filtered
    expect((await plant('GET', '/event/events')).body.events.map((event: any) => event.source.id)).toEqual([pump])
    expect((await plant('GET', '/alarm/alarms/count')).body).toBe(1)
    expect((await plant('PUT', `/inventory/managedObjects/${pump}`, { x: {} })).status).toBe(403)

    const manager = as(world, 'manager')
    expect((await manager('PUT', `/inventory/managedObjects/${sensor}`, { x: {} })).status).toBe(200)
    expect((await manager('POST', '/alarm/alarms', { source: { id: pump }, type: 'a', text: 'x', severity: 'MINOR', time: '2026-01-01T00:00:00Z' })).status).toBe(201)
    // Manager has no event, measurement, or operation admin permission
    expect((await manager('POST', '/event/events', { source: { id: pump }, type: 'a', text: 'x', time: '2026-01-01T00:00:00Z' })).status).toBe(403)
    expect((await manager('POST', '/inventory/managedObjects', { name: 'x' })).status).toBe(403)
  })

  it('matches a typed permission against the document\'s fragments', async () => {
    const { world, pump } = setup()
    const [role] = world.seed({ inventoryRoles: [{ name: 'Doors', permissions: [{ permission: '*', scope: 'EVENT', type: 'c8y_Door' }] }] }).inventoryRoles
    world.seed({ users: [{ userName: 'doors', roles: OWN, inventoryAssignments: [{ managedObject: pump, roles: [role!] }] }] })
    const doors = as(world, 'doors')
    const event = (fragments: object) => ({ source: { id: pump }, type: 'c8y_Door', text: 'x', time: '2026-01-01T00:00:00Z', ...fragments })
    expect((await doors('POST', '/event/events', event({}))).status).toBe(403)
    expect((await doors('POST', '/event/events', event({ c8y_Door: {} }))).status).toBe(201)
  })

  it('gives a service user its required roles and the bootstrap user none', async () => {
    const world = createWorld({ roles: 'enforce' })
    const pump = world.device({ name: 'Pump' })
    world.service(defineService({ manifest: { name: 'reports', contextPath: 'reports', requiredRoles: ['ROLE_INVENTORY_READ'] } }))
    const service = as(world, 'service_reports')
    expect((await service('GET', `/inventory/managedObjects/${pump}`)).status).toBe(200)
    expect((await service('GET', '/event/events')).status).toBe(403)
    const bootstrap = as(world, 'servicebootstrap_reports')
    expect((await bootstrap('GET', '/inventory/managedObjects')).body.message).toBe('Access is denied')
    expect((await bootstrap('GET', '/tenant/currentTenant')).status).toBe(200)
  })

  it('keeps the world\'s user, unknown users, and requests without credentials unrestricted', async () => {
    const { world, pump } = setup()
    for (const user of [undefined, 'test-user', 'not-stored']) {
      expect((await as(world, user)('GET', `/inventory/managedObjects/${pump}`)).status).toBe(200)
    }
  })

  it('checks nothing with roles: \'off\' (the default)', async () => {
    const { world, pump } = setup('off')
    expect((await as(world, 'nobody')('GET', `/inventory/managedObjects/${pump}`)).status).toBe(200)
    expect((await as(createWorld(), 'x')('GET', '/tenant/options')).status).toBe(200)
  })

  it('lets a fork turn enforcement on', async () => {
    const { world, pump } = setup('off')
    const fork = world.fork({ roles: 'enforce' })
    expect((await as(fork, 'nobody')('GET', `/inventory/managedObjects/${pump}`)).status).toBe(403)
  })
})
