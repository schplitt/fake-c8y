/**
 * Tenant usage statistics: `GET /tenant/statistics`, `/summary`,
 * `/allTenantsSummary`, `/device/{tenantId}/daily|monthly/{date}`, and the
 * statistics files.
 *
 * A day's numbers come from three places:
 * - seeded days (`seed({ usageStatistics })`, `TenantData.usageStatistics`):
 *   history a world brings along, kept in snapshots and diffs;
 * - the world's usage log (`UsageLog`): what the requests since the last
 *   reset did, counted by day of the trial clock (a fork starts with an
 *   empty log, so its numbers show its own activity on top of the seeds);
 * - the inventory: the device counts of today (and of the days of the log)
 *   are counted from the managed objects.
 */
import type { C8yRequest } from '../types'
import type { StoredDocument, TenantData } from '../store'
import type { Collection } from '../collection'
import { apiError, checkQuery, paged, parsePlatformDate } from './http'
import { ERROR_INFO } from './media'
import { parentIndex } from './inventory'

/**
 * Counters of a day that requests add to.
 */
export const REQUEST_COUNTERS = [
  'requestCount',
  'deviceRequestCount',
  'measurementsCreatedCount',
  'eventsCreatedCount',
  'eventsUpdatedCount',
  'alarmsCreatedCount',
  'alarmsUpdatedCount',
  'inventoriesCreatedCount',
  'inventoriesUpdatedCount',
  'operationsCreatedCount',
  'operationsUpdatedCount',
] as const

export type RequestCounter = typeof REQUEST_COUNTERS[number]

/**
 * Counters taken from the inventory.
 */
export const DEVICE_COUNTERS = ['deviceCount', 'deviceWithChildrenCount', 'deviceEndpointCount'] as const

export type DeviceCounter = typeof DEVICE_COUNTERS[number]

/**
 * Resource usage of the tenant's microservices.
 */
export interface UsageResources {
  cpu: number
  memory: number
  usedBy: Array<{ name: string, cpu: number, memory: number, cause?: string }>
}

/**
 * A seeded day of usage statistics, as stored in `TenantData.usageStatistics`
 * (keyed by `day`).
 */
export interface StoredUsageDay {
  /**
   * The day, `YYYY-MM-DD` (UTC).
   */
  day: string
  counters: Partial<Record<RequestCounter | DeviceCounter, number>>
  /**
   * Database storage in bytes.
   */
  storageSize?: number
  resources?: UsageResources
  subscribedApplications?: string[]
  /**
   * Per device: measurements, events, and alarms created and updated that day.
   */
  devices?: Record<string, number>
}

/**
 * Input of a seeded day: `day` as `YYYY-MM-DD` (or any time on that UTC day),
 * the counters as top-level numbers.
 */
export interface C8yUsageStatisticsInput extends Partial<Record<RequestCounter | DeviceCounter, number>> {
  day: string
  storageSize?: number
  resources?: UsageResources
  subscribedApplications?: string[]
  /**
   * Per device id: measurements, events, and alarms created and updated that day.
   */
  devices?: Record<string, number>
}

/**
 * What the requests of one day did, per tenant.
 */
interface LiveDay {
  counters: Record<RequestCounter, number>
  devices: Map<string, number>
}

/**
 * The requests' contribution to the statistics, per tenant and day, since the
 * last reset. Lives next to the world's call log (`world.calls`), not in the
 * tenant data, so it never shows in a diff.
 */
export class UsageLog {
  readonly #days = new Map<string, Map<string, LiveDay>>()

  /**
   * The days of a tenant with requests, by `YYYY-MM-DD`.
   * @param tenant - Tenant id
   */
  days(tenant: string): ReadonlyMap<string, LiveDay> {
    return this.#days.get(tenant) ?? new Map()
  }

  /**
   * Counts an answered request.
   * @param call - The request
   * @param status - Status of the answer
   * @param time - Time of the answer (epoch milliseconds)
   * @param data - Tenant data of the request (after the answer)
   */
  record(call: C8yRequest, status: number, time: number, data: TenantData | undefined): void {
    const day = dayOf(time)
    let tenant = this.#days.get(call.tenant)
    if (!tenant) {
      tenant = new Map()
      this.#days.set(call.tenant, tenant)
    }
    let live = tenant.get(day)
    if (!live) {
      live = { counters: Object.fromEntries(REQUEST_COUNTERS.map((name) => [name, 0])) as Record<RequestCounter, number>, devices: new Map() }
      tenant.set(day, live)
    }
    countRequest(live, call, status, data)
  }
}

