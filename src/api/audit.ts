/**
 * Audit API and the audit hook the write paths call.
 *
 * The platform writes audit records itself (verified on a tenant, see the
 * table in docs/platform-behavior.md): alarm creation and changes, operation
 * creation and updates, managed object and tenant option deletion, Notification
 * 2.0 subscriptions and tokens, users, inventory roles, global role
 * permissions, and bulk operations. Creating or updating a managed object,
 * events, measurements, retention rules, new device requests, user groups
 * themselves, and creating or updating tenant options write none. Records are
 * only written while answering a request; world helpers (`seed()`,
 * `device()`, `db.operations.update()`) write none.
 */
import { listed, visible } from './access'
import type { C8yRequest } from '../types'
import type { StoredDocument, TenantData } from '../store'
import { apiError, checkQuery, inRange, paged, parsePlatformDate, sourceId } from './http'
import { clone, invalidTimeMessage, normalizeIsoTime, parseIsoTime } from '../utils'

/**
 * One changed attribute of an audit record.
 */
export interface AuditChange {
  attribute: string
  /**
   * The platform's type name of the value.
   */
  type?: string | null
  previousValue: unknown
  newValue: unknown
  /**
   * `ADDED`, `REMOVED`, `REPLACED`; user and application records carry it,
   * alarm records do not.
   */
  changeType?: string
}

/**
 * What a write path knows about an audit record; the hook adds id, user,
 * and creation time.
 */
export interface AuditInput {
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
   * Id of the changed object (for options `category.key`, for users the user
   * name). Some records have none (Notification 2.0 tokens).
   */
  source?: string
  severity?: string
  changes?: AuditChange[]
  /**
   * Defaults to now.
   */
  time?: string
  /**
   * Defaults to the user of the request being answered.
   */
  user?: string
  /**
   * Written by the platform itself (availability monitoring): no `user`,
   * also outside a request.
   */
  system?: boolean
  application?: string
  /**
   * Further fragments, e.g. `com_cumulocity_model_event_AuditSourceDevice`.
   */
  fragments?: Record<string, unknown>
}

/**
 * Writes an audit record like the platform does for a write. Does nothing
 * outside a request (world helpers write no audit records).
 * @param data - Tenant data
 * @param input - The record
 * @returns The stored record, if one was written
 */
export function recordAudit(data: TenantData, input: AuditInput): StoredDocument | undefined {
  const user = input.user ?? data.world.actor()
  if (user === undefined && !input.system) {
    return undefined
  }
  const now = data.world.now()
  const record: StoredDocument = {
    id: data.world.newId(),
    type: input.type,
    text: input.text,
    ...(input.system ? {} : { user }),
    ...(input.application !== undefined ? { application: input.application } : {}),
    activity: input.activity,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.changes ? { changes: input.changes } : {}),
    ...(input.source !== undefined ? { source: { id: input.source } } : {}),
    time: input.time ?? now,
    creationTime: now,
    ...input.fragments,
  }
  data.auditRecords.set(record.id, record)
  return record
}

/**
 * The platform's type name for a value in `changes[].type`.
 * @param value - Any JSON value
 */
function javaType(value: unknown): string {
  if (typeof value === 'string') {
    return 'java.lang.String'
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'java.lang.Long' : 'java.lang.Double'
  }
  if (typeof value === 'boolean') {
    return 'java.lang.Boolean'
  }
  return Array.isArray(value) ? 'java.util.ArrayList' : 'java.util.LinkedHashMap'
}

/**
 * A value as the platform writes it in `changes[]` (verified): scalars as
 * strings, objects as they are, missing as `null`.
 * @param value - Any JSON value
 */
function changeValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null
  }
  return typeof value === 'object' ? clone(value) : String(value)
}

/**
 * The standard values of an alarm's `severity` and `status`, in the order of
 * their ordinals (from 1), and the type names of a standard and of another
 * value.
 */
const ALARM_ENUMS: Record<string, { values: readonly string[], type: string, other: string }> = {
  severity: { values: ['CRITICAL', 'MAJOR', 'MINOR', 'WARNING'], type: 'com.cumulocity.model.event.CumulocitySeverities', other: 'com.cumulocity.model.event.SeverityImpl' },
  status: { values: ['ACTIVE', 'ACKNOWLEDGED', 'CLEARED'], type: 'com.cumulocity.model.event.CumulocityAlarmStatuses', other: 'com.cumulocity.model.event.AlarmStatusImpl' },
}

