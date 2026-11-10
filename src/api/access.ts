/**
 * Role enforcement (`createWorld({ roles: 'enforce' })`): what a caller may
 * do, checked against its global roles (own and from its groups), the
 * ownership of managed objects, and its inventory roles on a managed object
 * and its parents. docs/roles.md lists the rules and where each comes from.
 */
import type { C8yRequest } from '../types'
import type { StoredDocument, TenantData } from '../store'
import { generatedView } from '../generators'
import { apiError, sourceId } from './http'
import { parentIndex } from './inventory'
import { effectiveRoles } from './users'

export type AccessScope = 'MANAGED_OBJECT' | 'MEASUREMENT' | 'EVENT' | 'ALARM' | 'OPERATION' | 'AUDIT'
export type AccessLevel = 'READ' | 'ADMIN'

interface Permission {
  permission: string
  scope: string
  type: string
}

/**
 * A restricted caller: a user of the tenant, or a microservice's bootstrap
 * or service user.
 */
export interface Access {
  readonly user: string
  /**
   * A microservice's bootstrap or service user.
   */
  readonly application: boolean
  readonly roles: ReadonlySet<string>
  /**
   * Inventory permissions by managed object id (inventory roles and device
   * permissions of the user and its groups).
   */
  readonly assignments: ReadonlyMap<string, readonly Permission[]>
  /**
   * Resolved permissions per managed object (with its parents), per request.
   */
  readonly cache: Map<string, readonly Permission[]>
}

/**
 * The global roles that give a scope to all objects of the tenant.
 */
const GLOBAL: Record<AccessScope, Record<AccessLevel, readonly string[]>> = {
  MANAGED_OBJECT: { READ: ['ROLE_INVENTORY_READ', 'ROLE_MANAGED_OBJECT_READ'], ADMIN: ['ROLE_INVENTORY_ADMIN', 'ROLE_MANAGED_OBJECT_ADMIN'] },
  MEASUREMENT: { READ: ['ROLE_MEASUREMENT_READ'], ADMIN: ['ROLE_MEASUREMENT_ADMIN'] },
  EVENT: { READ: ['ROLE_EVENT_READ'], ADMIN: ['ROLE_EVENT_ADMIN'] },
  ALARM: { READ: ['ROLE_ALARM_READ'], ADMIN: ['ROLE_ALARM_ADMIN'] },
  OPERATION: { READ: ['ROLE_DEVICE_CONTROL_READ'], ADMIN: ['ROLE_DEVICE_CONTROL_ADMIN'] },
  AUDIT: { READ: ['ROLE_AUDIT_READ'], ADMIN: ['ROLE_AUDIT_ADMIN'] },
}

const CREATE_MANAGED_OBJECT = ['ROLE_INVENTORY_ADMIN', 'ROLE_INVENTORY_CREATE', 'ROLE_MANAGED_OBJECT_ADMIN', 'ROLE_MANAGED_OBJECT_CREATE']

/**
 * Builds the access of a stored user.
 * @param data - The user's tenant
 * @param user - The stored user
 */
export function userAccess(data: TenantData, user: Readonly<StoredDocument>): Access {
  const assignments = new Map<string, Permission[]>()
  const add = (id: string, permissions: Permission[]) => {
    assignments.set(id, [...assignments.get(id) ?? [], ...permissions])
  }
  for (const assignment of data.inventoryAssignments.values()) {
    if (assignment.user !== user.userName) {
      continue
    }
    for (const roleId of assignment.roles as string[]) {
      const role = data.inventoryRoles.get(roleId)
      add(String(assignment.managedObject), (role?.permissions as Permission[] | undefined) ?? [])
    }
  }
  // device permissions (`SCOPE:TYPE:PERMISSION`) of the user and its groups
  const holders = [user, ...(user.groups as string[] ?? []).map((id) => data.groups.get(id)).filter((group) => group !== undefined)]
  for (const holder of holders) {
    for (const [id, values] of Object.entries((holder.devicePermissions ?? {}) as Record<string, unknown>)) {
      if (Array.isArray(values)) {
        add(id, values.filter((value): value is string => typeof value === 'string').map((value) => {
          const [scope = '', type = '*', permission = ''] = value.split(':')
          return { scope, type, permission }
        }))
      }
    }
  }
  return { user: user.userName as string, application: false, roles: new Set(effectiveRoles(data, user)), assignments, cache: new Map() }
}

/**
 * Builds the access of a microservice's bootstrap user (`ROLE_SYSTEM`) or
 * service user (its required roles and `ROLE_SYSTEM`).
 * @param user - User name
 * @param roles - Its roles
 */
export function applicationAccess(user: string, roles: readonly string[]): Access {
  return { user, application: true, roles: new Set(roles), assignments: new Map(), cache: new Map() }
}

export function hasRole(access: Access, roles: readonly string[]): boolean {
  return roles.some((role) => access.roles.has(role))
}

/**
 * The inventory permissions on a managed object: assigned to it or to one of
 * its parents (asset and device parents, all the way up).
 * @param data - Tenant data
 * @param access - The caller
 * @param id - Managed object id
 */
