// Side effects of writes on other documents, for cases the contract scenarios
// do not reach: inventory assignments, the clock, seeding, and update paths.
import { expect, it } from 'vitest'
import { createWorld } from '../../src'

type World = ReturnType<typeof createWorld>

async function call(world: World, method: string, path: string, body?: unknown) {
  const res = await world.fetch(new Request(`${world.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

it('deletes inventory assignments on a deleted managed object', async () => {
  const world = createWorld()
  const group = world.managedObject({ name: 'Site', c8y_IsDeviceGroup: {} })
  await call(world, 'POST', `/user/${world.tenant}/users`, { userName: 'ev.a', email: 'ev.a@example.com', password: 'Contract-Pass-2026!x' })
  const role = await call(world, 'POST', '/user/inventoryroles', { name: 'Site reader', permissions: [{ permission: 'READ', scope: 'ALARM', type: '*' }] })
  const assigned = await call(world, 'POST', `/user/${world.tenant}/users/ev.a/roles/inventory`, { managedObject: group, roles: [{ id: role.body.id }] })
  expect(assigned.status).toBe(200)

  await call(world, 'DELETE', `/inventory/managedObjects/${group}`)
  expect((await call(world, 'GET', `/user/${world.tenant}/users/ev.a/roles/inventory`)).body.inventoryAssignments).toEqual([])
  // the role is no longer in use
  expect((await call(world, 'DELETE', `/user/inventoryroles/${role.body.id}`)).status).toBe(204)
})

it('counts seeded alarms once an alarm write touches the source', async () => {
  const world = createWorld()
  const pump = world.device({ name: 'Pump' })
  world.seed({ alarms: [{ source: pump, type: 'seeded', severity: 'MINOR' }] })
  await call(world, 'POST', '/alarm/alarms', { source: { id: pump }, type: 'hot', text: 'Hot', severity: 'MAJOR', time: '2026-01-01T00:00:00Z' })
  expect((await call(world, 'GET', `/inventory/managedObjects/${pump}`)).body.c8y_ActiveAlarmsStatus).toEqual({ critical: 0, major: 1, minor: 1, warning: 0 })
})

it('moves lastMessage with incoming data, not with seeding', async () => {
  let now = Date.parse('2026-01-01T10:00:00Z')
  const world = createWorld({ now: () => now })
  const created = await call(world, 'POST', '/inventory/managedObjects', { name: 'Meter', c8y_IsDevice: {}, c8y_RequiredAvailability: { responseInterval: 10 } })
  const id = created.body.id
  expect(created.body.c8y_Availability).toEqual({ lastMessage: '2026-01-01T10:00:00.000Z', status: 'AVAILABLE' })

  now += 60_000
  world.seed({ events: [{ source: id, type: 'seeded' }] })
  expect((await call(world, 'GET', `/inventory/managedObjects/${id}`)).body.c8y_Availability.lastMessage).toBe('2026-01-01T10:00:00.000Z')

  await call(world, 'POST', '/measurement/measurements', { source: { id }, type: 'm', time: '2026-01-01T10:01:00Z', m: { v: { value: 1 } } })
  expect((await call(world, 'GET', `/inventory/managedObjects/${id}`)).body.c8y_Availability.lastMessage).toBe('2026-01-01T10:01:00.000Z')

  // maintenance keeps the last message; removing the requirement removes both fragments
  await call(world, 'PUT', `/inventory/managedObjects/${id}`, { c8y_RequiredAvailability: { responseInterval: -1 } })
  expect((await call(world, 'GET', `/inventory/managedObjects/${id}`)).body).toMatchObject({ c8y_Availability: { lastMessage: '2026-01-01T10:01:00.000Z', status: 'MAINTENANCE' }, c8y_Connection: { status: 'MAINTENANCE' } })
  await call(world, 'PUT', `/inventory/managedObjects/${id}`, { c8y_RequiredAvailability: null })
  const removed = (await call(world, 'GET', `/inventory/managedObjects/${id}`)).body
  expect(removed.c8y_Availability).toBeUndefined()
  expect(removed.c8y_Connection).toBeUndefined()

  // a decimal interval is a server error on the platform
  expect((await call(world, 'PUT', `/inventory/managedObjects/${id}`, { c8y_RequiredAvailability: { responseInterval: 1.5 } })).status).toBe(500)
})

it('keeps seeded availability fragments', () => {
  const world = createWorld()
  const id = world.device({ name: 'Meter', c8y_Availability: { status: 'UNAVAILABLE', lastMessage: '2025-01-01T00:00:00Z' } })
  expect(world.db.managedObjects.get(id)?.c8y_Availability).toEqual({ status: 'UNAVAILABLE', lastMessage: '2025-01-01T00:00:00Z' })
})

it('takes nested subgroups along, audited once', async () => {
  const world = createWorld()
  const inner = world.managedObject({ name: 'inner', c8y_IsDeviceGroup: {} })
  const device = world.device({ name: 'device' })
  const middle = world.managedObject({ name: 'middle', c8y_IsDeviceGroup: {}, assets: [inner, device] })
  const top = world.managedObject({ name: 'top', c8y_IsDeviceGroup: {}, assets: [middle] })
  await call(world, 'DELETE', `/inventory/managedObjects/${top}`)
  expect(world.db.managedObjects.get(inner)).toBeUndefined()
  expect(world.db.managedObjects.get(middle)).toBeUndefined()
  expect(world.db.managedObjects.get(device)).toBeDefined()
  // only the requested object is audited
  expect(world.db.auditRecords.find({ type: 'Inventory' }).map((record) => record.source)).toEqual([expect.objectContaining({ id: top })])
})