/**
 * One change of an alarm attribute. A `severity` or `status` value that is
 * not a standard one in upper case shows as `{ ordinal }` (the standard
 * value it matches in any case, from 1, else `null`), and the type is the
 * class of the previous value (verified).
 * @param attribute - The attribute
 * @param previous - The value before
 * @param next - The value after
 */
function alarmChange(attribute: string, previous: unknown, next: unknown): AuditChange {
  const enumeration = Object.hasOwn(ALARM_ENUMS, attribute) ? ALARM_ENUMS[attribute] : undefined
  if (!enumeration) {
    return { attribute, type: javaType(next ?? previous), previousValue: changeValue(previous), newValue: changeValue(next) }
  }
  const standard = (value: unknown): boolean => typeof value === 'string' && enumeration.values.includes(value)
  const render = (value: unknown): unknown => {
    if (value === undefined || value === null || standard(value)) {
      return changeValue(value)
    }
    const ordinal = enumeration.values.indexOf(String(value).toUpperCase())
    return { ordinal: ordinal === -1 ? null : ordinal + 1 }
  }
  return { attribute, type: previous === undefined || previous === null || standard(previous) ? enumeration.type : enumeration.other, previousValue: render(previous), newValue: render(next) }
}

function deviceFragment(id: string | undefined): Record<string, unknown> {
  return id === undefined ? {} : { com_cumulocity_model_event_AuditSourceDevice: { _id: id } }
}

function alarmText(data: TenantData, alarm: StoredDocument): string {
  // verified: without a device name only the alarm text
  const name = data.managedObjects.get(sourceId(alarm) ?? '')?.name
  return name === undefined ? String(alarm.text) : `Device name: '${String(name)}', alarm text: '${String(alarm.text)}'`
}

/**
 * Audit record of a new alarm (not of one absorbed by deduplication).
 * @param data - Tenant data
 * @param alarm - The stored alarm
 * @param system
 */
export function auditAlarmCreated(data: TenantData, alarm: StoredDocument, system = false): void {
  recordAudit(data, {
    system,
    type: 'Alarm',
    activity: 'Alarm created',
    text: alarmText(data, alarm),
    severity: String(alarm.severity),
    source: alarm.id,
    time: String(alarm.time),
    fragments: deviceFragment(sourceId(alarm)),
  })
}

/**
 * Audit record of an alarm update: text and severity as before the update,
 * one change per attribute that changed, none if nothing changed (verified).
 * A severity change leaves the status change out and is followed by two
 * `SYSTEM` "Availability monitoring record" records of the user: the status
 * before the update to CLEARED with the old severity and text, then one
 * without changes with the new ones (verified, also when the
 * status stays or the alarm was CLEARED already).
 * @param data - Tenant data
 * @param before - The alarm before the update
 * @param after - The alarm after the update
 * @param always - Also without changes (verified for upserts: `changes: []`)
 * @param system - Written by the platform (no user)
 */
export function auditAlarmUpdated(data: TenantData, before: StoredDocument, after: StoredDocument, always = false, system = false): void {
  const severityChanged = !system && JSON.stringify(before.severity) !== JSON.stringify(after.severity)
  const ignored = new Set(['id', 'self', 'lastUpdated', 'creationTime', 'count', 'firstOccurrenceTime', 'source', 'time', 'type', ...(severityChanged ? ['status'] : [])])
  const changes: AuditChange[] = []
  for (const attribute of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const previous = Object.hasOwn(before, attribute) ? before[attribute] : undefined
    const next = Object.hasOwn(after, attribute) ? after[attribute] : undefined
    if (ignored.has(attribute) || JSON.stringify(previous) === JSON.stringify(next)) {
      continue
    }
    changes.push(alarmChange(attribute, previous, next))
  }
  if (changes.length === 0 && !always) {
    return
  }
  const record = { source: after.id, time: String(after.time), fragments: deviceFragment(sourceId(after)) }
  recordAudit(data, { ...record, system, type: 'Alarm', activity: 'Alarm updated', text: alarmText(data, before), severity: String(before.severity), changes })
  if (severityChanged) {
    recordAudit(data, { ...record, type: 'SYSTEM', activity: 'Availability monitoring record', text: alarmText(data, before), severity: String(before.severity), changes: [alarmChange('status', before.status, 'CLEARED')] })
    recordAudit(data, { ...record, type: 'SYSTEM', activity: 'Availability monitoring record', text: alarmText(data, after), severity: String(after.severity) })
  }
}

