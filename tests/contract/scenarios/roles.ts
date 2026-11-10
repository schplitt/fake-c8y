import { Buffer } from 'node:buffer'
import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'

// Role enforcement, checked with a restricted user each scenario creates
// (with a random password) and deletes in `finally`. The client's user only
// creates the test data and assigns and removes roles on that user. Against
// the fake the suite runs with `roles: 'enforce'`.

interface Answer {
  status: number
  body: any
}

interface Login {
  login: string
  password: string
}

async function api(client: Client, method: string, path: string, body?: unknown, auth?: Login): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'accept': 'application/json' }
  if (auth) {
    headers.authorization = `Basic ${Buffer.from(`${auth.login}:${auth.password}`).toString('base64')}`
  }
  const init = { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }
  const res = auth ? await fetch(`${client.core.baseUrl}${path}`, init) : await client.core.fetch(path, init)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

function password(): string {
  const random = Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('')
  return `Rr1!${random}`
}

const time = '2026-01-01T00:00:00.000Z'

/**
 * A restricted user and the data of a scenario; everything is deleted
 * afterwards, also when the scenario fails.
 * @param client
 * @param tenant
 * @param unique
 * @param run
 */
async function withRestrictedUser(client: Client, tenant: string, unique: string, run: (context: {
  as: (method: string, path: string, body?: unknown) => Promise<Answer>
  userName: string
  grant: (role: string) => Promise<void>
  revoke: (role: string) => Promise<void>
  object: (body: Record<string, unknown>) => Promise<string>
  inventoryRole: (body: Record<string, unknown>) => Promise<number>
}) => Promise<void>): Promise<void> {
  const userName = `${unique}-roles`
  const login = { login: `${tenant}/${userName}`, password: password() }
  const objects: string[] = []
  const inventoryRoles: number[] = []
  const userPath = `/user/${tenant}/users/${encodeURIComponent(userName)}`
  const created = await api(client, 'POST', `/user/${tenant}/users`, { userName, email: `${userName}@example.com`, password: login.password })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  try {
    await run({
      as: (method, path, body) => api(client, method, path, body, login),
      userName,
      grant: async (role) => {
        expect((await api(client, 'POST', `${userPath}/roles`, { role: { self: `/user/roles/${role}` } })).status).toBe(201)
      },
      revoke: async (role) => {
        expect((await api(client, 'DELETE', `${userPath}/roles/${role}`)).status).toBe(204)
      },
      object: async (body) => {
        const answer = await api(client, 'POST', '/inventory/managedObjects', { name: `${unique}-mo`, ...body })
        objects.push(answer.body.id)
        return answer.body.id
      },
      inventoryRole: async (body) => {
        const answer = await api(client, 'POST', '/user/inventoryroles', { name: `${unique}-ir${inventoryRoles.length}`, ...body })
        expect(answer.status).toBe(201)
        inventoryRoles.push(answer.body.id)
        return answer.body.id
      },
    })
  } finally {
    // the user first: its inventory assignments hold the inventory roles
    await api(client, 'DELETE', userPath)
    for (const id of inventoryRoles) {
      await api(client, 'DELETE', `/user/inventoryroles/${id}`)
    }
    for (const id of objects) {
      for (const path of [`/event/events?source=${id}`, `/alarm/alarms?source=${id}`, `/devicecontrol/operations?deviceId=${id}`]) {
        await api(client, 'DELETE', path)
      }
      await api(client, 'DELETE', `/inventory/managedObjects/${id}`)
    }
  }
}

const event = (source: string, fragments: Record<string, unknown> = {}) => ({ source: { id: source }, type: 'roles_test', text: 'x', time, ...fragments })
const alarm = (source: string) => ({ source: { id: source }, type: 'roles_test', text: 'x', time, severity: 'MINOR' })

