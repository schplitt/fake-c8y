import { renderedAvailability, scheduleAvailability } from '../availability'
import type { C8yRequest } from '../types'
import type { ChildKind, Relations, StoredDocument, TenantData } from '../store'
import type { Collection } from '../collection'
import { auditAvailability, auditManagedObjectDeleted } from './audit'
import { addChild, CHILD_KINDS, childIds, deleteManagedObject, descendants, externalIdKey, externalIdsByObject, PARENT_KIND, removeChild } from '../store'
import { addExternalId } from './identity'
import { apiError, checkQuery, flag, paged, raw, sourceId } from './http'
import { clone, invalidTimeMessage, normalizeIsoTime, parseIsoTime } from '../utils'
import { generatedView } from '../generators'
import { applyOrderBy, parseQuery, QuerySyntaxError } from './query'
import { deleteUser } from './users'
import { matchesText, parseTextSearch } from './text-search'
import { recordTraffic } from './data'
import { listedManagedObject, visible } from './access'

const SERVER_FIELDS = ['id', 'self', 'creationTime', 'lastUpdated', ...CHILD_KINDS, ...Object.values(PARENT_KIND)]

export function moSelf(data: TenantData, id: string): string {
  return `${data.world.baseUrl}/inventory/managedObjects/${id}`
}

export function notFound(id: string): Response {
  return apiError(404, 'inventory/Not Found', `Finding device data from database failed : No managedObject for id '${id}'!`)
}

interface ParentLink {
  parent: string
  kind: ChildKind
}

/**
 * Child id to its direct parents (with the kind of the link), in the order of
 * the parents in the children collection, then by kind.
 */
interface ParentIndex {
  get: (child: string) => readonly ParentLink[] | undefined
}

const parentCache = new WeakMap<Collection<Relations>, { version: number, index: ParentIndex }>()

/**
 * Child id to its direct parents (with the kind of the link), for walking up a
 * hierarchy without scanning every relation per step. Cached per children
 * collection and version: a frozen base builds it once, and a fork layers the
 * relations it wrote on top of its base's index.
 * @param data - Tenant data
 */
export function parentIndex(data: TenantData): ParentIndex {
  return parentIndexOf(data.children)
}

function parentIndexOf(children: Collection<Relations>): ParentIndex {
  const cached = parentCache.get(children)
  if (cached && cached.version === children.version) {
    return cached.index
  }
  const base = children.base
  const index = !base ? linksOf(children, children.keys()) : children.pristine ? parentIndexOf(base) : forkedParentIndex(children, parentIndexOf(base))
  parentCache.set(children, { version: children.version, index })
  return index
}

/**
 * The parent links of the given parents' relations.
 * @param children - The children collection
 * @param parents - Parent ids, in collection order
 */
function linksOf(children: Collection<Relations>, parents: Iterable<string>): Map<string, ParentLink[]> {
  const index = new Map<string, ParentLink[]>()
  for (const parent of parents) {
    const relations = children.get(parent)
    if (!relations) {
      continue
    }
    for (const kind of CHILD_KINDS) {
      for (const child of relations[kind]) {
        const links = index.get(child)
        if (links) {
          links.push({ parent, kind })
        } else {
          index.set(child, [{ parent, kind }])
        }
      }
    }
  }
  return index
}

/**
 * A fork's parent index: its base's index, with the links of the parents the
 * fork wrote replaced by their current relations.
 * @param children - The fork's children collection
 * @param inBase - The base's parent index
 */
function forkedParentIndex(children: Collection<Relations>, inBase: ParentIndex): ParentIndex {
  const base = children.base!
  const written = children.ownKeys()
  const own = linksOf(children, children.inOrder(written))
  const affected = new Set(own.keys())
  for (const parent of written) {
    for (const kind of CHILD_KINDS) {
      for (const child of base.get(parent)?.[kind] ?? []) {
        affected.add(child)
      }
    }
  }
  const overlay = new Map<string, readonly ParentLink[]>()
  for (const child of affected) {
    const links = [...(inBase.get(child) ?? []).filter((link) => !written.has(link.parent)), ...own.get(child) ?? []]
    // by parent position (stable: the kinds of one parent keep their order)
    const positions = new Map(links.map((link) => [link.parent, children.position(link.parent)!]))
    links.sort((a, b) => positions.get(a.parent)! - positions.get(b.parent)!)
    overlay.set(child, links)
  }
  return { get: (child) => overlay.has(child) ? (overlay.get(child)!.length > 0 ? overlay.get(child) : undefined) : inBase.get(child) }
}

const PARENT_ORDER: ChildKind[] = ['childAssets', 'childDevices', 'childAdditions']

/**
 * All ancestors of an object over links of every kind, the way the platform
 * lists them (verified): depth first, each parent's own ancestors before it,
 * asset parents before device parents. An ancestor is listed under the kind
 * of every link that leads down from it, so it can appear in `assetParents`
 * and in `deviceParents`, but only once per kind.
 * @param index - Parent index
 * @param id - Managed object id
 */
function ancestors(index: ParentIndex, id: string): Array<{ id: string, kind: ChildKind }> {
  const found: Array<{ id: string, kind: ChildKind }> = []
  const listed = new Set<string>()
  const expanded = new Set([id])
  const visit = (node: string) => {
    const parents = [...index.get(node) ?? []].sort((a, b) => PARENT_ORDER.indexOf(a.kind) - PARENT_ORDER.indexOf(b.kind))
    for (const { parent, kind } of parents) {
      if (!expanded.has(parent)) {
        expanded.add(parent)
        visit(parent)
      }
      if (parent !== id && !listed.has(`${kind} ${parent}`)) {
        listed.add(`${kind} ${parent}`)
        found.push({ id: parent, kind })
      }
    }
  }
  visit(id)
  return found
}

/**
 * The fields the platform puts first, in its order; fragments follow.
 */
const STANDARD_ORDER = ['self', 'id', 'type', 'name', 'lastUpdated', 'creationTime', 'owner']

