// The fake tenant against the OpenAPI spec: every response of every emulated
// endpoint has a documented status and matches the documented schema, and
// documented defaults hold. The schemas come from tests/contract/spec.generated.json
// (pnpm gen:capabilities). Where the platform itself deviates from the
// spec, docs/platform-behavior.md lists it and tests/contract/deviations.ts
// allows it. The fake answers `application/json` where the platform uses its
// vendor media types; the media type itself is not compared.
import { Buffer } from 'node:buffer'
import { BasicAuth, Client } from '@c8y/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { C8Y_ENDPOINTS } from '../../src'
import type { C8yEndpoint } from '../../src'
import { fakePlatform } from './fake-platform'
import { DEVIATIONS, EMPTY_BODY_DEVIATIONS, SCHEMA_DEVIATIONS } from './deviations'
import spec from './spec.generated.json' with { type: 'json' }
import { checkSchema } from './schema'
import type { Schema } from './schema'

/**
 * Documented success statuses no request can reach on the fake, with the reason.
 */
const UNREACHABLE: Record<string, string> = {
  'POST /inventory/managedObjects 200': 'the platform answers 201 (200 is listed for an upsert the fake does not emulate)',
  'DELETE /inventory/managedObjects/{id} 202': 'the asynchronous (cascading) delete of a large hierarchy',
  'GET /measurement/measurements/{id} 200': 'time series persistence answers 405 (measurement-by-id-405)',
  'PUT /alarm/alarms 202': 'the platform answers 200 for a small bulk update; 202 is the asynchronous one',
  'POST /notification2/unsubscribe 200': 'the platform answers 204 (unsubscribe-statuses)',
  'GET /inventory/managedObjects/{id}/availability 200': 'only device connections fill the availability cache (availability-not-in-cache)',
  'PUT /tenant/options/{category}/{key}/editable 200': 'only the management tenant may change it; a tenant gets 403',
  'GET /tenant/tenants/{tenantId}/applications 200': 'only the management tenant lists subscriptions; a tenant gets 403 (tenant-applications-list-403)',
  'GET /tenant/statistics/files 200': 'a tenant admin may not read statistics files; the platform answers 403 (statistics-files-403)',
  'GET /tenant/statistics/files/{id} 200': 'a tenant admin may not read statistics files; the platform answers 403 (statistics-files-403)',
  'GET /tenant/statistics/files/latest/{month} 200': 'a tenant admin may not read statistics files; the platform answers 403 (statistics-files-403)',
  'GET /tenant/tenants/{tenantId} 200': 'a tenant admin may not read tenants, also not its own (tenant-read-403)',
  'GET /tenant/loginOptions/{typeOrId}/accessMappings/{id} 200': 'the built-in login options have no access mappings',
  'GET /tenant/loginOptions/{typeOrId}/inventoryAccessMappings/{id} 200': 'the built-in login options have no access mappings',
}

/**
 * The shape of every error body (the spec's `error` schema).
 */
const ERROR_SCHEMA: Schema = { type: 'object', required: ['error', 'message'], properties: { error: { type: 'string' }, message: { type: 'string' }, info: { type: 'string' } } }

const { world } = fakePlatform()
const client = new Client(new BasicAuth({ tenant: world.tenant, user: 'test-user', password: 'contract-password' }), world.baseUrl)
const checked = new Set<string>()
const usedDeviations = new Set<string>()
const problems: string[] = []

function endpointOf(method: string, path: string): C8yEndpoint | undefined {
  const candidates = (Object.keys(C8Y_ENDPOINTS) as C8yEndpoint[]).filter((endpoint) => {
    const [m, template] = endpoint.split(' ') as [string, string]
    return m === method && new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path)
  })
  // a literal path (`/measurement/measurements/series`) wins over `{id}`
  return candidates.sort((a, b) => (a.split('{').length) - (b.split('{').length))[0]
}

/**
 * Sends a request to the fake and checks the response against the spec.
 * @param method
 * @param path
 * @param body
 * @param headers
 */
