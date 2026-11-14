import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'

// Request variants the spec documents for writes: the processing mode,
// X-HTTP-METHOD, the bulk create and update of managed objects, and
// `withDeviceUser` when the device user owns more. Verified on a tenant
// (November 2026), except external ids in a bulk create (no `verifies`).

const MO = '/inventory/managedObjects'
const COLLECTION = 'application/vnd.com.nsn.cumulocity.managedobjectcollection+json'
const PASSWORD = 'Contract-Pass-2026!x'

const INFO = 'https://cumulocity.com/api/core/'

async function api(client: Client, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number, body: any, headers: Headers }> {
  const res = await client.core.fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'accept': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, body: json, headers: res.headers }
}

// Jackson's message for a string item of a managed object collection
const stringItem = (column: number) => `Cannot construct instance of \`com.cumulocity.rest.representation.inventory.ManagedObjectRepresentation\` (although at least one Creator exists): no String-argument constructor/factory method to deserialize from String value ('abc')\n at [Source: REDACTED (\`StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION\` disabled); line: 1, column: ${column}] (through reference chain: com.cumulocity.rest.representation.inventory.ManagedObjectCollectionRepresentation["managedObjects"]->java.util.ArrayList[0])`

const byType = (type: string) => `${MO}?pageSize=100&type=${encodeURIComponent(type)}`

