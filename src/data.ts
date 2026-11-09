import { scheduleAvailability } from './availability'
import type { C8yAlarmSeverity, C8yAlarmStatus, C8yOperationStatus } from './capabilities.generated'
import type { DocumentCollection, StoredDocument, TenantData } from './store'
import { createDocument, RESOURCES, renderDocument, updateDocument } from './api/data'
import { addExternalId } from './api/identity'
import { createManagedObject, parentIndex, renderManagedObject } from './api/inventory'
import { createBinary } from './api/binaries'
import { renderBulkOperation } from './api/bulkoperations'
import type { C8yNewDeviceRequestStatus } from './api/registration'
import { createNewDeviceRequest, renderNewDeviceRequest } from './api/registration'
import { recordAudit, renderAuditRecord } from './api/audit'
import type { AuditChange } from './api/audit'
import { createRetentionRule } from './api/retention'
import type { C8yUsageStatisticsInput } from './api/statistics'
import { seedUsageStatistics } from './api/statistics'
import type { C8yTrustedCertificateInput } from './api/tenant-admin'
import { seedTrustedCertificates } from './api/tenant-admin'
import { addChild, CHILD_KINDS, PARENT_KIND } from './store'
import type { Collection } from './collection'
import { sourceId } from './api/http'
import type { C8yMeasurementGeneratorInput } from './generators'
import { generatedView, seedGenerators } from './generators'
import type { C8yServiceStateInput, C8yServiceStore } from './services'
import { serviceStateKey, serviceStore, toJson } from './services'
import type { C8yApplicationInput } from './api/applications'
import { renderApplication, seedApplications, visibleApplications } from './api/applications'
import { createAssignment, createGroup, createInventoryRole, createUser, effectiveRoles, groupId, inventoryRoleId, renderAssignment, renderGroup, renderInventoryRole, renderRole, renderUser, UserApiError } from './api/users'

/**
 * A managed object id, or an object with its `id` (e.g. a test framework's
 * lazy reference).
 */
export type C8yIdInput = string | { readonly id: string }

export function resolveId(input: C8yIdInput): string {
  return typeof input === 'string' ? input : input.id
}

/**
 * The id of a reference object: an instance of a class (not a plain object)
 * with a string `id`, e.g. a test framework's lazy reference. Plain objects are
 * matched field by field instead.
 * @param value - Any value
 */
function refId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype === Object.prototype || prototype === null) {
    return undefined
  }
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/**
 * Input of `world.managedObject()` and `world.device()`.
 */
export interface C8yManagedObjectInput {
  name?: string
  type?: string
  /**
   * Defaults to the current user.
   */
  owner?: string
  /**
   * Child devices (references in `childDevices`).
   */
  children?: C8yIdInput[]
  /**
   * Child assets (references in `childAssets`).
   */
  assets?: C8yIdInput[]
  /**
   * Child additions (references in `childAdditions`).
   */
  additions?: C8yIdInput[]
  /**
   * External ids by type, e.g. `{ c8y_Serial: 'SN-1' }`.
   */
  externalIds?: Record<string, string>
  /**
   * Tenant to create it in. Defaults to the deployed tenant.
   */
  tenant?: string
  /**
   * Any fragments, e.g. `c8y_Hardware: { serialNumber: 'SN-1' }`.
   */
  [fragment: string]: unknown
}

interface SourcedInput {
  source: C8yIdInput
  type: string
  /**
   * Defaults to now.
   */
  time?: string
  [fragment: string]: unknown
}

export interface C8yMeasurementInput extends SourcedInput {}

export interface C8yEventInput extends SourcedInput {
  /**
   * Defaults to `type`.
   */
  text?: string
}

export interface C8yAlarmInput extends SourcedInput {
  /**
   * Defaults to `type`.
   */
  text?: string
  /**
   * Defaults to `MAJOR`.
   */
  severity?: C8yAlarmSeverity
  /**
   * Defaults to `ACTIVE`.
   */
  status?: C8yAlarmStatus
}

export interface C8yOperationInput {
  deviceId: C8yIdInput
  /**
   * Defaults to `PENDING`.
   */
  status?: C8yOperationStatus
  failureReason?: string
  [fragment: string]: unknown
}