/**
 * A parent as the platform lists it in `assetParents` etc. (verified): only
 * `self`, `id`, `type` (not for `withGroups`), `name`, and empty relations.
 * @param data
 * @param parent
 * @param withType
 */
function basicManagedObject(data: TenantData, parent: StoredDocument, withType: boolean): StoredDocument {
  const self = moSelf(data, parent.id)
  const rendered: StoredDocument = { self, id: parent.id } as StoredDocument
  if (withType && parent.type !== undefined) {
    rendered.type = parent.type
  }
  if (parent.name !== undefined) {
    rendered.name = parent.name
  }
  for (const kind of CHILD_KINDS) {
    rendered[kind] = { self: `${self}/${kind}`, references: [] }
  }
  for (const kind of CHILD_KINDS) {
    rendered[PARENT_KIND[kind]] = { references: [] }
  }
  return rendered
}

export interface RenderOptions {
  /**
   * Include child references (default true)
   */
  withChildren?: boolean
  /**
   * Omit names in child references
   */
  skipChildrenNames?: boolean
  /**
   * Fill the parent references with all ancestors
   */
  withParents?: boolean
  /**
   * Add the group parents (direct asset parents with `c8y_IsDeviceGroup`) to `assetParents`
   */
  withGroups?: boolean
  /**
   * Add `count` to child collections that are not empty
   */
  withChildrenCount?: boolean
  /**
   * Parent index to reuse across a list
   */
  parents?: ParentIndex
}

/**
 * Renders a stored managed object like the platform: standard fields first,
 * child references (`childDevices`, `childAssets`, `childAdditions`), parent
 * references (`deviceParents`, `assetParents`, `additionParents`, without
 * `self`), then the fragments.
 * @param data - Tenant data
 * @param document - Stored managed object
 * @param options - Rendering options
 */
export function renderManagedObject(data: TenantData, document: StoredDocument, options: RenderOptions = {}): StoredDocument {
  const self = moSelf(data, document.id)
  const reference = (id: string, referenceSelf: string) => ({
    self: referenceSelf,
    managedObject: {
      self: moSelf(data, id),
      id,
      ...(options.skipChildrenNames ? {} : { name: data.managedObjects.get(id)?.name }),
    },
  })
  const stored = clone(document)
  const rendered: StoredDocument = { self, id: document.id } as StoredDocument
  for (const key of STANDARD_ORDER.slice(2)) {
    if (stored[key] !== undefined) {
      rendered[key] = stored[key]
    }
  }
  for (const kind of CHILD_KINDS) {
    const all = childIds(data, document.id, kind)
    const children = options.withChildren === false ? [] : all
    rendered[kind] = {
      self: `${self}/${kind}`,
      references: children.map((id) => reference(id, `${self}/${kind}/${id}`)),
      // verified: only for a non-empty collection, also with withChildren=false
      ...(options.withChildrenCount && all.length > 0 ? { count: all.length } : {}),
    }
  }
  // verified against the platform: parent references only with withParents=true
  // (all ancestors, root first) or withGroups=true (direct group parents, after
  // the ancestors, without `type`)
  const index = options.withParents || options.withGroups ? options.parents ?? parentIndex(data) : undefined
  const parents: Record<string, StoredDocument[]> = Object.fromEntries(CHILD_KINDS.map((kind) => [kind, []]))
  if (options.withParents) {
    for (const { id, kind } of ancestors(index!, document.id)) {
      const parent = data.managedObjects.get(id)
      if (parent) {
        parents[kind]!.push(basicManagedObject(data, parent, true))
      }
    }
  }
  if (options.withGroups) {
    for (const { parent: id, kind } of index!.get(document.id) ?? []) {
      const parent = data.managedObjects.get(id)
      // verified: by type, the c8y_IsDeviceGroup fragment does not count
      if (kind === 'childAssets' && (parent?.type === 'c8y_DeviceGroup' || parent?.type === 'c8y_DeviceSubgroup')) {
        parents.childAssets!.push(basicManagedObject(data, parent, false))
      }
    }
  }
  for (const kind of CHILD_KINDS) {
    rendered[PARENT_KIND[kind]] = { references: parents[kind]!.map((parent) => ({ managedObject: parent })) }
  }
  for (const [key, value] of Object.entries(stored)) {
    if (!Object.hasOwn(rendered, key)) {
      // a fragment named `__proto__` stays a fragment
      Object.defineProperty(rendered, key, { value, enumerable: true, writable: true, configurable: true })
    }
  }
  if (rendered.c8y_Availability !== undefined && data.measurementGenerators.size > 0) {
    rendered.c8y_Availability = clone(renderedAvailability(data, document))
  }
  return rendered
}

/**
 * Creates a managed object (server fields assigned, relation fields ignored).
 * @param data - Tenant data
 * @param body - Managed object fragments
 * @param owner - Owner user name
 */
export function createManagedObject(data: TenantData, body: Record<string, unknown>, owner: string): StoredDocument {
  const now = data.world.now()
  // verified: a create may set the creation time (an update cannot)
  const given = body.creationTime
  const creationTime = typeof given === 'number' ? new Date(given).toISOString() : typeof given === 'string' ? normalizeIsoTime(given) : now
  const document: StoredDocument = { id: data.world.newId('managedObject'), owner, ...omit(body, SERVER_FIELDS), creationTime, lastUpdated: now }
  if (typeof body.owner === 'string') {
    document.owner = body.owner
  }
  data.managedObjects.set(document.id, document)
  // seeded objects with c8y_RequiredAvailability are monitored from here on
  scheduleAvailability(data, document.id)
  data.world.notify(data, 'managedobjects', 'CREATE', renderManagedObject(data, document), document.id)
  return document
}

function omit(body: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !fields.includes(key)))
}

/**
 * Fragments the platform derives from `c8y_RequiredAvailability` and device
 * traffic; values a client sends are dropped (verified).
 */
const AVAILABILITY_FIELDS = ['c8y_Availability', 'c8y_Connection']

