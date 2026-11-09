/**
 * Generated measurements: a world with measurement generators must answer
 * every measurement request exactly like a world that stores the same
 * documents (in id order). The stored world here is built independently from
 * the generators' definitions, and both get the same random writes (POSTs,
 * deletes by id and by filter, a deleted device) and clock moves.
 */
import { describe, expect, it } from 'vitest'
import { createWorld, diffSnapshots } from '../../src'
import type { C8yMeasurementGeneratorInput, C8yWave, GeneratorSnapshot, World, WorldSnapshot } from '../../src'

const T0 = Date.parse('2026-05-10T12:34:00.000Z')
const HOUR = 3_600_000
const DAY = 86_400_000

/**
 * A small deterministic PRNG (mulberry32).
 * @param seed - Seed
 */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function call(world: World, method: string, path: string, body?: unknown) {
  // a write answers with its document only to a request that accepts JSON
  const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json', 'accept': 'application/json' }
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  return { status: response.status, text: await response.text() }
}

// ---------------------------------------------------------------- the stored world, built independently

function fnv(hash: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/**
 * The documented wave formula.
 * @param wave
 * @param start
 * @param key
 * @param time
 */
function waveValue(wave: C8yWave, start: number, key: string, time: number): number {
  const hour = (((time % DAY) + DAY) % DAY) / HOUR
  const active = (wave.overrides ?? []).filter((item) => time >= Date.parse(item.from) && time < Date.parse(item.to))
  const set = active.find((item) => item.set !== undefined)?.set
  let value = set ?? wave.base + (wave.dailyAmplitude ?? 0) * Math.sin((2 * Math.PI * (hour - (wave.peakHour ?? 15) + 6)) / 24) + (wave.trendPerDay ?? 0) * ((time - start) / DAY)
  for (const item of active) {
    value += item.add ?? 0
  }
  if (wave.noise) {
    value += ((fnv(0x811C9DC5, `${wave.noiseKey ?? key}|${time}`) / 0x100000000) * 2 - 1) * wave.noise
  }
  value = Math.min(wave.max ?? Infinity, Math.max(wave.min ?? -Infinity, value))
  return Number(value.toFixed(wave.precision ?? 2))
}

type Ids = 'scattered' | 'sequential'

function mix(n: number): number {
  let x = Math.imul(n ^ (n >>> 16), 0x45D9F3B)
  x = Math.imul(x ^ (x >>> 16), 0x45D9F3B)
  return (x ^ (x >>> 16)) >>> 0
}

/**
 * The documented measurement id of sequence number `n`: 24 hex digits (the
 * number after 0x6A000000, then two hashes of it), or the number itself with
 * `ids: 'sequential'`.
 * @param n
 * @param ids
 */
function measurementId(n: number, ids: Ids): string {
  const hex = (value: number) => value.toString(16).padStart(8, '0')
  return ids === 'sequential' ? String(n) : `${hex(0x6A000000 + n)}${hex(mix(n))}${hex(mix(n ^ 0x5BD1E995))}`
}

/**
 * The sequence number of a measurement id, for sorting in id order.
 * @param id
 * @param ids
 */
function sequenceOf(id: string, ids: Ids): number {
  return ids === 'sequential' ? Number(id) : Number.parseInt(id.slice(0, 8), 16) - 0x6A000000
}

const STEP: Record<string, number> = { s: 1000, m: 60_000, h: HOUR, d: DAY }

function stepOf(interval: string): number {
  return Number(interval.slice(0, -1)) * STEP[interval.at(-1)!]!
}

/**
 * Grid points a generator shows at a time.
 * @param entry
 * @param now
 */
function visiblePoints(entry: GeneratorSnapshot, now: number): number {
  const { generator } = entry
  const start = Date.parse(generator.from)
  return generator.to !== undefined ? entry.block : (now < start ? 0 : Math.min(entry.block, Math.floor((now - start) / stepOf(generator.interval)) + 1))
}

/**
 * The documents of a generator with grid index in `[from, to)`.
 * @param entry
 * @param from
 * @param to
 * @param ids
 */
function expand(entry: GeneratorSnapshot, from: number, to: number, ids: Ids): Array<Record<string, unknown>> {
  const { generator } = entry
  const start = Date.parse(generator.from)
  const step = stepOf(generator.interval)
  const inGap = (ranges: Array<{ from: string, to: string }> | undefined, time: number) => (ranges ?? []).some((range) => time >= Date.parse(range.from) && time < Date.parse(range.to))
  const documents: Array<Record<string, unknown>> = []
  for (let i = from; i < to; i++) {
    const time = start + i * step
    const iso = new Date(time).toISOString()
    const document: Record<string, unknown> = { time: iso, source: { id: generator.source }, type: generator.type }
    let any = false
    for (const fragment of new Set(generator.series.map((series) => series.fragment))) {
      for (const series of generator.series.filter((item) => item.fragment === fragment)) {
        if (inGap(generator.gaps, time) || inGap(series.gaps, time)) {
          continue
        }
        const value = typeof series.value === 'number'
          ? series.value
          : typeof series.value === 'function' ? series.value(time, i) : waveValue(series.value, start, `${generator.source}|${fragment}.${series.series}`, time)
        const entryValue = series.unit === undefined ? { value } : { value, unit: series.unit }
        document[fragment] = { ...(document[fragment] as object | undefined), [series.series]: entryValue }
        any = true
      }
    }
    if (any) {
      document.id = measurementId(entry.idStart + i, ids)
      document.creationTime = iso
      documents.push(document)
    }
  }
  return documents
}

/**
 * A snapshot with the generated documents stored instead of the generators.
 * @param snapshot
 * @param now
 * @param ids
 */
function materialize(snapshot: WorldSnapshot, now: number, ids: Ids): WorldSnapshot {
  return {
    ...snapshot,
    tenants: snapshot.tenants.map(({ measurementGenerators = [], measurementTombstones: _tombstones, ...tenant }) => ({
      ...tenant,
      measurements: [...tenant.measurements, ...measurementGenerators.flatMap((entry) => expand(entry, 0, visiblePoints(entry, now), ids))].sort((a, b) => sequenceOf(String(a.id), ids) - sequenceOf(String(b.id), ids)) as WorldSnapshot['tenants'][number]['measurements'],
    })),
  }
}

// ---------------------------------------------------------------- random worlds and requests

interface Pair {
  generated: World
  stored: World
  generators: GeneratorSnapshot[]
  devices: string[]
  clock: { now: number }
  ids: Ids
  rnd: () => number
  checks: number
}

const FRAGMENTS = [['c8y_Temperature', 'T', 'C'], ['c8y_Temperature', 'T2', 'C'], ['c8y_Power', 'P', 'kW'], ['c8y_Power', 'Q', undefined], ['c8y_Extra', 'x', 'u']] as const

function randomGenerators(rnd: () => number, devices: string[], declarative: boolean): C8yMeasurementGeneratorInput[] {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!
  const at = (time: number) => new Date(time).toISOString()
  const generators: C8yMeasurementGeneratorInput[] = []
  for (const device of devices) {
    const types = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(['c8y_Temperature', 'c8y_Power', 'c8y_Mixed'])))]
    for (const type of types) {
      const interval = pick(['5m', '10m', '13m', '1h', '30s'])
      const span = interval === '30s' ? 8 * HOUR : (2 + rnd() * 2) * DAY
      const from = Math.floor((T0 - span) / 60_000) * 60_000
      const end = pick([undefined, T0 - Math.floor(rnd() * 5) * HOUR, T0 + 2 * HOUR])
      const gap = (scale: number) => {
        const a = from + Math.floor(rnd() * span)
        return { from: at(a), to: at(a + Math.floor(rnd() * scale)) }
      }
      const series = FRAGMENTS.filter(() => rnd() < 0.45).map(([fragment, name, unit]) => {
        const kind = declarative ? pick(['wave', 'constant']) : pick(['wave', 'constant', 'function'])
        const value: C8yMeasurementGeneratorInput['series'][number]['value'] = kind === 'constant'
          ? Math.round(rnd() * 100)
          : kind === 'function'
            ? (time: number, index: number) => Math.round(Math.sin(time / 1e7 + index) * 1000) / 10
            : { base: 20 + rnd() * 10, dailyAmplitude: rnd() * 5, noise: rnd(), trendPerDay: rnd() - 0.5, ...(rnd() < 0.3 ? { overrides: [{ ...gap(6 * HOUR), add: 10 }] } : {}), ...(rnd() < 0.2 ? { max: 25 } : {}) }
        return { fragment, series: name, ...(unit ? { unit } : {}), value, ...(rnd() < 0.4 ? { gaps: [gap(12 * HOUR), gap(2 * HOUR)] } : {}) }
      })
      if (series.length === 0) {
        series.push({ fragment: 'c8y_Temperature', series: 'T', unit: 'C', value: 1 })
      }
      generators.push({ source: device, type, from: at(from), ...(end !== undefined ? { to: at(end) } : {}), interval, series, ...(rnd() < 0.3 ? { gaps: [gap(3 * HOUR)] } : {}) })
    }
  }
  return generators
}

