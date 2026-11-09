import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { eventually, rejection, time } from '../helpers'

async function call(client: Client, method: string, path: string, body?: unknown) {
  const res = await client.core.fetch(path, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

async function send(client: Client, method: string, path: string, body: unknown, contentType: string) {
  const res = await client.core.fetch(path, { method, headers: { 'accept': 'application/json', 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

const COLLECTION = 'application/vnd.com.nsn.cumulocity.measurementcollection+json'
const q = encodeURIComponent
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 0, 1, hour, minute)).toISOString()
async function createTemperature(client: Client, source: string, when: string, value: number, fragment = 'c8y_T', type = fragment) {
  await client.measurement.create({ source: { id: source }, type, time: when, [fragment]: { T: { value, unit: 'C' } } } as any)
}

export const measurementsScenarios: ContractScenario[] = [
  {
    name: 'measurements: series buckets of days and weeks',
    verifies: ['series-calendar-buckets'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `sb-${unique}`, c8y_IsDevice: {} })
      // 14 days from Monday 2026-04-20, one value a day
      for (let day = 0; day < 14; day++) {
        await client.measurement.create({ source: { id: device.id }, type: 'wk', time: new Date(Date.UTC(2026, 3, 20 + day, 12, 34, 56)).toISOString(), wk: { v: { value: day + 1, unit: 'u' } } } as any)
      }
      const keys = async (interval: string, from = '2026-04-19T00:00:00Z') => {
        const res = await call(client, 'GET', `/measurement/measurements/series?source=${device.id}&series=wk.v&dateFrom=${from}&dateTo=2026-05-04T00:00:00Z&aggregationInterval=${interval}`)
        expect(res.status).toBe(200)
        return Object.entries(res.json.values as Record<string, Array<{ min: number, max: number }>>).map(([key, [value]]) => [key, value!.min, value!.max])
      }
      // calendar weeks from Sunday, whatever dateFrom is
      const weeks = [['2026-04-19T00:00:00.000Z', 1, 6], ['2026-04-26T00:00:00.000Z', 7, 13], ['2026-05-03T00:00:00.000Z', 14, 14]]
      expect(await keys('1w')).toEqual(weeks)
      expect(await keys('1w', '2026-04-22T05:00:00Z')).toEqual([['2026-04-19T00:00:00.000Z', 3, 6], ...weeks.slice(1)])
      // a 7 day grid of its own: Saturdays
      expect(await keys('7d')).toEqual([['2026-04-18T00:00:00.000Z', 1, 5], ['2026-04-25T00:00:00.000Z', 6, 12], ['2026-05-02T00:00:00.000Z', 13, 14]])
      expect((await keys('1d')).map(([key]) => key)).toEqual(Array.from({ length: 14 }, (_, day) => new Date(Date.UTC(2026, 3, 20 + day)).toISOString()))
    },
  },
  {
    name: 'measurements: newest first, revert=false for oldest first',
    verifies: ['measurements-newest-first'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `m-${unique}`, c8y_IsDevice: {} })
      for (const [minute, value] of [[1, 10], [3, 30], [2, 20]] as const) {
        await client.measurement.create({ source: { id: device.id }, type: 'c8y_Temperature', time: time(minute), c8y_Temperature: { T: { value, unit: 'C' } } } as any)
      }
      const values = (data: any[]) => data.map((measurement) => measurement.c8y_Temperature.T.value)

      const { data: newestFirst } = await client.measurement.list({ source: device.id, type: 'c8y_Temperature' })
      expect(values(newestFirst)).toEqual([30, 20, 10])

      const { data: oldestFirst } = await client.measurement.list({ source: device.id, dateFrom: time(0), dateTo: time(10), revert: false, pageSize: 2 })
      expect(values(oldestFirst)).toEqual([10, 20])
    },
  },
  {
    name: 'measurements: series with aggregation, bulk delete',
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `s-${unique}`, c8y_IsDevice: {} })
      for (const [minute, value] of [[1, 10], [20, 30], [70, 50]] as const) {
        await client.measurement.create({ source: { id: device.id }, type: 'c8y_Temperature', time: time(minute), c8y_Temperature: { T: { value, unit: 'C' } } } as any)
      }
      const range = { source: device.id, dateFrom: time(0), dateTo: time(120) }

      const { data: raw } = await client.measurement.listSeries({ ...range, series: 'c8y_Temperature.T' } as any)
      expect(raw.series).toEqual([{ name: 'T', type: 'c8y_Temperature', unit: 'C' }])
      expect(Object.values(raw.values)).toEqual([[{ min: 10, max: 10 }], [{ min: 30, max: 30 }], [{ min: 50, max: 50 }]])

      const { data: hourly } = await client.measurement.listSeries({ ...range, aggregationType: 'HOURLY' } as any)
      expect(hourly.values).toEqual({
        [time(0)]: [{ min: 10, max: 30 }],
        [time(60)]: [{ min: 50, max: 50 }],
      })

      // bulk delete boundaries must be full hours
      const unaligned = await client.core.fetch(`/measurement/measurements?source=${device.id}&dateTo=${encodeURIComponent(time(30))}`, { method: 'DELETE' })
      expect(unaligned.status).toBe(422)
      const res = await client.core.fetch(`/measurement/measurements?source=${device.id}&dateTo=${encodeURIComponent(time(60))}`, { method: 'DELETE' })
      expect(res.status).toBe(204)
      await eventually(async () => {
        expect((await client.measurement.list({ source: device.id })).data).toHaveLength(1)
      })
    },
  },
  {
    name: 'measurements: collection create, value fragment filters, detail and delete, interval functions',
    verifies: ['measurement-by-id-405'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `m2-${unique}`, c8y_IsDevice: {} })
      const created = await client.core.fetch('/measurement/measurements', {
        method: 'POST',
        headers: { 'content-type': 'application/vnd.com.nsn.cumulocity.measurementcollection+json', 'accept': 'application/json' },
        body: JSON.stringify({
          measurements: [
            { source: { id: device.id }, type: 'c8y_Climate', time: time(1), c8y_Climate: { T: { value: 10, unit: 'C' }, H: { value: 40, unit: '%' } } },
            { source: { id: device.id }, type: 'c8y_Climate', time: time(2), c8y_Climate: { T: { value: 20, unit: 'C' } } },
            { source: { id: device.id }, type: 'c8y_Power', time: time(3), c8y_Power: { P: { value: 5, unit: 'W' } } },
          ],
        }),
      })
      expect(created.status).toBe(201)
      const { measurements } = await created.json()
      expect(measurements).toHaveLength(3)

      const types = async (filter: Record<string, unknown>) => (await client.measurement.list({ source: device.id, pageSize: 100, ...filter } as any)).data.map((item: any) => item.type).sort()
      expect(await types({ valueFragmentType: 'c8y_Climate' })).toEqual(['c8y_Climate', 'c8y_Climate'])
      expect(await types({ valueFragmentType: 'c8y_Climate', valueFragmentSeries: 'H' })).toEqual(['c8y_Climate'])

      // time series persistence: single measurements cannot be read, but deleted
      expect((await rejection(client.measurement.detail(measurements[2].id))).res.status).toBe(405)
      await client.measurement.delete(measurements[2].id)
      await eventually(async () => {
        expect(await types({})).toEqual(['c8y_Climate', 'c8y_Climate'])
      })

      const series = await (await client.core.fetch(`/measurement/measurements/series?source=${device.id}&dateFrom=${encodeURIComponent(time(0))}&dateTo=${encodeURIComponent(time(60))}&series=c8y_Climate.T&aggregationInterval=1h&aggregationFunction=avg&aggregationFunction=count`)).json()
      expect(Object.values(series.values)).toEqual([[{ avg: 15, count: 2 }]])

      const invalid = await client.core.fetch(`/measurement/measurements/series?source=${device.id}&dateFrom=${encodeURIComponent(time(0))}&dateTo=${encodeURIComponent(time(60))}&aggregationFunction=avg`)
      // the platform answers 422 (the docs say 400)
      expect(invalid.status).toBe(422)
    },
  },
  {
    name: 'measurements: validation and error responses',
    verifies: ['measurement-by-id-405', 'time-unparsable-400', 'date-parameters-lenient'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `mv-${unique}`, c8y_IsDevice: {} })
      const post = (body: unknown) => call(client, 'POST', '/measurement/measurements', body)
      const source = { id: device.id }

      for (const field of ['source', 'type', 'time']) {
        const body: Record<string, unknown> = { source, type: 'c8y_T', time: time(1) }
        delete body[field]
        const res = await post(body)
        expect(res.status, field).toBe(422)
        expect(res.json.error).toBe('undefined/validationError')
        expect(res.json.message).toContain(field)
      }

      const unknownSource = await post({ source: { id: '999999999999' }, type: 'c8y_T', time: time(1) })
      expect(unknownSource.status).toBe(422)
      expect(unknownSource.json.error).toBe('measurement/Unprocessable Entity')

      const badTime = await post({ source, type: 'c8y_T', time: 'not a date' })
      expect(badTime.status).toBe(400)

      // time series persistence: single measurements cannot be read
      expect((await call(client, 'GET', '/measurement/measurements/999999999999')).status).toBe(405)
      const missing = await call(client, 'DELETE', '/measurement/measurements/999999999999')
      expect(missing.status).toBe(404)
      expect(missing.json.error).toBe('measurement/Not Found')

      const badDate = await call(client, 'GET', `/measurement/measurements?source=${device.id}&dateFrom=foo`)
      expect(badDate.status).toBe(422)
      const badDelete = await call(client, 'DELETE', `/measurement/measurements?source=${device.id}&dateFrom=foo`)
      expect(badDelete.status).toBe(422)
    },
  },
  {
    name: 'measurements: paging, totals, date range boundaries, revert',
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `mp-${unique}`, c8y_IsDevice: {} })
      for (let minute = 0; minute < 7; minute++) {
        await createTemperature(client, device.id, time(minute), minute)
      }
      const list = async (params: string) => (await call(client, 'GET', `/measurement/measurements?source=${device.id}&${params}`)).json
      const minutes = (page: any) => page.measurements.map((measurement: any) => new Date(measurement.time).getUTCMinutes())

      await eventually(async () => {
        const page = await list('pageSize=2&currentPage=2&withTotalElements=true&withTotalPages=true')
        expect(minutes(page)).toEqual([4, 3])
        expect(page.statistics).toEqual({ pageSize: 2, currentPage: 2, totalElements: 7, totalPages: 4 })
        expect(page.prev).toBeDefined()
        expect(page.next).toBeDefined()
      })
      // totals are only counted on request
      const plain = await list('pageSize=2')
      expect(plain.statistics).toEqual({ pageSize: 2, currentPage: 1 })
      expect(minutes(plain)).toEqual([6, 5])
      // revert=false only gives oldest first together with a date range
      expect(minutes(await list('pageSize=2&currentPage=2&revert=false'))).toEqual([4, 3])
      expect(minutes(await list(`dateFrom=${q(time(0))}&dateTo=${q(time(10))}&pageSize=2&currentPage=2&revert=false`))).toEqual([2, 3])
      expect(minutes(await list('pageSize=2&currentPage=50&withTotalElements=true'))).toEqual([])

      // dateFrom is inclusive, dateTo exclusive
      expect(minutes(await list(`dateFrom=${q(time(1))}&dateTo=${q(time(4))}&revert=false`))).toEqual([1, 2, 3])
      expect(minutes(await list(`dateFrom=${q(time(5))}`))).toEqual([6, 5])
      expect(minutes(await list(`dateTo=${q(time(2))}&revert=false`))).toEqual([0, 1])
      // an empty or reversed range matches nothing, except equal bounds which include that instant
      expect(minutes(await list(`dateFrom=${q(time(3))}&dateTo=${q(time(3))}`))).toEqual([3])
      expect(minutes(await list(`dateFrom=${q(time(4))}&dateTo=${q(time(2))}`))).toEqual([])
      // revert=true keeps newest first (the default)
      expect(minutes(await list(`dateFrom=${q(time(1))}&dateTo=${q(time(4))}&revert=true`))).toEqual([3, 2, 1])
    },
  },
  {
    name: 'measurements: bulk delete filters (type, fragmentType, dateFrom, dateTo)',
    async run({ client, unique, settle }) {
      const { data: device } = await client.inventory.create({ name: `md-${unique}`, c8y_IsDevice: {} })
      await createTemperature(client, device.id, at(9, 0), 1)
      await createTemperature(client, device.id, at(9, 30), 2)
      await createTemperature(client, device.id, at(10, 0), 3)
      await createTemperature(client, device.id, at(10, 30), 4, 'c8y_Other')
      await createTemperature(client, device.id, at(11, 0), 5)
      await createTemperature(client, device.id, at(12, 0), 6)
      const remaining = async () => (await call(client, 'GET', `/measurement/measurements?source=${device.id}&pageSize=100&dateFrom=${q(at(0))}&dateTo=${q(at(23))}&revert=false`)).json.measurements.map((m: any) => `${new Date(m.time).getUTCHours()}:${String(new Date(m.time).getUTCMinutes()).padStart(2, '0')}`)
      const del = async (params: string) => {
        const res = await client.core.fetch(`/measurement/measurements?source=${device.id}&${params}`, { method: 'DELETE' })
        expect(res.status).toBe(204)
      }
      await eventually(async () => {
        expect(await remaining()).toHaveLength(6)
      })

      // filters combine: nothing matches both, so nothing is deleted
      await del(`fragmentType=c8y_Nope`)
      await del(`dateFrom=${q(at(12, 0))}&fragmentType=c8y_Other`)
      await del(`dateFrom=${q(at(13, 0))}`)
      await settle(1500)
      expect(await remaining()).toHaveLength(6)

      // dateFrom inclusive, dateTo exclusive
      await del(`dateFrom=${q(at(11, 0))}&dateTo=${q(at(12, 0))}`)
      await eventually(async () => {
        expect(await remaining()).toEqual(['9:00', '9:30', '10:00', '10:30', '12:00'])
      })

      // equal bounds delete the whole hour
      await del(`dateFrom=${q(at(9, 0))}&dateTo=${q(at(9, 0))}`)
      await eventually(async () => {
        expect(await remaining()).toEqual(['10:00', '10:30', '12:00'])
      })

      await del('type=c8y_Other&fragmentType=c8y_Other')
      await eventually(async () => {
        expect(await remaining()).toEqual(['10:00', '12:00'])
      })

      await del(`dateTo=${q(at(10, 0))}`)
      await settle(1500)
      expect(await remaining()).toEqual(['10:00', '12:00'])

      await del(`dateFrom=${q(at(12, 0))}`)
      await eventually(async () => {
        expect(await remaining()).toEqual(['10:00'])
      })
      await del('type=c8y_T')
      await eventually(async () => {
        expect(await remaining()).toEqual([])
      })
    },
  },
  {
    name: 'measurements: series with several series, intervals and functions',
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `ms-${unique}`, c8y_IsDevice: {} })
      for (let minute = 0; minute < 6; minute++) {
        await createTemperature(client, device.id, time(minute), minute + 1)
      }
      await client.measurement.create({ source: { id: device.id }, type: 'c8y_Other', time: time(2), c8y_Other: { X: { value: 7, unit: 'W' } } } as any)
      const series = async (params: string) => {
        const res = await call(client, 'GET', `/measurement/measurements/series?source=${device.id}&dateFrom=${q(time(0))}&dateTo=${q(time(10))}&${params}`)
        return { status: res.status, ...res.json }
      }
      await eventually(async () => {
        expect(Object.keys((await series('series=c8y_T.T')).values)).toHaveLength(6)
      })

      // several series: positions follow the series list, missing values are null
      const several = await series('series=c8y_T.T&series=c8y_Other.X')
      expect(several.series).toEqual([{ name: 'T', type: 'c8y_T', unit: 'C' }, { name: 'X', type: 'c8y_Other', unit: 'W' }])
      expect(several.truncated).toBe(false)
      expect(Object.keys(several.values)).toEqual([0, 1, 2, 3, 4, 5].map(time))
      expect(several.values[time(0)]).toEqual([{ min: 1, max: 1 }, null])
      expect(several.values[time(2)]).toEqual([{ min: 3, max: 3 }, { min: 7, max: 7 }])
      // without a series filter all numeric series are returned
      expect((await series('')).series.map((item: any) => `${item.type}.${item.name}`).sort()).toEqual(['c8y_Other.X', 'c8y_T.T'])

      // revert has no effect, values are always oldest first
      expect(Object.keys((await series('series=c8y_T.T&revert=true')).values)).toEqual([0, 1, 2, 3, 4, 5].map(time))

      // unknown series are left out, a period without data is empty
      expect((await series('series=c8y_T.T&series=c8y_Nope.Z')).series).toHaveLength(1)
      expect(await series('series=c8y_Nope.Z')).toMatchObject({ values: {}, series: [], truncated: false })
      const empty = await call(client, 'GET', `/measurement/measurements/series?source=${device.id}&dateFrom=${q(at(20))}&dateTo=${q(at(21))}`)
      expect(empty.json).toMatchObject({ values: {}, series: [] })

      // dateFrom inclusive, dateTo exclusive
      const range = async (from: string, to: string) => Object.keys((await call(client, 'GET', `/measurement/measurements/series?source=${device.id}&series=c8y_T.T&dateFrom=${q(from)}&dateTo=${q(to)}`)).json.values)
      expect(await range(time(0), time(2))).toEqual([time(0), time(1)])
      expect(await range(time(2), time(2))).toEqual([time(2)])

      // every aggregation function, 2 minute buckets
      const all = await series('series=c8y_T.T&aggregationInterval=2m&aggregationFunction=min&aggregationFunction=max&aggregationFunction=avg&aggregationFunction=sum&aggregationFunction=count&aggregationFunction=stdDevPop&aggregationFunction=stdDevSamp')
      expect(Object.keys(all.values)).toEqual([time(0), time(2), time(4)])
      expect(all.values[time(0)]).toEqual([{ min: 1, max: 2, avg: 1.5, sum: 3, count: 2, stdDevPop: 0.5, stdDevSamp: Math.sqrt(0.5) }])
      expect(all.values[time(4)]).toEqual([{ min: 5, max: 6, avg: 5.5, sum: 11, count: 2, stdDevPop: 0.5, stdDevSamp: Math.sqrt(0.5) }])

      // aggregationType: MINUTELY, HOURLY (the default functions are min and max), DAILY
      expect(Object.keys((await series('aggregationType=MINUTELY')).values)).toEqual([0, 1, 2, 3, 4, 5].map(time))
      expect((await series('aggregationType=HOURLY&aggregationFunction=min')).values).toEqual({ [at(10)]: [{ min: 1 }, { min: 7 }] })
      expect((await series('aggregationType=DAILY')).values).toEqual({ [at(0)]: [{ min: 1, max: 6 }, { min: 7, max: 7 }] })
      // intervals in days
      expect((await series('aggregationInterval=1d&aggregationFunction=avg')).values).toEqual({ [at(0)]: [{ avg: 3.5 }, { avg: 7 }] })
      // buckets without values of a series: sum is 0, not null
      expect((await series('aggregationInterval=1m&aggregationFunction=sum')).values[time(0)]).toEqual([{ sum: 1 }, { sum: 0 }])
    },
  },
  {
    name: 'measurements: series validation',
    verifies: ['series-validation-statuses'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `mq-${unique}`, c8y_IsDevice: {} })
      const base = `/measurement/measurements/series?source=${device.id}&dateFrom=${q(time(0))}&dateTo=${q(time(10))}`
      const missingTo = await call(client, 'GET', `/measurement/measurements/series?source=${device.id}&dateFrom=${q(time(0))}`)
      expect(missingTo.status).toBe(400)
      expect(missingTo.json.error).toBe('measurement/Bad Request')
      const interval = await call(client, 'GET', `${base}&aggregationInterval=5x&aggregationFunction=min`)
      expect(interval.status).toBe(422)
      expect(interval.json.message).toContain('Invalid aggregation interval')
      const type = await call(client, 'GET', `${base}&aggregationType=WEEKLY`)
      expect(type.status).toBe(400)
      expect(type.json.message).toContain('HOURLY, DAILY, MINUTELY')
      const fn = await call(client, 'GET', `${base}&aggregationInterval=1h&aggregationFunction=bogus`)
      expect(fn.status).toBe(400)
      expect(fn.json.message).toContain('min, max, avg, sum, count, stdDevPop, stdDevSamp')
    },
  },
]

