/**
 * Bulk operations and new device requests with a controlled clock: the world
 * creates a bulk operation's operations as its clock passes their time.
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'

const START = Date.parse('2026-01-01T10:00:00.000Z')

function setup() {
  let clock = START
  const world = createWorld({ now: () => clock })
  const devices = [1, 2, 3].map((n) => world.device({ name: `Pump ${n}`, com_cumulocity_model_Agent: {} }))
  const group = world.managedObject({ name: 'Pumps', c8y_IsDeviceGroup: {}, assets: devices })
  return {
    world,
    devices,
    group,
    advance: (seconds: number) => {
      clock += seconds * 1000
    },
  }
}

async function call(world: World, method: string, path: string, body?: unknown) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

const at = (seconds: number) => new Date(START + seconds * 1000).toISOString()

describe('bulk operations', () => {
  it('create one operation per ramp from the start date, then complete', async () => {
    const { world, devices, group, advance } = setup()
    const { status, body: bulk } = await call(world, 'POST', '/devicecontrol/bulkoperations', { groupId: group, startDate: at(10), creationRamp: 5, operationPrototype: { c8y_Restart: {} } })
    expect(status).toBe(201)
    expect(bulk).toMatchObject({ id: 1, status: 'ACTIVE', generalStatus: 'SCHEDULED', progress: { all: 3, pending: 0 } })

    advance(9)
    expect(world.db.bulkOperations.get('1')).toMatchObject({ status: 'ACTIVE', progress: { pending: 0 } })
    advance(1)
    expect((await call(world, 'GET', '/devicecontrol/bulkoperations/1')).body).toMatchObject({ status: 'IN_PROGRESS', generalStatus: 'EXECUTING', progress: { pending: 1 } })
    advance(10)
    expect(world.db.operations.find({ bulkOperationId: 1 }).map((operation) => [operation.deviceId, operation.creationTime])).toEqual([
      [devices[0], at(10)],
      [devices[1], at(15)],
      [devices[2], at(20)],
    ])
    // completed one ramp after the last operation
    expect(world.db.bulkOperations.get('1')!.status).toBe('IN_PROGRESS')
    advance(5)
    expect(world.db.bulkOperations.get('1')).toMatchObject({ status: 'COMPLETED', generalStatus: 'EXECUTING', progress: { pending: 3 } })

    for (const operation of world.db.operations.find({ bulkOperationId: 1 })) {
      world.db.operations.update(operation.id, { status: 'SUCCESSFUL' })
    }
    expect(world.db.bulkOperations.get('1')).toMatchObject({ generalStatus: 'SUCCESSFUL', progress: { successful: 3, pending: 0 } })

    // every audit record of the bulk operation names it by a string id, so ?source= finds them all
    const records = world.db.auditRecords.find({ type: 'BulkOperation' })
    expect(records.length).toBeGreaterThan(1)
    expect(new Set(records.map((record) => (record.source as { id: unknown }).id))).toEqual(new Set(['1']))
    expect((await call(world, 'GET', '/audit/auditRecords?source=1&type=BulkOperation&pageSize=100')).body.auditRecords).toHaveLength(records.length)
  })

  it('fail the operations of objects without an agent or deleted ones', async () => {
    const { world, devices, advance } = setup()
    const asset = world.managedObject({ name: 'Hall' })
    const group = world.managedObject({ name: 'Mixed', c8y_IsDeviceGroup: {}, assets: [asset, devices[0]!] })
    await call(world, 'POST', '/devicecontrol/bulkoperations', { groupId: group, startDate: at(0), creationRamp: 1, operationPrototype: { c8y_Restart: {} } })
    await call(world, 'DELETE', `/inventory/managedObjects/${devices[0]}`)
    advance(5)
    expect(world.db.operations.find({ bulkOperationId: 1 }).map(({ status, failureReason }) => ({ status, failureReason }))).toEqual([
      { status: 'FAILED', failureReason: `Agent for device '${asset}' does not exist in inventory!` },
      { status: 'FAILED', failureReason: `Device '${devices[0]}' does not exist in inventory!` },
    ])
    expect(world.db.bulkOperations.get('1')).toMatchObject({ status: 'COMPLETED', generalStatus: 'FAILED', progress: { failed: 2 } })

    // reschedule the failed ones that are still in the group
    const { body: retry } = await call(world, 'POST', '/devicecontrol/bulkoperations', { failedParentId: 1, startDate: at(10), creationRamp: 1, operationPrototype: { c8y_Restart: {} } })
    expect(retry).toMatchObject({ id: 2, groupId: group, failedParentId: 1, progress: { all: 1 } })
  })

  it('stop when deleted, and keep running across a snapshot', async () => {
    const { world, group, advance } = setup()
    await call(world, 'POST', '/devicecontrol/bulkoperations', { groupId: group, startDate: at(0), creationRamp: 10, operationPrototype: { c8y_Restart: {} } })
    await call(world, 'POST', '/devicecontrol/bulkoperations', { groupId: group, startDate: at(0), creationRamp: 10, operationPrototype: { c8y_Restart: {} } })
    advance(1)
    const snapshot = world.snapshot()
    expect((await call(world, 'DELETE', '/devicecontrol/bulkoperations/1')).status).toBe(204)
    advance(60)
    // verified on a real tenant: the next due operation is still created after the delete, then the task stops
    expect(world.db.bulkOperations.get('1')).toMatchObject({ status: 'DELETED', generalStatus: 'CANCELED', progress: { pending: 2, all: 3 } })
    expect(world.db.bulkOperations.get('2')).toMatchObject({ status: 'COMPLETED', progress: { pending: 3 } })
    expect(world.diff(snapshot).tenants[world.tenant]!.bulkOperations.updated).toHaveLength(2)

    world.restore(snapshot)
    expect(world.db.bulkOperations.get('1')).toMatchObject({ status: 'COMPLETED', progress: { pending: 3 } })
    expect((await call(world, 'POST', '/devicecontrol/bulkoperations', { groupId: group, startDate: at(0), creationRamp: 1, operationPrototype: { c8y_Restart: {} } })).body.id).toBe(3)
  })

  it('list newest start date first, without deleted ones unless asked', async () => {
    const { world, group } = setup()
    for (const start of [100, 300, 200]) {
      await call(world, 'POST', '/devicecontrol/bulkoperations', { groupId: group, startDate: at(start), creationRamp: 1, operationPrototype: { c8y_Restart: {} } })
    }
    await call(world, 'DELETE', '/devicecontrol/bulkoperations/3')
    const ids = async (query: string) => (await call(world, 'GET', `/devicecontrol/bulkoperations?pageSize=10&${query}`)).body.bulkOperations.map((bulk: { id: number }) => bulk.id)
    expect(await ids('')).toEqual([2, 1])
    expect(await ids('withDeleted=true')).toEqual([2, 3, 1])
    expect(await ids('generalStatus=CANCELED&withDeleted=true')).toEqual([3])
    expect(await ids(`groupId=${group}`)).toEqual([2, 1])
  })
  it('write audit records like the platform, the task in the creator\'s name', async () => {
    const { world, group, advance } = setup()
    await call(world, 'POST', '/devicecontrol/bulkoperations', { groupId: group, startDate: at(0), creationRamp: 5, operationPrototype: { description: 'Restart', c8y_Restart: {} } })
    advance(12)
    await call(world, 'DELETE', '/devicecontrol/bulkoperations/1')
    const records = world.db.auditRecords.find().map((record) => [record.type, record.text, record.user, record.time])
    expect(records).toEqual([
      ['BulkOperation', 'Create bulk operation: status=\'ACTIVE\', generalStatus=\'SCHEDULED\', progress=\'BulkOperationProgress(pending=0, successful=0, failed=0, executing=0, all=3)\', note=\'null\'.', 'test-user', at(0)],
      ['Operation', 'Operation created: status=\'PENDING\', description=\'Restart\', device name=\'Pump 1\'.', 'test-user', at(0)],
      ['BulkOperation', 'Update bulk operation: status=\'IN_PROGRESS\', generalStatus=\'EXECUTING\', progress=\'BulkOperationProgress(pending=1, successful=0, failed=0, executing=0, all=3)\', note=\'null\'.', 'test-user', at(0)],
      ['Operation', 'Operation created: status=\'PENDING\', description=\'Restart\', device name=\'Pump 2\'.', 'test-user', at(5)],
      ['Operation', 'Operation created: status=\'PENDING\', description=\'Restart\', device name=\'Pump 3\'.', 'test-user', at(10)],
      ['BulkOperation', 'Delete bulk operation: status=\'DELETED\', generalStatus=\'CANCELED\', progress=\'null\', note=\'null\'.', 'test-user', at(12)],
    ])
  })
})

describe('new device requests', () => {
  it('accept a seeded or connected device', async () => {
    const { world } = setup()
    world.seed({ newDeviceRequests: [{ id: 'SN-1', status: 'PENDING_ACCEPTANCE' }, { id: 'SN-2', type: 'c8y_Pump' }] })
    expect((await call(world, 'PUT', '/devicecontrol/newDeviceRequests/SN-1', { status: 'ACCEPTED' })).body).toMatchObject({ id: 'SN-1', status: 'ACCEPTED', owner: 'test-user' })
    expect((await call(world, 'PUT', '/devicecontrol/newDeviceRequests/SN-2', { status: 'ACCEPTED' })).status).toBe(404)
    world.db.newDeviceRequests.connect('SN-2')
    expect((await call(world, 'PUT', '/devicecontrol/newDeviceRequests/SN-2', { status: 'ACCEPTED' })).status).toBe(200)
    expect(world.db.newDeviceRequests.find({ status: 'ACCEPTED' }).map((request) => request.id)).toEqual(['SN-1', 'SN-2'])
    expect(() => world.db.newDeviceRequests.connect('SN-2')).toThrow(TypeError)
  })
})
