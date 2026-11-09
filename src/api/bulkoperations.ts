/**
 * Bulk operations (`/devicecontrol/bulkoperations`): one operation per child
 * asset of a group, created one by one from `startDate` on, every
 * `creationRamp` seconds.
 *
 * Time-based progress happens in `advanceBulkOperations()`, which the world
 * runs before every request and every `world.db` access (and on
 * `world.tick()`): it creates the operations that are due by the world's
 * clock. Behavior verified against the platform and its source:
 *
 * - `status`: ACTIVE (scheduled) → IN_PROGRESS (first operation created) →
 *   COMPLETED (one ramp after the last operation), or DELETED.
 * - `generalStatus` is recalculated when the bulk operation creates an
 *   operation and when one of its operations is updated: SCHEDULED,
 *   EXECUTING, EXECUTING_WITH_ERROR (sic, the docs say ..._ERRORS),
 *   SUCCESSFUL, FAILED; CANCELED once deleted. CANCELED, SUCCESSFUL, and
 *   FAILED are final.
 * - `progress` counts the operations with this `bulkOperationId` by status,
 *   live; `all` is the number of targeted objects.
 * - An object the platform cannot create an operation for (no agent, deleted)
 *   gets a FAILED operation with the reason.
 * - Audit records (verified): `Create bulk operation`, `Update bulk operation`
 *   whenever the general status changes, `Delete bulk operation`. The task
 *   runs as the user who created the bulk operation: its operations get
 *   `Operation created` records in that user's name (FAILED ones none).
 */
import type { C8yRequest } from '../types'
import type { StoredDocument, TenantData } from '../store'
import { nextSequence } from '../store'
import { clone, parseIsoTime } from '../utils'
import { auditBulkOperation } from './audit'
import { createDocument, RESOURCES } from './data'
import { apiError, checkQuery, paged, raw, UnsupportedRequestError } from './http'

const PATH = '/devicecontrol/bulkoperations'

/**
 * Stored fields that are not part of the representation.
 */
interface BulkTask {
  /**
   * Targeted managed objects, fixed at creation.
   */
  deviceIds: string[]
  /**
   * Objects still waiting for their operation.
   */
  queue: string[]
  /**
   * When the next operation is created (ISO), while the task runs.
   */
  nextRunAt?: string
  /**
   * Set when a running bulk operation is deleted: its task still creates the
   * next due operation, then stops.
   */
  lastStep?: boolean
  /**
   * User who created the bulk operation; the task runs in their name.
   */
  creator?: string
}

type StoredBulkOperation = StoredDocument & BulkTask

const FINAL_GENERAL_STATUSES = ['CANCELED', 'SUCCESSFUL', 'FAILED', 'DELETED']
const GENERAL_STATUSES = ['SCHEDULED', 'CANCELED', 'EXECUTING', 'EXECUTING_WITH_ERROR', 'FAILED', 'SUCCESSFUL', 'DELETED', 'INCORRECT']

function invalid(message: string): Response {
  return apiError(422, 'bulkOperationResource/Invalid Data', message)
}

function notFound(id: string): Response {
  return apiError(404, 'devicecontrol/Not Found', `Finding bulk operation from database failed : Cannot find document with ID ${id}`)
}

function notActive(id: string): Response {
  return apiError(404, 'devicecontrol/Not Found', `Finding bulk operation from database failed : Could not find ACTIVE or IN_PROGRESS entity BulkOperation by ID ID [type=com_cumulocity_model_idtype_GId, value=${id}]!`)
}

/**
 * Operation counts of a bulk operation by status (live, like the platform).
 * @param data - Tenant data
 * @param bulk - Stored bulk operation
 */
