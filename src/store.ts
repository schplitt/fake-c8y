/**
 * In-memory data of the fake tenant: managed objects (with child relations),
 * external ids, measurements, events, alarms, operations, bulk operations, and
 * new device requests, kept per tenant.
 *
 * Ids come from one counter shared by all collections (`WorldContext.newId`);
 * timestamps come from the world's clock.
 */
import type { NotificationSubscription, NotificationToken, Realtime, RealtimeApi } from './realtime'
import type { MeasurementStream, MeasurementTombstone } from './generators'
import type { C8yJson } from './services'
import type { C8yRequest } from './types'
import type { StoredUsageDay, UsageLog } from './api/statistics'
import type { StoredTrustedCertificate } from './api/tenant-admin'
import { Collection } from './collection'
import { generatedView } from './generators'
import { addDefaultUserManagement } from './user-defaults'
import { AvailabilityQueue } from './availability-queue'
import { addDefaultApplications } from './application-defaults'

/**
 * A stored document. Fragments are kept as given.
 */
export interface StoredDocument {
  id: string
  [fragment: string]: unknown
}

export type ChildKind = 'childDevices' | 'childAssets' | 'childAdditions'

export const CHILD_KINDS: ChildKind[] = ['childDevices', 'childAssets', 'childAdditions']

export const PARENT_KIND: Record<ChildKind, string> = {
  childDevices: 'deviceParents',
  childAssets: 'assetParents',
  childAdditions: 'additionParents',
}

export interface ExternalId {
  type: string
  externalId: string
  managedObjectId: string
}

/**
 * What the API handlers need from the world a tenant lives in.
 */
export interface WorldContext {
  /**
   * Base URL used in `self`/`next` links, without a trailing slash.
   */
  baseUrl: string
  /**
   * Next id, from one sequence shared by all collections of all tenants. The
   * kind picks the format (see the `ids` world option): managed objects and
   * measurements look different from the other documents on the platform.
   */
  newId: (kind?: 'managedObject' | 'measurement' | 'document') => string
  /**
   * Reserves a block of sequence numbers at once (generated measurements:
   * point `i` of a block has sequence number `first + i`, its id is
   * `measurementId(first + i)`).
   * @returns The first sequence number of the block
   */
  reserveIds: (count: number) => number
  /**
   * The id of the measurement with this sequence number, in the world's id
   * format (`newId('measurement')` hands out the same).
   */
  measurementId: (n: number) => string
  /**
   * The sequence number of a measurement id, `NaN` if the id is not one the
   * world's id format makes (the inverse of `measurementId()`).
   */
  measurementSequence: (id: string) => number
  /**
   * Current time as an ISO string.
   */
  now: () => string
  /**
   * Notification 2.0 state of the world.
   */
  realtime: Realtime
  /**
   * Publishes a data change, unless the world is muted.
   */
  notify: (data: TenantData, api: RealtimeApi, action: 'CREATE' | 'UPDATE' | 'DELETE', document: StoredDocument, sourceId: string | undefined) => void
  /**
   * The microservice's own tenant option category: its `credentials.*`
   * options read decrypted.
   */
  settingsCategory: string
  /**
   * User name of the request being answered, or `undefined` outside a request
   * (world helpers such as `seed()` write no audit records).
   */
  actor: () => string | undefined
  /**
   * The request being answered, or `undefined` outside a request.
   */
  request: () => C8yRequest | undefined
  /**
   * Deep-freeze every stored document (`WorldOptions.freezeDocuments`).
   */
  freezeDocuments: boolean
  /**
   * The data of another tenant of the world, if it has one (applications
   * owned by one tenant and subscribed by another).
   */
  tenantData?: (tenant: string) => TenantData | undefined
  /**
   * All tenants of the world (an application delete ends every subscription).
   */
  tenants?: () => Iterable<TenantData>
  /**
   * What the requests since the last reset added to the usage statistics.
   */
  usage: () => UsageLog
}

