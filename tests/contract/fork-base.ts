/**
 * Data of the base world the contract scenarios fork in
 * tests/contract/fake-fork.test.ts: a bit of everything, so the scenarios run
 * next to base documents (merged lists, counts, paging totals, tombstones).
 * The scenarios tolerate foreign data, since they also run on a real tenant.
 */
import type { World } from '../../src'

export function seedBase(world: World): void {
  const t0 = Date.parse('2026-01-01T00:00:00.000Z')
  const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString()
  const agent = world.device({ name: 'base-agent', type: 'base_Agent', com_cumulocity_model_Agent: {}, externalIds: { base_Serial: 'base-agent-1' } })
  const devices = Array.from({ length: 6 }, (_, i) => world.device({ name: `base-device-${i}`, type: 'base_Device', c8y_Hardware: { serialNumber: `base-${i}` }, externalIds: { base_Serial: `base-${i}` } }))
  world.managedObject({ name: 'base-group', type: 'c8y_DeviceGroup', c8y_IsDeviceGroup: {}, assets: devices.slice(0, 3) })
  world.managedObject({ name: 'base-site', type: 'base_Site', children: [agent], assets: devices.slice(3) })
  world.binary({ name: 'base.txt', content: 'base binary' })
  world.seed({
    roles: ['ROLE_BASE_EXTRA'],
    inventoryRoles: [{ name: 'base-inventory-role', permissions: [{ permission: 'READ', scope: '*', type: '*' }] }],
    groups: [{ name: 'base-group', roles: ['ROLE_INVENTORY_READ'] }],
    users: [{ userName: 'base-user', groups: ['base-group'], inventoryAssignments: [{ managedObject: devices[0]!, roles: ['base-inventory-role'] }] }],
    measurements: devices.flatMap((device) => Array.from({ length: 20 }, (_, i) => ({ source: device, type: 'base_Temperature', time: at(i), base_Temperature: { T: { value: 20 + i, unit: 'C' } } }))),
    events: devices.map((device, i) => ({ source: device, type: 'base_Event', time: at(i) })),
    alarms: devices.slice(0, 3).map((device, i) => ({ source: device, type: 'base_Alarm', time: at(i), severity: 'MINOR' as const })),
    operations: [{ deviceId: agent, base_Command: { text: 'noop' }, status: 'SUCCESSFUL' }],
    newDeviceRequests: [{ id: 'base-request-1' }],
    retentionRules: [{ dataType: 'EVENT', maximumAge: 30 }],
    auditRecords: [{ type: 'Inventory', activity: 'Base record', text: 'base', source: agent, time: at(0) }],
  })
  world.options.set('base.key', 'base-value', { category: 'base-fixture' })
}
