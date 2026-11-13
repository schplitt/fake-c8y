/**
 * Response media types of the platform (verified on a real tenant): every
 * JSON answer of a Cumulocity API names its vendor type, a single object
 * `application/vnd.com.nsn.cumulocity.<name>+json;charset=UTF-8;ver=0.9` and
 * a list `<name>collection`. The handlers answer with `Response.json()`;
 * `withMediaType()` puts the platform's type on the answer afterwards.
 */

const VENDOR = 'application/vnd.com.nsn.cumulocity.'
const PARAMETERS = ';charset=UTF-8;ver=0.9'

/**
 * The content type of an error answer.
 */
export const ERROR_MEDIA_TYPE: string = `${VENDOR}error+json${PARAMETERS}`

/**
 * The `info` link of every JSON error the platform answers.
 */
export const ERROR_INFO: string = 'https://cumulocity.com/api/core/'

/**
 * The media type per endpoint: a vendor name (`managedobject`), or a full
 * type for the endpoints that answer plain JSON or text.
 */
const MEDIA_TYPES: Record<string, string> = {
  'GET /inventory/managedObjects': 'managedobjectcollection',
  'POST /inventory/managedObjects': 'managedobject',
  'GET /inventory/managedObjects/count': 'text/plain',
  'GET /inventory/managedObjects/{id}': 'managedobject',
  'PUT /inventory/managedObjects/{id}': 'managedobject',
  'GET /inventory/managedObjects/{id}/{children}': 'managedobjectreferencecollection',
  // verified: a reference added one by one is named in camel case
  'POST /inventory/managedObjects/{id}/{children}': 'managedObjectReference',
  'GET /inventory/managedObjects/{id}/{children}/{childId}': 'managedobjectreference',
  'GET /inventory/managedObjects/{id}/supportedSeries': 'application/json',
  'GET /inventory/managedObjects/{id}/supportedMeasurements': 'application/json',
  'GET /inventory/managedObjects/{id}/availability': 'application/json',
  'GET /inventory/managedObjects/{id}/user': 'managedobjectuser',
  'PUT /inventory/managedObjects/{id}/user': 'managedobjectuser',
  'GET /inventory/binaries': 'managedobjectcollection',
  'POST /inventory/binaries': 'managedobject',
  'PUT /inventory/binaries/{id}': 'managedobject',
  'GET /identity/externalIds/{type}/{externalId}': 'externalid',
  'GET /identity/globalIds/{id}/externalIds': 'externalidcollection',
  'POST /identity/globalIds/{id}/externalIds': 'externalid',
  'POST /identity/search': 'externalidcollection',
  'GET /measurement/measurements': 'measurementcollection',
  'POST /measurement/measurements': 'measurement',
  'GET /measurement/measurements/{id}': 'measurement',
  'GET /measurement/measurements/series': 'application/json',
  'GET /event/events': 'eventcollection',
  'POST /event/events': 'event',
  'GET /event/events/{id}': 'event',
  'PUT /event/events/{id}': 'event',
  'GET /alarm/alarms': 'alarmcollection',
  'POST /alarm/alarms': 'alarm',
  'GET /alarm/alarms/count': 'text/plain',
  'POST /alarm/alarms/upsert': 'alarmupsertresponse',
  'GET /alarm/alarms/{id}': 'alarm',
  'PUT /alarm/alarms/{id}': 'alarm',
  'GET /devicecontrol/operations': 'operationcollection',
  'POST /devicecontrol/operations': 'operation',
  'GET /devicecontrol/operations/{id}': 'operation',
  'PUT /devicecontrol/operations/{id}': 'operation',
  'GET /devicecontrol/bulkoperations': 'bulkoperationcollection',
  'POST /devicecontrol/bulkoperations': 'bulkoperation',
  'GET /devicecontrol/bulkoperations/{id}': 'bulkoperation',
  'PUT /devicecontrol/bulkoperations/{id}': 'bulkoperation',
  'GET /devicecontrol/newDeviceRequests': 'newdevicerequestcollection',
  'POST /devicecontrol/newDeviceRequests': 'newdevicerequest',
  'GET /devicecontrol/newDeviceRequests/{id}': 'newdevicerequest',
  'PUT /devicecontrol/newDeviceRequests/{id}': 'newdevicerequest',
  'GET /notification2/subscriptions': 'subscriptioncollection',
  'POST /notification2/subscriptions': 'subscription',
  'GET /notification2/subscriptions/{id}': 'subscription',
  'POST /notification2/token': 'application/json',
  'POST /notification2/unsubscribe': 'application/json',
  'GET /user/currentUser': 'currentuser',
  'GET /user/roles': 'rolecollection',
  'GET /user/roles/{name}': 'role',
  'GET /user/inventoryroles': 'inventoryrolecollection',
  'POST /user/inventoryroles': 'inventoryrole',
  'GET /user/inventoryroles/{id}': 'inventoryrole',
  'PUT /user/inventoryroles/{id}': 'inventoryrole',
  'GET /user/devicePermissions/{id}': 'application/json',
  'GET /user/{tenant}/users': 'usercollection',
  'POST /user/{tenant}/users': 'user',
  'GET /user/{tenant}/users/{id}': 'user',
  'PUT /user/{tenant}/users/{id}': 'user',
  'GET /user/{tenant}/userByName/{name}': 'user',
  'GET /user/{tenant}/users/{id}/groups': 'groupreferencecollection',
  'POST /user/{tenant}/users/{id}/roles': 'rolereference',
  'GET /user/{tenant}/users/{id}/roles/inventory': 'inventoryassignmentcollection',
  'POST /user/{tenant}/users/{id}/roles/inventory': 'inventoryassignment',
  'GET /user/{tenant}/users/{id}/roles/inventory/{assignment}': 'inventoryassignment',
  'PUT /user/{tenant}/users/{id}/roles/inventory/{assignment}': 'inventoryassignment',
  'GET /user/{tenant}/groups': 'groupcollection',
  'POST /user/{tenant}/groups': 'group',
  'GET /user/{tenant}/groups/{id}': 'group',
  'PUT /user/{tenant}/groups/{id}': 'group',
  'GET /user/{tenant}/groupByName/{name}': 'group',
  'GET /user/{tenant}/groups/{id}/users': 'userreferencecollection',
  'POST /user/{tenant}/groups/{id}/users': 'userreference',
  'GET /user/{tenant}/groups/{id}/roles': 'rolereferencecollection',
  'POST /user/{tenant}/groups/{id}/roles': 'rolereference',
  'GET /tenant/currentTenant': 'currenttenant',
  'GET /tenant/options': 'optioncollection',
  'POST /tenant/options': 'option',
  'GET /tenant/options/{category}': 'option',
  'PUT /tenant/options/{category}': 'option',
  'GET /tenant/options/{category}/{key}': 'option',
  'PUT /tenant/options/{category}/{key}': 'option',
  'PUT /tenant/options/{category}/{key}/editable': 'option',
  'GET /tenant/system/options': 'optioncollection',
  'GET /tenant/system/options/{category}/{key}': 'option',
  'GET /tenant/statistics': 'tenantusagestatisticscollection',
  'GET /tenant/statistics/summary': 'tenantusagestatisticssummary',
  'GET /tenant/statistics/allTenantsSummary': 'application/json',
  'GET /tenant/statistics/device/{tenant}/{period}/{date}': 'application/json',
  'GET /tenant/tenants': 'tenantcollection',
  'GET /tenant/tenants/{tenant}/tfa': 'application/json',
  'GET /tenant/tenants/{tenant}/applications/restricted-roles': 'application/json',
  'GET /tenant/tenants/{tenant}/trusted-certificates': 'application/json',
  'GET /tenant/tenants/{tenant}/trusted-certificates/{fingerprint}': 'application/json',
  'GET /tenant/loginOptions': 'loginoptioncollection',
  'GET /tenant/loginOptions/{typeOrId}': 'authconfig',
  'GET /tenant/loginOptions/{typeOrId}/accessMappings': 'accessmappingcollection',
  'GET /tenant/loginOptions/{typeOrId}/inventoryAccessMappings': 'inventoryaccessmappingcollection',
  'GET /retention/retentions': 'retentionrulecollection',
  'POST /retention/retentions': 'retentionrule',
  'GET /retention/retentions/{id}': 'retentionrule',
  'PUT /retention/retentions/{id}': 'retentionrule',
  'GET /audit/auditRecords': 'auditrecordcollection',
  'POST /audit/auditRecords': 'auditrecord',
  'GET /audit/auditRecords/{id}': 'auditrecord',
  'GET /application/applications': 'applicationcollection',
  'POST /application/applications': 'application',
  'GET /application/applications/{id}': 'application',
  'PUT /application/applications/{id}': 'application',
  'GET /application/applications/{id}/bootstrapUser': 'user',
  'GET /application/applicationsByName/{name}': 'applicationcollection',
  'GET /application/applicationsByOwner/{tenant}': 'applicationcollection',
  'GET /application/applicationsByTenant/{tenant}': 'applicationcollection',
  'GET /application/applicationsByUser/{user}': 'applicationcollection',
  'GET /application/currentApplication': 'application',
  'PUT /application/currentApplication': 'application',
  'GET /application/currentApplication/settings': 'option',
  'GET /application/currentApplication/subscriptions': 'applicationusercollection',
  'POST /tenant/tenants/{tenant}/applications': 'applicationreference',
}