function progressOf(data: TenantData, bulk: StoredBulkOperation): Record<'pending' | 'successful' | 'failed' | 'executing' | 'all', number> {
  const progress = { pending: 0, successful: 0, failed: 0, executing: 0, all: bulk.deviceIds.length }
  for (const operation of data.operations.values()) {
    if (operation.bulkOperationId === Number(bulk.id)) {
      const key = String(operation.status).toLowerCase() as keyof typeof progress
      if (key in progress && key !== 'all') {
        progress[key]++
      }
    }
  }
  return progress
}

export function renderBulkOperation(data: TenantData, bulk: StoredDocument): StoredDocument {
  const { id, groupId, failedParentId, startDate, creationRamp, operationPrototype, status, generalStatus, note, deviceIds: _deviceIds, queue: _queue, nextRunAt: _nextRunAt, creator: _creator, ...custom } = bulk as StoredBulkOperation
  return {
    id: Number(id) as unknown as string,
    ...(groupId !== undefined ? { groupId } : {}),
    ...(failedParentId !== undefined ? { failedParentId } : {}),
    startDate,
    creationRamp,
    operationPrototype: clone(operationPrototype),
    progress: progressOf(data, bulk as StoredBulkOperation),
    status,
    generalStatus,
    // verified: always present, `null` without a note
    note: note ?? null,
    self: `${data.world.baseUrl}${PATH}/${id}`,
    // verified: the representation's `isCreate()` leaks into the JSON
    create: groupId !== undefined,
    ...clone(custom),
  }
}

/**
 * Recalculates the general status from the progress (the platform's
 * `BulkOperationGeneralStatusCalculator`).
 * @param data - Tenant data
 * @param bulk - A copy of the stored bulk operation, changed in place (the caller stores it)
 * @returns Whether the general status changed
 */
export function updateGeneralStatus(data: TenantData, bulk: StoredDocument): boolean {
  const previous = String(bulk.generalStatus)
  if (FINAL_GENERAL_STATUSES.includes(previous)) {
    return false
  }
  if (bulk.status === 'DELETED') {
    bulk.generalStatus = 'CANCELED'
  } else {
    const { pending, executing, successful, failed, all } = progressOf(data, bulk as StoredBulkOperation)
    const done = successful + failed === all
    if (pending + executing + successful + failed === 0) {
      bulk.generalStatus = 'SCHEDULED'
    } else if (!done) {
      bulk.generalStatus = failed === 0 ? 'EXECUTING' : 'EXECUTING_WITH_ERROR'
    } else {
      bulk.generalStatus = successful === all ? 'SUCCESSFUL' : 'FAILED'
    }
  }
  auditStatusChange(data, bulk as StoredBulkOperation, previous)
  return bulk.generalStatus !== previous
}

/**
 * `Update bulk operation` audit record, if the general status changed (verified).
 * @param data - Tenant data
 * @param bulk - Stored bulk operation, after the change
 * @param previous - General status before
 */
function auditStatusChange(data: TenantData, bulk: StoredBulkOperation, previous: string): void {
  if (bulk.generalStatus !== previous) {
    auditBulkOperation(data, renderBulkOperation(data, bulk), 'Update', bulk.deviceIds, [{ attribute: 'generalStatus', type: 'com.cumulocity.model.operation.bulk.BulkOperationGeneralStatus', previousValue: previous, newValue: String(bulk.generalStatus) }])
  }
}

/**
 * `Delete bulk operation` audit record (verified: no progress, no devices).
 * @param data - Tenant data
 * @param bulk - What the platform describes: the marked one (note `null`), or the request of an update
 * @param bulk.id - Bulk operation id
 * @param bulk.status - Status
 * @param bulk.generalStatus - General status
 * @param bulk.note - Note
 */
function auditDeleted(data: TenantData, bulk: { id: string, status: string, generalStatus: string, note: unknown }): void {
  auditBulkOperation(data, { ...bulk, note: bulk.note ?? null }, 'Delete', null)
}

/**
 * Creates the operation of one targeted object, or a FAILED one with the
 * reason when the platform would reject it (verified: no agent, deleted
 * object; a FAILED operation is stored without a notification).
 * @param data - Tenant data
 * @param bulk - Stored bulk operation
 * @param deviceId - Targeted managed object
 * @param at - Creation time
 */
