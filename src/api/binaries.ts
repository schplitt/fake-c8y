import type { C8yRequest } from '../types'
import type { BinaryContent, StoredDocument, TenantData } from '../store'
import { deleteManagedObject } from '../store'
import { apiError, checkQuery, paged, raw } from './http'
import { createManagedObject, renderManagedObject } from './inventory'
import { clone, parseMultipart } from '../utils'

interface Upload {
  content: BinaryContent
  object: Record<string, unknown>
}

/**
 * Reads an upload: a multipart body with `object` (JSON) and `file` parts, or
 * a raw body (event attachments, binary replacement). Synchronous on
 * purpose: a handler that awaited between reading the tenant data and
 * writing could write into the next trial after a `reset()`.
 * @param call - The request
 * @returns The upload, or an error response
 */
function readUpload(call: C8yRequest): Upload | Response {
  const { bytes, contentType } = raw(call)
  if (!contentType.startsWith('multipart/')) {
    return { content: { bytes, contentType: contentType || 'application/octet-stream', name: 'bin' }, object: {} }
  }
  const parts = parseMultipart(bytes, contentType)
  if (!parts) {
    return apiError(422, 'binaries/Invalid Data', 'The body is not valid multipart/form-data')
  }
  const file = parts.find((part) => part.name === 'file')
  if (!file) {
    return apiError(422, 'binaries/Invalid Data', 'Missing file part')
  }
  let object: Record<string, unknown> = {}
  const objectPart = parts.find((part) => part.name === 'object' && part.filename === undefined)
  const objectText = objectPart ? new TextDecoder().decode(objectPart.bytes) : ''
  if (objectText) {
    try {
      object = JSON.parse(objectText)
    } catch {
      return apiError(422, 'binaries/Invalid Data', 'The object part is not valid JSON')
    }
  }
  // like a WHATWG FormData: a file part defaults to text/plain, a part without
  // a filename is a string (no type, no name)
  const fileType = file.filename === undefined ? '' : (file.contentType ?? 'text/plain')
  const name = typeof object.name === 'string' ? object.name : file.filename || 'bin'
  return {
    content: { bytes: file.bytes, contentType: fileType || 'application/octet-stream', name },
    object,
  }
}

function resourceNotFound(id: string): Response {
  // verified: unknown ids and objects that are no binaries
  return apiError(404, 'inventory/Not Found', `Resource ID [type=com_cumulocity_model_idtype_GId, value=${id}] for this request not found.`)
}

function download(content: BinaryContent): Response {
  return new Response(content.bytes.slice(), {
    headers: {
      'content-type': content.contentType,
      'content-length': String(content.bytes.length),
      'content-disposition': `attachment; filename="${content.name}"`,
    },
  })
}

/**
 * Creates an inventory binary (a managed object with `c8y_IsBinary`).
 * @param data - Tenant data
 * @param content - File content
 * @param object - Managed object fragments from the upload
 * @param owner - Owner user name
 */
export function createBinary(data: TenantData, content: BinaryContent, object: Record<string, unknown>, owner: string): StoredDocument {
  const document = createManagedObject(data, {
    ...object,
    name: object.name ?? content.name,
    type: object.type ?? content.contentType,
    contentType: content.contentType,
    length: content.bytes.length,
    c8y_IsBinary: '',
  }, owner)
  data.binaries.set(document.id, content)
  return document
}

/**
 * A binary as the binaries API answers it (verified): its own `self` link,
 * no `creationTime`, no child or parent collections.
 * @param data - Tenant data
 * @param document - The stored binary
 */
function renderBinary(data: TenantData, document: StoredDocument): StoredDocument {
  const { id, type, name, lastUpdated, owner, creationTime: _creationTime, ...fragments } = clone(document)
  const rendered: StoredDocument = { self: `${data.world.baseUrl}/inventory/binaries/${id}`, id }
  for (const [key, value] of Object.entries({ type, name, lastUpdated, owner })) {
    if (value !== undefined) {
      rendered[key] = value
    }
  }
  return { ...rendered, ...fragments }
}

const MISSING_PART = 'Missing field in form. The fields \'object\' and \'file\' are necessary for this request.'

/**
 * Checks an upload to `POST /inventory/binaries` like the platform (verified):
 * a multipart body with an `object` part (JSON with `name` and `type`, no
 * `id`) and a `file` part.
 * @param call - The request
 */