interface Route {
  segments: string[]
  /**
   * The vendor name (`managedobject`) or a full type (`application/json`, `text/plain`)
   */
  name: string
}

// routes per method and first segment, so a lookup compares a handful
const ROUTES = new Map<string, Route[]>()
for (const [endpoint, name] of Object.entries(MEDIA_TYPES)) {
  const [method, template] = endpoint.split(' ') as [string, string]
  const segments = template.split('/').filter(Boolean)
  const key = `${method} ${segments[0]}`
  ROUTES.set(key, [...(ROUTES.get(key) ?? []), { segments, name }])
}
const CHILDREN = new Set(['childDevices', 'childAssets', 'childAdditions'])

/**
 * The vendor name an endpoint answers for the request's content type
 * (verified): a collection sent as one (`measurementcollection`,
 * `managedObjectReferenceCollection`) is answered as one, in the case of the
 * table's name, and a child created with the managed object type
 * (`POST .../childAdditions`) is answered as a managed object.
 * @param name - The table's name
 * @param requestType - The request's content type
 */
function variant(name: string, requestType: string): string {
  const sent = /^application\/vnd\.com\.nsn\.cumulocity\.([a-z]+)\+json/i.exec(requestType.trim())?.[1]?.toLowerCase()
  if (sent === `${name.toLowerCase()}collection`) {
    return /[A-Z]/.test(name) ? `${name}Collection` : `${name}collection`
  }
  return name === 'managedObjectReference' && sent === 'managedobject' ? 'managedobject' : name
}