function createOperation(data: TenantData, bulk: StoredBulkOperation, deviceId: string, at: string): void {
  const prototype = clone(bulk.operationPrototype) as Record<string, unknown>
  const bulkOperationId = Number(bulk.id)
  let failureReason = `Device '${deviceId}' does not exist in inventory!`
  if (data.managedObjects.has(deviceId)) {
    const result = createDocument(data, RESOURCES.devicecontrol, { ...prototype, deviceId, bulkOperationId }, at)
    if (!(result instanceof Response)) {
      return
    }
    failureReason = (result as Response & { message?: string }).message ?? 'Failed to create operation'
  }
  const operation: StoredDocument = { ...prototype, id: data.world.newId(), deviceId, creationTime: at, bulkOperationId, status: 'FAILED', failureReason }
  data.operations.set(operation.id, operation)
}

/**
 * Runs the bulk operations' tasks up to the world's clock: creates the
 * operations that are due and completes finished bulk operations.
 * @param data - Tenant data
 */
export function advanceBulkOperations(data: TenantData): void {
  if (data.bulkOperations.size === 0) {
    return
  }
  const now = Date.parse(data.world.now())
  const { world } = data
  const { actor, now: clock } = world
  for (const stored of [...data.bulkOperations.values()] as StoredBulkOperation[]) {
    if (stored.nextRunAt === undefined || Date.parse(stored.nextRunAt) > now) {
      continue
    }
    // the task works on a copy, stored once it caught up
    const bulk = clone(stored)
    while (bulk.nextRunAt !== undefined && Date.parse(bulk.nextRunAt) <= now) {
      const at = bulk.nextRunAt
      // the task runs at its own time, in the name of the bulk operation's creator
      world.now = () => at
      world.actor = () => bulk.creator
      try {
        if (!runTask(data, bulk, at)) {
          break
        }
      } finally {
        world.now = clock
        world.actor = actor
      }
    }
    data.bulkOperations.set(bulk.id, bulk)
  }
}

/**
 * One step of a bulk operation's task: the next operation, or completion.
 * @param data - Tenant data
 * @param bulk - A copy of the stored bulk operation, changed in place
 * @param at - When the step is due
 * @returns Whether the task goes on
 */
function runTask(data: TenantData, bulk: StoredBulkOperation, at: string): boolean {
  if (bulk.status === 'ACTIVE') {
    bulk.status = 'IN_PROGRESS'
  }
  if (bulk.status !== 'IN_PROGRESS') {
    // deleted: verified against the platform (twice), the task still creates
    // the next due operation after the delete, then stops
    const deviceId = bulk.lastStep ? bulk.queue.shift() : undefined
    if (deviceId !== undefined) {
      createOperation(data, bulk, deviceId, at)
    }
    delete bulk.lastStep
    delete bulk.nextRunAt
    return false
  }
  const deviceId = bulk.queue.shift()
  if (deviceId === undefined) {
    bulk.status = 'COMPLETED'
    delete bulk.nextRunAt
    return false
  }
  createOperation(data, bulk, deviceId, at)
  updateGeneralStatus(data, bulk)
  bulk.nextRunAt = new Date(Date.parse(at) + Number(bulk.creationRamp) * 1000).toISOString()
  return true
}

/**
 * The bulk operation of an id from the URL.
 * @param data - Tenant data
 * @param id - Id from the URL
 * @returns The bulk operation, `undefined` if there is none, or a 422 for an id that is no number
 */
function find(data: TenantData, id: string): StoredBulkOperation | Response | undefined {
  if (!/^-?\d+$/.test(id)) {
    // verified against the platform
    return apiError(422, 'undefined/validationError', `bulkOperationId='${id}' isn't correct; number must be used`)
  }
  return data.bulkOperations.get(String(Number(id))) as StoredBulkOperation | undefined
}

