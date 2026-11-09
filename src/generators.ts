/**
 * Generated measurement history: a measurement generator describes one
 * stream of documents (one source and type, one point per interval) whose
 * values are computed when read. Nothing is stored per point. Reads merge the
 * generated documents with the stored ones (seeded or written through the
 * API) and leave out deleted ones, so every answer equals the answer of a
 * world that stores the same documents.
 *
 * - Ids: seeding a generator reserves one sequence number per grid point (a
 *   block from the world's id sequence): the point at grid index `i` has the
 *   sequence number `idStart + i` and the id `world.measurementId(idStart + i)`
 *   (24 hex digits by default, the number itself with `ids: 'sequential'`).
 *   A grid point without a document (a gap) leaves its id unused.
 * - Deletes: a deleted generated document is a point tombstone, a delete by
 *   filter a range tombstone (`TenantData.measurementTombstones`). Both live
 *   in a collection, so forks, resets, snapshots, and diffs pick them up.
 * - Live generators (no `to`) grow with the world's clock: they show the grid
 *   points up to now, up to `LIVE_CAPACITY` points after seeding.
 */
import type { Collection } from './collection'
import type { StoredDocument, TenantData, WorldContext } from './store'
import { clone, parseIsoTime } from './utils'

/**
 * Grid points a live generator (without `to`) reserves ids for beyond the
 * points that exist when it is seeded. A live generator stops growing there.
 */
export const LIVE_CAPACITY = 100_000

/**
 * How the world turns sequence numbers into measurement ids and back.
 */
type MeasurementIds = Pick<WorldContext, 'measurementId' | 'measurementSequence'>

type Interval = [number, number]

/**
 * A time range, from inclusive, to exclusive (ISO dates).
 */
export interface C8yTimeRange {
  from: string
  to: string
}

/**
 * A deterministic wave: `base`, a daily sine, a linear trend, and hashed noise.
 */
export interface C8yWave {
  base: number
  /**
   * Amplitude of a daily sine (UTC day).
   * @default 0
   */
  dailyAmplitude?: number
  /**
   * UTC hour of the sine's peak.
   * @default 15
   */
  peakHour?: number
  /**
   * Change per day since the generator's `from`.
   * @default 0
   */
  trendPerDay?: number
  /**
   * Uniform noise in `[-noise, noise]`, a hash of `noiseKey` and the time.
   * @default 0
   */
  noise?: number
  /**
   * Key of the noise hash.
   * @default `${source id}|${fragment}.${series}`
   */
  noiseKey?: string
  /**
   * Time ranges where the value is replaced (`set`) or shifted (`add`), e.g.
   * an incident.
   */
  overrides?: Array<C8yTimeRange & { add?: number, set?: number }>
  min?: number
  max?: number
  /**
   * Decimal places (`toFixed`).
   * @default 2
   */
  precision?: number
}

/**
 * One series (`fragment.series`) of a measurement generator.
 */
export interface C8yGeneratedSeriesInput {
  fragment: string
  series: string
  unit?: string
  /**
   * A constant, a wave, or a function of the time (epoch milliseconds) and
   * the grid index. Functions must be deterministic, and cannot be restored
   * from a snapshot that went through `JSON.stringify`.
   */
  value: number | C8yWave | ((time: number, index: number) => number)
  /**
   * Time ranges without a value of this series. A grid point where no series
   * has a value has no document.
   */
  gaps?: C8yTimeRange[]
}

/**
 * Measurement history computed on read: one document per grid point from
 * `from` (inclusive) to `to` (exclusive) every `interval`, with a value per
 * series.
 */
export interface C8yMeasurementGeneratorInput<Source = string | { readonly id: string }> {
  source: Source
  type: string
  /**
   * First grid point (ISO date).
   */
  from: string
  /**
   * End of the grid (exclusive). Without it, the generator is live: it shows
   * the grid points up to the world's clock (inclusive), and new points
   * appear as the clock moves on.
   */
  to?: string
  /**
   * Grid step: a number and a unit, `s`, `m`, `h`, or `d`, e.g. `5m`.
   */
  interval: string
  series: Array<C8yGeneratedSeriesInput>
  /**
   * Time ranges without documents.
   */
  gaps?: C8yTimeRange[]
}

/**
 * A seeded generator, as it is kept in snapshots.
 */
export interface GeneratorSnapshot {
  /**
   * Id of grid point 0.
   */
  idStart: number
  /**
   * Ids reserved: the grid points of a fixed generator, or those at seeding
   * plus `LIVE_CAPACITY` for a live one.
   */
  block: number
  generator: C8yMeasurementGeneratorInput<string>
}

/**
 * A deleted generated document (with its content at deletion), or a delete
 * by filter (with the number of generated documents it removed).
 */
export type MeasurementTombstone = PointTombstone | RangeTombstone

export interface PointTombstone {
  kind: 'point'
  id: string
  document: StoredDocument
}