export const requestVariantScenarios: ContractScenario[] = [
  {
    name: 'processing mode: TRANSIENT and CEP writes are answered but not stored',
    verifies: ['processing-mode-transient'],
    async run({ client, unique, settle }) {
      const device = await api(client, 'POST', MO, { name: `pm-${unique}`, type: `pm-${unique}`, c8y_IsDevice: {} })
      expect(device.status).toBe(201)
      const source = { id: device.body.id }
      const time = new Date().toISOString()
      const alarm = await api(client, 'POST', '/alarm/alarms', { source, type: `pm-kept-${unique}`, text: 'x', severity: 'MINOR', time })
      expect(alarm.status).toBe(201)
      for (const mode of ['TRANSIENT', 'CEP']) {
        const headers = { 'X-Cumulocity-Processing-Mode': mode }
        for (const [path, body] of [
          ['/measurement/measurements', { source, type: `pm-${unique}`, time, c8y_T: { T: { value: 1 } } }],
          ['/event/events', { source, type: `pm-${unique}`, text: 'x', time }],
          ['/alarm/alarms', { source, type: `pm-${unique}`, text: 'x', severity: 'MINOR', time }],
          [MO, { name: `pm-new-${unique}`, type: `pm-new-${unique}` }],
        ] as const) {
          const created = await api(client, 'POST', path, body, headers)
          expect([mode, path, created.status, typeof created.body.id, created.headers.get('location')]).toEqual([mode, path, 201, 'string', created.body.self])
          if (path === MO) {
            expect((await api(client, 'GET', `${MO}/${created.body.id}`)).status, mode).toBe(404)
          }
        }
        expect((await api(client, 'PUT', `${MO}/${source.id}`, { c8y_Transient: { mode } }, headers)).status, mode).toBe(200)
        // also a delete
        expect((await api(client, 'DELETE', `/alarm/alarms?source=${source.id}&type=pm-kept-${unique}`, undefined, headers)).status, mode).toBe(204)
      }
      await settle(2000)
      expect((await api(client, 'GET', `/measurement/measurements?source=${source.id}&pageSize=100`)).body.measurements).toEqual([])
      expect((await api(client, 'GET', `/event/events?source=${source.id}&pageSize=100`)).body.events).toEqual([])
      expect((await api(client, 'GET', `/alarm/alarms?source=${source.id}&pageSize=100`)).body.alarms.map((item: { id: string }) => item.id)).toEqual([alarm.body.id])
      expect((await api(client, 'GET', byType(`pm-new-${unique}`))).body.managedObjects).toEqual([])
      expect((await api(client, 'GET', `${MO}/${source.id}`)).body).not.toHaveProperty('c8y_Transient')

      // QUIESCENT stores like PERSISTENT
      expect((await api(client, 'POST', '/event/events', { source, type: `pm-${unique}`, text: 'x', time }, { 'X-Cumulocity-Processing-Mode': 'QUIESCENT' })).status).toBe(201)
      expect((await api(client, 'GET', `/event/events?source=${source.id}&pageSize=100`)).body.events).toHaveLength(1)
    },
  },
  {
    name: 'X-HTTP-METHOD: a POST runs as the method the header names',
    verifies: ['x-http-method'],
    async run({ client, unique }) {
      const created = await api(client, 'POST', MO, { name: `xm-${unique}`, type: `xm-${unique}` })
      expect(created.status).toBe(201)
      const updated = await api(client, 'POST', `${MO}/${created.body.id}`, { name: `xm-renamed-${unique}` }, { 'X-HTTP-METHOD': 'PUT' })
      expect(updated.status).toBe(200)
      expect((await api(client, 'GET', `${MO}/${created.body.id}`)).body.name).toBe(`xm-renamed-${unique}`)
      // in any case
      const lower = await api(client, 'POST', `${MO}/${created.body.id}`, { name: `xm-lower-${unique}` }, { 'X-HTTP-METHOD': 'put' })
      expect([lower.status, lower.body.name]).toEqual([200, `xm-lower-${unique}`])
      const deleted = await api(client, 'POST', `${MO}/${created.body.id}`, undefined, { 'X-HTTP-METHOD': 'DELETE' })
      expect(deleted.status).toBe(204)
      expect((await api(client, 'GET', `${MO}/${created.body.id}`)).status).toBe(404)
    },
  },
  {
    name: 'inventory: creating several managed objects at once',
    verifies: ['managed-object-bulk-create'],
    async run({ client, unique }) {
      const type = `bc-${unique}`
      const created = await api(client, 'POST', MO, { managedObjects: [{ name: `a-${unique}`, type }, { name: `b-${unique}`, type, c8y_BatchId_x: 1 }] }, { 'content-type': COLLECTION, 'accept': `${COLLECTION}, application/json` })
      try {
        expect(created.status).toBe(200)
        expect(created.headers.get('content-type')).toBe(`${COLLECTION};charset=UTF-8;ver=0.9`)
        expect(Object.keys(created.body)).toEqual(['self', 'managedObjects', 'statistics'])
        expect(created.body.managedObjects.map((item: { name: string }) => item.name)).toEqual([`a-${unique}`, `b-${unique}`])
        expect(created.body.managedObjects[1]).not.toHaveProperty('c8y_BatchId_x')

        // checked before anything is created
        const invalid = (message: string) => ({ error: 'undefined/validationError', message, info: INFO })
        const empty = await api(client, 'POST', MO, { managedObjects: [] }, { 'content-type': COLLECTION })
        expect([empty.status, empty.body]).toEqual([422, invalid('post.managedObjectCollection.managedObjects: At least one managed object is required for a bulk request')])
        const many = await api(client, 'POST', MO, { managedObjects: Array.from({ length: 51 }, (_, index) => ({ name: `m${index}-${unique}`, type })) }, { 'content-type': COLLECTION })
        expect([many.status, many.body]).toEqual([422, invalid('post.managedObjectCollection.managedObjects: Maximum of 50 managed objects allowed in a bulk request')])
        const withId = await api(client, 'POST', MO, { managedObjects: [{ name: `c-${unique}`, type }, { id: '1', name: `d-${unique}`, type }] }, { 'content-type': COLLECTION })
        expect([withId.status, withId.body]).toEqual([422, { ...invalid('post.managedObjectCollection.managedObjects[1].id: is not allowed here'), bulkRequest: { failedIndex: 1 } }])
        const text = await api(client, 'POST', MO, { managedObjects: ['abc'] }, { 'content-type': COLLECTION })
        expect([text.status, text.body]).toEqual([400, { error: 'Failed to parse JSON string', message: stringItem(20), info: INFO }])
        // a single null: the platform sometimes leaves out the message
        const nothing = await api(client, 'POST', MO, { managedObjects: [null] }, { 'content-type': COLLECTION })
        expect([nothing.status, nothing.body]).toEqual([500, { error: 'general/internalError', ...('message' in nothing.body ? { message: 'Cannot invoke "Object.getClass()" because "source" is null' } : {}), info: INFO }])
        // a null among two or more items fails the collection's external id check
        for (const managedObjects of [[{ name: `e-${unique}`, type }, null], [null, null]]) {
          const withNull = await api(client, 'POST', MO, { managedObjects }, { 'content-type': COLLECTION })
          expect([withNull.status, withNull.body]).toEqual([422, invalid('HV000028: Unexpected exception during isValid call. : Cannot invoke "com.cumulocity.rest.representation.inventory.ManagedObjectRepresentation.getExternalIds()" because "managedObject" is null')])
        }
        expect((await api(client, 'GET', byType(type))).body.managedObjects).toHaveLength(2)
      } finally {
        for (const item of created.body?.managedObjects ?? []) {
          await api(client, 'DELETE', `${MO}/${item.id}`).catch(() => {})
        }
      }
    },
  },
  {
    // Unverified on a real tenant: external ids in a bulk create, as the spec documents them.
    name: 'inventory: external ids in a bulk create',
    async run({ client, unique }) {
      const type = `bx-${unique}`
      const created = await api(client, 'POST', MO, { managedObjects: [{ name: `a-${unique}`, type }, { name: `b-${unique}`, type, externalIds: [{ type: `bc_Serial`, externalId: `B-${unique}` }] }] }, { 'content-type': COLLECTION, 'accept': COLLECTION })
      try {
        expect(created.status).toBe(200)
        expect((await api(client, 'GET', `/identity/externalIds/bc_Serial/B-${unique}`)).body.managedObject.id).toBe(created.body.managedObjects[1].id)
        // checked before anything is created: the failing item is named
        const bound = await api(client, 'POST', MO, { managedObjects: [{ name: `c-${unique}`, type }, { name: `d-${unique}`, type, externalIds: [{ type: `bc_Serial`, externalId: `B-${unique}` }] }] }, { 'content-type': COLLECTION })
        expect(bound.status).toBe(409)
        expect(bound.body).toMatchObject({ error: 'identity/Duplicate', bulkRequest: { failedIndex: 1 } })
        expect((await api(client, 'GET', byType(type))).body.managedObjects).toHaveLength(2)
      } finally {
        for (const item of (await api(client, 'GET', byType(type))).body?.managedObjects ?? []) {
          await api(client, 'DELETE', `${MO}/${item.id}`).catch(() => {})
        }
      }
    },
  },
  {
    name: 'inventory: items of a bulk update that are no managed object',
    verifies: ['managed-object-bulk-update-items'],
    async run({ client }) {
      const nothing = await api(client, 'PUT', MO, { managedObjects: [null] }, { 'content-type': COLLECTION })
      expect([nothing.status, nothing.body]).toEqual([422, { error: 'undefined/validationError', message: 'HV000028: Unexpected exception during isValid call. : Cannot invoke "com.cumulocity.rest.representation.ResourceRepresentationWithId.getId()" because "representation" is null', info: INFO }])
      const text = await api(client, 'PUT', MO, { managedObjects: ['abc'] }, { 'content-type': COLLECTION })
      expect([text.status, text.body]).toEqual([400, { error: 'Failed to parse JSON string', message: stringItem(20), info: INFO }])
      const noId = await api(client, 'PUT', MO, { managedObjects: [{ name: 'x' }] }, { 'content-type': COLLECTION })
      expect([noId.status, noId.body]).toEqual([422, { error: 'undefined/validationError', message: 'put.managedObjectCollection.managedObjects[0].id: is required', info: INFO, bulkRequest: { failedIndex: 0 } }])
    },
  },
  {
    name: 'inventory: withDeviceUser when the device user owns other managed objects',
    verifies: ['with-device-user-conflict'],
    async run({ client, unique, tenant }) {
      const userName = `device_${unique}`
      expect((await api(client, 'POST', `/user/${tenant}/users`, { userName, email: `${userName.toLowerCase()}@example.com`, password: PASSWORD })).status).toBe(201)
      const created: string[] = []
      try {
        // verified (scenario 'inventory: owner is the calling user, settable
        // on create and update'): a create stores the `owner` of the body
        const device = await api(client, 'POST', MO, { name: `du-${unique}`, type: `du-${unique}`, owner: userName, c8y_IsDevice: {} })
        if (device.body?.id) {
          created.push(device.body.id)
        }
        const other = await api(client, 'POST', MO, { name: `du-other-${unique}`, type: `du-${unique}`, owner: userName })
        if (other.body?.id) {
          created.push(other.body.id)
        }
        expect([device.body.owner, other.body.owner]).toEqual([userName, userName])
        // 409, before anything is deleted
        const conflict = await api(client, 'DELETE', `${MO}/${device.body.id}?withDeviceUser=true`)
        expect([conflict.status, conflict.body]).toEqual([409, { error: 'inventory/Update Conflict', message: 'Can\'t delete user because it is used by another managed object', info: INFO }])
        expect((await api(client, 'GET', `${MO}/${device.body.id}`)).status).toBe(200)
        expect((await api(client, 'GET', `/user/${tenant}/users/${userName}`)).status).toBe(200)
      } finally {
        // also when the delete went through (then some of these answer 404)
        for (const id of created) {
          await api(client, 'DELETE', `${MO}/${id}`).catch(() => {})
        }
        await api(client, 'DELETE', `/user/${tenant}/users/${userName}`).catch(() => {})
      }
    },
  },
]