export const measurementsConformanceScenarios: ContractScenario[] = [
  {
    name: 'measurements: create validation, collections are all or nothing',
    verifies: ['measurement-create-validation', 'measurement-values-numeric', 'measurement-collection-content-type', 'media-type-415'],
    async run({ client, unique, settle }) {
      const { data: device } = await client.inventory.create({ name: `r1108data-mc-${unique}`, c8y_IsDevice: {} })
      const source = { id: device.id }
      const type = `mc-${unique}`
      const valid = { source, type, time: time(1) }
      const post = (body: unknown) => call(client, 'POST', '/measurement/measurements', body)
      const collection = (body: unknown) => send(client, 'POST', '/measurement/measurements', body, COLLECTION)

      // one missing or server-owned field is named (with several, the platform picks one in no fixed order)
      for (const field of ['source', 'time', 'type'] as const) {
        const { [field]: _omitted, ...body } = valid
        const res = await post(body)
        expect(res.json, field).toMatchObject({ error: 'undefined/validationError', message: `post.measurementRepresentation.${field}: is required` })
        expect((await post({ ...valid, [field]: null })).json.message).toBe(`post.measurementRepresentation.${field}: is required`)
      }
      expect((await post({ source })).json.message).toMatch(/^post\.measurementRepresentation\.(time|type): is required$/)
      for (const field of ['id', 'creationTime']) {
        expect((await post({ ...valid, [field]: field === 'id' ? '5' : time(1) })).json).toMatchObject({ error: 'undefined/validationError', message: `post.measurementRepresentation.${field}: is not allowed here` })
      }
      // a source must be an object with an id
      expect(await post({ ...valid, source: device.id })).toMatchObject({ status: 400, json: { error: 'Failed to parse JSON string' } })
      expect((await post({ ...valid, source: {} })).json).toMatchObject({ error: 'measurement/Invalid Data', message: 'Invalid value for source argument! : Value cannot be null!' })
      expect((await post({ ...valid, source: { id: '999999999999' } })).json).toMatchObject({ error: 'measurement/Unprocessable Entity', message: 'Source object does not exist in inventory. : Finding device data from database failed' })

      // only a string value is rejected, other values are stored as given
      for (const value of ['x', '12']) {
        expect((await post({ ...valid, f: { s: { value } } })).json.message, value).toBe('post.measurementRepresentation: Only numbers are supported as measurement values')
      }
      expect((await post({ ...valid, f: { a: { value: 1 }, b: { value: 'x' } } })).status).toBe(422)
      for (const fragment of [{ s: { value: null } }, { s: { value: true } }, { s: { value: [1] } }, { s: { value: { a: 1 } } }, { s: { unit: 'u' } }, { s: 5 }, { value: 'x' }, { a: { b: { value: 'x' } } }]) {
        const res = await post({ ...valid, f: fragment })
        expect(res.status, JSON.stringify(fragment)).toBe(201)
        expect(res.json.f).toEqual(fragment)
      }
      // a numeric type is stored as text, self is ignored; no creation time
      const created = await post({ source: { id: Number(device.id) }, type: 5, time: '2026-01-01T12:00:00+02:00', self: 'x', lastUpdated: time(1), n: { s: { value: 1, unit: 'u' } } })
      expect(created.status).toBe(201)
      expect(created.json).toMatchObject({ type: '5', time: '2026-01-01T12:00:00.000+02:00', source: { id: device.id }, n: { s: { value: 1, unit: 'u' } } })
      // lastUpdated is no field of a measurement: it is stored as sent
      expect(created.json.lastUpdated).toBe(time(1))
      expect(Object.keys(created.json).sort()).toEqual(['id', 'lastUpdated', 'n', 'self', 'source', 'time', 'type'])

      // collections: field rules of every item first, then values, then sources; nothing is stored on an error
      const item = (minute: number, extra: Record<string, unknown> = {}) => ({ source, type, time: time(minute), c: { s: { value: minute } }, ...extra })
      const missing = await collection({ measurements: [item(10), item(11), { source, time: time(12) }] })
      expect(missing).toMatchObject({ status: 422, json: { error: 'undefined/validationError', message: 'post.measurementCollectionRepresentation.measurements[2].type: is required', bulkRequest: { failedIndex: 2 } } })
      const order = await collection({ measurements: [item(10, { c: { s: { value: 'x' } } }), { source, type, time: time(11), id: '5' }] })
      expect(order.json).toMatchObject({ message: 'post.measurementCollectionRepresentation.measurements[1].id: is not allowed here', bulkRequest: { failedIndex: 1 } })
      expect((await collection({ measurements: [item(10), item(11, { c: { s: { value: 'x' } } })] })).json).toMatchObject({ message: 'post.measurementCollectionRepresentation.measurements[1]: Only numbers are supported as measurement values', bulkRequest: { failedIndex: 1 } })
      expect((await collection({ measurements: [item(10), item(11, { source: { id: '999999999999' } })] })).json).toMatchObject({ error: 'measurement/Unprocessable Entity' })
      expect((await collection({ measurements: [item(10), item(11, { time: 'bad' })] })).status).toBe(400)
      expect((await collection({ measurements: 'x' })).status).toBe(400)
      // the platform fails on a missing list or a null item
      expect((await collection({})).json).toMatchObject({ error: 'general/internalError' })
      expect((await collection({ measurements: [null] })).json).toMatchObject({ error: 'general/internalError' })
      expect(await collection({ measurements: [] })).toMatchObject({ status: 201, json: { measurements: [] } })
      await settle(1500)
      expect((await call(client, 'GET', `/measurement/measurements?source=${device.id}&type=${type}&valueFragmentType=c`)).json.measurements).toEqual([])

      // the content type decides: a collection sent as JSON is one measurement, a measurement sent as a collection fails
      expect((await post({ measurements: [item(13)] })).json.message).toMatch(/^post\.measurementRepresentation\.(source|time|type): is required$/)
      expect((await collection(valid)).json).toMatchObject({ error: 'general/internalError' })
      const both = await collection({ measurements: [item(14), item(15)] })
      expect(both.status).toBe(201)
      expect(both.json.measurements.map((measurement: any) => measurement.c.s.value)).toEqual([14, 15])
      expect(Object.keys(both.json.measurements[0]).sort()).toEqual(['c', 'id', 'self', 'source', 'time', 'type'])
      expect((await send(client, 'POST', '/measurement/measurements', valid, 'application/vnd.com.nsn.cumulocity.measurement+json')).status).toBe(201)

      // other media types answer an empty 415
      for (const contentType of ['text/plain', 'application/vnd.com.nsn.cumulocity.event+json']) {
        expect(await send(client, 'POST', '/measurement/measurements', valid, contentType), contentType).toMatchObject({ status: 415, text: '' })
      }
    },
  },
  {
    name: 'measurements: list filters see numeric series, one type, lenient paging flags',
    verifies: ['measurement-value-fragments', 'query-booleans-not-false', 'paging-negative-page', 'paging-error-code', 'query-repeated-first', 'date-parameters-lenient', 'date-error-no-message'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `r1108data-ml-${unique}`, c8y_IsDevice: {} })
      const { data: other } = await client.inventory.create({ name: `r1108data-ml2-${unique}`, c8y_IsDevice: {} })
      const add = (minute: number, type: string, fragments: Record<string, unknown>, id = device.id) => call(client, 'POST', '/measurement/measurements', { source: { id }, type, time: time(minute), ...fragments })
      await add(0, 'A', { fa: { s1: { value: 1 }, s2: { value: 2 } } })
      await add(1, 'B', { fb: { s1: { value: 3 } }, plain: { x: 'y' } })
      await add(2, 'A', { fa: { s2: { value: 4 } }, fb: { s3: { value: 5 } } })
      await add(3, 'C', { plain: 'x', nov: { s1: { unit: 'u' } }, nul: { s1: { value: null } }, boo: { s1: { value: true } }, arr: [{ value: 1 }] })
      await add(4, 'A,B', { fc: { s1: { value: 6 } } })
      await add(5, '', { fd: { s4: { value: 7 } } })
      await add(6, 'A', { fa: { s1: { value: 8 } } }, other.id)
      const list = async (params: string) => {
        const res = await call(client, 'GET', `/measurement/measurements?source=${device.id}&pageSize=100&${params}`)
        expect(res.status, params).toBe(200)
        return res.json.measurements.map((measurement: any) => `${measurement.type}@${new Date(measurement.time).getUTCMinutes()}`)
      }
      await eventually(async () => {
        expect(await list('')).toHaveLength(6)
      })

      // one type, compared as a whole, also an empty one
      expect(await list('type=A')).toEqual(['A@2', 'A@0'])
      expect(await list('type=A,B')).toEqual(['A,B@4'])
      expect(await list('type=a')).toEqual([])
      expect(await list('type=')).toEqual(['@5'])
      // fragment filters only see series with a numeric value
      expect(await list('valueFragmentType=fa')).toEqual(['A@2', 'A@0'])
      expect(await list('valueFragmentType=fa&valueFragmentSeries=s1')).toEqual(['A@0'])
      expect(await list('valueFragmentSeries=s1')).toEqual(['A,B@4', 'B@1', 'A@0'])
      expect(await list('valueFragmentType=')).toHaveLength(6)
      expect(await list('fragmentType=fb')).toEqual(['A@2', 'B@1'])
      for (const fragment of ['plain', 'nov', 'nul', 'boo', 'arr']) {
        expect(await list(`valueFragmentType=${fragment}`), fragment).toEqual([])
        expect(await list(`fragmentType=${fragment}`), fragment).toEqual([])
      }
      expect(await list('valueFragmentType=fa,fb')).toEqual([])
      // an empty source matches nothing, an unknown or listed one too
      for (const source of ['', 'abc', '999999999999', `${device.id},${other.id}`]) {
        expect((await call(client, 'GET', `/measurement/measurements?source=${source}&type=A`)).json.measurements, source).toEqual([])
      }

      // totals for any value but false, revert=false in any case, a negative page is the first one
      const page = async (params: string) => (await call(client, 'GET', `/measurement/measurements?source=${device.id}&${params}`)).json
      expect((await page('pageSize=2&withTotalPages=abc&withTotalElements=')).statistics).toEqual({ currentPage: 1, pageSize: 2, totalPages: 3, totalElements: 6 })
      expect((await page('pageSize=2&withTotalPages=FALSE&withTotalElements=False')).statistics).toEqual({ currentPage: 1, pageSize: 2 })
      const negative = await page('pageSize=2&currentPage=-1&withTotalElements=0')
      expect(negative.statistics).toEqual({ currentPage: -1, pageSize: 2, totalElements: 6 })
      expect(negative.measurements.map((measurement: any) => measurement.type)).toEqual(['', 'A,B'])
      expect((await page(`pageSize=2&revert=FALSE&dateFrom=${q(time(0))}`)).measurements.map((measurement: any) => measurement.type)).toEqual(['A', 'B'])
      expect((await page(`pageSize=2&revert=0&dateFrom=${q(time(0))}`)).measurements.map((measurement: any) => measurement.type)).toEqual(['', 'A,B'])
      // a repeated parameter takes its first value
      expect((await page('pageSize=1&pageSize=3&type=B&type=A')).measurements.map((measurement: any) => measurement.type)).toEqual(['B'])
      for (const name of ['pageSize', 'currentPage']) {
        for (const value of ['abc', '1.5', '2147483648']) {
          const res = await call(client, 'GET', `/measurement/measurements?source=${device.id}&${name}=${value}`)
          expect(res.json, `${name}=${value}`).toMatchObject({ error: 'REST API/Unprocessable Entity', message: `Parameter '${name}' must have an integer value!` })
        }
      }

      // a time needs a zone; the error has no message
      expect(await list('dateFrom=2026-01-01&revert=false')).toHaveLength(6)
      expect(await list(`dateFrom=${q('2026-01-01T12:04:00+02:00')}`)).toEqual(['@5', 'A,B@4'])
      for (const value of ['2026-01-01T10:03:00', '2026-01-01T10:03Z', '2026-01', '1767261780000', '']) {
        const res = await call(client, 'GET', `/measurement/measurements?source=${device.id}&dateTo=${q(value)}`)
        expect(res.status, value).toBe(422)
        expect(res.json.error).toBe(`${value} is not a valid date./Invalid Data`)
        expect(res.json.message).toBeUndefined()
      }
    },
  },
  {
    name: 'measurements: delete by filter sees numeric series, one type, hours in the given zone',
    verifies: ['measurement-delete-filters'],
    async run({ client, unique, settle }) {
      const { data: device } = await client.inventory.create({ name: `r1108data-mdf-${unique}`, c8y_IsDevice: {} })
      const { data: other } = await client.inventory.create({ name: `r1108data-mdf2-${unique}`, c8y_IsDevice: {} })
      const type = `mdf-${unique}`
      const add = (hour: number, measurementType: string, fragments: Record<string, unknown>, id = device.id) => call(client, 'POST', '/measurement/measurements', { source: { id }, type: measurementType, time: at(hour), ...fragments })
      await add(1, type, { fa: { s: { value: 1 } } })
      await add(2, `${type}2`, { fb: { s: { value: 2 } }, plain: { x: 'y' } })
      await add(3, type, { nov: { s: { unit: 'u' } } })
      await add(4, `${type},${type}2`, { fa: { s: { value: 4 } } })
      await add(5, type, { fa: { s: { value: 5 } } }, other.id)
      await add(6, type, { fa: { t: { value: 6 } } })
      const left = async () => (await call(client, 'GET', `/measurement/measurements?source=${device.id}&pageSize=100&revert=false&dateFrom=2026-01-01&dateTo=2026-01-02`)).json.measurements.map((measurement: any) => new Date(measurement.time).getUTCHours())
      const del = async (params: string, status = 204) => {
        const res = await call(client, 'DELETE', `/measurement/measurements?${params}`)
        expect(res.status, params).toBe(status)
        return res
      }
      await eventually(async () => {
        expect(await left()).toEqual([1, 2, 3, 4, 6])
      })

      // nothing matches: fragments without a numeric value, a type list, an empty or unknown source
      await del(`source=${device.id}&fragmentType=nov`)
      await del(`source=${device.id}&fragmentType=plain`)
      await del(`source=${device.id}&type=${type},${type}2&dateTo=${q(at(4))}`)
      await del(`source=&type=${type}`)
      await del(`source=999999999999&type=${type}`)
      await settle(2000)
      expect(await left()).toEqual([1, 2, 3, 4, 6])
      expect((await call(client, 'GET', `/measurement/measurements?source=${other.id}`)).json.measurements).toHaveLength(1)

      // valueFragmentType is not a delete filter; the type is one value
      await del(`source=${device.id}&type=${type}2&valueFragmentType=fa`)
      await eventually(async () => {
        expect(await left()).toEqual([1, 3, 4, 6])
      })
      await del(`source=${device.id}&type=${q(`${type},${type}2`)}`)
      await eventually(async () => {
        expect(await left()).toEqual([1, 3, 6])
      })

      // full hours in the zone given; a time needs a zone
      expect((await del(`source=${device.id}&dateFrom=${q('2026-01-01T03:00:01Z')}`, 422)).json).toMatchObject({ error: 'measurement/Invalid Data', message: 'Date from and date to parameters used for delete filter must be truncated to hour!' })
      await del(`source=${device.id}&dateFrom=${q('2026-01-01T03:00:00.001Z')}`, 422)
      expect((await del(`source=${device.id}&dateFrom=2026-01-01T01:00:00`, 422)).json.error).toBe('2026-01-01T01:00:00 is not a valid date./Invalid Data')
      await del(`source=${device.id}&dateFrom=${q('2026-01-01T03:00:00+02:00')}&dateTo=${q('2026-01-01T04:00:00+02:00')}`)
      await eventually(async () => {
        expect(await left()).toEqual([3, 6])
      })
      await del(`source=${device.id}&dateTo=${q('2026-01-01T09:00:00+05:30')}&pageSize=1&revert=true`)
      await eventually(async () => {
        expect(await left()).toEqual([6])
      })
    },
  },
  {
    name: 'measurements: series units, case, validation order, series format',
    verifies: ['series-validation-statuses', 'series-unit'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `r1108data-su-${unique}`, c8y_IsDevice: {} })
      const units: Record<string, Array<string | undefined>> = { a: ['C', 'K'], b: ['K', 'C'], c: ['C', undefined], d: [undefined, 'C'], e: ['C', 'C', 'K', 'C'], f: ['', 'C'], g: ['A', 'B', 'Z', 'Y'] }
      for (let minute = 0; minute < 4; minute++) {
        const fragment = Object.fromEntries(Object.entries(units).filter(([, list]) => minute < list.length).map(([name, list]) => [name, { value: minute + 1, ...(list[minute] === undefined ? {} : { unit: list[minute] }) }]))
        await call(client, 'POST', '/measurement/measurements', { source: { id: device.id }, type: 'U', time: time(minute), u: fragment })
      }
      const base = `/measurement/measurements/series?source=${device.id}&dateFrom=${q(at(9))}&dateTo=${q(at(14))}`
      const series = async (params: string) => {
        const res = await call(client, 'GET', `${base}&${params}`)
        return res.status === 200 ? res.json : { status: res.status, error: res.json?.error, message: res.json?.message }
      }
      // the platform lists the series in no fixed order: compare by name
      const unitsOf = (json: any) => Object.fromEntries(json.series.map((item: any) => [item.name, item.unit]))
      await eventually(async () => {
        expect((await series('series=u.e')).values).toBeDefined()
        expect(Object.keys((await series('series=u.e')).values)).toHaveLength(4)
      })

      // the smallest unit in the newest bucket (with revert=false the oldest bucket), '' without one
      expect(unitsOf(await series(''))).toEqual({ a: 'K', b: 'C', c: '', d: 'C', e: 'C', f: 'C', g: 'Y' })
      expect(unitsOf(await series('revert=false'))).toEqual({ a: 'C', b: 'K', c: 'C', d: '', e: 'C', f: '', g: 'A' })
      expect(unitsOf(await series('aggregationInterval=1h'))).toEqual({ a: 'C', b: 'C', c: 'C', d: 'C', e: 'C', f: 'C', g: 'A' })
      expect(unitsOf(await series('aggregationInterval=2m'))).toEqual({ a: 'C', b: 'C', c: 'C', d: 'C', e: 'C', f: 'C', g: 'Y' })
      expect(unitsOf(await series('aggregationInterval=2m&revert=false'))).toEqual({ a: 'C', b: 'C', c: 'C', d: 'C', e: 'C', f: 'C', g: 'A' })

      // aggregation types and functions in any case
      const hourly = await series('series=u.e&aggregationType=hourly&aggregationFunction=MAX&aggregationFunction=Avg')
      expect(hourly.values).toEqual({ [at(10)]: [{ max: 4, avg: 2.5 }] })
      // an interval wins over the type, which is then not checked
      expect((await series('series=u.e&aggregationType=BOGUS&aggregationInterval=2m')).values).toEqual({ [time(0)]: [{ min: 1, max: 2 }], [time(2)]: [{ min: 3, max: 4 }] })

      const badType = { status: 400, error: 'measurements/Bad Request', message: 'The aggregationType param value is incorrect. Possible values: [HOURLY, DAILY, MINUTELY]' }
      const badFunction = { status: 400, error: 'measurements/Bad Request', message: 'The aggregationFunction param value is incorrect. Possible values: [min, max, avg, sum, count, stdDevPop, stdDevSamp]' }
      const badInterval = (value: string) => ({ status: 422, error: 'measurements/Invalid Data', message: `Invalid aggregation interval: ${value}` })
      const badSeries = (value: string) => ({ status: 422, error: 'measurement/Unprocessable Entity', message: `The series param ${value} has wrong format. Valid format is measurement_type.series_name` })
      expect(await series('aggregationType=')).toEqual(badType)
      expect(await series('aggregationType=WEEKLY')).toEqual(badType)
      expect(await series('aggregationInterval=1h&aggregationFunction=')).toEqual(badFunction)
      expect(await series('aggregationInterval=1h&aggregationFunction=min,max')).toEqual(badFunction)
      for (const value of ['', '0m', '1000m', '1H', '1D', '1ms', 'h', 'PT1H']) {
        expect(await series(`aggregationInterval=${value}`), value).toEqual(badInterval(value))
      }
      for (const value of ['u', 'u.a.b', '.a', 'u.', '', 'u.a,u.b']) {
        expect(await series(`series=${q(value)}`), value).toEqual(badSeries(value))
      }
      expect((await series('series=u.*')).series).toEqual([])
      // order: interval, type, functions, functions without interval, series
      expect(await series('aggregationInterval=5x&aggregationType=BOGUS&aggregationFunction=bogus&series=bad')).toEqual(badInterval('5x'))
      expect(await series('aggregationType=BOGUS&aggregationFunction=bogus&series=bad')).toEqual(badType)
      expect(await series('aggregationFunction=bogus&series=bad')).toEqual(badFunction)
      expect(await series('aggregationFunction=avg&series=bad')).toMatchObject({ status: 422, error: 'measurements/Invalid Data' })

      // an empty or unknown source is an empty result, a time needs a zone
      for (const source of ['', 'abc', '999999999999']) {
        const res = await call(client, 'GET', `/measurement/measurements/series?source=${source}&dateFrom=${q(at(9))}&dateTo=${q(at(14))}&series=u.a`)
        expect(res.json, source).toEqual({ values: {}, series: [], truncated: false })
      }
      const zoneless = await call(client, 'GET', `/measurement/measurements/series?source=${device.id}&dateFrom=2026-01-01T09:00:00&dateTo=${q(at(14))}`)
      expect(zoneless.status).toBe(422)
      expect(zoneless.json.error).toBe('2026-01-01T09:00:00 is not a valid date./Invalid Data')
      expect(Object.keys((await call(client, 'GET', `/measurement/measurements/series?source=${device.id}&dateFrom=2026-01-01&dateTo=2026-01-02&series=u.a`)).json.values)).toEqual([time(0), time(1)])
    },
  },
  {
    name: 'measurements: series keeps the latest 5000 times',
    verifies: ['series-truncated'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `r1108data-st-${unique}`, c8y_IsDevice: {} })
      const start = Date.UTC(2026, 0, 2)
      const total = 5003
      for (let first = 0; first < total; first += 1000) {
        const measurements = Array.from({ length: Math.min(1000, total - first) }, (_, offset) => ({ source: { id: device.id }, type: 'tr', time: new Date(start + (first + offset) * 1000).toISOString(), tr: { v: { value: first + offset }, ...((first + offset) % 2 === 0 ? { w: { value: 1 } } : {}) } }))
        expect((await send(client, 'POST', '/measurement/measurements', { measurements }, COLLECTION)).status).toBe(201)
      }
      const series = async (params: string) => (await call(client, 'GET', `/measurement/measurements/series?source=${device.id}&dateFrom=${q(new Date(start).toISOString())}&dateTo=${q(new Date(start + 86_400_000).toISOString())}&${params}`)).json
      await eventually(async () => {
        expect(Object.keys((await series('series=tr.v&aggregationInterval=1d&aggregationFunction=count')).values)).toHaveLength(1)
        expect(Object.values((await series('series=tr.v&aggregationInterval=1d&aggregationFunction=count')).values)).toEqual([[{ count: total }]])
      }, 15_000)
      for (const params of ['series=tr.v', '', 'series=tr.v&aggregationInterval=1s']) {
        const json = await series(params)
        const keys = Object.keys(json.values)
        expect(json.truncated, params).toBe(true)
        expect(keys).toHaveLength(5000)
        expect(keys[0]).toBe(new Date(start + 3000).toISOString())
        expect(keys.at(-1)).toBe(new Date(start + (total - 1) * 1000).toISOString())
      }
      const halved = await series('series=tr.v&aggregationInterval=2s')
      expect(halved.truncated).toBe(false)
      expect(Object.keys(halved.values)).toHaveLength(2502)
    },
  },

  {
    name: 'measurements: series entries of a series without a value (null, count-only buckets)',
    verifies: ['series-missing-entries'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `sn-${unique}`, c8y_IsDevice: {} })
      const measurement = (minute: number, fragments: Record<string, unknown>) => ({ source: { id: device.id }, type: `sn-${unique}`, time: time(minute), ...fragments })
      await client.measurement.create(measurement(0, { c8y_Temperature: { T: { value: 21.5, unit: 'C' } } }))
      await client.measurement.create(measurement(1, { c8y_Temperature: { T: { value: 22.5, unit: 'C' } }, c8y_Humidity: { H: { value: 50, unit: '%' } } }))
      await client.measurement.create(measurement(2, { c8y_Humidity: { H: { value: 55, unit: '%' } } }))
      const base = `/measurement/measurements/series?source=${device.id}&dateFrom=${q(time(0))}&dateTo=${q(time(10))}&series=c8y_Temperature.T&series=c8y_Humidity.H`
      // the order of `series` varies on the platform: read entries by series name
      const entries = (json: any) => {
        const index = (name: string) => json.series.findIndex((item: { name: string }) => item.name === name)
        return Object.fromEntries(Object.entries(json.values).map(([at, values]: [string, any]) => [at, { T: values[index('T')], H: values[index('H')] }]))
      }
      // without aggregation, a series without a value at that time is null
      const plain = entries((await call(client, 'GET', base)).json)
      expect(plain[time(0)]).toEqual({ T: { min: 21.5, max: 21.5 }, H: null })
      expect(plain[time(1)]).toEqual({ T: { min: 22.5, max: 22.5 }, H: { min: 50, max: 50 } })
      expect(plain[time(2)]).toEqual({ T: null, H: { min: 55, max: 55 } })
      // with aggregation functions, an empty bucket keeps only the functions that have a value
      const aggregated = entries((await call(client, 'GET', `${base}&aggregationInterval=1m&aggregationFunction=avg&aggregationFunction=count`)).json)
      expect(aggregated[time(0)]).toEqual({ T: { avg: 21.5, count: 1 }, H: { count: 0 } })
      expect(aggregated[time(2)]).toEqual({ T: { count: 0 }, H: { avg: 55, count: 1 } })
      const minMax = entries((await call(client, 'GET', `${base}&aggregationInterval=1m&aggregationFunction=min&aggregationFunction=max`)).json)
      expect(minMax[time(0)]).toEqual({ T: { min: 21.5, max: 21.5 }, H: null })
    },
  },
]
