// Availability monitoring by the world's clock (src/availability.ts): the
// platform needs minutes of real time for this, so the contract scenarios
// cannot check it; the timing is in docs/platform-behavior.md.
import { describe, expect, it } from 'vitest'
import { createClock, createWorld } from '../../src'

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

const START = '2026-01-01T10:00:10.000Z'
const MINUTE = 60_000

function setup() {
  const clock = createClock({ start: START, realtime: false })
  const world = createWorld({ clock })
  return { clock, world }
}

async function monitored(world: World, interval = 5) {
  const created = await call(world, 'POST', '/inventory/managedObjects', { name: 'Meter', c8y_IsDevice: {}, c8y_RequiredAvailability: { responseInterval: interval } })
  return created.body.id as string
}

const availability = (world: World, id: string) => world.db.managedObjects.get(id)?.c8y_Availability
const alarms = (world: World, id: string) => world.db.alarms.find({ source: id })

describe('availability by the clock', () => {
  it('turns UNAVAILABLE at the first full minute after the interval and raises the alarm after twice the interval', async () => {
    const { world } = setup()
    const id = await monitored(world)
    world.advance(5 * MINUTE + 49_000)
    expect(availability(world, id)).toEqual({ lastMessage: START, status: 'AVAILABLE' })
    world.advance(1000)
    expect(availability(world, id)).toEqual({ lastMessage: START, status: 'UNAVAILABLE' })
    expect(alarms(world, id)).toEqual([])
    world.advance(4 * MINUTE + 9000)
    expect(alarms(world, id)).toEqual([])
    world.advance(1000)
    expect(alarms(world, id)).toMatchObject([{ type: 'c8y_UnavailabilityAlarm', severity: 'MAJOR', status: 'ACTIVE', count: 1, time: '2026-01-01T10:10:10.000Z', text: 'No data received from device within required interval.' }])
    expect(world.db.managedObjects.get(id)?.c8y_ActiveAlarmsStatus).toEqual({ critical: 0, major: 1, minor: 0, warning: 0 })
    // the connection fragment does not change
    expect(world.db.managedObjects.get(id)?.c8y_Connection).toEqual({ status: 'DISCONNECTED' })
  })

  it('switches at the due time after a long clock jump', async () => {
    const { world } = setup()
    const id = await monitored(world)
    world.advance(24 * 60 * MINUTE)
    expect(availability(world, id)?.status).toBe('UNAVAILABLE')
    expect(alarms(world, id)).toMatchObject([{ time: '2026-01-01T10:10:10.000Z', count: 1 }])
  })

  it('stays available while data arrives, and data clears the alarm', async () => {
    const { clock, world } = setup()
    const id = await monitored(world)
    world.advance(4 * MINUTE)
    await call(world, 'POST', '/measurement/measurements', { source: { id }, type: 't', time: new Date(clock.now()).toISOString(), t: { v: { value: 1 } } })
    world.advance(4 * MINUTE)
    expect(availability(world, id)?.status).toBe('AVAILABLE')
    world.advance(10 * MINUTE)
    expect(availability(world, id)?.status).toBe('UNAVAILABLE')

    await call(world, 'POST', '/event/events', { source: { id }, type: 'e', text: 'back', time: new Date(clock.now()).toISOString() })
    expect(availability(world, id)).toEqual({ lastMessage: new Date(clock.now()).toISOString(), status: 'AVAILABLE' })
    expect(alarms(world, id)).toMatchObject([{ type: 'c8y_UnavailabilityAlarm', status: 'CLEARED' }])
    expect(world.db.managedObjects.get(id)?.c8y_ActiveAlarmsStatus).toEqual({ critical: 0, major: 0, minor: 0, warning: 0 })

    // a second outage raises a new alarm
    world.advance(10 * MINUTE)
    expect(alarms(world, id).map((alarm) => alarm.status)).toEqual(['CLEARED', 'ACTIVE'])
  })

  it('raises no alarm when data comes between the switch and the alarm', async () => {
    const { clock, world } = setup()
    const id = await monitored(world)
    world.advance(7 * MINUTE)
    expect(availability(world, id)?.status).toBe('UNAVAILABLE')
    await call(world, 'POST', '/measurement/measurements', { source: { id }, type: 't', time: '2020-01-01T00:00:00Z', t: { v: { value: 1 } } })
    // the time of the request counts, not the measurement's
    expect(availability(world, id)).toEqual({ lastMessage: new Date(clock.now()).toISOString(), status: 'AVAILABLE' })
    world.advance(5 * MINUTE)
    expect(alarms(world, id)).toEqual([])
  })

  it('does not count updates and upserts as data', async () => {
    const { world } = setup()
    const id = await monitored(world)
    const alarm = await call(world, 'POST', '/alarm/alarms', { source: { id }, type: 'x', text: 'x', severity: 'MINOR', time: START })
    const event = await call(world, 'POST', '/event/events', { source: { id }, type: 'x', text: 'x', time: START })
    world.advance(4 * MINUTE)
    await call(world, 'PUT', `/alarm/alarms/${alarm.body.id}`, { status: 'ACKNOWLEDGED' })
    await call(world, 'PUT', `/event/events/${event.body.id}`, { text: 'y' })
    await call(world, 'PUT', `/inventory/managedObjects/${id}`, { c8y_Other: {} })
    await call(world, 'POST', '/alarm/alarms/upsert', { source: { id }, type: 'up' })
    expect(availability(world, id)?.lastMessage).toBe(START)
    world.advance(2 * MINUTE)
    expect(availability(world, id)?.status).toBe('UNAVAILABLE')
  })

  it('counts an update of the device without changes as data', async () => {
    const { clock, world } = setup()
    world.advance(MINUTE)
    // creating the device sets lastMessage
    const id = await monitored(world)
    expect(availability(world, id)).toEqual({ lastMessage: new Date(clock.now()).toISOString(), status: 'AVAILABLE' })
    world.advance(4 * MINUTE)
    await call(world, 'PUT', `/inventory/managedObjects/${id}`, {})
    expect(availability(world, id)?.lastMessage).toBe(new Date(clock.now()).toISOString())
    world.advance(10 * MINUTE)
    expect(availability(world, id)?.status).toBe('UNAVAILABLE')
    await call(world, 'PUT', `/inventory/managedObjects/${id}`, { id })
    expect(availability(world, id)).toEqual({ lastMessage: new Date(clock.now()).toISOString(), status: 'AVAILABLE' })
    expect(alarms(world, id)).toMatchObject([{ type: 'c8y_UnavailabilityAlarm', status: 'CLEARED' }])
  })

  it('does not count operations as data', async () => {
    const { world } = setup()
    const id = await monitored(world)
    await call(world, 'PUT', `/inventory/managedObjects/${id}`, { com_cumulocity_model_Agent: {} })
    world.advance(4 * MINUTE)
    const operation = await call(world, 'POST', '/devicecontrol/operations', { deviceId: id, description: 'restart', c8y_Restart: {} })
    expect(operation.status).toBe(201)
    await call(world, 'PUT', `/devicecontrol/operations/${operation.body.id}`, { status: 'EXECUTING' })
    await call(world, 'PUT', `/devicecontrol/operations/${operation.body.id}`, { status: 'SUCCESSFUL' })
    expect(availability(world, id)?.lastMessage).toBe(START)
  })

  it('does not count requests with an application key as data', async () => {
    const { clock, world } = setup()
    const id = await monitored(world)
    world.advance(4 * MINUTE)
    const sent = await world.fetch(new Request(`${world.baseUrl}/measurement/measurements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json', 'x-cumulocity-application-key': 'key' },
      body: JSON.stringify({ source: { id }, type: 't', time: new Date(clock.now()).toISOString(), t: { v: { value: 1 } } }),
    }))
    expect(sent.status).toBe(201)
    expect(availability(world, id)?.lastMessage).toBe(START)
  })

  it('stops for maintenance and for removed monitoring', async () => {
    const { world } = setup()
    const maintenance = await monitored(world)
    const removed = await monitored(world)
    await call(world, 'PUT', `/inventory/managedObjects/${maintenance}`, { c8y_RequiredAvailability: { responseInterval: 0 } })
    await call(world, 'PUT', `/inventory/managedObjects/${removed}`, { c8y_RequiredAvailability: null })
    world.advance(60 * MINUTE)
    expect(availability(world, maintenance)?.status).toBe('MAINTENANCE')
    expect(availability(world, removed)).toBeUndefined()
    expect(world.db.alarms.find()).toEqual([])
  })

  it('monitors seeded devices from their lastMessage', () => {
    const { world } = setup()
    const seeded = world.device({ c8y_RequiredAvailability: { responseInterval: 10 }, c8y_Availability: { status: 'AVAILABLE', lastMessage: '2026-01-01T10:00:00.000Z' } })
    world.advance(10 * MINUTE)
    expect(availability(world, seeded)?.status).toBe('AVAILABLE')
    world.advance(MINUTE)
    expect(availability(world, seeded)?.status).toBe('UNAVAILABLE')
  })

  it('works on forks: the base is unchanged and forks are independent', async () => {
    const { world: base } = setup()
    const id = await monitored(base)
    const a = base.fork()
    const b = base.fork()
    a.advance(10 * MINUTE)
    expect(availability(a, id)?.status).toBe('UNAVAILABLE')
    expect(availability(b, id)?.status).toBe('AVAILABLE')
    expect(availability(base, id)?.status).toBe('AVAILABLE')
    expect(a.diff().tenants[a.tenant]!.alarms.created).toHaveLength(1)
    expect(b.diff().tenants[b.tenant]?.alarms.created ?? []).toHaveLength(0)
    // a write on a fork moves the due time there only
    b.advance(4 * MINUTE)
    await call(b, 'POST', '/alarm/alarms', { source: { id }, type: 'x', text: 'x', severity: 'MINOR', time: START })
    b.advance(10 * MINUTE)
    expect(availability(b, id)?.status).toBe('UNAVAILABLE')
    expect(alarms(b, id).map((alarm) => alarm.time)).toContain('2026-01-01T10:14:10.000Z')
  })

  it('counts generated measurements as data, with gaps', () => {
    const { world } = setup()
    const id = world.device({ c8y_RequiredAvailability: { responseInterval: 5 }, c8y_Availability: { status: 'AVAILABLE', lastMessage: START } })
    world.seed({ measurementGenerators: [{ source: id, type: 't', from: '2026-01-01T09:00:00Z', interval: '1m', series: [{ fragment: 't', series: 'v', value: 1 }], gaps: [{ from: '2026-01-01T11:00:00Z', to: '2026-01-01T12:00:00Z' }] }] })
    world.advance(30 * MINUTE)
    expect(availability(world, id)).toEqual({ lastMessage: '2026-01-01T10:30:00.000Z', status: 'AVAILABLE' })
    world.advance(60 * MINUTE)
    // last point 10:59, unavailable at 11:05
    expect(availability(world, id)).toEqual({ lastMessage: '2026-01-01T10:59:00.000Z', status: 'UNAVAILABLE' })
    world.advance(60 * MINUTE)
    // back with the point at 12:00
    expect(availability(world, id)).toEqual({ lastMessage: '2026-01-01T12:30:00.000Z', status: 'AVAILABLE' })
    expect(alarms(world, id)).toMatchObject([{ status: 'CLEARED', time: '2026-01-01T11:09:00.000Z', lastUpdated: '2026-01-01T12:00:00.000Z' }])
  })

  it('looks at a device with a running generator once per run, not per point', () => {
    const { world } = setup()
    const devices = Array.from({ length: 5000 }, () => world.device({ c8y_RequiredAvailability: { responseInterval: 5 }, c8y_Availability: { status: 'AVAILABLE', lastMessage: START } }))
    world.seed({ measurementGenerators: devices.map((source) => ({ source, type: 't', from: '2026-01-01T09:00:00Z', interval: '1m', series: [{ fragment: 't', series: 'v', value: 1 }] })) })
    const fork = world.fork()
    const started = performance.now()
    for (let day = 0; day < 30; day++) {
      fork.advance(24 * 60 * MINUTE)
    }
    expect(performance.now() - started).toBeLessThan(500)
    expect(fork.db.alarms.find()).toEqual([])
    expect(availability(fork, devices[0]!)?.status).toBe('AVAILABLE')
  })

  it('is cheap for many devices', () => {
    const { world } = setup()
    for (let index = 0; index < 18_000; index++) {
      world.device({ c8y_RequiredAvailability: { responseInterval: 5 + (index % 60) }, c8y_Availability: { status: 'AVAILABLE', lastMessage: START } })
    }
    const base = world
    const fork = base.fork()
    const started = performance.now()
    for (let index = 0; index < 100; index++) {
      fork.tick()
    }
    expect(performance.now() - started).toBeLessThan(50)
    fork.advance(30 * MINUTE)
    // switched: intervals 5 to 29 minutes; alarms: 5 to 15 minutes
    expect(fork.db.managedObjects.find((document) => document.c8y_Availability?.status === 'UNAVAILABLE')).toHaveLength(18_000 * 25 / 60)
    expect(fork.db.alarms.find()).toHaveLength(18_000 * 11 / 60)
  })
})

describe('availability: determinism and consistency', () => {
  const T0 = Date.parse(START)
  const iso = (time: number) => new Date(time).toISOString()

  it('evaluates devices due at the same time in the same order on a plain world and a fork', () => {
    const build = () => {
      const world = createWorld({ clock: createClock({ start: START, realtime: false }) })
      const ids = Array.from({ length: 6 }, (_, index) => world.device({ name: `D${index}`, c8y_RequiredAvailability: { responseInterval: 1 } }))
      return { world, ids }
    }
    const order = (world: World, ids: string[]) => world.db.alarms.find().map((alarm) => `${ids.indexOf(alarm.source.id)}:${alarm.id}`)
    const plain = build()
    plain.world.advance(5 * MINUTE)
    const forked = build()
    const fork = forked.world.fork()
    fork.advance(5 * MINUTE)
    expect(order(fork, forked.ids)).toEqual(order(plain.world, plain.ids))
  })

  it('keeps c8y_ActiveAlarmsStatus when the alarm is raised and cleared in one tick, and the state does not depend on the tick cadence', () => {
    const world = createWorld({ clock: createClock({ start: START, realtime: false }) })
    const id = world.device({ name: 'G', c8y_RequiredAvailability: { responseInterval: 5 } })
    world.seed({ measurementGenerators: [{ source: id, type: 'c8y_T', from: START, interval: '1m', series: [{ fragment: 'c8y_T', series: 'T', value: 1, gaps: [{ from: iso(T0 + 10 * MINUTE), to: iso(T0 + 40 * MINUTE) }] }] }] })
    const once = world.fork()
    once.advance(60 * MINUTE)
    const stepwise = world.fork()
    for (let minute = 0; minute < 60; minute++) {
      stepwise.advance(MINUTE)
    }
    for (const fork of [once, stepwise]) {
      expect(fork.db.managedObjects.get(id)).toMatchObject({ c8y_ActiveAlarmsStatus: { critical: 0, major: 0, minor: 0, warning: 0 }, c8y_Availability: { status: 'AVAILABLE', lastMessage: iso(T0 + 60 * MINUTE) } })
      expect(alarms(fork, id)).toMatchObject([{ status: 'CLEARED' }])
    }
    expect(stepwise.diff()).toEqual(once.diff())
  })

  it('shows the last generated point as lastMessage without storing it on every look', () => {
    const world = createWorld({ clock: createClock({ start: START, realtime: false }) })
    const id = world.device({ name: 'G', c8y_RequiredAvailability: { responseInterval: 5 }, c8y_Availability: { status: 'AVAILABLE', lastMessage: START } })
    world.seed({ measurementGenerators: [{ source: id, type: 'c8y_T', from: iso(T0 - 60 * MINUTE), interval: '1m', series: [{ fragment: 'c8y_T', series: 'T', value: 1 }] }] })
    const once = world.fork()
    once.advance(60 * MINUTE)
    const stepwise = world.fork()
    for (let minute = 0; minute < 60; minute++) {
      stepwise.advance(MINUTE)
    }
    for (const fork of [once, stepwise]) {
      expect(availability(fork, id)).toEqual({ status: 'AVAILABLE', lastMessage: iso(T0 + 60 * MINUTE) })
      expect(fork.diff().tenants).toEqual({})
    }
  })

  it('raises an alarm still to come in a restored snapshot', async () => {
    const clock = createClock({ start: START, realtime: false })
    const world = createWorld({ clock })
    const id = await monitored(world, 10)
    // UNAVAILABLE at 10:11, the alarm at 10:20:10
    world.advance(12 * MINUTE)
    const snapshot = JSON.parse(JSON.stringify(world.snapshot()))
    const restored = createWorld({ clock: createClock({ start: clock.now(), realtime: false }) })
    restored.restore(snapshot)
    world.advance(10 * MINUTE)
    restored.advance(10 * MINUTE)
    expect(alarms(restored, id)).toEqual(alarms(world, id))
    expect(alarms(world, id)).toHaveLength(1)
  })

  it('clears every open unavailability alarm on data, raising picks the earliest', async () => {
    const { world } = setup()
    const id = await monitored(world, 5)
    world.advance(11 * MINUTE)
    const [monitor] = alarms(world, id)
    await call(world, 'PUT', `/inventory/managedObjects/${id}`, {})
    expect(world.db.alarms.get(monitor!.id)!.status).toBe('CLEARED')
    // a second open one, stored later but with an earlier time
    const manual = (await call(world, 'POST', '/alarm/alarms', { source: { id }, type: 'c8y_UnavailabilityAlarm', text: 'manual', severity: 'MAJOR', time: '2026-01-01T09:00:00.000Z' })).body
    await call(world, 'PUT', `/alarm/alarms/${monitor!.id}`, { status: 'ACTIVE' })
    // UNAVAILABLE again, and its alarm deduplicates into the earliest open one
    world.advance(11 * MINUTE)
    expect(availability(world, id)?.status).toBe('UNAVAILABLE')
    expect([world.db.alarms.get(manual.id)!.count, world.db.alarms.get(monitor!.id)!.count]).toEqual([2, 1])
    await call(world, 'POST', '/event/events', { source: { id }, type: 'e', text: 'e', time: START })
    expect(world.db.alarms.get(manual.id)!.status).toBe('CLEARED')
    expect(world.db.alarms.get(monitor!.id)!.status).toBe('CLEARED')
    expect(world.db.managedObjects.get(id)?.c8y_ActiveAlarmsStatus).toEqual({ critical: 0, major: 0, minor: 0, warning: 0 })
  })

  it('brings seeded devices up to the clock on the first tick, as the docs say', () => {
    const { world } = setup()
    const old = '2026-01-01T08:00:00.000Z'
    const recent = '2026-01-01T09:55:00.000Z'
    const stale = world.device({ c8y_RequiredAvailability: { responseInterval: 10 }, c8y_Availability: { status: 'AVAILABLE', lastMessage: old } })
    const longGone = world.device({ c8y_RequiredAvailability: { responseInterval: 10 }, c8y_Availability: { status: 'UNAVAILABLE', lastMessage: old } })
    const justGone = world.device({ c8y_RequiredAvailability: { responseInterval: 10 }, c8y_Availability: { status: 'UNAVAILABLE', lastMessage: recent } })
    // the first db access ticks: an old lastMessage turns AVAILABLE into UNAVAILABLE with the alarm at once
    expect(availability(world, stale)).toEqual({ status: 'UNAVAILABLE', lastMessage: old })
    expect(alarms(world, stale)).toMatchObject([{ type: 'c8y_UnavailabilityAlarm', time: '2026-01-01T08:20:00.000Z' }])
    expect(world.db.auditRecords.find()).toMatchObject([{ activity: 'Alarm created', source: { id: alarms(world, stale)[0]!.id } }])
    // seeded UNAVAILABLE: no alarm when it is overdue, the alarm when it is still to come
    expect(alarms(world, longGone)).toEqual([])
    expect(alarms(world, justGone)).toEqual([])
    world.advance(15 * MINUTE)
    expect(alarms(world, longGone)).toEqual([])
    expect(alarms(world, justGone)).toMatchObject([{ time: '2026-01-01T10:15:00.000Z' }])
  })

  it('gives a device seeded with c8y_RequiredAvailability only the connection fragment too', () => {
    const { world } = setup()
    const id = world.device({ c8y_RequiredAvailability: { responseInterval: 5 } })
    world.advance(6 * MINUTE)
    expect(world.db.managedObjects.get(id)).toMatchObject({ c8y_Availability: { status: 'UNAVAILABLE', lastMessage: START }, c8y_Connection: { status: 'DISCONNECTED' } })
  })

  it('answers 422 for a duplicate of an alarm stored with a time beyond 9999', async () => {
    const { world } = setup()
    const id = world.device({ name: 'd' })
    expect((await call(world, 'POST', '/alarm/alarms', { source: { id }, type: 'far', text: 't', severity: 'MINOR', time: '12345-01-01T00:00:00Z' })).status).toBe(201)
    const duplicate = await call(world, 'POST', '/alarm/alarms', { source: { id }, type: 'far', text: 't', severity: 'MINOR', time: START })
    expect([duplicate.status, duplicate.body.message]).toEqual([422, 'Error updating duplicate alarm! : Failed to parse string as a date'])
  })
})