/**
 * A world with generators and the world that stores the same documents.
 * @param seed
 * @param declarative
 * @param ids
 */
function worlds(seed: number, declarative = false, ids: Ids = 'scattered'): Pair {
  const rnd = random(seed)
  const clock = { now: T0 }
  // scattered is the default: leave the option out for it
  const generated = createWorld({ now: () => clock.now, ...(ids === 'sequential' ? { ids } : {}) })
  const devices = Array.from({ length: 8 }, (_, k) => generated.device({ name: `device-${k}` }))
  // stored measurements before the generators: ids before their blocks
  generated.seed({ measurements: [{ source: devices[0]!, type: 'c8y_Temperature', time: new Date(T0 - DAY).toISOString(), c8y_Temperature: { T: { value: 1, unit: 'C' } } }] })
  generated.seed({ measurementGenerators: randomGenerators(rnd, devices, declarative) })
  generated.seed({ measurements: [{ source: devices[1]!, type: 'c8y_Power', time: new Date(T0 - HOUR).toISOString(), c8y_Power: { P: { value: 2, unit: 'kW' } } }] })
  const snapshot = generated.snapshot()
  const stored = createWorld({ now: () => clock.now, ids })
  stored.restore(materialize(snapshot, clock.now, ids))
  return { generated, stored, generators: snapshot.tenants[0]!.measurementGenerators!, devices, clock, ids, rnd, checks: 0 }
}

