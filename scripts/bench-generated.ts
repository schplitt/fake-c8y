/**
 * Benchmark of generated measurement history at a mid-sized world: 1,000 devices
 * with 4 series each over 30 days, at 5 minutes and at 1 minute, as one
 * generator per device (4 series in one document) and as 4 generators per
 * device (one series each). Measures seeding, heap, the first fork, typical
 * reads, deletes, and snapshots.
 *
 *   node --expose-gc scripts/bench-generated.ts
 *
 * Not part of `pnpm test:run`.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'

type Fake = typeof import('../src/index')
type World = import('../src/index').World
type Generator = import('../src/index').C8yMeasurementGeneratorInput

const NOW = Date.parse('2026-10-24T00:00:00.000Z')
const DAY = 86_400_000
const DEVICES = 1000

async function loadEngine(): Promise<Fake> {
  const bundle = await rolldown({ input: fileURLToPath(new URL('../src/index.ts', import.meta.url)), platform: 'neutral' })
  const { output } = await bundle.generate({ format: 'esm', codeSplitting: false })
  const file = join(await mkdtemp(join(tmpdir(), 'fake-c8y-bench-')), 'index.mjs')
  await writeFile(file, output[0].code)
  return await import(pathToFileURL(file).href) as Fake
}

const gc = (globalThis as { gc?: () => void }).gc
function heap(): number {
  gc?.()
  gc?.()
  return process.memoryUsage().heapUsed
}

const print = (line: string) => process.stdout.write(`${line}\n`)
const ms = (start: number) => `${(performance.now() - start).toFixed(1)} ms`
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`

/**
 * Median time of a few runs of an async operation.
 * @param runs
 * @param operation
 */
async function time(runs: number, operation: () => Promise<unknown>): Promise<string> {
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    await operation()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]!
  return median < 1 ? `${(median * 1000).toFixed(0)} µs` : `${median.toFixed(1)} ms`
}

const SERIES = [['c8y_Temperature', 'T', 'C', 20], ['c8y_Humidity', 'H', '%', 50], ['c8y_Power', 'P', 'kW', 3], ['c8y_Vibration', 'V', 'mm/s', 1]] as const

function generators(devices: string[], interval: string, streamsPerDevice: 1 | 4): Generator[] {
  const from = new Date(NOW - 30 * DAY).toISOString()
  const to = new Date(NOW).toISOString()
  return devices.flatMap((source): Generator[] => {
    const series = SERIES.map(([fragment, name, unit, base]) => ({ fragment, series: name, unit, value: { base, dailyAmplitude: base / 10, noise: base / 20, trendPerDay: 0.01 } }))
    return streamsPerDevice === 1
      ? [{ source, type: 'nhv_Telemetry', from, to, interval, series }]
      : series.map((item) => ({ source, type: item.fragment, from, to, interval, series: [item] }))
  })
}

async function get(world: World, path: string, method = 'GET'): Promise<any> {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method }))
  return response.status === 204 ? undefined : await response.json()
}

