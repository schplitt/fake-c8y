// Usage statistics: seeded history, what a trial's requests add, device
// counts from the inventory, forks, and reset.
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'

type World = ReturnType<typeof createWorld>

async function call(world: World, method: string, path: string, body?: unknown) {
  const res = await world.fetch(new Request(`${world.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

async function today(world: World) {
  // oldest first: today is the last day
  const list = await call(world, 'GET', '/tenant/statistics?pageSize=2000')
  return list.body.usageStatistics.at(-1)
}

describe('usage statistics', () => {
  it('counts the requests of the trial on top of the seeded day', async () => {
    const world = createWorld({ now: () => Date.parse('2026-11-07T10:00:00Z') })
    world.seed({ usageStatistics: [{ day: '2026-11-07', requestCount: 100, measurementsCreatedCount: 10, storageSize: 5000 }] })
    const device = await call(world, 'POST', '/inventory/managedObjects', { name: 'Pump', c8y_IsDevice: {} })
    await world.fetch(new Request(`${world.baseUrl}/measurement/measurements`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.com.nsn.cumulocity.measurementcollection+json', 'accept': 'application/json' },
      body: JSON.stringify({ measurements: [1, 2].map((value) => ({ source: { id: device.body.id }, type: 'm', time: '2026-11-07T09:00:00Z', m: { v: { value } } })) }),
    }))
    await call(world, 'POST', '/event/events', { source: { id: device.body.id }, type: 'e', text: 'e', time: '2026-11-07T09:00:00Z' })
    // a failed write adds a request, not a document
    await call(world, 'POST', '/event/events', { type: 'e' })
    const day = await today(world)
    expect(day).toMatchObject({
      day: '2026-11-07T00:00:00.000Z',
      requestCount: 100 + world.calls.length - 1,
      inventoriesCreatedCount: 1,
      eventsCreatedCount: 1,
      measurementsCreatedCount: 12,
      deviceCount: 1,
      storageSize: 5000,
    })
  })

  it('leaves out requests that never reach a platform API', async () => {
    const world = createWorld({ now: () => Date.parse('2026-11-07T10:00:00Z') })
    // the core's fallback: a double slash on the tenant API, a first segment that only starts like an API
    expect((await call(world, 'GET', '//tenant/currentTenant')).status).toBe(404)
    expect((await call(world, 'GET', '/users')).status).toBe(404)
    // outside the spec
    expect((await call(world, 'GET', '/nope')).status).toBe(501)
    // a double slash the inventory accepts is a normal request
    expect((await call(world, 'POST', '//inventory/managedObjects', { name: 'Pump', c8y_IsDevice: {} })).status).toBe(201)
    // a wrong method is answered by the API
    expect((await call(world, 'GET', '/identity/search')).status).toBe(405)
    const day = await today(world)
    // the two requests above that reached an API, and the statistics request itself is not counted yet
    expect(day).toMatchObject({ requestCount: 2, inventoriesCreatedCount: 1 })
  })

  it('buckets requests by the day of the trial clock', async () => {
    let now = Date.parse('2026-11-06T23:59:00Z')
    const world = createWorld({ now: () => now })
    await call(world, 'GET', '/inventory/managedObjects')
    now = Date.parse('2026-11-07T00:01:00Z')
    await call(world, 'GET', '/inventory/managedObjects')
    const days = (await call(world, 'GET', '/tenant/statistics?dateFrom=2026-11-01&dateTo=2026-11-07')).body.usageStatistics
    expect(days.map((day: any) => [day.day.slice(0, 10), day.requestCount])).toEqual([['2026-11-06', 1], ['2026-11-07', 1]])
  })

  it('a fork counts its own requests and devices, reset clears them', async () => {
    const base = createWorld({ now: () => Date.parse('2026-11-07T10:00:00Z') })
    for (let i = 0; i < 3; i++) {
      base.device({ name: `d${i}` })
    }
    base.seed({ usageStatistics: [{ day: '2026-11-07', requestCount: 50 }] })
    const fork = base.fork()
    expect(await today(fork)).toMatchObject({ requestCount: 50, deviceCount: 3 })
    await call(fork, 'POST', '/inventory/managedObjects', { name: 'new', c8y_IsDevice: {} })
    expect(await today(fork)).toMatchObject({ requestCount: 52, deviceCount: 4, inventoriesCreatedCount: 1 })

    const other = base.fork()
    expect(await today(other)).toMatchObject({ requestCount: 50, deviceCount: 3, inventoriesCreatedCount: 0 })

    fork.reset()
    expect(await today(fork)).toMatchObject({ requestCount: 50, deviceCount: 3 })
  })

  it('counts devices with their child devices and devices without children', async () => {
    const world = createWorld()
    const gateway = world.device({ name: 'Gateway' })
    const child = world.managedObject({ name: 'Child' })
    world.device({ name: 'Single' })
    await call(world, 'POST', `/inventory/managedObjects/${gateway}/childDevices`, { managedObject: { id: child } })
    expect(await today(world)).toMatchObject({ deviceCount: 2, deviceWithChildrenCount: 3, deviceEndpointCount: 1 })
  })

  it('fills the days between the first one and today, summary sums the range', async () => {
    const world = createWorld({ now: () => Date.parse('2026-11-07T10:00:00Z') })
    world.seed({ usageStatistics: [
      { day: '2026-11-03', requestCount: 10, alarmsCreatedCount: 2, operationsCreatedCount: 5, deviceCount: 7, storageSize: 100, resources: { cpu: 1000, memory: 512, usedBy: [{ name: 'svc', cpu: 1000, memory: 512, cause: 'Owner' }] }, subscribedApplications: ['cockpit'] },
      { day: '2026-11-05', requestCount: 20, deviceCount: 8, storageSize: 200, resources: { cpu: 500, memory: 256, usedBy: [{ name: 'svc', cpu: 500, memory: 256, cause: 'Owner' }] }, subscribedApplications: ['cockpit', 'devicemanagement'] },
    ] })
    const days = (await call(world, 'GET', '/tenant/statistics?pageSize=100')).body.usageStatistics
    expect(days.map((day: any) => [day.day.slice(0, 10), day.requestCount, day.deviceCount, day.storageSize])).toEqual([
      ['2026-11-03', 10, 7, 100],
      ['2026-11-04', 0, 7, 100],
      ['2026-11-05', 20, 8, 200],
      ['2026-11-06', 0, 8, 200],
      // the request being answered is not counted yet
      ['2026-11-07', 0, 0, 200],
    ])
    // operations are not part of the total
    expect(days[0].totalResourceCreateAndUpdateCount).toBe(2)

    const summary = (await call(world, 'GET', '/tenant/statistics/summary?dateFrom=2026-11-03&dateTo=2026-11-05')).body
    expect(summary).toMatchObject({ requestCount: 30, alarmsCreatedCount: 2, storageSize: 200, deviceCount: 8, subscribedApplications: ['cockpit', 'devicemanagement'], storageLimitPerDevice: 0, day: '2026-11-07T00:00:00.000Z' })
    expect(summary.resources).toEqual({ cpu: 1500, memory: 768, usedBy: [{ name: 'svc', cpu: 1500, memory: 768, cause: 'Owner' }] })
    const empty = (await call(world, 'GET', '/tenant/statistics/summary?dateFrom=2020-01-01&dateTo=2020-01-02')).body
    expect(empty).not.toHaveProperty('resources')
    expect(empty.requestCount).toBe(0)
  })

  it('device statistics show a day once it is over', async () => {
    let now = Date.parse('2026-11-07T10:00:00Z')
    const world = createWorld({ now: () => now })
    const pump = world.device({ name: 'Pump', type: 'nhv_Pump' })
    const sensor = world.device({ name: 'Sensor' })
    await call(world, 'POST', `/inventory/managedObjects/${pump}/childDevices`, { managedObject: { id: sensor } })
    world.seed({ usageStatistics: [{ day: '2026-10-02', devices: { [pump]: 4, [sensor]: 1 } }] })
    await call(world, 'POST', '/event/events', { source: { id: pump }, type: 'e', text: 'e', time: '2026-11-07T09:00:00Z' })
    const path = `/tenant/statistics/device/${world.tenant}`
    expect((await call(world, 'GET', `${path}/daily/2026-11-07`)).body.statistics).toEqual([])
    now = Date.parse('2026-11-08T00:00:01Z')
    expect((await call(world, 'GET', `${path}/daily/2026-11-07?pageSize=1`)).body.statistics).toEqual([{ deviceId: pump, count: 1 }])
    const monthly = (await call(world, 'GET', `${path}/monthly/2026-10-15`)).body
    expect(monthly.statistics).toEqual([{ deviceId: pump, count: 4, deviceType: 'nhv_Pump' }, { deviceId: sensor, count: 1, deviceParents: [pump] }])
    expect((await call(world, 'GET', `${path}/monthly/2026-11-01`)).body.statistics).toEqual([])
    expect((await call(world, 'GET', `${path}/monthly/2026-10-01?currentPage=2`)).body.statistics).toEqual([])
    expect((await call(world, 'GET', `/tenant/statistics/device/other/daily/2026-11-07`)).status).toBe(403)
  })

  it('keeps seeded days in snapshots and diffs', () => {
    const world = createWorld()
    const before = world.snapshot()
    world.seed({ usageStatistics: [{ day: '2026-10-01', requestCount: 7 }] })
    const snapshot = world.snapshot()
    expect(snapshot.tenants[0]!.usageStatistics).toEqual([{ day: '2026-10-01', counters: { requestCount: 7 } }])
    expect(world.diff(before).tenants[world.tenant]!.usageStatistics.created).toHaveLength(1)
    world.reset()
    world.restore(snapshot)
    expect(world.snapshot().tenants[0]!.usageStatistics).toEqual(snapshot.tenants[0]!.usageStatistics)
  })

  it('rejects invalid seeds', () => {
    const world = createWorld()
    expect(() => world.seed({ usageStatistics: [{ day: 'yesterday' }] })).toThrow(/invalid usage statistics day/)
    expect(() => world.seed({ usageStatistics: [{ day: '2026-10-01', requestCount: -1 }] })).toThrow(/non-negative integer/)
    expect(() => world.seed({ usageStatistics: [{ day: '2026-10-01', bogus: 1 } as never] })).toThrow(/unknown usage statistics counter/)
  })

  it('starts the requests over with restore(): a snapshot does not carry them', async () => {
    const world = createWorld({ now: () => Date.parse('2026-11-07T10:00:00Z') })
    const device = await call(world, 'POST', '/inventory/managedObjects', { name: 'Pump', c8y_IsDevice: {} })
    const before = world.snapshot()
    for (let i = 0; i < 5; i++) {
      await call(world, 'POST', '/event/events', { source: { id: device.body.id }, type: 'e', text: 'e', time: '2026-11-07T09:00:00Z' })
    }
    world.restore(before)
    const summary = (await call(world, 'GET', '/tenant/statistics/summary?dateFrom=2026-11-07')).body
    expect(summary).toMatchObject({ eventsCreatedCount: 0, requestCount: 0 })
    expect(world.db.events.find()).toEqual([])
  })
})