const REPRESENTATION = 'com.cumulocity.rest.representation.inventory.ManagedObjectRepresentation'
// standard properties the platform reads as strings
const STRING_FIELDS = ['name', 'type', 'owner']

function jsonKind(value: unknown): string {
  return Array.isArray(value) ? 'Array value (token `JsonToken.START_ARRAY`)' : typeof value === 'object' ? 'Object value (token `JsonToken.START_OBJECT`)' : `${typeof value === 'string' ? 'String' : typeof value === 'number' ? 'Number' : 'Boolean'} value (${JSON.stringify(value)})`
}

/**
 * Reads the managed object of a create or update request the way the
 * platform deserializes it (all verified): the body as `readJsonBody()` reads it; `name`,
 * `type`, and `owner` take strings, numbers, and booleans (stored as strings);
 * `creationTime` must be a time, the child and parent collections objects;
 * `lastUpdated` (and `id` on a create) answer 422. `null` for `name`, `type`,
 * or `owner` drops the field.
 * @param call - The request
 * @param operation - `post`, `put`, or `create` (a child created under a parent), as in the platform's messages
 * @returns The body with the string fields converted, or an error response
 */
function readManagedObject(call: C8yRequest, operation: 'post' | 'put' | 'create'): Record<string, unknown> | Response {
  const body = readJsonBody(call, 'managedobject', operation === 'put'
    ? 'Cannot invoke "com.cumulocity.rest.representation.inventory.ManagedObjectRepresentation.setId(com.cumulocity.model.idtype.GId)" because "managedObjectRepresentation" is null'
    : 'Cannot invoke "Object.getClass()" because "source" is null')
  return body instanceof Response ? body : normalizeManagedObject(body, operation)
}

/**
 * Reads a JSON request body like the platform (verified): a content type
 * other than `application/json` or the resource's vendor type answers 415
 * without a body, an empty body 400, a `null` body 500.
 * @param call - The request
 * @param vendorType - e.g. `managedobject` for `application/vnd.com.nsn.cumulocity.managedobject+json`
 * @param nullMessage - The message of the 500 for a `null` body
 */
export function readJsonBody(call: C8yRequest, vendorType: string, nullMessage: string): Record<string, unknown> | Response {
  const contentType = (call.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  if (contentType !== '' && contentType !== 'application/json' && contentType !== `application/vnd.com.nsn.cumulocity.${vendorType}+json`) {
    return new Response(null, { status: 415 })
  }
  if (raw(call).bytes.length === 0 && call.body === undefined) {
    return apiError(400, 'Failed to parse JSON string', 'No content to map due to end-of-input')
  }
  if (call.body === null) {
    return apiError(500, 'general/internalError', nullMessage)
  }
  return call.body as Record<string, unknown>
}

/**
 * The managed object of a request as the platform reads it (see `readManagedObject()`).
 * @param input - The managed object as sent
 * @param operation - `post`, `put`, or `create`
 */
function normalizeManagedObject(input: Record<string, unknown>, operation: 'post' | 'put' | 'create'): Record<string, unknown> | Response {
  const body = { ...input }
  for (const field of STRING_FIELDS) {
    const value = body[field]
    if (value === null) {
      delete body[field]
    } else if (typeof value === 'object') {
      return apiError(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`java.lang.String\` from ${jsonKind(value)} (through reference chain: ${REPRESENTATION}["${field}"])`)
    } else if (value !== undefined) {
      body[field] = String(value)
    }
  }
  for (const field of [...CHILD_KINDS, ...Object.values(PARENT_KIND)]) {
    const value = body[field]
    if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      return apiError(400, 'Failed to parse JSON string', `Cannot construct instance of \`com.cumulocity.rest.representation.inventory.ManagedObjectReferenceCollectionRepresentation\` from ${jsonKind(value)} (through reference chain: ${REPRESENTATION}["${field}"])`)
    }
  }
  const creationTime = body.creationTime
  if (creationTime !== undefined && creationTime !== null && typeof creationTime !== 'number' && Number.isNaN(parseIsoTime(creationTime))) {
    const message = invalidTimeMessage(creationTime)
    return apiError(400, 'Failed to parse JSON string', `${message} (through reference chain: ${REPRESENTATION}["creationTime"]) : ${message}`)
  }
  for (const field of operation === 'put' ? ['lastUpdated'] : ['lastUpdated', 'id']) {
    if (body[field] !== undefined && body[field] !== null) {
      return apiError(422, 'undefined/validationError', `${operation}.managedObjectRepresentation.${field}: is not allowed here`)
    }
  }
  return body
}

/**
 * Validation of a managed object create or update (verified against the platform).
 * @param body - Request body
 * @param operation - `post` or `put`, as in the platform's message
 */
function checkManagedObject(body: Record<string, unknown>, operation: 'post' | 'put' | 'create'): Response | undefined {
  for (const field of ['name', 'type']) {
    const value = body[field]
    if (typeof value === 'string' && value.length > 1000) {
      return apiError(422, 'undefined/validationError', `${operation}.managedObjectRepresentation.${field}: exceeds maximum length of 1000`)
    }
  }
  const interval = (body.c8y_RequiredAvailability as { responseInterval?: unknown } | null | undefined)?.responseInterval
  if (typeof interval === 'string') {
    return apiError(400, 'Device availability/Bad Request', 'Incorrect value of device availability interval. The correct value must be an integer')
  }
  if (typeof interval === 'number' && !Number.isInteger(interval)) {
    return apiError(500, 'general/internalError', `For input string: "${interval}"`)
  }
  return undefined
}

/**
 * Creates a managed object from a request body: validated, availability
 * fragments derived, and `externalIds` registered in the identity service
 * instead of being stored (all verified). Nothing is created if an external
 * id is invalid or bound to another object.
 * @param data - Tenant data
 * @param call - The request
 * @param owner - Owner user name
 * @param operation - `post`, or `create` for a child created under a parent (as in the platform's messages)
 */