function pickOf(pair: Pair) {
  return <T>(list: readonly T[]): T => list[Math.floor(pair.rnd() * list.length)]!
}

function randomTime(pair: Pair, align: number): number {
  return Math.floor((T0 - 3 * DAY + pair.rnd() * 3.5 * DAY) / align) * align
}

function gridTime(pair: Pair): number {
  const entry = pickOf(pair)(pair.generators)
  const start = Date.parse(entry.generator.from)
  return start + Math.floor(pair.rnd() * visiblePoints(entry, pair.clock.now)) * stepOf(entry.generator.interval)
}

function randomListQuery(pair: Pair): Record<string, string> {
  const { rnd } = pair
  const pick = pickOf(pair)
  const q: Record<string, string> = {}
  if (rnd() < 0.75) {
    q.source = rnd() < 0.03 ? '' : pick(pair.devices)
  }
  if (rnd() < 0.3) {
    q.type = pick(['c8y_Temperature', 'c8y_Power', 'c8y_Mixed', 'c8y_Temperature,c8y_Power', 'agent_Type'])
  }
  if (rnd() < 0.3) {
    const [fragment, series] = pick(FRAGMENTS)
    q.valueFragmentType = fragment
    if (rnd() < 0.5) {
      q.valueFragmentSeries = series
    }
  } else if (rnd() < 0.1) {
    // a series name in any fragment
    q.valueFragmentSeries = pick(FRAGMENTS)[1]
  }
  if (rnd() < 0.2) {
    // verified: a list filters by fragmentType too, and ignores status
    q.fragmentType = pick(FRAGMENTS)[0]
  }
  if (rnd() < 0.1) {
    q.status = 'ACTIVE'
  }
  const r = rnd()
  if (r < 0.6) {
    const a = rnd() < 0.3 ? gridTime(pair) : randomTime(pair, pick([60_000, HOUR, 7_000]))
    q.dateFrom = new Date(a).toISOString()
    q.dateTo = new Date(rnd() < 0.1 ? a : a + Math.floor(rnd() * 2 * DAY)).toISOString()
  } else if (r < 0.7) {
    q.dateFrom = new Date(randomTime(pair, HOUR)).toISOString()
  } else if (r < 0.8) {
    q.dateTo = new Date(randomTime(pair, HOUR)).toISOString()
  }
  if (rnd() < 0.5) {
    q.revert = pick(['true', 'false', 'FALSE'])
  }
  q.pageSize = String(pick([1, 5, 7, 100, 2000]))
  q.currentPage = String(pick([1, 1, 1, 2, 3, 10, 50, 400]))
  if (rnd() < 0.5) {
    q.withTotalElements = 'true'
  }
  if (rnd() < 0.3) {
    q.withTotalPages = 'true'
  }
  return q
}