/**
 * The UTC day of a time, `YYYY-MM-DD`.
 * @param time - Epoch milliseconds
 */
export function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

const DEVICE_USER = /^device_/
const NOT_DEVICE_TRAFFIC = new Set(['user', 'tenant', 'application'])

function countRequest(live: LiveDay, call: C8yRequest, status: number, data: TenantData | undefined): void {
  const { counters } = live
  counters.requestCount++
  const [domain, resource, id, sub] = call.path.split('/').slice(1)
  if (call.user !== undefined && DEVICE_USER.test(call.user) && !NOT_DEVICE_TRAFFIC.has(domain ?? '')) {
    counters.deviceRequestCount++
  }
  if (status < 200 || status >= 300) {
    return
  }
  const body = (call.body ?? {}) as Record<string, unknown>
  const device = (source: unknown, count = 1) => {
    const sourceId = (source as { id?: unknown } | undefined)?.id
    if (sourceId !== undefined) {
      live.devices.set(String(sourceId), (live.devices.get(String(sourceId)) ?? 0) + count)
    }
  }
  const stored = (collection: 'events' | 'alarms', documentId: string) => data?.[collection].get(documentId) as StoredDocument | undefined
  const route = `${call.method} ${domain}/${resource}${id === undefined ? '' : '/{id}'}${sub === undefined ? '' : `/${sub}`}`
  switch (route) {
    case 'POST measurement/measurements': {
      const collection = /measurementcollection/i.test(call.headers['content-type'] ?? '') && Array.isArray(body.measurements)
      const items = collection ? body.measurements as Array<Record<string, unknown>> : [body]
      counters.measurementsCreatedCount += items.length
      for (const item of items) {
        device(item.source)
      }
      break
    }
    case 'POST event/events':
      counters.eventsCreatedCount++
      device(body.source)
      break
    case 'PUT event/events/{id}':
      counters.eventsUpdatedCount++
      device(stored('events', id!)?.source)
      break
    case 'POST alarm/alarms':
      counters.alarmsCreatedCount++
      device(body.source)
      break
    case 'PUT alarm/alarms/{id}':
      counters.alarmsUpdatedCount++
      device(stored('alarms', id!)?.source)
      break
    case 'POST inventory/managedObjects':
    case 'POST inventory/binaries':
      counters.inventoriesCreatedCount++
      break
    case 'PUT inventory/managedObjects/{id}':
      counters.inventoriesUpdatedCount++
      break
    case 'POST devicecontrol/operations':
      counters.operationsCreatedCount++
      break
    case 'PUT devicecontrol/operations/{id}':
      counters.operationsUpdatedCount++
      break
    default:
      break
  }
}

/**
 * Device counts of the inventory.
 */
type DeviceCounts = Record<DeviceCounter, number>

/**
 * Device counts by managed objects collection, with the versions of the
 * managed objects and the child references they were counted at. A frozen
 * base counts once; forks that did not change the inventory use the base's
 * counts, other forks count again after a write.
 */
const countCache = new WeakMap<object, { objects: number, children: number, counts: DeviceCounts }>()

/**
 * The device counts of a tenant's inventory: devices (`c8y_IsDevice`),
 * devices with their child devices, and devices without child devices.
 * @param data - Tenant data
 */
export function deviceCounts(data: TenantData): DeviceCounts {
  let objects = data.managedObjects
  let children = data.children
  if (objects.base && children.base && objects.pristine && children.pristine) {
    objects = objects.base
    children = children.base
  }
  const cached = countCache.get(objects)
  if (cached && cached.objects === objects.version && cached.children === children.version) {
    return cached.counts
  }
  const counts = countDevices(objects, children)
  countCache.set(objects, { objects: objects.version, children: children.version, counts })
  return counts
}

const deviceGroup = (document: StoredDocument): string | undefined => (document.c8y_IsDevice !== undefined ? 'device' : undefined)

function countDevices(objects: Collection<StoredDocument>, children: TenantData['children']): DeviceCounts {
  const devices = objects.groupedBy(deviceGroup)('device')
  let withChildren = 0
  let endpoints = 0
  const seen = new Set<string>()
  for (const id of devices) {
    const childDevices = children.get(id)?.childDevices ?? []
    if (childDevices.length === 0) {
      endpoints++
    }
    // the device and its child devices, each counted once
    const queue = [id]
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]!
      if (seen.has(next) || !objects.has(next)) {
        continue
      }
      seen.add(next)
      withChildren++
      queue.push(...(children.get(next)?.childDevices ?? []))
    }
  }
  return { deviceCount: devices.length, deviceWithChildrenCount: withChildren, deviceEndpointCount: endpoints }
}

