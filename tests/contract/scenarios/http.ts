// Cross-cutting HTTP behavior: media types, Accept negotiation, error bodies,
// path normalization, link parameters, and response headers.
import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { time } from '../helpers'

const VENDOR = 'application/vnd.com.nsn.cumulocity.'
const vendor = (name: string) => `${VENDOR}${name}+json;charset=UTF-8;ver=0.9`

interface Answer {
  status: number
  contentType: string | null
  location: string | null
  text: string
  json: any
}

/**
 * Sends a request through the client's fetch (base URL and credentials),
 * with `accept: application/json` unless another one is given.
 * @param client
 * @param method
 * @param path
 * @param options
 * @param options.body
 * @param options.accept
 * @param options.contentType
 * @param options.raw
 */
async function send(client: Client, method: string, path: string, options: { body?: unknown, accept?: string | undefined, contentType?: string, raw?: boolean } = {}): Promise<Answer> {
  const headers: Record<string, string> = { accept: options.accept ?? 'application/json' }
  if (options.body !== undefined) {
    headers['content-type'] = options.contentType ?? 'application/json'
  }
  const init = { method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }
  // the client strips slashes at both ends of a path: a raw request keeps them
  const res = options.raw
    ? await fetch(`${client.core.baseUrl!.replace(/\/+$/, '')}${path}`, client.core.getFetchOptions(init) as Parameters<typeof fetch>[1])
    : await client.core.fetch(path, init)
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { status: res.status, contentType: res.headers.get('content-type'), location: res.headers.get('location'), text, json }
}