function permissionsOn(data: TenantData, access: Access, id: string): readonly Permission[] {
  if (access.assignments.size === 0) {
    return []
  }
  const cached = access.cache.get(id)
  if (cached) {
    return cached
  }
  const index = parentIndex(data)
  const found: Permission[] = []
  const seen = new Set<string>()
  const queue = [id]
  while (queue.length > 0) {
    const node = queue.pop()!
    if (seen.has(node)) {
      continue
    }
    seen.add(node)
    found.push(...access.assignments.get(node) ?? [])
    for (const link of index.get(node) ?? []) {
      if (link.kind !== 'childAdditions') {
        queue.push(link.parent)
      }
    }
  }
  access.cache.set(id, found)
  return found
}

/**
 * Whether an inventory permission covers a scope, a level, and a document.
 * A permission with a type covers only documents with a fragment of that
 * name (verified for events). A typed operation permission (`c8y_Restart` of
 * the default role "Operations: Restart Device") allowed neither creating
 * nor reading such an operation on the platform, also on an agent that
 * supports it, so it covers nothing here either.
 * @param permission - The permission
 * @param scope - Scope
 * @param level - Level
 * @param document - The document (the managed object itself for `MANAGED_OBJECT`)
 */
function covers(permission: Permission, scope: AccessScope, level: AccessLevel, document: Readonly<Record<string, unknown>> | undefined): boolean {
  return (permission.scope === '*' || permission.scope === scope)
    && (permission.permission === '*' || permission.permission === level)
    && (permission.type === '*' || (scope !== 'OPERATION' && document !== undefined && Object.hasOwn(document, permission.type) && document[permission.type] !== undefined))
}

/**
 * Whether the caller's inventory roles allow a scope and level on a managed
 * object (not counting global roles or ownership).
 * @param data - Tenant data
 * @param access - The caller
 * @param id - Managed object id
 * @param scope - Scope
 * @param level - Level
 * @param document - The document the permission's type is matched against
 */
export function permitted(data: TenantData, access: Access, id: string, scope: AccessScope, level: AccessLevel, document?: Readonly<Record<string, unknown>>): boolean {
  return permissionsOn(data, access, id).some((permission) => covers(permission, scope, level, document))
}

export function owns(data: TenantData, access: Access, id: string | undefined): boolean {
  return id !== undefined && data.managedObjects.get(id)?.owner === access.user
}

/**
 * Whether the caller may read or change something of a managed object: a
 * global role, ownership of the object, or an inventory permission.
 * @param data - Tenant data
 * @param access - The caller
 * @param id - Managed object id (the source)
 * @param scope - Scope
 * @param level - Level
 * @param document - The document (for typed permissions); the managed object for `MANAGED_OBJECT`
 */
export function allowed(data: TenantData, access: Access, id: string | undefined, scope: AccessScope, level: AccessLevel, document?: Readonly<Record<string, unknown>>): boolean {
  if (hasRole(access, GLOBAL[scope][level])) {
    return true
  }
  if (id === undefined) {
    return false
  }
  return owns(data, access, id) || permitted(data, access, id, scope, level, scope === 'MANAGED_OBJECT' ? (document ?? data.managedObjects.get(id)) : document)
}

/**
 * Whether a list shows a document to the caller: a global read role, or
 * an inventory read permission on its source. Lists do not count ownership
 * (verified).
 * @param data - Tenant data
 * @param access - The caller
 * @param scope - Scope
 * @param document - The listed document
 */
export function listed(data: TenantData, access: Access, scope: AccessScope, document: Readonly<StoredDocument>): boolean {
  if (hasRole(access, GLOBAL[scope].READ)) {
    return true
  }
  const source = scope === 'OPERATION' ? document.deviceId as string | undefined : sourceId(document)
  return source !== undefined && permitted(data, access, source, scope, 'READ', document)
}

/**
 * Whether the inventory list shows a managed object: a global read role,
 * ownership, or an inventory read permission (verified).
 * @param data - Tenant data
 * @param access - The caller
 * @param document - Managed object
 */
export function listedManagedObject(data: TenantData, access: Access, document: Readonly<StoredDocument>): boolean {
  return hasRole(access, GLOBAL.MANAGED_OBJECT.READ) || document.owner === access.user || permitted(data, access, document.id, 'MANAGED_OBJECT', 'READ', document)
}

/**
 * Keeps the items the caller may see, or all of them for an unrestricted
 * caller. Restricted lists are filtered in full, then paged.
 * @param items - A (lazy) list
 * @param items.length
 * @param items.slice
 * @param keep - Whether an item is shown
 */
export function visible<T>(items: { readonly length: number, slice: (start: number, end: number) => readonly T[] }, keep: ((item: T) => boolean) | undefined): { readonly length: number, slice: (start: number, end: number) => readonly T[] } {
  return keep ? items.slice(0, items.length).filter(keep) : items
}

export function accessDenied(message: 'Access Denied' | 'Access is denied' = 'Access Denied'): Response {
  return apiError(403, 'security/Forbidden', message)
}

// ---------------------------------------------------------------------------
// the request check

type Check = (context: CheckContext) => boolean | Response

interface CheckContext {
  call: C8yRequest
  data: TenantData
  access: Access
  params: Record<string, string>
  segments: string[]
}