function checkUpload(call: C8yRequest): Response | undefined {
  const { bytes, contentType } = raw(call)
  if (!contentType.toLowerCase().startsWith('multipart/')) {
    return /json/i.test(contentType)
      ? apiError(400, 'Failed to parse JSON string', 'Cannot construct instance of `org.apache.cxf.jaxrs.ext.multipart.MultipartBody` (although at least one Creator exists): cannot deserialize from Object value (no delegate- or property-based Creator)')
      : new Response(null, { status: 415 })
  }
  const parts = parseMultipart(bytes, contentType) ?? []
  const objectPart = parts.find((part) => part.name === 'object')
  if (!objectPart || !parts.some((part) => part.name === 'file')) {
    return apiError(400, 'inventory/Bad Request', MISSING_PART)
  }
  let object: unknown
  try {
    object = JSON.parse(new TextDecoder().decode(objectPart.bytes))
  } catch (error) {
    return apiError(500, 'general/internalError', `HTTP 500 Internal Server Error : ${(error as Error).message}`)
  }
  if (object === null || typeof object !== 'object' || Array.isArray(object)) {
    return apiError(500, 'general/internalError', 'HTTP 500 Internal Server Error : Cannot deserialize value of type `com.cumulocity.rest.representation.binary.BinaryObjectRepresentation`')
  }
  const { id, name, type } = object as Record<string, unknown>
  if (id !== undefined && id !== null) {
    return apiError(422, 'undefined/validationError', 'id is not allowed here')
  }
  if (name === undefined || name === null || type === undefined || type === null) {
    return apiError(400, 'inventory/Bad Request', 'Missing field in object. The fields \'name\' and \'type\' are necessary for this request.')
  }
  return undefined
}

/**
 * Inventory binaries API: `/inventory/binaries[/{id}]`.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function inventoryBinaries(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, , id] = segments
  const { method } = call

  if (id === undefined) {
    if (method === 'POST') {
      checkQuery('POST /inventory/binaries', call, [])
      const invalid = checkUpload(call)
      if (invalid) {
        return invalid
      }
      const upload = readUpload(call)
      if (upload instanceof Response) {
        return upload
      }
      // verified: name and type are read as strings
      const object = { ...upload.object, name: String(upload.object.name), type: String(upload.object.type) }
      const document = createBinary(data, upload.content, object, data.world.actor() ?? call.user ?? 'test-user')
      return Response.json(renderBinary(data, document), { status: 201 })
    }
    if (method === 'GET') {
      const supported = ['childAdditionId', 'childAssetId', 'childDeviceId', 'currentPage', 'ids', 'owner', 'pageSize', 'text', 'type', 'withTotalPages']
      checkQuery('GET /inventory/binaries', call, supported)
      const { query } = call
      const filters = (['ids', 'type', 'owner', 'text'] as const).filter((name) => query[name] !== undefined && query[name] !== '')
      if (filters.length === 1 && query.text) {
        // verified: the full-text search fails on the binaries collection
        return apiError(500, 'general/internalError', 'Command execution failed on MongoDB server with error 2 (BadValue): \'unknown operator: $search\'')
      }
      const ids = query.ids?.split(',')
      // verified: the child id filters never match a binary, and two of the
      // filters ids, type, owner, and text together match nothing
      const childFilter = ['childDeviceId', 'childAssetId', 'childAdditionId'].some((name) => query[name] !== undefined)
      const items = childFilter || filters.length > 1
        ? []
        : [...data.managedObjects.values()].filter((document) => document.c8y_IsBinary !== undefined
          && (ids === undefined || ids.includes(document.id))
          && (query.owner === undefined || document.owner === query.owner)
          && (query.type === undefined || document.type === query.type))
      return paged(data, call, 'managedObjects', items, '/inventory/binaries', { statistics: 'binaries', errorCode: 'REST API/Unprocessable Entity', render: (document) => renderBinary(data, document) })
    }
    return undefined
  }

  const document = data.managedObjects.get(id)
  const content = data.binaries.get(id)
  if (method === 'GET') {
    checkQuery('GET /inventory/binaries/{id}', call, [])
    if (!document || !content) {
      return resourceNotFound(id)
    }
    // verified: the content type is the object's type when it is a media type
    const type = typeof document.type === 'string' && /^[\w.+-]+\/[\w.+-]+/.test(document.type) ? document.type : 'application/octet-stream'
    return download({ ...content, contentType: type })
  }
  if (method === 'PUT') {
    checkQuery('PUT /inventory/binaries/{id}', call, [])
    if (!document || !content) {
      return resourceNotFound(id)
    }
    // verified: the raw body is the new content, also a multipart body, and
    // the content type header (as sent) the new type
    const { bytes, contentType } = raw(call)
    if (bytes.length === 0) {
      return apiError(400, 'inventory/Bad Request', MISSING_PART)
    }
    const type = contentType || 'application/octet-stream'
    data.binaries.set(id, { bytes, contentType: type, name: content.name })
    const updated = { ...document, type, contentType: type, length: bytes.length, lastUpdated: data.world.now() }
    data.managedObjects.set(id, updated)
    data.world.notify(data, 'managedobjects', 'UPDATE', renderManagedObject(data, updated), id)
    // verified: 201 with the binary (empty without an Accept header for JSON)
    return Response.json(renderBinary(data, updated), { status: 201 })
  }
  if (method === 'DELETE') {
    checkQuery('DELETE /inventory/binaries/{id}', call, [])
    // verified: the binaries API deletes any managed object
    if (!deleteManagedObject(data, id)) {
      return apiError(404, 'inventory/Not Found', 'Delete attachment query failed. : Attachment not found')
    }
    data.binaries.delete(id)
    data.world.notify(data, 'managedobjects', 'DELETE', { id }, id)
    return new Response(null, { status: 204 })
  }
  if (method === 'POST') {
    // verified against the platform
    return apiError(405, 'general/Method Not Allowed', 'Request method \'POST\' is not supported')
  }
  return undefined
}

function renderAttachment(data: TenantData, eventId: string, content: BinaryContent) {
  return {
    self: `${data.world.baseUrl}/event/events/${eventId}/binaries`,
    source: eventId,
    name: content.name,
    type: content.contentType,
  }
}

/**
 * Event attachments: `/event/events/{id}/binaries`.
 * @param call - The request
 * @param eventId - Event id
 * @param data - Tenant data
 */
