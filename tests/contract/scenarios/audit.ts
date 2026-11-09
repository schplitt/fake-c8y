import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { eventually, time } from '../helpers'

async function api(client: Client, method: string, path: string, body?: unknown) {
  const res = await client.core.fetch(path, { method, headers: { 'content-type': 'application/json', 'accept': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

async function records(client: Client, query: Record<string, string>) {
  const result = await api(client, 'GET', `/audit/auditRecords?${new URLSearchParams({ pageSize: '50', ...query })}`)
  expect(result.status).toBe(200)
  return result.body.auditRecords as any[]
}

export const auditScenarios: ContractScenario[] = [
  {
    name: 'audit: alarm writes are audited with their changes',
    verifies: ['audit-written-by-writes', 'audit-order'],
    async run({ client, unique }) {
      const user = (await api(client, 'GET', '/user/currentUser')).body.userName
      const { data: device } = await client.inventory.create({ name: `aud-${unique}`, c8y_IsDevice: {} })
      const alarm = (await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `aud${unique}`, text: 'Too hot', severity: 'MAJOR', time: time(1) })).body
      // a duplicate absorbed by the active alarm writes nothing
      await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `aud${unique}`, text: 'Too hot', severity: 'MAJOR', time: time(1) })
      await api(client, 'PUT', `/alarm/alarms/${alarm.id}`, { status: 'ACKNOWLEDGED' })
      // an update that changes nothing writes nothing
      await api(client, 'PUT', `/alarm/alarms/${alarm.id}`, { status: 'ACKNOWLEDGED' })
      await api(client, 'PUT', `/alarm/alarms/${alarm.id}`, { text: 'Still hot', c8y_Level: 5 })

      await eventually(async () => {
        const found = await records(client, { source: alarm.id })
        expect(found.map((record) => record.activity)).toEqual(['Alarm created', 'Alarm updated', 'Alarm updated'])
        const [created, acknowledged, edited] = found
        expect(created).toMatchObject({
          self: expect.stringContaining(`/audit/auditRecords/${created.id}`),
          type: 'Alarm',
          text: `Device name: 'aud-${unique}', alarm text: 'Too hot'`,
          user,
          severity: 'MAJOR',
          source: { id: alarm.id, self: expect.stringContaining(`/inventory/managedObjects/${alarm.id}`) },
          time: alarm.time,
          creationTime: expect.any(String),
          com_cumulocity_model_event_AuditSourceDevice: { _id: device.id },
        })
        expect(created).not.toHaveProperty('changes')
        expect(acknowledged.changes).toEqual([{ attribute: 'status', type: 'com.cumulocity.model.event.CumulocityAlarmStatuses', previousValue: 'ACTIVE', newValue: 'ACKNOWLEDGED' }])
        // the text is the one before the update; scalar values are strings
        expect(edited.text).toBe(`Device name: 'aud-${unique}', alarm text: 'Too hot'`)
        expect(edited.changes).toEqual(expect.arrayContaining([
          { attribute: 'text', type: 'java.lang.String', previousValue: 'Too hot', newValue: 'Still hot' },
          { attribute: 'c8y_Level', type: 'java.lang.Long', previousValue: null, newValue: '5' },
        ]))
        expect(edited.changes).toHaveLength(2)

        // oldest first; newest first with a date range
        const ranged = await records(client, { source: alarm.id, dateFrom: '2020-01-01' })
        expect(ranged.map((record) => record.id)).toEqual(found.map((record) => record.id).reverse())
        expect((await records(client, { source: alarm.id, dateTo: '2100-01-01' })).map((record) => record.id)).toEqual(found.map((record) => record.id).reverse())

        // filters match exactly and case-sensitively
        expect(await records(client, { source: alarm.id, type: 'alarm' })).toEqual([])
        expect(await records(client, { source: alarm.id, type: 'Alarm,Operation' })).toEqual([])
        expect(await records(client, { source: alarm.id, user: user.toUpperCase() === user ? `${user}x` : user.toUpperCase() })).toEqual([])
        expect(await records(client, { source: alarm.id, user })).toHaveLength(3)

        const single = await api(client, 'GET', `/audit/auditRecords/${created.id}`)
        expect(single.body).toEqual(created)
      })
    },
  },
  {
    name: 'audit: a severity change adds two SYSTEM records, other severity and status values show their ordinal',
    verifies: ['audit-alarm-severity-change'],
    async run({ client, unique }) {
      const user = (await api(client, 'GET', '/user/currentUser')).body.userName
      const { data: device } = await client.inventory.create({ name: `aus-${unique}`, c8y_IsDevice: {} })
      const alarm = (await api(client, 'POST', '/alarm/alarms', { source: { id: device.id }, type: `aus${unique}`, text: 'x', severity: 'MINOR', time: time(1) })).body
      // the status change is left out of the update record when the severity changes
      await api(client, 'PUT', `/alarm/alarms/${alarm.id}`, { severity: 'MAJOR', status: 'ACKNOWLEDGED', text: 'y' })
      await api(client, 'PUT', `/alarm/alarms/${alarm.id}`, { severity: 'critical' })
      await api(client, 'PUT', `/alarm/alarms/${alarm.id}`, { status: 'bogus' })
      const text = (value: string) => `Device name: 'aus-${unique}', alarm text: '${value}'`
      const severity = (previousValue: unknown, newValue: unknown, type = 'CumulocitySeverities') => ({ attribute: 'severity', type: `com.cumulocity.model.event.${type}`, previousValue, newValue })
      const status = (previousValue: unknown, newValue: unknown, type = 'CumulocityAlarmStatuses') => ({ attribute: 'status', type: `com.cumulocity.model.event.${type}`, previousValue, newValue })
      const monitoring = { type: 'SYSTEM', activity: 'Availability monitoring record', user, source: { id: alarm.id }, time: alarm.time }
      await eventually(async () => {
        const found = await records(client, { source: alarm.id })
        expect(found.map((record) => record.activity)).toEqual(['Alarm created', 'Alarm updated', monitoring.activity, monitoring.activity, 'Alarm updated', monitoring.activity, monitoring.activity, 'Alarm updated'])
        expect(found[1]).toMatchObject({ type: 'Alarm', text: text('x'), severity: 'MINOR', changes: [{ attribute: 'text', type: 'java.lang.String', previousValue: 'x', newValue: 'y' }, severity('MINOR', 'MAJOR')] })
        expect(found[2]).toMatchObject({ ...monitoring, text: text('x'), severity: 'MINOR', changes: [status('ACTIVE', 'CLEARED')] })
        expect(found[3]).toMatchObject({ ...monitoring, text: text('y'), severity: 'MAJOR' })
        expect(found[3]).not.toHaveProperty('changes')
        expect(found[4].changes).toEqual([severity('MAJOR', { ordinal: 1 })])
        expect(found[5]).toMatchObject({ ...monitoring, severity: 'MAJOR', changes: [status('ACKNOWLEDGED', 'CLEARED')] })
        expect(found[6]).toMatchObject({ ...monitoring, severity: 'critical' })
        expect(found[7]).toMatchObject({ severity: 'critical', changes: [status('ACKNOWLEDGED', { ordinal: null })] })
      })
      // the alarm keeps the status it was given
      expect((await api(client, 'GET', `/alarm/alarms/${alarm.id}`)).body).toMatchObject({ status: 'bogus', severity: 'critical', text: 'y' })
    },
  },
  {
    name: 'audit: operations, deletes, and what is not audited',
    verifies: ['audit-written-by-writes', 'audit-unknown-404', 'audit-optional-fields'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `aud-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const operation = (await api(client, 'POST', '/devicecontrol/operations', { deviceId: device.id, description: 'Restart', c8y_Restart: {} })).body
      await api(client, 'PUT', `/devicecontrol/operations/${operation.id}`, { status: 'FAILED', failureReason: 'no power' })

      // not audited: managed object create/update, events, option create/update
      await api(client, 'PUT', `/inventory/managedObjects/${device.id}`, { c8y_Note: 'x' })
      const event = (await api(client, 'POST', '/event/events', { source: { id: device.id }, type: `aud${unique}`, text: 'e', time: time(1) })).body
      await api(client, 'DELETE', `/event/events/${event.id}`)
      const category = `ctr${unique}`
      await api(client, 'PUT', `/tenant/options/${category}/alpha`, { value: 'one' })
      await api(client, 'PUT', `/tenant/options/${category}/alpha`, { value: 'two' })
      await api(client, 'DELETE', `/tenant/options/${category}/alpha`)
      const { data: other } = await client.inventory.create({ name: `aud2-${unique}` })
      await client.inventory.delete(other.id)

      await eventually(async () => {
        const operations = await records(client, { source: operation.id })
        expect(operations.map((record) => [record.type, record.activity, record.text])).toEqual([
          ['Operation', 'Operation created', `Operation created: status='PENDING', description='Restart', device name='aud-${unique}'.`],
          ['Operation', 'Operation updated', `Operation updated: status='FAILED', failure reason='no power', description='Restart', device name='aud-${unique}'.`],
        ])
        expect(operations[0].com_cumulocity_model_event_AuditSourceDevice).toEqual({ _id: device.id })
        expect(operations[0]).not.toHaveProperty('severity')

        expect(await records(client, { source: device.id })).toEqual([])
        expect(await records(client, { source: event.id })).toEqual([])
        const option = await records(client, { source: `${category}.alpha` })
        expect(option.map((record) => [record.type, record.activity, record.text])).toEqual([['Option', 'Option deleted', `Option "${category}.alpha" deleted`]])
        const deleted = await records(client, { source: other.id })
        expect(deleted.map((record) => [record.type, record.activity, record.text])).toEqual([['Inventory', 'Managed object deleted', `Managed object "aud2-${unique}" deleted`]])
      })

      const unknown = await api(client, 'GET', '/audit/auditRecords/abc')
      expect(unknown.status).toBe(404)
      expect(unknown.body.error).toBe('audit/Not Found')
      expect(unknown.body.message).toBe('Can\'t find audit record with given id ID [type=com_cumulocity_model_idtype_GId, value=abc]')
      const invalid = await api(client, 'GET', '/audit/auditRecords?dateFrom=yesterday')
      expect(invalid.status).toBe(422)
      expect(invalid.body.error).toBe('yesterday is not a valid date./Invalid Data')
    },
  },
]