/**
 * Audit record of an operation's creation or update, e.g.
 * `Operation updated: status='FAILED', failure reason='x', description='Restart', device name='Pump'.`
 * @param data - Tenant data
 * @param operation - The stored operation (after the write)
 * @param action - `created` or `updated`
 */
export function auditOperation(data: TenantData, operation: StoredDocument, action: 'created' | 'updated'): void {
  const deviceId = operation.deviceId as string | undefined
  const deviceName = data.managedObjects.get(deviceId ?? '')?.name
  const parts = [
    `status='${String(operation.status)}'`,
    ...(operation.failureReason !== undefined ? [`failure reason='${String(operation.failureReason)}'`] : []),
    ...(operation.description !== undefined ? [`description='${String(operation.description)}'`] : []),
    ...(deviceName !== undefined ? [`device name='${String(deviceName)}'`] : []),
  ]
  recordAudit(data, {
    type: 'Operation',
    activity: `Operation ${action}`,
    text: `Operation ${action}: ${parts.join(', ')}.`,
    source: operation.id,
    fragments: deviceFragment(deviceId),
  })
}

/**
 * Audit record of a deleted managed object (`Managed object "Pump" deleted`;
 * the id when it has no name).
 * @param data - Tenant data
 * @param managedObject - The deleted object
 */
export function auditManagedObjectDeleted(data: TenantData, managedObject: StoredDocument): void {
  recordAudit(data, {
    type: 'Inventory',
    activity: 'Managed object deleted',
    text: `Managed object "${String(managedObject.name ?? managedObject.id)}" deleted`,
    source: managedObject.id,
  })
}

/**
 * Audit record of a deleted tenant option (`Option "category.key" deleted`).
 * @param data - Tenant data
 * @param category - Option category
 * @param key - Option key
 */
export function auditOptionDeleted(data: TenantData, category: string, key: string): void {
  recordAudit(data, {
    type: 'Option',
    activity: 'Option deleted',
    text: `Option "${category}.${key}" deleted`,
    source: `${category}.${key}`,
  })
}

/**
 * `POST /audit/auditRecords` (verified): `type`, `time`, `text`, and
 * `activity` are required (the platform names one of several missing fields
 * in no stable order), scalars become strings, the source is not checked,
 * `user` defaults to the caller, and other fragments are kept.
 * @param data - Tenant data
 * @param body - Request body
 */
function createAuditRecord(data: TenantData, body: Record<string, unknown>): Response {
  if (body.id !== undefined && body.id !== null) {
    return apiError(422, 'undefined/validationError', 'id is not allowed here')
  }
  for (const field of ['type', 'time', 'text', 'activity']) {
    if (body[field] === undefined || body[field] === null) {
      return apiError(422, 'undefined/validationError', `${field} is required`)
    }
  }
  const source = body.source
  if (source !== undefined && source !== null && (typeof source !== 'object' || Array.isArray(source))) {
    return apiError(400, 'Failed to parse JSON string', `Cannot construct instance of \`com.cumulocity.rest.representation.inventory.ManagedObjectRepresentation\` (although at least one Creator exists): no String-argument constructor/factory method to deserialize from String value ('${String(source)}')\n at [Source: REDACTED (\`StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION\` disabled); line: 1, column: 1] (through reference chain: com.cumulocity.rest.representation.audit.AuditRecordRepresentation["source"])`)
  }
  if (Number.isNaN(parseIsoTime(body.time))) {
    const message = invalidTimeMessage(body.time)
    return apiError(400, 'Failed to parse JSON string', `${message} (through reference chain: com.cumulocity.rest.representation.audit.AuditRecordRepresentation["time"]) : ${message}`)
  }
  const text = (value: unknown) => (value === undefined || value === null ? undefined : typeof value === 'object' ? value : String(value))
  const { id: _id, self: _self, creationTime: _creationTime, type, time, text: recordText, activity, severity, application, user, changes, source: _source, ...fragments } = body
  const sourceRef = source && typeof source === 'object' ? (source as Record<string, unknown>).id : undefined
  const now = data.world.now()
  const record: StoredDocument = {
    id: data.world.newId(),
    type: String(type),
    text: String(recordText),
    user: user === undefined || user === null ? (data.world.actor() ?? '') : String(user),
    ...(application !== undefined && application !== null ? { application: text(application) } : {}),
    activity: String(activity),
    ...(severity !== undefined && severity !== null ? { severity: text(severity) } : {}),
    ...(Array.isArray(changes) ? { changes: clone(changes) } : {}),
    ...(sourceRef !== undefined && sourceRef !== null ? { source: { id: String(sourceRef) } } : {}),
    time: normalizeIsoTime(String(time)),
    creationTime: now,
    ...clone(fragments),
  }
  data.auditRecords.set(record.id, record)
  return Response.json(renderAuditRecord(data, record), { status: 201 })
}

