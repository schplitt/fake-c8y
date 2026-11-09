/**
 * Availability monitoring driven by the world's clock: a device with
 * `c8y_RequiredAvailability` turns UNAVAILABLE when no data arrived for its
 * `responseInterval`, gets a `c8y_UnavailabilityAlarm`, and turns AVAILABLE
 * again (the alarm cleared) when data arrives.
 *
 * Cost: every request ticks the world, so a tick must be O(1) when nothing is
 * due. Each tenant keeps a due-time queue (`AvailabilityQueue`) of devices to
 * look at again: a sorted array shared with forks (built when the world
 * freezes) plus a heap of the world's own entries. Entries are hints: a due
 * device is evaluated from its stored state, so a stale entry costs one look.
 */
import type { StoredDocument, TenantData } from './store'
import type { MeasurementStream } from './generators'
import { lastPointTime, nextPointTime, runEndTime } from './generators'
import { sourceId } from './api/http'
import { activeAlarmsOf, alarmsBySource, publishAlarm } from './api/data'
import { auditAlarmCreated, auditAlarmUpdated } from './api/audit'
import { renderManagedObject } from './api/inventory'
import { parseIsoTime } from './utils'

/**
 * Type, severity, and text of the alarm the platform raises (verified).
 */
export const UNAVAILABILITY_ALARM = { type: 'c8y_UnavailabilityAlarm', severity: 'MAJOR', text: 'No data received from device within required interval.' }

/**
 * When a device without data turns UNAVAILABLE. On the platform the switch
 * came 5:18 to 6:00 minutes after the last data for a 5 minute interval
 * (1:14 to 2:10 for 1 minute); the fake takes the first full minute after
 * `lastMessage + responseInterval`.
 * @param lastMessage - Epoch milliseconds of the last data
 * @param interval - `responseInterval` in minutes
 */
export function unavailableAt(lastMessage: number, interval: number): number {
  return Math.floor((lastMessage + interval * 60_000) / 60_000) * 60_000 + 60_000
}

/**
 * When the unavailability alarm of a device that went UNAVAILABLE comes. The
 * platform raises it in a later run (seen 8.5 to 10 minutes after the last
 * data for 5 minutes, together with the switch for 1 minute); the fake takes
 * twice the interval, at the earliest with the switch.
 * @param lastMessage - Epoch milliseconds of the last data
 * @param interval - `responseInterval` in minutes
 */
export function unavailabilityAlarmAt(lastMessage: number, interval: number): number {
  return Math.max(unavailableAt(lastMessage, interval), lastMessage + 2 * interval * 60_000)
}

/**
 * The monitored interval of a managed object in minutes (`undefined`: not
 * monitored or in maintenance).
 * @param document - Managed object
 */
function monitoredInterval(document: Readonly<StoredDocument> | undefined): number | undefined {
  const interval = (document?.c8y_RequiredAvailability as { responseInterval?: unknown } | undefined)?.responseInterval
  return typeof interval === 'number' && interval > 0 ? interval : undefined
}

function lastMessageOf(document: Readonly<StoredDocument>): number {
  const time = parseIsoTime((document.c8y_Availability as { lastMessage?: unknown } | undefined)?.lastMessage)
  return Number.isNaN(time) ? parseIsoTime(document.creationTime) : time
}

const generatorSource = (stream: MeasurementStream): string => stream.sourceId

/**
 * Schedules a look at a device after a write that changed its availability
 * fragments or its data (a no-op for objects without monitoring).
 * @param data - Tenant data
 * @param id - Managed object id
 */
export function scheduleAvailability(data: TenantData, id: string): void {
  const document = data.managedObjects.get(id)
  const interval = monitoredInterval(document)
  if (!data.availability.built) {
    return
  }
  if (interval === undefined) {
    data.availability.schedule(id, Number.POSITIVE_INFINITY)
    return
  }
  const status = (document!.c8y_Availability as { status?: unknown } | undefined)?.status
  // an unavailable device without generators waits for data (a write schedules it)
  if (status === 'UNAVAILABLE' && data.measurementGenerators.size === 0) {
    data.availability.schedule(id, Number.POSITIVE_INFINITY)
    return
  }
  data.availability.schedule(id, status === 'UNAVAILABLE' ? Number.NEGATIVE_INFINITY : unavailableAt(lastMessageOf(document!), interval))
}