export interface RangeTombstone {
  kind: 'range'
  source?: string
  /**
   * As in the query: one type, compared as a whole.
   */
  type?: string
  fragmentType?: string
  dateFrom?: string
  dateTo?: string
  /**
   * The world's clock at the delete: live generators keep the points after
   * it. Without it (a deleted source), the range covers all points.
   */
  until?: string
  /**
   * Generated documents it removed.
   */
  count: number
}

interface SeriesDef {
  fragment: string
  name: string
  unit: string | undefined
  value: (time: number, index: number) => number
  /**
   * Grid index intervals without a value.
   */
  skips: Interval[]
}

/**
 * A compiled generator, as stored in `TenantData.measurementGenerators`.
 */
export interface MeasurementStream extends GeneratorSnapshot {
  sourceId: string
  type: string
  /**
   * Epoch milliseconds of grid point 0.
   */
  start: number
  step: number
  live: boolean
  series: SeriesDef[]
  /**
   * Fragments in document order, with the indexes of their series.
   */
  fragments: Array<[string, number[]]>
  /**
   * Grid index intervals without a document.
   */
  holes: Interval[]
}

// ---------------------------------------------------------------- intervals

function normalize(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).map((x): Interval => [x[0], x[1]]).sort((x, y) => x[0] - y[0])
  const out: Interval[] = []
  for (const [a, b] of sorted) {
    const last = out.at(-1)
    if (last && a <= last[1]) {
      last[1] = Math.max(last[1], b)
    } else {
      out.push([a, b])
    }
  }
  return out
}

function intersect(x: Interval[], y: Interval[]): Interval[] {
  const out: Interval[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    const a = Math.max(x[i]![0], y[j]![0])
    const b = Math.min(x[i]![1], y[j]![1])
    if (b > a) {
      out.push([a, b])
    }
    if (x[i]![1] < y[j]![1]) {
      i++
    } else {
      j++
    }
  }
  return out
}

function complement(x: Interval[], n: number): Interval[] {
  const out: Interval[] = []
  let at = 0
  for (const [a, b] of x) {
    if (a > at) {
      out.push([at, Math.min(a, n)])
    }
    at = Math.max(at, b)
  }
  if (at < n) {
    out.push([at, n])
  }
  return out.filter(([a, b]) => b > a)
}

function prefixSums(x: Interval[]): number[] {
  const sums: number[] = []
  let total = 0
  for (const [a, b] of x) {
    sums.push(total)
    total += b - a
  }
  return sums
}

/**
 * Length of `x ∩ [0, p)`.
 * @param x
 * @param sums
 * @param p
 */
function covered(x: Interval[], sums: number[], p: number): number {
  let lo = 0
  let hi = x.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x[mid]![0] < p) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  if (lo === 0) {
    return 0
  }
  const k = lo - 1
  return sums[k]! + Math.min(x[k]![1], p) - x[k]![0]
}

/**
 * Index of the interval containing `i`, or -1.
 * @param x
 * @param i
 */
function containing(x: Interval[], i: number): number {
  let lo = 0
  let hi = x.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x[mid]![0] <= i) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  const k = lo - 1
  return k >= 0 && i < x[k]![1] ? k : -1
}

// ---------------------------------------------------------------- compiling

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function parseTime(value: string, what: string): number {
  const time = parseIsoTime(value)
  if (Number.isNaN(time)) {
    throw new TypeError(`measurement generator: ${what} '${value}' is not a date`)
  }
  return time
}

