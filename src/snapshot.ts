import { AvailabilityQueue } from './availability-queue'
import type { C8ySubscription, C8yUser } from './types'
import type { Collection } from './collection'
import type { BinaryContent, ChildKind, DocumentCollection, ExternalId, SequenceName, StoredDocument, TenantData, WorldContext, TenantCollection } from './store'
import { CHILD_KINDS, emptyTenant, externalIdKey, forkTenant, TENANT_COLLECTIONS } from './store'
import { clone, decodeBase64, encodeBase64 } from './utils'
import type { NotificationSubscription, NotificationToken } from './realtime'
import type { GeneratorSnapshot, MeasurementTombstone, RangeTombstone } from './generators'
import { compileGenerator } from './generators'
import type { C8yJson } from './services'
import { splitServiceStateKey } from './services'
import type { StoredUsageDay } from './api/statistics'
import type { StoredTrustedCertificate } from './api/tenant-admin'

/**
 * File content in a snapshot.
 */
export interface BinarySnapshot {
  name: string
  contentType: string
  /**
   * The bytes, base64-encoded.
   */
  base64: string
}

/**
 * Next ids of groups, inventory roles, their permissions, and inventory assignments.
 */
export interface UserSequences {
  group: number
  inventoryRole: number
  permission: number
  assignment: number
  /**
   * Next number of Notification 2.0 subscription ids and tokens. Missing in
   * snapshots of older versions.
   */
  notification?: number
  /**
   * Next number of application ids. Missing in snapshots of older versions.
   */
  application?: number
}

/**
 * One tenant's data as JSON.
 */
export interface TenantSnapshot {
  tenant: string
  managedObjects: StoredDocument[]
  /**
   * `[parent id, child ids by relation kind]`
   */
  children: Array<[string, Record<ChildKind, string[]>]>
  externalIds: ExternalId[]
  measurements: StoredDocument[]
  /**
   * Measurement generators (generated history), as seeded. Only present
   * when the tenant has some.
   */
  measurementGenerators?: GeneratorSnapshot[]
  /**
   * Deleted generated measurements, in write order. Only present when there
   * are some.
   */
  measurementTombstones?: MeasurementTombstone[]
  events: StoredDocument[]
  alarms: StoredDocument[]
  operations: StoredDocument[]
  /**
   * `[binary id, content]`
   */
  binaries: Array<[string, BinarySnapshot]>
  /**
   * `[event id, attachment]`
   */
  eventBinaries: Array<[string, BinarySnapshot]>
  /**
   * Users with their roles and group ids. The user management fields are
   * missing in snapshots taken before the fake had them; such a tenant
   * restores with the default content.
   */
  users?: StoredDocument[]
  /**
   * Groups with their roles.
   */
  groups?: StoredDocument[]
  /**
   * Global role names.
   */
  roles?: string[]
  inventoryRoles?: StoredDocument[]
  /**
   * Inventory assignments with their `user`.
   */
  inventoryAssignments?: StoredDocument[]
  sequences?: UserSequences
  /**
   * Bulk operations as stored (with their pending task). Optional when
   * reading snapshots of older versions.
   */
  bulkOperations?: StoredDocument[]
  /**
   * Next bulk operation id of the tenant.
   */
  nextBulkOperationId?: number
  newDeviceRequests?: StoredDocument[]
  /**
   * Optional when reading snapshots of older versions.
   */
  retentionRules?: StoredDocument[]
  /**
   * Optional when reading snapshots of older versions.
   */
  auditRecords?: StoredDocument[]
  /**
   * Notification 2.0 subscriptions. Optional when reading snapshots of older versions.
   */
  notificationSubscriptions?: NotificationSubscription[]
  /**
   * Notification 2.0 tokens: `[token, owner]`. Optional when reading snapshots of older versions.
   */
  notificationTokens?: Array<[string, NotificationToken]>
  /**
   * State of service emulations: `[<service>/<store>/<key>, value]`. Only
   * present when the tenant has some.
   */
  serviceState?: Array<[string, C8yJson]>
  /**
   * Applications the tenant owns or has a copy of (the default ones).
   * Missing in snapshots of older versions; such a tenant restores with the
   * default applications.
   */
  applications?: StoredDocument[]
  /**
   * The tenant's subscriptions to applications.
   */
  applicationSubscriptions?: StoredDocument[]
  /**
   * Seeded days of usage statistics. Only present when the tenant has some.
   */
  usageStatistics?: StoredUsageDay[]
  /**
   * Trusted certificates. Only present when the tenant has some.
   */
  trustedCertificates?: StoredTrustedCertificate[]
}

