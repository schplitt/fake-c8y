import type { AccessScope } from './access'
import { listed, visible } from './access'
import type { C8yRequest } from '../types'
import type { C8yEndpoint } from '../capabilities.generated'
import type { DocumentCollection, StoredDocument, TenantData, ChildKind } from '../store'
import type { SortedList } from '../collection'
import { CHILD_KINDS, descendants, parentIds } from '../store'
import { C8Y_ENDPOINTS, C8Y_ENUMS } from '../capabilities.generated'
import { apiError, byTime, checkQuery, checkRequired, flag, inRange, paged, parsePlatformDate, raw, sourceId } from './http'
import { ERROR_INFO } from './media'
import { moSelf } from './inventory'
import type { RealtimeApi } from '../realtime'
import { clone, formatIsoTime, invalidTimeMessage, normalizeIsoTime, parseIsoTime } from '../utils'
import { updateGeneralStatus } from './bulkoperations'
import { auditAlarmCreated, auditAlarmUpdated, auditOperation } from './audit'
import type { MeasurementQuery, GeneratedView } from '../generators'
import { dateBounds, documentPoints, generatedView } from '../generators'
import { clearUnavailabilityAlarm, scheduleAvailability } from '../availability'

interface Resource {
  collection: Exclude<DocumentCollection, 'managedObjects'>
  /**
   * URL path of the collection, e.g. `/alarm/alarms`
   */
  path: string
  /**
   * Error code prefix, e.g. `alarm`
   */
  domain: string
  /**
   * Supported list query parameters
   */
  listParams: string[]
}

export type { Resource }

export const RESOURCES: Record<'measurement' | 'event' | 'alarm' | 'devicecontrol', Resource> = {
  measurement: { collection: 'measurements', path: '/measurement/measurements', domain: 'measurement', listParams: ['currentPage', 'dateFrom', 'dateTo', 'pageSize', 'revert', 'source', 'type', 'valueFragmentSeries', 'valueFragmentType', 'withTotalElements', 'withTotalPages'] },
  event: { collection: 'events', path: '/event/events', domain: 'event', listParams: ['createdFrom', 'createdTo', 'currentPage', 'dateFrom', 'dateTo', 'fragmentType', 'fragmentValue', 'lastUpdatedFrom', 'lastUpdatedTo', 'pageSize', 'revert', 'source', 'type', 'withSourceAdditions', 'withSourceAssets', 'withSourceChildren', 'withSourceDevices', 'withTotalElements', 'withTotalPages'] },
  alarm: { collection: 'alarms', path: '/alarm/alarms', domain: 'alarm', listParams: ['createdFrom', 'createdTo', 'currentPage', 'dateFrom', 'dateTo', 'lastUpdatedFrom', 'lastUpdatedTo', 'pageSize', 'resolved', 'severity', 'source', 'status', 'type', 'withSourceAdditions', 'withSourceAssets', 'withSourceChildren', 'withSourceDevices', 'withTotalElements', 'withTotalPages'] },
  devicecontrol: { collection: 'operations', path: '/devicecontrol/operations', domain: 'devicecontrol', listParams: ['agentId', 'bulkOperationId', 'currentPage', 'dateFrom', 'dateTo', 'deviceId', 'fragmentType', 'pageSize', 'revert', 'status', 'withTotalElements', 'withTotalPages'] },
}

/**
 * Stored with an operation: the agent its device had at creation.
 */
const AGENT_ID = '__agentId'

const SERVER_FIELDS = ['id', 'self', 'creationTime', 'lastUpdated', 'count', 'firstOccurrenceTime']

export function renderDocument(data: TenantData, resource: Resource, document: StoredDocument): StoredDocument {
  const rendered: StoredDocument = { ...clone(document), self: `${data.world.baseUrl}${resource.path}/${document.id}` }
  if (resource.collection === 'measurements') {
    // verified: measurements are rendered without a creation time
    delete rendered.creationTime
  }
  delete rendered[AGENT_ID]
  const source = sourceId(document)
  if (source !== undefined) {
    // verified: measurements name no source
    rendered.source = { id: source, self: moSelf(data, source), ...(resource.collection === 'measurements' ? {} : { name: data.managedObjects.get(source)?.name }) }
  }
  if (resource.collection === 'operations' && typeof document.deviceId === 'string') {
    rendered.deviceName = data.managedObjects.get(document.deviceId)?.name
  }
  return rendered
}

function publish(data: TenantData, resource: Resource, action: 'CREATE' | 'UPDATE' | 'DELETE', document: StoredDocument): void {
  const source = resource.collection === 'operations' ? document.deviceId as string | undefined : sourceId(document)
  const payload = action === 'DELETE' ? { id: document.id } : renderDocument(data, resource, document)
  data.world.notify(data, resource.collection as RealtimeApi, action, payload, source)
}

const SCOPES: Record<Resource['collection'], AccessScope> = { measurements: 'MEASUREMENT', events: 'EVENT', alarms: 'ALARM', operations: 'OPERATION' }

/**
 * The filter of a list for a restricted caller (`roles: 'enforce'`), or
 * `undefined` for an unrestricted one.
 * @param data - Tenant data
 * @param resource - The listed resource
 */
function listedBy(data: TenantData, resource: Resource): ((document: StoredDocument) => boolean) | undefined {
  const access = data.world.access()
  const scope = SCOPES[resource.collection]
  return access && ((document) => listed(data, access, scope, document))
}

function notFound(resource: Resource, id: string): Response {
  const name = resource.collection.slice(0, -1)
  // verified: only alarms name themselves, events and operations say "device data"
  const what = resource.collection === 'alarms' ? name : 'device data'
  return apiError(404, `${resource.domain}/Not Found`, `Finding ${what} from database failed : No ${name} for gid '${id}'!`)
}

const DATE_PARAMS = ['dateFrom', 'dateTo', 'createdFrom', 'createdTo', 'lastUpdatedFrom', 'lastUpdatedTo']

/**
 * 422 for date query parameters of the endpoint that are not dates (verified
 * for measurements, events, alarms, and operations; the error has no
 * `message`, and a date parameter the endpoint does not have is ignored).
 * @param call - The request
 * @param endpoint - The endpoint answered
 */
function checkDates(call: C8yRequest, endpoint: C8yEndpoint): Response | undefined {
  const known: readonly string[] = C8Y_ENDPOINTS[endpoint].query
  for (const name of DATE_PARAMS) {
    const value = call.query[name]
    if (value !== undefined && known.includes(name) && Number.isNaN(parsePlatformDate(value))) {
      return Response.json({ error: `${value} is not a valid date./Invalid Data`, info: 'https://cumulocity.com/api/core/' }, { status: 422 })
    }
  }
  return undefined
}

/**
 * A boolean query parameter as alarms and events read it (verified): every
 * value except `false` (in any case) is true, also an empty one.
 * @param call - The request
 * @param name - Parameter name
 */
function notFalse(call: C8yRequest, name: string): boolean {
  const value = call.query[name]
  return value !== undefined && value.toLowerCase() !== 'false'
}

/**
 * Error of a JSON value the platform cannot read into a text field (400).
 * @param value - The value sent
 * @param representation - e.g. `alarm.AlarmRepresentation`
 * @param field - Field name
 */
function notText(value: unknown, representation: string, field: string): Response {
  const token = Array.isArray(value) ? 'Array value (token `JsonToken.START_ARRAY`)' : 'Object value (token `JsonToken.START_OBJECT`)'
  return apiError(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`java.lang.String\` from ${token} (through reference chain: com.cumulocity.rest.representation.${representation}["${field}"])`)
}

/**
 * Reads the text fields of an alarm or event body like the platform
 * (verified): numbers and booleans become strings, objects and arrays answer
 * 400.
 * @param body - Request body
 * @param resource - Alarms or events
 * @returns The body with text fields as strings, or an error response
 */
function textFields(body: Record<string, unknown>, resource: Resource): Record<string, unknown> | Response {
  const fields = resource.collection === 'alarms' ? ['type', 'text', 'severity', 'status'] : ['type', 'text']
  const representation = resource.collection === 'alarms' ? 'alarm.AlarmRepresentation' : 'event.EventRepresentation'
  const result = { ...body }
  for (const field of fields) {
    const value = body[field]
    if (typeof value === 'object' && value !== null) {
      return notText(value, representation, field)
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      result[field] = String(value)
    }
  }
  return result
}

/**
 * Date range match: from inclusive, to exclusive; equal bounds match exactly
 * that instant (verified against the platform).
 * @param value - ISO date of the document
 * @param from - Range start
 * @param to - Range end
 */
function inDateRange(value: unknown, from: string | undefined, to: string | undefined): boolean {
  if (from !== undefined && to !== undefined && parsePlatformDate(from) === parsePlatformDate(to)) {
    return parseIsoTime(value) === parsePlatformDate(from)
  }
  return inRange(value, from, to)
}

function invalid(message: string): Response {
  return apiError(422, 'undefined/validationError', message)
}

/**
 * The body without the fields the platform sets. Measurements and
 * operations have no `lastUpdated` of their own, a given one is stored as
 * sent (verified).
 * @param body - Request body
 * @param resource - The resource
 */
function omitServerFields(body: Record<string, unknown>, resource: Resource): Record<string, unknown> {
  const own = resource.collection === 'measurements' || resource.collection === 'operations'
  return Object.fromEntries(Object.entries(body).filter(([key]) => !SERVER_FIELDS.includes(key) || (own && key === 'lastUpdated')))
}

function omitFields(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !fields.includes(key)))
}

const MEASUREMENT_FIELDS: Array<[string, 'is required' | 'is not allowed here']> = [['source', 'is required'], ['id', 'is not allowed here'], ['creationTime', 'is not allowed here'], ['time', 'is required'], ['type', 'is required']]