const roles = (...names: string[]): Check => ({ access }) => hasRole(access, names)
const open: Check = () => true

/**
 * The source of a body (`source.id`, or `deviceId` for operations).
 * @param body - Request body
 * @param field - `source` or `deviceId`
 */
function bodySource(body: unknown, field: 'source' | 'deviceId'): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined
  }
  const value = field === 'deviceId' ? (body as Record<string, unknown>).deviceId : ((body as Record<string, unknown>).source as { id?: unknown } | undefined)?.id
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

/**
 * A data write (POST): a global admin role, or ownership of or an inventory
 * admin permission on the source in the body.
 * @param scope - Scope
 * @param field - Where the body names the source
 */
function createOnSource(scope: AccessScope, field: 'source' | 'deviceId' = 'source'): Check {
  return ({ call, data, access }) => {
    if (hasRole(access, GLOBAL[scope].ADMIN)) {
      return true
    }
    const body = call.body as Record<string, unknown> | undefined
    // a measurement collection: every item must be allowed
    const items = scope === 'MEASUREMENT' && Array.isArray(body?.measurements) ? body.measurements as unknown[] : [body]
    return items.length > 0 && items.every((item) => {
      const source = bodySource(item, field)
      return source !== undefined && data.managedObjects.has(source) && allowed(data, access, source, scope, 'ADMIN', item as Record<string, unknown>)
    })
  }
}

type DocumentCollection = 'events' | 'alarms' | 'operations'

/**
 * A read or write of a stored document by id: the check of its source. An
 * unknown id passes, so the handler answers 404 like the platform.
 * @param collection - Where the document lives
 * @param scope - Scope
 * @param level - Level
 * @param param - Path parameter with the id
 */
function onDocument(collection: DocumentCollection, scope: AccessScope, level: AccessLevel, param = 'id'): Check {
  return ({ data, access, params }) => {
    if (hasRole(access, GLOBAL[scope][level])) {
      return true
    }
    const document = data[collection].get(params[param]!)
    if (!document) {
      return true
    }
    const source = collection === 'operations' ? document.deviceId as string | undefined : sourceId(document)
    return allowed(data, access, source, scope, level, document)
  }
}

/**
 * A request on a managed object by id: an unknown id passes (the handler
 * answers 404).
 * @param level - Level
 * @param param - Path parameter with the id
 */
function onManagedObject(level: AccessLevel, param = 'id'): Check {
  return ({ data, access, params }) => !data.managedObjects.has(params[param]!) || allowed(data, access, params[param], 'MANAGED_OBJECT', level)
}

/**
 * Identity: `ROLE_IDENTITY_*`, ownership of the object, or an inventory
 * permission on it; the global inventory roles do not count (verified).
 * @param level - Level
 * @param id - Managed object id
 * @param data - Tenant data
 * @param access - The caller
 */
function identityAllowed(level: AccessLevel, id: string, data: TenantData, access: Access): boolean {
  return hasRole(access, [level === 'READ' ? 'ROLE_IDENTITY_READ' : 'ROLE_IDENTITY_ADMIN'])
    || owns(data, access, id)
    || permitted(data, access, id, 'MANAGED_OBJECT', level, data.managedObjects.get(id))
}

/**
 * A list of measurements, events, alarms, or operations: a global read
 * role, or any inventory assignment (the list then shows what the caller may
 * read). Without either it answers 403 `Access is denied` (verified).
 * @param scope - Scope
 */
function dataList(scope: AccessScope): Check {
  return ({ access }) => hasRole(access, GLOBAL[scope].READ) || access.assignments.size > 0 || accessDenied('Access is denied')
}

/**
 * Child references: adding needs admin rights on the parent and on the child
 * (or a global admin role); a new child also needs a create role.
 * @param root0
 * @param root0.call
 * @param root0.data
 * @param root0.access
 * @param root0.params
 */
const addChild: Check = ({ call, data, access, params }) => {
  if (hasRole(access, GLOBAL.MANAGED_OBJECT.ADMIN)) {
    return true
  }
  if (!data.managedObjects.has(params.id!)) {
    return true
  }
  if (!allowed(data, access, params.id, 'MANAGED_OBJECT', 'ADMIN')) {
    return false
  }
  const body = (call.body ?? {}) as Record<string, unknown>
  const references = Array.isArray((body as { references?: unknown }).references) ? (body.references as Array<Record<string, unknown>>) : [body]
  return references.every((reference) => {
    const child = (reference.managedObject as { id?: unknown } | undefined)?.id
    if (child === undefined) {
      // a new child object
      return hasRole(access, CREATE_MANAGED_OBJECT)
    }
    return !data.managedObjects.has(String(child)) || allowed(data, access, String(child), 'MANAGED_OBJECT', 'ADMIN')
  })
}

/**
 * Removing a child reference: a global admin role, ownership of the parent
 * or of the child, or an inventory admin permission on the parent.
 * @param root0
 * @param root0.data
 * @param root0.access
 * @param root0.params
 */
const removeChild: Check = ({ data, access, params }) =>
  !data.managedObjects.has(params.id!)
  || allowed(data, access, params.id, 'MANAGED_OBJECT', 'ADMIN')
  || (params.childId !== undefined && owns(data, access, params.childId))