interface BulkInput {
  groupId?: string
  failedParentId?: number
  startDate: string
  creationRamp: number
  operationPrototype: Record<string, unknown>
  note?: string
  custom: Record<string, unknown>
}

/**
 * Validates the creation ramp and the group, and stores a new bulk operation
 * (the platform's `BulkOperationModifyService.create`).
 * @param data - Tenant data
 * @param input - The bulk operation
 * @param deviceIds - Targeted objects; default: the group's child assets
 */
function create(data: TenantData, input: BulkInput, deviceIds?: string[]): StoredBulkOperation | Response {
  if (!(input.creationRamp > 0)) {
    return invalid('Creation ramp must be greater than 0')
  }
  let targets = deviceIds
  if (!targets) {
    const group = data.managedObjects.get(String(input.groupId))
    if (!group) {
      return invalid(`Cannot find group for id='${input.groupId}'`)
    }
    if (group.c8y_DeviceQueryString !== undefined) {
      throw new UnsupportedRequestError('bulk operations on dynamic groups (c8y_DeviceQueryString) are not emulated')
    }
    targets = [...data.children.get(group.id)?.childAssets ?? []]
    if (targets.length === 0) {
      return invalid(`Cannot execute bulk operation on empty group. Group with id='ID [type=com_cumulocity_model_idtype_GId, value=${group.id}]' doesn't have child assets.`)
    }
  }
  const id = String(nextSequence(data, 'bulkOperation'))
  const now = data.world.now()
  const bulk: StoredBulkOperation = {
    ...clone(input.custom),
    id,
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    ...(input.failedParentId !== undefined ? { failedParentId: input.failedParentId } : {}),
    startDate: input.startDate,
    // verified: the ramp is clamped to the system's limits (1 to 3600 seconds)
    creationRamp: Math.min(Math.max(input.creationRamp, 1), 3600),
    operationPrototype: clone(input.operationPrototype),
    status: 'ACTIVE',
    generalStatus: 'SCHEDULED',
    ...(input.note !== undefined ? { note: input.note } : {}),
    deviceIds: [...targets],
    queue: [...targets],
    // a start date in the past starts at once
    nextRunAt: Date.parse(input.startDate) < Date.parse(now) ? now : input.startDate,
  }
  const creator = data.world.actor()
  if (creator !== undefined) {
    bulk.creator = creator
  }
  data.bulkOperations.set(id, bulk)
  auditBulkOperation(data, renderBulkOperation(data, bulk), 'Create', bulk.deviceIds)
  return bulk
}

const PROTOTYPE_SERVER_FIELDS = ['id', 'self', 'deviceId', 'deviceName', 'status', 'failureReason', 'creationTime', 'bulkOperationId']

function parseError(field: string, problem: string): Response {
  return apiError(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`${problem}\` (through reference chain: com.cumulocity.rest.representation.operation.bulk.BulkOperationRepresentation["${field}"])`)
}

/**
 * Reads the body fields of a bulk operation the way the platform's JSON
 * parser does (verified): a numeric string is a number, a scalar note a
 * string, an empty ramp, start date, or parent nothing; other types fail with 400. The prototype
 * loses the fields an operation gets from the platform.
 * @param body - Request body
 * @returns The fields, or a 400 response
 */
