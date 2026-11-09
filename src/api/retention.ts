/**
 * Retention rules: stored and served like the platform does. The fake does
 * not delete data by them (documented assumption).
 */
import type { C8yRequest } from '../types'
import type { StoredDocument, TenantData } from '../store'
import { apiError, checkQuery, paged } from './http'

const DATA_TYPES = ['ALARM', 'AUDIT', 'EVENT', 'MEASUREMENT', 'OPERATION', '*']

/**
 * Which filter properties a data type's API knows (verified: `type` is not
 * used by operations, `fragmentType` not by alarms and audit records).
 */
const PROPERTIES: Record<string, Array<['TYPE' | 'FRAGMENT_TYPE', 'type' | 'fragmentType']>> = {
  ALARM: [['FRAGMENT_TYPE', 'fragmentType']],
  AUDIT: [['FRAGMENT_TYPE', 'fragmentType']],
  EVENT: [],
  MEASUREMENT: [],
  OPERATION: [['TYPE', 'type']],
  // verified: accepted, although the error for an unknown data type does not list it
  BULK_OPERATION: [['TYPE', 'type']],
}

const FIELDS = ['dataType', 'fragmentType', 'type', 'source', 'maximumAge'] as const

function render(data: TenantData, rule: StoredDocument): StoredDocument {
  return {
    self: `${data.world.baseUrl}/retention/retentions/${rule.id}`,
    id: rule.id,
    dataType: rule.dataType,
    fragmentType: rule.fragmentType,
    type: rule.type,
    source: rule.source,
    maximumAge: rule.maximumAge,
    editable: rule.editable,
  }
}

function notFound(id: string): Response {
  return apiError(404, 'retention/Not Found', `Finding retentionRule from database failed : No retentionRule for gid '${id}'!`)
}

/**
 * 422 for a maximum age over 3650 days, which the platform checks before
 * anything else in the body and before looking up the rule (verified).
 * @param age - `maximumAge` from the body
 */
function tooOld(age: unknown): Response | undefined {
  return age !== undefined && age !== null && Math.trunc(Number(age)) > 3650
    ? apiError(422, 'undefined/validationError', 'Maximum age cannot be bigger than 10 years.')
    : undefined
}

/**
 * The validated rule fields of a body, or the platform's error.
 * @param body - Request body
 * @param base - The stored rule (update) or the defaults (create)
 */
function ruleFields(body: Record<string, unknown>, base: Record<string, unknown>): Record<string, unknown> | Response {
  const age = body.maximumAge
  if (age !== undefined && age !== null && (typeof age === 'object' || typeof age === 'boolean' || (typeof age === 'string' && !/^-?\d+$/.test(age.trim())))) {
    // verified: the platform fails to parse the body
    return apiError(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`java.lang.Long\` from ${typeof age === 'string' ? 'String ' : ''}${JSON.stringify(age)}: not a valid \`java.lang.Long\` value`)
  }
  if ((age === undefined || age === null) && base.maximumAge === undefined) {
    return apiError(422, 'undefined/validationError', 'maximumAge is required')
  }
  const dataType = body.dataType
  if (dataType !== undefined && dataType !== null && !DATA_TYPES.includes(String(dataType)) && dataType !== 'BULK_OPERATION') {
    // verified: after a missing maximum age, before one that is too high
    return apiError(422, 'undefined/validationError', `Invalid data, correct values:[${DATA_TYPES.join(', ')}] : No enum constant com.cumulocity.model.retention.RetentionDataType.${String(dataType)}`)
  }
  const ageError = tooOld(age)
  if (ageError) {
    return ageError
  }
  const fields: Record<string, unknown> = { ...base }
  for (const field of FIELDS) {
    // verified: `null` and missing fields keep the current value
    if (body[field] !== undefined && body[field] !== null) {
      fields[field] = field === 'maximumAge' ? Math.trunc(Number(body[field])) : String(body[field])
    }
  }
  if (fields.maximumAge === undefined) {
    return apiError(422, 'undefined/validationError', 'maximumAge is required')
  }
  if (!DATA_TYPES.includes(String(fields.dataType)) && fields.dataType !== 'BULK_OPERATION') {
    return apiError(422, 'undefined/validationError', `Invalid data, correct values:[${DATA_TYPES.join(', ')}] : No enum constant com.cumulocity.model.retention.RetentionDataType.${String(fields.dataType)}`)
  }
  const dataTypes = fields.dataType === '*' ? Object.keys(PROPERTIES) : [String(fields.dataType)]
  for (const dataType of dataTypes) {
    const unused = PROPERTIES[dataType]!.filter(([, field]) => fields[field] !== '*').map(([name]) => name)
    if (unused.length > 0) {
      return apiError(422, 'retention/Invalid Data', `Failed to add retention rule : Properties [${unused.join(', ')}] can't be used in ${dataType} api.`)
    }
  }
  return fields
}