/**
 * A world's data and platform state as JSON: `JSON.stringify` it to store it
 * as a fixture, `world.restore()` it to go back to it. Overrides (functions)
 * and live Notification 2.0 sockets are not part of it; subscriptions and
 * tokens are.
 */
export interface WorldSnapshot {
  version: 1
  /**
   * Next id the world hands out.
   */
  nextId: number
  tenant: string
  user: C8yUser | null
  subscriptions: C8ySubscription[]
  /**
   * `[tenant, category, key, value]`; `null` for an option without a value.
   */
  options: Array<[string, string, string, string | null]>
  tenants: TenantSnapshot[]
}

/**
 * Changes of one document collection.
 */
export interface CollectionDiff {
  created: StoredDocument[]
  updated: Array<{ before: StoredDocument, after: StoredDocument }>
  deleted: StoredDocument[]
}

/**
 * Changes of one tenant's data.
 */
export interface TenantDiff {
  managedObjects: CollectionDiff
  /**
   * Stored measurements, plus generated ones deleted one by one (in `deleted`).
   */
  measurements: CollectionDiff
  /**
   * Deletes by filter of generated measurements (`DELETE
   * /measurement/measurements?...`, or deleting their source), with the
   * number of generated documents each removed. The stored documents they
   * removed are in `measurements.deleted`.
   */
  deletedMeasurementRanges: Array<Omit<RangeTombstone, 'kind'>>
  events: CollectionDiff
  alarms: CollectionDiff
  operations: CollectionDiff
  bulkOperations: CollectionDiff
  newDeviceRequests: CollectionDiff
  externalIds: { created: ExternalId[], deleted: ExternalId[] }
  /**
   * Users; group memberships and roles show as updates of the user.
   */
  users: CollectionDiff
  /**
   * Groups; role assignments show as updates of the group.
   */
  groups: CollectionDiff
  roles: { created: string[], deleted: string[] }
  inventoryRoles: CollectionDiff
  inventoryAssignments: CollectionDiff
  retentionRules: CollectionDiff
  /**
   * Audit records the platform wrote for the changes above, kept apart so an
   * eval can check them separately (or ignore them).
   */
  auditRecords: CollectionDiff
  /**
   * Notification 2.0 subscriptions (tokens are left out).
   */
  notificationSubscriptions: CollectionDiff
  /**
   * Inventory binary contents by binary id (`{ id, name, contentType, base64 }`).
   * The binary's managed object is in `managedObjects`.
   */
  binaries: CollectionDiff
  /**
   * Event attachments by event id (`{ id, name, contentType, base64 }`).
   */
  eventBinaries: CollectionDiff
  /**
   * State of service emulations, one document per key:
   * `{ id: '<service>/<store>/<key>', service, store, key, value }`.
   */
  serviceState: CollectionDiff
  /**
   * Applications the tenant owns (and its copies of the default ones).
   */
  applications: CollectionDiff
  /**
   * Subscriptions of the tenant to applications, by application id:
   * `{ id, owner }`, with the service user of a microservice.
   */
  applicationSubscriptions: CollectionDiff
  /**
   * Seeded days of usage statistics, one document per day (`{ id: day, ... }`).
   * What requests add to the statistics is not tenant data and never shows.
   */
  usageStatistics: CollectionDiff
  /**
   * Trusted certificates, one document per certificate (`{ id: fingerprint, ... }`).
   */
  trustedCertificates: CollectionDiff
  /**
   * Child references added and removed (`childDevices`, `childAssets`,
   * `childAdditions`). The parent and the child also show as updated
   * managed objects when the platform changed their `lastUpdated`.
   */
  relations: { created: RelationChange[], deleted: RelationChange[] }
}

/**
 * A child reference: `child` is in the `kind` collection of `parent`.
 */
export interface RelationChange {
  parent: string
  kind: ChildKind
  child: string
}