function readBody(body: Record<string, unknown>): Record<string, unknown> | Response {
  const fields = { ...body }
  for (const name of ['creationRamp', 'startDate', 'failedParentId']) {
    if (fields[name] === '') {
      fields[name] = undefined
    }
  }
  const { creationRamp, operationPrototype, note, groupId, failedParentId } = fields
  if (creationRamp !== undefined && creationRamp !== null && (typeof creationRamp === 'string' ? Number.isNaN(Number(creationRamp)) : typeof creationRamp !== 'number')) {
    return parseError('creationRamp', 'java.math.BigDecimal')
  }
  if (operationPrototype !== undefined && operationPrototype !== null && (typeof operationPrototype !== 'object' || Array.isArray(operationPrototype))) {
    return parseError('operationPrototype', 'com.cumulocity.rest.representation.operation.OperationRepresentation')
  }
  if (note !== undefined && note !== null && typeof note === 'object') {
    return parseError('note', 'java.lang.String')
  }
  if (groupId !== undefined && groupId !== null && typeof groupId === 'object') {
    return parseError('groupId', 'com.cumulocity.model.idtype.GId')
  }
  if (failedParentId !== undefined && failedParentId !== null && failedParentId !== '' && (typeof failedParentId === 'object' || !/^-?\d+$/.test(String(failedParentId)))) {
    return parseError('failedParentId', 'java.lang.Long')
  }
  if (typeof creationRamp === 'string') {
    fields.creationRamp = Number(creationRamp)
  }
  if (typeof note === 'number' || typeof note === 'boolean') {
    fields.note = String(note)
  }
  if (operationPrototype && typeof operationPrototype === 'object') {
    fields.operationPrototype = Object.fromEntries(Object.entries(operationPrototype).filter(([name]) => !PROTOTYPE_SERVER_FIELDS.includes(name)))
  }
  return fields
}

function badDate(value: unknown): Response {
  return apiError(400, 'Failed to parse JSON string', `Invalid format: ${JSON.stringify(value)} is malformed (through reference chain: com.cumulocity.rest.representation.operation.bulk.BulkOperationRepresentation["startDate"])`)
}

/**
 * `POST /devicecontrol/bulkoperations`: a bulk operation for a group, or a
 * reschedule of the failed operations of another one (`failedParentId`).
 * @param call - The request
 * @param data - Tenant data
 */
function post(call: C8yRequest, data: TenantData): Response {
  const fields = readBody((call.body ?? {}) as Record<string, unknown>)
  if (fields instanceof Response) {
    return fields
  }
  const { id, groupId, failedParentId, startDate, creationRamp, operationPrototype, note, status: _status, generalStatus: _generalStatus, progress: _progress, self: _self, ...custom } = fields
  if (startDate !== undefined && startDate !== null && Number.isNaN(parseIsoTime(startDate))) {
    return badDate(startDate)
  }
  // verified messages; the platform reports one missing field at a time
  if (id !== undefined && id !== null) {
    return apiError(422, 'undefined/validationError', 'id is not allowed here')
  }
  for (const [name, value] of [['creationRamp', creationRamp], ['startDate', startDate], ['operationPrototype', operationPrototype]] as const) {
    if (value === undefined || value === null) {
      return apiError(422, 'undefined/validationError', `${name} is required`)
    }
  }
  const hasGroup = groupId !== undefined && groupId !== null
  const hasParent = failedParentId !== undefined && failedParentId !== null
  if (hasGroup === hasParent) {
    const shown = JSON.stringify({ note: note ?? null, groupId, operationPrototype, failedParentId, creationRamp, startDate })
    return apiError(422, 'undefined/validationError', hasGroup
      ? `bulkOperation=${shown} only one following properties groupId or failedParent can be set`
      : `bulkOperation=${shown} one of the following properties groupId or failedParentId must be set`)
  }
  const input: BulkInput = {
    startDate: new Date(parseIsoTime(startDate)).toISOString(),
    creationRamp: Number(creationRamp),
    operationPrototype: operationPrototype as Record<string, unknown>,
    ...(typeof note === 'string' ? { note } : {}),
    custom,
  }
  let result: StoredBulkOperation | Response
  if (hasGroup) {
    result = create(data, { ...input, groupId: String(groupId) })
  } else {
    // reschedule: the parent's failed operations whose objects are still in its group
    const parent = find(data, String(failedParentId))
    if (parent instanceof Response) {
      return parent
    }
    if (!parent) {
      return notFound(String(failedParentId))
    }
    const progress = progressOf(data, parent)
    if (progress.all === progress.successful) {
      return apiError(422, 'devicecontrol/Invalid Data', 'Cannot reschedule bulk operation. All its operations are successful')
    }
    const inGroup = new Set(data.children.get(String(parent.groupId))?.childAssets ?? [])
    const failed = [...data.operations.values()]
      .filter((operation) => operation.bulkOperationId === Number(parent.id) && operation.status === 'FAILED' && inGroup.has(String(operation.deviceId)))
      .map((operation) => String(operation.deviceId))
    result = create(data, { ...input, groupId: parent.groupId as string, failedParentId: Number(parent.id) }, failed)
  }
  if (result instanceof Response) {
    return result
  }
  const rendered = renderBulkOperation(data, result)
  return Response.json(rendered, { status: 201, headers: { location: String(rendered.self) } })
}

