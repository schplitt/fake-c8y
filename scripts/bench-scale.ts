/**
 * Request latencies of a big synthetic inventory (devices in
 * lines of 20, lines in sites, 6 events, 0.5 alarms, and 2 stored
 * measurements per device), answered by a fork of the frozen world.
 *
 *   node --expose-gc scripts/bench-scale.ts [devices...]   (default: 10000 100000)
 *
 * Each request runs 3 times (once if the first run takes over 2 s); the
 * median is printed. Not part of `pnpm test:run`.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'

type Fake = typeof import('../src/index')
type World = import('../src/index').World

const ANCHOR = Date.parse('2026-10-24T00:00:00.000Z')
const print = (line: string) => process.stdout.write(`${line}\n`)

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

function build(fake: Fake, n: number): { world: World, devices: string[], lines: string[] } {
  const world = fake.createWorld({ now: () => ANCHOR })
  const devices: string[] = []
  const lines: string[] = []
  world.muted(() => {
    for (let d = 0; d < n; d++) {
      devices.push(world.device({
        name: `DEV-${d}`,
        type: ['nhv_Pump', 'nhv_Compressor', 'nhv_Gateway', 'nhv_Sensor'][d % 4]!,
        com_cumulocity_model_Agent: {},
        c8y_Hardware: { model: `M${d % 17}`, serialNumber: `SN-${d}` },
        c8y_Firmware: { name: 'os', version: ['3.4.1', '3.5.0', '2.9.9'][d % 3] },
        nhv_Location: { site: `S${d % 9}`, line: `L${d % 40}` },
        c8y_RequiredAvailability: { responseInterval: 60 },
        externalIds: { c8y_Serial: `SN-${d}` },
      }))
    }
    for (let g = 0; g < n / 20; g++) {
      lines.push(world.managedObject({ name: `Line ${g}`, type: 'c8y_DeviceSubgroup', c8y_IsDeviceGroup: {}, assets: devices.slice(g * 20, g * 20 + 20) }))
    }
    const siteCount = Math.max(1, n / 1000)
    for (let s = 0; s < siteCount; s++) {
      world.managedObject({ name: `Site ${s}`, type: 'c8y_DeviceGroup', c8y_IsDeviceGroup: {}, assets: lines.filter((_, g) => g % siteCount === s) })
    }
    const time = (offsetMs: number) => new Date(ANCHOR - offsetMs).toISOString()
    world.seed({
      events: Array.from({ length: n * 6 }, (_, i) => ({ source: devices[i % n]!, type: 'c8y_Event', text: `e${i}`, time: time(i * 7_000) })),
      alarms: Array.from({ length: n / 2 }, (_, i) => ({ source: devices[i * 2]!, type: `c8y_Alarm${i % 5}`, text: `a${i}`, severity: 'MAJOR', status: 'ACTIVE', time: time(i * 60_000) })),
      measurements: Array.from({ length: n * 2 }, (_, i) => ({ source: devices[i % n]!, type: 'c8y_Temperature', time: time(i * 5_000), c8y_Temperature: { T: { value: i % 50, unit: 'C' } } })),
    })
  })
  return { world, devices, lines }
}

/**
 * Median and first run (which builds the indexes of the frozen base) of a GET.
 * @param world - The world to ask
 * @param path - Path and query
 */
async function request(world: World, path: string): Promise<{ median: number, first: number }> {
  const times: number[] = []
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    const response = await world.fetch(new Request(world.baseUrl + path))
    await response.text()
    if (response.status >= 400) {
      throw new Error(`${path}: HTTP ${response.status}`)
    }
    times.push(performance.now() - start)
    if (times[0]! > 2000) {
      break
    }
  }
  const first = times[0]!
  return { median: times.sort((a, b) => a - b)[Math.floor((times.length - 1) / 2)]!, first }
}