function randomSeriesQuery(pair: Pair): string {
  const { rnd } = pair
  const pick = pickOf(pair)
  const a = rnd() < 0.2 ? gridTime(pair) : randomTime(pair, pick([60_000, HOUR]))
  const params = new URLSearchParams({ source: pick(pair.devices), dateFrom: new Date(a).toISOString(), dateTo: new Date(rnd() < 0.05 ? a : a + Math.floor(rnd() * 3 * DAY)).toISOString() })
  const interval = pick([undefined, '1h', '1d', '15m', '7m', '1w'])
  if (interval) {
    params.set('aggregationInterval', interval)
    for (const fn of pick([[], ['avg'], ['min', 'max', 'avg', 'sum', 'count'], ['stdDevPop', 'stdDevSamp']])) {
      params.append('aggregationFunction', fn)
    }
  }
  if (rnd() < 0.3) {
    const [fragment, series] = pick(FRAGMENTS)
    params.append('series', `${fragment}.${series}`)
  }
  if (rnd() < 0.2) {
    // the unit comes from the oldest bucket
    params.set('revert', 'false')
  }
  return `/measurement/measurements/series?${params}`
}

/**
 * Sends the same request to both worlds and expects the same answer.
 * @param pair
 * @param method
 * @param path
 * @param body
 */
async function same(pair: Pair, method: string, path: string, body?: unknown): Promise<{ status: number, text: string }> {
  const a = await call(pair.generated, method, path, body)
  const b = await call(pair.stored, method, path, body)
  expect({ path, method, status: a.status, text: a.text }).toEqual({ path, method, status: b.status, text: b.text })
  pair.checks++
  return a
}

async function compareReads(pair: Pair, count: number): Promise<void> {
  const pick = pickOf(pair)
  for (let k = 0; k < count; k++) {
    await same(pair, 'GET', `/measurement/measurements?${new URLSearchParams(randomListQuery(pair))}`)
    if (k % 3 === 0) {
      await same(pair, 'GET', randomSeriesQuery(pair))
    }
    if (k % 5 === 0) {
      await same(pair, 'GET', `/inventory/managedObjects/${pick(pair.devices)}/${pick(['supportedSeries', 'supportedMeasurements'])}`)
    }
  }
}

/**
 * Random writes to both worlds: POSTs (some on grid times, for ties),
 * deletes by id and by filter, and (rarely) a deleted device.
 * @param pair
 * @param count
 * @param options
 * @param options.deleteDevice
 */
async function randomWrites(pair: Pair, count: number, options: { deleteDevice?: boolean } = {}): Promise<void> {
  const { rnd } = pair
  const pick = pickOf(pair)
  const seen: string[] = []
  for (let k = 0; k < count; k++) {
    const r = rnd()
    if (r < 0.35) {
      const [fragment, series, unit] = pick(FRAGMENTS)
      const time = rnd() < 0.5 ? gridTime(pair) : randomTime(pair, 1000)
      const created = await same(pair, 'POST', '/measurement/measurements', { source: { id: pick(pair.devices) }, type: pick(['c8y_Temperature', 'c8y_Power', 'agent_Type']), time: new Date(time).toISOString(), [fragment]: { [series]: { value: Math.round(rnd() * 1000) / 10, ...(unit ? { unit } : {}) } } })
      seen.push(JSON.parse(created.text).id)
    } else if (r < 0.7) {
      // a generated id (maybe a gap, deleted, or not there yet), or a stored one
      const entry = pick(pair.generators)
      const id = rnd() < 0.85 || seen.length === 0 ? measurementId(entry.idStart + Math.floor(rnd() * (visiblePoints(entry, pair.clock.now) + 3)), pair.ids) : pick(seen)
      await same(pair, 'DELETE', `/measurement/measurements/${id}`)
    } else if (r < 0.97 || !options.deleteDevice) {
      const params: Record<string, string> = {}
      if (rnd() < 0.85) {
        params.source = pick(pair.devices)
      }
      if (rnd() < 0.25) {
        params.type = pick(['c8y_Temperature', 'c8y_Power', 'c8y_Mixed'])
      }
      if (rnd() < 0.2) {
        params.fragmentType = pick(FRAGMENTS)[0]
      }
      if (rnd() < 0.9 || !params.source) {
        const a = randomTime(pair, rnd() < 0.05 ? 60_000 : HOUR)
        params.dateFrom = new Date(a).toISOString()
        params.dateTo = new Date(rnd() < 0.15 ? a : a + Math.floor(rnd() * 8) * HOUR).toISOString()
      }
      await same(pair, 'DELETE', `/measurement/measurements?${new URLSearchParams(params)}`)
    } else {
      const device = pick(pair.devices)
      await same(pair, 'DELETE', `/inventory/managedObjects/${device}`)
    }
  }
}