/**
 * `PUT /devicecontrol/bulkoperations/{id}`. Verified: changing the note, ramp,
 * start date, or prototype replaces the bulk operation with a new one (new id,
 * the group's current child assets, custom fragments dropped); the old one is
 * removed, or marked DELETED/CANCELED if it created operations already. A bare
 * `generalStatus` may only turn FAILED into SUCCESSFUL.
 * @param call - The request
 * @param data - Tenant data
 * @param id - Id from the URL
 */
function put(call: C8yRequest, data: TenantData, id: string): Response {
  const body = readBody((call.body ?? {}) as Record<string, unknown>)
  if (body instanceof Response) {
    return body
  }
  const found = find(data, id)
  if (found instanceof Response) {
    return found
  }
  const given = (name: string) => body[name] !== undefined && body[name] !== null
  const changes = ['note', 'creationRamp', 'startDate', 'operationPrototype'].some(given)
  if (!changes && typeof body.generalStatus === 'string' && body.generalStatus !== '') {
    if (!GENERAL_STATUSES.includes(body.generalStatus)) {
      return apiError(500, 'general/internalError', `No enum constant com.cumulocity.model.operation.bulk.BulkOperationGeneralStatus.${body.generalStatus}`)
    }
    if (!found) {
      return notFound(id)
    }
    if (found.generalStatus !== 'FAILED' || body.generalStatus !== 'SUCCESSFUL') {
      return apiError(500, 'devicecontrol/Internal Server Error', 'Manual update general status is possible only from FAILED to SUCCESSFUL')
    }
    const updated = { ...found, generalStatus: 'SUCCESSFUL' }
    data.bulkOperations.set(found.id, updated)
    auditStatusChange(data, updated, 'FAILED')
    return Response.json(renderBulkOperation(data, updated))
  }
  if (!changes) {
    return invalid('It is able to update note, creationRamp, startDateTime, operationPrototype for status ACTIVE or IN_PROGRESS or update general status for general status FAILED')
  }
  if (given('startDate') && Number.isNaN(parseIsoTime(body.startDate))) {
    return badDate(body.startDate)
  }
  if (!found) {
    return notFound(id)
  }
  const group = data.managedObjects.get(String(found.groupId))
  if (!group) {
    return invalid(`Cannot find group for id='${found.groupId}'`)
  }
  const progress = progressOf(data, found)
  const started = progress.pending + progress.executing + progress.successful + progress.failed > 0
  if (started && found.status !== 'ACTIVE' && found.status !== 'IN_PROGRESS') {
    return notActive(id)
  }
  const ramp = Number(body.creationRamp)
  const result = create(data, {
    ...(given('groupId') ? { groupId: String(body.groupId) } : found.groupId !== undefined ? { groupId: String(found.groupId) } : {}),
    ...(found.failedParentId !== undefined ? { failedParentId: found.failedParentId as number } : {}),
    startDate: given('startDate') ? new Date(parseIsoTime(body.startDate)).toISOString() : String(found.startDate),
    creationRamp: given('creationRamp') && ramp > 0 ? ramp : Number(found.creationRamp),
    operationPrototype: (given('operationPrototype') ? body.operationPrototype : found.operationPrototype) as Record<string, unknown>,
    ...(typeof body.note === 'string' && body.note !== '' ? { note: body.note } : typeof found.note === 'string' ? { note: found.note } : {}),
    custom: {},
  })
  if (result instanceof Response) {
    return result
  }
  if (started) {
    const { nextRunAt: _nextRunAt, ...rest } = found
    data.bulkOperations.set(found.id, { ...rest, status: 'DELETED', generalStatus: 'CANCELED' })
    auditDeleted(data, { id: found.id, status: 'DELETED', generalStatus: 'CANCELED', note: null })
  } else {
    data.bulkOperations.delete(found.id)
    // verified: describes the request (status ACTIVE, general status SCHEDULED)
    auditDeleted(data, { id: found.id, status: 'ACTIVE', generalStatus: 'SCHEDULED', note: typeof body.note === 'string' ? body.note : null })
  }
  return Response.json(renderBulkOperation(data, result))
}