export interface C8yNewDeviceRequestInput {
  /**
   * The device's external id.
   */
  id: string
  /**
   * Defaults to `WAITING_FOR_CONNECTION`. `PENDING_ACCEPTANCE` is a device
   * that has connected and waits for a user to accept it.
   */
  status?: C8yNewDeviceRequestStatus
  type?: string
  groupId?: C8yIdInput
  /**
   * Defaults to the current user.
   */
  owner?: string
}

/**
 * A user group to seed.
 */
export interface C8yGroupInput {
  name: string
  description?: string
  /**
   * Global role names, e.g. `ROLE_ALARM_READ`.
   */
  roles?: string[]
  customProperties?: Record<string, unknown>
}

/**
 * An inventory role to seed.
 */
export interface C8yInventoryRoleInput {
  name: string
  description?: string
  permissions?: Array<{ permission: 'ADMIN' | 'READ' | '*', scope: 'ALARM' | 'AUDIT' | 'EVENT' | 'MANAGED_OBJECT' | 'MEASUREMENT' | 'OPERATION' | '*', type: string }>
}

/**
 * A user to seed.
 */
export interface C8yUserInput {
  /**
   * Case-sensitive, like on the platform.
   */
  userName: string
  /**
   * Defaults to the user name if it is an email address, else `<userName>@example.com`.
   */
  email?: string
  /**
   * Global role names assigned to the user directly. Default: none.
   */
  roles?: string[]
  /**
   * Groups the user is a member of, by name or id.
   */
  groups?: Array<string | number>
  /**
   * Inventory roles (by name or id) on managed objects.
   */
  inventoryAssignments?: Array<{ managedObject: C8yIdInput, roles: Array<string | number> }>
  customProperties?: Record<string, unknown>
  /**
   * Any other user fields: `firstName`, `lastName`, `phone`, `owner`, `enabled`, `devicePermissions`, ...
   */
  [field: string]: unknown
}

/**
 * A retention rule, validated like `POST /retention/retentions`. Filters
 * default to `*`.
 */
export interface C8yRetentionRuleInput {
  dataType?: 'ALARM' | 'AUDIT' | 'EVENT' | 'MEASUREMENT' | 'OPERATION' | '*'
  fragmentType?: string
  type?: string
  source?: string
  /**
   * Maximum age in days.
   */
  maximumAge: number
}

/**
 * An audit record, e.g. history from before the eval started.
 */
export interface C8yAuditRecordInput {
  /**
   * Platform component, e.g. `Alarm`, `Operation`, `Inventory`, `Option`, `User`.
   */
  type: string
  /**
   * Summary, e.g. `Alarm created`.
   */
  activity: string
  text: string
  /**
   * The changed object (for options `category.key`, for users the user name).
   */
  source: C8yIdInput
  /**
   * Defaults to now.
   */
  time?: string
  /**
   * Defaults to the current user.
   */
  user?: string
  application?: string
  severity?: string
  changes?: AuditChange[]
  [fragment: string]: unknown
}

/**
 * Input of `world.seed()`.
 */
export interface C8ySeed {
  /**
   * Global roles to add to the tenant's role catalogue.
   */
  roles?: string[]
  inventoryRoles?: C8yInventoryRoleInput[]
  groups?: C8yGroupInput[]
  users?: C8yUserInput[]
  measurements?: C8yMeasurementInput[]
  /**
   * Measurement history computed on read instead of stored: one document per
   * grid point and generator. Seeding reserves the ids of all grid points.
   */
  measurementGenerators?: C8yMeasurementGeneratorInput[]
  events?: C8yEventInput[]
  alarms?: C8yAlarmInput[]
  operations?: C8yOperationInput[]
  newDeviceRequests?: C8yNewDeviceRequestInput[]
  retentionRules?: C8yRetentionRuleInput[]
  /**
   * Seeded audit records. API writes add their own.
   */
  auditRecords?: C8yAuditRecordInput[]
  /**
   * State of service emulations (`world.service()`), as their handlers
   * read it with `ctx.store(store).get(key)`.
   */
  serviceState?: C8yServiceStateInput[]
  /**
   * Applications of the tenant, added or replaced (by `id`, else by `name`
   * and owner). Every tenant starts with the platform's default
   * applications (`DEFAULT_APPLICATIONS`).
   */
  applications?: C8yApplicationInput[]
  /**
   * `false` removes the default applications (and the subscriptions to
   * them) before `applications` are added.
   */
  defaultApplications?: false
  /**
   * Days of usage statistics (`GET /tenant/statistics`) before the trial;
   * a seeded day replaces an earlier seed of the same day. Requests add to
   * them, and the device counts of today come from the inventory.
   */
  usageStatistics?: C8yUsageStatisticsInput[]
  /**
   * Trusted certificates (`GET /tenant/tenants/{tenantId}/trusted-certificates`).
   */
  trustedCertificates?: C8yTrustedCertificateInput[]
  /**
   * Tenant to seed. Defaults to the deployed tenant.
   */
  tenant?: string
}

