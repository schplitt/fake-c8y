import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'

async function api(client: Client, method: string, path: string, body?: unknown) {
  const res = await client.core.fetch(path, { method, headers: { 'content-type': 'application/json', 'accept': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

// A source id no object has: the rules of these scenarios match no data on a real tenant.
const NO_SOURCE = '999999999999'

/**
 * Deletes the scenario's rules (their type starts with the run id).
 * @param client
 * @param unique
 */
async function removeRules(client: Client, unique: string) {
  const { body } = await api(client, 'GET', '/retention/retentions?pageSize=2000')
  for (const rule of body?.retentionRules ?? []) {
    if (String(rule.type).startsWith(unique) || String(rule.fragmentType).startsWith(unique)) {
      await api(client, 'DELETE', `/retention/retentions/${rule.id}`)
    }
  }
}

export const retentionScenarios: ContractScenario[] = [
  {
    name: 'retention rules: create, read, update, delete',
    verifies: ['retention-list-order'],
    async run({ client, unique }) {
      try {
        const created = await api(client, 'POST', '/retention/retentions', { dataType: 'EVENT', type: `${unique}a`, source: NO_SOURCE, maximumAge: 30, editable: false, extra: 'x' })
        expect(created.status).toBe(201)
        // filters default to *, editable is always true, unknown fields are dropped
        expect(created.body).toEqual({
          self: expect.stringContaining(`/retention/retentions/${created.body.id}`),
          id: expect.any(String),
          dataType: 'EVENT',
          fragmentType: '*',
          type: `${unique}a`,
          source: NO_SOURCE,
          maximumAge: 30,
          editable: true,
        })
        const id = created.body.id
        expect((await api(client, 'GET', `/retention/retentions/${id}`)).body).toEqual(created.body)

        // an update merges; id, editable, and null values are ignored
        const updated = await api(client, 'PUT', `/retention/retentions/${id}`, { maximumAge: 31, fragmentType: `${unique}f`, id: '1', editable: false, type: null })
        expect(updated.status).toBe(200)
        expect(updated.body).toMatchObject({ id, maximumAge: 31, fragmentType: `${unique}f`, type: `${unique}a`, editable: true })

        // the list is ordered by id as a string
        const second = await api(client, 'POST', '/retention/retentions', { dataType: 'MEASUREMENT', type: `${unique}b`, source: NO_SOURCE, maximumAge: '7' })
        expect(second.body.maximumAge).toBe(7)
        const list = await api(client, 'GET', '/retention/retentions?pageSize=2000')
        expect(list.status).toBe(200)
        const ids: string[] = list.body.retentionRules.map((rule: any) => rule.id)
        expect(ids).toEqual(expect.arrayContaining([id, second.body.id]))
        expect(ids).toEqual([...ids].sort())
        expect(list.body.statistics).not.toHaveProperty('totalPages')

        expect((await api(client, 'DELETE', `/retention/retentions/${id}`)).status).toBe(204)
        const gone = await api(client, 'GET', `/retention/retentions/${id}`)
        expect(gone.status).toBe(404)
        expect(gone.body.error).toBe('retention/Not Found')
        expect(gone.body.message).toBe(`Finding retentionRule from database failed : No retentionRule for gid '${id}'!`)
        expect((await api(client, 'DELETE', `/retention/retentions/${id}`)).status).toBe(404)
        expect((await api(client, 'PUT', `/retention/retentions/${id}`, { maximumAge: 1 })).status).toBe(404)
      } finally {
        await removeRules(client, unique)
      }
    },
  },
  {
    name: 'retention rules: validation',
    verifies: ['retention-validation'],
    async run({ client, unique }) {
      const post = (body: Record<string, unknown>) => api(client, 'POST', '/retention/retentions', { source: NO_SOURCE, ...body })
      try {
        for (const body of [{ dataType: 'EVENT', type: `${unique}x` }, { dataType: 'FOO', type: `${unique}x` }, { dataType: 'EVENT', type: `${unique}x`, maximumAge: null }]) {
          const result = await post(body)
          expect(result.status, JSON.stringify(body)).toBe(422)
          expect(result.body.message).toBe('maximumAge is required')
        }
        const badType = await post({ dataType: 'event', type: `${unique}x`, maximumAge: 3 })
        expect(badType.status).toBe(422)
        expect(badType.body.error).toBe('undefined/validationError')
        expect(badType.body.message).toBe('Invalid data, correct values:[ALARM, AUDIT, EVENT, MEASUREMENT, OPERATION, *] : No enum constant com.cumulocity.model.retention.RetentionDataType.event')
        const withId = await post({ dataType: 'EVENT', type: `${unique}x`, maximumAge: 3, id: '5' })
        expect(withId.status).toBe(422)
        expect(withId.body.message).toBe('id is not allowed here')
        expect((await post({ dataType: 'EVENT', type: `${unique}x`, maximumAge: 'ten' })).status).toBe(400)

        // type is not used by operations, fragmentType not by alarms and audit records; * means every data type
        for (const [body, message] of [
          [{ dataType: 'OPERATION', type: `${unique}x`, maximumAge: 3 }, 'Properties [TYPE] can\'t be used in OPERATION api.'],
          [{ dataType: 'ALARM', type: `${unique}x`, fragmentType: `${unique}f`, maximumAge: 3 }, 'Properties [FRAGMENT_TYPE] can\'t be used in ALARM api.'],
          [{ dataType: 'AUDIT', type: `${unique}x`, fragmentType: `${unique}f`, maximumAge: 3 }, 'Properties [FRAGMENT_TYPE] can\'t be used in AUDIT api.'],
          [{ type: `${unique}x`, maximumAge: 3 }, 'Properties [TYPE] can\'t be used in OPERATION api.'],
        ] as const) {
          const result = await post(body)
          expect(result.status, JSON.stringify(body)).toBe(422)
          expect(result.body.error).toBe('retention/Invalid Data')
          expect(result.body.message).toBe(`Failed to add retention rule : ${message}`)
        }

        // the age is truncated to whole days and may be zero or negative
        const rule = await post({ dataType: 'ALARM', type: `${unique}y`, maximumAge: 1.5 })
        expect(rule.status).toBe(201)
        expect(rule.body.maximumAge).toBe(1)
        expect((await post({ dataType: 'ALARM', type: `${unique}z`, maximumAge: -1 })).body.maximumAge).toBe(-1)
        const operation = await post({ dataType: 'OPERATION', fragmentType: `${unique}f`, maximumAge: 3 })
        expect(operation.status).toBe(201)
        expect(operation.body.type).toBe('*')

        // an update is validated against the merged rule
        const incompatible = await api(client, 'PUT', `/retention/retentions/${operation.body.id}`, { dataType: 'ALARM' })
        expect(incompatible.status).toBe(422)
        expect(incompatible.body.message).toBe('Failed to add retention rule : Properties [FRAGMENT_TYPE] can\'t be used in ALARM api.')

        const notANumber = await api(client, 'GET', '/retention/retentions/abc')
        expect(notANumber.status).toBe(422)
        expect(notANumber.body.message).toBe('retentionRuleId=\'abc\' isn\'t correct number mut be used')
      } finally {
        await removeRules(client, unique)
      }
    },
  },
]
