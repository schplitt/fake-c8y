import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { rejection, time } from '../helpers'

async function api(client: Client, method: string, path: string, body?: unknown) {
  const res = await client.core.fetch(path, { method, headers: { 'content-type': 'application/json', 'accept': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

export const platformScenarios: ContractScenario[] = [
  {
    name: 'current user and tenant',
    async run({ client, tenant }) {
      const user = await (await client.core.fetch('/user/currentUser')).json()
      expect(user.userName).toEqual(expect.any(String))
      expect(Array.isArray(user.effectiveRoles)).toBe(true)

      const current = await (await client.core.fetch('/tenant/currentTenant')).json()
      expect(current.name).toBe(tenant)
    },
  },
  {
    name: 'current user: id is the user name, roles carry id and name',
    async run({ client, tenant }) {
      const result = await api(client, 'GET', '/user/currentUser')
      expect(result.status).toBe(200)
      expect(result.body.id).toBe(result.body.userName)
      for (const role of result.body.effectiveRoles) {
        expect(role.id).toEqual(expect.any(String))
        expect(role.name).toBe(role.id)
      }

      const current = await api(client, 'GET', '/tenant/currentTenant')
      expect(current.status).toBe(200)
      expect(current.body.name).toBe(tenant)
      expect(current.body.domainName).toEqual(expect.stringContaining('.'))
      expect(current.body.allowCreateTenants).toEqual(expect.any(Boolean))
      expect(current.body.customProperties).toEqual(expect.any(Object))
      expect(Array.isArray(current.body.applications.references)).toBe(true)
      // the self link has no /tenant
      expect(current.body.self).toMatch(/\/currentTenant$/)
      expect(current.body.self).not.toContain('/tenant/currentTenant')
    },
  },
  {
    name: 'validation: required fields are enforced',
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `v-${unique}`, c8y_IsDevice: {} })
      const failure = await rejection(client.alarm.create({ source: { id: device.id }, type: 'x', text: 'no severity', time: time(1) } as any))
      expect(failure.res.status).toBe(422)
    },
  },
  {
    name: 'an unknown microservice answers 404',
    verifies: ['unknown-microservice-404'],
    async run({ client, unique }) {
      for (const method of ['GET', 'POST']) {
        const res = await api(client, method, `/service/nosuchservice${unique.replace(/\W/g, '')}/health`, method === 'POST' ? {} : undefined)
        expect(res.status).toBe(404)
        expect(res.body.error).toBe('microservice/Not Found')
        expect(res.body.message).toMatch(/^Microservice nosuchservice\w* not found\.$/)
      }
    },
  },
  {
    name: 'filters: parameters an endpoint does not have are ignored',
    verifies: ['unknown-filters-ignored'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `uf-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const source = { id: device.id }
      for (const [index, fragment] of ['r', 'other'].entries()) {
        expect((await api(client, 'POST', '/measurement/measurements', { source, type: `uf_${unique}`, time: time(index), [fragment]: { v: { value: index } } })).status).toBe(201)
      }
      const measurements = async (query: string) => (await api(client, 'GET', `/measurement/measurements?source=${device.id}&${query}`)).body.measurements.length
      expect(await measurements('fragmentType=r')).toBe(1)
      expect(await measurements('fragmentType=x')).toBe(0)
      expect(await measurements('status=x')).toBe(2)

      const operation = await api(client, 'POST', '/devicecontrol/operations', { deviceId: device.id, c8y_Restart: {} })
      const listed = await api(client, 'GET', `/devicecontrol/operations?source=999999999&deviceId=${device.id}`)
      expect(listed.body.operations.map((item: { id: string }) => item.id)).toEqual([operation.body.id])

      for (const type of [`uf_a_${unique}`, `uf_b_${unique}`]) {
        await api(client, 'POST', '/alarm/alarms', { source, type, text: 't', severity: 'MINOR', time: time(1), ...(type.startsWith('uf_a') ? { uf_Fragment: { n: 1 } } : {}) })
      }
      // alarms do not filter by fragmentType, also not when one alarm has the fragment
      for (const fragment of ['uf_Fragment', 'x', '']) {
        expect((await api(client, 'GET', `/alarm/alarms?source=${device.id}&fragmentType=${fragment}`)).body.alarms, fragment).toHaveLength(2)
        expect((await api(client, 'GET', `/alarm/alarms/count?source=${device.id}&fragmentType=${fragment}`)).body, fragment).toBe(2)
      }
      expect((await api(client, 'PUT', `/alarm/alarms?source=${device.id}&type=uf_a_${unique}&status=ACTIVE`, { status: 'ACKNOWLEDGED' })).status).toBe(200)
      const alarms = await api(client, 'GET', `/alarm/alarms?source=${device.id}`)
      expect(alarms.body.alarms.map((alarm: { status: string }) => alarm.status)).toEqual(['ACKNOWLEDGED', 'ACKNOWLEDGED'])
    },
  },
  {
    name: 'ids sent as numbers: stored as strings, alarms deduplicate, operations are found',
    verifies: ['numeric-ids'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `ni-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const numeric = Number(device.id)
      const alarm = { source: { id: numeric }, type: `ni_${unique}`, text: 't', severity: 'MINOR', time: time(1) }
      const first = await api(client, 'POST', '/alarm/alarms', alarm)
      const second = await api(client, 'POST', '/alarm/alarms', alarm)
      expect(first.status).toBe(201)
      expect(first.body.source.id).toBe(device.id)
      expect(second.body.id).toBe(first.body.id)
      expect(second.body.count).toBe(2)

      const operation = await api(client, 'POST', '/devicecontrol/operations', { deviceId: numeric, c8y_Restart: {} })
      expect(operation.status).toBe(201)
      expect(operation.body.deviceId).toBe(device.id)
      expect((await api(client, 'GET', `/devicecontrol/operations?deviceId=${device.id}`)).body.operations.map((item: { id: string }) => item.id)).toEqual([operation.body.id])

      // the query language compares ids as strings: an unquoted number matches nothing
      const query = (filter: string) => api(client, 'GET', `/inventory/managedObjects?query=${encodeURIComponent(filter)}`)
      expect((await query(`$filter=(id eq ${device.id})`)).body.managedObjects).toEqual([])
      expect((await query(`$filter=(id eq '${device.id}')`)).body.managedObjects.map((item: { id: string }) => item.id)).toEqual([device.id])
    },
  },
  {
    name: 'times: without a zone or as a date they are UTC, an offset is kept and filtered by instant',
    verifies: ['time-formats'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `tf-${unique}`, c8y_IsDevice: {} })
      const source = { id: device.id }
      const sent = ['2026-05-01T10:00:00Z', '2026-05-01T10:00:00.000+01:00', '2026-05-01T10:00:00', '2026-05-01']
      const stored = []
      for (const [index, value] of sent.entries()) {
        const created = await api(client, 'POST', '/event/events', { source, type: `tf_${index}`, text: 't', time: value })
        expect(created.status).toBe(201)
        stored.push(created.body.time)
      }
      expect(stored).toEqual(['2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000+01:00', '2026-05-01T10:00:00.000Z', '2026-05-01T00:00:00.000Z'])
      const window = async (from: string, to: string) => (await api(client, 'GET', `/event/events?source=${device.id}&dateFrom=${from}&dateTo=${to}`)).body.events.map((event: { type: string }) => event.type).sort()
      expect(await window('2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.999Z')).toEqual(['tf_0', 'tf_2'])
      expect(await window('2026-05-01T09:00:00.000Z', '2026-05-01T09:00:00.999Z')).toEqual(['tf_1'])
      const malformed = await api(client, 'POST', '/event/events', { source, type: 'tf_x', text: 't', time: '2026-05-01 10:00' })
      expect(malformed.status).toBe(400)
      expect(malformed.body.error).toBe('Failed to parse JSON string')
      expect(malformed.body.message).toContain('Invalid format: "2026-05-01 10:00" is malformed at " 10:00"')
    },
  },
  {
    name: 'validation: a body that is not a JSON object answers 400',
    verifies: ['body-not-object-400'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `vb-${unique}`, c8y_IsDevice: {} })
      const raw = async (method: string, path: string, body: string) => {
        const res = await client.core.fetch(path, { method, headers: { 'content-type': 'application/json', 'accept': 'application/json' }, body })
        return { status: res.status, body: await res.json() }
      }
      for (const body of ['"abc"', '[1,2]', '1', 'abc']) {
        const created = await raw('POST', '/inventory/managedObjects', body)
        expect(created.status).toBe(400)
        expect(created.body.error).toBe('Failed to parse JSON string')
        expect((await raw('PUT', `/inventory/managedObjects/${device.id}`, body)).status).toBe(400)
      }
    },
  },
  {
    name: 'validation: every required field of alarm, event, measurement, and operation POST',
    verifies: ['required-fields-422'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `vr-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const source = { id: device.id }
      const bodies: Record<string, { path: string, valid: Record<string, unknown> }> = {
        alarm: { path: '/alarm/alarms', valid: { source, type: `vr-${unique}`, text: 'text', severity: 'MAJOR', time: time(1) } },
        event: { path: '/event/events', valid: { source, type: `vr-${unique}`, text: 'text', time: time(1) } },
        measurement: { path: '/measurement/measurements', valid: { source, type: `vr-${unique}`, time: time(1) } },
        operation: { path: '/devicecontrol/operations', valid: { deviceId: device.id, c8y_Restart: {} } },
      }
      for (const [name, { path, valid }] of Object.entries(bodies)) {
        for (const field of Object.keys(valid)) {
          // c8y_Restart is the operation's payload: without it the body is invalid for another reason
          const { [field]: _removed, ...incomplete } = valid
          const result = await api(client, 'POST', path, incomplete)
          expect(result.status, `${name} without ${field}`).toBe(422)
          expect(result.body.error, `${name} without ${field}`).toEqual(expect.any(String))
          expect(result.body.message, `${name} without ${field}`).toEqual(expect.any(String))
        }
        expect((await api(client, 'POST', path, {})).status, `${name} empty`).toBe(422)
        expect((await api(client, 'POST', path, valid)).status, `${name} valid`).toBe(201)
      }
    },
  },
  {
    name: 'validation: unknown source, server-owned fields, unparsable time',
    verifies: ['alarm-unknown-source-404', 'time-unparsable-400'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `vs-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const source = { id: device.id }
      const missing = { id: '99999999999' }
      const post = (path: string, body: Record<string, unknown>) => api(client, 'POST', path, body)

      // a source that does not exist: 404 for alarms, 422 for the others
      expect((await post('/alarm/alarms', { source: missing, type: 'x', text: 't', severity: 'MAJOR', time: time(1) })).status).toBe(404)
      expect((await post('/event/events', { source: missing, type: 'x', text: 't', time: time(1) })).status).toBe(422)
      expect((await post('/measurement/measurements', { source: missing, type: 'x', time: time(1) })).status).toBe(422)
      expect((await post('/devicecontrol/operations', { deviceId: missing.id, c8y_Restart: {} })).status).toBe(422)
      // a source without an id
      expect((await post('/alarm/alarms', { source: {}, type: 'x', text: 't', severity: 'MAJOR', time: time(1) })).status).toBe(422)

      // id and creationTime are the platform's: sending them is an error, not ignored
      const alarm = { source, type: `vs-${unique}`, text: 't', severity: 'MAJOR', time: time(1) }
      for (const field of [{ id: '5' }, { creationTime: time(2) }]) {
        expect((await post('/alarm/alarms', { ...alarm, ...field })).status, JSON.stringify(field)).toBe(422)
      }
      expect((await post('/event/events', { source, type: 'x', text: 't', time: time(1), id: '5' })).status).toBe(422)

      // a time that is no date is a parse error
      for (const [path, body] of [
        ['/alarm/alarms', { ...alarm, time: 'garbage' }],
        ['/event/events', { source, type: 'x', text: 't', time: 'garbage' }],
      ] as const) {
        expect((await post(path, body)).status, path).toBe(400)
      }
    },
  },
]