function createFromRequest(data: TenantData, call: C8yRequest, owner: string, operation: 'post' | 'create'): StoredDocument | Response {
  const body = readManagedObject(call, operation)
  if (body instanceof Response) {
    return body
  }
  const invalid = checkManagedObject(body, operation)
  if (invalid) {
    return invalid
  }
  const externalIds = body.externalIds ?? []
  if (!Array.isArray(externalIds)) {
    return apiError(400, 'Failed to parse JSON string', 'Cannot deserialize value of type `java.util.ArrayList<com.cumulocity.rest.representation.identity.ExternalIDRepresentation>` from Object value (token `JsonToken.START_OBJECT`)')
  }
  for (const [index, entry] of (externalIds as Array<Record<string, unknown> | null>).entries()) {
    const missing = ['externalId', 'type'].find((field) => entry?.[field] === undefined || entry[field] === null || entry[field] === '')
    if (missing) {
      return apiError(422, 'undefined/validationError', `post.managedObjectRepresentation.externalIds[${index}].${missing}: must not be empty`)
    }
    if (data.externalIds.has(externalIdKey(String(entry!.type), String(entry!.externalId)))) {
      return apiError(409, 'identity/Duplicate', `ID [type=${String(entry!.type)}, value=${String(entry!.externalId)}] was already bound to different Global ID.`)
    }
  }
  const document = createManagedObject(data, omit(body, ['externalIds', ...AVAILABILITY_FIELDS]), owner)
  for (const entry of externalIds as Array<Record<string, unknown>>) {
    addExternalId(data, document.id, String(entry.type), String(entry.externalId))
  }
  if (body.c8y_RequiredAvailability !== undefined) {
    const updated = data.managedObjects.update(document.id, (draft) => updateAvailability(data, draft))!
    auditAvailability(data, document.id, undefined, requiredInterval(updated))
    scheduleAvailability(data, document.id)
    return updated
  }
  return document
}

/**
 * Derives `c8y_Availability` and `c8y_Connection` from `c8y_RequiredAvailability`
 * after a create or update, as the platform does (verified): an interval above
 * 0 is AVAILABLE and DISCONNECTED, 0 or less MAINTENANCE; `lastMessage` is set
 * once and kept. Without an interval both fragments are removed. The platform
 * applies this asynchronously, so a read right after the write can still show
 * the state before it.
 * @param data - Tenant data
 * @param document - A copy of the stored managed object, changed in place
 */
function updateAvailability(data: TenantData, document: StoredDocument): void {
  const interval = (document.c8y_RequiredAvailability as { responseInterval?: unknown } | undefined)?.responseInterval
  if (typeof interval !== 'number') {
    delete document.c8y_Availability
    delete document.c8y_Connection
    return
  }
  const maintenance = interval <= 0
  const lastMessage = (document.c8y_Availability as { lastMessage?: unknown } | undefined)?.lastMessage ?? data.world.now()
  document.c8y_Availability = { lastMessage, status: maintenance ? 'MAINTENANCE' : 'AVAILABLE' }
  document.c8y_Connection = { status: maintenance ? 'MAINTENANCE' : 'DISCONNECTED' }
}

function requiredInterval(document: Readonly<StoredDocument>): number | undefined {
  const interval = (document.c8y_RequiredAvailability as { responseInterval?: unknown } | undefined)?.responseInterval
  return typeof interval === 'number' ? interval : undefined
}

/**
 * Applies an update to a stored managed object (verified): `null` removes a
 * fragment, a fragment is replaced as a whole, server fields are ignored. An
 * update with nothing to change (only ids, links, or `null` standard fields)
 * changes nothing, not even `lastUpdated`.
 * @param data - Tenant data
 * @param document - The stored managed object
 * @param body - The update, read by `normalizeManagedObject()`
 * @returns The stored update, the unchanged `document`, or an error response
 */
function updateManagedObject(data: TenantData, document: StoredDocument, body: Record<string, unknown>): StoredDocument | Response {
  const invalid = checkManagedObject(body, 'put')
  if (invalid) {
    return invalid
  }
  const changes = omit(body, [...SERVER_FIELDS, ...AVAILABILITY_FIELDS])
  const dollar = Object.keys(changes).find((key) => key.startsWith('$'))
  if (dollar) {
    // verified: the platform answers 500 for a `$` key on update
    return apiError(500, 'general/internalError', `Bulk write operation error on MongoDB server. Write errors: [BulkWriteError{index=0, code=52, message='The dollar ($) prefixed field '${dollar}' in '${dollar}' is not allowed in the context of an update's replacement document. Consider using an aggregation pipeline with $replaceWith.', details={}}]. `)
  }
  if (Object.keys(changes).length === 0 && !('creationTime' in body)) {
    return document
  }
  const updated: StoredDocument = clone(document)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      delete updated[key]
    } else {
      updated[key] = value
    }
  }
  if ('c8y_RequiredAvailability' in body) {
    updateAvailability(data, updated)
  }
  updated.lastUpdated = data.world.now()
  data.managedObjects.set(document.id, updated)
  if ('c8y_RequiredAvailability' in body) {
    auditAvailability(data, document.id, requiredInterval(document), requiredInterval(updated))
    scheduleAvailability(data, document.id)
  }
  data.world.notify(data, 'managedobjects', 'UPDATE', renderManagedObject(data, updated), document.id)
  return updated
}

/**
 * `PUT /inventory/managedObjects`: several updates at once (verified). The
 * ids must be given, distinct, and known before anything changes (an error
 * names the failing index in `bulkRequest.failedIndex`); a write error stops
 * the request, earlier updates stay. Answers all objects, their children
 * without names, as one page of 1000000.
 * @param call - The request
 * @param data - Tenant data
 */