/**
 * What `world.seed()` created: the ids per seeded list, in input order, one
 * entry per input item. A list is here when the seed has it (also when it is
 * empty). The ids are the ones the API uses for the document, so they work in
 * `GET .../{id}` and `world.db.<collection>.get(id)`.
 *
 * Lists that create nothing addressable have no entry: `serviceState`,
 * `usageStatistics`, and `trustedCertificates` (keyed by the fingerprint you
 * give).
 */
export interface C8ySeedResult {
  /**
   * The role names, as given (a role that existed already stays as it is).
   */
  roles?: string[]
  inventoryRoles?: string[]
  groups?: string[]
  /**
   * The user names, as given.
   */
  users?: string[]
  measurements?: string[]
  /**
   * One entry per generator: the ids reserved for its grid points. Grid
   * point `i` has the `i`-th id of the world's measurement id sequence from
   * `firstId` on, and ids sort like that sequence, so `firstId` and
   * `lastId` bound the generator's ids. `firstId` is the document at `from`
   * unless a gap covers it. A live generator (no `to`) also reserves ids for
   * points after the clock, so its `lastId` is a point in the future.
   */
  measurementGenerators?: Array<{ firstId: string, lastId: string }>
  events?: string[]
  alarms?: string[]
  operations?: string[]
  /**
   * The request ids, as given (the device's external id).
   */
  newDeviceRequests?: string[]
  retentionRules?: string[]
  auditRecords?: string[]
  /**
   * The id of each input's application: a new one, the given `id`, or the
   * id of the application it replaced (same `id`, else same `name` and
   * owner). Two inputs that replace the same application have the same id.
   */
  applications?: string[]
}

/**
 * What `seed()` returns for a given seed: every list the seed passes (and
 * does not leave possibly undefined) comes back as a required array, so
 * `const { alarms: [overheat] } = world.seed({ alarms: [...] })` typechecks.
 * Lists the seed leaves out stay optional.
 */
export type C8ySeedResultFor<S extends C8ySeed> = C8ySeedResult & {
  [K in keyof S as K extends keyof C8ySeedResult ? (undefined extends S[K] ? never : K) : never]-?: NonNullable<C8ySeedResult[K & keyof C8ySeedResult]>
}

const RESERVED = ['children', 'assets', 'additions', 'externalIds', 'tenant']

/**
 * Creates a managed object from seed input.
 * @param data - Tenant to create it in
 * @param input - Seed input
 * @param owner - Owner when the input names none
 * @returns The new managed object's id
 */
export function createFromInput(data: TenantData, input: C8yManagedObjectInput, owner: string): string {
  const fragments = Object.fromEntries(Object.entries(input).filter(([key]) => !RESERVED.includes(key)))
  const document = createManagedObject(data, fragments, input.owner ?? owner)
  for (const [kind, children] of [['childDevices', input.children], ['childAssets', input.assets], ['childAdditions', input.additions]] as const) {
    for (const child of children ?? []) {
      addChild(data, document.id, kind, resolveId(child))
    }
  }
  for (const [type, externalId] of Object.entries(input.externalIds ?? {})) {
    const result = addExternalId(data, document.id, type, externalId)
    if (result instanceof Response) {
      throw new TypeError(`external id ${type}/${externalId} already exists`)
    }
  }
  return document.id
}

/**
 * Input of `world.binary()`.
 */
export interface C8yBinaryInput {
  /**
   * File name.
   */
  name: string
  /**
   * File content.
   */
  content: string | Uint8Array
  /**
   * Content type. Defaults to `text/plain` for strings, `application/octet-stream` otherwise.
   */
  contentType?: string
  /**
   * Tenant to create it in. Defaults to the deployed tenant.
   */
  tenant?: string
  /**
   * Any other managed object fragments.
   */
  [fragment: string]: unknown
}

