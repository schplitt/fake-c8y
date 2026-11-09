import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { eventually, sleep } from '../helpers'

// Changes a write makes to other documents than the one written: alarm
// counters on the source, lastUpdated of parents, data and references that go
// with a deleted object, external ids, availability fragments, and audit
// records of group members.

async function api(client: Client, method: string, path: string, body?: unknown) {
  const res = await client.core.fetch(path, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, body: json }
}

async function create(client: Client, body: Record<string, unknown>): Promise<any> {
  const result = await api(client, 'POST', '/inventory/managedObjects', body)
  expect(result.status, JSON.stringify(result.body)).toBe(201)
  return result.body
}

async function read(client: Client, id: string): Promise<any> {
  return (await api(client, 'GET', `/inventory/managedObjects/${id}`)).body
}

async function exists(client: Client, id: string): Promise<boolean> {
  return (await api(client, 'GET', `/inventory/managedObjects/${id}`)).status === 200
}

const now = () => new Date().toISOString()

export const sideEffectsScenarios: ContractScenario[] = [
  {
    name: 'side effects: c8y_ActiveAlarmsStatus follows the alarms of the source',
    verifies: ['active-alarms-status'],
    async run({ client, unique }) {
      const device = await create(client, { name: `aas-${unique}`, c8y_IsDevice: {} })
      const status = async () => (await read(client, device.id)).c8y_ActiveAlarmsStatus
      const zero = { critical: 0, major: 0, minor: 0, warning: 0 }
      const alarm = (type: string, extra: Record<string, unknown> = {}) => api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `${type}-${unique}`, text: type, severity: 'MAJOR', time: now(), ...extra })

      // a cleared alarm does not create the fragment
      await alarm('cleared', { status: 'CLEARED' })
      expect(await status()).toBeUndefined()

      const { body: major } = await alarm('hot')
      await eventually(async () => expect(await status()).toEqual({ ...zero, major: 1 }))
      // acknowledged alarms still count; a severity change moves the count
      await api(client, 'PUT', `/alarm/alarms/${major.id}`, { status: 'ACKNOWLEDGED' })
      await api(client, 'PUT', `/alarm/alarms/${major.id}`, { severity: 'WARNING' })
      await eventually(async () => expect(await status()).toEqual({ ...zero, warning: 1 }))
      await api(client, 'PUT', `/alarm/alarms/${major.id}`, { status: 'CLEARED' })
      await eventually(async () => expect(await status()).toEqual(zero))
      // a cleared alarm can become active again
      expect((await api(client, 'PUT', `/alarm/alarms/${major.id}`, { status: 'ACTIVE' })).body.status).toBe('ACTIVE')
      await eventually(async () => expect(await status()).toEqual({ ...zero, warning: 1 }))

      // unknown severities count under their lower-case name, a standard one in lower case not at all
      await alarm('severe', { severity: 'SEVERE' })
      await alarm('lower', { severity: 'minor' })
      await eventually(async () => expect(await status()).toEqual({ ...zero, warning: 1, severe: 1 }))
      // nothing validates a severity, also a name objects have built in, on create, update, and upsert
      const { body: odd } = await alarm('odd', { severity: 'constructor' })
      expect(odd.severity).toBe('constructor')
      await eventually(async () => expect(await status()).toEqual({ ...zero, warning: 1, severe: 1, constructor: 1 }))
      expect((await api(client, 'PUT', `/alarm/alarms/${odd.id}`, { severity: 'foo' })).body.severity).toBe('foo')
      await eventually(async () => expect(await status()).toEqual({ ...zero, warning: 1, severe: 1, constructor: 0, foo: 1 }))
      expect((await api(client, 'POST', '/alarm/alarms/upsert', { source: { id: device.id }, type: `odd-${unique}`, severity: 'minor' })).body.alarm.severity).toBe('minor')
      expect((await api(client, 'POST', '/alarm/alarms/upsert', { source: { id: device.id }, type: `odd2-${unique}`, severity: 'constructor' })).body.alarm.severity).toBe('constructor')
      await eventually(async () => expect(await status()).toEqual({ ...zero, warning: 1, severe: 1, constructor: 1, foo: 0 }))

      // bulk updates and deletes count too; keys stay at 0
      await api(client, 'PUT', `/alarm/alarms?source=${device.id}&status=ACTIVE`, { status: 'CLEARED' })
      await eventually(async () => expect(await status()).toEqual({ ...zero, severe: 0, constructor: 0, foo: 0 }))
      await alarm('deleted', { severity: 'CRITICAL' })
      await eventually(async () => expect(await status()).toEqual({ ...zero, critical: 1, severe: 0, constructor: 0, foo: 0 }))
      expect((await api(client, 'DELETE', `/alarm/alarms?source=${device.id}&type=deleted-${unique}`)).status).toBe(204)
      await eventually(async () => expect(await status()).toEqual({ ...zero, severe: 0, constructor: 0, foo: 0 }))

      // the source itself is not updated
      expect((await read(client, device.id)).lastUpdated).toBe(device.lastUpdated)
    },
  },
  {
    name: 'side effects: child references update lastUpdated of parent and child',
    verifies: ['child-reference-last-updated'],
    async run({ client, unique }) {
      const group = await create(client, { name: `clu-g-${unique}`, c8y_IsDeviceGroup: {} })
      const device = await create(client, { name: `clu-d-${unique}`, c8y_IsDevice: {} })
      const lastUpdated = async (id: string) => Date.parse((await read(client, id)).lastUpdated)
      await sleep(50)

      const before = { group: await lastUpdated(group.id), device: await lastUpdated(device.id) }
      expect((await api(client, 'POST', `/inventory/managedObjects/${group.id}/childAssets`, { managedObject: { id: device.id } })).status).toBe(201)
      const added = { group: await lastUpdated(group.id), device: await lastUpdated(device.id) }
      expect(added.group).toBeGreaterThan(before.group)
      expect(added.device).toBeGreaterThan(before.device)
      await sleep(50)

      // an update of the child leaves the parent alone
      await api(client, 'PUT', `/inventory/managedObjects/${device.id}`, { c8y_Notes: 'x' })
      expect(await lastUpdated(group.id)).toBe(added.group)
      await sleep(50)

      expect((await api(client, 'DELETE', `/inventory/managedObjects/${group.id}/childAssets/${device.id}`)).status).toBe(204)
      expect(await lastUpdated(group.id)).toBeGreaterThan(added.group)
      expect(await lastUpdated(device.id)).toBeGreaterThan(added.device)
    },
  },
  {
    name: 'side effects: deleting a device deletes its data, external ids, and subscriptions',
    verifies: ['delete-device-data'],
    async run({ client, unique }) {
      const parent = await create(client, { name: `ddd-p-${unique}`, c8y_IsDevice: {} })
      const device = await create(client, { name: `ddd-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} })
      await api(client, 'POST', `/inventory/managedObjects/${parent.id}/childDevices`, { managedObject: { id: device.id } })
      const parentUpdated = (await read(client, parent.id)).lastUpdated
      const source = { source: { id: device.id }, time: now() }
      await api(client, 'POST', `/identity/globalIds/${device.id}/externalIds`, { type: 'ddd_Serial', externalId: `ddd-${unique}` })
      const { body: alarm } = await api(client, 'POST', '/alarm/alarms', { ...source, type: `ddd-${unique}`, text: 'a', severity: 'MAJOR' })
      const { body: event } = await api(client, 'POST', '/event/events', { ...source, type: `ddd-${unique}`, text: 'e' })
      await api(client, 'POST', '/measurement/measurements', { ...source, type: `ddd-${unique}`, ddd_T: { T: { value: 1 } } })
      const { body: operation } = await api(client, 'POST', '/devicecontrol/operations', { deviceId: device.id, description: `ddd-${unique}`, c8y_Restart: {} })
      const { body: subscription } = await api(client, 'POST', '/notification2/subscriptions', { context: 'mo', source: { id: device.id }, subscription: `ddd${unique}`, subscriptionFilter: { apis: ['alarms'] } })
      expect(subscription.id).toBeDefined()

      expect((await api(client, 'DELETE', `/inventory/managedObjects/${device.id}`)).status).toBe(204)
      await eventually(async () => {
        expect((await api(client, 'GET', `/identity/externalIds/ddd_Serial/ddd-${unique}`)).status).toBe(404)
        expect((await api(client, 'GET', `/alarm/alarms/${alarm.id}`)).status).toBe(404)
        expect((await api(client, 'GET', `/event/events/${event.id}`)).status).toBe(404)
        expect((await api(client, 'GET', `/measurement/measurements?source=${device.id}`)).body.measurements).toEqual([])
        expect((await api(client, 'GET', `/devicecontrol/operations/${operation.id}`)).status).toBe(404)
        expect((await api(client, 'GET', `/notification2/subscriptions/${subscription.id}`)).status).toBe(404)
      })
      // the parent loses the reference without being updated
      const after = await read(client, parent.id)
      expect(after.childDevices.references).toEqual([])
      expect(after.lastUpdated).toBe(parentUpdated)
    },
  },
  {
    name: 'side effects: what a managed object delete takes along',
    verifies: ['delete-cascade'],
    async run({ client, unique }) {
      const object = (name: string, extra: Record<string, unknown> = {}) => create(client, { name: `${name}-${unique}`, ...extra })
      const link = (parent: string, kind: string, child: string) => api(client, 'POST', `/inventory/managedObjects/${parent}/${kind}`, { managedObject: { id: child } })

      // a group takes its subgroups along, not its devices and assets
      const group = await object('dc-group', { c8y_IsDeviceGroup: {} })
      const subgroup = await object('dc-subgroup', { c8y_IsDeviceGroup: {} })
      const device = await object('dc-device', { c8y_IsDevice: {} })
      const child = await object('dc-child', { c8y_IsDevice: {} })
      const asset = await object('dc-asset')
      await link(group.id, 'childAssets', subgroup.id)
      await link(subgroup.id, 'childAssets', device.id)
      await link(group.id, 'childAssets', asset.id)
      await link(device.id, 'childDevices', child.id)
      expect((await api(client, 'DELETE', `/inventory/managedObjects/${group.id}`)).status).toBe(204)
      await eventually(async () => {
        expect(await exists(client, group.id)).toBe(false)
        expect(await exists(client, subgroup.id)).toBe(false)
      })
      expect(await exists(client, device.id)).toBe(true)
      expect(await exists(client, asset.id)).toBe(true)

      // cascade: a device takes all its descendants along
      const addition = await object('dc-addition')
      await link(device.id, 'childAdditions', addition.id)
      expect((await api(client, 'DELETE', `/inventory/managedObjects/${device.id}?cascade=true`)).status).toBe(204)
      await eventually(async () => {
        expect(await exists(client, child.id)).toBe(false)
        expect(await exists(client, addition.id)).toBe(false)
      })

      // cascade does nothing for an object that is neither a device nor a group; forceCascade does
      const plainChild = await object('dc-plain-child')
      await link(asset.id, 'childAssets', plainChild.id)
      const other = await object('dc-other')
      const otherChild = await object('dc-other-child')
      await link(other.id, 'childAssets', otherChild.id)
      expect((await api(client, 'DELETE', `/inventory/managedObjects/${asset.id}?cascade=true`)).status).toBe(204)
      expect((await api(client, 'DELETE', `/inventory/managedObjects/${other.id}?forceCascade=true`)).status).toBe(204)
      await eventually(async () => expect(await exists(client, otherChild.id)).toBe(false))
      expect(await exists(client, plainChild.id)).toBe(true)
    },
  },
  {
    name: 'side effects: externalIds on managed object creation',
    verifies: ['create-external-ids'],
    async run({ client, unique }) {
      const created = await create(client, { name: `cei-${unique}`, externalIds: [{ type: 'cei_Serial', externalId: `cei-${unique}` }, { type: 'cei_Serial', externalId: `cei-${unique}` }] })
      expect(created.externalIds).toBeUndefined()
      expect((await read(client, created.id)).externalIds).toBeUndefined()
      const { body: ids } = await api(client, 'GET', `/identity/globalIds/${created.id}/externalIds`)
      expect(ids.externalIds.map((entry: any) => [entry.type, entry.externalId])).toEqual([['cei_Serial', `cei-${unique}`]])

      const duplicate = await api(client, 'POST', '/inventory/managedObjects', { name: `cei-dup-${unique}`, externalIds: [{ type: 'cei_Serial', externalId: `cei-${unique}` }] })
      expect(duplicate.status).toBe(409)
      expect(duplicate.body.error).toBe('identity/Duplicate')
      const missing = await api(client, 'POST', '/inventory/managedObjects', { name: `cei-bad-${unique}`, externalIds: [{ externalId: `cei-x-${unique}` }] })
      expect(missing.status).toBe(422)
      expect(missing.body.message).toBe('post.managedObjectRepresentation.externalIds[0].type: must not be empty')
      // nothing is created when an external id fails
      for (const name of [`cei-dup-${unique}`, `cei-bad-${unique}`]) {
        expect((await client.inventory.list({ query: `$filter=(name eq '${name}')` } as any)).data).toEqual([])
      }
    },
  },
  {
    name: 'side effects: availability fragments come from c8y_RequiredAvailability',
    verifies: ['availability-fragments'],
    async run({ client, unique }) {
      // values a client sends are dropped
      const plain = await create(client, { name: `av-plain-${unique}`, c8y_IsDevice: {}, c8y_Availability: { status: 'AVAILABLE' }, c8y_Connection: { status: 'CONNECTED' } })
      await api(client, 'PUT', `/inventory/managedObjects/${plain.id}`, { c8y_Availability: { status: 'UNAVAILABLE' } })
      const read1 = await read(client, plain.id)
      expect(read1.c8y_Availability).toBeUndefined()
      expect(read1.c8y_Connection).toBeUndefined()

      const monitored = await create(client, { name: `av-${unique}`, c8y_IsDevice: {}, c8y_RequiredAvailability: { responseInterval: 10 } })
      await eventually(async () => {
        const current = await read(client, monitored.id)
        expect(current.c8y_Availability).toEqual({ lastMessage: expect.any(String), status: 'AVAILABLE' })
        expect(current.c8y_Connection).toEqual({ status: 'DISCONNECTED' })
      })
      const maintenance = await create(client, { name: `av-m-${unique}`, c8y_IsDevice: {}, c8y_RequiredAvailability: { responseInterval: 0 } })
      await eventually(async () => {
        const current = await read(client, maintenance.id)
        expect(current.c8y_Availability.status).toBe('MAINTENANCE')
        expect(current.c8y_Connection).toEqual({ status: 'MAINTENANCE' })
      })

      const text = await api(client, 'PUT', `/inventory/managedObjects/${monitored.id}`, { c8y_RequiredAvailability: { responseInterval: '15' } })
      expect(text.status).toBe(400)
      expect(text.body.error).toBe('Device availability/Bad Request')
    },
  },
  {
    name: 'side effects: name length and measurement values are validated',
    verifies: ['managed-object-name-length', 'measurement-values-numeric'],
    async run({ client, unique }) {
      const name = `len-${unique}-`
      const longest = await api(client, 'POST', '/inventory/managedObjects', { name: name.padEnd(1000, 'x') })
      expect(longest.status).toBe(201)
      const tooLong = await api(client, 'POST', '/inventory/managedObjects', { name: name.padEnd(1001, 'x') })
      expect(tooLong.status).toBe(422)
      expect(tooLong.body.message).toBe('post.managedObjectRepresentation.name: exceeds maximum length of 1000')
      const update = await api(client, 'PUT', `/inventory/managedObjects/${longest.body.id}`, { name: name.padEnd(1001, 'x') })
      expect(update.status).toBe(422)
      expect(update.body.message).toBe('put.managedObjectRepresentation.name: exceeds maximum length of 1000')

      const measurement = await api(client, 'POST', '/measurement/measurements', { source: { id: longest.body.id }, type: `len-${unique}`, time: now(), len_T: { T: { value: '21.5', unit: 'C' } } })
      expect(measurement.status).toBe(422)
      expect(measurement.body.message).toBe('post.measurementRepresentation: Only numbers are supported as measurement values')
    },
  },
  {
    name: 'side effects: source names in measurements and single events',
    verifies: ['source-name-rendering'],
    async run({ client, unique }) {
      const device = await create(client, { name: `srn-${unique}`, c8y_IsDevice: {} })
      const source = { source: { id: device.id }, time: now(), type: `srn-${unique}` }
      const { body: event } = await api(client, 'POST', '/event/events', { ...source, text: 'e' })
      expect(event.source.name).toBe(device.name)
      await api(client, 'POST', '/measurement/measurements', { ...source, srn_T: { T: { value: 1 } } })
      expect((await api(client, 'GET', `/event/events/${event.id}`)).body.source.name).toBeUndefined()
      expect((await api(client, 'GET', `/event/events?source=${device.id}`)).body.events[0].source.name).toBe(device.name)
      expect((await api(client, 'GET', `/measurement/measurements?source=${device.id}`)).body.measurements[0].source.name).toBeUndefined()
    },
  },
  {
    name: 'side effects: deleting a group audits each member',
    verifies: ['group-delete-audit'],
    async run({ client, tenant, unique }) {
      const userName = `ev.se.${unique}`
      const groupName = `se-${unique}`
      let groupId: number | undefined
      try {
        const user = await api(client, 'POST', `/user/${tenant}/users`, { userName, email: `${userName}@example.com`, password: 'Contract-Pass-2026!x' })
        expect(user.status).toBe(201)
        const group = await api(client, 'POST', `/user/${tenant}/groups`, { name: groupName })
        groupId = group.body.id
        await api(client, 'POST', `/user/${tenant}/groups/${groupId}/users`, { user: { self: user.body.self } })
        expect((await api(client, 'DELETE', `/user/${tenant}/groups/${groupId}`)).status).toBe(204)
        groupId = undefined
        await eventually(async () => {
          const { body } = await api(client, 'GET', `/audit/auditRecords?type=User&source=${encodeURIComponent(userName)}&pageSize=20`)
          expect(body.auditRecords.map((record: any) => record.text)).toContain(`User ${userName} updated: global roles ['${groupName}'] removed`)
        })
        expect((await api(client, 'GET', `/user/${tenant}/users/${userName}`)).body.groups.references).toEqual([])
      } finally {
        if (groupId !== undefined) {
          await api(client, 'DELETE', `/user/${tenant}/groups/${groupId}`)
        }
        await api(client, 'DELETE', `/user/${tenant}/users/${userName}`)
      }
    },
  },
]