/**
 * Stores seeded days of usage statistics.
 * @param data - Tenant data
 * @param days - Seed input
 */
export function seedUsageStatistics(data: TenantData, days: readonly C8yUsageStatisticsInput[]): void {
  for (const input of days) {
    const { day, storageSize, resources, subscribedApplications, devices, ...counters } = input
    const time = parsePlatformDate(day)
    if (Number.isNaN(time)) {
      throw new TypeError(`seed(): invalid usage statistics day: ${day}`)
    }
    for (const [name, value] of Object.entries(counters)) {
      if (!(REQUEST_COUNTERS as readonly string[]).includes(name) && !(DEVICE_COUNTERS as readonly string[]).includes(name)) {
        throw new TypeError(`seed(): unknown usage statistics counter: ${name}`)
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new TypeError(`seed(): usage statistics counter ${name} must be a non-negative integer`)
      }
    }
    const key = dayOf(time)
    data.usageStatistics.set(key, {
      day: key,
      counters: { ...counters },
      ...(storageSize !== undefined ? { storageSize } : {}),
      ...(resources !== undefined ? { resources: { ...resources, usedBy: resources.usedBy.map((item) => ({ ...item })) } } : {}),
      ...(subscribedApplications !== undefined ? { subscribedApplications: [...subscribedApplications] } : {}),
      ...(devices !== undefined ? { devices: { ...devices } } : {}),
    })
  }
}

/**
 * A day's statistics, all counters filled in.
 */
interface UsageDay extends Record<RequestCounter | DeviceCounter, number> {
  day: string
  storageSize: number
  resources: UsageResources | undefined
  subscribedApplications: string[]
}

const EMPTY_RESOURCES: UsageResources = { cpu: 0, memory: 0, usedBy: [] }

/**
 * Seeded days in day order, then the days with requests (a list per request,
 * the tenant's seeds rarely change).
 */
class TenantUsage {
  readonly data: TenantData
  readonly today: string
  readonly days: string[]
  readonly #seeded: Array<Readonly<StoredUsageDay>>
  readonly #live: ReadonlyMap<string, LiveDay>

  constructor(data: TenantData, today: string) {
    this.data = data
    this.today = today
    this.#seeded = [...data.usageStatistics.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    this.#live = data.world.usage().days(data.tenant)
    // verified: every day from the tenant's first one up to today, also days
    // without any activity
    const known = [...this.#seeded.map((day) => day.day), ...this.#live.keys(), today].sort()
    this.days = known.length > 0 ? daysBetween(known[0]!, known.at(-1)!) : []
  }

  /**
   * The latest seeded day on or before a day.
   * @param day - `YYYY-MM-DD`
   */
  #lastSeeded(day: string): Readonly<StoredUsageDay> | undefined {
    let low = 0
    let high = this.#seeded.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (this.#seeded[middle]!.day <= day) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    return low > 0 ? this.#seeded[low - 1] : undefined
  }

  /**
   * A day's statistics: seeded counters plus what the requests of the trial
   * added. The device counts of today and of the trial's days come from the
   * inventory; days without a seed carry the device counts, storage, and
   * applications of the last seeded day.
   * @param day - `YYYY-MM-DD`
   */
  usage(day: string): UsageDay {
    const carried = this.#lastSeeded(day)
    const seeded = carried?.day === day ? carried : undefined
    const live = this.#live.get(day)
    const counters = {} as Record<RequestCounter | DeviceCounter, number>
    for (const name of REQUEST_COUNTERS) {
      counters[name] = (seeded?.counters[name] ?? 0) + (live?.counters[name] ?? 0)
    }
    const devices = day === this.today || (live !== undefined && seeded?.counters.deviceCount === undefined) ? deviceCounts(this.data) : undefined
    for (const name of DEVICE_COUNTERS) {
      counters[name] = devices?.[name] ?? carried?.counters[name] ?? 0
    }
    return {
      day,
      ...counters,
      storageSize: carried?.storageSize ?? 0,
      resources: seeded?.resources,
      subscribedApplications: [...carried?.subscribedApplications ?? []],
    }
  }