/**
 * Creates an inventory binary from seed input.
 * @param data - Tenant to create it in
 * @param input - Binary input
 * @param owner - Owner user name
 * @returns The new binary's id
 */
export function createBinaryFromInput(data: TenantData, input: C8yBinaryInput, owner: string): string {
  const { name, content, contentType, tenant: _tenant, ...fragments } = input
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  const document = createBinary(data, {
    bytes,
    contentType: contentType ?? (typeof content === 'string' ? 'text/plain' : 'application/octet-stream'),
    name,
  }, { name, ...fragments }, owner)
  return document.id
}

/**
 * Stored file content, as read by `world.db.binaries.content()`.
 */
export interface C8yBinaryContent {
  name: string
  contentType: string
  bytes: Uint8Array
  /**
   * The content decoded as UTF-8.
   */
  text: () => string
}

function toContent(content: { name: string, contentType: string, bytes: Uint8Array } | undefined): C8yBinaryContent | undefined {
  return content && { ...content, text: () => new TextDecoder().decode(content.bytes) }
}

function seedInto(data: TenantData, collection: Exclude<DocumentCollection, 'managedObjects'>, input: Record<string, unknown>): string {
  const resource = Object.values(RESOURCES).find((item) => item.collection === collection)!
  const now = data.world.now()
  const body: Record<string, unknown> = { time: now, ...input }
  if ('source' in input) {
    body.source = { id: resolveId(input.source as C8yIdInput) }
  }
  if (collection === 'events' || collection === 'alarms') {
    body.text ??= body.type
  }
  if (collection === 'alarms') {
    body.severity ??= 'MAJOR'
  }
  if (collection === 'operations') {
    delete body.time
    // applied as an update below: the platform rejects them on create
    delete body.status
    delete body.failureReason
    body.deviceId = resolveId(input.deviceId as C8yIdInput)
  }
  const result = createDocument(data, resource, body)
  if (result instanceof Response) {
    throw new TypeError(`seed(): invalid ${collection.slice(0, -1)}: ${(result as Response & { message?: string }).message ?? result.status}`)
  }
  if (collection === 'operations' && (input.status !== undefined || input.failureReason !== undefined)) {
    const updated = updateDocument(data, resource, result, { status: input.status ?? 'PENDING', failureReason: input.failureReason })
    if (updated instanceof Response) {
      throw new TypeError(`seed(): invalid operation: ${(updated as Response & { message?: string }).message ?? updated.status}`)
    }
  }
  return result.id
}

function seedUsers(data: TenantData, seed: C8ySeed, result: C8ySeedResult): void {
  const attempt = <T>(what: string, write: () => T): T => {
    try {
      return write()
    } catch (error) {
      throw new TypeError(`seed(): invalid ${what}: ${error instanceof UserApiError || error instanceof TypeError ? error.message : String(error)}`)
    }
  }
  if (seed.roles) {
    result.roles = seed.roles.map((role) => {
      data.roles.set(role, role)
      return role
    })
  }
  if (seed.inventoryRoles) {
    result.inventoryRoles = seed.inventoryRoles.map((role) => attempt(`inventory role ${role.name}`, () => createInventoryRole(data, { ...role })).id)
  }
  if (seed.groups) {
    result.groups = seed.groups.map((group) => attempt(`group ${group.name}`, () => createGroup(data, { ...group })).id)
  }
  if (seed.users) {
    result.users = seed.users.map((input) => input.userName)
  }
  for (const input of seed.users ?? []) {
    const { roles = [], groups = [], inventoryAssignments = [], ...fields } = input
    attempt(`user ${input.userName}`, () => {
      const email = input.email ?? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.userName) ? input.userName : `${input.userName}@example.com`)
      // the password only passes validation; the fake does not keep it
      createUser(data, { ...fields, email, password: 'Seeded-Password-1' }, roles, { seeding: true })
      data.users.update(input.userName, (user) => {
        user.groups = [...new Set(groups.map((group) => groupId(data, group)))]
      })
      for (const assignment of inventoryAssignments) {
        createAssignment(data, input.userName, { managedObject: resolveId(assignment.managedObject), roles: assignment.roles.map((role) => ({ id: inventoryRoleId(data, role) })) })
      }
    })
  }
}