/**
 * An audit record as the API returns it. The source link points into the
 * inventory, whatever the source is (verified, also for alarms and options).
 * @param data - Tenant data
 * @param record - Stored record
 */
export function renderAuditRecord(data: TenantData, record: StoredDocument): StoredDocument {
  const rendered: StoredDocument = { self: `${data.world.baseUrl}/audit/auditRecords/${record.id}`, ...clone(record) }
  const source = sourceId(record)
  if (source !== undefined) {
    rendered.source = { self: `${data.world.baseUrl}/inventory/managedObjects/${encodeURIComponent(source)}`, id: source }
  }
  return rendered
}

const LIST_PARAMS = ['application', 'currentPage', 'dateFrom', 'dateTo', 'pageSize', 'source', 'type', 'user', 'withTotalElements', 'withTotalPages']

/**
 * Audit API: `GET /audit/auditRecords` and `GET /audit/auditRecords/{id}`.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function audit(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, , id, extra] = segments
  if (call.method === 'POST' && id === undefined) {
    checkQuery('POST /audit/auditRecords', call, [])
    return createAuditRecord(data, (call.body ?? {}) as Record<string, unknown>)
  }
  if (call.method !== 'GET' || extra !== undefined) {
    return undefined
  }
  if (id !== undefined) {
    checkQuery('GET /audit/auditRecords/{id}', call, [])
    const record = data.auditRecords.get(id)
    return record
      ? Response.json(renderAuditRecord(data, record))
      // verified, also for an id that is no number
      : apiError(404, 'audit/Not Found', `Can't find audit record with given id ID [type=com_cumulocity_model_idtype_GId, value=${id}]`)
  }
  checkQuery('GET /audit/auditRecords', call, LIST_PARAMS)
  const { query } = call
  for (const name of ['dateFrom', 'dateTo']) {
    const value = query[name]
    if (value !== undefined && Number.isNaN(parsePlatformDate(value))) {
      // verified: no message
      return Response.json({ error: `${value} is not a valid date./Invalid Data`, info: 'https://cumulocity.com/api/core/' }, { status: 422 })
    }
  }
  // verified: exact, case-sensitive matches; no comma-separated lists
  let items = [...data.auditRecords.values()].filter((record) =>
    (query.source === undefined || sourceId(record) === query.source)
    && (query.type === undefined || record.type === query.type)
    && (query.user === undefined || record.user === query.user)
    && (query.application === undefined || record.application === query.application))
  const hasRange = query.dateFrom !== undefined || query.dateTo !== undefined
  if (hasRange) {
    items = items.filter((record) => inRange(record.time, query.dateFrom, query.dateTo))
  }
  // verified: oldest first, but newest first with a date range; records of
  // the same time keep their creation order (reversed with a date range)
  const order = items.map((record, index) => ({ record, index, time: parseIsoTime(record.time) }))
  order.sort((a, b) => a.time - b.time || a.index - b.index)
  if (hasRange) {
    order.reverse()
  }
  const access = data.world.access()
  // verified: without ROLE_AUDIT_READ the list answers the records the caller may read
  const shown = visible(order, access && (({ record }: { record: StoredDocument }) => listed(data, access, 'AUDIT', record)))
  return paged(data, call, 'auditRecords', shown, '/audit/auditRecords', { errorCode: 'REST API/Unprocessable Entity', render: ({ record }) => renderAuditRecord(data, record) })
}

/**
 * The summary the platform appends to `User … updated: ` and similar texts
 * (verified): `enabled='false'` for a replaced value,
 * `roles ['ROLE_A', 'ROLE_B'] added` for added or removed list entries.
 * @param changes - The changes of the record
 */