function fnv(hash: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function waveFunction(wave: C8yWave, start: number, key: string): (time: number) => number {
  const prefix = fnv(0x811C9DC5, `${wave.noiseKey ?? key}|`)
  const overrides = (wave.overrides ?? []).map((item) => ({ from: parseTime(item.from, 'override from'), to: parseTime(item.to, 'override to'), add: item.add, set: item.set }))
  const peak = wave.peakHour ?? 15
  return (time) => {
    const hour = (((time % 86_400_000) + 86_400_000) % 86_400_000) / 3_600_000
    let set: number | undefined
    let add = 0
    for (const item of overrides) {
      if (time >= item.from && time < item.to) {
        set ??= item.set
        add += item.add ?? 0
      }
    }
    let value = set ?? wave.base + (wave.dailyAmplitude ?? 0) * Math.sin((2 * Math.PI * (hour - peak + 6)) / 24) + (wave.trendPerDay ?? 0) * ((time - start) / 86_400_000)
    value += add
    if (wave.noise) {
      value += ((fnv(prefix, String(time)) / 0x100000000) * 2 - 1) * wave.noise
    }
    if (wave.min !== undefined) {
      value = Math.max(wave.min, value)
    }
    if (wave.max !== undefined) {
      value = Math.min(wave.max, value)
    }
    return Number(value.toFixed(wave.precision ?? 2))
  }
}

/**
 * Grid points of a generator up to a time (inclusive), at most `max`.
 * @param start
 * @param step
 * @param max
 * @param time
 */
function pointsUntil(start: number, step: number, max: number, time: number): number {
  return time < start ? 0 : Math.min(max, Math.floor((time - start) / step) + 1)
}

/**
 * Compiles a generator (validated) for a block of ids.
 * @param generator - The generator, its source resolved to an id
 * @param idStart - Id of grid point 0
 * @param block - Ids reserved (`undefined`: compute them at time `now`)
 * @param now - The world's clock (epoch milliseconds)
 */
export function compileGenerator(generator: C8yMeasurementGeneratorInput<string>, idStart: number, block: number | undefined, now: number): MeasurementStream {
  const match = /^([1-9]\d*)([smhd])$/.exec(generator.interval)
  if (!match) {
    throw new TypeError(`measurement generator: invalid interval '${generator.interval}' (e.g. 30s, 5m, 1h, 1d)`)
  }
  if (generator.series.length === 0) {
    throw new TypeError('measurement generator: no series')
  }
  const step = Number(match[1]) * UNIT_MS[match[2]!]!
  const start = parseTime(generator.from, 'from')
  const live = generator.to === undefined
  if (block === undefined) {
    if (live) {
      block = pointsUntil(start, step, Number.MAX_SAFE_INTEGER, now) + LIVE_CAPACITY
    } else {
      const end = parseTime(generator.to!, 'to')
      block = Math.max(0, Math.ceil((end - start) / step))
      if (block === 0) {
        throw new TypeError(`measurement generator: no grid point between ${generator.from} and ${generator.to}`)
      }
    }
  }
  const toIndex = (time: number) => Math.min(block, Math.max(0, Math.ceil((time - start) / step)))
  const ranges = (list: C8yTimeRange[] | undefined) => (list ?? []).map((range): Interval => [toIndex(parseTime(range.from, 'gap from')), toIndex(parseTime(range.to, 'gap to'))])
  const streamGaps = ranges(generator.gaps)
  const keys = new Set<string>()
  const series = generator.series.map((input): SeriesDef => {
    const key = `${input.fragment}.${input.series}`
    if (keys.has(key)) {
      throw new TypeError(`measurement generator: series ${key} twice`)
    }
    keys.add(key)
    const value = input.value
    let compute: (time: number, index: number) => number
    if (typeof value === 'number') {
      compute = () => value
    } else if (typeof value === 'function') {
      compute = value
    } else if (value && typeof value === 'object' && typeof value.base === 'number') {
      compute = waveFunction(value, start, `${generator.source}|${key}`)
    } else {
      throw new TypeError(`measurement generator: series ${key} has no value (a function value does not survive JSON)`)
    }
    return { fragment: input.fragment, name: input.series, unit: input.unit, value: compute, skips: normalize([...streamGaps, ...ranges(input.gaps)]) }
  })
  const fragments = new Map<string, number[]>()
  series.forEach((def, index) => fragments.set(def.fragment, [...(fragments.get(def.fragment) ?? []), index]))
  let holes: Interval[] = [[0, block]]
  for (const def of series) {
    holes = intersect(holes, def.skips)
  }
  return { idStart, block, generator, sourceId: generator.source, type: generator.type, start, step, live, series, fragments: [...fragments], holes }
}

/**
 * Seeds generators: reserves ids in one step instead of one `newId()` per point.
 * @param generators - The tenant's generators
 * @param inputs - Generators, their sources resolved to ids
 * @param reserve - Reserves `count` ids and returns the first
 * @param now - The world's clock (epoch milliseconds)
 * @returns The first id number and the number of reserved ids, per input
 */
export function seedGenerators(generators: Collection<MeasurementStream>, inputs: Array<C8yMeasurementGeneratorInput<string>>, reserve: (count: number) => number, now: number): Array<{ idStart: number, block: number }> {
  return inputs.map((input) => {
    const stream = compileGenerator(clone(input), 0, undefined, now)
    const idStart = reserve(stream.block)
    generators.set(String(idStart), { ...stream, idStart })
    return { idStart, block: stream.block }
  })
}

// ---------------------------------------------------------------- documents

/**
 * The stored form of the generated document at grid index `i` (it must exist).
 * @param stream - Generator
 * @param i - Grid index
 * @param ids - The world's measurement id format
 */
export function generatedDocument(stream: MeasurementStream, i: number, ids: MeasurementIds): StoredDocument {
  const time = stream.start + i * stream.step
  const iso = new Date(time).toISOString()
  const document: Record<string, unknown> = { time: iso, source: { id: stream.sourceId }, type: stream.type }
  for (const [fragment, indexes] of stream.fragments) {
    let value: Record<string, unknown> | undefined
    for (const index of indexes) {
      const def = stream.series[index]!
      if (def.skips.length > 0 && containing(def.skips, i) >= 0) {
        continue
      }
      value ??= {}
      value[def.name] = def.unit === undefined ? { value: def.value(time, i) } : { value: def.value(time, i), unit: def.unit }
    }
    if (value) {
      document[fragment] = value
    }
  }
  document.id = ids.measurementId(stream.idStart + i)
  document.creationTime = iso
  return document as StoredDocument
}

/**
 * A series value of a measurement.
 */
export interface MeasurementPoint {
  time: number
  fragment: string
  name: string
  value: number
  unit: unknown
}

/**
 * The series values (`fragment.series` with a numeric `value`) of a stored
 * measurement, in document order.
 * @param document - Stored measurement
 */
export function documentPoints(document: StoredDocument): MeasurementPoint[] {
  const points: MeasurementPoint[] = []
  for (const [fragment, fragmentValue] of Object.entries(document)) {
    if (!fragmentValue || typeof fragmentValue !== 'object' || Array.isArray(fragmentValue) || fragment === 'source') {
      continue
    }
    for (const [name, entry] of Object.entries(fragmentValue as Record<string, any>)) {
      if (entry && typeof entry === 'object' && typeof entry.value === 'number') {
        points.push({ time: parseIsoTime(document.time), fragment, name, value: entry.value, unit: entry.unit })
      }
    }
  }
  return points
}

// ---------------------------------------------------------------- the merged view

/**
 * A measurement filter, as parsed from the query.
 */
export interface MeasurementQuery {
  sources?: ReadonlySet<string>
  types?: readonly string[]
  valueFragmentType?: string
  valueFragmentSeries?: string
  /**
   * A fragment the documents must have (a list's `fragmentType`).
   */
  fragmentType?: string
  dateFrom?: number
  dateTo?: number
  /**
   * Equal bounds: exactly this instant.
   */
  exact?: number
}

interface Plan {
  s: number
  window: Interval
  excluded: Interval[]
  sums: number[]
  /**
   * Point tombstones in the window, outside `excluded`.
   */
  points: Set<number>
}

interface ParsedRange {
  source: string | undefined
  types: string[] | undefined
  fragmentType: string | undefined
  from: number | undefined
  to: number | undefined
  until: number | undefined
}

interface Sorted {
  time: number
  id: number
  document: StoredDocument
}

/**
 * Parses the date bounds of a query: equal bounds mean exactly that instant.
 * @param from - Epoch milliseconds or undefined
 * @param to - Epoch milliseconds or undefined
 */
export function dateBounds(from: number | undefined, to: number | undefined): Pick<MeasurementQuery, 'dateFrom' | 'dateTo' | 'exact'> {
  if (from !== undefined && to !== undefined && from === to) {
    return { exact: from }
  }
  return { ...(from !== undefined ? { dateFrom: from } : {}), ...(to !== undefined ? { dateTo: to } : {}) }
}

/**
 * Per generator collection: the streams in id order, by source, and the
 * sequence numbers of point tombstones already decoded (by tombstone).
 */
const views = new WeakMap<Collection<MeasurementStream>, { size: number, streams: MeasurementStream[], bySource: Map<string, number[]>, sequences: WeakMap<MeasurementTombstone, number> }>()

/**
 * The generated documents of a tenant at one instant, without the deleted ones.
 */
export class GeneratedView {
  readonly streams: MeasurementStream[]
  readonly bySource: Map<string, number[]>
  readonly now: number
  readonly #ranges: ParsedRange[] = []
  readonly #points = new Map<number, Set<number>>()
  readonly #ids: MeasurementIds
  readonly #sequences: WeakMap<MeasurementTombstone, number>

  /**
   * @param generators - The tenant's generators
   * @param tombstones - The tenant's tombstones
   * @param now - The world's clock (epoch milliseconds)
   * @param ids - The world's measurement id format
   */
  constructor(generators: Collection<MeasurementStream>, tombstones: Collection<MeasurementTombstone>, now: number, ids: MeasurementIds) {
    this.#ids = ids
    // the stream index of a collection: streams only get added
    let index = views.get(generators)
    if (!index || index.size !== generators.size) {
      const streams = [...generators.values()].sort((a, b) => a.idStart - b.idStart)
      const bySource = new Map<string, number[]>()
      streams.forEach((stream, s) => bySource.set(stream.sourceId, [...(bySource.get(stream.sourceId) ?? []), s]))
      index = { size: generators.size, streams, bySource, sequences: new WeakMap() }
      views.set(generators, index)
    }
    this.streams = index.streams
    this.bySource = index.bySource
    this.#sequences = index.sequences
    this.now = now
    for (const tombstone of tombstones.values()) {
      this.#add(tombstone)
    }
  }

  #add(tombstone: MeasurementTombstone): void {
    if (tombstone.kind === 'range') {
      this.#ranges.push({
        source: tombstone.source,
        types: tombstone.type === undefined ? undefined : [tombstone.type],
        fragmentType: tombstone.fragmentType,
        from: tombstone.dateFrom === undefined ? undefined : Date.parse(tombstone.dateFrom),
        to: tombstone.dateTo === undefined ? undefined : Date.parse(tombstone.dateTo),
        until: tombstone.until === undefined ? undefined : Date.parse(tombstone.until),
      })
      return
    }
    // every view decodes every tombstone: decode each one once
    let n = this.#sequences.get(tombstone)
    if (n === undefined) {
      n = this.#ids.measurementSequence(tombstone.id)
      this.#sequences.set(tombstone, n)
    }
    const at = this.locate(n)
    if (at) {
      const set = this.#points.get(at[0]) ?? new Set()
      set.add(at[1])
      this.#points.set(at[0], set)
    }
  }

  /**
   * Grid points of a stream now.
   * @param stream
   */
  size(stream: MeasurementStream): number {
    return stream.live ? pointsUntil(stream.start, stream.step, stream.block, this.now) : stream.block
  }

  /**
   * Stream index and grid index of a sequence number (whether or not the
   * document exists).
   * @param id - Sequence number (`NaN` for none)
   */
  locate(id: number): [number, number] | undefined {
    let lo = 0
    let hi = this.streams.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.streams[mid]!.idStart <= id) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    const s = lo - 1
    const stream = this.streams[s]
    if (!stream || !Number.isInteger(id) || id >= stream.idStart + stream.block) {
      return undefined
    }
    return [s, id - stream.idStart]
  }

  /**
   * The generated document with this id, if it exists now and is not deleted.
   * @param id
   */
  get(id: string): StoredDocument | undefined {
    const at = this.locate(this.#ids.measurementSequence(id))
    if (!at) {
      return undefined
    }
    const [s, i] = at
    const plan = this.plan(s, {})
    if (!plan || i < plan.window[0] || i >= plan.window[1] || containing(plan.excluded, i) >= 0 || plan.points.has(i)) {
      return undefined
    }
    return generatedDocument(this.streams[s]!, i, this.#ids)
  }

  #streamMatches(stream: MeasurementStream, q: MeasurementQuery): boolean {
    if (q.sources && !q.sources.has(stream.sourceId)) {
      return false
    }
    if (q.types && !q.types.includes(stream.type)) {
      return false
    }
    if (q.valueFragmentType !== undefined) {
      const entry = stream.fragments.find(([fragment]) => fragment === q.valueFragmentType)
      if (!entry) {
        return false
      }
      if (q.valueFragmentSeries !== undefined && !entry[1].some((index) => stream.series[index]!.name === q.valueFragmentSeries)) {
        return false
      }
    } else if (q.valueFragmentSeries !== undefined && !stream.series.some((def) => def.name === q.valueFragmentSeries)) {
      return false
    }
    if (q.fragmentType !== undefined && !stream.fragments.some(([fragment]) => fragment === q.fragmentType)) {
      return false
    }
    return true
  }

  /**
   * Grid index range of a time window, within `[0, n)`.
   * @param stream
   * @param n
   * @param from
   * @param to
   * @param exact
   */
  #window(stream: MeasurementStream, n: number, from: number | undefined, to: number | undefined, exact: number | undefined): Interval {
    if (exact !== undefined) {
      const k = (exact - stream.start) / stream.step
      return Number.isInteger(k) && k >= 0 && k < n ? [k, k + 1] : [0, 0]
    }
    const a = from === undefined ? 0 : Math.min(n, Math.max(0, Math.ceil((from - stream.start) / stream.step)))
    const b = to === undefined ? n : Math.min(n, Math.max(0, Math.ceil((to - stream.start) / stream.step)))
    return [a, Math.max(a, b)]
  }

  /**
   * Grid index intervals without a value of this fragment (and series).
   * @param stream
   * @param n
   * @param fragment
   * @param series
   */
  #absent(stream: MeasurementStream, n: number, fragment: string, series?: string): Interval[] {
    const entry = stream.fragments.find(([name]) => name === fragment)
    let absent: Interval[] = [[0, n]]
    for (const index of entry?.[1] ?? []) {
      const def = stream.series[index]!
      if (series === undefined || def.name === series) {
        absent = intersect(absent, def.skips)
      }
    }
    return absent
  }

  /**
   * The documents of a stream a query matches: a window, the excluded grid
   * intervals (gaps, absent fragments, range tombstones), and point tombstones.
   * @param s
   * @param q
   */
  plan(s: number, q: MeasurementQuery): Plan | undefined {
    const stream = this.streams[s]!
    if (!this.#streamMatches(stream, q)) {
      return undefined
    }
    const n = this.size(stream)
    const window = this.#window(stream, n, q.dateFrom, q.dateTo, q.exact)
    if (window[1] <= window[0]) {
      return undefined
    }
    const excluded: Interval[] = [...stream.holes]
    if (q.valueFragmentType !== undefined) {
      excluded.push(...this.#absent(stream, n, q.valueFragmentType, q.valueFragmentSeries))
    } else if (q.valueFragmentSeries !== undefined) {
      // a series of this name in any fragment
      let absent: Interval[] = [[0, n]]
      for (const def of stream.series) {
        if (def.name === q.valueFragmentSeries) {
          absent = intersect(absent, def.skips)
        }
      }
      excluded.push(...absent)
    }
    if (q.fragmentType !== undefined) {
      excluded.push(...this.#absent(stream, n, q.fragmentType))
    }
    for (const range of this.#ranges) {
      if ((range.source !== undefined && range.source !== stream.sourceId) || (range.types && !range.types.includes(stream.type))) {
        continue
      }
      // a live generator keeps the points that came after the delete
      const limit = stream.live && range.until !== undefined ? pointsUntil(stream.start, stream.step, n, range.until) : n
      let hit: Interval[] = [this.#window(stream, limit, range.from, range.to, undefined)]
      if (range.fragmentType !== undefined) {
        hit = intersect(hit, complement(this.#absent(stream, n, range.fragmentType), n))
      }
      excluded.push(...hit)
    }
    const merged = normalize(excluded)
    const points = new Set<number>()
    for (const i of this.#points.get(s) ?? []) {
      if (i >= window[0] && i < window[1] && containing(merged, i) < 0) {
        points.add(i)
      }
    }
    return { s, window, excluded: merged, sums: prefixSums(merged), points }
  }

  /**
   * Plans of every stream a query matches, in id order.
   * @param q
   */
  plans(q: MeasurementQuery): Plan[] {
    const indexes = q.sources
      ? [...q.sources].flatMap((source) => this.bySource.get(source) ?? []).sort((a, b) => a - b)
      : this.streams.map((_stream, s) => s)
    const plans: Plan[] = []
    for (const s of indexes) {
      const plan = this.plan(s, q)
      if (plan) {
        plans.push(plan)
      }
    }
    return plans
  }

  /**
   * Documents of a plan with grid index in `[a, b)`.
   * @param plan
   * @param a
   * @param b
   */
  static count(plan: Plan, a: number, b: number): number {
    a = Math.max(a, plan.window[0])
    b = Math.min(b, plan.window[1])
    if (b <= a) {
      return 0
    }
    let points = 0
    for (const i of plan.points) {
      if (i >= a && i < b) {
        points++
      }
    }
    return b - a - (covered(plan.excluded, plan.sums, b) - covered(plan.excluded, plan.sums, a)) - points
  }

  /**
   * Number of generated documents a query matches.
   * @param q
   */
  total(q: MeasurementQuery): number {
    let total = 0
    for (const plan of this.plans(q)) {
      total += GeneratedView.count(plan, 0, Infinity)
    }
    return total
  }

  /**
   * The next grid index of a plan with a document, from `i` in a direction, or -1.
   * @param plan
   * @param i
   * @param direction
   */
  static #valid(plan: Plan, i: number, direction: 1 | -1): number {
    for (;;) {
      if (i < plan.window[0] || i >= plan.window[1]) {
        return -1
      }
      const k = containing(plan.excluded, i)
      if (k >= 0) {
        i = direction < 0 ? plan.excluded[k]![0] - 1 : plan.excluded[k]![1]
        continue
      }
      if (plan.points.has(i)) {
        i += direction
        continue
      }
      return i
    }
  }

  /**
   * The merged list of generated and stored documents: newest first (or
   * oldest first), documents of the same time by ascending id, like the
   * stored list (whose order of the same time is the creation order).
   * @param q - The filter
   * @param stored - The stored documents the filter matches, in list order
   * @param newestFirst - Order
   * @returns The total and pages of the list, without building it
   */
  list(q: MeasurementQuery, stored: readonly StoredDocument[], newestFirst: boolean): { total: () => number, page: (offset: number, size: number) => StoredDocument[] } {
    const plans = this.plans(q)
    const items: Sorted[] = stored.map((document) => ({ time: parseIsoTime(document.time), id: this.#ids.measurementSequence(document.id), document }))
    let cached: number | undefined
    const total = () => (cached ??= plans.reduce((sum, plan) => sum + GeneratedView.count(plan, 0, Infinity), 0) + items.length)
    return {
      total,
      page: (offset, size) => (offset >= total() ? [] : this.#page(plans, items, newestFirst, offset, size)),
    }
  }

  #page(plans: Plan[], stored: Sorted[], newestFirst: boolean, offset: number, size: number): StoredDocument[] {
    const streams = this.streams
    const timeOf = (s: number, i: number) => streams[s]!.start + i * streams[s]!.step
    // stored documents before time t in list order (the list is sorted)
    const storedAhead = (t: number) => {
      let lo = 0
      let hi = stored.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (newestFirst ? stored[mid]!.time > t : stored[mid]!.time < t) {
          lo = mid + 1
        } else {
          hi = mid
        }
      }
      return lo
    }
    // documents strictly before time t in list order
    const ahead = (t: number) => {
      let count = storedAhead(t)
      for (const plan of plans) {
        const stream = streams[plan.s]!
        const k = (t - stream.start) / stream.step
        count += newestFirst ? GeneratedView.count(plan, Math.floor(k) + 1, Infinity) : GeneratedView.count(plan, 0, Math.ceil(k))
      }
      return count
    }
    let lo = Infinity
    let hi = -Infinity
    for (const plan of plans) {
      lo = Math.min(lo, timeOf(plan.s, plan.window[0]))
      hi = Math.max(hi, timeOf(plan.s, plan.window[1] - 1))
    }
    for (const item of stored) {
      lo = Math.min(lo, item.time)
      hi = Math.max(hi, item.time)
    }
    if (lo > hi || size <= 0) {
      return []
    }
    // the time of the document at `offset`
    let a = lo
    let b = hi
    if (newestFirst) {
      while (a < b) {
        const mid = Math.floor((a + b) / 2)
        if (ahead(mid) <= offset) {
          b = mid
        } else {
          a = mid + 1
        }
      }
    } else {
      while (a < b) {
        const mid = Math.ceil((a + b) / 2)
        if (ahead(mid) <= offset) {
          a = mid
        } else {
          b = mid - 1
        }
      }
    }
    const t0 = a
    let skip = offset - ahead(t0)
    if (skip < 0) {
      return []
    }

    // k-way merge from t0
    interface Cursor { plan: Plan | undefined, i: number, time: number, id: number }
    const heap: Cursor[] = []
    const less = (x: Cursor, y: Cursor) => (x.time !== y.time ? (newestFirst ? x.time > y.time : x.time < y.time) : x.id < y.id)
    const push = (cursor: Cursor) => {
      heap.push(cursor)
      let k = heap.length - 1
      while (k > 0) {
        const parent = (k - 1) >> 1
        if (!less(heap[k]!, heap[parent]!)) {
          break
        }
        [heap[k], heap[parent]] = [heap[parent]!, heap[k]!]
        k = parent
      }
    }
    const pop = (): Cursor => {
      const top = heap[0]!
      const last = heap.pop()!
      if (heap.length > 0) {
        heap[0] = last
        let k = 0
        for (;;) {
          const l = 2 * k + 1
          const r = l + 1
          let m = k
          if (l < heap.length && less(heap[l]!, heap[m]!)) {
            m = l
          }
          if (r < heap.length && less(heap[r]!, heap[m]!)) {
            m = r
          }
          if (m === k) {
            break
          }
          [heap[k], heap[m]] = [heap[m]!, heap[k]!]
          k = m
        }
      }
      return top
    }
    const direction = newestFirst ? -1 : 1
    const pushPlan = (plan: Plan, from: number) => {
      const i = GeneratedView.#valid(plan, from, direction)
      if (i >= 0) {
        push({ plan, i, time: timeOf(plan.s, i), id: streams[plan.s]!.idStart + i })
      }
    }
    for (const plan of plans) {
      const stream = streams[plan.s]!
      const k = (t0 - stream.start) / stream.step
      pushPlan(plan, newestFirst ? Math.min(Math.floor(k), plan.window[1] - 1) : Math.max(Math.ceil(k), plan.window[0]))
    }
    const firstStored = storedAhead(t0)
    if (firstStored < stored.length) {
      push({ plan: undefined, i: firstStored, time: stored[firstStored]!.time, id: stored[firstStored]!.id })
    }
    const page: StoredDocument[] = []
    while (heap.length > 0 && page.length < size) {
      const cursor = pop()
      if (skip > 0) {
        skip--
      } else {
        page.push(cursor.plan ? generatedDocument(streams[cursor.plan.s]!, cursor.i, this.#ids) : stored[cursor.i]!.document)
      }
      if (cursor.plan) {
        pushPlan(cursor.plan, cursor.i + direction)
      } else if (cursor.i + 1 < stored.length) {
        const next = stored[cursor.i + 1]!
        push({ plan: undefined, i: cursor.i + 1, time: next.time, id: next.id })
      }
    }
    return page
  }

  /**
   * Generated and stored documents a query matches, in id order (creation
   * order), lazily.
   * @param q - The filter
   * @param stored - The stored documents the filter matches
   */
  * documents(q: MeasurementQuery, stored: Iterable<StoredDocument>): IterableIterator<StoredDocument> {
    for (const item of this.#inIdOrder(q, stored)) {
      if ('plan' in item) {
        const stream = this.streams[item.plan.s]!
        for (const i of this.#indexes(item.plan)) {
          yield generatedDocument(stream, i, this.#ids)
        }
      } else {
        yield item.document
      }
    }
  }

  /**
   * Series values (`fragment.series` with a numeric `value`) of the documents
   * a query matches, in id order and document order.
   * @param q - The filter
   * @param stored - The stored documents the filter matches
   */
  * points(q: MeasurementQuery, stored: Iterable<StoredDocument>): IterableIterator<MeasurementPoint> {
    for (const item of this.#inIdOrder(q, stored)) {
      if ('plan' in item) {
        const stream = this.streams[item.plan.s]!
        for (const i of this.#indexes(item.plan)) {
          const time = stream.start + i * stream.step
          for (const [, indexes] of stream.fragments) {
            for (const index of indexes) {
              const def = stream.series[index]!
              if (def.skips.length === 0 || containing(def.skips, i) < 0) {
                yield { time, fragment: def.fragment, name: def.name, value: def.value(time, i), unit: def.unit }
              }
            }
          }
        }
        continue
      }
      yield* documentPoints(item.document)
    }
  }

  /**
   * The series of a source in the order of their first value (id order),
   * like the stored `supportedSeries`.
   * @param source - Managed object id
   * @param stored - The source's stored documents
   */
  supportedSeries(source: string, stored: Iterable<StoredDocument>): Array<[fragment: string, series: string]> {
    const found: Array<{ id: number, position: number, key: [string, string] }> = []
    const seen = new Set<string>()
    for (const plan of this.plans({ sources: new Set([source]) })) {
      const stream = this.streams[plan.s]!
      let position = 0
      for (const [, indexes] of stream.fragments) {
        for (const index of indexes) {
          const def = stream.series[index]!
          const absent = normalize([...plan.excluded, ...def.skips])
          let i = plan.window[0]
          for (;;) {
            const k = containing(absent, i)
            if (k >= 0) {
              i = absent[k]![1]
            } else if (plan.points.has(i)) {
              i++
            } else {
              break
            }
          }
          if (i < plan.window[1]) {
            found.push({ id: stream.idStart + i, position, key: [def.fragment, def.name] })
          }
          position++
        }
      }
    }
    for (const document of stored) {
      let position = 0
      for (const [fragment, value] of Object.entries(document)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          continue
        }
        for (const [series, entry] of Object.entries(value as Record<string, unknown>)) {
          if (entry && typeof entry === 'object' && typeof (entry as { value?: unknown }).value === 'number') {
            found.push({ id: this.#ids.measurementSequence(document.id), position: position++, key: [fragment, series] })
          }
        }
      }
    }
    found.sort((x, y) => x.id - y.id || x.position - y.position)
    const result: Array<[string, string]> = []
    for (const { key } of found) {
      const name = `${key[0]}.${key[1]}`
      if (!seen.has(name)) {
        seen.add(name)
        result.push(key)
      }
    }
    return result
  }

  * #indexes(plan: Plan): IterableIterator<number> {
    let k = 0
    const excluded = plan.excluded
    for (let i = plan.window[0]; i < plan.window[1]; i++) {
      while (k < excluded.length && excluded[k]![1] <= i) {
        k++
      }
      if (k < excluded.length && excluded[k]![0] <= i) {
        i = excluded[k]![1] - 1
        continue
      }
      if (!plan.points.has(i)) {
        yield i
      }
    }
  }

  /**
   * Streams (as plans) and stored documents in id order. The ids of a
   * stream are one block, so no stored document lies between them.
   * @param q
   * @param stored
   */
  #inIdOrder(q: MeasurementQuery, stored: Iterable<StoredDocument>): Array<{ plan: Plan, id: number } | { document: StoredDocument, id: number }> {
    const items: Array<{ plan: Plan, id: number } | { document: StoredDocument, id: number }> = this.plans(q).map((plan) => ({ plan, id: this.streams[plan.s]!.idStart }))
    for (const document of stored) {
      items.push({ document, id: this.#ids.measurementSequence(document.id) })
    }
    return items.sort((a, b) => a.id - b.id)
  }
}

/**
 * The tenant's generated measurements now, or `undefined` without generators.
 * @param data - Tenant data
 */
export function generatedView(data: TenantData): GeneratedView | undefined {
  return data.measurementGenerators.size > 0 ? new GeneratedView(data.measurementGenerators, data.measurementTombstones, Date.parse(data.world.now()), data.world) : undefined
}

// ---------------------------------------------------------------- availability

/**
 * Time of the first grid point with a document after `time` (exclusive), on
 * the whole grid (also points a live generator has not reached yet), or
 * `undefined` after the last one.
 * @param stream - Generator
 * @param time - Epoch milliseconds
 */
export function nextPointTime(stream: MeasurementStream, time: number): number | undefined {
  let index = time < stream.start ? 0 : Math.floor((time - stream.start) / stream.step) + 1
  const hole = containing(stream.holes, index)
  if (hole >= 0) {
    index = stream.holes[hole]![1]
  }
  return index < stream.block ? stream.start + index * stream.step : undefined
}

/**
 * Time of the last grid point of the run of documents that has one at
 * `time`: the point before the next hole or the end of the grid.
 * @param stream - Generator
 * @param time - Time of a grid point with a document
 */
export function runEndTime(stream: MeasurementStream, time: number): number {
  const index = Math.round((time - stream.start) / stream.step)
  let lo = 0
  let hi = stream.holes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (stream.holes[mid]![0] <= index) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  const end = lo < stream.holes.length ? Math.min(stream.holes[lo]![0], stream.block) : stream.block
  return stream.start + (end - 1) * stream.step
}

/**
 * Time of the last grid point with a document at or before `time`, or
 * `-Infinity` before the first one.
 * @param stream - Generator
 * @param time - Epoch milliseconds
 */
export function lastPointTime(stream: MeasurementStream, time: number): number {
  if (time < stream.start) {
    return Number.NEGATIVE_INFINITY
  }
  let index = Math.min(Math.floor((time - stream.start) / stream.step), stream.block - 1)
  const hole = containing(stream.holes, index)
  if (hole >= 0) {
    index = stream.holes[hole]![0] - 1
  }
  return index >= 0 ? stream.start + index * stream.step : Number.NEGATIVE_INFINITY
}