/**
 * What changed between two snapshots, per tenant. Tenants without changes are
 * left out, so an empty `tenants` object means nothing changed.
 */
export interface WorldDiff {
  tenants: Record<string, TenantDiff>
  /**
   * Tenant options: `[tenant, category, key]` with the value before and after
   * (`undefined` when it did not exist).
   */
  options: Array<{ tenant: string, category: string, key: string, before: string | null | undefined, after: string | null | undefined }>
}

const COLLECTIONS: DocumentCollection[] = ['managedObjects', 'measurements', 'events', 'alarms', 'operations']
const USER_COLLECTIONS = ['users', 'groups', 'inventoryRoles', 'inventoryAssignments'] as const
const APPLICATION_COLLECTIONS = ['applications', 'applicationSubscriptions'] as const
/**
 * Device control collections outside `DocumentCollection` (own id spaces).
 */
const DEVICE_CONTROL = ['bulkOperations', 'newDeviceRequests'] as const

function binarySnapshot(content: BinaryContent): BinarySnapshot {
  return { name: content.name, contentType: content.contentType, base64: encodeBase64(content.bytes) }
}

function binaryContent(snapshot: BinarySnapshot): BinaryContent {
  return { name: snapshot.name, contentType: snapshot.contentType, bytes: decodeBase64(snapshot.base64) }
}

/**
 * Picks the entries of a collection that go into a snapshot: all of them, or
 * the ones a fork touched.
 */
type EntryPicker = <V>(collection: Collection<V>) => Iterable<[string, V]>

const allEntries: EntryPicker = (collection) => collection.entries()

/**
 * A tenant's data as JSON.
 * @param data - Tenant data
 * @param entries - The entries of each collection to include
 */
function tenantSnapshot(data: TenantData, entries: EntryPicker): TenantSnapshot {
  const documents = (collection: Collection<StoredDocument>) => [...entries(collection)].map(([, document]) => clone(document))
  const binaries = (collection: Collection<BinaryContent>) => [...entries(collection)].map(([id, content]): [string, BinarySnapshot] => [id, binarySnapshot(content)])
  const sequence = (name: SequenceName) => data.sequences.get(name) ?? 1
  const generators = [...entries(data.measurementGenerators)].map(([, stream]): GeneratorSnapshot => ({ idStart: stream.idStart, block: stream.block, generator: clone(stream.generator) }))
  const tombstones = [...entries(data.measurementTombstones)].map(([, tombstone]) => clone(tombstone))
  const serviceState = [...entries(data.serviceState)].map(([id, value]): [string, C8yJson] => [id, clone(value) as C8yJson])
  const usageStatistics = [...entries(data.usageStatistics)].map(([, day]) => clone(day))
  const trustedCertificates = [...entries(data.trustedCertificates)].map(([, certificate]) => ({ ...certificate }))
  return {
    tenant: data.tenant,
    managedObjects: documents(data.managedObjects),
    children: [...entries(data.children)].map(([id, relations]) => [id, clone(relations) as Record<ChildKind, string[]>]),
    externalIds: [...entries(data.externalIds)].map(([, entry]) => ({ ...entry })),
    measurements: documents(data.measurements),
    ...(generators.length > 0 ? { measurementGenerators: generators } : {}),
    ...(tombstones.length > 0 ? { measurementTombstones: tombstones } : {}),
    events: documents(data.events),
    alarms: documents(data.alarms),
    operations: documents(data.operations),
    binaries: binaries(data.binaries),
    eventBinaries: binaries(data.eventBinaries),
    users: documents(data.users),
    groups: documents(data.groups),
    roles: [...entries(data.roles)].map(([name]) => name),
    inventoryRoles: documents(data.inventoryRoles),
    inventoryAssignments: documents(data.inventoryAssignments),
    sequences: { group: sequence('group'), inventoryRole: sequence('inventoryRole'), permission: sequence('permission'), assignment: sequence('assignment'), notification: sequence('notification'), ...(data.sequences.has('application') ? { application: sequence('application') } : {}) },
    bulkOperations: documents(data.bulkOperations),
    nextBulkOperationId: sequence('bulkOperation'),
    newDeviceRequests: documents(data.newDeviceRequests),
    retentionRules: documents(data.retentionRules),
    auditRecords: documents(data.auditRecords),
    notificationSubscriptions: [...entries(data.notificationSubscriptions)].map(([, subscription]) => clone(subscription)),
    notificationTokens: [...entries(data.notificationTokens)].map(([token, owner]): [string, NotificationToken] => [token, { ...owner }]),
    ...(serviceState.length > 0 ? { serviceState } : {}),
    applications: documents(data.applications),
    applicationSubscriptions: documents(data.applicationSubscriptions),
    ...(usageStatistics.length > 0 ? { usageStatistics } : {}),
    ...(trustedCertificates.length > 0 ? { trustedCertificates } : {}),
  }
}