/**
 * Moves the clock: live generators show new points, which the stored world
 * gets as stored documents (unless their device is gone).
 * @param pair
 * @param by
 */
function moveClock(pair: Pair, by: number): void {
  const before = pair.clock.now
  pair.clock.now += by
  const snapshot = pair.stored.snapshot()
  const tenant = snapshot.tenants.find((item) => item.tenant === pair.stored.tenant)!
  const exists = new Set(tenant.managedObjects.map((object) => object.id))
  const added = pair.generators
    .filter((entry) => entry.generator.to === undefined && exists.has(entry.generator.source))
    .flatMap((entry) => expand(entry, visiblePoints(entry, before), visiblePoints(entry, pair.clock.now), pair.ids))
  tenant.measurements = [...tenant.measurements, ...added].sort((a, b) => sequenceOf(String(a.id), pair.ids) - sequenceOf(String(b.id), pair.ids)) as typeof tenant.measurements
  pair.stored.restore(snapshot)
}

/**
 * The fork diffs must agree: stored measurements as in the stored world, the
 * generated deletes as tombstones (documents or counted ranges).
 * @param generated
 * @param stored
 * @param since
 */
function compareDiffs(generated: World, stored: World, since: WorldSnapshot): void {
  const a = generated.diff()
  expect(a).toEqual(generated.diff(since))
  expect(a).toEqual(diffSnapshots(since, generated.snapshot()))
  const b = stored.diff()
  const tenant = generated.tenant
  const ga = a.tenants[tenant]
  const sb = b.tenants[tenant]
  const ids = (list: Array<{ id: string }> | undefined) => (list ?? []).map((document) => document.id).sort()
  expect(ids(ga?.measurements.created)).toEqual(ids(sb?.measurements.created))
  const ranged = (ga?.deletedMeasurementRanges ?? []).reduce((sum, range) => sum + range.count, 0)
  const deletedOne = new Map((ga?.measurements.deleted ?? []).map((document) => [document.id, document]))
  expect((sb?.measurements.deleted ?? []).length).toBe(deletedOne.size + ranged)
  for (const document of sb?.measurements.deleted ?? []) {
    if (deletedOne.has(document.id)) {
      expect(deletedOne.get(document.id)).toEqual(document)
    }
  }
}