async function variant(fake: Fake, interval: string, streamsPerDevice: 1 | 4): Promise<void> {
  const before = heap()
  let start = performance.now()
  const world = fake.createWorld({ now: () => NOW })
  const devices = Array.from({ length: DEVICES }, (_, i) => world.device({ name: `DEV-${i}`, type: 'nhv_Device' }))
  const inventory = ms(start)
  start = performance.now()
  world.seed({ measurementGenerators: generators(devices, interval, streamsPerDevice) })
  const seeded = ms(start)
  const loaded = heap()
  start = performance.now()
  const fork = world.fork()
  const firstFork = ms(start)
  const device = devices[123]!
  const first = await get(fork, `/measurement/measurements?source=${device}&pageSize=1&withTotalElements=true`)
  const documents = (await get(fork, '/measurement/measurements?pageSize=1&withTotalElements=true')).statistics.totalElements as number
  const values = documents * (streamsPerDevice === 1 ? 4 : 1)
  print(`\n${DEVICES} devices x 4 series x 30 days at ${interval}, ${streamsPerDevice} generator(s) per device: ${documents.toLocaleString()} documents, ${values.toLocaleString()} values (${first.statistics.totalElements.toLocaleString()} for one device)`)
  print(`  inventory ${inventory}, seed generators ${seeded}, heap of the world (with the ${DEVICES} devices) ${mb(loaded - before)}, first fork ${firstFork}`)
  const month = `dateFrom=${new Date(NOW - 30 * DAY).toISOString()}&dateTo=${new Date(NOW).toISOString()}`
  const rows: Array<[string, string]> = [
    ['source page (5) + total', await time(20, () => get(fork, `/measurement/measurements?source=${device}&withTotalElements=true`))],
    ['source page of 2000', await time(10, () => get(fork, `/measurement/measurements?source=${device}&pageSize=2000`))],
    ['source, 7 days, oldest first, page 3 of 100', await time(10, () => get(fork, `/measurement/measurements?source=${device}&dateFrom=${new Date(NOW - 7 * DAY).toISOString()}&dateTo=${new Date(NOW).toISOString()}&revert=false&pageSize=100&currentPage=3`))],
    ['tenant-wide page (5) + total', await time(5, () => get(fork, '/measurement/measurements?withTotalElements=true'))],
    ['tenant-wide page 500 of 2000', await time(5, () => get(fork, '/measurement/measurements?pageSize=2000&currentPage=500'))],
    ['series, 30 days, daily, all functions', await time(5, () => get(fork, `/measurement/measurements/series?source=${device}&${month}&aggregationInterval=1d&aggregationFunction=min&aggregationFunction=max&aggregationFunction=avg&aggregationFunction=sum&aggregationFunction=count`))],
    ['series, 30 days, hourly min/max', await time(5, () => get(fork, `/measurement/measurements/series?source=${device}&${month}&aggregationInterval=1h`))],
    ['supportedSeries', await time(20, () => get(fork, `/inventory/managedObjects/${device}/supportedSeries`))],
  ]
  // deletes: 20 ranges (one tenant-wide), 200 ids
  start = performance.now()
  for (let i = 0; i < 20; i++) {
    const from = new Date(NOW - (i + 1) * DAY).toISOString()
    const to = new Date(NOW - (i + 1) * DAY + 6 * 3_600_000).toISOString()
    await get(fork, `/measurement/measurements?${i === 0 ? '' : `source=${devices[i * 7]}&`}dateFrom=${from}&dateTo=${to}`, 'DELETE')
  }
  const page = await get(fork, `/measurement/measurements?source=${device}&pageSize=200`)
  for (const item of page.measurements) {
    await get(fork, `/measurement/measurements/${item.id}`, 'DELETE')
  }
  rows.push(['20 range + 200 id deletes', ms(start)])
  rows.push(['after deletes: tenant-wide page + total', await time(5, () => get(fork, '/measurement/measurements?withTotalElements=true'))])
  rows.push(['after deletes: source page + total', await time(10, () => get(fork, `/measurement/measurements?source=${device}&withTotalElements=true`))])
  start = performance.now()
  const diff = fork.diff()
  rows.push([`fork diff (${diff.tenants[world.tenant]!.measurements.deleted.length} documents, ${diff.tenants[world.tenant]!.deletedMeasurementRanges.length} ranges)`, ms(start)])
  start = performance.now()
  const json = JSON.stringify(world.snapshot())
  rows.push([`snapshot to JSON (${mb(json.length)})`, ms(start)])
  start = performance.now()
  const restored = fake.createWorld({ now: () => NOW })
  restored.restore(JSON.parse(json))
  restored.fork()
  rows.push(['JSON snapshot: parse, restore, first fork', ms(start)])
  for (const [what, value] of rows) {
    print(`  ${what.padEnd(48)} ${value}`)
  }
}

const fake = await loadEngine()
if (!gc) {
  console.warn('run with node --expose-gc for heap numbers')
}
for (const interval of ['5m', '1m']) {
  for (const streams of [1, 4] as const) {
    await variant(fake, interval, streams)
  }
}