/**
 * Builds a tenant's queue by scanning its managed objects (once per new or
 * restored tenant).
 * @param data - Tenant data
 */
function build(data: TenantData): void {
  data.availability.built = true
  const now = parseIsoTime(data.world.now())
  let alarms: ((source: string) => readonly string[]) | undefined
  for (const document of data.managedObjects.values()) {
    const interval = monitoredInterval(document)
    if (interval === undefined) {
      continue
    }
    scheduleAvailability(data, document.id)
    // a device that went UNAVAILABLE by the clock and whose alarm is still to
    // come (a restored snapshot taken in between) gets it; one seeded
    // UNAVAILABLE long ago gets none
    const alarmAt = unavailabilityAlarmAt(lastMessageOf(document), interval)
    if ((document.c8y_Availability as { status?: unknown } | undefined)?.status === 'UNAVAILABLE' && alarmAt > now) {
      alarms ??= alarmsBySource(data)
      if (!openUnavailabilityAlarm(data, document.id, alarms(document.id))) {
        data.availability.schedule(document.id, alarmAt, true)
      }
    }
  }
}

/**
 * Applies the availability changes that are due by the world's clock: the
 * tick of `world.tick()`.
 * @param data - Tenant data
 */
export function advanceAvailability(data: TenantData): void {
  const queue = data.availability
  if (!queue.built) {
    build(data)
  }
  const now = parseIsoTime(data.world.now())
  let entry = queue.next(now)
  if (entry === undefined) {
    return
  }
  const alarms = alarmsBySource(data)
  const streams = data.measurementGenerators.size > 0 ? data.measurementGenerators.groupedBy(generatorSource) : undefined
  while (entry !== undefined) {
    const { id } = entry
    evaluate(data, id, now, entry.alarm, alarms(id), streams ? streams(id).map((key) => data.measurementGenerators.get(key)!) : [])
    entry = queue.next(now)
  }
}

/**
 * Brings one device up to `now`: generated measurements count as data at
 * their grid times. A switch to UNAVAILABLE by the clock is followed by the
 * unavailability alarm (`unavailabilityAlarmAt()`) unless data comes first;
 * data clears it. A device that was UNAVAILABLE already (seeded) gets no
 * alarm. Schedules the next look.
 * @param data - Tenant data
 * @param id - Managed object id
 * @param now - Epoch milliseconds
 * @param alarmPending - Whether the device's alarm is still to come
 * @param alarmIds - Ids of the device's alarms
 * @param streams - The device's measurement generators
 */