  /**
   * Created and updated documents per device on the given days, in order of
   * first appearance.
   * @param days - `YYYY-MM-DD` days
   */
  devices(days: readonly string[]): Map<string, number> {
    const result = new Map<string, number>()
    const add = (id: string, count: number) => result.set(id, (result.get(id) ?? 0) + count)
    for (const day of days) {
      const seeded = this.data.usageStatistics.get(day)
      for (const [id, count] of Object.entries(seeded?.devices ?? {})) {
        add(id, count)
      }
      for (const [id, count] of this.#live.get(day)?.devices ?? []) {
        add(id, count)
      }
    }
    return result
  }
}

/**
 * The days from `first` to `last`, both included.
 * @param first - `YYYY-MM-DD`
 * @param last - `YYYY-MM-DD`
 */
function daysBetween(first: string, last: string): string[] {
  const days: string[] = []
  for (let time = Date.parse(`${first}T00:00:00Z`); time <= Date.parse(`${last}T00:00:00Z`); time += 86_400_000) {
    days.push(dayOf(time))
  }
  return days
}

/**
 * Verified: the created and updated alarms, events, and managed objects and
 * the created measurements; operations do not count.
 * @param usage - A day or a summary
 */
function totalResources(usage: Record<RequestCounter, number>): number {
  return usage.alarmsCreatedCount + usage.alarmsUpdatedCount + usage.eventsCreatedCount + usage.eventsUpdatedCount + usage.inventoriesCreatedCount + usage.inventoriesUpdatedCount + usage.measurementsCreatedCount
}

function copyResources(resources: UsageResources): UsageResources {
  return { cpu: resources.cpu, memory: resources.memory, usedBy: resources.usedBy.map((item) => ({ ...item })) }
}

/**
 * Request counters in the platform's key order (verified).
 * @param usage - A day or a summary
 */
function requestCounters(usage: Record<RequestCounter, number>): Record<string, number> {
  return {
    deviceRequestCount: usage.deviceRequestCount,
    requestCount: usage.requestCount,
    alarmsCreatedCount: usage.alarmsCreatedCount,
    alarmsUpdatedCount: usage.alarmsUpdatedCount,
    eventsCreatedCount: usage.eventsCreatedCount,
    eventsUpdatedCount: usage.eventsUpdatedCount,
    inventoriesCreatedCount: usage.inventoriesCreatedCount,
    inventoriesUpdatedCount: usage.inventoriesUpdatedCount,
    measurementsCreatedCount: usage.measurementsCreatedCount,
    operationsCreatedCount: usage.operationsCreatedCount,
    operationsUpdatedCount: usage.operationsUpdatedCount,
  }
}

function renderDay(data: TenantData, usage: UsageDay): Record<string, unknown> {
  return {
    day: `${usage.day}T00:00:00.000Z`,
    ...requestCounters(usage),
    storageSize: usage.storageSize,
    deviceCount: usage.deviceCount,
    deviceWithChildrenCount: usage.deviceWithChildrenCount,
    deviceEndpointCount: usage.deviceEndpointCount,
    subscribedApplications: usage.subscribedApplications,
    resources: copyResources(usage.resources ?? EMPTY_RESOURCES),
    // the platform's id before the day is an internal number, the fake uses the tenant id
    self: `${data.world.baseUrl}/tenant/statistics/${data.tenant}_${usage.day.replaceAll('-', '')}`,
    totalResourceCreateAndUpdateCount: totalResources(usage),
  }
}

/**
 * The summary of a range of days (verified): request counters and resources
 * are summed, storage, device counts, and applications are the last day's;
 * `day` is today, whatever the range.
 * @param data - Tenant data
 * @param usage - The tenant's statistics
 * @param days - The days in the range
 */
function renderSummary(data: TenantData, usage: TenantUsage, days: readonly string[]): Record<string, unknown> {
  const sums = Object.fromEntries(REQUEST_COUNTERS.map((name) => [name, 0])) as Record<RequestCounter, number>
  let last: UsageDay | undefined
  let resources: UsageResources | undefined
  for (const day of days) {
    last = usage.usage(day)
    for (const name of REQUEST_COUNTERS) {
      sums[name] += last[name]
    }
    resources = mergeResources(resources ?? { cpu: 0, memory: 0, usedBy: [] }, last.resources ?? EMPTY_RESOURCES)
  }
  return {
    self: `${data.world.baseUrl}/tenant/statistics/summary`,
    ...requestCounters(sums),
    storageSize: last?.storageSize ?? 0,
    deviceCount: last?.deviceCount ?? 0,
    deviceWithChildrenCount: last?.deviceWithChildrenCount ?? 0,
    deviceEndpointCount: last?.deviceEndpointCount ?? 0,
    subscribedApplications: last?.subscribedApplications ?? [],
    storageLimitPerDevice: 0,
    // verified: missing for a range without days
    ...(resources ? { resources } : {}),
    totalResourceCreateAndUpdateCount: totalResources(sums),
    day: `${usage.today}T00:00:00.000Z`,
  }
}