/**
 * Whether a user is a subuser of another one (directly or further down).
 * @param data - Tenant data
 * @param userName - The user
 * @param ancestor - The possible owner
 */
function descendantOf(data: TenantData, userName: string, ancestor: string): boolean {
  const seen = new Set<string>()
  let current = data.users.get(userName)?.owner
  while (typeof current === 'string' && current !== '' && !seen.has(current)) {
    if (current === ancestor) {
      return true
    }
    seen.add(current)
    current = data.users.get(current)?.owner
  }
  return false
}

/**
 * User management: one of `roles`, or `ROLE_USER_MANAGEMENT_CREATE` for the
 * caller's own subusers (and the caller itself, when `self` is set).
 * @param names - Roles that allow the request for every user
 * @param self - Whether the caller itself is allowed with the create role
 */
function onUser(names: string[], self = false): Check {
  return ({ data, access, params }) => {
    if (hasRole(access, names)) {
      return true
    }
    if (!access.roles.has('ROLE_USER_MANAGEMENT_CREATE')) {
      return false
    }
    const userName = params.userId ?? params.username ?? ''
    return (self && userName === access.user) || descendantOf(data, userName, access.user)
  }
}

const USER_READ = ['ROLE_USER_MANAGEMENT_READ']
const USER_ADMIN = ['ROLE_USER_MANAGEMENT_ADMIN']
const USER_READ_OR_CREATE = roles('ROLE_USER_MANAGEMENT_READ', 'ROLE_USER_MANAGEMENT_CREATE')
const USER_ADMIN_OR_CREATE = roles('ROLE_USER_MANAGEMENT_ADMIN', 'ROLE_USER_MANAGEMENT_CREATE')
const TENANT_ADMIN = roles('ROLE_TENANT_MANAGEMENT_ADMIN', 'ROLE_TENANT_ADMIN')
const TENANT_READ = roles('ROLE_TENANT_MANAGEMENT_ADMIN', 'ROLE_TENANT_ADMIN', 'ROLE_TENANT_MANAGEMENT_READ')
const LOGIN_OPTION_READ = roles('ROLE_TENANT_ADMIN', 'ROLE_TENANT_MANAGEMENT_READ', 'ROLE_TENANT_MANAGEMENT_ADMIN', 'ROLE_USER_MANAGEMENT_ADMIN', 'ROLE_USER_MANAGEMENT_CREATE')