function bulkUpdate(call: C8yRequest, data: TenantData): Response {
  const body = readJsonBody(call, 'managedobjectcollection', 'Cannot invoke "Object.getClass()" because "source" is null')
  if (body instanceof Response) {
    return body
  }
  const items = body.managedObjects
  if (items !== undefined && items !== null && !Array.isArray(items)) {
    return apiError(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`java.util.ArrayList<${REPRESENTATION}>\` from ${jsonKind(items)} (through reference chain: com.cumulocity.rest.representation.inventory.ManagedObjectCollectionRepresentation["managedObjects"])`)
  }
  const failed = (status: number, error: string, message: string, failedIndex: number) =>
    Response.json({ error, message, info: 'https://cumulocity.com/api/core/', bulkRequest: { failedIndex } }, { status })
  const updates: Array<Record<string, unknown>> = []
  for (const item of (items ?? []) as unknown[]) {
    const normalized = normalizeManagedObject((item ?? {}) as Record<string, unknown>, 'put')
    if (normalized instanceof Response) {
      return normalized
    }
    updates.push(normalized)
  }
  if (updates.length === 0) {
    return apiError(422, 'undefined/validationError', 'put.managedObjectCollection.managedObjects: At least one managed object is required for a bulk request')
  }
  const missing = updates.findIndex((update) => update.id === undefined || update.id === null)
  if (missing >= 0) {
    return failed(422, 'undefined/validationError', `put.managedObjectCollection.managedObjects[${missing}].id: is required`, missing)
  }
  const ids = updates.map((update) => String(update.id))
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  if (duplicates.length > 0) {
    return apiError(422, 'undefined/validationError', `put.managedObjectCollection.managedObjects: Duplicate ids: ${duplicates.join(', ')}`)
  }
  const unknown = ids.findIndex((id) => !data.managedObjects.has(id))
  if (unknown >= 0) {
    return failed(404, 'inventory/Not Found', `Could not find managed object in database for update. : No managedObject for id '${ids[unknown]}'!`, unknown)
  }
  for (const [index, update] of updates.entries()) {
    const document = data.managedObjects.get(ids[index]!)!
    // an update without changes still counts as one here (verified)
    const result = updateManagedObject(data, document, { ...update, creationTime: update.creationTime ?? null })
    if (result instanceof Response) {
      return result
    }
  }
  return Response.json({
    self: `${data.world.baseUrl}/inventory/managedObjects?currentPage=1&pageSize=1000000`,
    managedObjects: ids.map((id) => renderManagedObject(data, data.managedObjects.get(id)!, { skipChildrenNames: true })),
    statistics: { totalPages: 1, pageSize: 1000000, currentPage: 1 },
  })
}

/**
 * Sets `lastUpdated` of a parent and a child whose reference was added or
 * removed (verified: both change).
 * @param data - Tenant data
 * @param ids - Managed object ids
 */
function touch(data: TenantData, ...ids: string[]): void {
  const now = data.world.now()
  for (const id of ids) {
    const document = data.managedObjects.get(id)
    if (document) {
      data.managedObjects.set(id, { ...document, lastUpdated: now })
    }
  }
}

/**
 * Ids a `DELETE /inventory/managedObjects/{id}` removes (verified): a group
 * takes its subgroups along; with `cascade=true` a device or group takes all
 * its descendants (child devices, assets, and additions, recursively), and
 * `forceCascade=true` does so for any object. Other descendants stay.
 * @param call - The request
 * @param data - Tenant data
 * @param document - The object to delete
 */
function deletedWith(call: C8yRequest, data: TenantData, document: StoredDocument): string[] {
  const isGroup = document.c8y_IsDeviceGroup !== undefined
  if (flag(call, 'forceCascade') || (flag(call, 'cascade') && (isGroup || document.c8y_IsDevice !== undefined))) {
    return [...descendants(data, [document.id])]
  }
  const ids = [document.id]
  if (isGroup) {
    for (let i = 0; i < ids.length; i++) {
      for (const child of childIds(data, ids[i]!, 'childAssets')) {
        if (data.managedObjects.get(child)?.c8y_IsDeviceGroup !== undefined && !ids.includes(child)) {
          ids.push(child)
        }
      }
    }
  }
  return ids
}

/**
 * The fields `text=` searches (verified): id, type, name, owner, and the
 * type and value of every external id; fragments are not searched.
 * @param externalIds - External ids by managed object (`externalIdsByObject()`)
 * @param document - Managed object
 */
function textFields(externalIds: ReturnType<typeof externalIdsByObject>, document: StoredDocument): string[] {
  return [
    document.id,
    document.type,
    document.name,
    document.owner,
    ...externalIds(document.id).flatMap((entry) => [entry.type, entry.externalId]),
  ].filter((value): value is string => typeof value === 'string')
}

function listManagedObjects(call: C8yRequest, data: TenantData, documents: StoredDocument[]): StoredDocument[] {
  let items = documents
  const { query } = call
  // verified: with `query` (or `q`) the filters by type, fragment, ids, owner,
  // and child ids are ignored; `text` and `onlyRoots` still apply. With both,
  // `query` wins and `q` is ignored (also its device-only rule)
  const language = query.query !== undefined ? 'query' : query.q !== undefined ? 'q' : undefined
  if (language === undefined) {
    if (query.type) {
      items = items.filter((document) => document.type === query.type)
    }
    if (query.fragmentType) {
      items = items.filter((document) => Object.hasOwn(document, query.fragmentType!) && document[query.fragmentType!] !== undefined)
    }
    if (query.ids) {
      const ids = query.ids.split(',')
      items = items.filter((document) => ids.includes(document.id))
    }
    if (query.owner) {
      items = items.filter((document) => document.owner === query.owner)
    }
    const childFilters: Array<[string, ChildKind]> = [['childDeviceId', 'childDevices'], ['childAssetId', 'childAssets'], ['childAdditionId', 'childAdditions']]
    for (const [param, kind] of childFilters) {
      if (query[param]) {
        items = items.filter((document) => childIds(data, document.id, kind).includes(query[param]!))
      }
    }
  }
  if (query.text) {
    const externalIds = externalIdsByObject(data)
    const search = parseTextSearch(query.text)
    items = items.filter((document) => matchesText(search, textFields(externalIds, document)))
  }
  if (flag(call, 'onlyRoots')) {
    const children = new Set<string>()
    for (const relations of data.children.values()) {
      for (const kind of CHILD_KINDS) {
        for (const child of relations[kind]) {
          children.add(child)
        }
      }
    }
    items = items.filter((document) => !children.has(document.id))
  }
  let orderBy: ReturnType<typeof parseQuery>['orderBy'] = []
  if (language !== undefined && query[language]) {
    const parsed = parseQuery(query[language]!, data)
    items = items.filter((document) => parsed.filter(document))
    orderBy = parsed.orderBy
  }
  if (language === 'q') {
    // `q` is the device query: devices only
    items = items.filter((document) => document.c8y_IsDevice !== undefined)
  }
  return applyOrderBy(items, orderBy)
}