/**
 * Sums resources; microservices are merged by name (the platform's order of
 * `usedBy` looks like hash order, the fake keeps first appearance).
 * @param total - The sum so far (changed)
 * @param add - Resources to add
 */
function mergeResources(total: UsageResources, add: UsageResources): UsageResources {
  total.cpu += add.cpu
  total.memory += add.memory
  for (const item of add.usedBy) {
    const known = total.usedBy.find((entry) => entry.name === item.name)
    if (known) {
      known.cpu += item.cpu
      known.memory += item.memory
    } else {
      total.usedBy.push({ ...item })
    }
  }
  return total
}

/**
 * 422 for a date the platform does not accept (verified: no `message`).
 * @param value - The value
 */
function invalidDate(value: string): Response {
  return Response.json({ error: `${value} is not a valid date./Invalid Data`, info: ERROR_INFO }, { status: 422 })
}

const forbidden = () => apiError(403, 'security/Forbidden', 'Access Denied')

interface DayRange {
  from: number
  to: number
}

/**
 * `dateFrom` and `dateTo` (verified: a day is in the range when its start
 * is, both ends included; times with a zone count, a time without a zone is
 * invalid).
 * @param call - The request
 */
function dateRange(call: C8yRequest): DayRange | Response {
  const range: DayRange = { from: -Infinity, to: Infinity }
  for (const name of ['dateFrom', 'dateTo'] as const) {
    const value = call.query[name]
    if (value === undefined) {
      continue
    }
    const time = parsePlatformDate(value)
    if (Number.isNaN(time)) {
      return invalidDate(value)
    }
    range[name === 'dateFrom' ? 'from' : 'to'] = time
  }
  return range
}

function inRange(day: string, range: DayRange): boolean {
  const start = Date.parse(`${day}T00:00:00Z`)
  return start >= range.from && start <= range.to
}

/**
 * `/tenant/statistics/**`.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function statisticsApi(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  if (call.method !== 'GET') {
    return undefined
  }
  const [, , resource, ...rest] = segments
  const today = dayOf(Date.parse(data.world.now()))
  if (resource === undefined) {
    checkQuery('GET /tenant/statistics', call, ['dateFrom', 'dateTo', 'currentPage', 'pageSize', 'withTotalPages', 'withTotalElements'])
    const range = dateRange(call)
    if (range instanceof Response) {
      return range
    }
    const usage = new TenantUsage(data, today)
    // verified: oldest first
    const days = usage.days.filter((day) => inRange(day, range))
    return paged(data, call, 'usageStatistics', days, '/tenant/statistics', { render: (day) => renderDay(data, usage.usage(day)) })
  }
  if (resource === 'summary' && rest.length === 0) {
    checkQuery('GET /tenant/statistics/summary', call, ['dateFrom', 'dateTo', 'tenant'])
    const range = dateRange(call)
    if (range instanceof Response) {
      return range
    }
    if (call.query.tenant !== undefined && call.query.tenant !== data.tenant) {
      // verified: also for the management tenant and unknown ones
      return forbidden()
    }
    const usage = new TenantUsage(data, today)
    return Response.json(renderSummary(data, usage, usage.days.filter((day) => inRange(day, range))))
  }
  if (resource === 'allTenantsSummary' && rest.length === 0) {
    checkQuery('GET /tenant/statistics/allTenantsSummary', call, ['dateFrom', 'dateTo'])
    const range = dateRange(call)
    // verified: an empty list for a tenant without subtenants
    return range instanceof Response ? range : Response.json([])
  }
  if (resource === 'device' && rest.length === 3 && (rest[1] === 'daily' || rest[1] === 'monthly')) {
    return deviceStatistics(call, data, rest[0]!, rest[1], rest[2]!, today)
  }
  if (resource === 'files') {
    return statisticsFiles(call, rest)
  }
  return undefined
}

/**
 * `GET /tenant/statistics/device/{tenantId}/daily|monthly/{date}`
 * (verified): a day's or a month's statistics only exist once it is over;
 * the list is not paged (all devices on the first page, later pages empty).
 * @param call - The request
 * @param data - Tenant data
 * @param tenantId - Tenant id from the path
 * @param period - `daily` or `monthly`
 * @param date - Date from the path
 * @param today - Today (`YYYY-MM-DD`)
 */