function evaluate(data: TenantData, id: string, now: number, alarmPending: boolean, alarmIds: readonly string[], streams: readonly MeasurementStream[]): void {
  const document = data.managedObjects.get(id)
  const interval = monitoredInterval(document)
  if (!document || interval === undefined) {
    return
  }
  const ownAlarms = [...alarmIds]
  // the first generated point after `time` (by now, or also later points)
  const nextGenerated = (time: number, until = now): number | undefined => {
    let next: number | undefined
    for (const stream of streams) {
      const point = nextPointTime(stream, time)
      if (point !== undefined && point <= until && (next === undefined || point < next)) {
        next = point
      }
    }
    return next
  }
  // the last point of the runs of generated points that have one at `time`
  const runEnd = (time: number): number => {
    let end = time
    for (const stream of streams) {
      if (nextPointTime(stream, time - 1) === time) {
        end = Math.max(end, runEndTime(stream, time))
      }
    }
    return end
  }
  let status = (document.c8y_Availability as { status?: unknown } | undefined)?.status
  let last = lastMessageOf(document)
  let pending = alarmPending
  for (let step = 0; step < 10_000; step++) {
    if (status !== 'UNAVAILABLE') {
      // generated data keeps the device available while it comes within the
      // interval: jump over whole runs of points, also future ones, so a
      // running generator costs one look per run
      let reach = last
      for (let point = nextGenerated(reach, Number.POSITIVE_INFINITY); point !== undefined && point <= unavailableAt(reach, interval); point = nextGenerated(reach, Number.POSITIVE_INFINITY)) {
        reach = runEnd(point)
      }
      const due = unavailableAt(reach, interval)
      if (due > now) {
        // only a switch is stored: generated points move `lastMessage` in
        // renders (`renderedAvailability()`), so the stored state does not
        // depend on how often the clock was advanced
        if (status !== 'AVAILABLE') {
          write(data, id, { lastMessage: new Date(last).toISOString(), status: 'AVAILABLE' })
        }
        data.availability.schedule(id, due)
        return
      }
      last = reach
      status = 'UNAVAILABLE'
      pending = true
      write(data, id, { lastMessage: new Date(last).toISOString(), status: 'UNAVAILABLE' })
      continue
    }
    const point = nextGenerated(last)
    const alarmAt = unavailabilityAlarmAt(last, interval)
    if (pending && alarmAt <= now && (point === undefined || point > alarmAt)) {
      raiseUnavailabilityAlarm(data, id, alarmAt, ownAlarms)
      pending = false
    }
    if (point === undefined) {
      // waits for data: a write, a later generated point, or the alarm schedules it
      const later = streams.map((stream) => nextPointTime(stream, now)).filter((time) => time !== undefined)
      data.availability.schedule(id, Math.min(pending ? alarmAt : Number.POSITIVE_INFINITY, ...later), pending)
      return
    }
    status = 'AVAILABLE'
    pending = false
    last = point
    write(data, id, { lastMessage: new Date(last).toISOString(), status: 'AVAILABLE' })
    clearUnavailabilityAlarm(data, id, point, ownAlarms)
  }
}

/**
 * Stores a device's new availability. Based on the stored document, since
 * alarm writes in between change it too (`c8y_ActiveAlarmsStatus`). A device
 * seeded without the fragments also gets `c8y_Connection`, like one created
 * through the API.
 * @param data - Tenant data
 * @param id - Managed object id
 * @param availability - The new `c8y_Availability`
 * @param availability.lastMessage
 * @param availability.status
 */
function write(data: TenantData, id: string, availability: { lastMessage: string, status: string }): void {
  const current = data.managedObjects.get(id)!
  const updated: StoredDocument = { ...current, c8y_Availability: availability }
  if (current.c8y_Connection === undefined) {
    updated.c8y_Connection = { status: 'DISCONNECTED' }
  }
  data.managedObjects.set(id, updated)
  data.world.notify(data, 'managedobjects', 'UPDATE', renderManagedObject(data, updated), id)
}

/**
 * The open unavailability alarm of a device: the one with the earliest
 * `time`, like the deduplication of `POST /alarm/alarms` picks it.
 * @param data - Tenant data
 * @param source - Device id
 * @param alarmIds - The device's alarm ids
 */
function openUnavailabilityAlarm(data: TenantData, source: string, alarmIds: readonly string[]): Readonly<StoredDocument> | undefined {
  let found: Readonly<StoredDocument> | undefined
  for (const alarmId of alarmIds) {
    const alarm = data.alarms.get(alarmId)
    if (alarm && alarm.type === UNAVAILABILITY_ALARM.type && alarm.status !== 'CLEARED' && sourceId(alarm) === source && (!found || parseIsoTime(alarm.time) < parseIsoTime(found.time))) {
      found = alarm
    }
  }
  return found
}

const lastPointCache = new WeakMap<object, { version: number, index: (source: string) => readonly string[] }>()

/**
 * `c8y_Availability` as the API shows it: for a device fed by measurement
 * generators, `lastMessage` is its last generated point by now when that is
 * later than the stored one (the monitor stores only switches, so the stored
 * state does not depend on how often the clock moved).
 * @param data - Tenant data
 * @param document - Stored managed object
 */