/**
 * Validates measurements before any is stored, in the platform's order
 * (verified): JSON parsing (time, source) of every item, then the field
 * rules of every item, then the series values, then the sources. A
 * collection names the failing item and adds `bulkRequest.failedIndex`.
 * @param data - Tenant data
 * @param items - The measurements
 * @param collection - Sent as a measurement collection
 */
function measurementErrors(data: TenantData, items: Array<Record<string, unknown>>, collection: boolean): Response | undefined {
  const at = (index: number) => collection ? `post.measurementCollectionRepresentation.measurements[${index}]` : 'post.measurementRepresentation'
  const failed = (index: number, message: string) => collection
    ? Response.json({ error: 'undefined/validationError', message, info: 'https://cumulocity.com/api/core/', bulkRequest: { failedIndex: index } }, { status: 422 })
    : apiError(422, 'undefined/validationError', message)
  for (const item of items) {
    if (item.source !== undefined && item.source !== null && (typeof item.source !== 'object' || Array.isArray(item.source))) {
      return apiError(400, 'Failed to parse JSON string', `Cannot construct instance of \`com.cumulocity.rest.representation.inventory.ManagedObjectRepresentation\` (although at least one Creator exists): no String-argument constructor/factory method to deserialize from String value ('${String(item.source)}')`)
    }
    if (item.time !== undefined && item.time !== null && Number.isNaN(parseIsoTime(item.time))) {
      // verified: an unparseable time fails JSON parsing on the platform
      return timeError(item.time, 'measurement.MeasurementRepresentation')
    }
  }
  for (const [index, item] of items.entries()) {
    const field = MEASUREMENT_FIELDS.find(([name, rule]) => rule === 'is required' ? item[name] === undefined || item[name] === null : item[name] !== undefined && item[name] !== null)
    if (field) {
      return failed(index, `${at(index)}.${field[0]}: ${field[1]}`)
    }
  }
  for (const item of items) {
    const time = parseIsoTime(item.time)
    if (!Number.isNaN(time) && new Date(time).getUTCFullYear() < 0) {
      // verified: a year before 0 is rejected for measurements only (no message)
      return Response.json({ error: `Invalid date ${formatIsoTime(time)}/Invalid Data`, info: ERROR_INFO }, { status: 422 })
    }
  }
  for (const [index, item] of items.entries()) {
    // verified: a string value is rejected; numbers, null, booleans, arrays, and objects are stored
    const series = Object.values(item).filter((fragment) => typeof fragment === 'object' && fragment !== null && !Array.isArray(fragment)).flatMap((fragment) => Object.values(fragment as Record<string, unknown>))
    if (series.some((entry) => typeof entry === 'object' && entry !== null && typeof (entry as { value?: unknown }).value === 'string')) {
      return failed(index, `${at(index)}: Only numbers are supported as measurement values`)
    }
  }
  for (const item of items) {
    const source = sourceId(item)
    if (source === undefined || source === null) {
      return apiError(422, 'measurement/Invalid Data', 'Invalid value for source argument! : Value cannot be null!')
    }
    if (!data.managedObjects.has(String(source))) {
      return apiError(422, 'measurement/Unprocessable Entity', 'Source object does not exist in inventory. : Finding device data from database failed')
    }
  }
  return undefined
}

/**
 * The body with a `time` sent as a JSON number or boolean read as text, as
 * the platform does (verified): `12345` is the year 12345, `1.5` is invalid.
 * @param body - Request body
 */
function textTime(body: Record<string, unknown>): Record<string, unknown> {
  return typeof body.time === 'number' || typeof body.time === 'boolean' ? { ...body, time: String(body.time) } : body
}

/**
 * 400 for a time the platform cannot read (verified: the parser's message,
 * the field, and the message again).
 * @param value - The time as sent
 * @param representation - e.g. `alarm.AlarmRepresentation`
 */
function timeError(value: unknown, representation: string): Response {
  const message = invalidTimeMessage(value)
  return apiError(400, 'Failed to parse JSON string', `${message} (through reference chain: com.cumulocity.rest.representation.${representation}["time"]) : ${message}`)
}

/**
 * Whether a time has a year above 9999, which the platform stores but cannot
 * read back as an instant (verified: deduplicating into an alarm or an upsert
 * then fails).
 * @param time - Epoch milliseconds
 */
function beyondYear9999(time: number): boolean {
  return time >= Date.UTC(10_000, 0, 1)
}

/**
 * Creates a measurement, event, alarm, or operation with platform semantics
 * (validation, alarm deduplication, operation status PENDING).
 * @param data - Tenant data
 * @param resource - The resource
 * @param body - Request body
 * @param now - Creation time (default: the world's clock)
 * @returns The stored document, or an error response
 */
export function createDocument(data: TenantData, resource: Resource, body: Record<string, unknown>, now: string = data.world.now()): StoredDocument | Response {
  const endpoint = `POST ${resource.path}` as C8yEndpoint
  if (resource.collection !== 'operations') {
    body = textTime(body)
  }
  if (resource.collection === 'measurements') {
    const error = measurementErrors(data, [body], false)
    if (error) {
      return error
    }
    // verified: a type sent as a number is stored as a string
    if (typeof body.type === 'number') {
      body = { ...body, type: String(body.type) }
    }
  }
  if (resource.collection === 'alarms' || resource.collection === 'events') {
    // verified: the missing fields first (one at a time, in an order the
    // platform does not keep stable for alarms; an empty time is missing),
    // then the source
    const representation = resource.collection === 'alarms' ? 'alarmRepresentation' : 'eventRepresentation'
    const fields = resource.collection === 'alarms' ? ['type', 'text', 'severity', 'time'] : ['type', 'text', 'time']
    const missing = fields.find((field) => body[field] === undefined || body[field] === null || (field === 'time' && body[field] === ''))
    if (missing) {
      return invalid(`post.${representation}.${missing}: is required`)
    }
    if (body.source !== undefined && body.source !== null && (typeof body.source !== 'object' || Array.isArray(body.source))) {
      return apiError(400, 'Failed to parse JSON string', `Cannot construct instance of \`com.cumulocity.rest.representation.inventory.ManagedObjectRepresentation\` from ${JSON.stringify(body.source)}`)
    }
    const id = (body.source as { id?: unknown } | null | undefined)?.id
    if (id === undefined || id === null) {
      return resource.collection === 'alarms'
        ? apiError(422, 'alarm/Invalid Data', 'cannot create an alarm without a source')
        : apiError(422, 'event/Invalid Data', 'Invalid value for source argument! : Value cannot be null!')
    }
    const text = textFields(body, resource)
    if (text instanceof Response) {
      return text
    }
    body = text
  } else {
    if (resource.collection === 'operations' && (body.deviceId === undefined || body.deviceId === null)) {
      // verified
      return apiError(422, 'undefined/validationError', 'deviceId is required')
    }
    const missing = checkRequired(endpoint, body)
    if (missing) {
      return missing
    }
  }
  if (resource.collection !== 'operations' && Number.isNaN(parseIsoTime(body.time))) {
    // verified: an unparseable time fails JSON parsing on the platform
    return timeError(body.time, resource.collection === 'alarms' ? 'alarm.AlarmRepresentation' : resource.collection === 'events' ? 'event.EventRepresentation' : 'measurement.MeasurementRepresentation')
  }
  if (resource.collection !== 'operations') {
    // verified: stored and answered in the platform's form, a time without a zone is UTC
    body = { ...body, time: normalizeIsoTime(String(body.time)) }
  }
  if (resource.collection !== 'measurements') {
    // verified: the platform owns these fields, sending them is an error
    const owned = resource.collection === 'operations' ? ['id', 'creationTime', 'status', 'failureReason'] : ['creationTime', 'lastUpdated', 'id']
    const field = owned.find((name) => body[name] !== undefined)
    const prefix = { operations: 'input', alarms: 'alarmRepresentation', events: 'eventRepresentation' }[resource.collection]
    if (field) {
      // verified: operations name the field alone
      return apiError(422, 'undefined/validationError', resource.collection === 'operations' ? `${field} is not allowed here` : `post.${prefix}.${field}: is not allowed here`)
    }
  }
  if (resource.collection === 'operations' && body.bulkOperationId !== undefined && body.bulkOperationId !== null && !/^-?\d+$/.test(String(body.bulkOperationId))) {
    // verified: a number
    return apiError(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`java.lang.Long\` from String "${String(body.bulkOperationId)}": not a valid \`java.lang.Long\` value`)
  }
  // verified: an empty severity is stored as none, and the new alarm answers
  // 500 (the active alarm counters fail on it); a deduplicated one answers 201
  const noSeverity = resource.collection === 'alarms' && body.severity === ''
  if (noSeverity) {
    body = omitFields(body, ['severity'])
  }
  if (resource.collection === 'operations') {
    // verified: at least one property besides the device (the description counts)
    if (Object.keys(body).every((key) => key === 'deviceId')) {
      return apiError(422, 'devicecontrol/Invalid Data', 'weak-typed property must be included in operation')
    }
  }
  // verified: an id sent as a number is accepted and stored as a string
  const rawSource = resource.collection === 'operations' ? body.deviceId : sourceId(body)
  const source = rawSource === undefined || rawSource === null ? undefined : String(rawSource)
  if (source === undefined && resource.collection !== 'operations') {
    return apiError(422, `${resource.domain}/Invalid Data`, 'Source id must not be null')
  }
  if (!data.managedObjects.has(String(source)) && resource.collection !== 'operations') {
    // verified: 404 for alarms, 422 for measurements and events
    return resource.collection === 'alarms'
      ? apiError(404, 'inventory/Not Found', `Finding device data from database failed : No managedObject for id '${String(source)}'!`)
      : apiError(422, `${resource.domain}/Unprocessable Entity`, resource.collection === 'events' ? 'Source object does not exist in inventory. : Finding device data from database failed' : 'Source object does not exist in inventory.')
  }

  if (resource.collection === 'operations' && !data.managedObjects.has(String(source))) {
    // verified against the platform
    return apiError(422, 'devicecontrol/Unprocessable Entity', `Device '${String(source)}' does not exist in inventory! : Finding device data from database failed`)
  }
  const agent = resource.collection === 'operations' ? agentOf(data, String(source)) : undefined
  if (resource.collection === 'operations' && agent === undefined) {
    // verified against the platform
    return apiError(422, 'devicecontrol/Unprocessable Entity', `Agent for device '${String(source)}' does not exist in inventory!`)
  }

  if (resource.collection === 'alarms') {
    // The platform does not validate alarm severity/status values (verified:
    // 'SEVERE', 'BOGUS', 'constructor', and 'minor' are stored as given on
    // create, update, and upsert), so neither does the fake.
    // Deduplication: an active or acknowledged alarm of the same source and
    // type is updated (count, time) instead of creating a new one.
    const existing = openAlarm(data, String(source), String(body.type))
    if (existing && body.status !== 'CLEARED') {
      // verified: a time beyond 9999 fails, the stored one or the new one
      if (beyondYear9999(parseIsoTime(body.time)) || beyondYear9999(parseIsoTime(existing.time))) {
        return apiError(422, 'alarm/Invalid Data', 'Error updating duplicate alarm! : Failed to parse string as a date')
      }
      // verified: text, severity, and status stay; time is the latest and
      // firstOccurrenceTime the earliest of all occurrences
      const updated = data.alarms.update(existing.id, (alarm) => {
        const first = String(alarm.firstOccurrenceTime ?? alarm.time)
        alarm.firstOccurrenceTime = parseIsoTime(body.time) < parseIsoTime(first) ? body.time : first
        alarm.count = (alarm.count as number) + 1
        if (parseIsoTime(body.time) > parseIsoTime(alarm.time)) {
          alarm.time = body.time
        }
        alarm.lastUpdated = now
      })!
      refreshActiveAlarms(data, String(source))
      recordTraffic(data, String(source))
      publish(data, resource, 'UPDATE', updated)
      return updated
    }
  }

  const document: StoredDocument = {
    ...omitServerFields(body, resource),
    id: data.world.newId(resource.collection === 'measurements' ? 'measurement' : 'document'),
    creationTime: now,
  }
  if (source !== undefined && resource.collection !== 'operations') {
    document.source = { id: String(source) }
  }
  // verified: measurements and operations have no lastUpdated
  if (resource.collection !== 'measurements' && resource.collection !== 'operations') {
    document.lastUpdated = now
  }
  if (resource.collection === 'alarms') {
    document.status ??= 'ACTIVE'
    document.count = 1
  }
  if (resource.collection === 'operations') {
    document.deviceId = source
    document.status = 'PENDING'
    delete document.failureReason
    // verified: `agentId` lists the operations of the agent the device had
    // when the operation was created (kept with the operation, not rendered)
    document[AGENT_ID] = agent
  }
  data[resource.collection].set(document.id, document)
  if (resource.collection === 'alarms') {
    refreshActiveAlarms(data, String(source))
    auditAlarmCreated(data, document)
  }
  if (resource.collection !== 'operations') {
    recordTraffic(data, String(source))
  }
  if (resource.collection === 'operations') {
    auditOperation(data, document, 'created')
  }
  publish(data, resource, 'CREATE', document)
  if (noSeverity) {
    return apiError(500, 'alarm/Internal Server Error', 'Cannot invoke "com.cumulocity.model.event.Severity.name()" because the return value of "java.util.Map$Entry.getKey()" is null')
  }
  return document
}