/**
 * Seeds user management data, measurements, events, alarms, operations, new device requests,
 * retention rules, and audit records (validated like API writes).
 * @param data - Tenant to seed
 * @param seed - Data to seed
 * @param user - User of seeded audit records and new device requests that name none
 * @returns The ids per seeded list, in input order
 */
export function applySeed(data: TenantData, seed: C8ySeed, user: string): C8ySeedResult {
  const result: C8ySeedResult = {}
  seedUsers(data, seed, result)
  if (seed.measurements) {
    result.measurements = seed.measurements.map((measurement) => seedInto(data, 'measurements', measurement))
  }
  if (seed.measurementGenerators) {
    const generators = seed.measurementGenerators.map((generator) => {
      const source = resolveId(generator.source)
      if (!data.managedObjects.has(source)) {
        throw new TypeError(`seed(): invalid measurement generator: source ${source} does not exist`)
      }
      return { ...generator, source }
    })
    const blocks = seedGenerators(data.measurementGenerators, generators, data.world.reserveIds, Date.parse(data.world.now()))
    for (const generator of generators) {
      // generated data keeps a monitored device available
      scheduleAvailability(data, generator.source)
    }
    result.measurementGenerators = blocks.map(({ idStart, block }) => ({ firstId: data.world.measurementId(idStart), lastId: data.world.measurementId(idStart + block - 1) }))
  }
  if (seed.events) {
    result.events = seed.events.map((event) => seedInto(data, 'events', event))
  }
  if (seed.alarms) {
    result.alarms = seed.alarms.map((alarm) => seedInto(data, 'alarms', alarm))
  }
  if (seed.operations) {
    result.operations = seed.operations.map((operation) => seedInto(data, 'operations', operation as Record<string, unknown>))
  }
  if (seed.newDeviceRequests) {
    result.newDeviceRequests = seed.newDeviceRequests.map(({ status, owner: requestOwner, groupId, ...input }) => {
      const created = createNewDeviceRequest(data, { ...input, ...(groupId !== undefined ? { groupId: resolveId(groupId) } : {}) }, requestOwner ?? user)
      if (created instanceof Response) {
        throw new TypeError(`seed(): invalid new device request: ${(created as Response & { message?: string }).message ?? created.status}`)
      }
      if (status !== undefined) {
        data.newDeviceRequests.set(created.id, { ...created, status })
      }
      return created.id
    })
  }
  if (seed.retentionRules) {
    result.retentionRules = seed.retentionRules.map((rule) => {
      const created = createRetentionRule(data, { ...rule })
      if (created instanceof Response) {
        throw new TypeError(`seed(): invalid retention rule: ${(created as Response & { message?: string }).message ?? created.status}`)
      }
      return created.id
    })
  }
  if (seed.auditRecords) {
    result.auditRecords = seed.auditRecords.map(({ type, activity, text, source, time, user: recordUser, application, severity, changes, ...fragments }) => recordAudit(data, {
      type,
      activity,
      text,
      source: resolveId(source),
      user: recordUser ?? user,
      fragments,
      ...(time !== undefined ? { time } : {}),
      ...(application !== undefined ? { application } : {}),
      ...(severity !== undefined ? { severity } : {}),
      ...(changes !== undefined ? { changes } : {}),
    })!.id)
  }
  for (const { service, store = 'default', key, value } of seed.serviceState ?? []) {
    data.serviceState.set(serviceStateKey(service, store, key), toJson(value))
  }
  if (seed.defaultApplications === false || seed.applications) {
    const ids = seedApplications(data, seed.applications ?? [], seed.defaultApplications === false)
    if (seed.applications) {
      result.applications = ids
    }
  }
  seedUsageStatistics(data, seed.usageStatistics ?? [])
  seedTrustedCertificates(data, seed.trustedCertificates ?? [])
  return result
}

/**
 * Filter for `world.db.*.find()`: partial match, or a predicate.
 */
export type C8yDbFilter = Record<string, unknown> | ((document: Record<string, any>) => boolean)