/**
 * Bulk operation API: `/devicecontrol/bulkoperations[/{id}]`.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function bulkOperations(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, , id, extra] = segments
  const { method } = call
  if (extra !== undefined) {
    return undefined
  }
  if (id === undefined) {
    if (method === 'GET') {
      checkQuery('GET /devicecontrol/bulkoperations', call, ['currentPage', 'pageSize', 'withTotalElements'])
      // not in the API docs, but supported by the platform: groupId,
      // generalStatus (repeatable), withDeleted (deleted ones are hidden)
      const statuses = raw(call).params.getAll('generalStatus').filter((status) => status.trim() !== '')
      const items = [...data.bulkOperations.values()]
        .filter((bulk) => call.query.withDeleted === 'true' || bulk.status !== 'DELETED')
        .filter((bulk) => !call.query.groupId || bulk.groupId === call.query.groupId)
        .filter((bulk) => statuses.length === 0 || statuses.includes(String(bulk.generalStatus)))
        // verified: newest start date first
        .sort((a, b) => parseIsoTime(b.startDate) - parseIsoTime(a.startDate) || Number(b.id) - Number(a.id))
      return paged(data, call, 'bulkOperations', items, PATH, { render: (bulk) => renderBulkOperation(data, bulk) })
    }
    if (method === 'POST') {
      checkQuery('POST /devicecontrol/bulkoperations', call, [])
      return post(call, data)
    }
    return undefined
  }
  if (method === 'GET') {
    checkQuery('GET /devicecontrol/bulkoperations/{id}', call, [])
    const found = find(data, id)
    if (found instanceof Response) {
      return found
    }
    return found ? Response.json(renderBulkOperation(data, found)) : notFound(id)
  }
  if (method === 'PUT') {
    checkQuery('PUT /devicecontrol/bulkoperations/{id}', call, [])
    return put(call, data, id)
  }
  if (method === 'DELETE') {
    checkQuery('DELETE /devicecontrol/bulkoperations/{id}', call, [])
    const found = find(data, id)
    if (found instanceof Response) {
      return found
    }
    // verified: only a scheduled or running bulk operation can be deleted; it
    // stays readable as DELETED/CANCELED and its operations stay
    if (!found || (found.status !== 'ACTIVE' && found.status !== 'IN_PROGRESS')) {
      return notActive(id)
    }
    const deleted = clone(found)
    if (deleted.status === 'IN_PROGRESS' && deleted.nextRunAt) {
      deleted.lastStep = true
    } else {
      delete deleted.nextRunAt
    }
    deleted.status = 'DELETED'
    deleted.generalStatus = 'CANCELED'
    data.bulkOperations.set(deleted.id, deleted)
    auditDeleted(data, { id: found.id, status: 'DELETED', generalStatus: 'CANCELED', note: null })
    return new Response(null, { status: 204 })
  }
  return undefined
}