async function post(world: World, path: string, body: unknown) {
  await world.fetch(new Request(world.baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
}

const sizes = process.argv.slice(2).map(Number)
const fake = await loadEngine()
const results = new Map<string, string[]>()
for (const n of sizes.length > 0 ? sizes : [10_000, 100_000]) {
  let start = performance.now()
  const { world, devices, lines } = build(fake, n)
  const buildSeconds = ((performance.now() - start) / 1000).toFixed(1)
  print(`${n} devices: build ${buildSeconds} s`)
  results.set('build', [...results.get('build') ?? [], `${buildSeconds} s`])
  start = performance.now()
  const fork = world.fork()
  print(`  fork ${(performance.now() - start).toFixed(0)} ms`)
  const q = (value: string) => encodeURIComponent(value)
  const device = devices[Math.floor(n * 0.777)]!
  const cases: Array<[string, string]> = [
    ['inventory pageSize=5', '/inventory/managedObjects?pageSize=5'],
    ['inventory pageSize=5 withTotalElements', '/inventory/managedObjects?pageSize=5&withTotalElements=true'],
    ['inventory pageSize=5 withParents', '/inventory/managedObjects?pageSize=5&withParents=true'],
    ['inventory pageSize=5 withGroups withChildrenCount', '/inventory/managedObjects?pageSize=5&withGroups=true&withChildrenCount=true'],
    ['inventory pageSize=2000', '/inventory/managedObjects?pageSize=2000'],
    ['inventory query type eq', `/inventory/managedObjects?pageSize=100&query=${q('$filter=(type eq \'nhv_Pump\')')}`],
    ['inventory text=SN-777', '/inventory/managedObjects?text=SN-777'],
    ['inventory onlyRoots=true', '/inventory/managedObjects?onlyRoots=true&withTotalElements=true'],
    ['inventory count text=SN-777', '/inventory/managedObjects/count?text=SN-777'],
    ['childAssets of a line', `/inventory/managedObjects/${lines[7]}/childAssets`],
    ['events pageSize=5', '/event/events?pageSize=5'],
    ['events source=X', `/event/events?source=${device}`],
    ['alarms pageSize=5 withTotalElements', '/alarm/alarms?pageSize=5&withTotalElements=true'],
    ['alarms source=X', `/alarm/alarms?source=${device}`],
    ['measurements pageSize=5', '/measurement/measurements?pageSize=5'],
    ['measurements source=X', `/measurement/measurements?source=${device}`],
    ['tenant statistics', '/tenant/statistics?pageSize=31'],
  ]
  const format = (ms: number) => (ms < 10 ? ms.toFixed(2) : ms.toFixed(0))
  const run = async (label: string, path: string) => {
    const { median, first } = await request(fork, path)
    print(`  ${label}: ${format(median)} ms${first > 2 * median && first > 1 ? ` (first call ${format(first)} ms)` : ''}`)
    results.set(label, [...results.get(label) ?? [], format(median)])
  }
  for (const [label, path] of cases) {
    await run(label, path)
  }
  // the fork's own documents are merged into the base's indexes
  const time = new Date(ANCHOR - 3_600_000).toISOString()
  await post(fork, '/event/events', { source: { id: device }, type: 'c8y_Event', text: 'new', time })
  await post(fork, '/alarm/alarms', { source: { id: device }, type: 'c8y_NewAlarm', text: 'new', severity: 'MINOR', time })
  await post(fork, '/measurement/measurements', { source: { id: device }, type: 'c8y_Temperature', time, c8y_Temperature: { T: { value: 1, unit: 'C' } } })
  await run('events pageSize=5 after a write', '/event/events?pageSize=5')
  await run('events source=X after a write', `/event/events?source=${device}`)
  await run('alarms pageSize=5 after a write', '/alarm/alarms?pageSize=5')
  await run('measurements pageSize=5 after a write', '/measurement/measurements?pageSize=5')
  await post(fork, '/inventory/managedObjects', { name: 'new device', c8y_IsDevice: {} })
  await post(fork, `/inventory/managedObjects/${lines[3]}/childAssets`, { managedObject: { id: devices[0]! } })
  await run('tenant statistics after a write', '/tenant/statistics?pageSize=31')
  await run('inventory pageSize=5 after a write', '/inventory/managedObjects?pageSize=5')
  await run('inventory pageSize=5 withParents after a write', '/inventory/managedObjects?pageSize=5&withParents=true')
  const timed = (label: string, action: () => unknown) => {
    const start = performance.now()
    action()
    const ms = performance.now() - start
    print(`  ${label}: ${format(ms)} ms`)
    results.set(label, [...results.get(label) ?? [], format(ms)])
  }
  timed('db.managedObjects.get(id)', () => fork.db.managedObjects.get(device))
  timed('db.events.find({ source })', () => fork.db.events.find({ source: device }))
  // the availability monitor: every device turns UNAVAILABLE and gets an alarm
  const monitored = world.fork({ clock: fake.createClock({ start: ANCHOR, realtime: false }) })
  timed('advance 4h (an unavailability alarm per device)', () => {
    monitored.advance(2 * 3_600_000)
    monitored.advance(2 * 3_600_000)
  })
  const postTimes: number[] = []
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    await post(monitored, '/alarm/alarms', { source: { id: devices[i]! }, type: 'c8y_NewAlarm', text: 'new', severity: 'MINOR', time })
    postTimes.push(performance.now() - start)
  }
  const postMedian = postTimes.sort((a, b) => a - b)[1]!
  print(`  POST alarm after the monitor: ${format(postMedian)} ms`)
  results.set('POST alarm after the monitor', [...results.get('POST alarm after the monitor') ?? [], format(postMedian)])
  const monitoredRun = async (label: string, path: string) => {
    const { median, first } = await request(monitored, path)
    print(`  ${label}: ${format(median)} ms${first > 2 * median && first > 1 ? ` (first call ${format(first)} ms)` : ''}`)
    results.set(label, [...results.get(label) ?? [], format(median)])
  }
  await monitoredRun('alarms pageSize=5 after the monitor', '/alarm/alarms?pageSize=5')
  await monitoredRun('alarms source=X after the monitor', `/alarm/alarms?source=${device}`)
}
print('')
print(`| request | ${(sizes.length > 0 ? sizes : [10_000, 100_000]).join(' | ')} |`)
for (const [label, values] of results) {
  print(`| ${label} | ${values.map((value) => (value.endsWith(' s') ? value : `${value} ms`)).join(' | ')} |`)
}