function matches(value: unknown, expected: unknown): boolean {
  const expectedId = refId(expected)
  if (expectedId !== undefined) {
    return (value as { id?: string } | undefined)?.id === expectedId || value === expectedId
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    return Object.entries(expected).every(([key, item]) => matches(value && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined, item))
  }
  return value === expected
}

function filterDocuments<T extends Record<string, unknown>>(documents: T[], filter?: C8yDbFilter): T[] {
  if (!filter) {
    return documents
  }
  if (typeof filter === 'function') {
    return documents.filter(filter)
  }
  const entries = Object.entries(filter)
  return documents.filter((document) => entries.every(([key, expected]) => matchesEntry(document, key, expected)))
}

function matchesEntry(document: Record<string, unknown>, key: string, expected: unknown): boolean {
  const expectedId = idOf(key, expected)
  if (expectedId !== undefined) {
    const actual = key === 'source' ? (document.source as { id?: string } | undefined)?.id : document.deviceId
    return actual === expectedId
  }
  return matches(Object.hasOwn(document, key) ? document[key] : undefined, expected)
}

/**
 * The id a `source` or `deviceId` filter compares (a string or a ref).
 * @param key
 * @param expected
 */
function idOf(key: string, expected: unknown): string | undefined {
  return key === 'source' || key === 'deviceId' ? (typeof expected === 'string' ? expected : refId(expected)) : undefined
}

/**
 * Fields a render adds or changes: a filter on them can only be checked on
 * the rendered document (except `source` and `deviceId` by id).
 */
const RENDERED_FIELDS = new Set(['self', 'source', 'creationTime', 'deviceName', '__agentId', ...CHILD_KINDS, ...Object.values(PARENT_KIND)])

/**
 * The stored documents that can match a partial filter: the filter's fields
 * a render leaves as stored are checked before rendering, and a `source` id
 * takes the documents from the source index.
 * @param collection - The stored documents
 * @param filter - The filter
 * @param indexed - Whether the collection has a source index
 */
function candidates(collection: Collection<StoredDocument>, filter: C8yDbFilter | undefined, indexed: boolean): Iterable<StoredDocument> {
  if (!filter || typeof filter === 'function') {
    return collection.values()
  }
  const checks = Object.entries(filter).filter(([key, expected]) => !RENDERED_FIELDS.has(key) || idOf(key, expected) !== undefined)
  const source = idOf('source', filter.source)
  const documents: Iterable<Readonly<StoredDocument>> = indexed && Object.hasOwn(filter, 'source') && source !== undefined
    ? collection.groupedBy(sourceId)(source).map((key) => collection.get(key)!)
    : collection.values()
  if (checks.length === 0) {
    return documents as Iterable<StoredDocument>
  }
  return [...documents].filter((document) => checks.every(([key, expected]) => matchesEntry(document, key, expected))) as StoredDocument[]
}

/**
 * Read access to one collection of the fake tenant.
 */
export interface C8yDbCollection<T> {
  /**
   * Object by id (or ref).
   */
  get: (id: C8yIdInput) => T | undefined
  /**
   * Objects matching a partial object (refs and ids match `source`/`deviceId`) or a predicate, in creation order.
   */
  find: (filter?: C8yDbFilter) => T[]
}

function collectionView(tenant: () => TenantData, collection: DocumentCollection): C8yDbCollection<Record<string, any>> {
  const render = (data: TenantData, documents: Iterable<StoredDocument>) => {
    if (collection === 'managedObjects') {
      const parents = parentIndex(data)
      return [...documents].map((document) => renderManagedObject(data, document, { withParents: true, parents }))
    }
    const resource = Object.values(RESOURCES).find((item) => item.collection === collection)!
    return [...documents].map((document) => renderDocument(data, resource, document))
  }
  const generated = (data: TenantData) => collection === 'measurements' ? generatedView(data) : undefined
  return {
    get: (id) => {
      const data = tenant()
      const document = data[collection].get(resolveId(id)) ?? generated(data)?.get(resolveId(id))
      return document && render(data, [document])[0]
    },
    find: (filter) => {
      const data = tenant()
      const view = generated(data)
      if (!view) {
        return filterDocuments(render(data, candidates(data[collection], filter, collection !== 'managedObjects')), filter)
      }
      // generated history can be large: only the filter's source, one document at a time
      const source = filter && typeof filter === 'object' && filter.source !== undefined ? (typeof filter.source === 'string' ? filter.source : refId(filter.source)) : undefined
      const sources = source === undefined ? undefined : new Set([source])
      const stored = source === undefined ? data.measurements.values() : data.measurements.groupedBy(sourceId)(source).map((key) => data.measurements.get(key)!)
      const found: Array<Record<string, any>> = []
      for (const document of view.documents(sources ? { sources } : {}, stored)) {
        found.push(...filterDocuments(render(data, [document]), filter))
      }
      return found
    },
  }
}