export interface TenantData {
  tenant: string
  world: WorldContext
  managedObjects: Collection<StoredDocument>
  /**
   * parent id → kind → child ids, in insertion order
   */
  children: Collection<Relations>
  /**
   * External ids by `externalIdKey(type, externalId)`.
   */
  externalIds: Collection<ExternalId>
  measurements: Collection<StoredDocument>
  /**
   * Measurement generators (generated history, src/generators.ts) by the id
   * of their first grid point.
   */
  measurementGenerators: Collection<MeasurementStream>
  /**
   * Deleted generated measurements: point tombstones by id, range
   * tombstones (deletes by filter) by `range#<n>`, in write order.
   */
  measurementTombstones: Collection<MeasurementTombstone>
  events: Collection<StoredDocument>
  alarms: Collection<StoredDocument>
  operations: Collection<StoredDocument>
  /**
   * inventory binary id → content
   */
  binaries: Collection<BinaryContent>
  /**
   * event id → attachment
   */
  eventBinaries: Collection<BinaryContent>
  /**
   * user name (case-sensitive) → user: profile fields, `customProperties`,
   * `roles` (global role names) and `groups` (group ids)
   */
  users: Collection<StoredDocument>
  /**
   * group id → group: `name`, `description`, `customProperties`, `roles` (global role names)
   */
  groups: Collection<StoredDocument>
  /**
   * Global role names (`ROLE_*`) → the name, in catalogue order.
   */
  roles: Collection<string>
  /**
   * inventory role id → inventory role: `name`, `description`, `permissions`
   */
  inventoryRoles: Collection<StoredDocument>
  /**
   * assignment id → inventory assignment: `user`, `managedObject`, `roles` (inventory role ids)
   */
  inventoryAssignments: Collection<StoredDocument>
  /**
   * Next ids of the collections that count on their own, like on the
   * platform (`nextSequence()`): groups, inventory roles, their permissions,
   * inventory assignments, bulk operations, and Notification 2.0
   * subscriptions and tokens.
   */
  sequences: Collection<number>
  /**
   * Bulk operations by id. Their ids come from the `bulkOperation` sequence,
   * like on the platform, not from `newId()`.
   */
  bulkOperations: Collection<StoredDocument>
  /**
   * New device requests by their (external) device id.
   */
  newDeviceRequests: Collection<StoredDocument>
  /**
   * Tenant options by `category\u0000key`. `null`: an option stored without a value.
   */
  options: Collection<string | null>
  retentionRules: Collection<StoredDocument>
  /**
   * Audit records, in creation order. Written by the write paths through
   * `recordAudit()` (src/api/audit.ts).
   */
  auditRecords: Collection<StoredDocument>
  /**
   * Notification 2.0 subscriptions by id (ids from the `notification` sequence).
   */
  notificationSubscriptions: Collection<NotificationSubscription>
  /**
   * Notification 2.0 tokens by token value.
   */
  notificationTokens: Collection<NotificationToken>
  /**
   * State of service emulations (`world.service()`) by
   * `<service>/<store>/<key>` (`serviceStateKey()`), as JSON.
   */
  serviceState: Collection<C8yJson>
  /**
   * Devices whose availability is due to change by the clock (not tenant
   * data: derived from the managed objects, rebuilt after a restore).
   */
  availability: AvailabilityQueue
  /**
   * Applications by id: the ones the tenant owns, and its copies of the
   * platform's default applications (owner `management`, see
   * `src/application-defaults.ts`). Ids of new ones come from the
   * `application` sequence.
   */
  applications: Collection<StoredDocument>
  /**
   * The tenant's subscriptions to applications by application id:
   * `{ id, owner }` (the owner tenant of the application), plus the service
   * user (`serviceUser`, `password`) of a microservice.
   */
  applicationSubscriptions: Collection<StoredDocument>
  /**
   * Seeded days of usage statistics by day (`YYYY-MM-DD`, UTC). The
   * requests of a trial add to them from the world's `UsageLog`.
   */
  usageStatistics: Collection<StoredUsageDay>
  /**
   * Trusted certificates by fingerprint.
   */
  trustedCertificates: Collection<StoredTrustedCertificate>
}

/**
 * Child ids of a managed object by relation kind. Stored values are never
 * changed in place (see `addChild()`).
 */
export type Relations = Readonly<Record<ChildKind, readonly string[]>>

/**
 * The per-tenant sequences (next ids) in `TenantData.sequences`.
 */
export type SequenceName = 'group' | 'inventoryRole' | 'permission' | 'assignment' | 'bulkOperation' | 'notification' | 'application'

/**
 * The collections of a tenant, in snapshot order.
 */