type OptionEntry = [string, string, string, string | null]

function optionEntries(data: TenantData, entries: EntryPicker): OptionEntry[] {
  return [...entries(data.options)].map(([id, value]): OptionEntry => [data.tenant, ...id.split('\u0000') as [string, string], value])
}

export function snapshotTenants(tenants: Map<string, TenantData>): TenantSnapshot[] {
  return [...tenants.values()].map((data) => tenantSnapshot(data, allEntries))
}

export function snapshotOptions(tenants: Map<string, TenantData>): OptionEntry[] {
  return [...tenants.values()].flatMap((data) => optionEntries(data, allEntries))
}

/**
 * Keys deleted and set again, per tenant and collection (from a fork's
 * `touched()`): a snapshot cannot tell them from unchanged or updated ones.
 */
export type RecreatedKeys = Map<string, Map<TenantCollection, Set<string>>>

/**
 * The parts of two snapshots a diff needs, built from what the forked tenants
 * wrote: for every collection only the touched keys, before (in the base) and
 * after. Untouched keys are equal on both sides, so `diffSnapshots()` of the
 * two gives the same result as for full snapshots, at a cost that grows with
 * the changes, not with the data. `recreated` has the keys that were deleted
 * and set again.
 * @param tenants - The fork's tenants
 * @param isForked - Whether a tenant has a base (otherwise all its data is new)
 */
export function touchedSnapshots(tenants: Map<string, TenantData>, isForked: (tenant: string) => boolean): { before: Pick<WorldSnapshot, 'tenants' | 'options'>, after: Pick<WorldSnapshot, 'tenants' | 'options'>, recreated: RecreatedKeys } {
  const before: Pick<WorldSnapshot, 'tenants' | 'options'> = { tenants: [], options: [] }
  const after: Pick<WorldSnapshot, 'tenants' | 'options'> = { tenants: [], options: [] }
  const recreated: RecreatedKeys = new Map()
  for (const data of tenants.values()) {
    const touched = new Map(TENANT_COLLECTIONS.map((name) => [data[name] as Collection<unknown>, data[name].touched()]))
    const pick = (side: 'before' | 'after'): EntryPicker => (collection) => touched.get(collection as Collection<unknown>)![side] as Array<[string, any]>
    if (isForked(data.tenant)) {
      before.tenants.push(tenantSnapshot(data, pick('before')))
      before.options.push(...optionEntries(data, pick('before')))
    }
    after.tenants.push(tenantSnapshot(data, pick('after')))
    after.options.push(...optionEntries(data, pick('after')))
    const keys = new Map(TENANT_COLLECTIONS.map((name) => [name, touched.get(data[name] as Collection<unknown>)!.recreated] as const).filter(([, set]) => set.size > 0))
    if (keys.size > 0) {
      recreated.set(data.tenant, keys)
    }
  }
  return { before, after, recreated }
}

/**
 * Tenant data from snapshots.
 * @param snapshots - Tenant snapshots
 * @param world - The world the tenants live in
 * @param base - For a fork: the frozen tenant of a name, which the restored tenant hides
 */