export function renderedAvailability(data: TenantData, document: Readonly<StoredDocument>): unknown {
  const availability = document.c8y_Availability as { lastMessage?: unknown } | undefined
  if (!availability || data.measurementGenerators.size === 0) {
    return availability
  }
  const generators = data.measurementGenerators
  let cached = lastPointCache.get(generators)
  if (!cached || cached.version !== generators.version) {
    cached = { version: generators.version, index: generators.groupedBy(generatorSource) }
    lastPointCache.set(generators, cached)
  }
  const keys = cached.index(document.id)
  if (keys.length === 0) {
    return availability
  }
  const now = parseIsoTime(data.world.now())
  const last = Math.max(...keys.map((key) => lastPointTime(generators.get(key)!, now)))
  return last > lastMessageOf(document) ? { ...availability, lastMessage: new Date(last).toISOString() } : availability
}

/**
 * Runs `operation` with the world's clock at `time` (the time a switch
 * happened, which can be before now after a clock jump).
 * @param data - Tenant data
 * @param time - Epoch milliseconds
 * @param operation - The writes
 */
function at<T>(data: TenantData, time: number, operation: () => T): T {
  const { world } = data
  const clock = world.now
  const iso = new Date(time).toISOString()
  world.now = () => iso
  try {
    return operation()
  } finally {
    world.now = clock
  }
}

/**
 * Raises the unavailability alarm of a device (deduplicated into an open one).
 * @param data - Tenant data
 * @param source - Device id
 * @param time - Time of the switch
 * @param alarmIds - The device's alarm ids, updated with a new alarm
 */
function raiseUnavailabilityAlarm(data: TenantData, source: string, time: number, alarmIds: string[]): void {
  at(data, time, () => {
    const now = data.world.now()
    const open = openUnavailabilityAlarm(data, source, alarmIds)
    if (open) {
      const updated = { ...open, firstOccurrenceTime: open.firstOccurrenceTime ?? open.time, count: (open.count as number) + 1, time: now, lastUpdated: now }
      data.alarms.set(open.id, updated)
      publishAlarm(data, 'UPDATE', updated)
      return
    }
    const alarm: StoredDocument = { ...UNAVAILABILITY_ALARM, status: 'ACTIVE', time: now, id: data.world.newId(), creationTime: now, lastUpdated: now, count: 1, source: { id: source } }
    data.alarms.set(alarm.id, alarm)
    alarmIds.push(alarm.id)
    activeAlarmsOf(data, source, alarmIds)
    // verified: audited without a user
    auditAlarmCreated(data, alarm, true)
    publishAlarm(data, 'CREATE', alarm)
  })
}

/**
 * Clears the open unavailability alarms of a device. A device can have
 * several (a cleared one set ACTIVE again); data clears them all (verified),
 * while raising picks the earliest (`openUnavailabilityAlarm()`).
 * @param data - Tenant data
 * @param source - Device id
 * @param time - Time the data arrived
 * @param alarmIds - The device's alarm ids (`undefined`: look them up)
 */
export function clearUnavailabilityAlarm(data: TenantData, source: string, time: number, alarmIds?: readonly string[]): void {
  const ids = [...(alarmIds ?? alarmsBySource(data)(source))]
  const open = ids.map((id) => data.alarms.get(id)).filter((alarm): alarm is Readonly<StoredDocument> => alarm !== undefined && alarm.type === UNAVAILABILITY_ALARM.type && alarm.status !== 'CLEARED' && sourceId(alarm) === source)
  if (open.length === 0) {
    return
  }
  at(data, time, () => {
    for (const alarm of open) {
      const updated = { ...alarm, status: 'CLEARED', lastUpdated: data.world.now() }
      data.alarms.set(alarm.id, updated)
      activeAlarmsOf(data, source, ids)
      auditAlarmUpdated(data, alarm as StoredDocument, updated, false, true)
      publishAlarm(data, 'UPDATE', updated)
    }
  })
}
