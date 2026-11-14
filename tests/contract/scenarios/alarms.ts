import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { eventually, sleep, time } from '../helpers'

async function api(client: Client, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await client.core.fetch(path, { method, headers: { 'content-type': 'application/json', 'accept': 'application/json', ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) })
  const text = await res.text()
  let parsed: any = text || undefined
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {}
  return { status: res.status, body: parsed, location: res.headers.get('location') }
}

const DAY = 86_400_000

export const alarmsScenarios: ContractScenario[] = [
  {
    name: 'alarms: deduplication while active, clearing, bulk update',
    verifies: ['alarm-deduplication'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `a-${unique}`, c8y_IsDevice: {} })
      const alarm = { source: { id: device.id }, type: `al-${unique}`, text: 'Too hot', severity: 'MAJOR', time: time(1) }

      const { data: first } = await client.alarm.create(alarm as any)
      const { data: duplicate } = await client.alarm.create({ ...alarm, time: time(2) } as any)
      expect(duplicate.id).toBe(first.id)
      expect(duplicate.count).toBe(2)

      await client.alarm.update({ id: first.id, status: 'CLEARED' } as any)
      const { data: fresh } = await client.alarm.create({ ...alarm, time: time(3) } as any)
      expect(fresh.id).not.toBe(first.id)
      expect(fresh.count).toBe(1)

      await client.alarm.updateBulk({ status: 'ACKNOWLEDGED' } as any, { source: device.id, status: 'ACTIVE' } as any)
      const { data: acknowledged } = await client.alarm.list({ source: device.id, status: 'ACKNOWLEDGED' } as any)
      expect(acknowledged.map((item) => item.id)).toEqual([fresh.id])
    },
  },
  {
    name: 'alarms: severity and resolved filters, acknowledged deduplication, unvalidated severity',
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `al2-${unique}`, c8y_IsDevice: {} })
      const alarm = (type: string, severity: string) => ({ source: { id: device.id }, type, text: type, severity, time: time(1) })
      const { data: major } = await client.alarm.create(alarm(`major-${unique}`, 'MAJOR') as any)
      const { data: minor } = await client.alarm.create(alarm(`minor-${unique}`, 'MINOR') as any)

      const ids = async (filter: Record<string, unknown>) => (await client.alarm.list({ source: device.id, pageSize: 100, ...filter } as any)).data.map((item) => item.id).sort()
      expect(await ids({ severity: 'MAJOR' })).toEqual([major.id])

      await client.alarm.update({ id: major.id, status: 'ACKNOWLEDGED' } as any)
      const { data: again } = await client.alarm.create(alarm(`major-${unique}`, 'MAJOR') as any)
      expect(again.id).toBe(major.id)
      expect(again.count).toBe(2)
      expect(again.status).toBe('ACKNOWLEDGED')

      await client.alarm.update({ id: minor.id, status: 'CLEARED' } as any)
      expect(await ids({ resolved: true })).toEqual([minor.id])
      expect(await ids({ resolved: false })).toEqual([major.id])

      // the platform does not validate severity values
      const { res: unknown, data: stored } = await client.alarm.create(alarm(`bad-${unique}`, 'SEVERE') as any)
      expect(unknown.status).toBe(201)
      expect(stored.severity).toBe('SEVERE')
    },
  },
  {
    name: 'alarms: single alarm, 404, read-only fields on update',
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `ro-${unique}`, c8y_IsDevice: {} })
      const { data: other } = await client.inventory.create({ name: `ro2-${unique}`, c8y_IsDevice: {} })
      const created = await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `ro-${unique}`, text: 'first', severity: 'MAJOR', time: time(1) })
      expect(created.status).toBe(201)
      const id = created.body.id

      const fetched = await api(client, 'GET', `/alarm/alarms/${id}`)
      expect(fetched.status).toBe(200)
      expect(fetched.body).toMatchObject({ id, type: `ro-${unique}`, text: 'first', status: 'ACTIVE', severity: 'MAJOR', count: 1, source: { id: device.id }, time: time(1) })
      // set by the platform only when the alarm is deduplicated
      expect(fetched.body.firstOccurrenceTime).toBeUndefined()

      const missing = await api(client, 'GET', '/alarm/alarms/99999999999')
      expect(missing.status).toBe(404)
      expect(missing.body.error).toBe('alarm/Not Found')
      expect((await api(client, 'PUT', '/alarm/alarms/99999999999', { status: 'CLEARED' })).status).toBe(404)

      // type, time, count, and the server-set timestamps are rejected, not ignored
      for (const field of [{ type: 'other' }, { time: time(30) }, { count: 99 }, { creationTime: time(3) }, { lastUpdated: time(3) }, { firstOccurrenceTime: time(3) }]) {
        expect((await api(client, 'PUT', `/alarm/alarms/${id}`, field)).status, JSON.stringify(field)).toBe(422)
      }
      // source, id, and self are silently ignored
      const ignored = await api(client, 'PUT', `/alarm/alarms/${id}`, { source: { id: other.id }, id: '5', self: 'x', text: 'second', severity: 'MINOR' })
      expect(ignored.status).toBe(200)
      expect(ignored.body).toMatchObject({ id, text: 'second', severity: 'MINOR', type: `ro-${unique}`, source: { id: device.id }, time: time(1), count: 1 })
      expect((await api(client, 'GET', `/alarm/alarms/${id}`)).body).toMatchObject({ id, text: 'second', source: { id: device.id } })
    },
  },
  {
    name: 'alarms: deduplication keeps text and severity, tracks count and first occurrence',
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `dd-${unique}`, c8y_IsDevice: {} })
      const { data: other } = await client.inventory.create({ name: `dd2-${unique}`, c8y_IsDevice: {} })
      const post = async (extra: Record<string, unknown>, source = device.id) => (await api(client, 'POST', '/alarm/alarms', { source: { id: source }, type: `dd-${unique}`, text: 'first', severity: 'MAJOR', time: time(1), ...extra })).body

      const first = await post({})
      expect(first.count).toBe(1)
      expect(first.firstOccurrenceTime).toBeUndefined()

      const second = await post({ time: time(5), text: 'changed', severity: 'CRITICAL' })
      expect(second).toMatchObject({ id: first.id, count: 2, text: 'first', severity: 'MAJOR', time: time(5), firstOccurrenceTime: time(1) })
      expect(await post({ time: time(6) })).toMatchObject({ id: first.id, count: 3, time: time(6), firstOccurrenceTime: time(1) })
      expect((await api(client, 'GET', `/alarm/alarms/${first.id}`)).body).toMatchObject({ count: 3, time: time(6), firstOccurrenceTime: time(1) })

      // another type or another source is another alarm
      expect((await post({ type: `dd-other-${unique}` })).id).not.toBe(first.id)
      expect((await post({}, other.id)).id).not.toBe(first.id)

      // a cleared alarm is not deduplicated into: the type is raised anew
      await client.alarm.update({ id: first.id, status: 'CLEARED' } as any)
      const raised = await post({ time: time(7) })
      expect(raised.id).not.toBe(first.id)
      expect(raised).toMatchObject({ count: 1, status: 'ACTIVE', time: time(7) })
      expect(raised.firstOccurrenceTime).toBeUndefined()
      expect((await api(client, 'GET', `/alarm/alarms/${first.id}`)).body).toMatchObject({ status: 'CLEARED', count: 3 })

      // alarms created as cleared are never merged
      const clearedOne = await post({ type: `cl-${unique}`, status: 'CLEARED' })
      const clearedTwo = await post({ type: `cl-${unique}`, status: 'CLEARED' })
      expect(clearedOne.status).toBe('CLEARED')
      expect(clearedTwo.id).not.toBe(clearedOne.id)
    },
  },
  {
    name: 'alarms: list by type list, dates, created, last updated, severity, status, paging',
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `ls-${unique}`, c8y_IsDevice: {} })
      const { data: other } = await client.inventory.create({ name: `ls2-${unique}`, c8y_IsDevice: {} })
      const make = async (letter: string, minute: number, severity: string) => (await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `${letter}-${unique}`, text: letter, severity, time: time(minute) })).body.id as string
      const a = await make('a', 1, 'MAJOR')
      const b = await make('b', 2, 'MINOR')
      const c = await make('c', 3, 'WARNING')
      const base = `/alarm/alarms?source=${device.id}`
      const ids = async (query: string) => {
        const result = await api(client, 'GET', `${base}&pageSize=100&${query}`)
        expect(result.status, query).toBe(200)
        return result.body.alarms.map((alarm: { id: string }) => alarm.id)
      }

      // newest alarm time first
      expect(await ids('')).toEqual([c, b, a])
      expect(await ids(`type=a-${unique},b-${unique}`)).toEqual([b, a])
      expect(await ids(`type=c-${unique}`)).toEqual([c])
      expect(await ids('severity=MINOR,WARNING')).toEqual([c, b])
      expect(await ids('status=ACTIVE,CLEARED')).toEqual([c, b, a])

      // dateFrom is inclusive, dateTo exclusive
      expect(await ids(`dateFrom=${time(2)}`)).toEqual([c, b])
      expect(await ids(`dateTo=${time(2)}`)).toEqual([a])
      expect(await ids(`dateFrom=${time(2)}&dateTo=${time(3)}`)).toEqual([b])
      // equal bounds select that exact time (the platform does not treat the range as empty)
      expect(await ids(`dateFrom=${time(2)}&dateTo=${time(2)}`)).toEqual([b])
      expect((await api(client, 'GET', `${base}&dateFrom=garbage`)).status).toBe(422)

      // creation time: the whole run is within a day of now
      const before = new Date(Date.now() - DAY).toISOString()
      const after = new Date(Date.now() + DAY).toISOString()
      expect(await ids(`createdFrom=${before}&createdTo=${after}`)).toHaveLength(3)
      expect(await ids(`createdFrom=${before}`)).toHaveLength(3)
      expect(await ids(`createdFrom=${after}`)).toEqual([])
      expect(await ids(`createdTo=${before}`)).toEqual([])

      // last update: updating one alarm moves it out of the earlier range
      await sleep(50)
      const updated = await api(client, 'PUT', `/alarm/alarms/${a}`, { text: 'updated' })
      const marker = updated.body.lastUpdated as string
      expect(await ids(`lastUpdatedFrom=${marker}`)).toEqual([a])
      expect(await ids(`lastUpdatedTo=${marker}`)).toEqual([c, b])
      expect(await ids(`lastUpdatedFrom=${before}&lastUpdatedTo=${after}`)).toHaveLength(3)

      // unknown source: nothing, not an error
      const none = await api(client, 'GET', '/alarm/alarms?source=99999999999')
      expect(none.status).toBe(200)
      expect(none.body.alarms).toEqual([])
      expect(await api(client, 'GET', `/alarm/alarms?source=${other.id}`).then((result) => result.body.alarms)).toEqual([])

      // paging: totals only on request, the next link stops after the last page when totals are asked for
      const page = (query: string) => api(client, 'GET', `${base}&${query}`).then((result) => result.body)
      const first = await page('pageSize=2&currentPage=1&withTotalElements=true&withTotalPages=true')
      expect(first.statistics).toEqual({ currentPage: 1, pageSize: 2, totalElements: 3, totalPages: 2 })
      expect(first.alarms.map((alarm: { id: string }) => alarm.id)).toEqual([c, b])
      expect(first.next).toEqual(expect.any(String))
      const second = await page('pageSize=2&currentPage=2&withTotalElements=true&withTotalPages=true')
      expect(second.alarms.map((alarm: { id: string }) => alarm.id)).toEqual([a])
      expect(second.next).toBeUndefined()
      expect(second.prev).toEqual(expect.any(String))
      const beyond = await page('pageSize=2&currentPage=9&withTotalPages=true')
      expect(beyond.alarms).toEqual([])
      expect(beyond.next).toBeUndefined()
      const plain = await page('pageSize=2&currentPage=2')
      expect(plain.statistics).toEqual({ currentPage: 2, pageSize: 2 })
      expect(plain.next).toEqual(expect.any(String))
      // page size and page number are clamped to at least 1
      const clamped = await page('pageSize=0&currentPage=0')
      expect(clamped.statistics).toMatchObject({ currentPage: 1, pageSize: 1 })
      expect(clamped.alarms).toHaveLength(1)
    },
  },
  {
    name: 'alarms: bulk update by severity, dates, created, resolved; only the status is applied',
    async run({ client, unique, settle }) {
      const { data: device } = await client.inventory.create({ name: `bk-${unique}`, c8y_IsDevice: {} })
      const make = async (letter: string, minute: number, severity: string) => (await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `${letter}-${unique}`, text: 'original', severity, time: time(minute) })).body.id as string
      const a = await make('a', 1, 'MAJOR')
      const b = await make('b', 2, 'MINOR')
      const c = await make('c', 3, 'WARNING')
      const d = await make('d', 4, 'CRITICAL')
      const base = `/alarm/alarms?source=${device.id}`
      const statuses = async () => {
        const result = await api(client, 'GET', `${base}&pageSize=100`)
        return Object.fromEntries(result.body.alarms.map((alarm: { id: string, status: string }) => [alarm.id, alarm.status]))
      }
      const bulk = async (query: string, body: unknown) => {
        const result = await api(client, 'PUT', `${base}&${query}`, body)
        expect(result.status, query).toBe(200)
      }

      // the new status is mandatory, and the rest of the body is ignored
      expect((await api(client, 'PUT', base, { text: 'changed' })).status).toBe(422)
      expect((await api(client, 'PUT', `${base}&severity=MINOR`, { severity: 'CRITICAL' })).status).toBe(422)
      await bulk('severity=MINOR', { status: 'ACKNOWLEDGED', text: 'changed', severity: 'CRITICAL' })
      await eventually(async () => {
        expect(await statuses()).toEqual({ [a]: 'ACTIVE', [b]: 'ACKNOWLEDGED', [c]: 'ACTIVE', [d]: 'ACTIVE' })
      })
      const untouched = (await api(client, 'GET', `/alarm/alarms/${b}`)).body
      expect(untouched).toMatchObject({ text: 'original', severity: 'MINOR' })

      // dateFrom inclusive, dateTo exclusive
      await bulk(`dateFrom=${time(3)}&dateTo=${time(4)}`, { status: 'CLEARED' })
      await eventually(async () => {
        expect(await statuses()).toEqual({ [a]: 'ACTIVE', [b]: 'ACKNOWLEDGED', [c]: 'CLEARED', [d]: 'ACTIVE' })
      })

      // resolved=false covers every alarm that is not cleared
      await bulk('resolved=false', { status: 'ACKNOWLEDGED' })
      await eventually(async () => {
        expect(await statuses()).toEqual({ [a]: 'ACKNOWLEDGED', [b]: 'ACKNOWLEDGED', [c]: 'CLEARED', [d]: 'ACKNOWLEDGED' })
      })

      // created outside the window: nothing matches
      const before = new Date(Date.now() - DAY).toISOString()
      const after = new Date(Date.now() + DAY).toISOString()
      await bulk(`createdFrom=${after}`, { status: 'CLEARED' })
      await bulk(`createdTo=${before}`, { status: 'CLEARED' })
      await settle(1500)
      expect(await statuses()).toEqual({ [a]: 'ACKNOWLEDGED', [b]: 'ACKNOWLEDGED', [c]: 'CLEARED', [d]: 'ACKNOWLEDGED' })

      // created inside the window, resolved=true: only the cleared alarm
      await bulk(`createdFrom=${before}&createdTo=${after}&resolved=true`, { status: 'ACKNOWLEDGED' })
      await eventually(async () => {
        expect(await statuses()).toEqual({ [a]: 'ACKNOWLEDGED', [b]: 'ACKNOWLEDGED', [c]: 'ACKNOWLEDGED', [d]: 'ACKNOWLEDGED' })
      })
    },
  },
  {
    name: 'alarms: filter values ignore case, resolved wins over status, any value but false is true, the first repeated parameter counts',
    verifies: ['alarm-filters-ignore-case', 'query-booleans-not-false', 'query-repeated-first'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `fc-${unique}`, c8y_IsDevice: {} })
      const { data: other } = await client.inventory.create({ name: `fc2-${unique}`, c8y_IsDevice: {} })
      const make = async (letter: string, minute: number, severity: string, status?: string) => (await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `${letter}-${unique}`, text: letter, severity, time: time(minute), ...(status ? { status } : {}) })).body.id as string
      const a = await make('a', 1, 'CRITICAL')
      const b = await make('b', 2, 'MAJOR')
      const c = await make('c', 3, 'MINOR', 'ACKNOWLEDGED')
      const d = await make('d', 4, 'WARNING', 'CLEARED')
      const ids = async (query: string) => {
        const result = await api(client, 'GET', `/alarm/alarms?source=${device.id}&pageSize=100&${query}`)
        expect(result.status, query).toBe(200)
        return result.body.alarms.map((alarm: { id: string }) => alarm.id)
      }
      const count = async (query: string) => (await api(client, 'GET', `/alarm/alarms/count?source=${device.id}&${query}`)).body

      // status and severity values ignore case, in lists too
      expect(await ids('status=active')).toEqual([b, a])
      expect(await ids('status=Acknowledged,cleared')).toEqual([d, c])
      expect(await ids('severity=major')).toEqual([b])
      expect(await ids('severity=Minor,critical')).toEqual([c, a])
      expect(await count('status=active')).toBe(2)
      expect(await count('severity=major')).toBe(1)
      // unknown values and other cases of the type match nothing; an empty value filters nothing
      expect(await ids('status=BOGUS')).toEqual([])
      expect(await ids(`type=A-${unique}`)).toEqual([])
      expect(await ids('status=')).toEqual([d, c, b, a])
      expect(await ids(`type=a-${unique}, b-${unique}`)).toEqual([b, a])

      // resolved: every value but false means true, and it replaces the status filter
      for (const value of ['true', 'TRUE', 'yes', '1', '0', '']) {
        expect(await ids(`resolved=${value}`), value).toEqual([d])
      }
      expect(await ids('resolved=FALSE')).toEqual([c, b, a])
      expect(await ids('resolved=false&status=CLEARED')).toEqual([c, b, a])
      expect(await ids('resolved=true&status=ACTIVE')).toEqual([d])
      expect(await count('resolved=yes')).toBe(1)
      expect(await count('resolved=false&status=CLEARED')).toBe(3)

      // a repeated parameter counts with its first value
      expect(await ids('status=ACTIVE&status=CLEARED')).toEqual([b, a])
      expect(await ids(`type=a-${unique}&type=b-${unique}`)).toEqual([a])
      expect((await api(client, 'GET', `/alarm/alarms?source=${device.id}&source=${other.id}`)).body.alarms).toHaveLength(4)
      expect(await count('status=ACTIVE&status=CLEARED')).toBe(2)
      expect((await api(client, 'GET', `/alarm/alarms/count?source=${device.id}&source=${other.id}`)).body).toBe(4)
    },
  },
  {
    name: 'alarms and events: paging parameters and date errors',
    verifies: ['query-booleans-not-false', 'paging-negative-page', 'paging-error-code', 'date-error-no-message'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `pg-${unique}`, c8y_IsDevice: {} })
      for (const minute of [1, 2, 3]) {
        await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `pg${minute}-${unique}`, text: 't', severity: 'MAJOR', time: time(minute) })
        await api(client, 'POST', '/event/events', { source: { id: device.id }, type: `pg-${unique}`, text: `e${minute}`, time: time(minute) })
      }
      for (const path of ['/alarm/alarms', '/event/events']) {
        const page = async (query: string) => {
          const result = await api(client, 'GET', `${path}?source=${device.id}&${query}`)
          expect(result.status, `${path} ${query}`).toBe(200)
          return result.body
        }
        await eventually(async () => {
          expect((await page('pageSize=100')).statistics).toEqual({ currentPage: 1, pageSize: 100 })
          expect((await page('pageSize=100'))[path === '/event/events' ? 'events' : 'alarms']).toHaveLength(3)
        })
        // every value but false asks for the totals
        for (const value of ['yes', 'TRUE', '0', '']) {
          expect((await page(`pageSize=2&withTotalPages=${value}&withTotalElements=${value}`)).statistics, value).toEqual({ currentPage: 1, pageSize: 2, totalPages: 2, totalElements: 3 })
        }
        expect((await page('pageSize=2&withTotalPages=FALSE&withTotalElements=False')).statistics).toEqual({ currentPage: 1, pageSize: 2 })
        // a negative page is the first page, but the statistics echo it; 0 is 1
        const negative = await page('pageSize=2&currentPage=-3&withTotalPages=true')
        expect(negative.statistics).toEqual({ currentPage: -3, pageSize: 2, totalPages: 2 })
        expect(negative[path === '/event/events' ? 'events' : 'alarms']).toHaveLength(2)
        expect((await page('pageSize=2&currentPage=0')).statistics).toEqual({ currentPage: 1, pageSize: 2 })
        // the first repeated value counts
        expect((await page('pageSize=1&pageSize=abc')).statistics).toEqual({ currentPage: 1, pageSize: 1 })

        for (const name of ['pageSize', 'currentPage']) {
          for (const value of ['abc', '1.5']) {
            const invalid = await api(client, 'GET', `${path}?source=${device.id}&${name}=${value}`)
            expect(invalid.status).toBe(422)
            expect(invalid.body).toMatchObject({ error: 'REST API/Unprocessable Entity', message: `Parameter '${name}' must have an integer value!` })
          }
        }
        // a date error has no message
        for (const name of ['dateFrom', 'createdTo', 'lastUpdatedFrom']) {
          const invalid = await api(client, 'GET', `${path}?source=${device.id}&${name}=abc`)
          expect(invalid.status).toBe(422)
          expect(invalid.body.error).toBe('abc is not a valid date./Invalid Data')
          expect(invalid.body.message).toBeUndefined()
        }
        expect((await api(client, 'GET', `${path}?source=${device.id}&dateTo=`)).body.error).toBe(' is not a valid date./Invalid Data')
      }
      const count = await api(client, 'GET', `/alarm/alarms/count?source=${device.id}&dateFrom=garbage`)
      expect(count.status).toBe(422)
      expect(count.body.message).toBeUndefined()
    },
  },
  {
    name: 'alarms: creation validation, text fields, server-owned fields, time forms, empty severity',
    verifies: ['alarm-event-create-validation', 'text-fields-coerced', 'time-forms-partial', 'alarm-empty-severity-500', 'write-non-json-415'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `cv-${unique}`, c8y_IsDevice: {} })
      const valid = { source: { id: device.id }, type: `cv-${unique}`, text: 'text', severity: 'MAJOR', time: time(1) }
      const post = (body: unknown, headers: Record<string, string> = {}) => api(client, 'POST', '/alarm/alarms', body, headers)

      // one missing field at a time
      for (const field of ['type', 'text', 'severity', 'time']) {
        for (const value of [undefined, null]) {
          const res = await post({ ...valid, [field]: value })
          expect(res.status, field).toBe(422)
          expect(res.body).toMatchObject({ error: 'undefined/validationError', message: `post.alarmRepresentation.${field}: is required` })
        }
      }
      expect((await post({ ...valid, time: '' })).body.message).toBe('post.alarmRepresentation.time: is required')
      // then the source
      for (const source of [undefined, null, {}, { id: null }]) {
        const res = await post({ ...valid, source })
        expect(res.status, JSON.stringify(source)).toBe(422)
        expect(res.body).toMatchObject({ error: 'alarm/Invalid Data', message: 'cannot create an alarm without a source' })
      }
      expect((await post({ ...valid, source: { id: '' } })).status).toBe(404)
      const stringSource = await post({ ...valid, source: device.id })
      expect(stringSource.status).toBe(400)
      expect(stringSource.body.error).toBe('Failed to parse JSON string')

      // server-owned fields are rejected; count, firstOccurrenceTime, and self are ignored
      for (const field of ['id', 'creationTime', 'lastUpdated']) {
        const res = await post({ ...valid, type: `own-${field}-${unique}`, [field]: field === 'id' ? '1' : time(9) })
        expect(res.status, field).toBe(422)
        expect(res.body.message).toBe(`post.alarmRepresentation.${field}: is not allowed here`)
      }
      const ignored = await post({ ...valid, type: `ig-${unique}`, count: 7, firstOccurrenceTime: time(0), self: 'x' })
      expect(ignored.status).toBe(201)
      expect(ignored.body.count).toBe(1)
      expect(ignored.body.firstOccurrenceTime).toBeUndefined()

      // numbers and booleans in text fields become strings, objects are no text
      const numbers = await post({ ...valid, type: 42, text: 7, severity: 5, status: true })
      expect(numbers.status).toBe(201)
      expect(numbers.body).toMatchObject({ type: '42', text: '7', severity: '5', status: 'true' })
      const object = await post({ ...valid, type: `obj-${unique}`, text: { a: 1 } })
      expect(object.status).toBe(400)
      expect(object.body.error).toBe('Failed to parse JSON string')
      expect(object.body.message).toContain('AlarmRepresentation["text"]')
      // empty and unknown values are stored as sent; an empty type is a type
      expect((await post({ ...valid, type: '' })).body.type).toBe('')
      expect((await post({ ...valid, type: `lc-${unique}`, severity: 'minor', status: 'acknowledged' })).body).toMatchObject({ severity: 'minor', status: 'acknowledged' })

      // a year, a month, or a time without seconds is the start of it
      for (const [sent, stored] of [['2026', '2026-01-01T00:00:00.000Z'], ['2026-02', '2026-02-01T00:00:00.000Z'], ['2026-01-01T10', '2026-01-01T10:00:00.000Z'], ['2026-01-01T10:05', '2026-01-01T10:05:00.000Z']]) {
        const res = await post({ ...valid, type: `tf-${sent}-${unique}`, time: sent })
        expect(res.status, sent).toBe(201)
        expect(res.body.time, sent).toBe(stored)
      }
      expect((await post({ ...valid, type: `tf-bad-${unique}`, time: '2026-13-01T10:00:00Z' })).status).toBe(400)

      // an empty severity is stored as none, the creation answers 500; a duplicate is merged
      const empty = await post({ ...valid, type: `es-${unique}`, severity: '' })
      expect(empty.status).toBe(500)
      expect(empty.body.error).toBe('alarm/Internal Server Error')
      const list = await api(client, 'GET', `/alarm/alarms?source=${device.id}&type=es-${unique}`)
      expect(list.body.alarms).toHaveLength(1)
      expect(list.body.alarms[0].severity).toBeUndefined()
      const merged = await post({ ...valid, type: `es-${unique}`, severity: '' })
      expect(merged.status).toBe(201)
      expect(merged.body.count).toBe(2)

      // a content type that is not JSON answers 415 without a body
      const plain = await post(JSON.stringify({ ...valid, type: `pl-${unique}` }), { 'content-type': 'text/plain' })
      expect(plain.status).toBe(415)
      expect(plain.body).toBeUndefined()
    },
  },
  {
    name: 'alarms: update keeps fields sent as null, stores text fields as strings, answers 415 for other content types',
    verifies: ['alarm-update-null-kept', 'text-fields-coerced', 'write-non-json-415'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `un-${unique}`, c8y_IsDevice: {} })
      const { body: alarm } = await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `un-${unique}`, text: 'one', severity: 'MAJOR', time: time(1), c8y_A: { a: 1 } })
      const put = (body: unknown, headers: Record<string, string> = {}) => api(client, 'PUT', `/alarm/alarms/${alarm.id}`, body, headers)

      // text, severity, and status sent as null stay; a fragment sent as null goes
      const nulls = await put({ text: null, severity: null, status: null, c8y_A: null })
      expect(nulls.status).toBe(200)
      expect(nulls.body).toMatchObject({ text: 'one', severity: 'MAJOR', status: 'ACTIVE' })
      expect(nulls.body.c8y_A).toBeUndefined()
      // values are not validated, numbers become strings
      expect((await put({ status: 'acknowledged', severity: 'bogus' })).body).toMatchObject({ status: 'acknowledged', severity: 'bogus' })
      expect((await put({ text: 5, severity: 3 })).body).toMatchObject({ text: '5', severity: '3' })
      const object = await put({ text: { a: 1 } })
      expect(object.status).toBe(400)
      expect(object.body.error).toBe('Failed to parse JSON string')
      // fragments are replaced, an empty update changes nothing
      expect((await put({ c8y_B: { x: 1 } })).body.c8y_B).toEqual({ x: 1 })
      expect((await put({ c8y_B: { y: 2 } })).body.c8y_B).toEqual({ y: 2 })
      expect((await put({})).body).toMatchObject({ text: '5', severity: '3', status: 'acknowledged', c8y_B: { y: 2 } })
      // the id of the alarm itself is accepted
      expect((await put({ id: alarm.id })).status).toBe(200)

      const plain = await put(JSON.stringify({ text: 'plain' }), { 'content-type': 'text/plain' })
      expect(plain.status).toBe(415)
      expect(plain.body).toBeUndefined()
      expect((await api(client, 'GET', `/alarm/alarms/${alarm.id}`)).body.text).toBe('5')
    },
  },
  {
    name: 'alarms: bulk update and delete by filter: case, severity lists, resolved, children',
    verifies: ['alarm-filters-ignore-case', 'alarm-severity-list-single', 'alarms-delete-ignores-children', 'bulk-alarm-status-required'],
    async run({ client, unique, settle }) {
      const { data: device } = await client.inventory.create({ name: `bf-${unique}`, c8y_IsDevice: {} })
      const { data: child } = await client.inventory.create({ name: `bf-child-${unique}`, c8y_IsDevice: {} })
      await client.inventory.childDevicesAdd(child.id, device.id)
      const make = async (source: string, letter: string, minute: number, severity: string, status?: string) => (await api(client, 'POST', '/alarm/alarms', { source: { id: source }, type: `${letter}-${unique}`, text: letter, severity, time: time(minute), ...(status ? { status } : {}) })).body.id as string
      await make(device.id, 'a', 1, 'CRITICAL')
      await make(device.id, 'b', 2, 'MAJOR')
      await make(device.id, 'c', 3, 'MINOR', 'ACKNOWLEDGED')
      await make(device.id, 'd', 4, 'WARNING', 'CLEARED')
      await make(child.id, 'e', 5, 'MAJOR')
      const states = async () => {
        const result = await api(client, 'GET', `/alarm/alarms?source=${device.id}&withSourceDevices=true&pageSize=100`)
        return Object.fromEntries(result.body.alarms.map((alarm: { text: string, status: string }) => [alarm.text, alarm.status]))
      }
      await eventually(async () => {
        expect(await states()).toEqual({ a: 'ACTIVE', b: 'ACTIVE', c: 'ACKNOWLEDGED', d: 'CLEARED', e: 'ACTIVE' })
      })
      const bulk = async (query: string, body: unknown) => {
        const result = await api(client, 'PUT', `/alarm/alarms?source=${device.id}&${query}`, body)
        expect(result.status, query).toBe(200)
      }

      // the new status is required (null counts as missing), the body must be JSON
      for (const body of [{}, { status: null }]) {
        const missing = await api(client, 'PUT', `/alarm/alarms?source=${device.id}`, body)
        expect(missing.status).toBe(422)
        expect(missing.body).toMatchObject({ error: 'undefined/validationError', message: 'Missing status for bulk alarm update. Desired new status must be set' })
      }
      expect((await api(client, 'PUT', `/alarm/alarms?source=${device.id}`, 'not json', { 'content-type': 'text/plain' })).status).toBe(400)

      // a list of severities matches nothing, a single one ignores case
      await bulk('severity=MAJOR,CRITICAL', { status: 'CLEARED' })
      await settle(1500)
      expect(await states()).toEqual({ a: 'ACTIVE', b: 'ACTIVE', c: 'ACKNOWLEDGED', d: 'CLEARED', e: 'ACTIVE' })
      await bulk('severity=major&status=active', { status: 'ACKNOWLEDGED' })
      await eventually(async () => {
        expect(await states()).toEqual({ a: 'ACTIVE', b: 'ACKNOWLEDGED', c: 'ACKNOWLEDGED', d: 'CLEARED', e: 'ACTIVE' })
      })
      // resolved: any value but false, and it wins over the status filter
      await bulk('resolved=yes', { status: 'ACTIVE' })
      await eventually(async () => {
        expect(await states()).toEqual({ a: 'ACTIVE', b: 'ACKNOWLEDGED', c: 'ACKNOWLEDGED', d: 'ACTIVE', e: 'ACTIVE' })
      })
      await bulk('resolved=false&status=CLEARED', { status: 'ACKNOWLEDGED' })
      await eventually(async () => {
        expect(await states()).toEqual({ a: 'ACKNOWLEDGED', b: 'ACKNOWLEDGED', c: 'ACKNOWLEDGED', d: 'ACKNOWLEDGED', e: 'ACTIVE' })
      })
      // withSourceDevices reaches the child
      await bulk('withSourceDevices=true&severity=MAJOR', { status: 'CLEARED' })
      await eventually(async () => {
        expect(await states()).toEqual({ a: 'ACKNOWLEDGED', b: 'CLEARED', c: 'ACKNOWLEDGED', d: 'ACKNOWLEDGED', e: 'CLEARED' })
      })

      const del = async (query: string) => {
        const result = await api(client, 'DELETE', `/alarm/alarms?source=${device.id}&${query}`)
        expect(result.status, query).toBe(204)
      }
      // a list of severities deletes nothing, withSource* does not reach the child
      await del('severity=MINOR,CRITICAL')
      await del(`withSourceDevices=true&type=e-${unique}`)
      await del('resolved=FALSE&status=CLEARED&type=nothing')
      await settle(2000)
      expect(Object.keys(await states()).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
      await del('severity=minor')
      await eventually(async () => {
        expect(Object.keys(await states()).sort()).toEqual(['a', 'b', 'd', 'e'])
      })
      // resolved=yes deletes the cleared alarms of the source only
      await del('resolved=yes&withSourceChildren=true')
      await eventually(async () => {
        expect(Object.keys(await states()).sort()).toEqual(['a', 'd', 'e'])
      })
    },
  },
]