const ALARM_STATUS_KEYS = ['critical', 'major', 'minor', 'warning']

/**
 * Recalculates `c8y_ActiveAlarmsStatus` of an alarm source after an alarm
 * write, as the platform does at once (verified): the number of ACTIVE and
 * ACKNOWLEDGED alarms per severity, keyed by the severity in lower case. The
 * four standard keys are always present and keys once written stay at 0. An
 * unknown severity counts under its lower-case name, while a standard one in
 * other case (`major`, `Minor`) is not counted. The fragment appears with the
 * first counted alarm; the object's `lastUpdated` does not change.
 * @param data - Tenant data
 * @param source - Managed object id
 */
function refreshActiveAlarms(data: TenantData, source: string): void {
  activeAlarmsOf(data, source, alarmsBySource(data)(source))
}

const alarmSource = (alarm: StoredDocument): string | undefined => sourceId(alarm)

/**
 * The alarm ids of a source, in collection order (an index that every
 * alarm write keeps up to date).
 * @param data - Tenant data
 */
export function alarmsBySource(data: TenantData): (source: string) => readonly string[] {
  return data.alarms.groupedBy(alarmSource)
}

/**
 * The open (not CLEARED) alarm of a source and type that a new one is
 * deduplicated into: with several (a cleared one set ACTIVE again), the one
 * with the earliest time (verified).
 * @param data - Tenant data
 * @param source - Managed object id
 * @param type - Alarm type
 */
function openAlarm(data: TenantData, source: string, type: string): Readonly<StoredDocument> | undefined {
  let found: Readonly<StoredDocument> | undefined
  for (const key of alarmsBySource(data)(source)) {
    const alarm = data.alarms.get(key)!
    if (alarm.type === type && alarm.status !== 'CLEARED' && (!found || parseIsoTime(alarm.time) < parseIsoTime(found.time))) {
      found = alarm
    }
  }
  return found
}

/**
 * `refreshActiveAlarms()` with the source's alarm ids known.
 * @param data - Tenant data
 * @param source - Managed object id
 * @param alarmIds - Ids of the source's alarms
 */