function route(method: string, segments: readonly string[]): Route | undefined {
  let best: Route | undefined
  let bestScore = -1
  for (const candidate of ROUTES.get(`${method} ${segments[0]}`) ?? []) {
    if (candidate.segments.length !== segments.length) {
      continue
    }
    let score = 0
    const matches = candidate.segments.every((part, i) => {
      if (part === '{children}') {
        return CHILDREN.has(segments[i]!)
      }
      if (part.startsWith('{')) {
        return true
      }
      score++
      return part === segments[i]
    })
    if (matches && score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

const vendorType = (name: string): string => `${VENDOR}${name}+json${PARAMETERS}`

/**
 * The platform's media type of a successful answer, or `undefined` for an
 * endpoint without one in the table. A literal segment beats a parameter
 * (`/alarm/alarms/count` over `/alarm/alarms/{id}`).
 * @param method - Request method
 * @param segments - Decoded path segments
 */
export function mediaType(method: string, segments: readonly string[]): string | undefined {
  const name = route(method, segments)?.name
  return name === undefined || name.includes('/') ? name : vendorType(name)
}

interface MediaRange {
  type: string
  params: Array<[string, string]>
}

/**
 * The media ranges of an Accept header in order, or `undefined` when there
 * is none or it does not parse (verified: `foo` counts as no header).
 * @param accept - The header
 */
function mediaRanges(accept: string | null): MediaRange[] | undefined {
  if (!accept?.trim()) {
    return undefined
  }
  const ranges = accept.split(',').map((entry) => {
    const [type = '', ...params] = entry.split(';').map((part) => part.trim())
    return { type: type.toLowerCase(), params: params.filter(Boolean).map((param): [string, string] => [param.split('=')[0]!.trim().toLowerCase(), (param.split('=')[1] ?? '').trim()]) }
  })
  return ranges.every((range) => /^[\w.+*-]+\/[\w.+*-]+$/.test(range.type)) ? ranges : undefined
}

// verified: these APIs read only the first media range of the Accept header,
// and reject one with parameters besides `q` or with `q=0`
const FIRST_RANGE_ONLY = new Set(['devicecontrol', 'retention', 'audit', 'notification2', 'application'])
// verified: the endpoints that also produce text (`supportedSeries`, `supportedMeasurements`)
const TEXT_TOO = new Set(['supportedSeries', 'supportedMeasurements'])

/**
 * What an endpoint answers to an Accept header (verified): `undefined` when
 * the header does not matter (the endpoint is not in the table, a DELETE, or
 * a count), `null` for 406 Not Acceptable, otherwise the content type of a
 * successful answer. Endpoints produce their vendor type and
 * `application/json` (the current user also `user`); `*\/*`, `application/*`
 * and those types (in any case, with any parameters) are accepted, everything
 * else (`text/plain`, `application/xml`, another vendor type) is not. The
 * user API answers `application/json` (with the requested charset) when the
 * header names it but is not exactly `application/json`; the other APIs
 * always answer their vendor type.
 * @param method - Request method
 * @param segments - Decoded path segments
 * @param accept - The request's Accept header
 * @param requestType - The request's content type (`variant()`)
 */
export function negotiate(method: string, segments: readonly string[], accept: string | null, requestType = ''): string | null | undefined {
  const found = method === 'DELETE' ? undefined : route(method, segments)
  if (!found || found.name === 'text/plain') {
    return undefined
  }
  const name = variant(found.name, requestType)
  const vendor = name.includes('/') ? undefined : name.toLowerCase()
  const vendors = vendor === 'currentuser' ? [vendor, 'user'] : vendor ? [vendor] : []
  const text = TEXT_TOO.has(segments.at(-1)!)
  const json = (range: MediaRange) => range.params.some(([name]) => name === 'charset') ? `application/json;charset=${range.params.find(([name]) => name === 'charset')![1].toLowerCase()}` : 'application/json'
  // what one range selects: a content type, or undefined when it does not fit
  const select = (range: MediaRange): string | undefined => {
    if (range.type === '*/*' || range.type === 'application/*') {
      return vendor ? vendorType(name) : 'application/json'
    }
    if (range.type === 'application/json') {
      return vendor ? vendorType(name) : json(range)
    }
    if (text && (range.type === 'text/plain' || range.type === 'text/*')) {
      return 'text/plain'
    }
    const named = vendors.find((name) => range.type === `${VENDOR}${name}+json`)
    // verified: in the case of the table (`managedObjectReference`)
    return named ? vendorType(named === vendor ? name : named) : undefined
  }
  const ranges = mediaRanges(accept)
  if (!ranges) {
    return select({ type: '*/*', params: [] })
  }
  if (FIRST_RANGE_ONLY.has(segments[0]!)) {
    const first = ranges[0]!
    const plain = first.params.every(([name, value]) => name === 'q' && Number(value) > 0)
    return plain ? (select(first) ?? null) : null
  }
  const chosen = ranges.map(select).find((type) => type !== undefined)
  if (chosen === undefined) {
    return null
  }
  if (segments[0] === 'user' && vendor && accept!.trim() !== 'application/json') {
    const named = ranges.find((range) => range.type === 'application/json')
    if (named) {
      return json(named)
    }
  }
  return chosen
}

/**
 * Puts the platform's content type on an answer the handlers built with
 * `Response.json()` (`application/json`): the negotiated type of the
 * endpoint, or the error type for a JSON error. Answers with another content
 * type (binary downloads) or without a body keep theirs.
 * @param method - Request method
 * @param segments - Decoded path segments
 * @param response - The handler's answer
 * @param requestType - The request's content type
 * @param accept - The request's Accept header
 */
export function withMediaType(method: string, segments: readonly string[], response: Response, requestType = '', accept: string | null = null): Response {
  if (response.headers.get('content-type') !== 'application/json') {
    return response
  }
  const type = response.status >= 400
    ? (response.status === 401 ? ERROR_MEDIA_TYPE.replace(';ver', ' ;ver') : ERROR_MEDIA_TYPE)
    : (negotiate(method, segments, accept, requestType) ?? mediaType(method, segments))
  if (type === undefined) {
    return response
  }
  // the handler's own fresh answer: its headers can change in place (a new
  // Response around the body stream fails in iso4)
  response.headers.set('content-type', type)
  return response
}

/**
 * Verified: a create (201) names the new resource in a `Location` header,
 * the `self` link of its answer (none for a measurement collection, which
 * has no `self`).
 * @param response - The answer, before `writeAnswer()` drops its body
 */
export async function withLocation(response: Response): Promise<Response> {
  // verified: a collection (of child references) names none
  const type = response.headers.get('content-type') ?? ''
  if (response.status !== 201 || !/json/.test(type) || /collection\+json/i.test(type) || response.headers.has('location')) {
    return response
  }
  const self = ((await response.clone().json().catch(() => undefined)) as { self?: unknown } | undefined)?.self
  if (typeof self === 'string') {
    response.headers.set('location', self)
  }
  return response
}

/**
 * The answer to an Accept header `negotiate()` rejects: 406 with an empty
 * body. Verified exception: a single measurement whose Accept header names
 * only the collection type fails with 500 (nothing stored).
 * @param method - Request method
 * @param segments - Decoded path segments
 * @param accept - The request's Accept header
 */
export function notAcceptable(method: string, segments: readonly string[], accept: string | null): Response {
  if (method === 'POST' && segments.length === 2 && segments[0] === 'measurement' && segments[1] === 'measurements' && /measurementcollection\+json/i.test(accept ?? '')) {
    return Response.json({ error: 'general/internalError', message: 'Cannot invoke "java.util.List.size()" because the return value of "com.cumulocity.rest.representation.measurement.MeasurementCollectionRepresentation.getMeasurements()" is null', info: ERROR_INFO }, { status: 500, headers: { 'content-type': ERROR_MEDIA_TYPE } })
  }
  return new Response(null, { status: 406 })
}