export const alarmsConformanceScenarios: ContractScenario[] = [
  {
    name: 'alarms and events: withSource* parameters, unknown sources, resolved left out',
    verifies: ['with-source-children', 'source-unknown', 'alarms-resolved-omitted'],
    async run({ client, unique }) {
      const create = async (name: string, extra: Record<string, unknown> = {}) => (await client.inventory.create({ name: `${name}-${unique}`, ...extra })).data
      const parent = await create('parent', { c8y_IsDevice: {} })
      const device = await create('device', { c8y_IsDevice: {} })
      const grandchild = await create('grandchild', { c8y_IsDevice: {} })
      const asset = await create('asset')
      const addition = await create('addition')
      await client.inventory.childDevicesAdd(device.id, parent.id)
      await client.inventory.childDevicesAdd(grandchild.id, device.id)
      await client.inventory.childAssetsAdd(asset.id, parent.id)
      await client.inventory.childAdditionsAdd(addition.id, parent.id)
      const objects = { parent, device, grandchild, asset, addition }
      for (const [name, mo] of Object.entries(objects)) {
        await client.alarm.create({ source: { id: mo.id }, type: `ws-${unique}`, text: name, severity: 'MINOR', time: time(1) })
        await client.event.create({ source: { id: mo.id }, type: `ws-${unique}`, text: name, time: time(1) })
      }
      const sources = async (path: string, params: Record<string, string>) => {
        const { status, body } = await api(client, 'GET', `${path}?${new URLSearchParams({ source: parent.id, pageSize: '100', ...params })}`)
        expect(status).toBe(200)
        return (body.alarms ?? body.events).map((item: { text: string }) => item.text).sort()
      }
      for (const path of ['/alarm/alarms', '/event/events']) {
        expect(await sources(path, {}), path).toEqual(['parent'])
        // the parent links are indexed asynchronously on the platform
        await eventually(async () => {
          expect(await sources(path, { withSourceDevices: 'true' }), path).toEqual(['device', 'grandchild', 'parent'])
          expect(await sources(path, { withSourceAssets: 'true' }), path).toEqual(['asset', 'parent'])
          expect(await sources(path, { withSourceAdditions: 'true' }), path).toEqual(['addition', 'parent'])
          expect(await sources(path, { withSourceChildren: 'true' }), path).toEqual(['addition', 'asset', 'device', 'grandchild', 'parent'])
        })
        // an unknown source is an empty page, but a 404 with withSource*
        const unknown = await api(client, 'GET', `${path}?source=99999999999`)
        expect(unknown.status).toBe(200)
        expect(unknown.body.alarms ?? unknown.body.events).toEqual([])
        expect((await api(client, 'GET', `${path}?source=99999999999&withSourceAssets=true`)).status, path).toBe(404)
        expect((await api(client, 'GET', `${path}?source=99999999999&withSourceDevices=true`)).status, path).toBe(404)
      }
      // the bulk alarm update is a no-op for an unknown source, with or without withSource*
      expect((await api(client, 'PUT', '/alarm/alarms?source=99999999999', { status: 'CLEARED' })).status).toBe(200)
      expect((await api(client, 'PUT', '/alarm/alarms?source=99999999999&withSourceDevices=true', { status: 'CLEARED' })).status).toBe(200)

      // `resolved` left out returns alarms of every status (the docs say it defaults to false)
      const { data: cleared } = await client.alarm.create({ source: { id: parent.id }, type: `wc-${unique}`, text: 'cleared', severity: 'MINOR', time: time(2) })
      await client.alarm.update({ id: cleared.id, status: 'CLEARED' } as any)
      const texts = async (params: Record<string, string>) => (await api(client, 'GET', `/alarm/alarms?${new URLSearchParams({ source: parent.id, ...params })}`)).body.alarms.map((alarm: { text: string }) => alarm.text).sort()
      expect(await texts({})).toEqual(['cleared', 'parent'])
      expect(await texts({ resolved: 'false' })).toEqual(['parent'])
      expect(await texts({ resolved: 'true' })).toEqual(['cleared'])
    },
  },
  {
    name: 'alarms and events: date parameter formats',
    verifies: ['date-parameters-lenient'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `dp-${unique}`, c8y_IsDevice: {} })
      await client.alarm.create({ source: { id: device.id }, type: `dp-${unique}`, text: 'at 10:05', severity: 'MINOR', time: time(5) })
      await client.event.create({ source: { id: device.id }, type: `dp-${unique}`, text: 'at 10:05', time: time(5) })
      for (const path of ['/alarm/alarms', '/event/events']) {
        const count = async (params: Record<string, string>) => {
          const { status, body } = await api(client, 'GET', `${path}?${new URLSearchParams({ source: device.id, ...params })}`)
          return status === 200 ? (body.alarms ?? body.events).length : status
        }
        // fields may have one digit, and a bare date is a date
        expect(await count({ dateFrom: '2026-1-1T10:0:0Z', dateTo: '2026-1-1T10:10:0Z' }), path).toBe(1)
        expect(await count({ dateFrom: '2026-01-01', dateTo: '2026-01-02' }), path).toBe(1)
        expect(await count({ dateFrom: '2026-01-01T10:06:00Z', dateTo: '2026-01-02' }), path).toBe(0)
        expect(await count({ dateFrom: '2026-01-01T11:05:00+01:00', dateTo: '2026-01-01T11:06:00+01:00' }), path).toBe(1)
        // a time needs seconds; words are no dates
        expect(await count({ dateFrom: '2026-01-01T10:00Z' }), path).toBe(422)
        expect(await count({ dateTo: '2026-01-01T10:00' }), path).toBe(422)
        expect(await count({ dateFrom: 'yesterday' }), path).toBe(422)
        expect(await count({ createdFrom: '2026-01-01T10:00Z' }), path).toBe(422)
      }
    },
  },
  {
    name: 'alarms: severity as the only filter applies to the list, the count, and the bulk update; the bulk update needs a known filter',
    verifies: ['bulk-alarm-known-filters'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `sv-${unique}`, c8y_IsDevice: {} })
      const now = new Date().toISOString()
      // a random millisecond in 2001 no other alarm of the tenant has: dateFrom
      // and dateTo (honored by the list, the count, and the bulk update) run
      // after the severity filter and keep every request to this scenario's alarms
      const millisecond = Date.parse('2001-01-01T00:00:00.000Z') + Math.floor(Math.random() * 364 * 24 * 3600 * 1000)
      const time = new Date(millisecond).toISOString()
      const major = await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `sv-major-${unique}`, text: 'major', severity: 'MAJOR', time })
      const minor = await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `sv-minor-${unique}`, text: 'minor', severity: 'MINOR', time })
      expect([major.status, minor.status]).toEqual([201, 201])
      const window = `dateFrom=${encodeURIComponent(new Date(millisecond - 1).toISOString())}&dateTo=${encodeURIComponent(new Date(millisecond + 1).toISOString())}`
      // the creation range alone is no known filter for the bulk update
      const createdTo = new Date(Date.parse(String(minor.body.creationTime)) + 1).toISOString()
      const range = `createdFrom=${encodeURIComponent(String(device.creationTime))}&createdTo=${encodeURIComponent(createdTo)}`

      const ids = async (query: string) => (await api(client, 'GET', `/alarm/alarms?pageSize=100&${window}&${query}`)).body.alarms.map((alarm: { id: string }) => alarm.id)
      expect(await ids('severity=MAJOR')).toEqual([major.body.id])
      expect(await ids('severity=MINOR')).toEqual([minor.body.id])
      expect((await api(client, 'GET', `/alarm/alarms/count?${window}&severity=MAJOR`)).body).toBe(1)
      // the count ignores what its spec does not list (the list honors createdFrom)
      const future = encodeURIComponent('2100-01-01T00:00:00.000Z')
      expect(await ids(`severity=MAJOR&createdFrom=${future}`)).toEqual([])
      for (const extra of [`createdFrom=${future}`, `createdTo=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`, 'fragmentType=c8y_Nothing', `lastUpdatedFrom=${future}`]) {
        expect((await api(client, 'GET', `/alarm/alarms/count?${window}&severity=MAJOR&${extra}`)).body, extra).toBe(1)
      }

      // without source, status, severity, dateFrom, or dateTo the update is
      // rejected: the creation range, type, fragmentType, lastUpdatedFrom,
      // and unknown parameters do not count
      for (const query of [range, `${range}&type=sv-minor-${unique}`, `${range}&fragmentType=c8y_X`, `${range}&lastUpdatedFrom=${encodeURIComponent(now)}`, `${range}&foo=1`]) {
        expect(await api(client, 'PUT', `/alarm/alarms?${query}`, { status: 'ACKNOWLEDGED' }), query).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'Bulk alarm update works only with filter. None known filter is set' } })
      }

      expect((await api(client, 'PUT', `/alarm/alarms?${window}&severity=MINOR`, { status: 'ACKNOWLEDGED' })).status).toBe(200)
      await eventually(async () => {
        expect((await api(client, 'GET', `/alarm/alarms/${minor.body.id}`)).body.status).toBe('ACKNOWLEDGED')
      })
      expect((await api(client, 'GET', `/alarm/alarms/${major.body.id}`)).body.status).toBe('ACTIVE')

      // type is ignored, also next to a source: every alarm of the source changes
      expect((await api(client, 'PUT', `/alarm/alarms?source=${device.id}&type=sv-other-${unique}`, { status: 'ACKNOWLEDGED' })).status).toBe(200)
      await eventually(async () => {
        expect((await api(client, 'GET', `/alarm/alarms/${major.body.id}`)).body.status).toBe('ACKNOWLEDGED')
      })
    },
  },
  {
    name: 'alarms: the bulk update with withSource* needs a source',
    verifies: ['bulk-alarm-known-filters'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `bs-${unique}`, c8y_IsDevice: {} })
      // the creation range alone is no known filter, so a platform that
      // skipped the source check would still change nothing (422 as well);
      // with status=ACKNOWLEDGED it would set ACKNOWLEDGED alarms created in
      // the millisecond of this scenario's device to ACKNOWLEDGED
      const created = Date.parse(String(device.creationTime))
      const range = `createdFrom=${encodeURIComponent(new Date(created).toISOString())}&createdTo=${encodeURIComponent(new Date(created + 1).toISOString())}`
      for (const name of ['withSourceDevices', 'withSourceAssets', 'withSourceAdditions', 'withSourceChildren']) {
        for (const query of [`${range}&${name}=true`, `${range}&status=ACKNOWLEDGED&${name}=true`]) {
          expect(await api(client, 'PUT', `/alarm/alarms?${query}`, { status: 'ACKNOWLEDGED' }), query).toMatchObject({ status: 422, body: { error: 'alarm/Invalid Data', message: 'Cannot fetch children alarms if parameter \'source\' is not specified!' } })
        }
      }
    },
  },
  {
    name: 'alarms: alarm.type.mapping overrides severity and text, NONE suppresses the alarm',
    verifies: ['alarm-type-mapping'],
    async run({ client, unique, settle }) {
      const { data: device } = await client.inventory.create({ name: `tm-${unique}`, c8y_IsDevice: {} })
      const types = { both: `tm-both-${unique}`, text: `tm-text-${unique}`, severity: `tm-sev-${unique}`, pipes: `tm-pipes-${unique}`, spaced: `tm-spaced-${unique}`, none: `tm-none-${unique}`, lower: `tm-lower-${unique}`, noneSpace: `tm-nonesp-${unique}`, rejected: `tm-rejected-${unique}`, bulkGood: `tm-bulkgood-${unique}` }
      const mappings: Array<[string, string]> = [[types.both, 'CRITICAL|mapped text'], [types.text, '|only text'], [types.severity, 'WARNING|'], [types.pipes, 'MAJOR|a|b'], [types.spaced, ' WARNING | spaced '], [types.none, 'NONE|'], [types.lower, 'none|other text'], [types.noneSpace, 'NONE |x']]
      try {
        // a value without a pipe, or with both parts empty, is rejected
        const wrong = (value: string) => ({ status: 422, body: { error: 'options/Invalid Data', message: `Wrong format: '${value}'!` } })
        const empty = { status: 422, body: { error: 'options/Invalid Data', message: 'Priority or text must not be empty in alarm mapping!' } }
        for (const value of ['MAJOR', '']) {
          expect(await api(client, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: types.rejected, value }), value).toMatchObject(wrong(value))
          expect(await api(client, 'PUT', `/tenant/options/alarm.type.mapping/${types.rejected}`, { value }), value).toMatchObject(wrong(value))
        }
        expect(await api(client, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: types.rejected, value: '|' })).toMatchObject(empty)
        expect(await api(client, 'PUT', `/tenant/options/alarm.type.mapping/${types.rejected}`, { value: '|' })).toMatchObject(empty)
        expect(await api(client, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: types.rejected, value: ' | ' })).toMatchObject(empty)
        // the category update rejects a wrong value; whether it stored others first
        // varies between runs (the values are taken in no fixed order)
        expect(await api(client, 'PUT', '/tenant/options/alarm.type.mapping', { [types.bulkGood]: 'MAJOR|x', [types.rejected]: 'MAJOR' })).toMatchObject(wrong('MAJOR'))
        expect((await api(client, 'GET', `/tenant/options/alarm.type.mapping/${types.rejected}`)).status).toBe(404)
        for (const [key, value] of mappings) {
          expect((await api(client, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key, value })).status, value).toBe(200)
        }
        const create = (type: string) => api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type, text: 'sent text', severity: 'MINOR', time: new Date().toISOString(), c8y_Custom: { a: 1 } })
        expect((await create(types.both)).body).toMatchObject({ severity: 'CRITICAL', text: 'mapped text' })
        expect((await create(types.text)).body).toMatchObject({ severity: 'MINOR', text: 'only text' })
        expect((await create(types.severity)).body).toMatchObject({ severity: 'WARNING', text: 'sent text' })
        // split at the last pipe; the whole value is trimmed, the parts are not
        expect((await create(types.pipes)).body).toMatchObject({ severity: 'MAJOR|a', text: 'b' })
        expect((await create(types.spaced)).body).toMatchObject({ severity: 'WARNING ', text: ' spaced' })
        // NONE with a trailing space is no NONE: stored with that severity
        expect((await create(types.noneSpace)).body).toMatchObject({ severity: 'NONE ', text: 'x' })
        // NONE in any case: answered like a new alarm, with an id, mapped like
        // any other (the option's severity, its text if not empty), not stored
        const suppressed: string[] = []
        for (const [type, severity, text] of [[types.none, 'NONE', 'sent text'], [types.lower, 'none', 'other text']] as const) {
          const answer = await create(type)
          expect(answer, type).toMatchObject({ status: 201, body: { type, text, severity, status: 'ACTIVE', count: 1, source: { id: device.id }, c8y_Custom: { a: 1 } } })
          expect(answer.body.self).toMatch(new RegExp(`/alarm/alarms/${answer.body.id}$`))
          expect(answer.location).toBe(answer.body.self)
          expect([typeof answer.body.creationTime, typeof answer.body.lastUpdated]).toEqual(['string', 'string'])
          suppressed.push(answer.body.id)
        }
        const upsert = await api(client, 'POST', '/alarm/alarms/upsert', { source: { id: device.id }, type: types.none, text: 'x', severity: 'MINOR' })
        expect(upsert).toMatchObject({ status: 200, body: { alarm: { self: expect.stringMatching(/\/alarm\/alarms\/null$/), count: 1 }, previousState: null }, location: expect.stringMatching(/\/alarm\/alarms\/null$/) })
        expect(Object.keys(upsert.body.alarm).sort()).toEqual(['count', 'self'])
        await settle(1000)
        for (const id of suppressed) {
          expect((await api(client, 'GET', `/alarm/alarms/${id}`)).status).toBe(404)
        }
        const listed = (await api(client, 'GET', `/alarm/alarms?source=${device.id}&pageSize=100`)).body.alarms.map((alarm: { type: string }) => alarm.type).sort()
        expect(listed).toEqual([types.both, types.severity, types.text, types.pipes, types.spaced, types.noneSpace].sort())
      } finally {
        for (const [key] of [...mappings, [types.rejected], [types.bulkGood]]) {
          await api(client, 'DELETE', `/tenant/options/alarm.type.mapping/${key}`)
        }
      }
    },
  },
  {
    name: 'alarms: a source in maintenance suppresses new alarms',
    verifies: ['alarm-maintenance-suppressed'],
    async run({ client, unique, settle }) {
      const { data: device } = await client.inventory.create({ name: `mt-${unique}`, c8y_IsDevice: {}, c8y_RequiredAvailability: { responseInterval: -1 } } as any)
      const type = `mt-${unique}`
      try {
        // checked before the type mapping: the answer shows what was sent
        expect((await api(client, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: type, value: 'CRITICAL|mapped' })).status).toBe(200)
        const time = new Date().toISOString()
        const created = await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type, text: 'x', severity: 'MINOR', time, c8y_Custom: { a: 1 } })
        expect(created).toMatchObject({ status: 201, location: expect.stringMatching(/\/alarm\/alarms\/null$/) })
        expect(created.body).toEqual({ self: expect.stringMatching(/\/alarm\/alarms\/null$/), type, text: 'x', severity: 'MINOR', count: 1, source: { self: expect.stringMatching(new RegExp(`/inventory/managedObjects/${device.id}$`)), id: device.id }, time, c8y_Custom: { a: 1 } })
        // validation comes first
        expect(await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type, text: 'x', time })).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'post.alarmRepresentation.severity: is required' } })
        const upsert = await api(client, 'POST', '/alarm/alarms/upsert', { source: { id: device.id }, type, text: 'x', severity: 'MINOR' })
        expect(upsert).toMatchObject({ status: 200, body: { alarm: { self: expect.stringMatching(/\/alarm\/alarms\/null$/), count: 1 }, previousState: null }, location: expect.stringMatching(/\/alarm\/alarms\/null$/) })
        expect(Object.keys(upsert.body.alarm).sort()).toEqual(['count', 'self'])
        await settle(1000)
        expect((await api(client, 'GET', `/alarm/alarms?source=${device.id}`)).body.alarms).toEqual([])
      } finally {
        await api(client, 'DELETE', `/tenant/options/alarm.type.mapping/${type}`)
      }
    },
  },
]