async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number, json: any }> {
  const raw = body === undefined || typeof body === 'string' || body instanceof Uint8Array || body instanceof FormData
  const init = {
    method,
    headers: { accept: 'application/json', ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : (raw ? body as any : JSON.stringify(body)),
  }
  // other credentials than the client's: the client would add its own
  const res = headers.authorization ? await fetch(`${world.baseUrl}${path}`, init) : await client.core.fetch(path, init)
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {}
  const endpoint = endpointOf(method, path.split('?')[0]!)
  expect(endpoint, `${method} ${path} is not an emulated endpoint`).toBeDefined()
  const documented = (spec.responses as Record<string, Record<string, Record<string, Schema>>>)[endpoint!]!
  const label = `${method} ${path} → ${res.status}`
  checked.add(`${endpoint} ${res.status}`)
  const deviation = DEVIATIONS[endpoint!]?.[res.status]
  const emptyBody = EMPTY_BODY_DEVIATIONS[endpoint!]?.[res.status]
  if (deviation) {
    usedDeviations.add(`${endpoint} ${res.status}`)
  } else if (emptyBody) {
    usedDeviations.add(`${endpoint} ${res.status}`)
    if (text !== '') {
      problems.push(`${label}: expected an empty body (${emptyBody}), got ${JSON.stringify(text.slice(0, 80))}`)
    }
    return { status: res.status, json }
  } else if (!documented[res.status]) {
    problems.push(`${label}: status not documented (documented: ${Object.keys(documented).join(', ')})`)
    return { status: res.status, json }
  }
  // an undocumented error status still has the platform's error body; a
  // documented body is only checked for JSON media types (binaries are bytes)
  const schemas = deviation
    ? (res.status >= 400 ? [ERROR_SCHEMA] : [])
    : Object.entries(documented[res.status] ?? {}).filter(([mediaType]) => mediaType.includes('json')).map(([, schema]) => schema)
  if (schemas.length > 0) {
    if (json === undefined) {
      problems.push(`${label}: expected a JSON body, got ${JSON.stringify(text.slice(0, 80))}`)
      return { status: res.status, json }
    }
    const results = schemas.map((schema) => checkSchema(json, schema).filter((problem) => {
      const matched = SCHEMA_DEVIATIONS.find((item) => item.problem.test(problem))
      if (matched) {
        usedDeviations.add(matched.id)
      }
      return !matched
    }))
    if (!results.some((result) => result.length === 0)) {
      problems.push(`${label}: ${results[0]!.join('; ')}`)
    }
  }
  return { status: res.status, json }
}

const q = (params: Record<string, string | number | boolean>) => new URLSearchParams(Object.entries(params).map(([key, value]): [string, string] => [key, String(value)])).toString()
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString()

describe('the fake tenant against the OpenAPI spec', { concurrent: false }, () => {
  beforeEach(() => {
    problems.length = 0
  })

  it('answers every emulated endpoint with a documented status and schema', async () => {
    const { json: device } = await request('POST', '/inventory/managedObjects', { name: 'Pump', type: 'c8y_Pump', c8y_IsDevice: {}, com_cumulocity_model_Agent: {} })
    const { json: child } = await request('POST', '/inventory/managedObjects', { name: 'Sensor', c8y_IsDevice: {} })
    await request('GET', `/inventory/managedObjects?${q({ pageSize: 2, withTotalPages: true, withTotalElements: true, withParents: true })}`)
    await request('GET', `/inventory/managedObjects?${q({ query: `$filter=(has(c8y_IsDevice)) $orderby=name asc` })}`)
    await request('GET', `/inventory/managedObjects?${q({ query: `$filter=(name ne 'x')` })}`)
    await request('GET', `/inventory/managedObjects/${device.id}?withChildren=false`)
    await request('GET', '/inventory/managedObjects/9999')
    await request('PUT', `/inventory/managedObjects/${device.id}`, { c8y_Extra: { a: 1 } })
    await request('PUT', '/inventory/managedObjects/9999', { name: 'x' })
    await request('PUT', '/inventory/managedObjects', { managedObjects: [{ id: device.id, c8y_Bulk: {} }] })
    await request('PUT', '/inventory/managedObjects', { managedObjects: [] })
    await request('PUT', '/inventory/managedObjects', { managedObjects: [{ id: '9999' }] })
    for (const kind of ['childDevices', 'childAssets', 'childAdditions']) {
      await request('POST', `/inventory/managedObjects/${device.id}/${kind}`, { managedObject: { id: child.id } })
      await request('POST', `/inventory/managedObjects/9999/${kind}`, { managedObject: { id: child.id } })
      await request('GET', `/inventory/managedObjects/${device.id}/${kind}?withTotalPages=true`)
      await request('GET', `/inventory/managedObjects/9999/${kind}`)
      await request('GET', `/inventory/managedObjects/${device.id}/${kind}/${child.id}`)
      await request('GET', `/inventory/managedObjects/${device.id}/${kind}/9999`)
      await request('DELETE', `/inventory/managedObjects/${device.id}/${kind}/${child.id}`)
      await request('DELETE', `/inventory/managedObjects/${device.id}/${kind}/${child.id}`)
      await request('GET', `/inventory/managedObjects/${device.id}/${kind}/${child.id}`)
      await request('POST', `/inventory/managedObjects/${device.id}/${kind}`, { managedObject: { id: child.id } })
      await request('DELETE', `/inventory/managedObjects/${device.id}/${kind}`, { references: [{ managedObject: { id: child.id } }] })
      await request('DELETE', `/inventory/managedObjects/${device.id}/${kind}`, { references: [{ managedObject: { id: child.id } }] })
      await request('DELETE', `/inventory/managedObjects/${device.id}/${kind}`, { references: [] })
      await request('DELETE', `/inventory/managedObjects/9999/${kind}`, { references: [{ managedObject: { id: child.id } }] })
    }
    await request('GET', `/inventory/managedObjects?${q({ withGroups: true, withChildrenCount: true, withLatestValues: true })}`)
    await request('GET', `/inventory/managedObjects/${device.id}?${q({ withChildrenCount: true, withParents: true })}`)

    await request('POST', `/identity/globalIds/${device.id}/externalIds`, { type: 'c8y_Serial', externalId: 'SN-1' })
    await request('POST', `/identity/globalIds/${child.id}/externalIds`, { type: 'c8y_Serial', externalId: 'SN-1' })
    await request('POST', `/identity/globalIds/${device.id}/externalIds`, { type: 'c8y_Serial' })
    await request('GET', `/identity/globalIds/${device.id}/externalIds`)
    await request('GET', '/identity/externalIds/c8y_Serial/SN-1')
    await request('GET', '/identity/externalIds/c8y_Serial/unknown')
    await request('DELETE', '/identity/externalIds/c8y_Serial/SN-1')
    await request('DELETE', '/identity/externalIds/c8y_Serial/SN-1')

    const source = { id: device.id }
    const { json: measurement } = await request('POST', '/measurement/measurements', { source, type: 'c8y_T', time: at(0), c8y_Temperature: { T: { value: 21.5, unit: 'C' } } })
    await request('POST', '/measurement/measurements', { measurements: [{ source, type: 'c8y_T', time: at(1), c8y_Temperature: { T: { value: 22, unit: 'C' } } }] })
    await request('POST', '/measurement/measurements', { source, type: 'c8y_T' })
    await request('POST', '/measurement/measurements', { source, type: 'c8y_T', time: 'garbage', c8y_T: { T: { value: 1 } } })
    await request('GET', `/measurement/measurements?${q({ source: device.id, dateFrom: at(0), dateTo: at(5), withTotalPages: true })}`)
    await request('GET', `/measurement/measurements?${q({ dateFrom: 'yesterday' })}`)
    await request('GET', `/measurement/measurements/${measurement.id}`)
    await request('GET', `/measurement/measurements/series?${q({ source: device.id, dateFrom: at(0), dateTo: at(5), aggregationInterval: '1m', aggregationFunction: 'avg' })}`)
    await request('GET', `/measurement/measurements/series?${q({ source: device.id, dateFrom: at(0), dateTo: at(5) })}`)
    await request('GET', `/measurement/measurements/series?${q({ source: device.id })}`)
    await request('GET', `/measurement/measurements/series?${q({ source: device.id, dateFrom: at(0), dateTo: at(5), aggregationFunction: 'avg' })}`)
    for (const kind of ['supportedSeries', 'supportedMeasurements', 'availability']) {
      await request('GET', `/inventory/managedObjects/${device.id}/${kind}`)
      await request('GET', `/inventory/managedObjects/9999/${kind}`)
    }
    await request('GET', `/inventory/managedObjects/${device.id}/user`)
    await request('PUT', `/inventory/managedObjects/${device.id}/user`, { enabled: true })
    await request('GET', '/inventory/managedObjects/9999/user')
    await request('DELETE', `/measurement/measurements/${measurement.id}`)
    await request('DELETE', `/measurement/measurements/${measurement.id}`)
    await request('DELETE', `/measurement/measurements?${q({ source: device.id })}`)

    const { json: event } = await request('POST', '/event/events', { source, type: 'c8y_Note', text: 'hi', time: at(0) })
    await request('POST', '/event/events', { source, type: 'c8y_Note', text: 'hi', time: 'garbage' })
    await request('POST', '/event/events', { source: { id: '9999' }, type: 'c8y_Note', text: 'hi', time: at(0) })
    await request('GET', `/event/events?${q({ source: device.id, withSourceChildren: true, withTotalElements: true })}`)
    await request('GET', `/event/events?${q({ source: '9999', withSourceAssets: true })}`)
    await request('GET', `/event/events?${q({ dateFrom: '2026-01-01T10:00Z' })}`)
    await request('GET', `/event/events/${event.id}`)
    await request('GET', '/event/events/9999')
    await request('PUT', `/event/events/${event.id}`, { text: 'updated' })
    await request('PUT', `/event/events/${event.id}`, { time: at(2) })
    await request('POST', `/event/events/${event.id}/binaries`, 'hello', { 'content-type': 'text/plain' })
    await request('GET', `/event/events/${event.id}/binaries`)
    await request('PUT', `/event/events/${event.id}/binaries`, 'hello again', { 'content-type': 'text/plain' })
    await request('DELETE', `/event/events/${event.id}/binaries`)
    await request('GET', `/event/events/${event.id}/binaries`)
    await request('DELETE', `/event/events/${event.id}`)
    await request('DELETE', `/event/events/${event.id}`)
    await request('DELETE', `/event/events?${q({ source: device.id })}`)

    const { json: alarm } = await request('POST', '/alarm/alarms', { source, type: 'c8y_Hot', text: 'hot', severity: 'MAJOR', time: at(0) })
    await request('POST', '/alarm/alarms', { source, type: 'c8y_Hot', text: 'hot', severity: 'MAJOR', time: at(1) })
    await request('POST', '/alarm/alarms', { source: { id: '9999' }, type: 'c8y_Hot', text: 'hot', severity: 'MAJOR', time: at(0) })
    await request('POST', '/alarm/alarms', { source, type: 'c8y_Hot', text: 'hot', severity: 'MAJOR', time: 'garbage' })
    await request('POST', '/alarm/alarms', { source, type: 'c8y_Hot', text: 'hot', time: at(0) })
    await request('GET', `/alarm/alarms?${q({ source: device.id, status: 'ACTIVE', withTotalPages: true })}`)
    await request('GET', `/alarm/alarms?${q({ source: device.id, resolved: true })}`)
    await request('GET', `/alarm/alarms?${q({ source: '9999', withSourceDevices: true })}`)
    await request('GET', `/alarm/alarms?${q({ dateFrom: 'yesterday' })}`)
    await request('GET', `/alarm/alarms/count?${q({ source: device.id, status: 'ACTIVE' })}`)
    await request('GET', `/alarm/alarms/count?${q({ source: '9999', withSourceAssets: true })}`)
    await request('GET', `/alarm/alarms/count?${q({ withSourceAssets: true })}`)
    await request('GET', `/alarm/alarms/${alarm.id}`)
    await request('GET', '/alarm/alarms/9999')
    await request('PUT', `/alarm/alarms/${alarm.id}`, { status: 'ACKNOWLEDGED' })
    await request('PUT', `/alarm/alarms/${alarm.id}`, { type: 'changed' })
    await request('POST', '/alarm/alarms/upsert', { source, type: 'c8y_Upserted' })
    await request('POST', '/alarm/alarms/upsert?incrementCount=true', { source, type: 'c8y_Upserted', text: 'again' })
    await request('POST', '/alarm/alarms/upsert', { source })
    await request('PUT', `/alarm/alarms?${q({ source: device.id })}`, { status: 'CLEARED' })
    await request('PUT', `/alarm/alarms?${q({ source: '9999', withSourceDevices: true })}`, { status: 'CLEARED' })
    await request('DELETE', `/alarm/alarms?${q({ type: 'c8y_Hot' })}`)
    await request('DELETE', `/alarm/alarms?${q({ source: device.id, status: 'CLEARED', severity: 'MAJOR', type: 'c8y_Hot', resolved: true, createdFrom: at(0), createdTo: '2099-01-01', dateFrom: at(0), dateTo: '2099-01-01', withSourceChildren: true, withSourceDevices: true, withSourceAssets: true, withSourceAdditions: true })}`)

    const { json: operation } = await request('POST', '/devicecontrol/operations', { deviceId: device.id, c8y_Restart: {} })
    await request('POST', '/devicecontrol/operations', { deviceId: child.id, c8y_Restart: {} })
    await request('POST', '/devicecontrol/operations', { deviceId: device.id })
    await request('GET', `/devicecontrol/operations?${q({ deviceId: device.id, status: 'PENDING' })}`)
    await request('GET', `/devicecontrol/operations?${q({ status: 'BOGUS' })}`)
    await request('GET', `/devicecontrol/operations/${operation.id}`)
    await request('GET', '/devicecontrol/operations/9999')
    await request('PUT', `/devicecontrol/operations/${operation.id}`, { status: 'EXECUTING' })
    await request('PUT', `/devicecontrol/operations/${operation.id}`, { status: 'BOGUS' })
    await request('DELETE', `/devicecontrol/operations?${q({ deviceId: child.id, status: 'BOGUS' })}`)
    await request('DELETE', `/devicecontrol/operations?${q({ deviceId: child.id, status: 'FAILED', dateFrom: at(0), dateTo: '2099-01-01' })}`)

    const { json: group } = await request('POST', '/inventory/managedObjects', { name: 'Group', c8y_IsDeviceGroup: {} })
    // the child has no agent: its operation fails first (EXECUTING_WITH_ERROR)
    await request('POST', `/inventory/managedObjects/${group.id}/childAssets`, { managedObject: { id: child.id } })
    await request('POST', `/inventory/managedObjects/${group.id}/childAssets`, { managedObject: { id: device.id } })
    const prototype = { description: 'restart', c8y_Restart: {} }
    const { json: bulk } = await request('POST', '/devicecontrol/bulkoperations', { groupId: group.id, startDate: at(0), creationRamp: 1, operationPrototype: prototype })
    await request('POST', '/devicecontrol/bulkoperations', { groupId: group.id, startDate: 'tomorrow', creationRamp: 1, operationPrototype: prototype })
    await request('POST', '/devicecontrol/bulkoperations', { groupId: '9999', startDate: at(0), creationRamp: 1, operationPrototype: prototype })
    await request('GET', `/devicecontrol/bulkoperations?${q({ pageSize: 1, withTotalElements: true })}`)
    await request('GET', `/devicecontrol/bulkoperations/${bulk.id}`)
    await request('GET', '/devicecontrol/bulkoperations/9999')
    await request('GET', '/devicecontrol/bulkoperations/abc')
    await request('PUT', `/devicecontrol/bulkoperations/${bulk.id}`, {})
    await request('PUT', `/devicecontrol/bulkoperations/${bulk.id}`, { generalStatus: 'CANCELED' })
    const { json: scheduled } = await request('POST', '/devicecontrol/bulkoperations', { groupId: group.id, startDate: '2099-01-01T00:00:00Z', creationRamp: 1, operationPrototype: prototype })
    const { json: replaced } = await request('PUT', `/devicecontrol/bulkoperations/${scheduled.id}`, { creationRamp: 2 })
    await request('PUT', '/devicecontrol/bulkoperations/9999', { creationRamp: 2 })
    await request('DELETE', `/devicecontrol/bulkoperations/${replaced.id}`)
    await request('DELETE', `/devicecontrol/bulkoperations/${replaced.id}`)
    await request('DELETE', `/devicecontrol/operations?${q({ bulkOperationId: bulk.id, deviceId: device.id })}`)

    await request('POST', '/devicecontrol/newDeviceRequests', { id: 'serial-1', type: 'c8y_Test' })
    await request('POST', '/devicecontrol/newDeviceRequests', { id: 'serial-1' })
    await request('GET', `/devicecontrol/newDeviceRequests?${q({ withTotalPages: true, withTotalElements: true })}`)
    await request('GET', '/devicecontrol/newDeviceRequests/serial-1')
    await request('GET', '/devicecontrol/newDeviceRequests/unknown')
    await request('PUT', '/devicecontrol/newDeviceRequests/serial-1', { status: 'ACCEPTED' })
    await request('PUT', '/devicecontrol/newDeviceRequests/serial-1', { status: 'BLOCKED' })
    await request('PUT', '/devicecontrol/newDeviceRequests/serial-1', { status: 'BOGUS' })
    world.db.newDeviceRequests.connect('serial-1')
    await request('PUT', '/devicecontrol/newDeviceRequests/serial-1', { status: 'ACCEPTED' })
    await request('DELETE', '/devicecontrol/newDeviceRequests/serial-1')
    await request('DELETE', '/devicecontrol/newDeviceRequests/serial-1')

    const upload = new FormData()
    upload.append('object', JSON.stringify({ name: 'file.txt', type: 'text/plain' }))
    upload.append('file', new Blob([Buffer.from('content')], { type: 'text/plain' }), 'file.txt')
    const { json: binary } = await request('POST', '/inventory/binaries', upload)
    await request('GET', '/inventory/binaries?pageSize=1')
    await request('GET', `/inventory/binaries/${binary.id}`)
    await request('GET', '/inventory/binaries/9999')
    await request('PUT', `/inventory/binaries/${binary.id}`, 'new content', { 'content-type': 'text/plain' })
    await request('DELETE', `/inventory/binaries/${binary.id}`)
    await request('DELETE', `/inventory/binaries/${binary.id}`)
    await request('DELETE', `/inventory/managedObjects/${device.id}`)

    const { json: subscription } = await request('POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'specsub', subscriptionFilter: { apis: ['alarms'] } })
    await request('POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'specsub' })
    await request('POST', '/notification2/subscriptions', { context: 'mo', subscription: 'other', source: { id: '9999' } })
    await request('GET', '/notification2/subscriptions?context=tenant')
    await request('GET', `/notification2/subscriptions/${subscription.id}`)
    await request('GET', '/notification2/subscriptions/9999')
    const { json: token } = await request('POST', '/notification2/token', { subscriber: 'spec', subscription: 'specsub' })
    await request('POST', '/notification2/token', { subscription: 'specsub' })
    await request('POST', `/notification2/unsubscribe?token=${token.token}`)
    await request('POST', '/notification2/unsubscribe')
    await request('DELETE', `/notification2/subscriptions/${subscription.id}`)
    await request('DELETE', `/notification2/subscriptions/${subscription.id}`)
    await request('DELETE', '/notification2/subscriptions?context=tenant')

    await request('GET', '/tenant/currentTenant')
    await request('POST', '/tenant/options', { category: 'spec', key: 'a', value: 'one' })
    await request('POST', '/tenant/options', { category: 'spec', value: 'one' })
    await request('PUT', '/tenant/options/spec', { 'b': 'two', 'credentials.c': 'three' })
    await request('PUT', '/tenant/options/spec/a', { value: 'uno' })
    await request('GET', '/tenant/options?withTotalPages=true&pageSize=1&currentPage=2')
    await request('GET', '/tenant/options/spec')
    await request('GET', '/tenant/options/spec/a')
    await request('GET', '/tenant/options/spec/nope')
    await request('PUT', '/tenant/options/spec/a/editable', { editable: 'false' })
    await request('DELETE', '/tenant/options/spec/a')
    await request('DELETE', '/tenant/options/spec/a')
    await request('GET', '/tenant/system/options')
    await request('GET', '/tenant/system/options/system/version')
    await request('GET', '/tenant/system/options/system/nope')

    world.seed({
      usageStatistics: [{ day: '2026-01-02', requestCount: 3, devices: { 1: 2 }, resources: { cpu: 1, memory: 2, usedBy: [{ name: 'svc', cpu: 1, memory: 2, cause: 'Owner' }] }, subscribedApplications: ['cockpit'] }],
      trustedCertificates: [{ fingerprint: 'ab12', name: 'ca', issuer: 'CN=ca', subject: 'CN=ca', notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2029-01-01T00:00:00.000Z', certInPemFormat: 'MIIB', serialNumber: '1', algorithmName: 'SHA256withECDSA' }],
    })
    await request('GET', '/tenant/statistics?pageSize=2&withTotalPages=true&withTotalElements=true')
    await request('GET', '/tenant/statistics?dateFrom=2026-01-01&dateTo=2026-01-03')
    await request('GET', '/tenant/statistics?dateFrom=bad')
    await request('GET', '/tenant/statistics/summary')
    await request('GET', `/tenant/statistics/summary?dateFrom=2020-01-01&dateTo=2020-01-02&tenant=${world.tenant}`)
    await request('GET', '/tenant/statistics/summary?tenant=other')
    await request('GET', '/tenant/statistics/summary?dateTo=bad')
    await request('GET', '/tenant/statistics/allTenantsSummary')
    await request('GET', '/tenant/statistics/allTenantsSummary?dateFrom=bad')
    await request('GET', `/tenant/statistics/device/${world.tenant}/daily/2026-01-02?pageSize=1`)
    await request('GET', `/tenant/statistics/device/${world.tenant}/daily/bad`)
    await request('GET', '/tenant/statistics/device/other/daily/2026-01-02')
    await request('GET', `/tenant/statistics/device/${world.tenant}/monthly/2026-01-01?withTotalPages=true`)
    await request('GET', `/tenant/statistics/device/${world.tenant}/monthly/2026-01`)
    await request('GET', '/tenant/statistics/device/other/monthly/2026-01-01')
    await request('GET', '/tenant/statistics/files')
    await request('GET', '/tenant/statistics/files?dateFrom=bad')
    await request('GET', '/tenant/statistics/files/1')
    await request('GET', '/tenant/statistics/files/latest/2026-10-01')
    await request('GET', '/tenant/statistics/files/latest/2026-10')

    await request('GET', '/tenant/tenants?withTotalPages=true')
    await request('GET', `/tenant/tenants/${world.tenant}`)
    await request('GET', `/tenant/tenants/${world.tenant}/tfa`)
    await request('GET', '/tenant/tenants/other/tfa')
    await request('GET', `/tenant/tenants/${world.tenant}/applications/restricted-roles`)
    await request('GET', '/tenant/tenants/other/applications/restricted-roles')
    await request('GET', `/tenant/tenants/${world.tenant}/trusted-certificates?withTotalPages=true`)
    await request('GET', '/tenant/tenants/other/trusted-certificates')
    await request('GET', `/tenant/tenants/${world.tenant}/trusted-certificates/ab12`)
    await request('GET', `/tenant/tenants/${world.tenant}/trusted-certificates/AB12`)
    await request('GET', '/tenant/tenants/other/trusted-certificates/ab12')
    await request('GET', '/tenant/loginOptions')
    await request('GET', '/tenant/loginOptions?management=true')
    await request('GET', '/tenant/loginOptions?tenantId=other')
    await request('GET', `/tenant/loginOptions?tenantId=${world.tenant}&management=true`)
    await request('GET', '/tenant/loginOptions/basic')
    await request('GET', '/tenant/loginOptions/NOPE')
    await request('GET', '/tenant/loginOptions/OAUTH2_INTERNAL/accessMappings')
    await request('GET', '/tenant/loginOptions/NOPE/accessMappings')
    await request('GET', '/tenant/loginOptions/BASIC/accessMappings/1')
    await request('GET', '/tenant/loginOptions/OAUTH2_INTERNAL/inventoryAccessMappings')
    await request('GET', '/tenant/loginOptions/NOPE/inventoryAccessMappings')
    await request('GET', '/tenant/loginOptions/BASIC/inventoryAccessMappings/1')

    const { json: rule } = await request('POST', '/retention/retentions', { dataType: 'EVENT', type: 'c8y_Note', maximumAge: 30 })
    await request('POST', '/retention/retentions', { dataType: 'EVENT' })
    await request('POST', '/retention/retentions', { dataType: 'EVENT', maximumAge: 'ten' })
    await request('GET', '/retention/retentions?withTotalPages=true&withTotalElements=true&pageSize=1&currentPage=1')
    await request('GET', `/retention/retentions/${rule.id}`)
    await request('GET', '/retention/retentions/9999')
    await request('GET', '/retention/retentions/abc')
    await request('PUT', `/retention/retentions/${rule.id}`, { maximumAge: 31 })
    await request('PUT', `/retention/retentions/${rule.id}`, { dataType: 'OPERATION' })
    await request('DELETE', `/retention/retentions/${rule.id}`)
    await request('DELETE', `/retention/retentions/${rule.id}`)

    const { json: audits } = await request('GET', `/audit/auditRecords?${q({ type: 'Alarm', user: 'test-user', source: alarm.id, pageSize: 5, currentPage: 1, withTotalPages: true, withTotalElements: true })}`)
    await request('GET', `/audit/auditRecords?${q({ application: 'cockpit', dateFrom: '2020-01-01', dateTo: '2100-01-01' })}`)
    await request('GET', `/audit/auditRecords?${q({ dateFrom: 'yesterday' })}`)
    await request('POST', '/audit/auditRecords', { type: 'Alarm', time: '2026-01-01T10:00:00.000Z', text: 'spec', activity: 'Spec check', source: { id: alarm.id } })
    await request('GET', `/audit/auditRecords/${audits.auditRecords[0].id}`)
    await request('GET', '/audit/auditRecords/9999')

    await request('POST', `/identity/globalIds/${child.id}/externalIds`, { type: 'c8y_Serial', externalId: 'SN-2' })
    await request('POST', '/identity/search', { externalIds: [{ type: 'c8y_Serial', externalId: 'SN-2' }, { type: 'c8y_Serial', externalId: 'none' }] })
    await request('POST', '/identity/search', { externalIds: [] })
    await request('POST', '/identity/search', { externalIds: 'SN-2' })

    const T = world.tenant
    await request('GET', `/application/applications?${q({ pageSize: 3, withTotalPages: true, withTotalElements: true, type: 'HOSTED' })}`)
    await request('GET', '/application/applications?user=nobody')
    const { json: hosted } = await request('POST', '/application/applications', { name: 'spec-h', key: 'spec-h-key', type: 'HOSTED', contextPath: 'spec-h', resourcesUrl: '/' })
    const { json: microservice } = await request('POST', '/application/applications', { name: 'spec-m', key: 'spec-m-key', type: 'MICROSERVICE', contextPath: 'spec-m' })
    await request('POST', '/application/applications', { name: 'spec-e', key: 'spec-e-key', type: 'EXTERNAL', externalUrl: 'https://example.com' })
    await request('POST', '/application/applications', { name: 'spec-h', key: 'x', type: 'HOSTED', contextPath: 'x' })
    await request('POST', '/application/applications', { name: 'spec-x', type: 'HOSTED' })
    await request('GET', `/application/applications/${hosted.id}`)
    await request('GET', '/application/applications/999999999')
    await request('PUT', `/application/applications/${hosted.id}`, { description: 'd' })
    await request('PUT', `/application/applications/${hosted.id}`, { type: 'EXTERNAL' })
    await request('GET', `/application/applications/${hosted.id}/bootstrapUser`)
    const { json: bootstrap } = await request('GET', `/application/applications/${microservice.id}/bootstrapUser`)
    await request('GET', '/application/applications/7/bootstrapUser')
    await request('GET', '/application/applicationsByName/spec-h')
    await request('GET', `/application/applicationsByOwner/${T}`)
    await request('GET', `/application/applicationsByTenant/${T}`)
    await request('GET', '/application/applicationsByUser/test-user')
    await request('GET', '/application/applicationsByUser/nobody')
    const asBootstrap = { authorization: `Basic ${Buffer.from(`${T}/${bootstrap.name}:${bootstrap.password}`).toString('base64')}` }
    await request('GET', '/application/currentApplication', undefined, asBootstrap)
    await request('PUT', '/application/currentApplication', { description: 'd' }, asBootstrap)
    await request('GET', '/application/currentApplication/settings', undefined, asBootstrap)
    await request('GET', '/application/currentApplication')
    await request('GET', `/tenant/tenants/${T}/applications`)
    await request('POST', `/tenant/tenants/${T}/applications`, { application: { id: microservice.id } })
    await request('POST', `/tenant/tenants/${T}/applications`, { application: { id: microservice.id } })
    await request('POST', `/tenant/tenants/${T}/applications`, { application: { id: '999999999' } })
    await request('POST', `/tenant/tenants/${T}/applications`, {})
    await request('DELETE', `/tenant/tenants/${T}/applications/${microservice.id}`)
    await request('DELETE', `/tenant/tenants/${T}/applications/${microservice.id}`)
    await request('DELETE', `/application/applications/${hosted.id}`)
    await request('DELETE', `/application/applications/${hosted.id}`)

    expect(problems).toEqual([])
  })

  it('answers the user API with documented statuses and schemas', async () => {
    const T = world.tenant
    const base = world.baseUrl
    const password = 'Spec-Password-1'
    await request('POST', `/user/${T}/users`, { userName: 'spec.a', email: 'spec.a@example.com', password, firstName: 'Spec' })
    await request('POST', `/user/${T}/users`, { userName: 'spec.b', email: 'spec.b@example.com', password })
    await request('POST', `/user/${T}/users`, { userName: 'spec.a', email: 'spec.c@example.com', password })
    await request('POST', `/user/${T}/users`, { userName: 'spec.c', email: 'spec.c@example.com' })
    await request('GET', `/user/${T}/users?${q({ username: 'spec', pageSize: 1, withTotalElements: true, withSubusersCount: true })}`)
    await request('GET', `/user/${T}/users?${q({ username: 'spec', usernameContains: 'a' })}`)
    await request('GET', `/user/${T}/users/spec.a`)
    await request('GET', '/user/t0000001/users/spec.a')
    await request('GET', `/user/${T}/users/spec.nope`)
    await request('GET', `/user/${T}/userByName/spec.a`)
    await request('GET', `/user/${T}/userByName/spec.nope`)
    await request('PUT', `/user/${T}/users/spec.a`, { lastName: 'Lee' })
    await request('PUT', `/user/${T}/users/spec.a`, { userName: 'x' })
    await request('PUT', `/user/${T}/users/spec.nope`, { lastName: 'Lee' })
    await request('POST', `/user/${T}/users/spec.a/roles`, { role: { self: `${base}/user/roles/ROLE_ALARM_READ` } })
    await request('POST', `/user/${T}/users/spec.a/roles`, { role: { self: `${base}/user/roles/ROLE_NOPE` } })
    await request('POST', `/user/${T}/users/spec.nope/roles`, { role: { self: `${base}/user/roles/ROLE_ALARM_READ` } })
    await request('DELETE', `/user/${T}/users/spec.a/roles/ROLE_ALARM_READ`)
    await request('DELETE', `/user/${T}/users/spec.a/roles/ROLE_ALARM_READ`)

    const { json: group } = await request('POST', `/user/${T}/groups`, { name: 'spec-group' })
    await request('POST', `/user/${T}/groups`, { name: 'spec-group' })
    await request('POST', `/user/${T}/groups`, { description: 'no name' })
    await request('GET', `/user/${T}/groups?${q({ pageSize: 2, withTotalElements: true })}`)
    await request('GET', `/user/${T}/groups/${group.id}`)
    await request('GET', `/user/${T}/groups/999999`)
    await request('GET', `/user/${T}/groupByName/spec-group`)
    await request('GET', `/user/${T}/groupByName/spec-nope`)
    await request('PUT', `/user/${T}/groups/${group.id}`, { name: 'spec-group', description: 'd' })
    await request('PUT', `/user/${T}/groups/${group.id}`, { description: 'd' })
    await request('PUT', `/user/${T}/groups/999999`, { name: 'x' })
    await request('PUT', `/user/${T}/groups/${group.id}`, { name: 'admins' })
    await request('POST', `/user/${T}/groups/${group.id}/users`, { user: { self: `${base}/user/${T}/users/spec.a` } })
    await request('POST', `/user/${T}/groups/${group.id}/users`, { user: { self: `${base}/user/${T}/users/spec.a` } })
    await request('POST', `/user/${T}/groups/${group.id}/users`, { user: { id: 'spec.a' } })
    await request('POST', `/user/${T}/groups/999999/users`, { user: { self: `${base}/user/${T}/users/spec.a` } })
    await request('GET', `/user/${T}/groups/${group.id}/users?withTotalElements=true`)
    await request('GET', `/user/${T}/groups/999999/users`)
    await request('GET', `/user/${T}/users/spec.a/groups`)
    await request('GET', `/user/${T}/users/spec.nope/groups`)
    await request('POST', `/user/${T}/groups/${group.id}/roles`, { role: { self: `${base}/user/roles/ROLE_ALARM_READ` } })
    await request('POST', `/user/${T}/groups/${group.id}/roles`, { role: { self: `${base}/user/roles/ROLE_ALARM_READ` } })
    await request('POST', `/user/${T}/groups/${group.id}/roles`, { role: { id: 'ROLE_ALARM_READ' } })
    await request('POST', `/user/${T}/groups/${group.id}/roles`, { role: { self: `${base}/user/roles/ROLE_NOPE` } })
    await request('POST', `/user/${T}/groups/999999/roles`, { role: { self: `${base}/user/roles/ROLE_ALARM_READ` } })
    await request('GET', `/user/${T}/groups/${group.id}/roles`)
    await request('GET', `/user/${T}/groups/999999/roles`)
    await request('DELETE', `/user/${T}/groups/${group.id}/roles/ROLE_ALARM_READ`)
    await request('DELETE', `/user/${T}/groups/${group.id}/roles/ROLE_ALARM_READ`)
    await request('DELETE', `/user/${T}/groups/${group.id}/roles/ROLE_NOPE`)
    await request('DELETE', `/user/${T}/groups/${group.id}/users/spec.a`)
    await request('DELETE', `/user/${T}/groups/${group.id}/users/spec.nope`)
    await request('DELETE', `/user/${T}/groups/999999/users/spec.a`)

    await request('GET', `/user/roles?${q({ pageSize: 3, withTotalElements: true })}`)
    await request('GET', '/user/roles/ROLE_ALARM_READ')
    await request('GET', '/user/roles/ROLE_NOPE')

    const { json: role } = await request('POST', '/user/inventoryroles', { name: 'spec-role', permissions: [{ permission: 'READ', scope: 'ALARM', type: '*' }] })
    await request('POST', '/user/inventoryroles', { name: 'spec-role' })
    await request('POST', '/user/inventoryroles', { name: 'spec-bad', permissions: [{ permission: 'WRITE', scope: 'ALARM', type: '*' }] })
    await request('GET', '/user/inventoryroles?withTotalElements=true')
    await request('GET', `/user/inventoryroles/${role.id}`)
    await request('GET', '/user/inventoryroles/999999')
    await request('PUT', `/user/inventoryroles/${role.id}`, { description: 'd' })
    await request('PUT', '/user/inventoryroles/999999', { description: 'd' })
    const { json: device } = await request('POST', '/inventory/managedObjects', { name: 'Spec device', c8y_IsDevice: {} })
    const assignments = `/user/${T}/users/spec.a/roles/inventory`
    const { json: assignment } = await request('POST', assignments, { managedObject: device.id, roles: [{ id: role.id }] })
    await request('POST', assignments, { managedObject: device.id, roles: [{ id: role.id }] })
    await request('POST', assignments, { managedObject: device.id, roles: [{ id: 999999 }] })
    await request('DELETE', `/user/inventoryroles/${role.id}`)
    await request('POST', assignments, { roles: [] })
    await request('GET', assignments)
    await request('GET', `/user/${T}/users/spec.nope/roles/inventory`)
    await request('GET', `${assignments}/${assignment.id}`)
    await request('GET', `${assignments}/999999`)
    await request('PUT', `${assignments}/${assignment.id}`, { roles: [{ id: 1 }] })
    await request('PUT', `${assignments}/999999`, { roles: [{ id: 1 }] })
    await request('DELETE', `/user/inventoryroles/${role.id}`)
    await request('DELETE', `${assignments}/${assignment.id}`)
    await request('DELETE', `${assignments}/${assignment.id}`)
    await request('DELETE', `/user/inventoryroles/${role.id}`)
    await request('DELETE', `/user/inventoryroles/${role.id}`)
    await request('GET', `/user/devicePermissions/${device.id}`)

    await request('DELETE', `/user/${T}/groups/${group.id}`)
    await request('DELETE', `/user/${T}/groups/${group.id}`)
    await request('DELETE', `/user/${T}/users/spec.a`)
    await request('DELETE', `/user/${T}/users/spec.a`)
    expect(problems).toEqual([])
  })

  it('keeps the documented page size default and the paging limits', async () => {
    const { json: device } = await request('POST', '/inventory/managedObjects', { name: 'Pump', c8y_IsDevice: {}, com_cumulocity_model_Agent: {} })
    const lists: Array<[C8yEndpoint, string]> = [
      ['GET /inventory/managedObjects', '/inventory/managedObjects'],
      ['GET /inventory/managedObjects/{id}/childDevices', `/inventory/managedObjects/${device.id}/childDevices`],
      ['GET /measurement/measurements', '/measurement/measurements'],
      ['GET /event/events', '/event/events'],
      ['GET /alarm/alarms', '/alarm/alarms'],
      ['GET /devicecontrol/operations', '/devicecontrol/operations'],
      ['GET /devicecontrol/bulkoperations', '/devicecontrol/bulkoperations'],
      ['GET /devicecontrol/newDeviceRequests', '/devicecontrol/newDeviceRequests'],
      ['GET /inventory/binaries', '/inventory/binaries'],
      ['GET /notification2/subscriptions', '/notification2/subscriptions'],
      ['GET /retention/retentions', '/retention/retentions'],
      ['GET /audit/auditRecords', '/audit/auditRecords'],
    ]
    for (const [endpoint, path] of lists) {
      const params = (spec.parameters as Record<string, Record<string, { default?: unknown, minimum?: number, maximum?: number }>>)[endpoint]!
      const { json } = await request('GET', path)
      expect(json.statistics.pageSize, endpoint).toBe(params.pageSize!.default)
      expect(json.statistics.currentPage, endpoint).toBe(params.currentPage!.default)
      // `withTotalPages` and `withTotalElements` default to false
      expect(json.statistics, endpoint).not.toHaveProperty('totalElements')
      if (endpoint !== 'GET /inventory/binaries') {
        expect(json.statistics, endpoint).not.toHaveProperty('totalPages')
      }
      const { json: capped } = await request('GET', `${path}?pageSize=${params.pageSize!.maximum! + 1}`)
      expect(capped.statistics.pageSize, endpoint).toBe(params.pageSize!.maximum)
    }
    expect(problems).toEqual([])
  })

  // last on purpose: it sums up the requests of the tests above
  it('reached every documented success status and needed every deviation', () => {
    const unseen = (Object.keys(C8Y_ENDPOINTS) as C8yEndpoint[]).flatMap((endpoint) =>
      Object.keys((spec.responses as Record<string, Record<string, unknown>>)[endpoint] ?? {})
        .filter((status) => status.startsWith('2') && !checked.has(`${endpoint} ${status}`))
        .map((status) => `${endpoint} ${status}`),
    )
    expect(unseen.filter((status) => !UNREACHABLE[status]), 'documented success statuses no request reached').toEqual([])
    expect(Object.keys(UNREACHABLE).filter((status) => checked.has(status)), 'statuses listed as unreachable that a request reached').toEqual([])
    // every deviation is still needed
    const stale = [...Object.entries(DEVIATIONS), ...Object.entries(EMPTY_BODY_DEVIATIONS)].flatMap(([endpoint, statuses]) => Object.keys(statuses).map((status) => `${endpoint} ${status}`)).filter((key) => !usedDeviations.has(key))
    expect([...stale, ...SCHEMA_DEVIATIONS.map((item) => item.id).filter((id) => !usedDeviations.has(id))], 'deviations no response needed').toEqual([])
  })
})