/**
 * Retention API: `/retention/retentions` and `/retention/retentions/{id}`.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function retention(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, , id, extra] = segments
  const { method } = call
  const body = (call.body ?? {}) as Record<string, unknown>
  if (extra !== undefined) {
    return undefined
  }

  if (id === undefined) {
    if (method === 'GET') {
      checkQuery('GET /retention/retentions', call, ['currentPage', 'pageSize', 'withTotalElements', 'withTotalPages'])
      // verified: ordered by id as a string ("31" after "3001")
      const rules = [...data.retentionRules.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return paged(data, call, 'retentionRules', rules, '/retention/retentions', { errorCode: 'REST API/Unprocessable Entity', render: (rule) => render(data, rule) })
    }
    if (method === 'POST') {
      checkQuery('POST /retention/retentions', call, [])
      const result = createRetentionRule(data, body)
      return result instanceof Response ? result : Response.json(render(data, result), { status: 201 })
    }
    return undefined
  }

  const detail = `/retention/retentions/{id}` as const
  if (!['GET', 'PUT', 'DELETE'].includes(method)) {
    return undefined
  }
  checkQuery(`${method as 'GET' | 'PUT' | 'DELETE'} ${detail}`, call, [])
  if (method === 'PUT' && tooOld(body.maximumAge)) {
    return tooOld(body.maximumAge)!
  }
  // verified: a negative id is looked up (404)
  if (!/^-?\d+$/.test(id)) {
    // verified (sic)
    return apiError(422, 'undefined/validationError', `retentionRuleId='${id}' isn't correct number mut be used`)
  }
  const rule = data.retentionRules.get(id)
  if (!rule) {
    return notFound(id)
  }
  if (method === 'GET') {
    return Response.json(render(data, rule))
  }
  if (method === 'DELETE') {
    data.retentionRules.delete(id)
    return new Response(null, { status: 204 })
  }
  // verified: `id`, `editable`, and unknown fields are ignored
  const fields = ruleFields(body, rule)
  if (fields instanceof Response) {
    return fields
  }
  const updated = { ...rule, ...fields }
  data.retentionRules.set(id, updated)
  return Response.json(render(data, updated))
}

/**
 * Creates a retention rule with the platform's validation and defaults
 * (`*` for every filter, `editable: true`).
 * @param data - Tenant data
 * @param body - The rule
 * @returns The stored rule, or the error response
 */
export function createRetentionRule(data: TenantData, body: Record<string, unknown>): StoredDocument | Response {
  const fields = ruleFields(body, { dataType: '*', fragmentType: '*', type: '*', source: '*' })
  if (fields instanceof Response) {
    return fields
  }
  if (body.id !== undefined) {
    return apiError(422, 'undefined/validationError', 'id is not allowed here')
  }
  // verified: `editable` can only be changed by the management tenant
  const rule: StoredDocument = { id: data.world.newId(), ...fields, editable: true }
  data.retentionRules.set(rule.id, rule)
  return rule
}