export const platformConformanceScenarios: ContractScenario[] = [
  {
    name: 'platform: the current application needs application credentials',
    verifies: ['current-application-user-403'],
    async run({ client }) {
      for (const path of ['/application/currentApplication', '/application/currentApplication/subscriptions', '/application/currentApplication/settings']) {
        const result = await api(client, 'GET', path)
        expect(result.status, path).toBe(403)
        expect(result.body.error, path).toBe('security/Forbidden')
      }
    },
  },
  {
    name: 'platform: unknown endpoints answer 404, wrong methods 405',
    verifies: ['unknown-endpoint-404', 'wrong-method-405'],
    async run({ client }) {
      for (const path of ['/inventory/nope', '/alarm/alarms/count/nope', '/measurement/nope']) {
        expect((await api(client, 'GET', path)).status, path).toBe(404)
      }
      expect((await api(client, 'POST', '/tenant/currentTenant', {})).status).toBe(405)
      expect((await api(client, 'PATCH', '/inventory/managedObjects', {})).status).toBe(405)
      expect((await api(client, 'DELETE', '/user/currentUser')).status).toBe(405)
    },
  },
]

/**
 * A write sent with the given Accept header (none: the client's default,
 * which is `*\/*` for Node's fetch), as status, content-type, and body text.
 * @param client
 * @param method
 * @param path
 * @param body
 * @param accept
 */