function deviceStatistics(call: C8yRequest, data: TenantData, tenantId: string, period: 'daily' | 'monthly', date: string, today: string): Response {
  const endpoint = period === 'daily' ? 'GET /tenant/statistics/device/{tenantId}/daily/{date}' : 'GET /tenant/statistics/device/{tenantId}/monthly/{date}'
  checkQuery(endpoint, call, ['deviceId', 'currentPage', 'pageSize', 'withTotalPages'])
  if (tenantId !== data.tenant) {
    return forbidden()
  }
  const time = parsePlatformDate(date)
  if (Number.isNaN(time)) {
    return invalidDate(date)
  }
  const usage = new TenantUsage(data, today)
  const day = dayOf(time)
  const days = period === 'daily'
    ? (day < today ? [day] : [])
    : (day.slice(0, 7) < today.slice(0, 7) ? usage.days.filter((known) => known.startsWith(day.slice(0, 7))) : [])
  let counts = [...usage.devices(days)]
  if (call.query.deviceId !== undefined) {
    counts = counts.filter(([id]) => id === call.query.deviceId)
  }
  const parents = period === 'monthly' && counts.length > 0 ? parentIndex(data) : undefined
  const statistics = counts.map(([deviceId, count]) => {
    if (!parents) {
      return { deviceId, count }
    }
    const type = data.managedObjects.get(deviceId)?.type
    const deviceParents = (parents.get(deviceId) ?? []).filter((link) => link.kind === 'childDevices').map((link) => link.parent)
    return { deviceId, count, ...(typeof type === 'string' ? { deviceType: type } : {}), ...(deviceParents.length > 0 ? { deviceParents } : {}) }
  })
  return unpaged(data, call, `/tenant/statistics/device/${tenantId}/${period}/${date}`, statistics)
}

/**
 * The device statistics' links (verified): the paging parameters show in the
 * links but the whole list is on the first page; `next` is always linked,
 * except with `withTotalPages`.
 * @param data - Tenant data
 * @param call - The request
 * @param path - Path of the list
 * @param items - All items
 */
function unpaged(data: TenantData, call: C8yRequest, path: string, items: unknown[]): Response {
  for (const name of ['pageSize', 'currentPage']) {
    const value = call.query[name]
    if (value !== undefined && !/^-?\d+$/.test(value)) {
      return apiError(422, 'REST API/Unprocessable Entity', `Parameter '${name}' must have an integer value!`)
    }
  }
  const pageSize = Math.min(Math.max(Number.parseInt(call.query.pageSize ?? '5', 10), 1), 2000)
  const currentPage = Math.max(Number.parseInt(call.query.currentPage ?? '1', 10), 1)
  const link = (page: number) => `${data.world.baseUrl}${path}?${new URLSearchParams({ ...call.query, pageSize: String(pageSize), currentPage: String(page) })}`
  const withTotalPages = call.query.withTotalPages !== undefined && call.query.withTotalPages.toLowerCase() !== 'false'
  return Response.json({
    self: link(currentPage),
    ...(currentPage > 1 ? { prev: link(currentPage - 1) } : {}),
    ...(withTotalPages ? {} : { next: link(currentPage + 1) }),
    statistics: currentPage === 1 ? items : [],
  })
}

/**
 * Statistics files (verified): a tenant admin may not read them; dates are
 * checked first.
 * @param call - The request
 * @param rest - Path segments after `files`
 */
function statisticsFiles(call: C8yRequest, rest: string[]): Response | undefined {
  if (rest.length === 0) {
    checkQuery('GET /tenant/statistics/files', call, ['dateFrom', 'dateTo', 'currentPage', 'pageSize', 'withTotalPages'])
    const range = dateRange(call)
    return range instanceof Response ? range : forbidden()
  }
  if (rest.length === 2 && rest[0] === 'latest') {
    checkQuery('GET /tenant/statistics/files/latest/{month}', call, [])
    return Number.isNaN(parsePlatformDate(rest[1]!)) ? invalidDate(rest[1]!) : forbidden()
  }
  if (rest.length === 1) {
    checkQuery('GET /tenant/statistics/files/{id}', call, [])
    return forbidden()
  }
  return undefined
}