export type TenantCollection = 'managedObjects' | 'children' | 'externalIds' | 'measurements' | 'events' | 'alarms' | 'operations' | 'binaries' | 'eventBinaries' | 'users' | 'groups' | 'roles' | 'inventoryRoles' | 'inventoryAssignments' | 'sequences' | 'bulkOperations' | 'newDeviceRequests' | 'options' | 'retentionRules' | 'auditRecords' | 'measurementGenerators' | 'measurementTombstones' | 'notificationSubscriptions' | 'notificationTokens' | 'serviceState' | 'applications' | 'applicationSubscriptions' | 'usageStatistics' | 'trustedCertificates'

export const TENANT_COLLECTIONS: readonly TenantCollection[] = ['managedObjects', 'children', 'externalIds', 'measurements', 'events', 'alarms', 'operations', 'binaries', 'eventBinaries', 'users', 'groups', 'roles', 'inventoryRoles', 'inventoryAssignments', 'sequences', 'bulkOperations', 'newDeviceRequests', 'options', 'retentionRules', 'auditRecords', 'measurementGenerators', 'measurementTombstones', 'notificationSubscriptions', 'notificationTokens', 'serviceState', 'applications', 'applicationSubscriptions', 'usageStatistics', 'trustedCertificates']

/**
 * Stored file content of a binary or an event attachment.
 */
export interface BinaryContent {
  bytes: Uint8Array
  contentType: string
  name: string
}

export type DocumentCollection = 'managedObjects' | 'measurements' | 'events' | 'alarms' | 'operations'

/**
 * A tenant with the platform's role catalogue, default groups, and default
 * inventory roles, and no other data.
 * @param tenant - Tenant id
 * @param world - The world it lives in
 */
export function emptyTenant(tenant: string, world: WorldContext): TenantData {
  const options = { freezeValues: world.freezeDocuments }
  const data = { tenant, world, availability: new AvailabilityQueue() } as TenantData
  for (const name of TENANT_COLLECTIONS) {
    (data as unknown as Record<TenantCollection, Collection<unknown>>)[name] = new Collection([], options)
  }
  data.sequences.set('bulkOperation', 1)
  // every tenant starts with the platform's role catalogue and default groups
  addDefaultUserManagement(data)
  // and with the platform's default applications, subscribed
  addDefaultApplications(data)
  return data
}

/**
 * A copy-on-write tenant on top of a frozen one.
 * @param base - Frozen tenant data
 * @param world - The world the fork lives in
 */
export function forkTenant(base: TenantData, world: WorldContext): TenantData {
  const data = { tenant: base.tenant, world, availability: base.availability.fork() } as TenantData
  for (const name of TENANT_COLLECTIONS) {
    (data as unknown as Record<TenantCollection, Collection<unknown>>)[name] = base[name].fork()
  }
  return data
}

/**
 * Makes a tenant's data read-only.
 * @param data - Tenant data
 * @param deep - Also deep-freeze the stored documents
 */
export function freezeTenant(data: TenantData, deep: boolean): void {
  for (const name of TENANT_COLLECTIONS) {
    data[name].freeze(deep)
  }
}

/**
 * Hands out the next value of a per-tenant sequence.
 * @param data - Tenant data
 * @param name - Sequence
 */
export function nextSequence(data: TenantData, name: SequenceName): number {
  const value = data.sequences.get(name) ?? 1
  data.sequences.set(name, value + 1)
  return value
}

/**
 * Key of an external id in `TenantData.externalIds`.
 * @param type - External id type
 * @param externalId - External id value
 */
export function externalIdKey(type: string, externalId: string): string {
  return `${type}\u0000${externalId}`
}

const byManagedObject = (entry: ExternalId): string => entry.managedObjectId

/**
 * The external ids of a managed object, in the order they were added, from an
 * index (`Collection.groupedBy()`). Call it once per request.
 * @param data - Tenant data
 * @returns External ids by managed object id
 */
export function externalIdsByObject(data: TenantData): (id: string) => Array<Readonly<ExternalId>> {
  const keys = data.externalIds.groupedBy(byManagedObject)
  return (id) => keys(id).map((key) => data.externalIds.get(key)!)
}

/**
 * Key of a tenant option in `TenantData.options`.
 * @param category - Option category
 * @param key - Option key
 */
export function optionKey(category: string, key: string): string {
  return `${category}\u0000${key}`
}

/**
 * Child ids of a managed object.
 * @param data - Tenant data
 * @param parentId - Managed object id
 * @param kind - Relation kind
 */
export function childIds(data: TenantData, parentId: string, kind: ChildKind): string[] {
  return (data.children.get(parentId)?.[kind] ?? []) as string[]
}