export function describeChanges(changes: AuditChange[]): string {
  const parts = new Map<string, string[]>()
  for (const change of changes) {
    const kind = change.changeType === 'ADDED' ? 'added' : change.changeType === 'REMOVED' ? 'removed' : undefined
    if (kind === undefined) {
      parts.set(`=${change.attribute}`, [`${change.attribute}='${String(change.newValue)}'`])
      continue
    }
    const key = `${kind} ${change.attribute}`
    parts.set(key, [...(parts.get(key) ?? []), `'${String(kind === 'added' ? change.newValue : change.previousValue)}'`])
  }
  return [...parts].map(([key, values]) => key.startsWith('=')
    ? values[0]!
    : `${key.slice(key.indexOf(' ') + 1)} [${values.join(', ')}] ${key.slice(0, key.indexOf(' '))}`).join(', ')
}

/**
 * A list change for user, role, and group records: `ADDED` (previous `null`)
 * or `REMOVED` (new `null`).
 * @param attribute - e.g. `roles`, `global roles`, `inventoryAssignment`, `permissions`
 * @param type - The platform's type name of the entry
 * @param value - The added or removed entry
 * @param changeType - `ADDED` or `REMOVED`
 */
export function listChange(attribute: string, type: string, value: string, changeType: 'ADDED' | 'REMOVED'): AuditChange {
  return changeType === 'ADDED'
    ? { attribute, type, previousValue: null, newValue: value, changeType }
    : { attribute, type, previousValue: value, newValue: null, changeType }
}

/**
 * A replaced value for user and role records (no `changeType`, scalars as
 * strings), e.g. `{ attribute: 'firstname', previousValue: 'Ev', newValue: 'Eva' }` with the type name.
 * The user API names `firstname`, `lastname` in lower case here (verified).
 * @param attribute - Attribute name
 * @param previousValue - Before (`undefined` when it was not set)
 * @param newValue - After
 */
export function valueChange(attribute: string, previousValue: unknown, newValue: unknown): AuditChange {
  return { attribute, type: javaType(newValue ?? previousValue), previousValue: changeValue(previousValue), newValue: changeValue(newValue) }
}

/**
 * Audit record of a user change (verified): `User <name> created`,
 * `User <name> deleted`, or `User <name> updated: <changes>`. Changes of
 * roles (`roles`), group membership (`global roles`, the group name), and
 * inventory assignments (`inventoryAssignment`,
 * `(managedObject=<id>, roles=[<role names>])`) are list changes; field
 * changes (`firstname`, `lastname`, `email`, `enabled`, …) are value changes.
 * An update without changes writes nothing.
 * @param data - Tenant data
 * @param userName - The user
 * @param action - What happened
 * @param changes - Changes of an update
 */
export function auditUser(data: TenantData, userName: string, action: 'created' | 'updated' | 'deleted', changes: AuditChange[] = []): void {
  if (action === 'updated' && changes.length === 0) {
    return
  }
  recordAudit(data, {
    type: 'User',
    activity: `User ${action}`,
    text: action === 'updated' ? `User ${userName} updated: ${describeChanges(changes)}` : `User ${userName} ${action}`,
    changes,
    source: userName,
  })
}

/**
 * Audit record of a global role (user group) whose permissions changed
 * (verified: `Global Role <name> updated: roles ['ROLE_X'] added`, source
 * the group id in the platform's id notation). Creating,
 * renaming, and deleting a group, and adding users to it, write no group
 * record (adding a user writes a user record with `global roles`).
 * @param data - Tenant data
 * @param group - Group id and name
 * @param group.id - Group id
 * @param group.name - Group name
 * @param changes - `listChange('roles', ...)` entries, `ADDED` or `REMOVED`
 */
export function auditGlobalRoleUpdated(data: TenantData, group: { id: string, name: string }, changes: AuditChange[]): void {
  if (changes.length === 0) {
    return
  }
  recordAudit(data, {
    type: 'Group',
    activity: 'Global Role updated',
    text: `Global Role ${group.name} updated: ${describeChanges(changes)}`,
    changes,
    source: `ID [type=com_cumulocity_model_idtype_GId, value=${group.id}]`,
  })
}