export function activeAlarmsOf(data: TenantData, source: string, alarmIds: readonly string[]): void {
  const document = data.managedObjects.get(source)
  if (!document) {
    return
  }
  const counts = new Map<string, number>()
  for (const alarm of alarmIds.map((id) => data.alarms.get(id)).filter((alarm) => alarm !== undefined)) {
    if (sourceId(alarm) !== source || (alarm.status !== 'ACTIVE' && alarm.status !== 'ACKNOWLEDGED') || alarm.severity === undefined) {
      continue
    }
    const severity = String(alarm.severity)
    const key = severity.toLowerCase()
    if (severity !== key.toUpperCase() && ALARM_STATUS_KEYS.includes(key)) {
      continue
    }
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const previous = document.c8y_ActiveAlarmsStatus as Record<string, number> | undefined
  if (!previous && counts.size === 0) {
    return
  }
  const keys = [...new Set([...ALARM_STATUS_KEYS, ...Object.keys(previous ?? {}), ...counts.keys()])].sort()
  const status = Object.fromEntries(keys.map((key) => [key, counts.get(key) ?? 0]))
  if (JSON.stringify(status) !== JSON.stringify(previous)) {
    data.managedObjects.set(source, { ...document, c8y_ActiveAlarmsStatus: status })
  }
}

/**
 * Marks incoming data on a source with `c8y_RequiredAvailability`:
 * `c8y_Availability.lastMessage` becomes now and the status AVAILABLE unless
 * in maintenance. Data is a measurement, event, or alarm sent through the
 * API, or an update of the device without changes (`{}` or only its `id`);
 * operations and real updates are not (verified). The platform does this
 * asynchronously, a few seconds after the write. Seeding does not count, and
 * neither does a request with the `X-Cumulocity-Application-Key` header
 * (from the docs, unverified).
 * @param data - Tenant data
 * @param source - Managed object id
 */
export function recordTraffic(data: TenantData, source: string): void {
  const document = data.managedObjects.get(source)
  const interval = (document?.c8y_RequiredAvailability as { responseInterval?: unknown } | undefined)?.responseInterval
  const request = data.world.request()
  if (!document || data.world.actor() === undefined || typeof interval !== 'number' || request?.headers['x-cumulocity-application-key'] !== undefined) {
    return
  }
  const now = data.world.now()
  data.managedObjects.set(source, { ...document, c8y_Availability: { lastMessage: now, status: interval <= 0 ? 'MAINTENANCE' : 'AVAILABLE' } })
  if ((document.c8y_Availability as { status?: unknown } | undefined)?.status === 'UNAVAILABLE') {
    clearUnavailabilityAlarm(data, source, parseIsoTime(now))
  }
  scheduleAvailability(data, source)
}

/**
 * Publishes an alarm change on Notification 2.0.
 * @param data - Tenant data
 * @param action - The change
 * @param alarm - The stored alarm
 */
export function publishAlarm(data: TenantData, action: 'CREATE' | 'UPDATE', alarm: StoredDocument): void {
  publish(data, RESOURCES.alarm, action, alarm)
}

/**
 * The agent of a device: the device itself if it is an agent
 * (`com_cumulocity_model_Agent`), otherwise the nearest agent among its
 * device parents, which the platform requires for operations.
 * @param data - Tenant data
 * @param deviceId - Device id
 * @param seen
 */
function agentOf(data: TenantData, deviceId: string, seen = new Set<string>()): string | undefined {
  if (seen.has(deviceId)) {
    return undefined
  }
  seen.add(deviceId)
  if (data.managedObjects.get(deviceId)?.com_cumulocity_model_Agent !== undefined) {
    return deviceId
  }
  for (const parent of parentIds(data, deviceId, 'childDevices')) {
    const agent = agentOf(data, parent, seen)
    if (agent !== undefined) {
      return agent
    }
  }
  return undefined
}

/**
 * The agent an operation belongs to (operations stored without one, e.g.
 * failed bulk operation ones, use the device's current agent).
 * @param data - Tenant data
 * @param operation - Stored operation
 */
function operationAgent(data: TenantData, operation: StoredDocument): string | undefined {
  return (operation[AGENT_ID] as string | undefined) ?? agentOf(data, String(operation.deviceId))
}

/**
 * Applies an update to a stored document (fragments merged, `null` removes)
 * and stores the result.
 * @param data - Tenant data
 * @param resource - The resource
 * @param stored - Stored document
 * @param body - Update
 * @returns The updated document, or an error response if the update is invalid
 */
export function updateDocument(data: TenantData, resource: Resource, stored: StoredDocument, body: Record<string, unknown>): StoredDocument | Response {
  const before = resource.collection === 'alarms' ? stored : undefined
  const document = clone(stored)
  // verified: an operation update ignores the bulk operation and the device name
  const readOnly = resource.collection === 'operations' ? ['deviceId', 'deviceName', 'bulkOperationId', AGENT_ID] : ['source', 'time', 'type']
  if (resource.collection === 'operations') {
    // verified against the platform: messages and order
    if (body.status === undefined || body.status === null) {
      return apiError(422, 'undefined/validationError', 'status is required')
    }
    const fixed = ['deviceId', 'creationTime'].find((field) => body[field] !== undefined && body[field] !== null)
    if (fixed) {
      return apiError(422, 'undefined/validationError', `${fixed} is not allowed here`)
    }
    if (!C8Y_ENUMS.operationStatus.includes(body.status as any)) {
      return apiError(422, 'Operation API/Invalid Data', 'Operation Status value is not correct. Allowed values: [PENDING, SUCCESSFUL, FAILED, EXECUTING]')
    }
    if (body.failureReason !== undefined && body.failureReason !== null && body.status !== 'FAILED') {
      return apiError(422, 'devicecontrol/Invalid Data', 'Invalid value for failureReason argument! : Should be set only when operation status is FAILED!')
    }
    if (body.status !== 'FAILED') {
      delete document.failureReason
    }
    if (body.failureReason !== undefined && body.failureReason !== null && typeof body.failureReason !== 'string') {
      // verified: stored as a string
      body = { ...body, failureReason: String(body.failureReason) }
    }
  }
  if (resource.collection === 'alarms') {
    // verified: these are rejected; source, id, and self are ignored
    const fixed = ['type', 'time', 'count', 'creationTime', 'lastUpdated', 'firstOccurrenceTime'].find((field) => body[field] !== undefined)
    if (fixed) {
      return apiError(422, 'undefined/validationError', `put.alarm.${fixed}: is not allowed here`)
    }
  }
  for (const [key, value] of Object.entries(omitServerFields(body, resource))) {
    if (readOnly.includes(key)) {
      continue
    }
    if (value === null && (key === 'text' || (resource.collection === 'alarms' && (key === 'severity' || key === 'status'))) && resource.collection !== 'operations') {
      // verified: `null` keeps the text (and an alarm's severity and status)
      continue
    }
    if (value === null) {
      delete document[key]
    } else {
      document[key] = value
    }
  }
  if (resource.collection !== 'measurements' && resource.collection !== 'operations') {
    document.lastUpdated = data.world.now()
  }
  data[resource.collection].set(document.id, document)
  if (before) {
    refreshActiveAlarms(data, String(sourceId(document)))
    auditAlarmUpdated(data, before, document)
  }
  if (resource.collection === 'operations') {
    auditOperation(data, document, 'updated')
  }
  publish(data, resource, 'UPDATE', document)
  if (resource.collection === 'operations' && typeof document.bulkOperationId === 'number') {
    // verified: an operation update recalculates its bulk operation's general status
    const bulk = data.bulkOperations.get(String(document.bulkOperationId))
    if (bulk) {
      const draft = clone(bulk)
      if (updateGeneralStatus(data, draft)) {
        data.bulkOperations.set(draft.id, draft)
      }
    }
  }
  return document
}

/**
 * Event updates the platform rejects (verified against the platform).
 * @param call - The request
 * @param id - Event id from the URL
 * @param body - Update
 */
function checkEventUpdate(call: C8yRequest, id: string, body: Record<string, unknown>): Response | undefined {
  const mediaError = unsupportedMediaType(call, RESOURCES.event)
  if (mediaError) {
    return mediaError
  }
  if (body.id !== undefined && String(body.id) !== id) {
    return apiError(422, 'event/Invalid Data', 'Id from representation must be the same like in url')
  }
  // verified: `null` for these is ignored
  if (body.source !== undefined && body.source !== null) {
    return apiError(422, 'event/Invalid Data', 'Invalid value for source argument! : Value must be null!')
  }
  const forbidden = ['time', 'type', 'creationTime', 'lastUpdated'].find((field) => body[field] !== undefined && body[field] !== null)
  if (forbidden) {
    return apiError(422, 'undefined/validationError', `put.eventRepresentation.${forbidden}: is not allowed here`)
  }
  return undefined
}

const SOURCE_KINDS: Array<[string, ChildKind[]]> = [
  ['withSourceDevices', ['childDevices']],
  ['withSourceAssets', ['childAssets']],
  ['withSourceAdditions', ['childAdditions']],
  ['withSourceChildren', CHILD_KINDS],
]

/**
 * The sources a `source` filter selects: the object itself and, with
 * `withSourceDevices`/`withSourceAssets`/`withSourceAdditions`/
 * `withSourceChildren`, its children of that kind, recursively.
 * @param call - The request
 * @param data - Tenant data
 * @param source - The `source` parameter
 */
function relatedSources(call: C8yRequest, data: TenantData, source: string): Set<string> {
  return descendants(data, [source], SOURCE_KINDS.filter(([name]) => flag(call, name)).flatMap(([, kinds]) => kinds))
}

/**
 * 404 for a `source` that does not exist, when a `withSource*` parameter asks
 * for its children (verified: without one, an unknown source is an empty page;
 * the bulk alarm update never answers 404), and 422 for a `withSource*`
 * parameter without a `source` (verified for alarms and events).
 * @param call - The request
 * @param data - Tenant data
 * @param resource - The resource
 */
function unknownSource(call: C8yRequest, data: TenantData, resource: Resource): Response | undefined {
  const withChildren = SOURCE_KINDS.some(([name]) => flag(call, name))
  if (!call.query.source && withChildren) {
    return apiError(422, `${resource.domain}/Invalid Data`, `Cannot fetch children ${resource.collection} if parameter 'source' is not specified!`)
  }
  if (call.query.source && withChildren && !data.managedObjects.has(call.query.source)) {
    return apiError(404, 'inventory/Not Found', `Finding device data from database failed : No managedObject for id '${call.query.source}'!`)
  }
  return undefined
}

/**
 * Whether a measurement has a series with a numeric value in this fragment
 * (and of this name).
 * @param document - Stored measurement
 * @param fragment - Fragment name
 * @param series - Series name
 */
function hasValueFragment(document: StoredDocument, fragment: string, series?: string): boolean {
  const value = Object.hasOwn(document, fragment) ? document[fragment] : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const entries = series === undefined ? Object.values(value) : Object.hasOwn(value, series) ? [(value as Record<string, unknown>)[series]] : []
  return entries.some((entry) => typeof entry === 'object' && entry !== null && typeof (entry as { value?: unknown }).value === 'number')
}

// `sourceId` itself is the cache key, so inventory's supportedSeries shares the index
const bySource: (document: StoredDocument) => string | undefined = sourceId
const oldestFirst = (document: StoredDocument): number => parseIsoTime(document.time)
const newestFirst = (document: StoredDocument): number => -parseIsoTime(document.time)

/**
 * The stored documents a list, count, bulk update, or delete by filter
 * matches, in the platform's order.
 * @param request - The request
 * @param data - Tenant data
 * @param resource - The resource
 * @param endpoint - The endpoint answered: only its query parameters filter
 */
function list(request: C8yRequest, data: TenantData, resource: Resource, endpoint: C8yEndpoint): SortedList<StoredDocument> {
  // verified: a parameter the endpoint does not have is ignored (operations
  // ?source=, bulk alarm update ?type=, measurements ?status=); measurements
  // also filter by fragmentType, which their spec does not list
  const known = new Set<string>([...C8Y_ENDPOINTS[endpoint].query, ...(endpoint === 'GET /measurement/measurements' ? ['fragmentType'] : [])])
  const call: C8yRequest = { ...request, query: Object.fromEntries(Object.entries(request.query).filter(([name]) => known.has(name))) }
  const { query } = call
  const values = (name: string) => query[name]?.split(',').map((value) => value.trim())
  const collection = data[resource.collection]

  // Orders (verified against the platform): measurements and events newest
  // first; `revert` only matters together with a date range (measurements:
  // revert=false → oldest first, events: revert=true → oldest first). Alarms
  // newest first, operations in creation order. Equal times: events the last
  // created first when newest first, otherwise the first created first
  // (`default-order`).
  const revert = flag(call, 'revert')
  const hasRange = query.dateFrom !== undefined || query.dateTo !== undefined
  // verified: events read revert as true unless `false`, and any date range counts
  const eventsOldestFirst = notFalse(call, 'revert') && DATE_PARAMS.some((name) => query[name] !== undefined)
  const timeOrder = {
    measurements: !(hasRange && query.revert?.toLowerCase() === 'false'),
    events: !eventsOldestFirst,
    alarms: true,
    operations: undefined,
  }[resource.collection]
  // newest first with the last created first: the reverse of oldest first
  const lastCreatedFirst = resource.collection === 'events' && timeOrder === true

  // a single source comes from the source index (a short list, sorted at the
  // end); otherwise filters run over the time order, which a frozen base
  // keeps (filtering keeps the order)
  const measurements = resource.collection === 'measurements'
  if (measurements && query.source === '') {
    // verified: an empty source matches nothing
    return []
  }
  let items: readonly StoredDocument[] = []
  // the time order of the whole collection, read lazily until a filter applies
  let view: SortedList<StoredDocument> | undefined
  const keep = (test: (document: StoredDocument) => boolean) => {
    items = (view ? [...view] : items).filter(test)
    view = undefined
  }
  let sorted = false
  const sources = query.source ? relatedSources(call, data, query.source) : undefined
  if (sources?.size === 1) {
    const keys = collection.groupedBy(bySource)(query.source!)
    items = keys.map((key) => collection.get(key)!)
  } else if (timeOrder !== undefined && sources === undefined) {
    view = lastCreatedFirst ? collection.sortedBy(oldestFirst, { reverse: true }) : collection.sortedBy(timeOrder ? newestFirst : oldestFirst)
    sorted = true
  } else {
    items = [...collection.values()]
  }

  if (sources && sources.size > 1) {
    keep((document) => sources.has(sourceId(document) ?? ''))
  }
  if (query.deviceId) {
    keep((document) => document.deviceId === query.deviceId)
  }
  if (query.agentId) {
    keep((document) => operationAgent(data, document) === query.agentId)
  }
  if (query.bulkOperationId) {
    keep((document) => document.bulkOperationId === Number(query.bulkOperationId))
  }
  if (measurements && query.type !== undefined) {
    // verified: one type, compared as a whole (also an empty one)
    keep((document) => document.type === query.type)
  } else if (query.type) {
    // verified: events take one type (a comma is part of it)
    const types = resource.collection === 'events' ? [query.type] : values('type')!
    keep((document) => types.includes(String(document.type)))
  }
  // verified: alarm status and severity filters ignore case
  const alarms = resource.collection === 'alarms'
  const upper = (value: unknown) => alarms ? String(value).toUpperCase() : String(value)
  if (query.status && !(alarms && query.resolved !== undefined)) {
    // operations: one status only (lists are rejected in documents());
    // verified: `resolved` replaces an alarm status filter
    const statuses = resource.collection === 'operations' ? [query.status] : values('status')!.map(upper)
    keep((document) => statuses.includes(upper(document.status)))
  }
  if (query.severity) {
    // verified: only the alarm list takes a list of severities; the count,
    // bulk update, and delete by filter match nothing for one
    const severities = values('severity')!.map(upper)
    const single = endpoint === 'GET /alarm/alarms' || severities.length === 1
    items = single ? items.filter((document) => severities.includes(upper(document.severity))) : []
  }
  if (query.resolved !== undefined) {
    const resolved = notFalse(call, 'resolved')
    keep((document) => (upper(document.status) === 'CLEARED') === resolved)
  }
  if (measurements) {
    // verified: measurement filters only see series with a numeric value
    if (query.fragmentType) {
      keep((document) => hasValueFragment(document, query.fragmentType!))
    }
    if (query.valueFragmentType) {
      keep((document) => hasValueFragment(document, query.valueFragmentType!, query.valueFragmentSeries || undefined))
    } else if (query.valueFragmentSeries) {
      keep((document) => Object.keys(document).some((fragment) => fragment !== 'source' && hasValueFragment(document, fragment, query.valueFragmentSeries)))
    }
  } else if (query.fragmentType) {
    keep((document) => Object.hasOwn(document, query.fragmentType!) && document[query.fragmentType!] !== undefined)
  }
  if (query.fragmentValue && query.fragmentType) {
    // verified: the fragment must be this exact string (numbers, booleans, and objects never match)
    keep((document) => Object.hasOwn(document, query.fragmentType!) && document[query.fragmentType!] === query.fragmentValue)
  }
  const timeField = resource.collection === 'operations' ? 'creationTime' : 'time'
  if (query.dateFrom !== undefined || query.dateTo !== undefined) {
    keep((document) => inDateRange(document[timeField], query.dateFrom, query.dateTo))
  }
  if (query.createdFrom !== undefined || query.createdTo !== undefined) {
    keep((document) => inDateRange(document.creationTime, query.createdFrom, query.createdTo))
  }
  if (query.lastUpdatedFrom !== undefined || query.lastUpdatedTo !== undefined) {
    keep((document) => inDateRange(document.lastUpdated, query.lastUpdatedFrom, query.lastUpdatedTo))
  }

  if (timeOrder === undefined) {
    // verified: operations in creation order (ascending ids, which the
    // counter keeps); revert needs a date range
    return hasRange && revert ? [...items].reverse() : items
  }
  if (sorted) {
    return view ?? items
  }
  return lastCreatedFirst ? byTime([...items].reverse(), 'time', true) : byTime(items, 'time', timeOrder)
}

/**
 * The measurement filter of a list or delete request, as `list()` applies it.
 * @param call - The request
 * @param data - Tenant data
 * @param fragment - `valueFragmentType` (list) or `fragmentType` (delete)
 */
function measurementQuery(call: C8yRequest, data: TenantData, fragment: 'valueFragmentType' | 'fragmentType'): MeasurementQuery {
  const { query } = call
  const fragmentType = query[fragment]
  const bound = (name: string) => query[name] === undefined ? undefined : parsePlatformDate(query[name]!)
  return {
    ...(query.source ? { sources: relatedSources(call, data, query.source) } : {}),
    // verified: one type, compared as a whole
    ...(query.type !== undefined ? { types: [query.type] } : {}),
    ...(fragmentType ? { valueFragmentType: fragmentType } : {}),
    ...(fragment === 'valueFragmentType' && query.valueFragmentSeries ? { valueFragmentSeries: query.valueFragmentSeries } : {}),
    // verified: a list also filters by fragmentType (not in its spec)
    ...(fragment === 'valueFragmentType' && query.fragmentType ? { fragmentType: query.fragmentType } : {}),
    ...dateBounds(bound('dateFrom'), bound('dateTo')),
  }
}

/**
 * Whether a Notification 2.0 subscription may receive measurement
 * notifications of these sources.
 * @param data - Tenant data
 * @param sources - Sources (`undefined`: all)
 */
function listening(data: TenantData, sources: ReadonlySet<string> | undefined): boolean {
  return [...data.notificationSubscriptions.values()].some((subscription) => {
    const apis = subscription.subscriptionFilter?.apis ?? ['*']
    return (apis.includes('*') || apis.includes('measurements'))
      && (subscription.context !== 'mo' || !sources || sources.has(String(subscription.source?.id)))
  })
}

/**
 * `DELETE /measurement/measurements` with generated measurements: deletes the
 * stored matches and adds a range tombstone for the generated ones. The
 * deleted documents are listed only when a subscription may want to hear
 * about them.
 * @param target - The request (equal bounds already widened to the hour)
 * @param data - Tenant data
 * @param view - The generated measurements
 */
function deleteMeasurements(target: C8yRequest, data: TenantData, view: GeneratedView): void {
  const resource = RESOURCES.measurement
  const q = measurementQuery(target, data, 'fragmentType')
  const stored = [...list(target, data, resource, 'DELETE /measurement/measurements')]
  const count = view.total(q)
  const hasRange = target.query.dateFrom !== undefined || target.query.dateTo !== undefined
  const deleted = listening(data, q.sources) ? view.list(q, stored, !(hasRange && target.query.revert?.toLowerCase() === 'false')).page(0, Infinity) : stored
  for (const document of deleted) {
    data.measurements.delete(document.id)
    publish(data, resource, 'DELETE', document)
  }
  if (count > 0) {
    const { source, type, fragmentType } = target.query
    data.measurementTombstones.set(`range#${data.measurementTombstones.size}`, {
      kind: 'range',
      ...(source ? { source } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(fragmentType ? { fragmentType } : {}),
      ...(q.dateFrom !== undefined ? { dateFrom: new Date(q.dateFrom).toISOString() } : {}),
      ...(q.dateTo !== undefined ? { dateTo: new Date(q.dateTo).toISOString() } : {}),
      until: new Date(view.now).toISOString(),
      count,
    })
  }
}

/**
 * An empty 415 for a request body the platform does not read (verified):
 * alarm and event writes take any JSON content type; measurements and
 * operations only JSON or a vendor type of the resource.
 * @param call - The request
 * @param resource - The resource
 */
function unsupportedMediaType(call: C8yRequest, resource: Resource): Response | undefined {
  const contentType = call.headers['content-type'] ?? ''
  if (resource.collection === 'alarms' || resource.collection === 'events') {
    return contentType && !/json/i.test(contentType) ? new Response(null, { status: 415 }) : undefined
  }
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  const vendor = resource.collection === 'measurements' ? ['measurement', 'measurementcollection'] : ['operation']
  if (type === '' || type === 'application/json' || vendor.some((name) => type === `application/vnd.com.nsn.cumulocity.${name}+json`)) {
    return undefined
  }
  return new Response(null, { status: 415 })
}

/**
 * `POST /measurement/measurements` with the measurement collection type:
 * every item is validated before any is stored (verified: one invalid item,
 * also an unknown source, stores none).
 * @param data - Tenant data
 * @param body - The request body
 */
function postMeasurementCollection(data: TenantData, body: Record<string, unknown>): Response {
  const resource = RESOURCES.measurement
  const items = body.measurements
  if (items === undefined || items === null) {
    // verified: the platform answers 500
    return apiError(500, 'general/internalError', 'Cannot invoke "java.util.List.size()" because the return value of "com.cumulocity.rest.representation.measurement.MeasurementCollectionRepresentation.getMeasurements()" is null')
  }
  if (!Array.isArray(items) || items.some((item) => item !== null && (typeof item !== 'object' || Array.isArray(item)))) {
    return apiError(400, 'Failed to parse JSON string', 'Cannot deserialize value of type `java.util.ArrayList<com.cumulocity.rest.representation.measurement.MeasurementRepresentation>` (through reference chain: com.cumulocity.rest.representation.measurement.MeasurementCollectionRepresentation["measurements"])')
  }
  if (items.includes(null)) {
    return apiError(500, 'general/internalError', 'Cannot invoke "com.cumulocity.rest.representation.measurement.MeasurementRepresentation.getDateTime()" because "measurementRepresentation" is null')
  }
  const texts = (items as Array<Record<string, unknown>>).map(textTime)
  const error = measurementErrors(data, texts, true)
  if (error) {
    return error
  }
  const created: StoredDocument[] = []
  for (const item of texts) {
    const result = createDocument(data, resource, item)
    if (result instanceof Response) {
      return result
    }
    created.push(result)
  }
  return Response.json({ measurements: created.map((document) => renderDocument(data, resource, document)) }, { status: 201 })
}

/**
 * Operation list filters the platform rejects (verified): an unknown status
 * (also in other case) and `agentId` together with `deviceId`. A
 * `bulkOperationId` that is no integer answers an empty 404.
 * @param call - The request
 */
function operationFilterError(call: C8yRequest): Response | undefined {
  const { query } = call
  if (query.status && !C8Y_ENUMS.operationStatus.includes(query.status as any)) {
    return invalid(`Incorrect argument:  : No enum constant com.cumulocity.model.operation.OperationStatus.${query.status}`)
  }
  if (query.agentId && query.deviceId) {
    return apiError(422, 'devicecontrol/Invalid Data', 'cannot find by agentId and deviceId, only one parameter is possible')
  }
  if (query.bulkOperationId && !/^-?\d+$/.test(query.bulkOperationId)) {
    return new Response(null, { status: 404 })
  }
  return undefined
}

/**
 * Measurement, event, alarm, and operation APIs.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 * @param resource - The resource
 */
export function documents(call: C8yRequest, segments: string[], data: TenantData, resource: Resource): Response | undefined {
  const [, , id, extra] = segments
  const { method } = call
  const collection = data[resource.collection]
  const body = (call.body ?? {}) as Record<string, unknown>

  if (extra !== undefined) {
    return undefined
  }

  if (id === 'series' && resource.collection === 'measurements' && method === 'GET') {
    return series(call, data)
  }

  if (id === 'count' && resource.collection === 'alarms' && method === 'GET') {
    checkQuery('GET /alarm/alarms/count', call, ['dateFrom', 'dateTo', 'resolved', 'severity', 'source', 'status', 'type', 'withSourceAdditions', 'withSourceAssets', 'withSourceChildren', 'withSourceDevices'])
    const error = checkDates(call, 'GET /alarm/alarms/count') ?? unknownSource(call, data, resource)
    if (error) {
      return error
    }
    // verified: the list filters apply, but a comma-separated severity
    // (accepted by the list) counts nothing; the answer is a bare JSON number
    const counted = list(call, data, resource, 'GET /alarm/alarms/count')
    const access = data.world.access()
    return Response.json(access ? visible(counted, (document: StoredDocument) => listed(data, access, 'ALARM', document)).length : counted.length)
  }

  if (id === 'upsert' && resource.collection === 'alarms') {
    // verified: the other methods answer 405
    return method === 'POST' ? upsertAlarm(call, data) : new Response(null, { status: 405 })
  }

  if (id === undefined) {
    if (method === 'DELETE' && (resource.collection === 'measurements' || resource.collection === 'events')) {
      const supported = resource.collection === 'measurements'
        ? ['dateFrom', 'dateTo', 'fragmentType', 'source', 'type']
        : ['createdFrom', 'createdTo', 'dateFrom', 'dateTo', 'fragmentType', 'source', 'type']
      checkQuery(`DELETE ${resource.path}` as C8yEndpoint, call, supported)
      const dateError = checkDates(call, `DELETE ${resource.path}` as C8yEndpoint)
      if (dateError) {
        return dateError
      }
      if (resource.collection === 'measurements') {
        // verified: full hours in the zone given (`03:00+05:30` is fine)
        const unaligned = ['dateFrom', 'dateTo'].some((name) => /T\d{1,2}:(?!0{1,2}:0{1,2}(?:\.0*)?(?:[Zz+-]|$))/.test(call.query[name] ?? ''))
        if (unaligned) {
          return apiError(422, 'measurement/Invalid Data', 'Date from and date to parameters used for delete filter must be truncated to hour!')
        }
        if (call.query.source === '') {
          // verified: an empty source matches nothing
          return new Response(null, { status: 204 })
        }
      }
      let target = call
      const { dateFrom, dateTo } = call.query
      if (resource.collection === 'measurements' && dateFrom !== undefined && dateTo !== undefined && parsePlatformDate(dateFrom) === parsePlatformDate(dateTo)) {
        // verified: equal bounds delete the whole hour
        target = { ...call, query: { ...call.query, dateTo: new Date(parsePlatformDate(dateFrom) + 3_600_000).toISOString() } }
      }
      const view = resource.collection === 'measurements' ? generatedView(data) : undefined
      if (view) {
        deleteMeasurements(target, data, view)
        return new Response(null, { status: 204 })
      }
      for (const document of [...list(target, data, resource, `DELETE ${resource.path}` as C8yEndpoint)]) {
        collection.delete(document.id)
        data.eventBinaries.delete(document.id)
        publish(data, resource, 'DELETE', document)
      }
      return new Response(null, { status: 204 })
    }
    if (method === 'DELETE' && (resource.collection === 'operations' || resource.collection === 'alarms')) {
      return deleteByFilter(call, data, resource)
    }
    if (method === 'GET') {
      checkQuery(`GET ${resource.path}` as C8yEndpoint, call, resource.listParams)
      const dateError = checkDates(call, `GET ${resource.path}` as C8yEndpoint)
      if (dateError) {
        return dateError
      }
      const sourceError = unknownSource(call, data, resource)
      if (sourceError) {
        return sourceError
      }
      if (resource.collection === 'events' && call.query.fragmentValue && !call.query.fragmentType) {
        // verified
        return apiError(422, 'event/Invalid Data', 'Cannot filter by \'fragmentValue\' when \'fragmentType\' is not specified!')
      }
      if (resource.collection === 'operations') {
        const error = operationFilterError(call)
        if (error) {
          return error
        }
      }
      if (resource.collection === 'measurements' && call.query.source === '') {
        // verified: an empty source matches nothing
        return paged(data, call, resource.collection, [], resource.path)
      }
      const view = resource.collection === 'measurements' ? generatedView(data) : undefined
      if (view) {
        // generated history: count and render only the page
        const hasRange = call.query.dateFrom !== undefined || call.query.dateTo !== undefined
        const merged = view.list(measurementQuery(call, data, 'valueFragmentType'), [...list(call, data, resource, 'GET /measurement/measurements')], !(hasRange && call.query.revert?.toLowerCase() === 'false'))
        const items = {
          get length() {
            return merged.total()
          },
          slice: (start: number, end: number) => merged.page(start, end - start),
        }
        return paged(data, call, resource.collection, visible(items, listedBy(data, resource)), resource.path, { render: (document) => renderDocument(data, resource, document) })
      }
      return paged(data, call, resource.collection, visible(list(call, data, resource, `GET ${resource.path}` as C8yEndpoint), listedBy(data, resource)), resource.path, { render: (document) => renderDocument(data, resource, document) })
    }
    if (method === 'POST') {
      checkQuery(`POST ${resource.path}` as C8yEndpoint, call, [])
      const mediaError = unsupportedMediaType(call, resource)
      if (mediaError) {
        return mediaError
      }
      if (resource.collection === 'measurements' && /measurementcollection\+json/i.test(call.headers['content-type'] ?? '')) {
        return postMeasurementCollection(data, body)
      }
      const result = createDocument(data, resource, body)
      return result instanceof Response ? result : Response.json(renderDocument(data, resource, result), { status: 201 })
    }
    if (method === 'PUT' && resource.collection === 'alarms') {
      checkQuery('PUT /alarm/alarms', call, ['createdFrom', 'createdTo', 'dateFrom', 'dateTo', 'resolved', 'severity', 'source', 'status', 'withSourceAdditions', 'withSourceAssets', 'withSourceChildren', 'withSourceDevices'])
      const dateError = checkDates(call, 'PUT /alarm/alarms')
      if (dateError) {
        return dateError
      }
      // verified: the status is mandatory and the only field applied (an
      // unknown source is a no-op, even with withSource*)
      if (typeof call.body === 'string') {
        // verified: read as JSON whatever the content type
        return apiError(400, 'Failed to parse JSON string', `Unrecognized token '${call.body.trim().split(/[\s,:{}[\]]/)[0]}': was expecting (JSON String, Number, Array, Object or token 'null', 'true' or 'false')`)
      }
      if (body.status === undefined || body.status === null) {
        return invalid('Missing status for bulk alarm update. Desired new status must be set')
      }
      for (const alarm of [...list(call, data, resource, 'PUT /alarm/alarms')]) {
        const result = updateDocument(data, resource, alarm, { status: body.status })
        if (result instanceof Response) {
          return result
        }
      }
      return new Response(null, { status: 200 })
    }
    return undefined
  }

  const document = collection.get(id)
  const detail = `${resource.path}/{id}`
  if (method === 'GET') {
    checkQuery(`GET ${detail}` as C8yEndpoint, call, [])
    if (resource.collection === 'measurements') {
      // verified: time series persistence (the default) cannot read single measurements
      return apiError(405, 'measurement/Method Not Allowed', 'Find by id is not supported by time series measurements!')
    }
    if (!document) {
      return notFound(resource, id)
    }
    const rendered = renderDocument(data, resource, document)
    if (resource.collection === 'operations') {
      // verified: a single read has no device name
      delete rendered.deviceName
    }
    if (resource.collection === 'events') {
      // verified: nor the source name of a single event
      delete (rendered.source as { name?: unknown }).name
    }
    return Response.json(rendered)
  }
  if (method === 'PUT' && resource.collection !== 'measurements') {
    checkQuery(`PUT ${detail}` as C8yEndpoint, call, [])
    const mediaError = resource.collection === 'operations' ? unsupportedMediaType(call, resource) : undefined
    if (mediaError) {
      return mediaError
    }
    if (!document) {
      return notFound(resource, id)
    }
    if (resource.collection === 'operations' && (body.status === undefined || body.status === null)) {
      return apiError(422, 'undefined/validationError', 'status is required')
    }
    if (resource.collection === 'operations' && agentOf(data, String(document.deviceId)) === undefined) {
      // verified: also an update needs the device's agent (e.g. a bulk
      // operation's FAILED operation for an object without one)
      return apiError(422, 'devicecontrol/Unprocessable Entity', `Agent for device '${String(document.deviceId)}' does not exist in inventory!`)
    }
    if (resource.collection === 'events') {
      const error = checkEventUpdate(call, id, body)
      if (error) {
        return error
      }
    }
    let update = body
    if (resource.collection === 'alarms' || resource.collection === 'events') {
      const text = unsupportedMediaType(call, resource) ?? textFields(body, resource)
      if (text instanceof Response) {
        return text
      }
      update = text
    }
    const result = updateDocument(data, resource, document, update)
    if (result instanceof Response) {
      return result
    }
    if (resource.collection === 'operations' && typeof result.bulkOperationId === 'number' && !data.bulkOperations.has(String(result.bulkOperationId))) {
      // verified: the update is stored, but recalculating the missing bulk operation fails
      return apiError(500, 'general/internalError', `Cannot find document with ID ${result.bulkOperationId}`)
    }
    return Response.json(renderDocument(data, resource, result))
  }
  if (method === 'DELETE' && (resource.collection === 'measurements' || resource.collection === 'events')) {
    checkQuery(`DELETE ${detail}` as C8yEndpoint, call, [])
    if (!document || !collection.delete(id)) {
      const generated = resource.collection === 'measurements' ? generatedView(data)?.get(id) : undefined
      if (generated) {
        data.measurementTombstones.set(id, { kind: 'point', id, document: generated })
        publish(data, resource, 'DELETE', generated)
        return new Response(null, { status: 204 })
      }
      return notFound(resource, id)
    }
    data.eventBinaries.delete(id)
    publish(data, resource, 'DELETE', document)
    return new Response(null, { status: 204 })
  }
  return undefined
}

/**
 * `DELETE /devicecontrol/operations` and `DELETE /alarm/alarms` by filter
 * (204 also without matches).
 * @param call - The request
 * @param data - Tenant data
 * @param resource - Operations or alarms
 */
function deleteByFilter(call: C8yRequest, data: TenantData, resource: Resource): Response {
  const { query } = call
  if (resource.collection === 'operations') {
    checkQuery('DELETE /devicecontrol/operations', call, ['agentId', 'dateFrom', 'dateTo', 'deviceId', 'status'])
  } else {
    checkQuery('DELETE /alarm/alarms', call, ['createdFrom', 'createdTo', 'dateFrom', 'dateTo', 'resolved', 'severity', 'source', 'status', 'type', 'withSourceAdditions', 'withSourceAssets', 'withSourceChildren', 'withSourceDevices'])
  }
  const dateError = checkDates(call, `DELETE ${resource.path}` as C8yEndpoint)
  if (dateError) {
    return dateError
  }
  if (resource.collection === 'operations') {
    // verified: one known status (agentId and deviceId together select the
    // operations of both); without any filter every operation is deleted
    // (platform source, not tried on a tenant)
    if (query.status && !C8Y_ENUMS.operationStatus.includes(query.status as any)) {
      return invalid(`Incorrect argument:  : No enum constant com.cumulocity.model.operation.OperationStatus.${query.status}`)
    }
  } else {
    // platform source: a source or a date range is required, and children need a source
    if (['source', 'createdFrom', 'createdTo', 'dateFrom', 'dateTo'].every((name) => !query[name])) {
      return apiError(422, 'alarm/Unprocessable Entity', 'At least one parameter from [source, createdFrom, createdTo, dateFrom, dateTo] has to be provided')
    }
    if (!query.source && SOURCE_KINDS.some(([name]) => flag(call, name))) {
      return apiError(422, 'alarm/Invalid Data', 'Cannot fetch children alarms if parameter \'source\' is not specified!')
    }
  }
  // verified: the alarms of the source's children are not deleted (withSource* is ignored)
  const target = resource.collection === 'alarms'
    ? { ...call, query: Object.fromEntries(Object.entries(query).filter(([name]) => !SOURCE_KINDS.some(([kind]) => kind === name))) }
    : call
  const sources = new Set<string>()
  for (const document of [...list(target, data, resource, `DELETE ${resource.path}` as C8yEndpoint)]) {
    data[resource.collection].delete(document.id)
    sources.add(String(sourceId(document)))
    publish(data, resource, 'DELETE', document)
  }
  if (resource.collection === 'alarms') {
    for (const source of sources) {
      refreshActiveAlarms(data, source)
    }
  }
  return new Response(null, { status: 204 })
}

const INTERVAL_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
const AGGREGATION_TYPES: Record<string, string> = { MINUTELY: '1m', HOURLY: '1h', DAILY: '1d' }
const SERIES_LIMIT = 5000

/**
 * Fixed-size buckets are counted from 2000-01-01T00:00Z (a Saturday), weeks
 * from the Sunday after, months from January 2000. Verified: `1d` starts at UTC midnight, `1w` on Sundays
 * (calendar weeks), `7d` on Saturdays.
 */
const BUCKET_ANCHOR = Date.UTC(2000, 0, 1)
const WEEK_ANCHOR = Date.UTC(2000, 0, 2)

/**
 * Start of the aggregation bucket a time falls into (UTC, see `BUCKET_ANCHOR`).
 * @param time - Epoch milliseconds
 * @param interval - e.g. `15m`, `1h`, `1w`, `1M`
 */
function bucketStart(time: number, interval: string): number {
  const match = /^([1-9]\d{0,2})([smhdwMqy])$/.exec(interval)
  if (!match) {
    throw new TypeError(interval)
  }
  const amount = Number(match[1])
  const unit = match[2]!
  if (unit in INTERVAL_MS) {
    const size = amount * INTERVAL_MS[unit]!
    const anchor = unit === 'w' ? WEEK_ANCHOR : BUCKET_ANCHOR
    return anchor + Math.floor((time - anchor) / size) * size
  }
  const date = new Date(time)
  const months = { M: amount, q: amount * 3, y: amount * 12 }[unit as 'M' | 'q' | 'y']
  const index = (date.getUTCFullYear() - 2000) * 12 + date.getUTCMonth()
  const start = Math.floor(index / months) * months
  const result = new Date(0)
  result.setUTCFullYear(2000 + Math.floor(start / 12), ((start % 12) + 12) % 12, 1)
  return result.getTime()
}

function aggregate(values: number[], fn: string): number {
  const sum = values.reduce((total, value) => total + value, 0)
  const avg = sum / values.length
  const variance = (divisor: number) => values.reduce((total, value) => total + (value - avg) ** 2, 0) / divisor
  switch (fn) {
    // not Math.min(...values): it throws for very long lists
    case 'min': return values.reduce((a, b) => Math.min(a, b))
    case 'max': return values.reduce((a, b) => Math.max(a, b))
    case 'sum': return sum
    case 'avg': return avg
    case 'count': return values.length
    case 'stdDevPop': return Math.sqrt(variance(values.length))
    default: return values.length > 1 ? Math.sqrt(variance(values.length - 1)) : 0
  }
}

/**
 * `GET /measurement/measurements/series`: values of a source's series in a
 * period, optionally aggregated per interval.
 * @param call - The request
 * @param data - Tenant data
 */
function series(call: C8yRequest, data: TenantData): Response {
  checkQuery('GET /measurement/measurements/series', call, ['aggregationFunction', 'aggregationInterval', 'aggregationType', 'dateFrom', 'dateTo', 'revert', 'series', 'source'])
  const { query } = call
  const params = raw(call).params
  // validation order and messages verified against the platform
  if (query.source === undefined || !query.dateFrom || !query.dateTo) {
    return apiError(400, 'measurement/Bad Request', 'The query parameters source, dateFrom and dateTo are required for this request.')
  }
  const dateError = checkDates(call, 'GET /measurement/measurements/series')
  if (dateError) {
    return dateError
  }
  // verified: an interval wins over the type, which is then not checked;
  // types and functions in any case
  const type = query.aggregationInterval === undefined && query.aggregationType !== undefined ? Object.keys(AGGREGATION_TYPES).find((name) => name === query.aggregationType!.toUpperCase()) : undefined
  const interval = query.aggregationInterval ?? (type ? AGGREGATION_TYPES[type] : undefined)
  if (query.aggregationInterval !== undefined && !/^[1-9]\d{0,2}[smhdwMqy]$/.test(query.aggregationInterval)) {
    return apiError(422, 'measurements/Invalid Data', `Invalid aggregation interval: ${query.aggregationInterval}`)
  }
  if (query.aggregationInterval === undefined && query.aggregationType !== undefined && !type) {
    return apiError(400, 'measurements/Bad Request', 'The aggregationType param value is incorrect. Possible values: [HOURLY, DAILY, MINUTELY]')
  }
  const functions: string[] = []
  for (const value of params.getAll('aggregationFunction')) {
    const fn = C8Y_ENUMS.seriesAggregationFunction.find((name) => name.toLowerCase() === value.toLowerCase())
    if (!fn) {
      return apiError(400, 'measurements/Bad Request', 'The aggregationFunction param value is incorrect. Possible values: [min, max, avg, sum, count, stdDevPop, stdDevSamp]')
    }
    functions.push(fn)
  }
  if (functions.length > 0 && !interval) {
    // verified: 422 (the docs say 400)
    return apiError(422, 'measurements/Invalid Data', 'Cannot specify aggregation functions if `aggregationType` is not provided!')
  }
  const badSeries = params.getAll('series').find((value) => !/^[^.]+\.[^.]+$/.test(value))
  if (badSeries !== undefined) {
    return apiError(422, 'measurement/Unprocessable Entity', `The series param ${badSeries} has wrong format. Valid format is measurement_type.series_name`)
  }
  const wanted = params.getAll('series')

  // series = fragment.series pairs with a numeric `value`, in creation order
  const source = query.source!
  const stored = [...data.measurements.values()].filter((measurement) => sourceId(measurement) === source && inDateRange(measurement.time, query.dateFrom, query.dateTo))
  const view = generatedView(data)
  const points = view
    ? view.points({ sources: new Set([source]), ...dateBounds(parsePlatformDate(query.dateFrom!), parsePlatformDate(query.dateTo!)) }, stored)
    : stored.flatMap(documentPoints)
  // verified: a series has the smallest unit (as a string, '' without one)
  // of its values in its newest bucket, or with revert=false in its oldest
  // bucket (without aggregation every time is a bucket)
  const oldestBucket = query.revert?.toLowerCase() === 'false'
  const seriesList: Array<{ key: string, name: string, type: string, unit: string, bucket: number }> = []
  const known = new Map<string, (typeof seriesList)[number]>()
  const buckets = new Map<number, Map<string, number[]>>()
  for (const point of points) {
    const key = `${point.fragment}.${point.name}`
    if (wanted.length > 0 && !wanted.includes(key)) {
      continue
    }
    const time = interval ? bucketStart(point.time, interval) : point.time
    const unit = point.unit === undefined || point.unit === null ? '' : String(point.unit)
    const item = known.get(key)
    if (!item) {
      const added = { key, name: point.name, type: point.fragment, unit, bucket: time }
      known.set(key, added)
      seriesList.push(added)
    } else if (oldestBucket ? time < item.bucket : time > item.bucket) {
      Object.assign(item, { unit, bucket: time })
    } else if (time === item.bucket && unit !== '' && (item.unit === '' || unit < item.unit)) {
      item.unit = unit
    }
    let bucket = buckets.get(time)
    if (!bucket) {
      bucket = new Map()
      buckets.set(time, bucket)
    }
    const list = bucket.get(key)
    if (list) {
      list.push(point.value)
    } else {
      bucket.set(key, [point.value])
    }
  }
  // always oldest first, `revert` is ignored; at most the latest 5000 times
  // (verified against the platform)
  const sortedTimes = [...buckets.keys()].sort((a, b) => a - b)
  const truncated = sortedTimes.length > SERIES_LIMIT
  const times = truncated ? sortedTimes.slice(-SERIES_LIMIT) : sortedTimes
  const fns = functions.length > 0 ? functions : ['min', 'max']
  const values: Record<string, Array<Record<string, number> | null>> = {}
  for (const time of times) {
    const bucket = buckets.get(time)!
    values[formatIsoTime(time)] = seriesList.map((item) => {
      const numbers = bucket.get(item.key)
      if (numbers) {
        return Object.fromEntries(fns.map((fn) => [fn, aggregate(numbers, fn)]))
      }
      // verified: a series without values in a bucket keeps only its `sum`
      // and `count` (0); without those (e.g. min/max) the entry is null
      const zeros = fns.filter((fn) => fn === 'sum' || fn === 'count')
      return zeros.length > 0 ? Object.fromEntries(zeros.map((fn) => [fn, 0])) : null
    })
  }
  return Response.json({
    values,
    series: seriesList.map(({ name, type, unit }) => ({ name, type, unit })),
    truncated,
  })
}

const UPSERT = 'upsert.upsertRepresentation'
const UPSERT_TYPE = 'alarm.AlarmUpsertRepresentation'
const UPSERT_PROHIBITED = ['count', 'creationTime', 'firstOccurrenceTime', 'id', 'lastUpdated']

/**
 * `POST /alarm/alarms/upsert` (verified): updates the open alarm of the
 * source and type (the one `POST /alarm/alarms` would deduplicate into) or
 * creates one. A new alarm defaults to MAJOR, ACTIVE, an empty text, and the
 * current time. An update applies text, severity, status, and fragments,
 * ignores the time, and counts up only with `incrementCount=true`; it is
 * audited also when nothing changed. Severity and status are not validated.
 * Answers `{ alarm, previousState }`, 201 for a new alarm, 200 for an update.
 * @param call - The request
 * @param data - Tenant data
 */
function upsertAlarm(call: C8yRequest, data: TenantData): Response {
  checkQuery('POST /alarm/alarms/upsert', call, ['incrementCount'])
  const mediaError = unsupportedMediaType(call, RESOURCES.alarm)
  if (mediaError) {
    return mediaError
  }
  // verified: the answer is an upsert response, not an alarm
  const accept = call.headers.accept
  if (accept && !accept.split(',').some((type) => /^\s*(?:\*\/\*|application\/\*|application\/json|application\/vnd\.com\.nsn\.cumulocity\.alarmupsertresponse\+json)\s*(?:;|$)/i.test(type))) {
    return new Response(null, { status: 406 })
  }
  let body = textTime((call.body ?? {}) as Record<string, unknown>)
  // JSON reading first (400), then the field rules (422)
  if (body.source !== undefined && body.source !== null && (typeof body.source !== 'object' || Array.isArray(body.source))) {
    return apiError(400, 'Failed to parse JSON string', `Cannot construct instance of \`com.cumulocity.rest.representation.${UPSERT_TYPE}$Source\` (although at least one Creator exists): no String-argument constructor/factory method to deserialize from String value ('${String(body.source)}') (through reference chain: com.cumulocity.rest.representation.${UPSERT_TYPE}["source"])`)
  }
  for (const field of ['type', 'text', 'severity', 'status']) {
    const value = body[field]
    if (typeof value === 'object' && value !== null) {
      return notText(value, UPSERT_TYPE, field)
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      body = { ...body, [field]: String(value) }
    }
  }
  const hasTime = body.time !== undefined && body.time !== null
  if (hasTime && Number.isNaN(parseIsoTime(body.time))) {
    return timeError(body.time, UPSERT_TYPE)
  }
  const sourceRef = body.source as { id?: unknown } | null | undefined
  if (sourceRef === undefined || sourceRef === null) {
    return invalid(`${UPSERT}.source: is required`)
  }
  if (body.type === undefined || body.type === null) {
    return invalid(`${UPSERT}.type: is required`)
  }
  if (sourceRef.id === undefined || sourceRef.id === null) {
    return invalid(`${UPSERT}.source.id: is required`)
  }
  const prohibited = UPSERT_PROHIBITED.filter((field) => body[field] !== undefined)
  if (prohibited.length > 0) {
    return invalid(`${UPSERT}: Field 'customProperties' contains prohibited keys: ${prohibited.join(', ')}`)
  }
  const source = String(sourceRef.id)
  if (!data.managedObjects.has(source)) {
    return apiError(404, 'inventory/Not Found', `Finding device data from database failed : No managedObject for id '${source}'!`)
  }
  const time = hasTime ? normalizeIsoTime(String(body.time)) : undefined
  if (time !== undefined && beyondYear9999(parseIsoTime(time))) {
    // verified: the time is read as an instant, which needs a `+` above 9999
    return apiError(500, 'general/internalError', `Failed to parse string as a date : Text '${formatIsoTime(parseIsoTime(time))}' could not be parsed at index 0`)
  }
  const now = data.world.now()
  const type = String(body.type)
  const fragments = omitFields(body, ['source', 'type', 'text', 'severity', 'status', 'time', 'self'])
  const existing = openAlarm(data, source, type)
  if (!existing) {
    const alarm: StoredDocument = {
      ...fragments,
      type,
      text: body.text ?? '',
      // verified: an empty severity is the default too
      severity: body.severity === undefined || body.severity === null || body.severity === '' ? 'MAJOR' : body.severity,
      status: body.status ?? 'ACTIVE',
      time: time ?? now,
      id: data.world.newId(),
      creationTime: now,
      lastUpdated: now,
      count: 1,
      source: { id: source },
    }
    data.alarms.set(alarm.id, alarm)
    refreshActiveAlarms(data, source)
    auditAlarmCreated(data, alarm)
    publish(data, RESOURCES.alarm, 'CREATE', alarm)
    return Response.json({ alarm: renderDocument(data, RESOURCES.alarm, alarm), previousState: null }, { status: 201 })
  }
  const updated = clone(existing) as StoredDocument
  for (const field of ['text', 'severity', 'status']) {
    // verified: `null` keeps the value
    if (body[field] !== undefined && body[field] !== null) {
      updated[field] = body[field]
    }
  }
  for (const [key, value] of Object.entries(fragments)) {
    if (value === null) {
      delete updated[key]
    } else {
      updated[key] = value
    }
  }
  // verified: only `true` (in any case) counts up, and without a first occurrence
  if (call.query.incrementCount?.toLowerCase() === 'true') {
    updated.count = (updated.count as number) + 1
  }
  updated.lastUpdated = now
  data.alarms.set(updated.id, updated)
  refreshActiveAlarms(data, source)
  auditAlarmUpdated(data, existing as StoredDocument, updated, true)
  publish(data, RESOURCES.alarm, 'UPDATE', updated)
  return Response.json({ alarm: renderDocument(data, RESOURCES.alarm, updated), previousState: renderDocument(data, RESOURCES.alarm, existing as StoredDocument) })
}