/**
 * Whether a list request has no filter, so its page can be read without
 * copying the collection.
 * @param call - The request
 */
function unfilteredList(call: C8yRequest): boolean {
  const { query } = call
  return query.query === undefined && query.q === undefined && !flag(call, 'onlyRoots')
    && !['type', 'fragmentType', 'ids', 'owner', 'childDeviceId', 'childAssetId', 'childAdditionId', 'text'].some((name) => query[name])
}

/**
 * The values of a collection as a list that reads only up to the end of the
 * requested slice.
 * @param collection - The collection
 */
function lazyValues<V>(collection: Collection<V>): { length: number, slice: (start: number, end: number) => V[] } {
  return {
    length: collection.size,
    slice: (start, end) => {
      const page: V[] = []
      let index = 0
      for (const value of collection.values()) {
        if (index >= end) {
          break
        }
        if (index >= start) {
          page.push(value)
        }
        index++
      }
      return page
    },
  }
}

// `withLatestValues` is accepted and ignored: the Latest Measurement feature is
// a public preview, and a tenant without it (verified) ignores the parameter
const LIST_PARAMS = ['childAdditionId', 'childAssetId', 'childDeviceId', 'currentPage', 'fragmentType', 'ids', 'onlyRoots', 'owner', 'pageSize', 'q', 'query', 'skipChildrenNames', 'text', 'type', 'withChildren', 'withChildrenCount', 'withGroups', 'withLatestValues', 'withParents', 'withTotalElements', 'withTotalPages']
const DETAIL_PARAMS = ['skipChildrenNames', 'withChildren', 'withChildrenCount', 'withLatestValues', 'withParents']

/**
 * The series (`fragment.series` with a numeric `value`) of a source's
 * measurements, in the order they first appear.
 * @param data - Tenant data
 * @param source - Managed object id
 */
function supportedSeries(data: TenantData, source: string): Array<[fragment: string, series: string]> {
  // the source index (shared with the measurement list) keeps collection order
  const stored = data.measurements.groupedBy(sourceId)(source).map((key) => data.measurements.get(key)!)
  const view = generatedView(data)
  if (view) {
    return view.supportedSeries(source, stored)
  }
  const found = new Map<string, [string, string]>()
  for (const measurement of stored) {
    for (const [fragment, value] of Object.entries(measurement)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        continue
      }
      for (const [series, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry && typeof entry === 'object' && typeof (entry as { value?: unknown }).value === 'number') {
          found.set(`${fragment}.${series}`, [fragment, series])
        }
      }
    }
  }
  return [...found.values()]
}

/**
 * The child id of a reference (`{ managedObject: { id } }`), as the platform
 * reads it (verified): without `id` it takes the id from a `self` link
 * ending in `/inventory/managedObjects/{id}`.
 * @param entry - The reference
 * @returns The id, or a 422 response
 */