/**
 * Audit record of an inventory role (verified): `Inventory Role <name> created`,
 * `… removed` (on delete), or `… updated: <changes>` with the new name.
 * Permissions are list changes (`permissions`,
 * `<scope>:<type>:<permission>`, e.g. `ALARM:*:READ`); a new name is
 * `valueChange('name', old, new)`.
 * @param data - Tenant data
 * @param role - Role id and (new) name
 * @param role.id - Role id
 * @param role.name - Role name
 * @param action - What happened
 * @param changes - Changes of an update
 */
export function auditInventoryRole(data: TenantData, role: { id: string, name: string }, action: 'created' | 'updated' | 'removed', changes: AuditChange[] = []): void {
  if (action === 'updated' && changes.length === 0) {
    return
  }
  recordAudit(data, {
    type: 'InventoryRole',
    activity: `Inventory Role ${action}`,
    text: action === 'updated' ? `Inventory Role ${role.name} updated: ${describeChanges(changes)}` : `Inventory Role ${role.name} ${action}`,
    changes,
    source: role.id,
  })
}

/**
 * Audit record of a bulk operation (verified): `Create bulk operation: …`,
 * `Update bulk operation: …` (with changes such as `generalStatus`), or
 * `Delete bulk operation: …`, with the target devices in a source fragment
 * (`null` on delete).
 * @param data - Tenant data
 * @param bulk - The stored bulk operation (after the write)
 * @param action - What happened
 * @param deviceIds - Ids of the group's devices, or `null`
 * @param changes - Changes of an update
 */
export function auditBulkOperation(data: TenantData, bulk: StoredDocument, action: 'Create' | 'Update' | 'Delete', deviceIds: string[] | null, changes: AuditChange[] = []): void {
  const progress = bulk.progress as Record<string, number> | undefined
  const progressText = progress && action !== 'Delete'
    ? `BulkOperationProgress(pending=${progress.pending ?? 0}, successful=${progress.successful ?? 0}, failed=${progress.failed ?? 0}, executing=${progress.executing ?? 0}, all=${progress.all ?? 0})`
    : 'null'
  recordAudit(data, {
    type: 'BulkOperation',
    activity: `${action} bulk operation`,
    text: `${action} bulk operation: status='${String(bulk.status)}', generalStatus='${String(bulk.generalStatus)}', progress='${progressText}', note='${String(bulk.note ?? null)}'.`,
    changes,
    // a rendered bulk operation has a numeric id; the source id is a string like everywhere
    source: String(bulk.id),
    fragments: { com_cumulocity_model_event_AuditSourceDevices: { ids: deviceIds } },
  })
}

const GID = (id: string) => `ID [type=com_cumulocity_model_idtype_GId, value=${id}]`

/**
 * Audit record of a new Notification 2.0 subscription (verified).
 * @param data - Tenant data
 * @param subscription - The subscription as stored
 * @param subscription.id - Subscription id
 * @param subscription.context - `mo` or `tenant`
 * @param subscription.subscription - Subscription name
 * @param subscription.source - Source of an `mo` subscription
 * @param subscription.source.id - Its id
 * @param subscription.subscriptionFilter - Filter
 * @param subscription.subscriptionFilter.apis
 * @param subscription.subscriptionFilter.typeFilter
 * @param subscription.fragmentsToCopy - Fragments to copy
 * @param subscription.nonPersistent - Non-persistent flag
 */