export function restoreTenants(snapshots: TenantSnapshot[], world: WorldContext, base?: (tenant: string) => TenantData | undefined): TenantData[] {
  return snapshots.map((snapshot) => {
    const baseTenant = base?.(snapshot.tenant)
    const data = baseTenant ? forkTenant(baseTenant, world) : emptyTenant(snapshot.tenant, world)
    const documents = (list: StoredDocument[] | undefined) => (list ?? []).map((document): [string, StoredDocument] => [document.id, clone(document)])
    for (const collection of COLLECTIONS) {
      data[collection].replace(documents(snapshot[collection]))
    }
    data.children.replace(snapshot.children.map(([id, relations]) => [id, clone(relations)]))
    data.externalIds.replace(snapshot.externalIds.map((entry) => [externalIdKey(entry.type, entry.externalId), { ...entry }]))
    data.binaries.replace(snapshot.binaries.map(([id, content]) => [id, binaryContent(content)]))
    data.eventBinaries.replace(snapshot.eventBinaries.map(([id, content]) => [id, binaryContent(content)]))
    for (const collection of USER_COLLECTIONS) {
      const list = snapshot[collection]
      if (list) {
        data[collection].replace(documents(list))
      }
    }
    if (snapshot.roles) {
      data.roles.replace(snapshot.roles.map((role) => [role, role]))
    }
    const sequences = snapshot.sequences ?? { group: data.sequences.get('group') ?? 1, inventoryRole: data.sequences.get('inventoryRole') ?? 1, permission: data.sequences.get('permission') ?? 1, assignment: data.sequences.get('assignment') ?? 1 }
    data.sequences.replace([...Object.entries({ notification: 1, ...sequences }), ['bulkOperation', snapshot.nextBulkOperationId ?? 1]])
    for (const collection of APPLICATION_COLLECTIONS) {
      const list = snapshot[collection]
      if (list) {
        data[collection].replace(documents(list))
      }
    }
    for (const collection of DEVICE_CONTROL) {
      data[collection].replace(documents(snapshot[collection]))
    }
    data.retentionRules.replace(documents(snapshot.retentionRules))
    // the clock does not matter: the snapshot has the blocks
    data.measurementGenerators.replace((snapshot.measurementGenerators ?? []).map((entry) => [String(entry.idStart), compileGenerator(clone(entry.generator), entry.idStart, entry.block, 0)]))
    data.measurementTombstones.replace((snapshot.measurementTombstones ?? []).map((tombstone, index) => [tombstone.kind === 'point' ? tombstone.id : `range#${index}`, clone(tombstone)]))
    data.auditRecords.replace(documents(snapshot.auditRecords))
    data.notificationSubscriptions.replace((snapshot.notificationSubscriptions ?? []).map((subscription) => [subscription.id, clone(subscription)]))
    data.notificationTokens.replace((snapshot.notificationTokens ?? []).map(([token, owner]) => [token, { ...owner }]))
    data.serviceState.replace((snapshot.serviceState ?? []).map(([id, value]) => [id, clone(value)]))
    data.usageStatistics.replace((snapshot.usageStatistics ?? []).map((day) => [day.day, clone(day)]))
    data.trustedCertificates.replace((snapshot.trustedCertificates ?? []).map((certificate) => [certificate.fingerprint, { ...certificate }]))
    data.options.replace([])
    // monitoring starts over from the restored managed objects
    data.availability = new AvailabilityQueue()
    return data
  })
}

const NONE: ReadonlySet<string> = new Set()

function diffCollection(before: StoredDocument[], after: StoredDocument[], recreated: ReadonlySet<string> = NONE): CollectionDiff {
  const previous = new Map(before.map((document) => [document.id, document]))
  const current = new Map(after.map((document) => [document.id, document]))
  const result: CollectionDiff = { created: [], updated: [], deleted: [] }
  for (const document of after) {
    const old = previous.get(document.id)
    if (!old || recreated.has(document.id)) {
      result.created.push(document)
    } else if (JSON.stringify(old) !== JSON.stringify(document)) {
      result.updated.push({ before: old, after: document })
    }
  }
  for (const document of before) {
    if (!current.has(document.id) || recreated.has(document.id)) {
      result.deleted.push(document)
    }
  }
  return result
}

const binaryDocuments = (list: Array<[string, BinarySnapshot]>) => list.map(([id, content]) => ({ id, ...content }))
const serviceStateDocuments = (list: Array<[string, C8yJson]> = []) => list.map(([id, value]) => ({ id, ...splitServiceStateKey(id), value }))
const usageDocuments = (list: StoredUsageDay[] = []) => list.map((day) => ({ id: day.day, ...day }))
const certificateDocuments = (list: StoredTrustedCertificate[] = []) => list.map((certificate) => ({ id: certificate.fingerprint, ...certificate }))