/**
 * Read (and limited write) access to the fake tenant's data.
 */
export interface C8yDb {
  managedObjects: C8yDbCollection<Record<string, any>>
  measurements: C8yDbCollection<Record<string, any>>
  events: C8yDbCollection<Record<string, any>> & {
    /**
     * Attachment (binary) of an event.
     */
    attachment: (id: C8yIdInput) => C8yBinaryContent | undefined
  }
  binaries: C8yDbCollection<Record<string, any>> & {
    /**
     * Content of an inventory binary.
     */
    content: (id: C8yIdInput) => C8yBinaryContent | undefined
  }
  alarms: C8yDbCollection<Record<string, any>>
  operations: C8yDbCollection<Record<string, any>> & {
    /**
     * Updates an operation like a device agent would, e.g.
     * `{ status: 'SUCCESSFUL' }` or `{ status: 'FAILED', failureReason }`.
     */
    update: (id: C8yIdInput, update: { status: C8yOperationStatus, failureReason?: string, [fragment: string]: unknown }) => void
  }
  externalIds: {
    /**
     * External ids, optionally of one managed object.
     */
    find: (managedObject?: C8yIdInput) => Array<{ type: string, externalId: string, managedObjectId: string }>
  }
  retentionRules: C8yDbCollection<Record<string, any>>
  /**
   * Audit records, seeded and written by API requests, in creation order.
   */
  auditRecords: C8yDbCollection<Record<string, any>>
  /**
   * Users by user name, as `GET /user/{tenantId}/users/{userId}` renders them.
   */
  users: C8yDbCollection<Record<string, any>> & {
    /**
     * Global roles of a user: its own and its groups' roles.
     */
    effectiveRoles: (userName: string) => string[]
  }
  /**
   * User groups by id, as the user API renders them.
   */
  groups: C8yDbCollection<Record<string, any>>
  /**
   * The tenant's global roles by name.
   */
  roles: C8yDbCollection<Record<string, any>>
  /**
   * Inventory roles by id.
   */
  inventoryRoles: C8yDbCollection<Record<string, any>>
  /**
   * Inventory assignments by id, each with the `user` it belongs to.
   */
  inventoryAssignments: C8yDbCollection<Record<string, any>>
  /**
   * Bulk operations as the API shows them (numeric `id`, live `progress`).
   */
  bulkOperations: C8yDbCollection<Record<string, any>>
  newDeviceRequests: C8yDbCollection<Record<string, any>> & {
    /**
     * Moves a request from WAITING_FOR_CONNECTION to PENDING_ACCEPTANCE, like
     * the device's first credentials poll does on the platform.
     */
    connect: (id: string) => void
  }
  /**
   * State of a service emulation (`world.service()`) in the tenant: one of
   * its stores (default: `'default'`), read-only.
   */
  serviceState: (service: string, store?: string) => Pick<C8yServiceStore, 'get' | 'list'>
  /**
   * The applications the tenant owns or is subscribed to, as the API shows
   * them, each with `subscribed`.
   */
  applications: C8yDbCollection<Record<string, any>>
  /**
   * The same views for another tenant's data.
   */
  tenant: (tenant: string) => Omit<C8yDb, 'tenant'>
}

/**
 * Views on one tenant's data.
 * @param tenant - Returns the tenant's data (looked up on every access)
 */
