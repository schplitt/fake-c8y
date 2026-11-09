/**
 * Device registration: new device requests (`/devicecontrol/newDeviceRequests`).
 *
 * A request starts as WAITING_FOR_CONNECTION (ACCEPTED with an
 * `enrollmentToken`). The device's first credentials poll
 * (`POST /devicecontrol/deviceCredentials` with the device bootstrap user,
 * not emulated; `world.db.newDeviceRequests.connect()` stands in for it)
 * moves it to PENDING_ACCEPTANCE, and only then can a user accept it. Behavior
 * and messages verified against the platform.
 */
import type { C8yRequest } from '../types'
import type { StoredDocument, TenantData } from '../store'
import { apiError, checkQuery, paged } from './http'
import { clone, parseIsoTime } from '../utils'

const PATH = '/devicecontrol/newDeviceRequests'
export const NEW_DEVICE_STATUSES = ['PENDING_ACCEPTANCE', 'WAITING_FOR_CONNECTION', 'ACCEPTED', 'BLOCKED'] as const
export type C8yNewDeviceRequestStatus = typeof NEW_DEVICE_STATUSES[number]

function validationError(message: string): Response {
  return apiError(422, 'undefined/validationError', message)
}

export function renderNewDeviceRequest(data: TenantData, request: StoredDocument): StoredDocument {
  const { id, status, tenantId, groupId, type, owner, creationTime, customProperties } = request
  return {
    id,
    status,
    tenantId,
    ...(groupId !== undefined ? { groupId } : {}),
    ...(type !== undefined ? { type } : {}),
    owner,
    creationTime,
    self: `${data.world.baseUrl}${PATH}/${encodeURIComponent(id)}`,
    // verified: as given (empty by default), other fragments of the request are dropped
    customProperties: clone(customProperties ?? {}),
  }
}

/**
 * Creates a new device request, validated like `POST /devicecontrol/newDeviceRequests`.
 * @param data - Tenant data
 * @param body - Request body
 * @param owner - The creating user
 * @returns The stored request, or an error response
 */
export function createNewDeviceRequest(data: TenantData, body: Record<string, unknown>, owner: string): StoredDocument | Response {
  if (body.id === undefined || body.id === null) {
    return validationError('id is required')
  }
  const forbidden = ['status', 'owner', 'creationTime', 'securityToken'].find((name) => body[name] !== undefined && body[name] !== null)
  if (forbidden) {
    return validationError(`${forbidden} is not allowed here`)
  }
  const id = String(body.id)
  if (id === '' || /[\s/\\+$:]/.test(id)) {
    return validationError('id field cannot contain whitespace, slashes nor any of (+$:) characters.')
  }
  if (body.tenantId !== undefined && body.tenantId !== null) {
    return validationError('Property tenant id allowed in \'management\' tenant only!')
  }
  if (data.newDeviceRequests.has(id)) {
    return apiError(422, 'devicecontrol/Non Unique Result', `NewDeviceRequest for id = ${id} already exists.`)
  }
  if (body.groupId !== undefined && body.groupId !== null && !data.managedObjects.has(String(body.groupId))) {
    return apiError(404, 'inventory/Not Found', `Finding device data from database failed : No managedObject for id '${String(body.groupId)}'!`)
  }
  const request: StoredDocument = {
    id,
    // verified: an enrollment token (the device's one-time password) accepts the request at once
    status: body.enrollmentToken !== undefined && body.enrollmentToken !== null ? 'ACCEPTED' : 'WAITING_FOR_CONNECTION',
    tenantId: data.tenant,
    ...(body.groupId !== undefined && body.groupId !== null ? { groupId: String(body.groupId) } : {}),
    ...(body.type !== undefined && body.type !== null ? { type: String(body.type) } : {}),
    owner,
    creationTime: data.world.now(),
    ...(body.customProperties && typeof body.customProperties === 'object' && !Array.isArray(body.customProperties) ? { customProperties: clone(body.customProperties) } : {}),
  }
  data.newDeviceRequests.set(id, request)
  return request
}

/**
 * New device request API: `/devicecontrol/newDeviceRequests[/{requestId}]`.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function newDeviceRequests(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, , id, extra] = segments
  const { method } = call
  const body = (call.body ?? {}) as Record<string, unknown>
  if (extra !== undefined) {
    return undefined
  }
  if (id === undefined) {
    if (method === 'GET') {
      checkQuery('GET /devicecontrol/newDeviceRequests', call, ['currentPage', 'pageSize', 'withTotalElements', 'withTotalPages'])
      // verified: newest first (the same instant: the later one first)
      const items = [...data.newDeviceRequests.values()].reverse().sort((a, b) => parseIsoTime(b.creationTime) - parseIsoTime(a.creationTime))
      return paged(data, call, 'newDeviceRequests', items, PATH, { render: (request) => renderNewDeviceRequest(data, request) })
    }
    if (method === 'POST') {
      checkQuery('POST /devicecontrol/newDeviceRequests', call, [])
      const type = (call.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (type !== '' && type !== 'application/json' && type !== 'application/vnd.com.nsn.cumulocity.newdevicerequest+json') {
        // verified: an empty 415
        return new Response(null, { status: 415 })
      }
      const result = createNewDeviceRequest(data, body, data.world.actor() ?? call.user ?? 'test-user')
      if (result instanceof Response) {
        return result
      }
      const rendered = renderNewDeviceRequest(data, result)
      return Response.json(rendered, { status: 201, headers: { location: String(rendered.self) } })
    }
    return undefined
  }

  const request = data.newDeviceRequests.get(id)
  if (method === 'GET' || method === 'DELETE') {
    checkQuery(`${method} /devicecontrol/newDeviceRequests/{requestId}`, call, [])
    if (!request) {
      return apiError(404, 'devicecontrol/Not Found', `Could not find newDeviceRequest by ID ${id}`)
    }
    if (method === 'DELETE') {
      data.newDeviceRequests.delete(id)
      return new Response(null, { status: 204 })
    }
    return Response.json(renderNewDeviceRequest(data, request))
  }
  if (method === 'PUT') {
    checkQuery('PUT /devicecontrol/newDeviceRequests/{requestId}', call, [])
    // verified order and messages: a user can only accept a request the
    // device has connected for
    if (body.status === undefined || body.status === null || body.status === '') {
      return validationError('status is required')
    }
    if (body.id !== undefined && body.id !== null) {
      return validationError('id is not allowed here')
    }
    if (!NEW_DEVICE_STATUSES.includes(body.status as C8yNewDeviceRequestStatus)) {
      return apiError(500, 'general/internalError', `No enum constant com.cumulocity.model.device.NewDeviceStatus.${String(body.status)}`)
    }
    if (body.status !== 'ACCEPTED') {
      return apiError(422, 'devicecontrol/Invalid Data', 'Can transpose to ACCEPTED status only.')
    }
    if (!request) {
      return apiError(404, 'devicecontrol/Not Found', `There is no newDeviceRequest for device id ${id}.`)
    }
    if (request.status !== 'PENDING_ACCEPTANCE') {
      return apiError(404, 'devicecontrol/Not Found', `NewDeviceRequest for device id ${id} is in state ${String(request.status)}, (not PENDING_ACCEPTANCE)).`)
    }
    const accepted = { ...request, status: 'ACCEPTED' }
    data.newDeviceRequests.set(id, accepted)
    return Response.json(renderNewDeviceRequest(data, accepted))
  }
  return undefined
}
