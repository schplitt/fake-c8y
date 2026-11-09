/**
 * Benchmark of forks against snapshot/restore at the size of a mid-sized
 * test world (1,039 devices in 54 groups, ~215k measurements, ~6.6k events,
 * ~500 alarms, 135 operations).
 *
 *   node --expose-gc scripts/bench-fork.ts [fixtures dir]
 *
 * The fixtures dir holds a world of your own (`inventory.json`,
 * `series.json`, `events.json`, `alarms.json`, `operations.json`; default
 * `$FAKE_C8Y_WORLD`). Without it, the script generates a world of the same
 * size. Not part of `pnpm test:run`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'

type Fake = typeof import('../src/index')
type World = import('../src/index').World

const ANCHOR = Date.parse('2026-10-24T00:00:00.000Z')
const iso = (offsetMinutes: number) => new Date(ANCHOR + offsetMinutes * 60_000).toISOString()

/**
 * The engine, bundled from src (node cannot import its extensionless paths).
 */
async function loadEngine(): Promise<Fake> {
  const bundle = await rolldown({ input: fileURLToPath(new URL('../src/index.ts', import.meta.url)), platform: 'neutral' })
  const { output } = await bundle.generate({ format: 'esm', codeSplitting: false })
  const file = join(await mkdtemp(join(tmpdir(), 'fake-c8y-bench-')), 'index.mjs')
  await writeFile(file, output[0].code)
  return await import(pathToFileURL(file).href) as Fake
}

interface WorldObject { key: string, name: string, type: string, externalIds?: Record<string, string>, fragments?: Record<string, unknown>, assetOf?: string[], deviceOf?: string[], additionOf?: string[] }
interface SeriesSpec { source: string, type: string, fragment: string, series: string, unit?: string, intervalMinutes: number, base: number, noise?: number, fromOffset?: number, toOffset?: number }

interface Fixtures {
  objects: WorldObject[]
  specs: SeriesSpec[]
  events: Array<{ source: string, type: string, text: string, offset: number, fragments?: Record<string, unknown> }>
  alarms: Array<{ source: string, type: string, text: string, severity: string, status: string, offset: number }>
  operations: Array<{ source: string, status: string, offset: number, fragment: Record<string, unknown> }>
}

function readFixtures(dir: string): Fixtures {
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
  return {
    objects: read('inventory.json').objects,
    specs: read('series.json').specs,
    events: read('events.json').events,
    alarms: read('alarms.json').alarms,
    operations: read('operations.json').operations,
  }
}

/**
 * A world of the same size, with generated content.
 */
function generatedFixtures(): Fixtures {
  const groups: WorldObject[] = Array.from({ length: 54 }, (_, i) => ({ key: `grp:${i}`, name: `Group ${i}`, type: 'c8y_DeviceGroup', fragments: { c8y_IsDeviceGroup: {} }, assetOf: i === 0 ? [] : ['grp:0'] }))
  const devices: WorldObject[] = Array.from({ length: 1039 }, (_, i) => ({
    key: `dev:${i}`,
    name: `DEV-${i}`,
    type: 'nhv_Device',
    externalIds: { c8y_Serial: `SN-${i}` },
    fragments: { c8y_IsDevice: {}, com_cumulocity_model_Agent: {}, c8y_Hardware: { model: 'm', serialNumber: `SN-${i}` }, c8y_Firmware: { name: 'os', version: '3.4.1' }, nhv_Location: { site: `S${i % 9}`, line: `L${i % 40}` } },
    assetOf: [`grp:${1 + (i % 53)}`],
  }))
  const specs: SeriesSpec[] = devices.flatMap((device, i) => [
    { source: device.key, type: 'c8y_Temperature', fragment: 'c8y_Temperature', series: 'T', unit: 'C', intervalMinutes: i % 10 === 0 ? 15 : 240, base: 20, noise: 3 },
  ])
  return {
    objects: [...groups, ...devices],
    specs,
    events: Array.from({ length: 6644 }, (_, i) => ({ source: `dev:${i % 1039}`, type: 'c8y_Event', text: `event ${i}`, offset: -i * 6 })),
    alarms: Array.from({ length: 499 }, (_, i) => ({ source: `dev:${i * 2}`, type: 'c8y_Alarm', text: `alarm ${i}`, severity: 'MAJOR', status: 'ACTIVE', offset: -i * 60 })),
    operations: Array.from({ length: 135 }, (_, i) => ({ source: `dev:${i}`, status: 'SUCCESSFUL', offset: -i * 60, fragment: { c8y_Restart: {} } })),
  }
}

