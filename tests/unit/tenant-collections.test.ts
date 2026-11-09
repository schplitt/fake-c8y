/**
 * Every collection in `TENANT_COLLECTIONS` must reach snapshots, restores,
 * and diffs. `snapshot.ts` lists the collections one by one, so a new
 * collection added only to `TENANT_COLLECTIONS` would fork and reset fine
 * but be silently missing from `snapshot()` and `diff()`. The fixtures are a
 * `Record<TenantCollection, ...>`, so a new collection also fails the
 * typecheck until it has an entry here.
 */
import { describe, expect, it } from 'vitest'
import { emptyTenant, externalIdKey, TENANT_COLLECTIONS } from '../../src/store'
import type { TenantCollection, TenantData, WorldContext } from '../../src/store'
import { diffSnapshots, restoreTenants, snapshotOptions, snapshotTenants } from '../../src/snapshot'
import type { TenantDiff, WorldDiff } from '../../src/snapshot'
import { compileGenerator } from '../../src/generators'

const world = { freezeDocuments: false } as WorldContext

/**
 * One new entry per collection, `[key, value]` as stored.
 */
const FIXTURES: Record<TenantCollection, () => [string, unknown]> = {
  managedObjects: () => ['1', { id: '1', name: 'pump' }],
  children: () => ['1', { childDevices: ['2'], childAssets: [], childAdditions: [] }],
  externalIds: () => [externalIdKey('c8y_Serial', 's1'), { type: 'c8y_Serial', externalId: 's1', managedObjectId: '1' }],
  measurements: () => ['3', { id: '3', type: 't', time: '2026-01-01T00:00:00.000Z', source: { id: '1' } }],
  events: () => ['4', { id: '4', type: 't', text: 't', time: '2026-01-01T00:00:00.000Z', source: { id: '1' } }],
  alarms: () => ['5', { id: '5', type: 't', text: 't', severity: 'MAJOR', status: 'ACTIVE', time: '2026-01-01T00:00:00.000Z', source: { id: '1' } }],
  operations: () => ['6', { id: '6', deviceId: '1', status: 'PENDING' }],
  binaries: () => ['7', { name: 'a.txt', contentType: 'text/plain', bytes: new Uint8Array([1]) }],
  eventBinaries: () => ['4', { name: 'b.txt', contentType: 'text/plain', bytes: new Uint8Array([2]) }],
  users: () => ['alice', { id: 'alice', userName: 'alice', roles: [], groups: [] }],
  groups: () => ['99', { id: '99', name: 'g', roles: [] }],
  roles: () => ['ROLE_FIXTURE', 'ROLE_FIXTURE'],
  inventoryRoles: () => ['98', { id: '98', name: 'r', permissions: [] }],
  inventoryAssignments: () => ['8', { id: '8', user: 'alice', managedObject: '1', roles: [] }],
  sequences: () => ['notification', 7],
  bulkOperations: () => ['9', { id: '9', groupId: '1', status: 'ACTIVE' }],
  newDeviceRequests: () => ['dev-1', { id: 'dev-1', status: 'WAITING_FOR_CONNECTION' }],
  options: () => ['cat\u0000key', 'value'],
  retentionRules: () => ['10', { id: '10', dataType: 'EVENT', maximumAge: 1 }],
  auditRecords: () => ['11', { id: '11', type: 'Operation', activity: 'a', text: 't' }],
  measurementGenerators: () => {
    const stream = compileGenerator({ source: '1', type: 't', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T01:00:00.000Z', interval: '30m', series: [{ fragment: 'f', series: 's', value: 1 }] }, 1000, undefined, 0)
    return [String(stream.idStart), stream]
  },
  measurementTombstones: () => ['12', { kind: 'point', id: '12', document: { id: '12' } }],
  notificationSubscriptions: () => ['13', { id: '13', tenant: 't1', context: 'tenant', subscription: 'sub' }],
  notificationTokens: () => ['token', { tenant: 't1', subscription: 'sub', subscriber: 'me' }],
  serviceState: () => ['pumps/default/count', { n: 1 }],
  applications: () => ['120001', { id: '120001', name: 'fixture', key: 'fixture-key', type: 'HOSTED', availability: 'PRIVATE', owner: 't1' }],
  applicationSubscriptions: () => ['120001', { id: '120001', owner: 't1' }],
  usageStatistics: () => ['2026-01-01', { day: '2026-01-01', counters: { requestCount: 5 }, storageSize: 1000 }],
  trustedCertificates: () => ['ab12', { fingerprint: 'ab12', name: 'ca', status: 'ENABLED', autoRegistrationEnabled: false, version: 3, tenantCertificateAuthority: false, proofOfPossessionValid: false }],
}

/**
 * How many changes of a collection a diff shows, or why the diff leaves it out.
 */
const IN_DIFF: Record<TenantCollection, ((tenant: TenantDiff, diff: WorldDiff) => number) | string> = {
  managedObjects: (tenant) => tenant.managedObjects.created.length,
  children: (tenant) => tenant.relations.created.length,
  externalIds: (tenant) => tenant.externalIds.created.length,
  measurements: (tenant) => tenant.measurements.created.length,
  events: (tenant) => tenant.events.created.length,
  alarms: (tenant) => tenant.alarms.created.length,
  operations: (tenant) => tenant.operations.created.length,
  binaries: (tenant) => tenant.binaries.created.length,
  eventBinaries: (tenant) => tenant.eventBinaries.created.length,
  users: (tenant) => tenant.users.created.length,
  groups: (tenant) => tenant.groups.created.length,
  roles: (tenant) => tenant.roles.created.length,
  inventoryRoles: (tenant) => tenant.inventoryRoles.created.length,
  inventoryAssignments: (tenant) => tenant.inventoryAssignments.created.length,
  sequences: 'counters: the documents they number show instead',
  bulkOperations: (tenant) => tenant.bulkOperations.created.length,
  newDeviceRequests: (tenant) => tenant.newDeviceRequests.created.length,
  options: (_tenant, diff) => diff.options.length,
  retentionRules: (tenant) => tenant.retentionRules.created.length,
  auditRecords: (tenant) => tenant.auditRecords.created.length,
  measurementGenerators: 'seeded history: only deletes of generated measurements are changes',
  measurementTombstones: (tenant) => tenant.measurements.deleted.length,
  notificationSubscriptions: (tenant) => tenant.notificationSubscriptions.created.length,
  notificationTokens: 'tokens are left out of diffs',
  serviceState: (tenant) => tenant.serviceState.created.length,
  applications: (tenant) => tenant.applications.created.length,
  applicationSubscriptions: (tenant) => tenant.applicationSubscriptions.created.length,
  usageStatistics: (tenant) => tenant.usageStatistics.created.length,
  trustedCertificates: (tenant) => tenant.trustedCertificates.created.length,
}

function populated(): TenantData {
  const data = emptyTenant('t1', world)
  for (const name of TENANT_COLLECTIONS) {
    const [key, value] = FIXTURES[name]()
    data[name].set(key, value as never)
  }
  return data
}

describe('TENANT_COLLECTIONS', () => {
  it('all have a fixture and a diff entry', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...TENANT_COLLECTIONS].sort())
    expect(Object.keys(IN_DIFF).sort()).toEqual([...TENANT_COLLECTIONS].sort())
  })

  it('all go through a snapshot and back', () => {
    const data = populated()
    const tenants = new Map([[data.tenant, data]])
    const [restored] = restoreTenants(snapshotTenants(tenants), world)
    for (const name of TENANT_COLLECTIONS) {
      const [key] = FIXTURES[name]()
      if (name === 'options') {
        // tenant options are in the snapshot's top-level `options` list
        expect(snapshotOptions(tenants)).toContainEqual(['t1', 'cat', 'key', 'value'])
        continue
      }
      expect([name, restored![name].has(key)]).toEqual([name, true])
      // the same keys (sequences restore in their own order)
      expect([name, [...restored![name].keys()].sort()]).toEqual([name, [...data[name].keys()].sort()])
    }
  })

  it('all show in a diff, or are left out on purpose', () => {
    const before = new Map([['t1', emptyTenant('t1', world)]])
    const after = new Map([['t1', populated()]])
    const diff = diffSnapshots(
      { tenants: snapshotTenants(before), options: snapshotOptions(before) },
      { tenants: snapshotTenants(after), options: snapshotOptions(after) },
    )
    for (const name of TENANT_COLLECTIONS) {
      const count = IN_DIFF[name]
      if (typeof count === 'function') {
        expect([name, count(diff.tenants.t1!, diff)]).toEqual([name, 1])
      }
    }
  })
})