export const httpScenarios: ContractScenario[] = [
  {
    name: 'http: every answer names the platform media type of its endpoint',
    verifies: ['media-types'],
    async run({ client, unique }) {
      const expectType = (answer: Answer, type: string | null, label: string) => {
        expect(answer.contentType, `${label} (${answer.status})`).toBe(type)
      }
      const device = await send(client, 'POST', '/inventory/managedObjects', { body: { name: `mt-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } })
      expectType(device, vendor('managedobject'), 'POST managed object')
      const id = device.json.id as string
      const source = { id }
      expectType(await send(client, 'GET', `/inventory/managedObjects/${id}`), vendor('managedobject'), 'GET managed object')
      expectType(await send(client, 'PUT', `/inventory/managedObjects/${id}`, { body: { mt_F: 1 } }), vendor('managedobject'), 'PUT managed object')
      expectType(await send(client, 'GET', `/inventory/managedObjects?fragmentType=mt_F&pageSize=1`), vendor('managedobjectcollection'), 'GET managed objects')
      const count = await send(client, 'GET', `/inventory/managedObjects/count?type=mt_${unique}`)
      expectType(count, 'text/plain', 'GET count')
      expect(count.text).toBe('0')
      const child = await send(client, 'POST', '/inventory/managedObjects', { body: { name: `mt-${unique}-child` } })
      // a reference added one by one is named in camel case
      expectType(await send(client, 'POST', `/inventory/managedObjects/${id}/childDevices`, { body: { managedObject: { id: child.json.id } } }), vendor('managedObjectReference'), 'POST child')
      expectType(await send(client, 'GET', `/inventory/managedObjects/${id}/childDevices`), vendor('managedobjectreferencecollection'), 'GET children')
      // the content type picks the variant: a reference collection is answered
      // as one (camel case, no Location), a created child as a managed object
      const more = await send(client, 'POST', '/inventory/managedObjects', { body: { name: `mt-${unique}-more` } })
      const references = await send(client, 'POST', `/inventory/managedObjects/${id}/childAssets`, { contentType: `${VENDOR}managedobjectreferencecollection+json`, accept: `${VENDOR}managedobjectreferencecollection+json`, body: { references: [{ managedObject: { id: more.json.id } }] } })
      expectType(references, vendor('managedObjectReferenceCollection'), 'POST child collection')
      expect(references.location).toBeNull()
      expect((await send(client, 'POST', `/inventory/managedObjects/${id}/childAssets`, { accept: `${VENDOR}managedObjectReferenceCollection+json`, body: { managedObject: { id: child.json.id } } })).status).toBe(406)
      expectType(await send(client, 'POST', `/inventory/managedObjects/${id}/childAssets`, { accept: `${VENDOR}managedobjectreference+json`, body: { managedObject: { id: child.json.id } } }), vendor('managedObjectReference'), 'POST child, Accept reference')
      const created = await send(client, 'POST', `/inventory/managedObjects/${id}/childAdditions`, { contentType: `${VENDOR}managedObject+json`, accept: `${VENDOR}managedobject+json`, body: { name: `mt-${unique}-addition` } })
      expectType(created, vendor('managedobject'), 'POST child by content type')
      expect(created.location).toBe(created.json.self)
      expectType(await send(client, 'GET', `/inventory/managedObjects/${id}/childDevices/${child.json.id}`), vendor('managedobjectreference'), 'GET child')
      expectType(await send(client, 'DELETE', `/inventory/managedObjects/${id}/childDevices/${child.json.id}`), null, 'DELETE child')
      expectType(await send(client, 'GET', `/inventory/managedObjects/${id}/supportedSeries`), 'application/json', 'GET supportedSeries')
      expectType(await send(client, 'GET', `/inventory/managedObjects/${id}/supportedMeasurements`), 'application/json', 'GET supportedMeasurements')
      expectType(await send(client, 'GET', `/inventory/managedObjects/${id}/user`), vendor('managedobjectuser'), 'GET owner user')

      expectType(await send(client, 'POST', `/identity/globalIds/${id}/externalIds`, { body: { type: 'mt_Serial', externalId: `mt-${unique}` } }), vendor('externalid'), 'POST external id')
      expectType(await send(client, 'GET', `/identity/globalIds/${id}/externalIds`), vendor('externalidcollection'), 'GET external ids')
      expectType(await send(client, 'GET', `/identity/externalIds/mt_Serial/mt-${unique}`), vendor('externalid'), 'GET external id')
      expectType(await send(client, 'POST', '/identity/search', { body: { externalIds: [{ type: 'mt_Serial', externalId: `mt-${unique}` }] } }), vendor('externalidcollection'), 'POST search')
      expectType(await send(client, 'DELETE', `/identity/externalIds/mt_Serial/mt-${unique}`), null, 'DELETE external id')

      const event = await send(client, 'POST', '/event/events', { body: { source, type: `mt_${unique}`, text: 't', time: time(0) } })
      expectType(event, vendor('event'), 'POST event')
      expectType(await send(client, 'GET', `/event/events/${event.json.id}`), vendor('event'), 'GET event')
      expectType(await send(client, 'PUT', `/event/events/${event.json.id}`, { body: { text: 'x' } }), vendor('event'), 'PUT event')
      expectType(await send(client, 'GET', `/event/events?source=${id}`), vendor('eventcollection'), 'GET events')

      const alarm = await send(client, 'POST', '/alarm/alarms', { body: { source, type: `mt_${unique}`, text: 't', time: time(0), severity: 'MINOR' } })
      expectType(alarm, vendor('alarm'), 'POST alarm')
      expectType(await send(client, 'GET', `/alarm/alarms/${alarm.json.id}`), vendor('alarm'), 'GET alarm')
      expectType(await send(client, 'PUT', `/alarm/alarms/${alarm.json.id}`, { body: { text: 'x' } }), vendor('alarm'), 'PUT alarm')
      expectType(await send(client, 'GET', `/alarm/alarms?source=${id}`), vendor('alarmcollection'), 'GET alarms')
      const alarmCount = await send(client, 'GET', `/alarm/alarms/count?source=${id}`)
      expectType(alarmCount, 'text/plain', 'GET alarm count')
      expect(alarmCount.text).toBe('1')
      const upsert = await send(client, 'POST', '/alarm/alarms/upsert', { body: { source, type: `mt_${unique}_up`, text: 't', time: time(0), severity: 'MINOR' } })
      expectType(upsert, vendor('alarmupsertresponse'), 'POST alarm upsert')

      expectType(await send(client, 'POST', '/measurement/measurements', { body: { source, type: `mt_${unique}`, time: time(0), mt_T: { T: { value: 1 } } } }), vendor('measurement'), 'POST measurement')
      expectType(await send(client, 'POST', '/measurement/measurements', { contentType: `${VENDOR}measurementcollection+json`, body: { measurements: [{ source, type: `mt_${unique}`, time: time(1), mt_T: { T: { value: 2 } } }] } }), vendor('measurementcollection'), 'POST measurements')
      expectType(await send(client, 'POST', '/measurement/measurements', { contentType: `${VENDOR}measurementcollection+json`, accept: `${VENDOR}measurementcollection+json`, body: { measurements: [{ source, type: `mt_${unique}`, time: time(2), mt_T: { T: { value: 3 } } }] } }), vendor('measurementcollection'), 'POST measurements, Accept collection')
      expect((await send(client, 'POST', '/measurement/measurements', { contentType: `${VENDOR}measurementcollection+json`, accept: `${VENDOR}measurement+json`, body: { measurements: [{ source, type: `mt_${unique}`, time: time(3), mt_T: { T: { value: 4 } } }] } })).status).toBe(406)
      // a single measurement that accepts only the collection type fails, nothing is stored
      const failed = await send(client, 'POST', '/measurement/measurements', { accept: `${VENDOR}measurementcollection+json`, body: { source, type: `mt_${unique}`, time: time(4), mt_T: { T: { value: 5 } } } })
      expect({ status: failed.status, body: failed.json }).toEqual({ status: 500, body: { error: 'general/internalError', info: 'https://cumulocity.com/api/core/' } })
      expectType(await send(client, 'GET', `/measurement/measurements?source=${id}`), vendor('measurementcollection'), 'GET measurements')
      expectType(await send(client, 'GET', `/measurement/measurements/series?source=${id}&dateFrom=2025-01-01&dateTo=2027-01-01`), 'application/json', 'GET series')

      const operation = await send(client, 'POST', '/devicecontrol/operations', { body: { deviceId: id, description: 'mt', mt_Restart: {} } })
      expectType(operation, vendor('operation'), 'POST operation')
      expectType(await send(client, 'GET', `/devicecontrol/operations/${operation.json.id}`), vendor('operation'), 'GET operation')
      expectType(await send(client, 'PUT', `/devicecontrol/operations/${operation.json.id}`, { body: { status: 'EXECUTING' } }), vendor('operation'), 'PUT operation')
      expectType(await send(client, 'GET', `/devicecontrol/operations?deviceId=${id}`), vendor('operationcollection'), 'GET operations')
      expectType(await send(client, 'GET', '/devicecontrol/bulkoperations?pageSize=1'), vendor('bulkoperationcollection'), 'GET bulk operations')
      expectType(await send(client, 'GET', '/devicecontrol/newDeviceRequests?pageSize=1'), vendor('newdevicerequestcollection'), 'GET new device requests')

      const tenant = await send(client, 'GET', '/tenant/currentTenant')
      expectType(tenant, vendor('currenttenant'), 'GET current tenant')
      expectType(await send(client, 'GET', '/user/currentUser'), vendor('currentuser'), 'GET current user')
      expectType(await send(client, 'GET', `/user/${tenant.json.name}/users?pageSize=1`), vendor('usercollection'), 'GET users')
      expectType(await send(client, 'GET', '/user/roles?pageSize=1'), vendor('rolecollection'), 'GET roles')
      expectType(await send(client, 'GET', '/user/inventoryroles?pageSize=1'), vendor('inventoryrolecollection'), 'GET inventory roles')
      const category = `mt${unique}`
      expectType(await send(client, 'POST', '/tenant/options', { body: { category, key: 'k', value: 'v' } }), vendor('option'), 'POST option')
      expectType(await send(client, 'GET', `/tenant/options/${category}`), vendor('option'), 'GET category')
      expectType(await send(client, 'PUT', `/tenant/options/${category}`, { body: { k: 'w' } }), vendor('option'), 'PUT category')
      expectType(await send(client, 'GET', `/tenant/options/${category}/k`), vendor('option'), 'GET option')
      expectType(await send(client, 'PUT', `/tenant/options/${category}/k`, { body: { value: 'z' } }), vendor('option'), 'PUT option')
      expectType(await send(client, 'DELETE', `/tenant/options/${category}/k`), null, 'DELETE option')
      expectType(await send(client, 'GET', '/tenant/options?pageSize=1'), vendor('optioncollection'), 'GET options')
      expectType(await send(client, 'GET', '/tenant/system/options?pageSize=1'), vendor('optioncollection'), 'GET system options')
      expectType(await send(client, 'GET', '/retention/retentions?pageSize=1'), vendor('retentionrulecollection'), 'GET retention rules')
      expectType(await send(client, 'GET', '/audit/auditRecords?pageSize=1'), vendor('auditrecordcollection'), 'GET audit records')
      expectType(await send(client, 'GET', '/tenant/statistics?pageSize=1'), vendor('tenantusagestatisticscollection'), 'GET usage statistics')
      expectType(await send(client, 'GET', '/tenant/statistics/summary'), vendor('tenantusagestatisticssummary'), 'GET usage summary')
      expectType(await send(client, 'GET', '/tenant/statistics/allTenantsSummary'), 'application/json', 'GET all tenants summary')
      expectType(await send(client, 'GET', `/tenant/statistics/device/${tenant.json.name}/daily/${new Date().toISOString().slice(0, 10)}`), 'application/json', 'GET device statistics')
      expectType(await send(client, 'GET', '/tenant/tenants?pageSize=1'), vendor('tenantcollection'), 'GET tenants')
      expectType(await send(client, 'GET', `/tenant/tenants/${tenant.json.name}/tfa`), 'application/json', 'GET TFA settings')
      expectType(await send(client, 'GET', `/tenant/tenants/${tenant.json.name}/applications/restricted-roles`), 'application/json', 'GET restricted roles')
      expectType(await send(client, 'GET', `/tenant/tenants/${tenant.json.name}/trusted-certificates`), 'application/json', 'GET trusted certificates')
      expectType(await send(client, 'GET', '/tenant/loginOptions'), vendor('loginoptioncollection'), 'GET login options')
      expectType(await send(client, 'GET', '/tenant/loginOptions/BASIC'), vendor('authconfig'), 'GET login option')
      expectType(await send(client, 'GET', '/tenant/loginOptions/BASIC/accessMappings'), vendor('accessmappingcollection'), 'GET access mappings')
      expectType(await send(client, 'GET', '/tenant/loginOptions/BASIC/inventoryAccessMappings'), vendor('inventoryaccessmappingcollection'), 'GET inventory access mappings')
      expectType(await send(client, 'GET', '/notification2/subscriptions?pageSize=1'), vendor('subscriptioncollection'), 'GET subscriptions')
      expectType(await send(client, 'GET', '/inventory/binaries?pageSize=1'), vendor('managedobjectcollection'), 'GET binaries')

      // errors: the error type and one `info` link
      const missing = await send(client, 'GET', '/inventory/managedObjects/99999999901')
      expect(missing.status).toBe(404)
      expectType(missing, vendor('error'), 'GET unknown managed object')
      expect(missing.json.info).toBe('https://cumulocity.com/api/core/')
      const invalid = await send(client, 'POST', '/alarm/alarms', { body: { source } })
      expect(invalid.status).toBe(422)
      expectType(invalid, vendor('error'), 'POST invalid alarm')
      expect(invalid.json.info).toBe('https://cumulocity.com/api/core/')
      const badDate = await send(client, 'GET', '/event/events?dateFrom=abc')
      expect(badDate.status).toBe(422)
      expectType(badDate, vendor('error'), 'GET events with a bad date')
      expect(badDate.json.info).toBe('https://cumulocity.com/api/core/')
    },
  },
  {
    name: 'http: a create names the new resource in a Location header',
    verifies: ['location-header'],
    async run({ client, unique }) {
      const device = await send(client, 'POST', '/inventory/managedObjects', { body: { name: `loc-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } })
      expect(device.location).toBe(device.json.self)
      const id = device.json.id as string
      const source = { id }
      const child = await send(client, 'POST', '/inventory/managedObjects', { body: { name: `loc-${unique}-child` } })
      const reference = await send(client, 'POST', `/inventory/managedObjects/${id}/childAssets`, { body: { managedObject: { id: child.json.id } } })
      expect(reference.location).toBe(reference.json.self)
      expect(reference.location).toMatch(new RegExp(`/inventory/managedObjects/${id}/childAssets/${child.json.id}$`))
      let n = 0
      const external = await send(client, 'POST', `/identity/globalIds/${id}/externalIds`, { body: { type: 'loc_Serial', externalId: `loc-${unique}` } })
      expect(external.location).toBe(external.json.self)
      for (const [path, body] of [
        ['/event/events', { source, type: `loc_${unique}`, text: 't', time: time(0) }],
        ['/alarm/alarms', { source, type: `loc_${unique}`, text: 't', time: time(0), severity: 'MINOR' }],
        ['/measurement/measurements', { source, type: `loc_${unique}`, time: time(0), loc_T: { T: { value: 1 } } }],
        ['/devicecontrol/operations', { deviceId: id, description: 'loc', loc_Restart: {} }],
      ] as const) {
        const created = await send(client, 'POST', path, { body })
        expect(created.status, path).toBe(201)
        expect(created.location, path).toBe(created.json.self)
        // without a body: the header stays only with an Accept header that
        // does not parse, without one or with */* these creates name nothing
        const again = () => (path === '/alarm/alarms' ? { ...body, type: `loc_${unique}_${n++}` } : body)
        const unparsable = await send(client, 'POST', path, { body: again(), accept: 'foo' })
        expect(unparsable.text, path).toBe('')
        expect(unparsable.location, path).toMatch(new RegExp(`${path}/[0-9a-f]+$`))
        const wildcard = await send(client, 'POST', path, { body: again(), accept: '*/*' })
        expect(wildcard.text, path).toBe('')
        expect(wildcard.location, path).toEqual(path === '/devicecontrol/operations' ? expect.stringMatching(/\/devicecontrol\/operations\/\d+$/) : null)
      }
      const wildcard = await send(client, 'POST', '/inventory/managedObjects', { body: { name: `loc-${unique}-w` }, accept: '*/*' })
      expect(wildcard.location).toMatch(/\/inventory\/managedObjects\/\d+$/)
      // a measurement collection and an option (200) name none
      const measurements = await send(client, 'POST', '/measurement/measurements', { contentType: `${VENDOR}measurementcollection+json`, body: { measurements: [{ source, type: `loc_${unique}`, time: time(1), loc_T: { T: { value: 2 } } }] } })
      expect(measurements.status).toBe(201)
      expect(measurements.location).toBeNull()
      const category = `loc${unique}`
      const option = await send(client, 'POST', '/tenant/options', { body: { category, key: 'k', value: 'v' } })
      expect(option.location).toBeNull()
      await send(client, 'DELETE', `/tenant/options/${category}/k`)
    },
  },
  {
    name: 'http: the Accept header picks the content type or answers 406',
    verifies: ['accept-negotiation'],
    async run({ client, unique, tenant }) {
      const device = await send(client, 'POST', '/inventory/managedObjects', { body: { name: `neg-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } })
      const id = device.json.id as string
      const event = await send(client, 'POST', '/event/events', { body: { source: { id }, type: `neg_${unique}`, text: 't', time: time(0) } })
      const check = async (method: string, path: string, accept: string, expected: number | string | RegExp, body?: unknown) => {
        const answer = await send(client, method, path, { accept, body })
        const label = `${method} ${path} accept=${accept}`
        if (typeof expected === 'number') {
          expect(answer.status, label).toBe(expected)
          expect(answer.text, label).toBe('')
        } else {
          expect(answer.status, label).toBeLessThan(300)
          if (typeof expected === 'string') {
            expect(answer.contentType, label).toBe(expected)
          } else {
            expect(answer.contentType, label).toMatch(expected)
          }
        }
      }
      const mo = `/inventory/managedObjects/${id}`
      // the core APIs: any listed range that fits, in any case, parameters and q ignored
      for (const accept of ['*/*', 'application/*', 'application/json;q=0', 'text/plain, application/json', 'application/JSON', `${VENDOR}managedobject+json`, 'foo']) {
        await check('GET', mo, accept, vendor('managedobject'))
      }
      for (const accept of ['text/plain', 'application/xml', 'application/foo+json', `${VENDOR}event+json`, `${VENDOR}managedobjectcollection+json`]) {
        await check('GET', mo, accept, 406)
      }
      await check('GET', `/event/events/${event.json.id}`, `${VENDOR}event+json`, vendor('event'))
      // an error and a write are negotiated first: no 404 or 422, nothing created
      await check('GET', '/inventory/managedObjects/99999999901', 'text/plain', 406)
      await check('POST', '/alarm/alarms', 'text/plain', 406, { source: { id } })
      await check('POST', '/inventory/managedObjects', `${VENDOR}event+json`, 406, { name: `neg-${unique}-never` })
      expect((await send(client, 'GET', `/inventory/managedObjects?query=${encodeURIComponent(`$filter=(name eq 'neg-${unique}-never')`)}`)).json.managedObjects).toEqual([])
      // DELETE and the counts do not negotiate
      expect((await send(client, 'DELETE', `/tenant/options/neg${unique}/k`, { accept: 'text/plain' })).status).toBe(404)
      await check('GET', `/alarm/alarms/count?source=${id}`, 'text/plain', 'text/plain')
      await check('GET', `/alarm/alarms/count?source=${id}`, 'application/xml', 'text/plain')
      // plain JSON endpoints: supportedSeries also produces text, the first fitting range wins
      await check('GET', `${mo}/supportedSeries`, 'text/plain', 'text/plain')
      await check('GET', `${mo}/supportedSeries`, 'text/plain, application/json', 'text/plain')
      await check('GET', `${mo}/supportedSeries`, 'application/json;charset=UTF-8', 'application/json;charset=utf-8')
      await check('GET', `/measurement/measurements/series?source=${id}&dateFrom=2025-01-01&dateTo=2027-01-01`, 'text/plain', 406)
      // the user API answers plain JSON unless the header is exactly application/json
      await check('GET', '/user/roles?pageSize=1', 'application/json', vendor('rolecollection'))
      await check('GET', '/user/roles?pageSize=1', 'application/json, text/plain, */*', 'application/json')
      await check('GET', '/user/roles?pageSize=1', 'application/json;charset=UTF-8', 'application/json;charset=utf-8')
      await check('GET', '/user/roles?pageSize=1', '*/*', vendor('rolecollection'))
      await check('GET', `/user/${tenant}/groups?pageSize=1`, 'text/plain, application/json', 'application/json')
      await check('GET', '/user/currentUser', `${VENDOR}currentUser+json;`, vendor('currentuser'))
      // device control, retention, audit, and Notification 2.0 read only the first range
      for (const path of ['/devicecontrol/operations?pageSize=1', '/retention/retentions?pageSize=1', '/audit/auditRecords?pageSize=1', '/notification2/subscriptions?pageSize=1']) {
        await check('GET', path, 'application/json, text/plain, */*', /collection\+json/)
        await check('GET', path, '*/*;q=0.8', /collection\+json/)
        await check('GET', path, 'text/plain, application/json', 406)
        await check('GET', path, 'application/json;q=0', 406)
        await check('GET', path, 'application/json;charset=UTF-8', 406)
      }
      // writes: a body unless the header is missing, exactly */*, or unparsable
      for (const [accept, empty] of [['foo', true], ['*/*', true], ['*/*;q=0.8', false], ['application/*', false], ['text/*, application/json;q=0.5', false]] as const) {
        const answer = await send(client, 'PUT', mo, { accept, body: { neg_F: accept } })
        expect(answer.status, accept).toBe(200)
        expect(answer.text === '', accept).toBe(empty)
      }
    },
  },
  {
    name: 'http: unknown paths and wrong methods answer without a body',
    verifies: ['unknown-path-empty'],
    async run({ client, unique, tenant }) {
      const device = await send(client, 'POST', '/inventory/managedObjects', { body: { name: `ep-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } })
      const id = device.json.id as string
      const source = { id }
      const event = await send(client, 'POST', '/event/events', { body: { source, type: `ep_${unique}`, text: 't', time: time(0) } })
      const alarm = await send(client, 'POST', '/alarm/alarms', { body: { source, type: `ep_${unique}`, text: 't', time: time(0), severity: 'MINOR' } })
      const operation = await send(client, 'POST', '/devicecontrol/operations', { body: { deviceId: id, description: 'ep', ep_Restart: {} } })
      const empty = async (method: string, path: string, status: number, accept?: string) => {
        const answer = await send(client, method, path, { accept, ...(method === 'POST' || method === 'PUT' || method === 'PATCH' ? { body: {} } : {}) })
        expect(answer.status, `${method} ${path}`).toBe(status)
        expect(answer.text, `${method} ${path}`).toBe('')
        expect(answer.contentType, `${method} ${path}`).toBeNull()
      }
      for (const path of [`/inventory/managedObjects/${id}/nope`, `/event/events/${event.json.id}/nope`, `/alarm/alarms/${alarm.json.id}/nope`, `/devicecontrol/operations/${operation.json.id}/nope`, '/devicecontrol/bulkoperations/1/nope', `/identity/globalIds/${id}`, '/identity/nope', `/user/${tenant}/nope`, '/tenant/nope', '/retention/nope', '/audit/nope', '/notification2/nope', `/inventory/binaries/${id}/nope`, '/application/nope', '/measurement/nope', '/inventory/managedObjects/count/nope', '/alarm/alarms/count/nope', `/inventory/managedObjects/${id}/childDevices/1/nope`, '/inventoryx', '/auditx']) {
        await empty('GET', path, 404)
      }
      // also when the Accept header does not fit
      await empty('GET', '/inventory/nope', 404, 'text/plain')
      for (const [method, path] of [['DELETE', `/alarm/alarms/${alarm.json.id}`], ['POST', `/inventory/managedObjects/${id}`], ['PATCH', `/inventory/managedObjects/${id}`], ['DELETE', `/devicecontrol/operations/${operation.json.id}`], ['POST', `/event/events/${event.json.id}`], ['PUT', '/identity/externalIds/t/x'], ['POST', '/user/roles'], ['POST', `/inventory/managedObjects/${id}/supportedMeasurements`], ['POST', '/alarm/alarms/count'], ['GET', '/identity/search']] as const) {
        await empty(method, path, 405)
      }
    },
  },
  {
    name: 'http: repeated and trailing slashes, and paths the core service does not have',
    verifies: ['path-normalization'],
    async run({ client, unique }) {
      const device = await send(client, 'POST', '//inventory/managedObjects/', { raw: true, body: { name: `pn-${unique}`, c8y_IsDevice: {} } })
      expect(device.status).toBe(201)
      const id = device.json.id as string
      for (const path of [`/inventory/managedObjects//${id}`, '/devicecontrol//operations?pageSize=1', '/alarm/alarms//count', '//alarm/alarms?pageSize=1', '//event/events?pageSize=1', '//measurement/measurements?pageSize=1', '//audit/auditRecords?pageSize=1', '//retention/retentions', '/./inventory/managedObjects?pageSize=1']) {
        expect((await send(client, 'GET', path, { raw: true })).status, path).toBe(200)
      }
      // a leading double slash on these APIs, or a first segment that only
      // starts like an API, reaches the core's fallback
      for (const path of ['//devicecontrol/operations', '//identity/globalIds/1/externalIds', '//tenant/currentTenant', '//user/currentUser', '//notification2/subscriptions', '//application/applications', '/users', '/alarms', '/devicecontrolx']) {
        const answer = await send(client, 'GET', path, { raw: true, accept: 'text/plain' })
        expect(answer.status, path).toBe(404)
        expect(answer.contentType, path).toBe('application/json')
        expect(answer.text, path).toBe('{\n  "error": "System/Not Found",\n  "message": "Not Found"\n}')
      }
      const post = await send(client, 'POST', '//devicecontrol/operations', { raw: true, body: { deviceId: id, pn_Restart: {} } })
      expect(post.status).toBe(405)
      expect(post.text).toBe('{\n  "error": "System/Method Not Allowed",\n  "message": "HTTP method POST is not supported by this URL"\n}')
      for (const method of ['PUT', 'DELETE']) {
        const answer = await send(client, method, '//tenant/options/x/y', method === 'PUT' ? { raw: true, body: {} } : { raw: true })
        expect(answer.status, method).toBe(405)
        expect(answer.text, method).toBe('')
      }
      expect((await send(client, 'GET', `/inventory/ManagedObjects/${id}`, { raw: true })).status).toBe(404)
      expect((await send(client, 'GET', `/inventory/managedObjects/${id}/`, { raw: true })).status).toBe(200)
    },
  },
  {
    name: 'http: link parameters come in the platform order and encoding',
    verifies: ['link-parameters'],
    async run({ client, unique, tenant }) {
      const device = await send(client, 'POST', '/inventory/managedObjects', { body: { name: `lp-${unique}`, type: `lp_${unique}`, c8y_IsDevice: {} } })
      const id = device.json.id as string
      const query = (link: string) => link.slice(link.indexOf('?') + 1)
      const links = async (path: string) => {
        const answer = await send(client, 'GET', path)
        return { self: query(answer.json.self), next: answer.json.next && query(answer.json.next), prev: answer.json.prev && query(answer.json.prev) }
      }
      expect(await links(`/inventory/managedObjects?type=lp_${unique}&pageSize=1&withTotalPages=true&fragmentType=c8y_IsDevice&currentPage=1`)).toEqual({ self: `pageSize=1&fragmentType=c8y_IsDevice&type=lp_${unique}&currentPage=1&withTotalPages=true`, next: undefined, prev: undefined })
      expect((await links(`/inventory/managedObjects?currentPage=1&fragmentType=c8y_IsDevice&withTotalPages=true&pageSize=1&type=lp_${unique}`)).self).toBe(`pageSize=1&fragmentType=c8y_IsDevice&type=lp_${unique}&currentPage=1&withTotalPages=true`)
      expect(await links(`/alarm/alarms?source=${id}&status=ACTIVE&severity=MINOR&pageSize=1&withTotalElements=true`)).toEqual({ self: `severity=MINOR&pageSize=1&source=${id}&currentPage=1&withTotalElements=true&status=ACTIVE`, next: `severity=MINOR&pageSize=1&source=${id}&currentPage=2&withTotalElements=true&status=ACTIVE`, prev: undefined })
      expect(await links('/devicecontrol/operations?pageSize=1&currentPage=2')).toMatchObject({ self: 'currentPage=2&pageSize=1', prev: 'currentPage=1&pageSize=1' })
      expect((await links(`/user/${tenant}/users?username=lp${unique}&onlyDevices=true&pageSize=1`)).self).toBe(`pageSize=1&currentPage=1&onlyDevices=true&username=lp${unique}`)
      expect((await links('/devicecontrol/operations?pageSize=1&unknownParam=x&a=1')).self).toBe('a=1&pageSize=1&unknownParam=x&currentPage=1')
      // a repeated parameter keeps its values
      expect((await links(`/inventory/managedObjects?pageSize=1&type=lp_${unique}&type=x`)).self).toBe(`type=lp_${unique}&type=x&currentPage=1&pageSize=1`)
      // everything but letters, digits, and -._~ is encoded, a space as %20
      expect((await links(`/inventory/managedObjects?pageSize=1&text=${encodeURIComponent('a b+c/d:e,f*')}`)).self).toBe('currentPage=1&pageSize=1&text=a%20b%2Bc%2Fd%3Ae%2Cf%2A')
      expect((await links(`/inventory/managedObjects?pageSize=1&text=${encodeURIComponent('~!\'()_-.ä€#&=?')}`)).self).toBe('currentPage=1&pageSize=1&text=~%21%27%28%29_-.%C3%A4%E2%82%AC%23%26%3D%3F')
      expect((await links(`/inventory/managedObjects?pageSize=1&query=${encodeURIComponent(`$filter=(name eq 'lp-${unique}*') $orderby=name`)}`)).self).toBe(`currentPage=1&pageSize=1&query=%24filter%3D%28name%20eq%20%27lp-${unique}%2A%27%29%20%24orderby%3Dname`)
      // a negative page is echoed, and the next one is that plus one
      expect(await links(`/event/events?source=${id}&pageSize=2&currentPage=-1`)).toEqual({ self: `pageSize=2&source=${id}&currentPage=-1`, next: `pageSize=2&source=${id}&currentPage=0`, prev: undefined })
    },
  },
]