/**
 * Seeds the world: objects with their relations (children before parents),
 * external ids, measurements (one document per source, type, and time),
 * events, alarms, and operations.
 * @param world - The world
 * @param fixtures - World content
 */
function seed(world: World, fixtures: Fixtures): Map<string, string> {
  const ids = new Map<string, string>()
  const children = new Map<string, Record<'assets' | 'children' | 'additions', string[]>>()
  for (const object of fixtures.objects) {
    for (const [field, parents] of [['assets', object.assetOf], ['children', object.deviceOf], ['additions', object.additionOf]] as const) {
      for (const parent of parents ?? []) {
        const entry = children.get(parent) ?? { assets: [], children: [], additions: [] }
        entry[field].push(object.key)
        children.set(parent, entry)
      }
    }
  }
  const byKey = new Map(fixtures.objects.map((object) => [object.key, object]))
  // the fixtures have a duplicate on purpose (a quirk): the first one keeps the external id
  const taken = new Set<string>()
  const create = (key: string): string => {
    const known = ids.get(key)
    if (known) {
      return known
    }
    const object = byKey.get(key)!
    const relations = children.get(key) ?? { assets: [], children: [], additions: [] }
    const externalIds = Object.fromEntries(Object.entries(object.externalIds ?? {}).filter((entry) => !taken.has(entry.join('/'))))
    for (const entry of Object.entries(externalIds)) {
      taken.add(entry.join('/'))
    }
    const id = world.managedObject({
      name: object.name,
      type: object.type,
      ...object.fragments,
      externalIds,
      assets: relations.assets.map(create),
      children: relations.children.map(create),
      additions: relations.additions.map(create),
    })
    ids.set(key, id)
    return id
  }
  for (const object of fixtures.objects) {
    create(object.key)
  }
  const measurements = new Map<string, Record<string, any>>()
  for (const spec of fixtures.specs) {
    for (let offset = spec.fromOffset ?? -43_200; offset < (spec.toOffset ?? 0); offset += spec.intervalMinutes) {
      const key = `${spec.source}|${spec.type}|${offset}`
      const document = measurements.get(key) ?? { source: ids.get(spec.source)!, type: spec.type, time: iso(offset) }
      document[spec.fragment] = { ...document[spec.fragment], [spec.series]: { value: spec.base + ((offset * 7919) % 100) / 100 * (spec.noise ?? 0), ...(spec.unit ? { unit: spec.unit } : {}) } }
      measurements.set(key, document)
    }
  }
  world.seed({
    measurements: [...measurements.values()] as any,
    events: fixtures.events.map((event) => ({ source: ids.get(event.source)!, type: event.type, text: event.text, time: iso(event.offset), ...event.fragments })),
    alarms: fixtures.alarms.map((alarm) => ({ source: ids.get(alarm.source)!, type: alarm.type, text: alarm.text, severity: alarm.severity as 'MAJOR', status: alarm.status as 'ACTIVE', time: iso(alarm.offset) })),
    operations: fixtures.operations.map((operation) => ({ deviceId: ids.get(operation.source)!, status: operation.status as 'SUCCESSFUL', ...operation.fragment })),
  })
  return ids
}

function time<T>(run: () => T): [T, number] {
  const start = performance.now()
  const result = run()
  return [result, performance.now() - start]
}

async function timeAsync<T>(run: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now()
  const result = await run()
  return [result, performance.now() - start]
}

function heap(): number {
  const gc = (globalThis as { gc?: () => void }).gc
  gc?.()
  gc?.()
  return process.memoryUsage().heapUsed
}

const print = (line: string) => process.stdout.write(`${line}\n`)
const ms = (value: number) => value < 1 ? `${(value * 1000).toFixed(0)} µs` : `${value.toFixed(value < 10 ? 1 : 0)} ms`
const mb = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

