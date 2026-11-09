import type { C8yRequest } from '../types'
import type { ExternalId, TenantData } from '../store'
import { externalIdKey, externalIdsByObject } from '../store'
import { apiError, checkQuery } from './http'
import { moSelf, readJsonBody } from './inventory'

function renderExternalId(data: TenantData, entry: ExternalId) {
  return {
    self: `${data.world.baseUrl}/identity/externalIds/${encodeURIComponent(entry.type)}/${encodeURIComponent(entry.externalId)}`,
    externalId: entry.externalId,
    type: entry.type,
    managedObject: { self: moSelf(data, entry.managedObjectId), id: entry.managedObjectId },
  }
}

/**
 * Adds an external id. Fails like the platform on unknown objects or duplicates.
 * @param data - Tenant data
 * @param managedObjectId - Managed object id
 * @param type - External id type, e.g. `c8y_Serial`
 * @param externalId - External id value
 */
export function addExternalId(data: TenantData, managedObjectId: string, type: string, externalId: string): Response | ExternalId {
  if (!data.managedObjects.has(managedObjectId)) {
    // verified against the platform
    return /^\d+$/.test(managedObjectId)
      ? apiError(404, 'identity/Not Found', 'Global id not found;')
      : apiError(422, 'identity/Invalid Data', 'GId value has to be a number !')
  }
  const existing = data.externalIds.get(externalIdKey(type, externalId))
  if (existing) {
    // verified against the platform: idempotent for the same object
    return existing.managedObjectId === managedObjectId
      ? existing
      : apiError(409, 'identity/Duplicate', `ID [type=${type}, value=${externalId}] was already bound to different Global ID.`)
  }
  const entry = { type, externalId, managedObjectId }
  data.externalIds.set(externalIdKey(type, externalId), entry)
  return entry
}

/**
 * Identity API: external ids.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function identity(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, resource, a, b] = segments
  const { method } = call

  if (resource === 'externalIds' && a !== undefined && b !== undefined && segments.length === 4) {
    const entry = data.externalIds.get(externalIdKey(a, b))
    if (method === 'GET') {
      checkQuery('GET /identity/externalIds/{type}/{externalId}', call, [])
      return entry
        ? Response.json(renderExternalId(data, entry))
        : apiError(404, 'identity/Not Found', `External id not found; external id = ID [type=${a}, value=${b}]`)
    }
    if (method === 'DELETE') {
      checkQuery('DELETE /identity/externalIds/{type}/{externalId}', call, [])
      if (!entry) {
        return apiError(404, 'identity/Not Found', `External id not found; external id = ID [type=${a}, value=${b}]`)
      }
      data.externalIds.delete(externalIdKey(a, b))
      return new Response(null, { status: 204 })
    }
    return undefined
  }

  if (resource === 'search' && segments.length === 2 && method === 'POST') {
    checkQuery('POST /identity/search', call, [])
    const criteria = (call.body ?? {}) as { externalIds?: unknown }
    if (criteria.externalIds !== undefined && criteria.externalIds !== null && !Array.isArray(criteria.externalIds)) {
      // verified: the platform fails to parse the body
      return apiError(400, 'Failed to parse JSON string', 'Cannot deserialize value of type `java.util.ArrayList<com.cumulocity.rest.representation.identity.ExternalIDRepresentation>`')
    }
    const wanted = (criteria.externalIds ?? []) as Array<{ type?: unknown, externalId?: unknown }>
    if (wanted.length === 0) {
      // verified, also without `externalIds`
      return apiError(422, 'undefined/validationError', 'search.criteria.externalIds: must not be empty')
    }
    for (const [index, entry] of wanted.entries()) {
      const missing = (['type', 'externalId'] as const).find((field) => !entry?.[field])
      if (missing) {
        // verified
        return apiError(422, 'undefined/validationError', `search.criteria.externalIds[${index}].${missing}: must not be empty`)
      }
    }
    const found = wanted.flatMap((entry) => data.externalIds.get(externalIdKey(String(entry.type), String(entry.externalId))) ?? [])
    // verified: no self link, unknown ids left out, repeated ones repeated
    return Response.json({ externalIds: found.map((entry) => renderExternalId(data, entry)) })
  }

  if (resource === 'globalIds' && a !== undefined && b === 'externalIds' && segments.length === 4) {
    if (method === 'GET') {
      checkQuery('GET /identity/globalIds/{id}/externalIds', call, [])
      // verified: no paging, and unknown objects have no external ids (200)
      const externalIds = externalIdsByObject(data)(a).map((entry) => renderExternalId(data, entry))
      return Response.json({ self: `${data.world.baseUrl}/identity/globalIds/${a}/externalIds`, externalIds })
    }
    if (method === 'POST') {
      checkQuery('POST /identity/globalIds/{id}/externalIds', call, [])
      const read = readJsonBody(call, 'externalid', 'Cannot invoke "Object.getClass()" because "source" is null')
      if (read instanceof Response) {
        return read
      }
      // verified: scalars are read as strings, objects and arrays fail
      const body: { type?: string, externalId?: string } = {}
      for (const field of ['type', 'externalId'] as const) {
        const value = read[field]
        if (value !== null && typeof value === 'object') {
          return apiError(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`java.lang.String\` from ${Array.isArray(value) ? 'Array value (token `JsonToken.START_ARRAY`)' : 'Object value (token `JsonToken.START_OBJECT`)'} (through reference chain: com.cumulocity.rest.representation.identity.ExternalIDRepresentation["${field}"])`)
        }
        if (value !== undefined && value !== null) {
          body[field] = String(value)
        }
      }
      const missing = (['type', 'externalId'] as const).find((field) => !body[field])
      if (missing) {
        // verified: empty strings count as missing
        return apiError(422, 'undefined/validationError', `post.input.${missing}: must not be empty`)
      }
      const result = addExternalId(data, a, body.type!, body.externalId!)
      return result instanceof Response ? result : Response.json(renderExternalId(data, result), { status: 201 })
    }
  }

  return undefined
}
