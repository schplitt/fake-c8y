// Runs inside an iso4 isolate: no Node APIs, frozen clock, virtual timers.
import { createWorld } from '../../src'

async function json(response: Response): Promise<any> {
  return { status: response.status, body: await response.json() }
}

export default async function scenario(): Promise<Record<string, unknown>> {
  const world = createWorld({ now: () => Date.parse('2026-01-01T00:00:00.000Z') })
  const base = world.baseUrl
  const auth = { authorization: `Basic ${'dDEyMzQ1L3Rlc3QtdXNlcjp0ZXN0LXBhc3N3b3Jk'}`, accept: 'application/json' } // t12345/test-user:test-password
  const pump = world.device({ name: 'Pump', type: 'pump', externalIds: { c8y_Serial: 'SN-1' } })
  world.seed({ measurements: [{ source: pump, type: 'c8y_Temperature', time: '2026-01-01T00:00:00.000Z', c8y_Temperature: { T: { value: 21, unit: 'C' } } }] })
  const before = world.snapshot()

  const created = await json(await world.fetch(new Request(`${base}/alarm/alarms`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ source: { id: pump }, type: 'overheat', text: 'Too hot', severity: 'MAJOR', time: '2026-01-01T00:00:00.000Z' }),
  })))
  const query = await json(await world.fetch(new Request(`${base}/inventory/managedObjects?query=${encodeURIComponent('$filter=(type eq \'pump\')')}&withTotalElements=true`, { headers: auth })))
  const identity = await json(await world.fetch(new Request(`${base}/identity/externalIds/c8y_Serial/SN-1`, { headers: auth })))
  const series = await json(await world.fetch(new Request(`${base}/measurement/measurements/series?source=${pump}&dateFrom=2025-12-31T00:00:00Z&dateTo=2026-01-02T00:00:00Z&series=c8y_Temperature.T`, { headers: auth })))
  const option = await world.fetch(new Request(`${base}/tenant/options/service/credentials.key`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'secret' }),
  }))
  const boundary = 'fake-c8y-boundary'
  const upload = await json(await world.fetch(new Request(`${base}/inventory/binaries`, {
    method: 'POST',
    headers: { ...auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: [
      `--${boundary}`,
      'Content-Disposition: form-data; name="object"',
      '',
      JSON.stringify({ name: 'notes.txt', type: 'text/plain' }),
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="notes.txt"',
      'Content-Type: text/plain',
      '',
      'hello from iso4',
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  })))
  const download = await world.fetch(new Request(`${base}/inventory/binaries/${upload.body.id}`, { headers: auth }))
  const unsupported = await json(await world.fetch(new Request(`${base}/notification2/subscriptions`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ context: 'tenant', subscription: 'children', subscriptionFilter: { apis: ['eventsWithChildren'] } }) })))
  const diff = world.diff(before)

  // a fork of the world: copy-on-write overlay, own ids, diff from the overlay
  const fork = world.fork()
  const forked = await json(await fork.fetch(new Request(`${base}/inventory/managedObjects/${pump}`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Forked pump' }),
  })))
  const forkDiff = fork.diff()

  // generated measurement history (computed on read), deleted in a fork
  const gauge = fork.device({ name: 'Gauge' })
  fork.seed({ measurementGenerators: [{ source: gauge, type: 'c8y_Pressure', from: '2025-12-31T00:00:00.000Z', interval: '1h', series: [{ fragment: 'c8y_Pressure', series: 'P', unit: 'bar', value: { base: 2, dailyAmplitude: 0.5, noise: 0.1 } }] }] })
  const generated = await json(await fork.fetch(new Request(`${base}/measurement/measurements?source=${gauge}&pageSize=2&withTotalElements=true`, { headers: auth })))
  await fork.fetch(new Request(`${base}/measurement/measurements?source=${gauge}&dateFrom=2025-12-31T00:00:00Z&dateTo=2025-12-31T06:00:00Z`, { method: 'DELETE', headers: auth }))
  const generatedDiff = fork.diff().tenants.t12345?.deletedMeasurementRanges.map((range) => range.count)

  return {
    created,
    totalElements: query.body.statistics.totalElements,
    identity: identity.body.managedObject.id === pump,
    series: series.body.values,
    optionValue: (await option.json()).value,
    upload: { status: upload.status, length: upload.body.length },
    downloaded: await download.text(),
    unsupported: unsupported.status,
    unhandled: world.unhandled.map((request) => request.reason),
    diff: Object.fromEntries(Object.entries(diff.tenants.t12345 ?? {}).map(([collection, changes]) => [collection, Array.isArray(changes) ? changes.length : (changes as { created: unknown[] }).created.length])),
    generated: { total: generated.body.statistics.totalElements, times: generated.body.measurements.map((item: { time: string }) => item.time), deleted: generatedDiff },
    options: diff.options,
    fork: {
      status: forked.status,
      baseName: world.db.managedObjects.get(pump)?.name,
      updated: forkDiff.tenants.t12345?.managedObjects.updated.map((change) => change.after.name),
    },
  }
}