// The rules by endpoint. An endpoint without a rule is not checked. Lists
// that filter instead of answering 403 (inventory, alarm count, audit,
// binaries) are `open` here and filter in their handlers (`visible()`).
const RULES: Array<[string, Check]> = [
  // inventory
  ['GET /inventory/managedObjects', ({ access }) => !access.application || hasRole(access, GLOBAL.MANAGED_OBJECT.READ) || accessDenied('Access is denied')],
  ['GET /inventory/managedObjects/count', ({ access }) => !access.application || hasRole(access, GLOBAL.MANAGED_OBJECT.READ) || accessDenied('Access is denied')],
  ['POST /inventory/managedObjects', roles(...CREATE_MANAGED_OBJECT)],
  ['PUT /inventory/managedObjects', roles(...GLOBAL.MANAGED_OBJECT.ADMIN)],
  ['GET /inventory/managedObjects/{id}', onManagedObject('READ')],
  ['PUT /inventory/managedObjects/{id}', onManagedObject('ADMIN')],
  ['DELETE /inventory/managedObjects/{id}', onManagedObject('ADMIN')],
  ['GET /inventory/managedObjects/{id}/availability', onManagedObject('READ')],
  ['GET /inventory/managedObjects/{id}/supportedMeasurements', onManagedObject('READ')],
  ['GET /inventory/managedObjects/{id}/supportedSeries', onManagedObject('READ')],
  ['GET /inventory/managedObjects/{id}/user', onManagedObject('READ')],
  ['PUT /inventory/managedObjects/{id}/user', onManagedObject('ADMIN')],
  ...(['childDevices', 'childAssets', 'childAdditions'] as const).flatMap((kind): Array<[string, Check]> => [
    [`GET /inventory/managedObjects/{id}/${kind}`, onManagedObject('READ')],
    [`GET /inventory/managedObjects/{id}/${kind}/{childId}`, onManagedObject('READ')],
    [`POST /inventory/managedObjects/{id}/${kind}`, addChild],
    [`DELETE /inventory/managedObjects/{id}/${kind}`, removeChild],
    [`DELETE /inventory/managedObjects/{id}/${kind}/{childId}`, removeChild],
  ]),
  // binaries: the list filters
  ['GET /inventory/binaries', open],
  ['POST /inventory/binaries', roles('ROLE_INVENTORY_ADMIN', 'ROLE_INVENTORY_CREATE', 'ROLE_BINARY_ADMIN', 'ROLE_BINARY_CREATE')],
  ['GET /inventory/binaries/{id}', ({ data, access, params }) => !data.managedObjects.has(params.id!) || hasRole(access, ['ROLE_BINARY_READ']) || allowed(data, access, params.id, 'MANAGED_OBJECT', 'READ')],
  ['PUT /inventory/binaries/{id}', ({ data, access, params }) => !data.managedObjects.has(params.id!) || hasRole(access, ['ROLE_BINARY_ADMIN']) || allowed(data, access, params.id, 'MANAGED_OBJECT', 'ADMIN')],
  ['DELETE /inventory/binaries/{id}', ({ data, access, params }) => !data.managedObjects.has(params.id!) || hasRole(access, ['ROLE_BINARY_ADMIN']) || allowed(data, access, params.id, 'MANAGED_OBJECT', 'ADMIN')],
  // identity
  ['GET /identity/globalIds/{id}/externalIds', ({ data, access, params }) => !data.managedObjects.has(params.id!) || identityAllowed('READ', params.id!, data, access)],
  ['POST /identity/globalIds/{id}/externalIds', ({ data, access, params }) => hasRole(access, ['ROLE_IDENTITY_ADMIN']) || (data.managedObjects.has(params.id!) && identityAllowed('ADMIN', params.id!, data, access))],
  ['GET /identity/externalIds/{type}/{externalId}', ({ data, access, params }) => externalIdCheck(data, access, params, 'READ')],
  ['DELETE /identity/externalIds/{type}/{externalId}', ({ data, access, params }) => externalIdCheck(data, access, params, 'ADMIN')],
  ['POST /identity/search', roles('ROLE_IDENTITY_READ')],
  // measurements
  ['GET /measurement/measurements', dataList('MEASUREMENT')],
  ['POST /measurement/measurements', createOnSource('MEASUREMENT')],
  ['DELETE /measurement/measurements', roles('ROLE_MEASUREMENT_ADMIN')],
  ['DELETE /measurement/measurements/{id}', ({ data, access, params }) => {
    if (hasRole(access, GLOBAL.MEASUREMENT.ADMIN)) {
      return true
    }
    const document = data.measurements.get(params.id!) ?? generatedView(data)?.get(params.id!)
    return !document || allowed(data, access, sourceId(document), 'MEASUREMENT', 'ADMIN', document)
  }],
  ['GET /measurement/measurements/series', ({ call, data, access }) => allowed(data, access, call.query.source, 'MEASUREMENT', 'READ')],
  // events
  ['GET /event/events', dataList('EVENT')],
  ['POST /event/events', createOnSource('EVENT')],
  ['DELETE /event/events', roles('ROLE_EVENT_ADMIN')],
  ['GET /event/events/{id}', onDocument('events', 'EVENT', 'READ')],
  ['PUT /event/events/{id}', onDocument('events', 'EVENT', 'ADMIN')],
  ['DELETE /event/events/{id}', onDocument('events', 'EVENT', 'ADMIN')],
  ['GET /event/events/{id}/binaries', onDocument('events', 'EVENT', 'READ')],
  ['POST /event/events/{id}/binaries', onDocument('events', 'EVENT', 'ADMIN')],
  ['PUT /event/events/{id}/binaries', onDocument('events', 'EVENT', 'ADMIN')],
  ['DELETE /event/events/{id}/binaries', onDocument('events', 'EVENT', 'ADMIN')],
  // alarms: the count filters
  ['GET /alarm/alarms', dataList('ALARM')],
  ['GET /alarm/alarms/count', open],
  ['POST /alarm/alarms', createOnSource('ALARM')],
  ['POST /alarm/alarms/upsert', createOnSource('ALARM')],
  ['PUT /alarm/alarms', roles('ROLE_ALARM_ADMIN')],
  ['DELETE /alarm/alarms', roles('ROLE_ALARM_ADMIN')],
  ['GET /alarm/alarms/{id}', onDocument('alarms', 'ALARM', 'READ')],
  ['PUT /alarm/alarms/{id}', onDocument('alarms', 'ALARM', 'ADMIN')],
  // operations
  ['GET /devicecontrol/operations', dataList('OPERATION')],
  ['POST /devicecontrol/operations', createOnSource('OPERATION', 'deviceId')],
  ['DELETE /devicecontrol/operations', roles('ROLE_DEVICE_CONTROL_ADMIN')],
  ['GET /devicecontrol/operations/{id}', onDocument('operations', 'OPERATION', 'READ')],
  ['PUT /devicecontrol/operations/{id}', onDocument('operations', 'OPERATION', 'ADMIN')],
  // bulk operations, device registration
  ['GET /devicecontrol/bulkoperations', roles('ROLE_BULK_OPERATION_READ')],
  ['GET /devicecontrol/bulkoperations/{id}', roles('ROLE_BULK_OPERATION_READ')],
  ['POST /devicecontrol/bulkoperations', roles('ROLE_BULK_OPERATION_ADMIN')],
  ['PUT /devicecontrol/bulkoperations/{id}', roles('ROLE_BULK_OPERATION_ADMIN')],
  ['DELETE /devicecontrol/bulkoperations/{id}', roles('ROLE_BULK_OPERATION_ADMIN')],
  ['GET /devicecontrol/newDeviceRequests', roles('ROLE_DEVICE_CONTROL_READ')],
  ['GET /devicecontrol/newDeviceRequests/{requestId}', roles('ROLE_DEVICE_CONTROL_READ')],
  ['POST /devicecontrol/newDeviceRequests', roles('ROLE_DEVICE_CONTROL_ADMIN')],
  ['POST /devicecontrol/bulkNewDeviceRequests', roles('ROLE_DEVICE_CONTROL_ADMIN')],
  ['PUT /devicecontrol/newDeviceRequests/{requestId}', roles('ROLE_DEVICE_CONTROL_ADMIN')],
  ['DELETE /devicecontrol/newDeviceRequests/{requestId}', roles('ROLE_DEVICE_CONTROL_ADMIN', 'ROLE_USER_MANAGEMENT_ADMIN')],
  // audit: the list filters
  ['GET /audit/auditRecords', open],
  ['GET /audit/auditRecords/{id}', ({ data, access, params }) => {
    if (hasRole(access, GLOBAL.AUDIT.READ)) {
      return true
    }
    const record = data.auditRecords.get(params.id!)
    return !record || listed(data, access, 'AUDIT', record)
  }],
  ['POST /audit/auditRecords', ({ call, data, access }) => {
    if (hasRole(access, [...GLOBAL.AUDIT.ADMIN, 'ROLE_SYSTEM'])) {
      return true
    }
    const source = bodySource(call.body, 'source')
    return source !== undefined && permitted(data, access, source, 'AUDIT', 'ADMIN', call.body as Record<string, unknown>)
  }],
  // tenant options, retention rules, Notification 2.0
  ['GET /tenant/options', roles('ROLE_OPTION_MANAGEMENT_READ')],
  ['GET /tenant/options/{category}', roles('ROLE_OPTION_MANAGEMENT_READ')],
  ['GET /tenant/options/{category}/{key}', roles('ROLE_OPTION_MANAGEMENT_READ')],
  ['POST /tenant/options', roles('ROLE_OPTION_MANAGEMENT_ADMIN')],
  ['PUT /tenant/options/{category}', roles('ROLE_OPTION_MANAGEMENT_ADMIN')],
  ['PUT /tenant/options/{category}/{key}', roles('ROLE_OPTION_MANAGEMENT_ADMIN')],
  ['DELETE /tenant/options/{category}/{key}', roles('ROLE_OPTION_MANAGEMENT_ADMIN')],
  ['PUT /tenant/options/{category}/{key}/editable', roles('ROLE_OPTION_MANAGEMENT_ADMIN')],
  ['GET /tenant/system/options', open],
  ['GET /tenant/system/options/{category}/{key}', roles('ROLE_OPTION_MANAGEMENT_ADMIN')],
  ['GET /retention/retentions', roles('ROLE_RETENTION_RULE_READ')],
  ['GET /retention/retentions/{id}', roles('ROLE_RETENTION_RULE_READ')],
  ['POST /retention/retentions', roles('ROLE_RETENTION_RULE_ADMIN')],
  ['PUT /retention/retentions/{id}', roles('ROLE_RETENTION_RULE_ADMIN')],
  ['DELETE /retention/retentions/{id}', roles('ROLE_RETENTION_RULE_ADMIN')],
  ['POST /notification2/unsubscribe', open],
  ['GET /notification2/subscriptions', roles('ROLE_NOTIFICATION_2_ADMIN')],
  ['GET /notification2/subscriptions/{id}', roles('ROLE_NOTIFICATION_2_ADMIN')],
  ['POST /notification2/subscriptions', roles('ROLE_NOTIFICATION_2_ADMIN')],
  ['DELETE /notification2/subscriptions', roles('ROLE_NOTIFICATION_2_ADMIN')],
  ['DELETE /notification2/subscriptions/{id}', roles('ROLE_NOTIFICATION_2_ADMIN')],
  ['POST /notification2/token', roles('ROLE_NOTIFICATION_2_ADMIN')],
  // tenant
  ['GET /tenant/currentTenant', open],
  ['GET /tenant/statistics', roles('ROLE_TENANT_STATISTICS_READ')],
  ['GET /tenant/statistics/summary', roles('ROLE_TENANT_STATISTICS_READ', ...GLOBAL.MANAGED_OBJECT.READ)],
  ['GET /tenant/statistics/allTenantsSummary', roles('ROLE_TENANT_MANAGEMENT_READ')],
  ['GET /tenant/statistics/device/{tenantId}/daily/{date}', roles('ROLE_TENANT_STATISTICS_READ')],
  ['GET /tenant/statistics/device/{tenantId}/monthly/{date}', roles('ROLE_TENANT_STATISTICS_READ')],
  ['GET /tenant/statistics/files', roles('ROLE_TENANT_MANAGEMENT_ADMIN')],
  ['GET /tenant/statistics/files/{id}', roles('ROLE_TENANT_MANAGEMENT_ADMIN')],
  ['GET /tenant/statistics/files/latest/{month}', roles('ROLE_TENANT_MANAGEMENT_ADMIN')],
  ['GET /tenant/tenants', roles('ROLE_TENANT_MANAGEMENT_READ')],
  ['GET /tenant/tenants/{tenantId}', roles('ROLE_TENANT_MANAGEMENT_READ')],
  ['GET /tenant/tenants/{tenantId}/tfa', roles('ROLE_TENANT_MANAGEMENT_READ', 'ROLE_USER_MANAGEMENT_READ', 'ROLE_USER_MANAGEMENT_OWN_READ')],
  ['GET /tenant/tenants/{tenantId}/applications/restricted-roles', roles('ROLE_TENANT_MANAGEMENT_READ', 'ROLE_TENANT_ADMIN')],
  ['GET /tenant/tenants/{tenantId}/trusted-certificates', TENANT_READ],
  ['GET /tenant/tenants/{tenantId}/trusted-certificates/{fingerprint}', TENANT_READ],
  ['GET /tenant/trusted-certificates/settings/crl', TENANT_READ],
  ['POST /tenant/tenants/{tenantId}/trusted-certificates', TENANT_ADMIN],
  ['GET /tenant/loginOptions', open],
  ['GET /tenant/loginOptions/{typeOrId}', LOGIN_OPTION_READ],
  ['GET /tenant/loginOptions/{typeOrId}/accessMappings', LOGIN_OPTION_READ],
  ['GET /tenant/loginOptions/{typeOrId}/accessMappings/{id}', LOGIN_OPTION_READ],
  ['GET /tenant/loginOptions/{typeOrId}/inventoryAccessMappings', LOGIN_OPTION_READ],
  ['GET /tenant/loginOptions/{typeOrId}/inventoryAccessMappings/{id}', LOGIN_OPTION_READ],
  ['GET /tenant/tenants/{tenantId}/applications', roles('ROLE_TENANT_MANAGEMENT_READ', 'ROLE_TENANT_ADMIN')],
  ['POST /tenant/tenants/{tenantId}/applications', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN', 'ROLE_TENANT_MANAGEMENT_ADMIN', 'ROLE_TENANT_MANAGEMENT_UPDATE')],
  ['DELETE /tenant/tenants/{tenantId}/applications/{applicationId}', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN', 'ROLE_TENANT_MANAGEMENT_ADMIN', 'ROLE_TENANT_MANAGEMENT_UPDATE')],
  // applications
  ['GET /application/applications', roles('ROLE_APPLICATION_MANAGEMENT_READ')],
  ['GET /application/applications/{id}', ({ access }) => hasRole(access, ['ROLE_APPLICATION_MANAGEMENT_READ']) || accessDenied('Access is denied')],
  ['GET /application/applicationsByName/{name}', roles('ROLE_APPLICATION_MANAGEMENT_READ')],
  ['GET /application/applicationsByTenant/{tenantId}', roles('ROLE_APPLICATION_MANAGEMENT_READ')],
  ['GET /application/applicationsByOwner/{tenantId}', roles('ROLE_APPLICATION_MANAGEMENT_READ')],
  ['GET /application/applicationsByUser/{username}', ({ access, params }) => (access.roles.has('ROLE_USER_MANAGEMENT_OWN_READ') && params.username === access.user) || (access.roles.has('ROLE_USER_MANAGEMENT_READ') && access.roles.has('ROLE_APPLICATION_MANAGEMENT_READ'))],
  ['GET /application/applications/{id}/versions', roles('ROLE_APPLICATION_MANAGEMENT_READ')],
  ['GET /application/applications/{id}/binaries', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['GET /application/applications/{id}/bootstrapUser', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['POST /application/applications', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['POST /application/applications/{id}/clone', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['POST /application/applications/{id}/binaries', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['POST /application/applications/{id}/versions', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['PUT /application/applications/{id}', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['PUT /application/applications/{id}/authType', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['PUT /application/applications/{id}/versions/{version}', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['DELETE /application/applications/{id}', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['DELETE /application/applications/{id}/binaries/{binaryId}', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  ['DELETE /application/applications/{id}/versions', roles('ROLE_APPLICATION_MANAGEMENT_ADMIN')],
  // users, groups, roles
  ['GET /user/roles', USER_READ_OR_CREATE],
  ['GET /user/roles/{name}', USER_READ_OR_CREATE],
  ['GET /user/inventoryroles', USER_READ_OR_CREATE],
  ['GET /user/inventoryroles/{id}', USER_READ_OR_CREATE],
  ['POST /user/inventoryroles', roles(...USER_ADMIN)],
  ['PUT /user/inventoryroles/{id}', roles(...USER_ADMIN)],
  ['DELETE /user/inventoryroles/{id}', roles(...USER_ADMIN)],
  ['GET /user/devicePermissions/{id}', USER_READ_OR_CREATE],
  ['PUT /user/devicePermissions/{id}', USER_ADMIN_OR_CREATE],
  ['GET /user/{tenantId}/users', USER_READ_OR_CREATE],
  ['POST /user/{tenantId}/users', USER_ADMIN_OR_CREATE],
  ['GET /user/{tenantId}/users/{userId}', onUser(USER_READ, true)],
  ['PUT /user/{tenantId}/users/{userId}', onUser(USER_ADMIN)],
  ['DELETE /user/{tenantId}/users/{userId}', ({ access, params, ...rest }) => params.userId !== access.user || hasRole(access, USER_ADMIN) ? onUser(USER_ADMIN)({ access, params, ...rest }) : false],
  ['GET /user/{tenantId}/userByName/{username}', onUser(USER_READ)],
  ['GET /user/{tenantId}/users/{userId}/tfa', ({ access, params, ...rest }) => params.userId === access.user || onUser(USER_READ)({ access, params, ...rest })],
  ['GET /user/{tenantId}/users/{userId}/groups', onUser(USER_READ)],
  ['GET /user/{tenantId}/users/{userId}/roles', roles(...USER_READ)],
  ['POST /user/{tenantId}/users/{userId}/roles', onUser(USER_ADMIN)],
  ['DELETE /user/{tenantId}/users/{userId}/roles/{roleId}', onUser(USER_ADMIN)],
  ['GET /user/{tenantId}/users/{userId}/roles/inventory', onUser(USER_READ)],
  ['GET /user/{tenantId}/users/{userId}/roles/inventory/{id}', onUser(USER_READ)],
  ['POST /user/{tenantId}/users/{userId}/roles/inventory', onUser(USER_ADMIN)],
  ['PUT /user/{tenantId}/users/{userId}/roles/inventory/{id}', onUser(USER_ADMIN)],
  ['DELETE /user/{tenantId}/users/{userId}/roles/inventory/{id}', onUser(USER_ADMIN)],
  ['GET /user/{tenantId}/groups', USER_READ_OR_CREATE],
  ['GET /user/{tenantId}/groupByName/{groupName}', USER_READ_OR_CREATE],
  ['POST /user/{tenantId}/groups', USER_ADMIN_OR_CREATE],
  ['GET /user/{tenantId}/groups/{groupId}', roles(...USER_READ)],
  ['PUT /user/{tenantId}/groups/{groupId}', roles(...USER_ADMIN)],
  ['DELETE /user/{tenantId}/groups/{groupId}', roles(...USER_ADMIN)],
  ['GET /user/{tenantId}/groups/{groupId}/roles', roles(...USER_READ)],
  ['POST /user/{tenantId}/groups/{groupId}/roles', roles(...USER_ADMIN)],
  ['DELETE /user/{tenantId}/groups/{groupId}/roles/{roleId}', roles(...USER_ADMIN)],
  ['GET /user/{tenantId}/groups/{groupId}/users', USER_READ_OR_CREATE],
  ['POST /user/{tenantId}/groups/{groupId}/users', USER_ADMIN_OR_CREATE],
  ['DELETE /user/{tenantId}/groups/{groupId}/users/{userId}', USER_ADMIN_OR_CREATE],
  ['PUT /user/currentUser', roles('ROLE_USER_MANAGEMENT_OWN_ADMIN')],
  ['PUT /user/currentUser/password', roles('ROLE_USER_MANAGEMENT_OWN_ADMIN')],
  ['POST /user/logout', open],
  ['POST /user/logout/{tenantId}/allUsers', roles(...USER_ADMIN)],
]

/**
 * The external id's managed object decides; an unknown external id passes
 * (verified: 404 also without roles).
 * @param data - Tenant data
 * @param access - The caller
 * @param params - Path parameters
 * @param level - Level
 */
function externalIdCheck(data: TenantData, access: Access, params: Record<string, string>, level: AccessLevel): boolean {
  if (hasRole(access, [level === 'READ' ? 'ROLE_IDENTITY_READ' : 'ROLE_IDENTITY_ADMIN'])) {
    return true
  }
  const entry = data.externalIds.get(`${params.type}\u0000${params.externalId}`)
  return !entry || identityAllowed(level, entry.managedObjectId, data, access)
}

interface CompiledRule {
  method: string
  parts: Array<{ literal: string } | { param: string }>
  literals: number
  check: Check
}

const COMPILED: CompiledRule[] = RULES.map(([endpoint, check]) => {
  const [method, template] = endpoint.split(' ') as [string, string]
  const parts = template.split('/').filter(Boolean).map((part) => part.startsWith('{') ? { param: part.slice(1, -1) } : { literal: part })
  return { method, parts, literals: parts.filter((part) => 'literal' in part).length, check }
})

/**
 * The rule of a request: the matching endpoint with the most literal path
 * segments, with its path parameters.
 * @param method - Request method
 * @param segments - Decoded path segments
 */
function ruleOf(method: string, segments: readonly string[]): { rule: CompiledRule, params: Record<string, string> } | undefined {
  let best: { rule: CompiledRule, params: Record<string, string> } | undefined
  for (const rule of COMPILED) {
    if (rule.method !== method || rule.parts.length !== segments.length || (best && best.rule.literals >= rule.literals)) {
      continue
    }
    const params: Record<string, string> = {}
    const matches = rule.parts.every((part, i) => {
      if ('literal' in part) {
        return part.literal === segments[i]
      }
      params[part.param] = segments[i]!
      return true
    })
    if (matches) {
      best = { rule, params }
    }
  }
  return best
}

/**
 * Checks a request against the caller's rights before a handler answers it.
 * @param call - The request
 * @param segments - Decoded path segments
 * @param data - Data of the caller's tenant
 * @param access - The caller
 * @returns 403 like the platform, or `undefined` when the request may go on
 */
export function authorize(call: C8yRequest, segments: string[], data: TenantData, access: Access): Response | undefined {
  const match = ruleOf(call.method, segments)
  if (!match) {
    return undefined
  }
  const result = match.rule.check({ call, data, access, params: match.params, segments })
  if (result === true) {
    return undefined
  }
  return result === false ? accessDenied() : result
}
