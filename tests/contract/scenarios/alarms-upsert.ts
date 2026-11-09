import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { eventually, time } from '../helpers'

async function api(client: Client, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await client.core.fetch(path, { method, headers: { 'content-type': 'application/json', 'accept': 'application/json', ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) })
  const text = await res.text()
  let parsed: any = text || undefined
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {}
  return { status: res.status, body: parsed }
}

const activeAlarms = async (client: Client, id: string) => (await api(client, 'GET', `/inventory/managedObjects/${id}`)).body.c8y_ActiveAlarmsStatus

export const alarmsUpsertScenarios: ContractScenario[] = [
  {
    name: 'alarms: upsert creates with defaults and updates the open alarm',
    verifies: ['alarm-upsert'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `up-${unique}`, c8y_IsDevice: {} })
      const type = `up-${unique}`
      const upsert = (body: Record<string, unknown>, query = '') => api(client, 'POST', `/alarm/alarms/upsert${query}`, { source: { id: device.id }, type, ...body })

      const created = await upsert({})
      expect(created.status).toBe(201)
      expect(created.body.previousState).toBeNull()
      expect(created.body.alarm).toMatchObject({ type, text: '', severity: 'MAJOR', status: 'ACTIVE', count: 1, source: { id: device.id } })
      expect(created.body.alarm.time).toBe(created.body.alarm.creationTime)
      const id = created.body.alarm.id
      expect(await activeAlarms(client, device.id)).toEqual({ critical: 0, major: 1, minor: 0, warning: 0 })

      // text, severity, status, and fragments change; the time and count stay
      const updated = await upsert({ severity: 'CRITICAL', text: 'changed', time: time(1), c8y_Extra: { a: 1 } })
      expect(updated.status).toBe(200)
      expect(updated.body.alarm).toMatchObject({ id, text: 'changed', severity: 'CRITICAL', count: 1, time: created.body.alarm.time, c8y_Extra: { a: 1 } })
      expect(updated.body.previousState).toMatchObject({ id, text: '', severity: 'MAJOR' })
      expect(updated.body.previousState.c8y_Extra).toBeUndefined()
      expect(await activeAlarms(client, device.id)).toEqual({ critical: 1, major: 0, minor: 0, warning: 0 })

      // only incrementCount=true counts, and without a first occurrence
      expect((await upsert({}, '?incrementCount=TRUE')).body.alarm.count).toBe(2)
      for (const value of ['yes', '', 'false']) {
        expect((await upsert({}, `?incrementCount=${value}`)).body.alarm.count, value).toBe(2)
      }
      expect((await upsert({}, '?incrementCount=true')).body.alarm).toMatchObject({ count: 3 })
      expect((await api(client, 'GET', `/alarm/alarms/${id}`)).body.firstOccurrenceTime).toBeUndefined()

      // null keeps the values; an acknowledged alarm is updated too
      expect((await upsert({ status: 'ACKNOWLEDGED' })).body.alarm.status).toBe('ACKNOWLEDGED')
      expect((await upsert({ text: null, severity: null, status: null })).body.alarm).toMatchObject({ id, text: 'changed', severity: 'CRITICAL', status: 'ACKNOWLEDGED' })

      // CLEARED clears it; the next upsert creates a new alarm with the given time
      expect((await upsert({ status: 'CLEARED' })).body.alarm).toMatchObject({ id, status: 'CLEARED' })
      expect(await activeAlarms(client, device.id)).toEqual({ critical: 0, major: 0, minor: 0, warning: 0 })
      const fresh = await upsert({ severity: 'MINOR', text: 'again', time: time(2) })
      expect(fresh.status).toBe(201)
      expect(fresh.body.alarm).toMatchObject({ text: 'again', severity: 'MINOR', status: 'ACTIVE', count: 1, time: time(2) })
      expect(fresh.body.alarm.id).not.toBe(id)

      // POST deduplicates into an upserted alarm and the other way round
      const posted = await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type, text: 'p', severity: 'MAJOR', time: time(3) })
      expect(posted.body).toMatchObject({ id: fresh.body.alarm.id, count: 2, text: 'again', firstOccurrenceTime: time(2), time: time(3) })

      // a new alarm can be created ACKNOWLEDGED or CLEARED; severity and status are not validated
      const acknowledged = await api(client, 'POST', '/alarm/alarms/upsert', { source: { id: device.id }, type: `${type}-a`, status: 'ACKNOWLEDGED', severity: 'WARNING' })
      expect(acknowledged.body.alarm).toMatchObject({ status: 'ACKNOWLEDGED', severity: 'WARNING' })
      const odd = await api(client, 'POST', '/alarm/alarms/upsert', { source: { id: device.id }, type: `${type}-o`, status: 'BOGUS', severity: 'SEVERE', text: 5 })
      expect(odd.status).toBe(201)
      expect(odd.body.alarm).toMatchObject({ status: 'BOGUS', severity: 'SEVERE', text: '5' })
      const empty = await api(client, 'POST', '/alarm/alarms/upsert', { source: { id: device.id }, type: `${type}-e`, severity: '' })
      expect(empty.body.alarm.severity).toBe('MAJOR')

      // every upsert of an existing alarm is audited, also without changes (a deduplicating POST is not)
      expect((await upsert({})).body.alarm).toMatchObject({ id: fresh.body.alarm.id, count: 2 })
      await eventually(async () => {
        const audit = await api(client, 'GET', `/audit/auditRecords?source=${fresh.body.alarm.id}&pageSize=100`)
        const records = audit.body.auditRecords.filter((record: { activity: string }) => record.activity.startsWith('Alarm'))
        expect(records.map((record: { activity: string, changes?: unknown }) => [record.activity, record.changes ?? null])).toEqual([['Alarm created', null], ['Alarm updated', []]])
      })
    },
  },
  {
    name: 'alarms: upsert validation, media types, methods',
    verifies: ['alarm-upsert-validation'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `upv-${unique}`, c8y_IsDevice: {} })
      const type = `upv-${unique}`
      const upsert = (body: unknown, headers: Record<string, string> = {}) => api(client, 'POST', '/alarm/alarms/upsert', body, headers)
      const rejected = async (body: unknown, status: number, error: string, message?: string) => {
        const answer = await upsert(body)
        expect(answer.status, JSON.stringify(body)).toBe(status)
        expect(answer.body.error, JSON.stringify(body)).toBe(error)
        if (message !== undefined) {
          expect(answer.body.message, JSON.stringify(body)).toContain(message)
        }
      }
      await rejected({}, 422, 'undefined/validationError', 'upsert.upsertRepresentation.source: is required')
      await rejected({ source: null, type }, 422, 'undefined/validationError', 'upsert.upsertRepresentation.source: is required')
      await rejected({ source: {} }, 422, 'undefined/validationError', 'upsert.upsertRepresentation.type: is required')
      await rejected({ source: { id: null }, type }, 422, 'undefined/validationError', 'upsert.upsertRepresentation.source.id: is required')
      await rejected({ source: { id: device.id }, type, id: '1', count: 3 }, 422, 'undefined/validationError', 'upsert.upsertRepresentation: Field \'customProperties\' contains prohibited keys: count, id')
      for (const field of ['creationTime', 'lastUpdated', 'firstOccurrenceTime']) {
        await rejected({ source: { id: device.id }, type, [field]: time(1) }, 422, 'undefined/validationError', `prohibited keys: ${field}`)
      }
      await rejected({ source: { id: '1' }, type }, 404, 'inventory/Not Found', 'No managedObject for id \'1\'!')
      await rejected({ source: device.id, type }, 400, 'Failed to parse JSON string', 'AlarmUpsertRepresentation$Source')
      await rejected({ source: { id: device.id }, type, text: { a: 1 } }, 400, 'Failed to parse JSON string', 'AlarmUpsertRepresentation["text"]')
      await rejected({ source: { id: device.id }, type, time: 'yesterday' }, 400, 'Failed to parse JSON string', 'Invalid format: "yesterday" (through reference chain: com.cumulocity.rest.representation.alarm.AlarmUpsertRepresentation["time"])')
      // a numeric time is a year, and an instant above 9999 cannot be read
      await rejected({ source: { id: device.id }, type, time: 12345 }, 500, 'general/internalError', 'Failed to parse string as a date : Text \'12345-01-01T00:00:00.000Z\' could not be parsed at index 0')
      expect((await upsert({ source: { id: device.id }, type: `${type}-n`, time: 2026 })).body.alarm.time).toBe('2026-01-01T00:00:00.000Z')
      expect((await upsert({ source: { id: device.id }, type: `${type}-s`, self: 'x' })).status).toBe(201)

      expect((await upsert(JSON.stringify({ source: { id: device.id }, type }), { 'content-type': 'text/plain' })).status).toBe(415)
      expect((await upsert({ source: { id: device.id }, type: `${type}-v` }, { 'content-type': 'application/vnd.com.nsn.cumulocity.alarm+json' })).status).toBe(201)
      expect((await upsert({ source: { id: device.id }, type: `${type}-acc` }, { accept: 'application/vnd.com.nsn.cumulocity.alarm+json' })).status).toBe(406)
      const noBody = await upsert({ source: { id: device.id }, type: `${type}-any` }, { accept: '*/*' })
      expect(noBody).toEqual({ status: 201, body: undefined })
      for (const method of ['GET', 'PUT', 'DELETE']) {
        expect((await api(client, method, '/alarm/alarms/upsert', method === 'PUT' ? {} : undefined)).status, method).toBe(405)
      }
    },
  },
  {
    name: 'alarms: deduplication keeps the latest time and the earliest first occurrence',
    verifies: ['alarm-deduplication-times'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `dt-${unique}`, c8y_IsDevice: {} })
      const type = `dt-${unique}`
      const post = async (minute: number, extra: Record<string, unknown> = {}) => (await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type, text: 'first', severity: 'MAJOR', time: time(minute), ...extra })).body
      const first = await post(1)
      expect(await post(5)).toMatchObject({ id: first.id, count: 2, time: time(5), firstOccurrenceTime: time(1) })
      // an older occurrence moves the first occurrence back, not the time
      expect(await post(0)).toMatchObject({ id: first.id, count: 3, time: time(5), firstOccurrenceTime: time(0) })

      // acknowledged alarms absorb new ones and stay acknowledged, whatever status is sent
      await api(client, 'PUT', `/alarm/alarms/${first.id}`, { status: 'ACKNOWLEDGED' })
      expect(await post(6, { status: 'ACTIVE' })).toMatchObject({ id: first.id, count: 4, status: 'ACKNOWLEDGED' })
      expect(await activeAlarms(client, device.id)).toEqual({ critical: 0, major: 1, minor: 0, warning: 0 })

      // two open alarms of a type (a cleared one set ACTIVE again): the one with the earliest time absorbs
      await api(client, 'PUT', `/alarm/alarms/${first.id}`, { status: 'CLEARED' })
      const second = await post(10)
      expect(second.id).not.toBe(first.id)
      await api(client, 'PUT', `/alarm/alarms/${first.id}`, { status: 'ACTIVE' })
      expect(await activeAlarms(client, device.id)).toEqual({ critical: 0, major: 2, minor: 0, warning: 0 })
      expect(await post(11)).toMatchObject({ id: first.id, count: 5, time: time(11) })
      expect(await post(12)).toMatchObject({ id: second.id, count: 2, time: time(12), firstOccurrenceTime: time(10) })
    },
  },
  {
    name: 'alarms, events, measurements: a numeric time is a year',
    verifies: ['numeric-time-year'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `nt-${unique}`, c8y_IsDevice: {} })
      const post = (path: string, body: Record<string, unknown>) => api(client, 'POST', path, { source: { id: device.id }, ...body })
      const alarm = (type: string, value: unknown) => post('/alarm/alarms', { type: `${type}-${unique}`, text: 't', severity: 'MINOR', time: value })
      const event = (type: string, value: unknown) => post('/event/events', { type: `${type}-${unique}`, text: 't', time: value })
      const measurement = (type: string, value: unknown) => post('/measurement/measurements', { type: `${type}-${unique}`, time: value, c8y_T: { T: { value: 1 } } })
      for (const [value, rendered] of [[12345, '12345-01-01T00:00:00.000Z'], [2026, '2026-01-01T00:00:00.000Z'], [0, '0000-01-01T00:00:00.000Z'], ['12345', '12345-01-01T00:00:00.000Z']] as const) {
        for (const create of [alarm, event, measurement]) {
          const answer = await create(`y${typeof value}${value}`, value)
          expect(answer.status, `${create.name} ${value}`).toBe(201)
          expect(answer.body.time, `${create.name} ${value}`).toBe(rendered)
        }
      }
      // a negative year: alarms and events store it, measurements reject it
      expect((await alarm('neg', -1)).body.time).toBe('-0001-01-01T00:00:00.000Z')
      expect((await event('neg', -1)).body.time).toBe('-0001-01-01T00:00:00.000Z')
      const negative = await measurement('neg', -1)
      expect(negative.status).toBe(422)
      expect(negative.body.error).toBe('Invalid date -0001-01-01T00:00:00.000Z/Invalid Data')
      // what is not a year is a format error
      for (const [value, rest] of [[1.5, '.5'], [1730000000000, '0000'], [true, 'rue']] as const) {
        const answer = await event('bad', value)
        expect(answer.status).toBe(400)
        expect(answer.body.message).toContain(`Invalid format: "${String(value)}" is malformed at "${rest}"`)
      }
      // deduplicating into an alarm with a year above 9999 fails
      const duplicate = await alarm('ynumber12345', 12345)
      expect(duplicate.status).toBe(422)
      expect(duplicate.body).toMatchObject({ error: 'alarm/Invalid Data', message: 'Error updating duplicate alarm! : Failed to parse string as a date' })

      // such times sort and filter as times; a query takes them with 4 to 9 year digits
      const events = async (query: string) => {
        const answer = await api(client, 'GET', `/event/events?source=${device.id}&pageSize=100${query}`)
        return answer.status === 200 ? answer.body.events.map((item: { time: string }) => item.time) : answer.status
      }
      expect(await events('')).toEqual(['12345-01-01T00:00:00.000Z', '12345-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '0000-01-01T00:00:00.000Z', '-0001-01-01T00:00:00.000Z'])
      expect(await events('&dateFrom=2027-01-01')).toEqual(['12345-01-01T00:00:00.000Z', '12345-01-01T00:00:00.000Z'])
      expect(await events('&dateFrom=12345-01-01&dateTo=12346-01-01')).toHaveLength(2)
      expect(await events('&dateTo=-000001-01-02')).toEqual(['-0001-01-01T00:00:00.000Z'])
      expect(await events('&dateFrom=12345')).toBe(422)
      expect(await events('&dateFrom=%2B012345-01-01')).toHaveLength(2)
      const alarms = await api(client, 'GET', `/alarm/alarms?source=${device.id}&pageSize=100&dateFrom=2027-01-01`)
      expect(alarms.body.alarms.map((item: { time: string }) => item.time)).toEqual(['12345-01-01T00:00:00.000Z', '12345-01-01T00:00:00.000Z'])
      const series = await api(client, 'GET', `/measurement/measurements/series?source=${device.id}&dateFrom=2000-01-01&dateTo=20000-01-01`)
      expect(Object.keys(series.body.values)).toEqual(['2026-01-01T00:00:00.000Z', '12345-01-01T00:00:00.000Z'])

      // a year with a sign is read too
      for (const [value, rendered] of [['+12345-01-01T00:00:00Z', '12345-01-01T00:00:00.000Z'], ['+002026-01-01', '2026-01-01T00:00:00.000Z']] as const) {
        for (const create of [alarm, event, measurement]) {
          const answer = await create(`plus${rendered.slice(0, 5)}`, value)
          expect([answer.status, answer.body.time], `${create.name} ${value}`).toEqual([201, rendered])
        }
      }
      // deduplication fails when either time is above 9999, the stored one or the new one
      for (const [type, first, second] of [['far-old', '12345-01-01T00:00:00Z', '2026-01-01T00:00:00Z'], ['far-new', '2026-01-01T00:00:00Z', '12345-01-01T00:00:00Z']] as const) {
        expect((await alarm(type, first)).status, type).toBe(201)
        const failed = await alarm(type, second)
        expect([failed.status, failed.body.message], type).toEqual([422, 'Error updating duplicate alarm! : Failed to parse string as a date'])
      }
    },
  },
  {
    name: 'availability: c8y_RequiredAvailability changes are audited',
    verifies: ['availability-audit'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `aa-${unique}`, c8y_IsDevice: {}, c8y_RequiredAvailability: { responseInterval: 5 } } as any)
      const id = device.id
      const expected: string[] = [`Device availability enabled: device with id: ${id} enabled availability monitoring with required interval: 5`]
      const check = async () => eventually(async () => {
        const answer = await api(client, 'GET', `/audit/auditRecords?source=${id}&type=DevicesAvailabilityMonitoring&pageSize=100`)
        const records = answer.body.auditRecords as Array<{ activity: string, text: string, user?: string }>
        expect(records.map((record) => `${record.activity}: ${record.text}`)).toEqual(expected)
        expect(records.every((record) => typeof record.user === 'string')).toBe(true)
      }, 10_000)
      await check()
      const put = (interval: number | null) => api(client, 'PUT', `/inventory/managedObjects/${id}`, { c8y_RequiredAvailability: interval === null ? null : { responseInterval: interval } })
      await put(5)
      await put(7)
      expected.push(`Required interval changed: Interval assigned to the device with id: ${id} is changed to 7`)
      await check()
      await put(0)
      await put(-1)
      expected.push(`Device put into maintenance state: device with id: ${id} is put into maintenance state`, `Device put into maintenance state: device with id: ${id} is put into maintenance state`)
      await check()
      // from maintenance it is a change of the interval
      await put(5)
      expected.push(`Required interval changed: Interval assigned to the device with id: ${id} is changed to 5`)
      await check()
      await put(null)
      expected.push(`Device availability disabled: device with id: ${id} disabled availability monitoring`)
      await check()
    },
  },
]