export function eventBinaries(call: C8yRequest, eventId: string, data: TenantData): Response | undefined {
  const { method } = call
  if (!data.events.has(eventId)) {
    return apiError(404, 'event/Not Found', `Finding device data from database failed : No event for gid '${eventId}'!`)
  }
  const existing = data.eventBinaries.get(eventId)

  if (method === 'POST' || method === 'PUT') {
    checkQuery(`${method} /event/events/{id}/binaries` as 'POST /event/events/{id}/binaries', call, [])
    if (method === 'POST' && existing) {
      return apiError(409, 'event/Duplicate', 'Binary already exists.')
    }
    // verified against the platform: a raw JSON body is not an upload (PUT
    // takes it); raw uploads are named after the event; no content type means
    // text/plain
    const { bytes, contentType } = raw(call)
    if (method === 'POST' && /^application\/json/i.test(contentType)) {
      return apiError(400, 'Failed to parse JSON string', 'Cannot construct instance of `org.apache.cxf.jaxrs.ext.multipart.MultipartBody` (although at least one Creator exists): cannot deserialize from Object value (no delegate- or property-based Creator)')
    }
    if (contentType.startsWith('multipart/')) {
      // verified: the platform's errors for a broken multipart body
      const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2]
      if (bytes.length === 0) {
        return apiError(400, 'general/internalError', 'HTTP 400 Bad Request')
      }
      const parts = parseMultipart(bytes, contentType)
      if (!parts) {
        return apiError(500, 'general/internalError', boundary ? `Couldn't find MIME boundary: --${boundary}` : 'Couldn\'t determine the boundary from the message!')
      }
      if (!parts.some((part) => part.name === 'file')) {
        return apiError(422, 'eventBinary/Unprocessable Entity', 'No file attachment')
      }
    }
    const upload = readUpload(call)
    if (upload instanceof Response) {
      return upload
    }
    const multipart = contentType.startsWith('multipart/')
    const content = {
      ...upload.content,
      contentType: contentType ? upload.content.contentType : 'text/plain;charset=UTF-8',
      name: multipart ? upload.content.name : eventId,
    }
    data.eventBinaries.set(eventId, content)
    // verified: the event describes its attachment in c8y_IsBinary
    data.events.update(eventId, (event) => {
      event.c8y_IsBinary = { name: content.name, length: content.bytes.length, type: content.contentType }
      event.lastUpdated = data.world.now()
    })
    return Response.json(renderAttachment(data, eventId, content), { status: 201 })
  }
  if (method === 'GET') {
    checkQuery('GET /event/events/{id}/binaries', call, [])
    return existing ? download(existing) : apiError(404, 'event/Not Found', 'Attachment not found')
  }
  if (method === 'DELETE') {
    checkQuery('DELETE /event/events/{id}/binaries', call, [])
    // verified: deleting a missing attachment succeeds; the event loses c8y_IsBinary
    data.eventBinaries.delete(eventId)
    if (data.events.get(eventId)?.c8y_IsBinary !== undefined) {
      data.events.update(eventId, (event) => {
        delete event.c8y_IsBinary
      })
    }
    return new Response(null, { status: 204 })
  }
  return undefined
}