describe('generated measurements', () => {
  for (const [seed, ids] of [[1, 'scattered'], [2, 'scattered'], [3, 'scattered'], [3, 'sequential']] as const) {
    it(`answer like stored ones (seed ${seed}, ${ids} ids): writes, clock, fork, diff, reset, snapshot, restore`, async () => {
      const pair = worlds(seed, false, ids)
      await compareReads(pair, 60)
      await randomWrites(pair, 30)
      await compareReads(pair, 40)
      moveClock(pair, 90 * 60_000)
      await compareReads(pair, 30)
      await randomWrites(pair, 30, { deleteDevice: true })
      moveClock(pair, 3 * HOUR + 17_000)
      await compareReads(pair, 40)

      // forks of both worlds
      const generatedBase = pair.generated.snapshot()
      const forked: Pair = { ...pair, generated: pair.generated.fork(), stored: pair.stored.fork() }
      await compareReads(forked, 20)
      await randomWrites(forked, 40, { deleteDevice: true })
      await compareReads(forked, 40)
      compareDiffs(forked.generated, forked.stored, generatedBase)

      // snapshot and restore: into a new world, into another fork
      const snapshot = forked.generated.snapshot()
      const restored = createWorld({ now: () => pair.clock.now, ids })
      restored.restore(snapshot)
      const other = pair.generated.fork()
      other.restore(snapshot)
      for (const generated of [restored, other]) {
        await compareReads({ ...forked, generated }, 25)
      }
      expect(restored.snapshot()).toEqual(snapshot)

      // reset: back to the base
      forked.generated.reset()
      forked.stored.reset()
      await compareReads(forked, 25)
      expect(forked.generated.diff().tenants).toEqual({})

      pair.checks += forked.checks
      expect(pair.checks).toBeGreaterThan(400)
    }, 60_000)
  }

  it('survives a JSON snapshot (declarative values)', async () => {
    const pair = worlds(7, true)
    await randomWrites(pair, 20)
    const json = JSON.parse(JSON.stringify(pair.generated.snapshot())) as WorldSnapshot
    const restored = createWorld({ now: () => pair.clock.now, ids: pair.ids })
    restored.restore(json)
    expect(restored.snapshot()).toEqual(json)
    await compareReads({ ...pair, generated: restored }, 40)
  })

  it('needs the function of a function value', () => {
    const pair = worlds(4)
    const json = JSON.parse(JSON.stringify(pair.generated.snapshot())) as WorldSnapshot
    const hasFunction = pair.generators.some((entry) => entry.generator.series.some((series) => typeof series.value === 'function'))
    expect(hasFunction).toBe(true)
    expect(() => createWorld().restore(json)).toThrow(/no value/)
  })

  it('publishes deletes like stored measurements', async () => {
    const pair = worlds(5)
    for (const world of [pair.generated, pair.stored]) {
      for (const body of [{ context: 'tenant', subscription: 'all', subscriptionFilter: { apis: ['measurements'] } }, { context: 'mo', source: { id: pair.devices[2]! }, subscription: 'one' }]) {
        const response = await world.fetch(new Request(`${world.baseUrl}/notification2/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
        expect(response.status).toBe(201)
      }
    }
    await randomWrites(pair, 30)
    expect(pair.generated.realtime.backlog).toEqual(pair.stored.realtime.backlog)
    expect([...pair.generated.realtime.backlog.values()].flat().some((frame) => frame.text.includes('DELETE'))).toBe(true)
  })

  it('keeps ids, db views, and the history small', async () => {
    const world = createWorld({ now: () => T0 })
    const device = world.device({ name: 'pump' })
    world.seed({ measurementGenerators: [{ source: device, type: 'c8y_Temperature', from: new Date(T0 - 30 * DAY).toISOString(), interval: '1m', series: [{ fragment: 'c8y_Temperature', series: 'T', unit: 'C', value: { base: 20, noise: 1 } }] }] })
    // 30 days at one minute, plus the live capacity
    const entry = world.snapshot().tenants[0]!.measurementGenerators![0]!
    expect(entry.block).toBe(30 * 1440 + 1 + 100_000)
    // the next managed object: a two-digit prefix and the counter after the block
    expect(world.device()).toMatch(new RegExp(`^\\d{2}${100_000 + entry.idStart + entry.block}$`))
    const id = measurementId(entry.idStart + 5, 'scattered')
    expect(id).toMatch(/^[0-9a-f]{24}$/)
    // the hash digits must match the sequence number
    expect(world.db.measurements.get(`${id.slice(0, 23)}${id.endsWith('0') ? '1' : '0'}`)).toBeUndefined()
    expect(world.db.measurements.get(id)).toMatchObject({ id, time: new Date(T0 - 30 * DAY + 5 * 60_000).toISOString(), source: { id: device } })
    expect(world.db.measurements.get(measurementId(entry.idStart + 30 * 1440 + 1, 'scattered'))).toBeUndefined()
    const page = JSON.parse((await call(world, 'GET', `/measurement/measurements?source=${device}&withTotalElements=true&pageSize=1`)).text)
    expect(page.statistics.totalElements).toBe(30 * 1440 + 1)
    expect(page.measurements[0].time).toBe(new Date(T0).toISOString())
    expect((await call(world, 'GET', `/measurement/measurements/${id}`)).status).toBe(405)
  })

  it('rejects invalid generators', () => {
    const world = createWorld()
    const device = world.device()
    const valid: C8yMeasurementGeneratorInput = { source: device, type: 't', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', interval: '1h', series: [{ fragment: 'f', series: 's', value: 1 }] }
    expect(() => world.seed({ measurementGenerators: [{ ...valid, source: '999' }] })).toThrow(/does not exist/)
    expect(() => world.seed({ measurementGenerators: [{ ...valid, interval: '1w' }] })).toThrow(/interval/)
    expect(() => world.seed({ measurementGenerators: [{ ...valid, to: valid.from }] })).toThrow(/no grid point/)
    expect(() => world.seed({ measurementGenerators: [{ ...valid, series: [] }] })).toThrow(/no series/)
  })
})