export function createDb(tenant: () => TenantData): Omit<C8yDb, 'tenant'> {
  return {
    managedObjects: collectionView(tenant, 'managedObjects'),
    measurements: collectionView(tenant, 'measurements'),
    events: {
      ...collectionView(tenant, 'events'),
      attachment: (id) => toContent(tenant().eventBinaries.get(resolveId(id))),
    },
    binaries: {
      get: (id) => {
        const document = collectionView(tenant, 'managedObjects').get(id)
        return document?.c8y_IsBinary !== undefined ? document : undefined
      },
      find: (filter) => collectionView(tenant, 'managedObjects').find(filter).filter((document) => document.c8y_IsBinary !== undefined),
      content: (id) => toContent(tenant().binaries.get(resolveId(id))),
    },
    alarms: collectionView(tenant, 'alarms'),
    operations: {
      ...collectionView(tenant, 'operations'),
      update(id, update) {
        const operation = tenant().operations.get(resolveId(id))
        if (!operation) {
          throw new TypeError(`world.db.operations.update(): no operation ${resolveId(id)}`)
        }
        const result = updateDocument(tenant(), RESOURCES.devicecontrol, operation, update)
        if (result instanceof Response) {
          throw new TypeError(`world.db.operations.update(): ${(result as Response & { message?: string }).message ?? result.status}`)
        }
      },
    },
    externalIds: {
      find: (managedObject) => [...tenant().externalIds.values()].filter((entry) => managedObject === undefined || entry.managedObjectId === resolveId(managedObject)).map((entry) => ({ ...entry })),
    },
    users: {
      ...renderedView(() => [...tenant().users.values()].map((user) => renderUser(tenant(), user))),
      effectiveRoles: (userName) => {
        const user = tenant().users.get(userName)
        return user ? effectiveRoles(tenant(), user) : []
      },
    },
    groups: renderedView(() => [...tenant().groups.values()].map((group) => renderGroup(tenant(), group))),
    roles: renderedView(() => [...tenant().roles.keys()].map((role) => renderRole(tenant(), role))),
    inventoryRoles: renderedView(() => [...tenant().inventoryRoles.values()].map((role) => renderInventoryRole(tenant(), role))),
    inventoryAssignments: renderedView(() => [...tenant().inventoryAssignments.values()].map((assignment) => ({ ...renderAssignment(tenant(), assignment), user: assignment.user }))),
    bulkOperations: {
      get: (id) => {
        const data = tenant()
        const bulk = data.bulkOperations.get(String(resolveId(id)))
        return bulk && renderBulkOperation(data, bulk)
      },
      find: (filter) => {
        const data = tenant()
        return filterDocuments([...data.bulkOperations.values()].map((bulk) => renderBulkOperation(data, bulk)), filter)
      },
    },
    newDeviceRequests: {
      get: (id) => {
        const data = tenant()
        const request = data.newDeviceRequests.get(resolveId(id))
        return request && renderNewDeviceRequest(data, request)
      },
      find: (filter) => {
        const data = tenant()
        return filterDocuments([...data.newDeviceRequests.values()].map((request) => renderNewDeviceRequest(data, request)), filter)
      },
      connect(id) {
        const request = tenant().newDeviceRequests.get(id)
        if (request?.status !== 'WAITING_FOR_CONNECTION') {
          throw new TypeError(`world.db.newDeviceRequests.connect(): no request ${id} waiting for connection`)
        }
        tenant().newDeviceRequests.set(id, { ...request, status: 'PENDING_ACCEPTANCE' })
      },
    },
    retentionRules: plainView(() => [...tenant().retentionRules.values()].map((rule) => ({ ...rule }))),
    applications: plainView(() => {
      const data = tenant()
      return visibleApplications(data).map((application) => ({ ...renderApplication(data, application), subscribed: data.applicationSubscriptions.has(application.id) }))
    }),
    auditRecords: plainView(() => {
      const data = tenant()
      return [...data.auditRecords.values()].map((record) => renderAuditRecord(data, record))
    }),
    serviceState: (service, store = 'default') => {
      const { get, list } = serviceStore(tenant, service, store)
      return { get, list }
    },
  }
}

function plainView(documents: () => Array<Record<string, any>>): C8yDbCollection<Record<string, any>> {
  return {
    get: (id) => documents().find((document) => document.id === resolveId(id)),
    find: (filter) => filterDocuments(documents(), filter),
  }
}

/**
 * A db view over rendered documents with string ids.
 * @param rendered - Renders all documents
 */
function renderedView(rendered: () => Array<Record<string, any>>): C8yDbCollection<Record<string, any>> {
  return {
    get: (id) => rendered().find((document) => String(document.id) === resolveId(id)),
    find: (filter) => filterDocuments(rendered(), filter),
  }
}