/**
 * Tombstones of `after` that `before` does not have, in write order.
 * @param before - Earlier tenant snapshot
 * @param after - Later tenant snapshot
 */
function newTombstones(before: TenantSnapshot, after: TenantSnapshot): MeasurementTombstone[] {
  const known = new Set((before.measurementTombstones ?? []).map((tombstone) => JSON.stringify(tombstone)))
  return (after.measurementTombstones ?? []).filter((tombstone) => !known.has(JSON.stringify(tombstone)))
}

/**
 * Stored measurement changes, plus the generated measurements deleted by id.
 * @param before - Earlier tenant snapshot
 * @param after - Later tenant snapshot
 * @param recreated
 */
function diffMeasurements(before: TenantSnapshot, after: TenantSnapshot, recreated: ReadonlySet<string> = NONE): CollectionDiff {
  const diff = diffCollection(before.measurements, after.measurements, recreated)
  for (const tombstone of newTombstones(before, after)) {
    if (tombstone.kind === 'point') {
      diff.deleted.push(tombstone.document)
    }
  }
  return diff
}

/**
 * The child references of `snapshot` that `other` does not have, in the
 * order of `snapshot`.
 * @param snapshot - Tenant snapshot
 * @param other - Tenant snapshot to compare with
 */
function relationsOnlyIn(snapshot: TenantSnapshot, other: TenantSnapshot): RelationChange[] {
  const others = new Map(other.children)
  return snapshot.children.flatMap(([parent, relations]) => CHILD_KINDS.flatMap((kind) => relations[kind]
    .filter((child) => !others.get(parent)?.[kind].includes(child))
    .map((child) => ({ parent, kind, child }))))
}

function emptyTenantSnapshot(tenant: string): TenantSnapshot {
  return { tenant, managedObjects: [], children: [], externalIds: [], measurements: [], events: [], alarms: [], operations: [], binaries: [], eventBinaries: [], users: [], groups: [], roles: [], inventoryRoles: [], inventoryAssignments: [], retentionRules: [], auditRecords: [] }
}

/**
 * What changed between two snapshots. A document deleted and created again
 * with the same id and content does not show (a snapshot cannot tell);
 * a fork's own `diff()` lists it as deleted and created.
 * @param before - Earlier snapshot
 * @param after - Later snapshot
 */
export function diffSnapshots(before: Pick<WorldSnapshot, 'tenants' | 'options'>, after: Pick<WorldSnapshot, 'tenants' | 'options'>): WorldDiff {
  return diffWorld(before, after, new Map())
}

/**
 * `diffSnapshots()` with the keys a fork deleted and set again.
 * @param before - Earlier snapshot
 * @param after - Later snapshot
 * @param recreatedKeys - Keys deleted and set again, from `touchedSnapshots()`
 */