export const rolesScenarios: ContractScenario[] = [
  {
    name: 'roles: a user without roles, and read and admin roles apart',
    verifies: ['roles-forbidden-body', 'roles-unknown-id-404', 'roles-admin-without-read', 'roles-open-endpoints'],
    async run({ client, tenant, unique }) {
      await withRestrictedUser(client, tenant, unique, async ({ as, userName, grant, revoke, object }) => {
        const device = await object({ type: `${unique}-t`, c8y_IsDevice: {} })
        const stored = await api(client, 'POST', '/event/events', event(device))
        expect(stored.status).toBe(201)

        // a new user has only its own user management roles
        const me = await as('GET', '/user/currentUser')
        expect([me.status, me.body.userName]).toEqual([200, userName])
        expect(me.body.effectiveRoles.map((role: { id: string }) => role.id).sort()).toEqual(['ROLE_USER_MANAGEMENT_OWN_ADMIN', 'ROLE_USER_MANAGEMENT_OWN_READ'])
        expect((await as('GET', '/tenant/currentTenant')).status).toBe(200)

        const denied = await as('GET', `/inventory/managedObjects/${device}`)
        expect(denied).toEqual({ status: 403, body: { error: 'security/Forbidden', message: 'Access Denied', info: 'https://cumulocity.com/api/core/' } })
        // lists of data documents answer 'Access is denied'
        for (const path of ['/event/events', '/alarm/alarms', '/measurement/measurements', '/devicecontrol/operations']) {
          const list = await as('GET', `${path}?pageSize=1`)
          expect([path, list.status, list.body.error, list.body.message]).toEqual([path, 403, 'security/Forbidden', 'Access is denied'])
        }
        for (const path of ['/tenant/options', `/user/${tenant}/users`, '/application/applications', '/retention/retentions', '/notification2/subscriptions', '/devicecontrol/bulkoperations', '/tenant/statistics']) {
          const list = await as('GET', `${path}?pageSize=1`)
          expect([path, list.status, list.body.message]).toEqual([path, 403, 'Access Denied'])
        }
        expect((await as('POST', '/event/events', {})).status).toBe(403)
        expect((await as('POST', '/tenant/options', {})).status).toBe(403)
        // an unknown id answers 404 before the role check
        expect((await as('GET', '/event/events/999999999')).status).toBe(404)
        expect((await as('GET', '/inventory/managedObjects/999999999')).status).toBe(404)
        // the inventory list and the alarm count filter instead
        const objects = await as('GET', `/inventory/managedObjects?type=${unique}-t&withTotalElements=true`)
        expect([objects.status, objects.body.managedObjects, objects.body.statistics.totalElements]).toEqual([200, [], 0])
        expect(await as('GET', `/alarm/alarms/count?source=${device}`)).toEqual({ status: 200, body: 0 })

        // a read role reads, an admin role writes but does not read
        await grant('ROLE_EVENT_READ')
        expect((await as('GET', `/event/events/${stored.body.id}`)).status).toBe(200)
        expect((await as('POST', '/event/events', event(device))).status).toBe(403)
        await revoke('ROLE_EVENT_READ')
        await grant('ROLE_EVENT_ADMIN')
        expect((await as('POST', '/event/events', {})).status).toBe(422)
        expect((await as('POST', '/event/events', event(device))).status).toBe(201)
        expect((await as('PUT', `/event/events/${stored.body.id}`, { text: 'y' })).status).toBe(200)
        expect((await as('GET', `/event/events/${stored.body.id}`)).status).toBe(403)
        expect((await as('GET', '/event/events?pageSize=1')).status).toBe(403)
      })
    },
  },
  {
    name: 'roles: the owner of a managed object',
    verifies: ['roles-ownership'],
    async run({ client, tenant, unique }) {
      await withRestrictedUser(client, tenant, unique, async ({ as, userName, grant, revoke, object }) => {
        const foreign = await object({ type: `${unique}-t`, c8y_IsDevice: {} })
        await grant('ROLE_INVENTORY_CREATE')
        const own = await as('POST', '/inventory/managedObjects', { name: `${unique}-own`, type: `${unique}-t`, c8y_IsDevice: {} })
        await revoke('ROLE_INVENTORY_CREATE')
        expect([own.status, own.body.owner]).toEqual([201, userName])
        const id = own.body.id
        try {
          expect((await as('GET', `/inventory/managedObjects/${id}`)).status).toBe(200)
          expect((await as('PUT', `/inventory/managedObjects/${id}`, { name: `${unique}-own2` })).status).toBe(200)
          const list = await as('GET', `/inventory/managedObjects?type=${unique}-t`)
          expect(list.body.managedObjects.map((mo: { id: string }) => mo.id)).toEqual([id])
          const created = await as('POST', '/event/events', event(id))
          expect(created.status).toBe(201)
          expect((await as('GET', `/event/events/${created.body.id}`)).status).toBe(200)
          expect((await as('POST', '/alarm/alarms', alarm(id))).status).toBe(201)
          expect((await as('GET', `/identity/globalIds/${id}/externalIds`)).status).toBe(200)
          // data lists do not count ownership
          expect((await as('GET', `/event/events?source=${id}`)).status).toBe(403)
          // nothing of another object, also not to link it
          expect((await as('GET', `/inventory/managedObjects/${foreign}`)).status).toBe(403)
          expect((await as('POST', '/event/events', event(foreign))).status).toBe(403)
          expect((await as('POST', `/inventory/managedObjects/${id}/childDevices`, { managedObject: { id: foreign } })).status).toBe(403)
          expect((await as('DELETE', `/event/events/${created.body.id}`)).status).toBe(204)
        } finally {
          await api(client, 'DELETE', `/alarm/alarms?source=${id}`)
          await api(client, 'DELETE', `/event/events?source=${id}`)
          await api(client, 'DELETE', `/inventory/managedObjects/${id}`)
        }
      })
    },
  },
  {
    name: 'roles: inventory roles on a group and its descendants',
    verifies: ['roles-inventory-descendants', 'roles-data-lists'],
    async run({ client, tenant, unique }) {
      await withRestrictedUser(client, tenant, unique, async ({ as, userName, object }) => {
        const type = `${unique}-t`
        const group = await object({ type: 'c8y_DeviceGroup', c8y_IsDeviceGroup: {} })
        const device = await object({ type, c8y_IsDevice: {} })
        const child = await object({ type, c8y_IsDevice: {} })
        const outside = await object({ type, c8y_IsDevice: {} })
        expect((await api(client, 'POST', `/inventory/managedObjects/${group}/childAssets`, { managedObject: { id: device } })).status).toBe(201)
        expect((await api(client, 'POST', `/inventory/managedObjects/${device}/childDevices`, { managedObject: { id: child } })).status).toBe(201)
        for (const source of [device, outside]) {
          expect((await api(client, 'POST', '/event/events', event(source))).status).toBe(201)
        }
        const assigned = await api(client, 'POST', `/user/${tenant}/users/${userName}/roles/inventory`, { managedObject: group, roles: [{ id: 1 }] })
        // verified: 200, not 201
        expect(assigned.status).toBe(200)

        // Reader on the group: the group and everything below it
        for (const id of [group, device, child]) {
          expect([id, (await as('GET', `/inventory/managedObjects/${id}`)).status]).toEqual([id, 200])
        }
        expect((await as('GET', `/inventory/managedObjects/${outside}`)).status).toBe(403)
        const objects = await as('GET', `/inventory/managedObjects?type=${type}&pageSize=10`)
        expect(objects.body.managedObjects.map((mo: { id: string }) => mo.id).sort()).toEqual([device, child].sort())
        // with an inventory role the data lists answer, with what it may read
        const events = await as('GET', `/event/events?source=${outside}`)
        expect([events.status, events.body.events]).toEqual([200, []])
        expect((await as('GET', `/event/events?source=${device}`)).body.events).toHaveLength(1)
        expect((await as('PUT', `/inventory/managedObjects/${device}`, { [`${unique.replace(/\W/g, '')}_x`]: {} })).status).toBe(403)

        // Manager: inventory and alarms, no events
        expect((await api(client, 'PUT', `/user/${tenant}/users/${userName}/roles/inventory/${assigned.body.id}`, { managedObject: group, roles: [{ id: 2 }] })).status).toBe(200)
        expect((await as('PUT', `/inventory/managedObjects/${child}`, { name: `${unique}-renamed` })).status).toBe(200)
        expect((await as('POST', '/alarm/alarms', alarm(device))).status).toBe(201)
        expect((await as('POST', '/event/events', event(device))).status).toBe(403)
        expect((await as('POST', '/inventory/managedObjects', { name: `${unique}-new` })).status).toBe(403)
      })
    },
  },
  {
    name: 'roles: a typed inventory permission',
    verifies: ['roles-typed-permission'],
    async run({ client, tenant, unique }) {
      await withRestrictedUser(client, tenant, unique, async ({ as, userName, object, inventoryRole }) => {
        const device = await object({ c8y_IsDevice: {} })
        const fragment = `roles_${unique.replace(/\W/g, '')}`
        const role = await inventoryRole({ description: 'roles test', permissions: [{ permission: '*', scope: 'EVENT', type: fragment }] })
        expect((await api(client, 'POST', `/user/${tenant}/users/${userName}/roles/inventory`, { managedObject: device, roles: [{ id: role }] })).status).toBe(200)
        // the type is a fragment of the document, not its `type`
        expect((await as('POST', '/event/events', { ...event(device), type: fragment })).status).toBe(403)
        const created = await as('POST', '/event/events', event(device, { [fragment]: {} }))
        expect(created.status).toBe(201)
        expect((await as('GET', `/event/events/${created.body.id}`)).status).toBe(200)
        expect((await as('GET', `/inventory/managedObjects/${device}`)).status).toBe(403)

        // a typed operation permission ("Operations: Restart Device") allows nothing on the operation
        const agent = await object({ c8y_IsDevice: {}, com_cumulocity_model_Agent: {}, c8y_SupportedOperations: ['c8y_Restart'] })
        const restart = { deviceId: agent, description: 'roles test', c8y_Restart: {} }
        const stored = await api(client, 'POST', '/devicecontrol/operations', restart)
        expect((await api(client, 'POST', `/user/${tenant}/users/${userName}/roles/inventory`, { managedObject: agent, roles: [{ id: 4 }] })).status).toBe(200)
        expect((await as('POST', '/devicecontrol/operations', restart)).status).toBe(403)
        expect((await as('GET', `/devicecontrol/operations/${stored.body.id}`)).status).toBe(403)
        expect((await as('GET', `/inventory/managedObjects/${agent}`)).status).toBe(200)
      })
    },
  },
]