export function auditSubscriptionCreated(data: TenantData, subscription: { id: string, context: string, subscription: string, source?: { id: string }, subscriptionFilter?: { apis?: string[], typeFilter?: string }, fragmentsToCopy?: string[], nonPersistent?: boolean }): void {
  // verified: a tenant subscription's source is the tenant
  const source = subscription.source?.id ?? data.tenant
  const filter = subscription.subscriptionFilter
  const parts: string[] = [`context='${subscription.context}'`]
  const changes: AuditChange[] = [{ attribute: 'context', type: 'java.lang.String', previousValue: null, newValue: subscription.context }]
  if (filter) {
    parts.push(`subscriptionFilter='NotificationSubscriptionFilter(apis=[${(filter.apis ?? []).join(', ')}], typeFilter=${filter.typeFilter ?? 'null'})'`)
    changes.push({ attribute: 'subscriptionFilter', type: 'com.cumulocity.model.reliable.notification.NotificationSubscriptionFilter', previousValue: null, newValue: clone(filter) })
  }
  for (const fragment of subscription.fragmentsToCopy ?? []) {
    changes.push(listChange('fragmentsToCopy', 'java.lang.String', fragment, 'ADDED'))
  }
  if (subscription.fragmentsToCopy?.length) {
    parts.push(`fragmentsToCopy [${subscription.fragmentsToCopy.map((fragment) => `'${fragment}'`).join(', ')}] added`)
  }
  parts.push(`source='${GID(source)}'`, `id='${GID(subscription.id)}'`, `subscription='${subscription.subscription}'`)
  changes.push(
    { attribute: 'source', type: 'com.cumulocity.model.idtype.GId', previousValue: null, newValue: source },
    { attribute: 'id', type: 'com.cumulocity.model.idtype.GId', previousValue: null, newValue: subscription.id },
    { attribute: 'subscription', type: 'java.lang.String', previousValue: null, newValue: subscription.subscription },
  )
  if (subscription.nonPersistent) {
    parts.push(`nonPersistent='true'`)
    changes.push({ attribute: 'nonPersistent', type: 'java.lang.Boolean', previousValue: 'false', newValue: 'true' })
  }
  recordAudit(data, {
    type: 'Notification2',
    activity: 'Reliable notification subscription created',
    text: `Reliable notification subscription ${GID(subscription.id)} created: ${parts.join(', ')}`,
    changes,
    source: subscription.id,
  })
}

/**
 * Audit record of a deleted Notification 2.0 subscription (verified).
 * @param data - Tenant data
 * @param id - Subscription id
 */
export function auditSubscriptionDeleted(data: TenantData, id: string): void {
  recordAudit(data, {
    type: 'Notification2',
    activity: 'Reliable notification subscription deleted',
    text: `Reliable notification subscription ${GID(id)} deleted`,
    source: id,
  })
}

/**
 * Audit record of `DELETE /notification2/subscriptions?source=…` (verified;
 * no source). Deleting by context only is not verified and writes nothing.
 * @param data - Tenant data
 * @param source - The `source` filter
 * @param count - Deleted subscriptions
 */
export function auditSubscriptionsDeletedBySource(data: TenantData, source: string, count: number): void {
  const activity = `reliable notification subscriptions with filter source=${GID(source)} deleted`
  recordAudit(data, { type: 'Notification2', activity, text: `${count} ${activity}` })
}

/**
 * Audit record of a new Notification 2.0 token (verified, sic; no source).
 * @param data - Tenant data
 * @param subscription - Subscription name
 */
export function auditTokenCreated(data: TenantData, subscription: string): void {
  recordAudit(data, {
    type: 'Notification2',
    activity: 'Notification token created',
    text: `Notification token for topic:'${data.tenant}/relnotif/${subscription}'created created`,
  })
}

/**
 * Audit record of an unsubscribed consumer (verified; no source).
 * @param data - Tenant data
 * @param subscriber - Subscriber name
 * @param subscription - Subscription name
 */
export function auditUnsubscribed(data: TenantData, subscriber: string, subscription: string): void {
  recordAudit(data, {
    type: 'Notification2',
    activity: 'Unsubscribe the subscriber',
    text: `Subscriber '${subscriber}' was unsubscribed from topic '${data.tenant}/relnotif/${subscription}'`,
    application: 'messaging-management',
  })
}

/**
 * Audit record of a change of `c8y_RequiredAvailability` (verified): enabled
 * (from none), interval changed (from another interval, also from maintenance),
 * maintenance (0 or less, on every such write), disabled (removed). The
 * same interval again writes none.
 * @param data - Tenant data
 * @param id - Managed object id
 * @param before - `responseInterval` before the write (`undefined`: none)
 * @param after - `responseInterval` after it
 */
export function auditAvailability(data: TenantData, id: string, before: number | undefined, after: number | undefined): void {
  const record = (activity: string, text: string) => recordAudit(data, { type: 'DevicesAvailabilityMonitoring', activity, text, source: id })
  if (after === undefined) {
    if (before !== undefined) {
      record('Device availability disabled', `device with id: ${id} disabled availability monitoring`)
    }
  } else if (after <= 0) {
    record('Device put into maintenance state', `device with id: ${id} is put into maintenance state`)
  } else if (before === undefined) {
    record('Device availability enabled', `device with id: ${id} enabled availability monitoring with required interval: ${after}`)
  } else if (before !== after) {
    record('Required interval changed', `Interval assigned to the device with id: ${id} is changed to ${after}`)
  }
}