function referencedId(entry: unknown): string | Response {
  const managedObject = (entry as { managedObject?: unknown } | null)?.managedObject
  if (managedObject === null || typeof managedObject !== 'object') {
    return apiError(422, 'inventory/Invalid Data', 'no child reference provided for ManagedObjectRepresentation')
  }
  const { id, self } = managedObject as { id?: unknown, self?: unknown }
  if (id !== undefined && id !== null) {
    return String(id)
  }
  if (self !== undefined && self !== null) {
    const match = /\/inventory\/managedObjects\/([^/?#]+)$/.exec(String(self))
    return match ? match[1]! : apiError(422, 'inventory/Invalid Data', `invalid self url provided for ManagedObjectRepresentation: ${String(self)}`)
  }
  return apiError(422, 'inventory/Invalid Data', 'no child id provided for ManagedObjectRepresentation')
}

/**
 * `GET`/`PUT /inventory/managedObjects/{id}/user`: the owner's user name and
 * state. Verified on a real tenant: the owner must be a user (else 404
 * `users/Not Found`); a microservice's `service_*` user counts although the
 * user API does not list it, and answers `enabled: true`; an object without
 * an owner answers 404 "Managed object not owned"; `customProperties` are the
 * user's own for the calling user and `{}` for others. The fake takes every
 * `service_*` name for a service user. A `PUT` with `enabled` changes the
 * owner user's state and answers the new state.
 * @param call - The request
 * @param data - Tenant data
 * @param id - Managed object id
 * @param document - The managed object, if it exists
 */
function managedObjectUser(call: C8yRequest, data: TenantData, id: string, document: Readonly<StoredDocument> | undefined): Response {
  checkQuery(`${call.method as 'GET' | 'PUT'} /inventory/managedObjects/{id}/user`, call, [])
  if (!document) {
    return notFound(id)
  }
  const owner = document.owner
  if (typeof owner !== 'string' || owner === '') {
    return apiError(404, 'inventory/Not Found', 'Managed object not owned : No owner')
  }
  let user = data.users.get(owner)
  const caller = data.world.actor() ?? call.user
  if (!user && owner !== caller && !owner.startsWith('service_')) {
    return apiError(404, 'users/Not Found', `Error retrieving user ${owner}! : Cannot find document with ID ${owner}`)
  }
  let enabled = user?.enabled !== false
  if (call.method === 'PUT') {
    const body = readJsonBody(call, 'managedobjectuser', 'Cannot invoke "Object.getClass()" because "source" is null')
    if (body instanceof Response) {
      return body
    }
    if (typeof body.enabled === 'boolean') {
      enabled = body.enabled
      if (user && user.enabled !== enabled) {
        user = data.users.update(owner, (draft) => {
          draft.enabled = enabled
        })
      }
    }
  }
  const customProperties = user && owner === caller ? clone(user.customProperties ?? {}) : {}
  return Response.json({ userName: owner, enabled, self: `${moSelf(data, id)}/user`, customProperties })
}

function notAChild(id: string, childId: string): Response {
  return apiError(422, 'inventory/Invalid Data', `managedObject with id: ${childId}, is not a child of object with id: ${id} : Parent child relationship validation failed`)
}

/**
 * Inventory API: managed objects and child references.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function inventory(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  try {
    return inventoryRequest(call, segments, data)
  } catch (error) {
    if (error instanceof QuerySyntaxError) {
      const query = call.query.query ?? call.query.q
      return apiError(422, 'inventory/Invalid Data', `Find by filter query failed : Query '${query}' could not be understood. Please try again.`)
    }
    throw error
  }
}

function inventoryRequest(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, , id, kind, childId] = segments
  const { method } = call
  const options: RenderOptions = {
    withChildren: flag(call, 'withChildren', true),
    skipChildrenNames: flag(call, 'skipChildrenNames'),
    withParents: flag(call, 'withParents'),
    withChildrenCount: flag(call, 'withChildrenCount'),
  }
  if (options.withParents) {
    options.parents = parentIndex(data)
  }
  const render = (document: StoredDocument) => renderManagedObject(data, document, options)

  if (id === undefined) {
    if (method === 'GET') {
      checkQuery('GET /inventory/managedObjects', call, LIST_PARAMS)
      const items = unfilteredList(call) ? lazyValues(data.managedObjects) : listManagedObjects(call, data, [...data.managedObjects.values()])
      // `withGroups` is a list parameter only
      const listOptions: RenderOptions = { ...options, withGroups: flag(call, 'withGroups') }
      if (listOptions.withGroups) {
        listOptions.parents ??= parentIndex(data)
      }
      const access = data.world.access()
      const shown = visible(items, access && ((document: StoredDocument) => listedManagedObject(data, access, document)))
      return paged(data, call, 'managedObjects', shown, '/inventory/managedObjects', { render: (document) => renderManagedObject(data, document, listOptions) })
    }
    if (method === 'PUT') {
      checkQuery('PUT /inventory/managedObjects', call, [])
      return bulkUpdate(call, data)
    }
    if (method === 'POST') {
      checkQuery('POST /inventory/managedObjects', call, [])
      // verified: the owner is the login user, the one audit records name
      const created = createFromRequest(data, call, data.world.actor() ?? call.user ?? 'test-user', 'post')
      return created instanceof Response ? created : Response.json(render(created), { status: 201 })
    }
    return undefined
  }

  const document = data.managedObjects.get(id)

  if (id === 'count' && kind === undefined && method === 'GET') {
    // undocumented, used by @c8y/client's inventory.count(filter): the number
    // of objects the list filters select, as a bare JSON number. Verified:
    // `query`, `q`, and `onlyRoots` are ignored (so `type` always applies);
    // `type`, `fragmentType`, `text`, `owner`, and `ids` filter
    checkQuery('GET /inventory/managedObjects', call, LIST_PARAMS)
    const { query: _query, q: _q, onlyRoots: _onlyRoots, ...honoured } = call.query
    const access = data.world.access()
    const counted = listManagedObjects({ ...call, query: honoured }, data, [...data.managedObjects.values()])
    return Response.json(access ? counted.filter((document) => listedManagedObject(data, access, document)).length : counted.length)
  }

  if (kind === 'supportedSeries' || kind === 'supportedMeasurements' || kind === 'availability') {
    if (method !== 'GET' || childId !== undefined) {
      return undefined
    }
    checkQuery(`GET /inventory/managedObjects/{id}/${kind}`, call, [])
    if (kind === 'availability') {
      // verified: the platform answers from a cache that only device
      // connections fill; for objects created or fed through the REST API
      // (and unknown ids) it is always this 404
      return apiError(404, 'availability/Not Found', `Availability for device with id ${id} not found in cache`)
    }
    if (!document) {
      return notFound(id)
    }
    const series = supportedSeries(data, id)
    return Response.json(kind === 'supportedSeries'
      ? { c8y_SupportedSeries: series.map(([fragment, name]) => `${fragment}.${name}`) }
      : { c8y_SupportedMeasurements: [...new Set(series.map(([fragment]) => fragment))] })
  }

  if (kind === 'user' && childId === undefined && (method === 'GET' || method === 'PUT')) {
    return managedObjectUser(call, data, id, document)
  }

  if (kind === undefined) {
    if (method === 'GET') {
      checkQuery('GET /inventory/managedObjects/{id}', call, DETAIL_PARAMS)
      return document ? Response.json(render(document)) : notFound(id)
    }
    if (method === 'PUT') {
      checkQuery('PUT /inventory/managedObjects/{id}', call, [])
      if (!document) {
        return apiError(404, 'inventory/Not Found', `Could not find managed object in database for update. : No managedObject for id '${id}'!`)
      }
      const body = readManagedObject(call, 'put')
      if (body instanceof Response) {
        return body
      }
      const updated = updateManagedObject(data, document, body)
      if (updated === document && Object.keys(call.body as Record<string, unknown>).every((key) => key === 'id')) {
        // verified: an update of the device without changes is a heartbeat
        recordTraffic(data, id)
      }
      return updated instanceof Response ? updated : Response.json(updated === document ? renderManagedObject(data, { id }, { withChildren: false }) : render(updated))
    }
    if (method === 'DELETE') {
      checkQuery('DELETE /inventory/managedObjects/{id}', call, ['cascade', 'forceCascade', 'withDeviceUser'])
      if (document?.c8y_IsBinary !== undefined) {
        // verified against the platform
        return apiError(422, 'inventory/Invalid Data', 'Cannot delete managed object. :  Cannot change binary metadata through inventory api.')
      }
      if (!document) {
        return notFound(id)
      }
      // verified: only the requested object gets an audit record
      for (const deleted of deletedWith(call, data, document)) {
        // published first: the object's own subscriptions go with it
        data.world.notify(data, 'managedobjects', 'DELETE', { id: deleted }, deleted)
        deleteManagedObject(data, deleted)
      }
      auditManagedObjectDeleted(data, document)
      // documented: `withDeviceUser` also deletes the device's own user (the
      // owner a device gets from its registration); verified: accepted for
      // objects without one
      if (flag(call, 'withDeviceUser') && typeof document.owner === 'string' && document.owner.startsWith('device_')) {
        deleteUser(data, document.owner)
      }
      return new Response(null, { status: 204 })
    }
    return undefined
  }

  if (!(CHILD_KINDS as string[]).includes(kind)) {
    return undefined
  }
  const childKind = kind as ChildKind
  const endpoint = `/inventory/managedObjects/{id}/${childKind}` as const

  if (childId === undefined && method === 'GET') {
    checkQuery(`GET ${endpoint}`, call, ['currentPage', 'pageSize', 'query', 'withChildren', 'withChildrenCount', 'withTotalElements', 'withTotalPages'])
    if (!document) {
      return notFound(id)
    }
    // verified: in the order the children were created, not linked (the
    // object's own child references keep the link order)
    let children = data.managedObjects.inOrder(new Set(childIds(data, id, childKind))).map((child) => data.managedObjects.get(child)!)
    if (call.query.query) {
      const parsed = parseQuery(call.query.query, data)
      children = applyOrderBy(children.filter((child) => parsed.filter(child)), parsed.orderBy)
    }
    return paged(data, call, 'references', children, `/inventory/managedObjects/${id}/${childKind}`, {
      errorCode: 'REST API/Unprocessable Entity',
      render: (child) => ({ self: `${moSelf(data, id)}/${childKind}/${child.id}`, managedObject: render(child) }),
    })
  }

  if (childId === undefined && method === 'POST') {
    checkQuery(`POST ${endpoint}`, call, [])
    if (!document) {
      return notFound(id)
    }
    const contentType = (call.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    // createChild: a new managed object, created and attached
    if (contentType === 'application/vnd.com.nsn.cumulocity.managedobject+json') {
      const child = createFromRequest(data, call, data.world.actor() ?? call.user ?? 'test-user', 'create')
      if (child instanceof Response) {
        return child
      }
      addChild(data, id, childKind, child.id)
      touch(data, id, child.id)
      return Response.json(render(child), { status: 201 })
    }
    // verified: only the collection content type reads `references`; any
    // other body is a single reference
    const collection = contentType === 'application/vnd.com.nsn.cumulocity.managedobjectreferencecollection+json'
    const body = readJsonBody(call, collection ? 'managedobjectreferencecollection' : 'managedobjectreference', 'Cannot invoke "Object.getClass()" because "source" is null')
    if (body instanceof Response) {
      return body
    }
    const entries: unknown[] = collection ? (Array.isArray(body.references) ? body.references : []) : [body]
    const requested: string[] = []
    for (const entry of entries) {
      const child = referencedId(entry)
      if (child instanceof Response) {
        return child
      }
      if (!requested.includes(child)) {
        requested.push(child)
      }
    }
    const unknown = requested.filter((child) => !data.managedObjects.has(child))
    if (unknown.length > 0) {
      // verified: nothing is added
      return apiError(404, 'inventory/Not Found', `Finding device data from database failed : Some managedObjects don't exist in database: '[${unknown.map((child) => `ID [type=com_cumulocity_model_idtype_GId, value=${child}]`).join(', ')}]'`)
    }
    const references = requested.map((child) => {
      // verified: the child as it was before the link, its children without names
      const rendered = renderManagedObject(data, data.managedObjects.get(child)!, { skipChildrenNames: true })
      addChild(data, id, childKind, child)
      touch(data, id, child)
      return { self: `${moSelf(data, id)}/${childKind}/${child}`, managedObject: rendered }
    })
    return Response.json(collection ? { self: `${moSelf(data, id)}/${childKind}`, references } : references[0], { status: 201 })
  }

  if (childId === undefined && method === 'DELETE') {
    checkQuery(`DELETE ${endpoint}`, call, [])
    if (!document) {
      return notFound(id)
    }
    const body = (call.body ?? {}) as Record<string, any>
    const requested: string[] = Array.isArray(body.references) ? body.references.map((reference: any) => String(reference?.managedObject?.id)) : []
    if (requested.length === 0) {
      // verified against the platform
      return apiError(500, 'general/internalError', 'It must be at least one element to remove from set')
    }
    // verified: all or nothing, the first id that is no child fails the request
    const stray = requested.find((child) => !childIds(data, id, childKind).includes(child))
    if (stray !== undefined) {
      return notAChild(id, stray)
    }
    for (const child of requested) {
      removeChild(data, id, childKind, child)
      touch(data, id, child)
    }
    return new Response(null, { status: 204 })
  }

  if (childId !== undefined && method === 'GET') {
    checkQuery(`GET ${endpoint}/{childId}`, call, [])
    const child = data.managedObjects.get(childId)
    if (!document || !child) {
      return notFound(document ? childId : id)
    }
    if (!childIds(data, id, childKind).includes(childId)) {
      // verified against the platform (no comma, unlike the delete message)
      return apiError(422, 'inventory/Invalid Data', `managedObject with id: ${childId} is not a child of parent with id: ${id}`)
    }
    // verified: the child's own child references come without names
    return Response.json({ self: `${moSelf(data, id)}/${childKind}/${childId}`, managedObject: renderManagedObject(data, child, { skipChildrenNames: true }) })
  }

  if (childId !== undefined && method === 'DELETE') {
    checkQuery(`DELETE ${endpoint}/{childId}`, call, [])
    if (!document) {
      return notFound(id)
    }
    if (!removeChild(data, id, childKind, childId)) {
      // verified against the platform
      return notAChild(id, childId)
    }
    touch(data, id, childId)
    return new Response(null, { status: 204 })
  }

  return undefined
}