async function write(client: Client, method: string, path: string, body: unknown, accept?: string) {
  const res = await client.core.fetch(path, { method, headers: { 'content-type': 'application/json', ...(accept ? { accept } : {}) }, body: JSON.stringify(body) })
  return { status: res.status, contentType: res.headers.get('content-type'), text: await res.text() }
}

export const orderScenarios: ContractScenario[] = [
  {
    name: 'default order: inventory in creation order, equal times by creation',
    verifies: ['default-order'],
    async run({ client, unique }) {
      const type = `ord_${unique}`
      const created: string[] = []
      for (let i = 0; i < 6; i++) {
        created.push((await client.inventory.create({ name: `ord-${unique}-${i}`, type })).data.id)
      }
      for (const id of created) {
        expect(id).toMatch(/^\d+$/)
      }
      // without pageSize: the first 5 created, not the 5 smallest ids
      expect((await api(client, 'GET', `/inventory/managedObjects?type=${type}`)).body.managedObjects.map((mo: { id: string }) => mo.id)).toEqual(created.slice(0, 5))
      expect((await api(client, 'GET', `/inventory/managedObjects?type=${type}&pageSize=100`)).body.managedObjects.map((mo: { id: string }) => mo.id)).toEqual(created)

      const { data: device } = await client.inventory.create({ name: `ord-${unique}-device`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const source = { id: device.id }
      const events: string[] = []
      const alarms: string[] = []
      const operations: string[] = []
      for (let i = 0; i < 3; i++) {
        events.push(String((await client.event.create({ source, type, text: 'same time', time: time(1) })).data.id))
        alarms.push(String((await client.alarm.create({ source, type: `${type}_${i}`, text: 'same time', time: time(1), severity: 'MINOR' } as any)).data.id))
        operations.push(String((await client.operation.create({ deviceId: device.id, description: `op ${i}`, ord_Restart: {} } as any)).data.id))
      }
      const later = (await client.event.create({ source, type, text: 'later', time: time(2) })).data.id
      // events and alarms: newest first; the order of equal times is not stable
      // on the platform (events mostly the last created first, alarms the
      // first created first), so only the set is checked
      const listedEvents = (await api(client, 'GET', `/event/events?source=${device.id}&pageSize=100`)).body.events.map((event: { id: string }) => event.id)
      expect(listedEvents[0]).toBe(later)
      expect([...listedEvents.slice(1)].sort()).toEqual([...events].sort())
      const listedAlarms = (await api(client, 'GET', `/alarm/alarms?source=${device.id}&pageSize=100`)).body.alarms.map((alarm: { id: string }) => alarm.id)
      expect([...listedAlarms].sort()).toEqual([...alarms].sort())
      // operations: creation order
      expect((await api(client, 'GET', `/devicecontrol/operations?deviceId=${device.id}&pageSize=100`)).body.operations.map((operation: { id: string }) => operation.id)).toEqual(operations)
    },
  },
]

export const acceptScenarios: ContractScenario[] = [
  {
    name: 'writes: the body only when the request accepts JSON',
    verifies: ['write-body-needs-accept'],
    async run({ client, unique, tenant }) {
      const { data: device } = await client.inventory.create({ name: `acc-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const source = { id: device.id }
      const ids = {
        event: (await client.event.create({ source, type: `acc_${unique}`, text: 'e', time: time(0) })).data.id,
        alarm: (await client.alarm.create({ source, type: `acc_${unique}_put`, text: 'a', time: time(0), severity: 'MINOR' } as any)).data.id,
        operation: (await client.operation.create({ deviceId: device.id, description: 'acc', acc_Restart: {} } as any)).data.id,
      }
      const category = `acc${unique}`
      const json = async (method: string, path: string, body: unknown) => JSON.parse((await write(client, method, path, body, 'application/json')).text)
      const group = (await json('POST', `/user/${tenant}/groups`, { name: `acc-${unique}-group` })).id as string
      const rule = (await json('POST', '/retention/retentions', { dataType: 'EVENT', type: `acc_${unique}`, fragmentType: '*', source: '*', maximumAge: 3650 })).id as string
      const application = (await json('POST', '/application/applications', { name: `acc-${unique}-app`, key: `acc-${unique}-app-key`, type: 'EXTERNAL', externalUrl: 'https://example.com' })).id as string
      await json('POST', '/notification2/subscriptions', { context: 'tenant', subscription: `acc${unique}`, subscriptionFilter: { apis: ['alarms'] } })
      let n = 0
      // status with JSON, status without, whether the content-type stays without
      const writes: Array<{ method: string, path: string, body: () => unknown, status: number, empty?: number, contentType: boolean }> = [
        { method: 'POST', path: '/inventory/managedObjects', body: () => ({ name: `acc-${unique}-child` }), status: 201, contentType: true },
        { method: 'PUT', path: `/inventory/managedObjects/${device.id}`, body: () => ({ acc_Fragment: { n: 1 } }), status: 200, contentType: true },
        { method: 'POST', path: '/event/events', body: () => ({ source, type: `acc_${unique}`, text: 'e', time: time(1) }), status: 201, contentType: false },
        { method: 'PUT', path: `/event/events/${ids.event}`, body: () => ({ text: 'changed' }), status: 200, empty: 204, contentType: false },
        { method: 'POST', path: '/alarm/alarms', body: () => ({ source, type: `acc_${unique}_${n++}`, text: 'a', time: time(2), severity: 'MINOR' }), status: 201, contentType: false },
        { method: 'PUT', path: `/alarm/alarms/${ids.alarm}`, body: () => ({ text: 'changed' }), status: 200, contentType: true },
        { method: 'POST', path: '/measurement/measurements', body: () => ({ source, type: `acc_${unique}`, time: time(3), acc_T: { T: { value: 1, unit: 'C' } } }), status: 201, contentType: false },
        { method: 'POST', path: '/devicecontrol/operations', body: () => ({ deviceId: device.id, description: 'acc', acc_Restart: {} }), status: 201, contentType: true },
        { method: 'PUT', path: `/devicecontrol/operations/${ids.operation}`, body: () => ({ status: 'EXECUTING' }), status: 200, contentType: true },
        { method: 'POST', path: `/identity/globalIds/${device.id}/externalIds`, body: () => ({ type: 'acc_Serial', externalId: `acc-${unique}-${n++}` }), status: 201, contentType: true },
        { method: 'POST', path: '/tenant/options', body: () => ({ category, key: 'k', value: 'v' }), status: 200, contentType: true },
        { method: 'POST', path: `/user/${tenant}/groups`, body: () => ({ name: `acc-${unique}-group-${n++}` }), status: 201, contentType: true },
        { method: 'PUT', path: `/user/${tenant}/groups/${group}`, body: () => ({ name: `acc-${unique}-group`, description: `d${n++}` }), status: 200, contentType: true },
        { method: 'POST', path: '/retention/retentions', body: () => ({ dataType: 'EVENT', type: `acc_${unique}_${n++}`, fragmentType: '*', source: '*', maximumAge: 3650 }), status: 201, contentType: true },
        { method: 'POST', path: `/user/${tenant}/users`, body: () => ({ userName: `acc-${unique}-user-${n}`, email: `acc-${unique}-user-${n++}@example.com`, password: 'Contract-Pass-2026!x' }), status: 201, contentType: true },
        { method: 'PUT', path: `/retention/retentions/${rule}`, body: () => ({ maximumAge: 3000 + n++ }), status: 200, contentType: true },
        { method: 'POST', path: '/application/applications', body: () => ({ name: `acc-${unique}-app-${n}`, key: `acc-${unique}-app-${n++}-key`, type: 'EXTERNAL', externalUrl: 'https://example.com' }), status: 201, contentType: true },
        { method: 'PUT', path: `/application/applications/${application}`, body: () => ({ description: `d${n++}` }), status: 200, contentType: true },
        { method: 'POST', path: '/notification2/subscriptions', body: () => ({ context: 'tenant', subscription: `acc${unique}x${n++}`, subscriptionFilter: { apis: ['alarms'] } }), status: 201, contentType: false },
        // a read sent as POST too
        { method: 'POST', path: '/identity/search', body: () => ({ externalIds: [{ type: 'acc_Serial', externalId: `acc-${unique}-0` }] }), status: 200, contentType: true },
      ]
      try {
        for (const accept of [undefined, '*/*', 'application/json', 'application/json, text/plain, */*']) {
          const acceptsJson = accept?.includes('application/json') ?? false
          for (const { method, path, body, status, empty, contentType } of writes) {
            const label = `${method} ${path} accept=${accept}`
            const result = await write(client, method, path, body(), accept)
            if (acceptsJson) {
              expect(result.status, label).toBe(status)
              expect(JSON.parse(result.text), label).toEqual(expect.any(Object))
            } else {
              expect(result.status, label).toBe(empty ?? status)
              expect(result.text, label).toBe('')
              expect(result.contentType !== null, label).toBe(contentType)
            }
          }
        }
        // a vendor media type counts as JSON
        const vendor = await write(client, 'POST', '/inventory/managedObjects', { name: `acc-${unique}-vendor` }, 'application/vnd.com.nsn.cumulocity.managedobject+json')
        expect(JSON.parse(vendor.text).name).toBe(`acc-${unique}-vendor`)
        // an endpoint that answers plain JSON keeps its body
        for (const accept of [undefined, '*/*']) {
          const token = await write(client, 'POST', '/notification2/token', { subscriber: `acc${unique}`, subscription: `acc${unique}`, expiresInMinutes: 5 }, accept)
          expect(token.status).toBe(200)
          expect(JSON.parse(token.text).token).toEqual(expect.any(String))
        }
      } finally {
        await client.core.fetch(`/tenant/options/${category}/k`, { method: 'DELETE' })
        const groups = ((await json('GET', `/user/${tenant}/groups?pageSize=2000`, undefined)).groups as Array<{ id: number, name: string }>).filter((item) => item.name.startsWith(`acc-${unique}-group`))
        const rules = ((await json('GET', '/retention/retentions?pageSize=2000', undefined)).retentionRules as Array<{ id: string, type: string }>).filter((item) => item.type.startsWith(`acc_${unique}`))
        const users = ((await json('GET', `/user/${tenant}/users?pageSize=2000&username=acc-${unique}-user`, undefined)).users as Array<{ id: string }>).filter((item) => item.id.startsWith(`acc-${unique}-user`))
        const applications = ((await json('GET', `/application/applications?pageSize=2000&owner=${tenant}`, undefined)).applications as Array<{ id: string, name: string }>).filter((item) => item.name.startsWith(`acc-${unique}-app`))
        const subscriptions = ((await json('GET', '/notification2/subscriptions?context=tenant&pageSize=2000', undefined)).subscriptions as Array<{ id: string, subscription: string }>).filter((item) => item.subscription.startsWith(`acc${unique}`))
        for (const path of [...groups.map((item) => `/user/${tenant}/groups/${item.id}`), ...rules.map((item) => `/retention/retentions/${item.id}`), ...users.map((item) => `/user/${tenant}/users/${encodeURIComponent(item.id)}`), ...applications.map((item) => `/application/applications/${item.id}`), ...subscriptions.map((item) => `/notification2/subscriptions/${item.id}`)]) {
          await client.core.fetch(path, { method: 'DELETE' })
        }
      }
    },
  },
]