async function main(): Promise<void> {
  if (!(globalThis as { gc?: unknown }).gc) {
    console.warn('run with node --expose-gc for memory numbers')
  }
  const fake = await loadEngine()
  const dir = process.argv[2] ?? process.env.FAKE_C8Y_WORLD
  const fixtures = dir && existsSync(join(dir, 'inventory.json')) ? readFixtures(dir) : generatedFixtures()
  const now = () => ANCHOR

  const heapBefore = heap()
  const base = fake.createWorld({ now })
  const [ids, seedTime] = time(() => base.muted(() => seed(base, fixtures)))
  const counts = base.snapshot().tenants[0]!
  print(`world (${dir ? 'fixtures' : 'generated'}): ${counts.managedObjects.length} managed objects, ${counts.measurements.length} measurements, ${counts.events.length} events, ${counts.alarms.length} alarms, ${counts.operations.length} operations; seeded in ${ms(seedTime)}, heap ${mb(heap() - heapBefore)}`)

  const alarm = base.db.alarms.find({ status: 'ACTIVE' })[0]!.id as string
  const device = ids.get(fixtures.alarms[0]!.source)!
  const write = async (world: World) => {
    const headers = { 'content-type': 'application/json' }
    const response = await world.fetch(new Request(`${world.baseUrl}/alarm/alarms/${alarm}`, { method: 'PUT', headers, body: JSON.stringify({ status: 'ACKNOWLEDGED' }) }))
    if (response.status !== 200) {
      throw new Error(`write failed: ${response.status}`)
    }
  }
  const read = async (world: World, path: string) => (await world.fetch(new Request(`${world.baseUrl}${path}`))).status

  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

  // today: snapshot, restore, and diff on a plain world
  const plain = fake.createWorld({ now })
  plain.restore(base.snapshot())
  const [snapshot, snapshotTime] = time(() => plain.snapshot())
  const [, restoreTime] = time(() => plain.restore(snapshot))
  await write(plain)
  const [, plainDiffTime] = time(() => plain.diff(snapshot))
  const plainWrites: number[] = []
  for (let i = 0; i < 50; i++) {
    plainWrites.push((await timeAsync(() => write(plain)))[1])
  }

  // forks
  const [, freezeTime] = time(() => base.fork())
  const forkTimes: number[] = []
  const writeTimes: number[] = []
  const diffTimes: number[] = []
  const resetTimes: number[] = []
  for (let i = 0; i < 50; i++) {
    const [fork, forkTime] = time(() => base.fork())
    const [, writeTime] = await timeAsync(() => write(fork))
    const [diff, diffTime] = time(() => fork.diff())
    if (diff.tenants.t12345!.alarms.updated.length !== 1) {
      throw new Error('unexpected diff')
    }
    const [, resetTime] = time(() => fork.reset())
    forkTimes.push(forkTime)
    writeTimes.push(writeTime)
    diffTimes.push(diffTime)
    resetTimes.push(resetTime)
  }

  // memory of 100 live forks, each after a write
  const before = heap()
  const forks: World[] = []
  for (let i = 0; i < 100; i++) {
    const fork = base.fork()
    await write(fork)
    forks.push(fork)
  }
  const perFork = (heap() - before) / forks.length

  // read overhead of the overlay
  const fork = forks[0]!
  const reads = [
    `/inventory/managedObjects?pageSize=100&withTotalElements=true&query=${encodeURIComponent(`$filter=(type eq 'nhv_LineGateway' or has(c8y_IsDevice))`)}`,
    `/measurement/measurements?source=${device}&pageSize=100&withTotalElements=true`,
    `/alarm/alarms?pageSize=100&withTotalElements=true`,
  ]
  const readRows: string[] = []
  for (const path of reads) {
    const onPlain: number[] = []
    const onFork: number[] = []
    for (let i = 0; i < 7; i++) {
      onPlain.push((await timeAsync(() => read(plain, path)))[1])
      onFork.push((await timeAsync(() => read(fork, path)))[1])
    }
    readRows.push(`  GET ${path.split('?')[0]}: plain ${ms(median(onPlain))}, fork ${ms(median(onFork))}`)
  }

  print(`snapshot/restore (plain world): snapshot ${ms(snapshotTime)}, restore ${ms(restoreTime)}, diff(snapshot) ${ms(plainDiffTime)}, write ${ms(median(plainWrites))} (median of 50)`)
  print(`forks: first fork (freezes the base) ${ms(freezeTime)}; median of 50: fork ${ms(median(forkTimes))}, write ${ms(median(writeTimes))}, diff ${ms(median(diffTimes))}, reset ${ms(median(resetTimes))}`)
  print(`memory: ${mb(perFork)} per live fork (100 forks, one write each)`)
  print(`reads:\n${readRows.join('\n')}`)
}

await main()