export function diffWorld(before: Pick<WorldSnapshot, 'tenants' | 'options'>, after: Pick<WorldSnapshot, 'tenants' | 'options'>, recreatedKeys: RecreatedKeys): WorldDiff {
  const tenants: Record<string, TenantDiff> = {}
  const names = new Set([...before.tenants, ...after.tenants].map((snapshot) => snapshot.tenant))
  for (const name of names) {
    const old = before.tenants.find((snapshot) => snapshot.tenant === name) ?? emptyTenantSnapshot(name)
    const current = after.tenants.find((snapshot) => snapshot.tenant === name) ?? emptyTenantSnapshot(name)
    const recreated = (collection: TenantCollection) => recreatedKeys.get(name)?.get(collection) ?? NONE
    const key = (entry: ExternalId) => `${entry.type}\u0000${entry.externalId}\u0000${entry.managedObjectId}`
    const again = (entry: ExternalId) => recreated('externalIds').has(externalIdKey(entry.type, entry.externalId))
    const oldIds = new Set(old.externalIds.map(key))
    const currentIds = new Set(current.externalIds.map(key))
    const documents = (collection: 'managedObjects' | 'events' | 'alarms' | 'operations' | 'users' | 'groups' | 'inventoryRoles' | 'inventoryAssignments' | 'retentionRules' | 'auditRecords' | 'bulkOperations' | 'newDeviceRequests' | 'applications' | 'applicationSubscriptions') => diffCollection(old[collection] ?? [], current[collection] ?? [], recreated(collection))
    const diff: TenantDiff = {
      managedObjects: documents('managedObjects'),
      measurements: diffMeasurements(old, current, recreated('measurements')),
      deletedMeasurementRanges: newTombstones(old, current).filter((tombstone) => tombstone.kind === 'range').map(({ kind: _kind, ...range }) => range),
      events: documents('events'),
      alarms: documents('alarms'),
      operations: documents('operations'),
      bulkOperations: documents('bulkOperations'),
      newDeviceRequests: documents('newDeviceRequests'),
      externalIds: {
        created: current.externalIds.filter((entry) => !oldIds.has(key(entry)) || again(entry)),
        deleted: old.externalIds.filter((entry) => !currentIds.has(key(entry)) || again(entry)),
      },
      users: documents('users'),
      groups: documents('groups'),
      roles: {
        created: (current.roles ?? []).filter((role) => !(old.roles ?? []).includes(role) || recreated('roles').has(role)),
        deleted: (old.roles ?? []).filter((role) => !(current.roles ?? []).includes(role) || recreated('roles').has(role)),
      },
      inventoryRoles: documents('inventoryRoles'),
      inventoryAssignments: documents('inventoryAssignments'),
      retentionRules: documents('retentionRules'),
      auditRecords: documents('auditRecords'),
      notificationSubscriptions: diffCollection((old.notificationSubscriptions ?? []) as unknown as StoredDocument[], (current.notificationSubscriptions ?? []) as unknown as StoredDocument[], recreated('notificationSubscriptions')),
      binaries: diffCollection(binaryDocuments(old.binaries), binaryDocuments(current.binaries), recreated('binaries')),
      eventBinaries: diffCollection(binaryDocuments(old.eventBinaries), binaryDocuments(current.eventBinaries), recreated('eventBinaries')),
      serviceState: diffCollection(serviceStateDocuments(old.serviceState), serviceStateDocuments(current.serviceState), recreated('serviceState')),
      applications: documents('applications'),
      applicationSubscriptions: documents('applicationSubscriptions'),
      usageStatistics: diffCollection(usageDocuments(old.usageStatistics), usageDocuments(current.usageStatistics), recreated('usageStatistics')),
      trustedCertificates: diffCollection(certificateDocuments(old.trustedCertificates), certificateDocuments(current.trustedCertificates), recreated('trustedCertificates')),
      relations: { created: relationsOnlyIn(current, old), deleted: relationsOnlyIn(old, current) },
    }
    const changed = diff.deletedMeasurementRanges.length > 0 || [...COLLECTIONS, ...USER_COLLECTIONS, ...DEVICE_CONTROL, ...APPLICATION_COLLECTIONS, 'retentionRules' as const, 'auditRecords' as const, 'notificationSubscriptions' as const, 'binaries' as const, 'eventBinaries' as const, 'serviceState' as const, 'usageStatistics' as const, 'trustedCertificates' as const].some((collection) => {
      const { created, updated, deleted } = diff[collection]
      return created.length + updated.length + deleted.length > 0
    }) || diff.externalIds.created.length + diff.externalIds.deleted.length + diff.roles.created.length + diff.roles.deleted.length + diff.relations.created.length + diff.relations.deleted.length > 0
    if (changed) {
      tenants[name] = diff
    }
  }

  const optionKey = (entry: [string, string, string, string | null]) => entry.slice(0, 3).join('\u0000')
  const oldOptions = new Map(before.options.map((entry) => [optionKey(entry), entry]))
  const currentOptions = new Map(after.options.map((entry) => [optionKey(entry), entry]))
  const options: WorldDiff['options'] = []
  for (const id of new Set([...oldOptions.keys(), ...currentOptions.keys()])) {
    const old = oldOptions.get(id)
    const current = currentOptions.get(id)
    const [tenant, category, key] = (current ?? old)!
    if (old && current && recreatedKeys.get(tenant)?.get('options')?.has(`${category}\u0000${key}`)) {
      // deleted and set again: a delete, then a create
      options.push({ tenant, category, key, before: old[3], after: undefined }, { tenant, category, key, before: undefined, after: current[3] })
    } else if (old?.[3] !== current?.[3]) {
      options.push({ tenant, category, key, before: old?.[3], after: current?.[3] })
    }
  }
  return { tenants, options }
}