/**
 * The given objects and their children of the given kinds, recursively.
 * @param data - Tenant data
 * @param roots - Managed object ids
 * @param kinds - Relation kinds to follow (default: all)
 */
export function descendants(data: TenantData, roots: Iterable<string>, kinds: readonly ChildKind[] = CHILD_KINDS): Set<string> {
  const result = new Set<string>()
  const queue = [...roots]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    if (result.has(id)) {
      continue
    }
    result.add(id)
    for (const kind of kinds) {
      for (const child of childIds(data, id, kind)) {
        if (!result.has(child)) {
          queue.push(child)
        }
      }
    }
  }
  return result
}

/**
 * Parent ids of a managed object for a relation kind.
 * @param data - Tenant data
 * @param childId - Managed object id
 * @param kind - Relation kind (the parent's children list)
 */
export function parentIds(data: TenantData, childId: string, kind: ChildKind): string[] {
  const parents: string[] = []
  for (const [parentId, relations] of data.children) {
    if (relations[kind].includes(childId)) {
      parents.push(parentId)
    }
  }
  return parents
}

/**
 * Adds a child reference (idempotent).
 * @param data - Tenant data
 * @param parentId - Parent managed object id
 * @param kind - Relation kind
 * @param childId - Child managed object id
 */
export function addChild(data: TenantData, parentId: string, kind: ChildKind, childId: string): void {
  const relations = data.children.get(parentId) ?? { childDevices: [], childAssets: [], childAdditions: [] }
  if (!relations[kind].includes(childId)) {
    data.children.set(parentId, { ...relations, [kind]: [...relations[kind], childId] })
  }
}

/**
 * Removes a child reference.
 * @param data - Tenant data
 * @param parentId - Parent managed object id
 * @param kind - Relation kind
 * @param childId - Child managed object id
 * @returns Whether the reference existed
 */
export function removeChild(data: TenantData, parentId: string, kind: ChildKind, childId: string): boolean {
  const relations = data.children.get(parentId)
  if (!relations?.[kind].includes(childId)) {
    return false
  }
  data.children.set(parentId, { ...relations, [kind]: relations[kind].filter((id) => id !== childId) })
  return true
}

/**
 * Deletes a managed object with everything that belongs to it (verified): its
 * references (both directions), external ids, binary, measurements, events
 * (with attachments), alarms, operations, Notification 2.0 subscriptions of
 * the object, and inventory assignments on it. Child objects stay; the
 * inventory API decides which descendants go too (`cascade`).
 * @param data - Tenant data
 * @param id - Managed object id
 */
export function deleteManagedObject(data: TenantData, id: string): boolean {
  if (!data.managedObjects.delete(id)) {
    return false
  }
  data.children.delete(id)
  for (const [parentId, relations] of data.children) {
    if (CHILD_KINDS.some((kind) => relations[kind].includes(id))) {
      const next: Record<ChildKind, readonly string[]> = { ...relations }
      for (const kind of CHILD_KINDS) {
        next[kind] = relations[kind].filter((childId) => childId !== id)
      }
      data.children.set(parentId, next)
    }
  }
  for (const [key, entry] of data.externalIds) {
    if (entry.managedObjectId === id) {
      data.externalIds.delete(key)
    }
  }
  data.binaries.delete(id)
  const view = generatedView(data)
  if (view?.bySource.has(id)) {
    // its generated measurements go too, also the ones a live generator would add later
    data.measurementTombstones.set(`range#${data.measurementTombstones.size}`, { kind: 'range', source: id, count: view.total({ sources: new Set([id]) }) })
  }
  for (const collection of ['measurements', 'events', 'alarms', 'operations'] as const) {
    for (const [documentId, document] of data[collection]) {
      const owner = collection === 'operations' ? document.deviceId : (document.source as { id?: unknown } | undefined)?.id
      if (String(owner) === id) {
        data[collection].delete(documentId)
        if (collection === 'events') {
          data.eventBinaries.delete(documentId)
        }
      }
    }
  }
  for (const [assignmentId, assignment] of data.inventoryAssignments) {
    if (assignment.managedObject === id) {
      data.inventoryAssignments.delete(assignmentId)
    }
  }
  for (const [subscriptionId, subscription] of data.notificationSubscriptions) {
    if (subscription.source?.id === id) {
      data.notificationSubscriptions.delete(subscriptionId)
    }
  }
  return true
}
