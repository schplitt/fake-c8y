// Inventory hierarchy details, series of a device, and the count endpoints.
// Verified against a real tenant (eu-latest, 2026-11) through the REST API.
import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { eventually, time } from '../helpers'

type Json = Record<string, any>

async function api(client: Client, method: string, path: string, body?: unknown): Promise<{ status: number, body: any }> {
  const res = await client.core.fetch(path, { method, headers: { 'content-type': 'application/json', 'accept': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

async function getJson(client: Client, path: string): Promise<Json> {
  const { status, body } = await api(client, 'GET', path)
  expect(status, path).toBe(200)
  return body
}

const UNKNOWN_ID = '99999999999'
const MO = '/inventory/managedObjects'

const ids = (fragment: Json): string[] => fragment.references.map((reference: Json) => reference.managedObject.id)

export const inventoryDetailsScenarios: ContractScenario[] = [
  {
    name: 'inventory: child reference by id, and removing several children at once',
    verifies: ['child-reference-by-id', 'delete-children-all-or-nothing'],
    async run({ client, unique }) {
      const { data: parent } = await client.inventory.create({ name: `parent-${unique}` })
      const { data: child } = await client.inventory.create({ name: `child-${unique}`, type: `ct-${unique}` })
      const { data: other } = await client.inventory.create({ name: `other-${unique}` })
      const { data: grandchild } = await client.inventory.create({ name: `grandchild-${unique}` })
      await client.inventory.childAssetsAdd(child.id, parent.id)
      await client.inventory.childAssetsAdd(other.id, parent.id)
      await client.inventory.childDevicesAdd(grandchild.id, child.id)

      const reference = await getJson(client, `${MO}/${parent.id}/childAssets/${child.id}`)
      expect(reference.self).toMatch(new RegExp(`/inventory/managedObjects/${parent.id}/childAssets/${child.id}$`))
      expect(reference.managedObject).toMatchObject({ id: child.id, name: `child-${unique}`, type: `ct-${unique}` })
      // the child's own children come without names
      expect(reference.managedObject.childDevices.references.map((item: Json) => item.managedObject)).toEqual([{ self: expect.any(String), id: grandchild.id }])

      const notChild = await api(client, 'GET', `${MO}/${parent.id}/childDevices/${child.id}`)
      expect(notChild.status).toBe(422)
      expect(notChild.body).toMatchObject({ error: 'inventory/Invalid Data', message: `managedObject with id: ${child.id} is not a child of parent with id: ${parent.id}` })
      const unknownChild = await api(client, 'GET', `${MO}/${parent.id}/childAssets/${UNKNOWN_ID}`)
      expect(unknownChild.status).toBe(404)
      expect(unknownChild.body.message).toContain(`No managedObject for id '${UNKNOWN_ID}'`)
      const unknownParent = await api(client, 'GET', `${MO}/${UNKNOWN_ID}/childAssets/${child.id}`)
      expect(unknownParent.status).toBe(404)
      expect(unknownParent.body.message).toContain(`No managedObject for id '${UNKNOWN_ID}'`)

      // removing several: all or nothing, an empty list is a server error
      const references = (...children: string[]) => ({ references: children.map((id) => ({ managedObject: { id } })) })
      const stray = await api(client, 'DELETE', `${MO}/${parent.id}/childAssets`, references(child.id, grandchild.id))
      expect(stray.status).toBe(422)
      expect(stray.body.message).toBe(`managedObject with id: ${grandchild.id}, is not a child of object with id: ${parent.id} : Parent child relationship validation failed`)
      expect(ids((await getJson(client, `${MO}/${parent.id}`)).childAssets).sort()).toEqual([child.id, other.id].sort())
      expect((await api(client, 'DELETE', `${MO}/${parent.id}/childAssets`, references())).status).toBe(500)
      expect((await api(client, 'DELETE', `${MO}/${UNKNOWN_ID}/childAssets`, references(child.id))).status).toBe(404)
      expect((await api(client, 'DELETE', `${MO}/${parent.id}/childAssets`, references(child.id, other.id))).status).toBe(204)
      expect(ids((await getJson(client, `${MO}/${parent.id}`)).childAssets)).toEqual([])
      expect((await api(client, 'DELETE', `${MO}/${child.id}/childDevices`, references(grandchild.id))).status).toBe(204)
      expect((await api(client, 'DELETE', `${MO}/${child.id}/childAdditions`, references(grandchild.id))).status).toBe(422)
      for (const kind of ['childDevices', 'childAdditions']) {
        expect((await api(client, 'GET', `${MO}/${parent.id}/${kind}/${child.id}`)).status).toBe(422)
      }
    },
  },
  {
    name: 'inventory: withParents lists all ancestors, withGroups the direct groups, withChildrenCount',
    verifies: ['parents-only-with-parameter', 'with-parents-ancestors', 'with-groups-direct', 'with-children-count'],
    async run({ client, unique }) {
      const { data: root } = await client.inventory.create({ name: `root-${unique}`, type: 'c8y_DeviceGroup', c8y_IsDeviceGroup: {} } as any)
      const { data: group } = await client.inventory.create({ name: `group-${unique}`, type: 'c8y_DeviceSubgroup', c8y_IsDeviceGroup: {} } as any)
      const { data: asset } = await client.inventory.create({ name: `asset-${unique}`, type: `plain-${unique}` })
      const { data: gateway } = await client.inventory.create({ name: `gateway-${unique}`, type: `gw-${unique}`, c8y_IsDevice: {}, c8y_Extra: { a: 1 } } as any)
      const { data: sensor } = await client.inventory.create({ name: `sensor-${unique}`, c8y_IsDevice: {} } as any)
      await client.inventory.childAssetsAdd(group.id, root.id)
      await client.inventory.childAssetsAdd(gateway.id, group.id)
      await client.inventory.childAssetsAdd(gateway.id, asset.id)
      await client.inventory.childDevicesAdd(sensor.id, gateway.id)

      // all ancestors over every kind of link, each under the kind of the link below it
      const sensorDetail = await getJson(client, `${MO}/${sensor.id}?withParents=true`)
      expect(ids(sensorDetail.deviceParents)).toEqual([gateway.id])
      // the order of ancestors is not stable on the platform (two runs gave both orders)
      expect(ids(sensorDetail.assetParents).filter((id) => id !== asset.id).sort()).toEqual([root.id, group.id].sort())
      expect(ids(sensorDetail.assetParents).sort()).toEqual([root.id, group.id, asset.id].sort())
      expect(ids(sensorDetail.additionParents)).toEqual([])
      // parent references have no self link, and the parents only their basic fields
      expect(sensorDetail.deviceParents).toEqual({ references: [expect.any(Object)] })
      const listedGateway = sensorDetail.deviceParents.references[0].managedObject
      expect(Object.keys(listedGateway)).toEqual(['self', 'id', 'type', 'name', 'childDevices', 'childAssets', 'childAdditions', 'deviceParents', 'assetParents', 'additionParents'])
      expect(listedGateway).toMatchObject({ id: gateway.id, type: `gw-${unique}`, name: `gateway-${unique}`, childDevices: { references: [] }, deviceParents: { references: [] } })
      expect(Object.keys(sensorDetail).slice(0, 12)).toEqual(['self', 'id', 'type', 'name', 'lastUpdated', 'creationTime', 'owner', 'childDevices', 'childAssets', 'childAdditions', 'deviceParents', 'assetParents', 'additionParents'].filter((key) => key !== 'type'))

      // the list answers the same; withGroups adds the direct group parents (no type), not plain assets or ancestors
      const [listed] = (await getJson(client, `${MO}?ids=${sensor.id}&withParents=true`)).managedObjects
      expect(ids(listed.assetParents).sort()).toEqual([root.id, group.id, asset.id].sort())
      const [grouped] = (await getJson(client, `${MO}?ids=${gateway.id}&withGroups=true`)).managedObjects
      expect(ids(grouped.assetParents)).toEqual([group.id])
      expect(Object.keys(grouped.assetParents.references[0].managedObject)).toEqual(['self', 'id', 'name', 'childDevices', 'childAssets', 'childAdditions', 'deviceParents', 'assetParents', 'additionParents'])
      expect(ids(grouped.deviceParents)).toEqual([])
      const [sensorGroups] = (await getJson(client, `${MO}?ids=${sensor.id}&withGroups=true`)).managedObjects
      expect(ids(sensorGroups.assetParents)).toEqual([])
      // a group is a parent with a group type; the c8y_IsDeviceGroup fragment does not count
      const { data: typed } = await client.inventory.create({ name: `typed-${unique}`, type: 'c8y_DeviceGroup' } as any)
      const { data: flagged } = await client.inventory.create({ name: `flagged-${unique}`, type: `farm-${unique}`, c8y_IsDeviceGroup: {} } as any)
      const { data: leaf } = await client.inventory.create({ name: `leaf-${unique}` })
      for (const parent of [typed, flagged, group]) {
        await client.inventory.childAssetsAdd(leaf.id, parent.id)
      }
      const [leafGroups] = (await getJson(client, `${MO}?ids=${leaf.id}&withGroups=true`)).managedObjects
      expect(ids(leafGroups.assetParents).sort()).toEqual([typed.id, group.id].sort())
      // both: the ancestors (in no stable order, seen both ways), then the groups again
      const [both] = (await getJson(client, `${MO}?ids=${gateway.id}&withGroups=true&withParents=true`)).managedObjects
      const bothIds = ids(both.assetParents).filter((id) => id !== asset.id)
      expect(bothIds.slice(0, 2).sort()).toEqual([root.id, group.id].sort())
      expect(bothIds.slice(2)).toEqual([group.id])

      // withChildrenCount: a count for non-empty collections, also without the references
      const counted = await getJson(client, `${MO}/${gateway.id}?withChildrenCount=true&withChildren=false`)
      expect(counted.childDevices).toEqual({ self: expect.any(String), references: [], count: 1 })
      expect(counted.childAssets).not.toHaveProperty('count')
      expect((await getJson(client, `${MO}/${gateway.id}`)).childDevices).not.toHaveProperty('count')
      const [listedCount] = (await getJson(client, `${MO}?ids=${root.id}&withChildrenCount=true`)).managedObjects
      expect(listedCount.childAssets.count).toBe(1)
      const children = await getJson(client, `${MO}/${group.id}/childAssets?withChildrenCount=true`)
      expect(children.references[0].managedObject.childDevices.count).toBe(1)
    },
  },
  {
    name: 'inventory: supported series and measurements of a device, availability',
    verifies: ['supported-series-numeric', 'supported-series-after-delete', 'availability-not-in-cache', 'latest-values-ignored'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `series-${unique}`, c8y_IsDevice: {} } as any)
      const { data: empty } = await client.inventory.create({ name: `empty-${unique}`, c8y_IsDevice: {} } as any)
      const source = { id: device.id }
      const { data: first } = await client.measurement.create({ source, type: 'c8y_T', time: time(1), c8y_Temperature: { T: { value: 20, unit: 'C' } }, c8y_Humidity: { h: { value: 50 }, b: { value: 1 } } } as any)
      await client.measurement.create({ source, type: 'c8y_T', time: time(2), c8y_Temperature: { T: { value: 21, unit: 'C' }, A: { value: 3 } }, c8y_NoValue: { x: { unit: 'C' } }, c8y_Plain: 5 } as any)

      // only numeric `value` entries are series; the platform's order is unspecified
      await eventually(async () => {
        const { c8y_SupportedSeries: series } = await getJson(client, `${MO}/${device.id}/supportedSeries`)
        expect([...series].sort()).toEqual(['c8y_Humidity.b', 'c8y_Humidity.h', 'c8y_Temperature.A', 'c8y_Temperature.T'])
      })
      const { c8y_SupportedMeasurements: measurements } = await getJson(client, `${MO}/${device.id}/supportedMeasurements`)
      expect([...measurements].sort()).toEqual(['c8y_Humidity', 'c8y_Temperature'])
      // a series goes with the last of its measurements (the platform takes a few seconds)
      expect((await api(client, 'DELETE', `/measurement/measurements/${first.id}`)).status).toBe(204)
      await eventually(async () => {
        const { c8y_SupportedSeries: series } = await getJson(client, `${MO}/${device.id}/supportedSeries`)
        expect([...series].sort()).toEqual(['c8y_Temperature.A', 'c8y_Temperature.T'])
      }, 20000)
      expect((await getJson(client, `${MO}/${device.id}/supportedMeasurements`)).c8y_SupportedMeasurements).toEqual(['c8y_Temperature'])
      expect(await getJson(client, `${MO}/${empty.id}/supportedSeries`)).toEqual({ c8y_SupportedSeries: [] })
      expect(await getJson(client, `${MO}/${empty.id}/supportedMeasurements`)).toEqual({ c8y_SupportedMeasurements: [] })
      for (const kind of ['supportedSeries', 'supportedMeasurements']) {
        const unknown = await api(client, 'GET', `${MO}/${UNKNOWN_ID}/${kind}`)
        expect(unknown.status).toBe(404)
        expect(unknown.body).toMatchObject({ error: 'inventory/Not Found', message: `Finding device data from database failed : No managedObject for id '${UNKNOWN_ID}'!` })
      }

      // availability comes from a cache that REST data does not fill
      for (const id of [device.id, UNKNOWN_ID]) {
        const availability = await api(client, 'GET', `${MO}/${id}/availability`)
        expect(availability.status).toBe(404)
        expect(availability.body).toMatchObject({ error: 'availability/Not Found', message: `Availability for device with id ${id} not found in cache` })
      }

      // withLatestValues (a feature preview) is ignored
      expect(await getJson(client, `${MO}/${device.id}?withLatestValues=true`)).not.toHaveProperty('c8y_LatestMeasurements')
      const [listed] = (await getJson(client, `${MO}?ids=${device.id}&withLatestValues=true`)).managedObjects
      expect(listed).not.toHaveProperty('c8y_LatestMeasurements')
    },
  },
  {
    name: 'inventory: not with a function, a parenthesized expression, or another not',
    verifies: ['query-not-operand'],
    async run({ client, unique }) {
      const type = `not-${unique}`
      await client.inventory.create({ name: `a-${unique}`, type, c8y_IsDevice: {}, c8y_Position: {} } as any)
      await client.inventory.create({ name: `b-${unique}`, type, c8y_IsDevice: {} } as any)
      await client.inventory.create({ name: `c-${unique}`, type } as any)
      const names = async (filter: string) => (await client.inventory.list({ query: `$filter=(type eq '${type}' and ${filter})`, pageSize: 100 })).data.map((mo) => mo.name).sort()

      expect(await names('has(c8y_IsDevice) and not has(c8y_Position)')).toEqual([`b-${unique}`])
      expect(await names('not has(c8y_Position) and has(c8y_IsDevice)')).toEqual([`b-${unique}`])
      expect(await names('(not has(c8y_Position) or has(c8y_Position))')).toEqual([`a-${unique}`, `b-${unique}`, `c-${unique}`])
      expect(await names('not not has(c8y_Position)')).toEqual([`a-${unique}`])
      expect(await names('not (has(c8y_Position) or not has(c8y_IsDevice))')).toEqual([`b-${unique}`])
      expect(await names(`not (name eq 'c-${unique}')`)).toEqual([`a-${unique}`, `b-${unique}`])
      for (const filter of [`not name eq 'c-${unique}'`, 'has(c8y_IsDevice) and not', 'NOT has(c8y_IsDevice)']) {
        const rejected = await api(client, 'GET', `${MO}?${new URLSearchParams({ query: `$filter=(${filter})` })}`)
        expect(rejected.status, filter).toBe(422)
        expect(rejected.body.error).toBe('inventory/Invalid Data')
      }
    },
  },
  {
    name: 'counts: alarms and managed objects; other collections have no count',
    verifies: ['alarm-count-severity-list', 'with-source-without-source-422', 'count-endpoints'],
    async run({ client, unique }) {
      const { data: parent } = await client.inventory.create({ name: `cp-${unique}`, type: `cnt-${unique}`, c8y_IsDevice: {} } as any)
      const { data: child } = await client.inventory.create({ name: `cc-${unique}`, type: `cnt-${unique}`, c8y_IsDevice: {} } as any)
      await client.inventory.create({ name: `cx-${unique}`, type: `cnt-${unique}` })
      await client.inventory.childDevicesAdd(child.id, parent.id)
      const alarm = (source: string, type: string, severity: string) => client.alarm.create({ source: { id: source }, type: `${type}-${unique}`, text: type, severity, time: time(1) } as any)
      await alarm(parent.id, 'a', 'MAJOR')
      await alarm(parent.id, 'b', 'MINOR')
      const { data: cleared } = await alarm(child.id, 'c', 'MAJOR')
      await client.alarm.update({ id: cleared.id, status: 'CLEARED' } as any)

      const count = async (params: Record<string, string>) => {
        const { status, body } = await api(client, 'GET', `/alarm/alarms/count?${new URLSearchParams(params)}`)
        expect(status, JSON.stringify(params)).toBe(200)
        expect(typeof body).toBe('number')
        return body as number
      }
      await eventually(async () => {
        expect(await count({ source: parent.id })).toBe(2)
      })
      expect(await count({ source: parent.id, withSourceDevices: 'true' })).toBe(3)
      expect(await count({ source: parent.id, withSourceDevices: 'true', resolved: 'false' })).toBe(2)
      expect(await count({ source: parent.id, withSourceDevices: 'true', status: 'ACTIVE,CLEARED' })).toBe(3)
      expect(await count({ source: parent.id, severity: 'MAJOR' })).toBe(1)
      expect(await count({ source: parent.id, type: `a-${unique},b-${unique}` })).toBe(2)
      expect(await count({ source: parent.id, dateFrom: '2099-01-01' })).toBe(0)
      expect(await count({ source: UNKNOWN_ID })).toBe(0)
      // a list of severities counts nothing (the alarm list accepts it)
      expect(await count({ source: parent.id, severity: 'MAJOR,MINOR' })).toBe(0)
      expect((await client.alarm.list({ source: parent.id, severity: 'MAJOR,MINOR' } as any)).data).toHaveLength(2)
      expect((await client.alarm.count({ source: parent.id } as any)).data).toBe(2)

      const unknownSource = await api(client, 'GET', `/alarm/alarms/count?source=${UNKNOWN_ID}&withSourceAssets=true`)
      expect(unknownSource.status).toBe(404)
      for (const path of ['/alarm/alarms/count?withSourceAssets=true', '/alarm/alarms?withSourceDevices=true', '/event/events?withSourceChildren=true']) {
        const missing = await api(client, 'GET', path)
        expect(missing.status, path).toBe(422)
        const kind = path.startsWith('/event') ? 'events' : 'alarms'
        expect(missing.body).toMatchObject({ error: `${kind === 'events' ? 'event' : 'alarm'}/Invalid Data`, message: `Cannot fetch children ${kind} if parameter 'source' is not specified!` })
      }
      expect((await api(client, 'GET', `/alarm/alarms/count?dateFrom=yesterday`)).status).toBe(422)

      // managed objects: undocumented, the list filters apply (as @c8y/client's inventory.count sends them)
      await eventually(async () => {
        expect((await client.inventory.count({ type: `cnt-${unique}` })).data).toBe(3)
      })
      // verified: count ignores `query` (and `q`, `onlyRoots`), so `type` still applies next to it
      expect((await client.inventory.count({ type: `cnt-${unique}`, query: `$filter=(has(c8y_IsDevice))` })).data).toBe(3)
      expect((await client.inventory.count({ type: `cnt-${unique}`, fragmentType: 'c8y_IsDevice' })).data).toBe(2)
      expect((await client.inventory.count({ text: `cx-${unique}` } as any)).data).toBeGreaterThanOrEqual(1)

      // events and operations read "count" as an id, measurements cannot be read by id
      const event = await api(client, 'GET', '/event/events/count')
      expect(event).toMatchObject({ status: 404, body: { error: 'event/Not Found', message: `Finding device data from database failed : No event for gid 'count'!` } })
      const operation = await api(client, 'GET', '/devicecontrol/operations/count')
      expect(operation).toMatchObject({ status: 404, body: { error: 'devicecontrol/Not Found', message: `Finding device data from database failed : No operation for gid 'count'!` } })
      const measurement = await api(client, 'GET', '/measurement/measurements/count')
      expect(measurement).toMatchObject({ status: 405, body: { error: 'measurement/Method Not Allowed', message: 'Find by id is not supported by time series measurements!' } })
    },
  },
  {
    name: 'inventory: the owner of a managed object as its user (read only)',
    verifies: ['managed-object-user'],
    async run({ client, unique }) {
      // never PUT here: on a real tenant it disables the owner, which is the caller
      const me = (await getJson(client, '/user/currentUser')).userName
      const { data: own } = await client.inventory.create({ name: `owned-${unique}` })
      const mine = await getJson(client, `${MO}/${own.id}/user?withParents=true`)
      expect(mine).toMatchObject({ userName: me, enabled: true, customProperties: expect.any(Object) })
      expect(mine.self).toMatch(new RegExp(`/inventory/managedObjects/${own.id}/user$`))
      expect(Object.keys(mine)).toEqual(['userName', 'enabled', 'self', 'customProperties'])
      // an owner that is no user of the tenant
      const { data: foreign } = await client.inventory.create({ name: `foreign-${unique}`, owner: `ghost-${unique}` } as any)
      const ghost = await api(client, 'GET', `${MO}/${foreign.id}/user`)
      expect(ghost).toMatchObject({ status: 404, body: { error: 'users/Not Found', message: `Error retrieving user ghost-${unique}! : Cannot find document with ID ghost-${unique}` } })
      // PUT is only sent to the fake (a reserved `.test` host): on a real tenant
      // it changes a real user, and the probing account must not be touched
      if (new URL((client.core as unknown as { baseUrl: string }).baseUrl).hostname.endsWith('.test')) {
        const put = await api(client, 'PUT', `${MO}/${own.id}/user`, { enabled: true })
        expect(put).toMatchObject({ status: 200, body: { userName: me, enabled: true } })
      }
      const unknown = await api(client, 'GET', `${MO}/${UNKNOWN_ID}/user`)
      expect(unknown).toMatchObject({ status: 404, body: { error: 'inventory/Not Found', message: `Finding device data from database failed : No managedObject for id '${UNKNOWN_ID}'!` } })
    },
  },
]
