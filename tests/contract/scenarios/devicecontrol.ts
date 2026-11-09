import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { eventually, time } from '../helpers'

async function api(client: Client, method: string, path: string, body?: unknown) {
  const res = await client.core.fetch(path, { method, headers: { 'content-type': 'application/json', 'accept': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

/**
 * A group with the given child assets.
 * @param client
 * @param name
 * @param assets - Managed object ids
 */
async function group(client: Client, name: string, assets: string[]): Promise<string> {
  const { data } = await client.inventory.create({ name, type: 'c8y_DeviceGroup', c8y_IsDeviceGroup: {} } as any)
  for (const id of assets) {
    await client.inventory.childAssetsAdd(id, data.id)
  }
  return data.id
}

async function agent(client: Client, name: string): Promise<string> {
  return (await client.inventory.create({ name, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)).data.id
}

const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()

// Bulk operations cannot be removed once they ran: the completed ones of these
// scenarios stay on a real tenant (their operations and group are deleted).
export const deviceControlScenarios: ContractScenario[] = [
  {
    name: 'bulk operations: body values are parsed like JSON fields, the prototype loses operation fields',
    verifies: ['bulk-operation-body-parsing'],
    async run({ client, unique }) {
      const a = await agent(client, `r1108data-bp-a-${unique}`)
      const groupId = await group(client, `r1108data-bp-g-${unique}`, [a])
      const other = await group(client, `r1108data-bp-g2-${unique}`, [a])
      const created: number[] = []
      const post = async (body: Record<string, unknown>) => {
        const result = await api(client, 'POST', '/devicecontrol/bulkoperations', body)
        if (result.status === 201) {
          created.push(result.body.id)
        }
        return result
      }
      try {
        const valid = { groupId, startDate: inSeconds(48 * 3600), creationRamp: 5, operationPrototype: { c8y_Restart: {} } }
        const parseError = { status: 400, body: { error: 'Failed to parse JSON string' } }
        // numbers as text, notes as text, an empty ramp or start date is missing
        expect((await post({ ...valid, creationRamp: '7' })).body.creationRamp).toBe(7)
        expect((await post({ ...valid, creationRamp: '0.5' })).body.creationRamp).toBe(1)
        expect((await post({ ...valid, creationRamp: 2.7 })).body.creationRamp).toBe(2.7)
        expect((await post({ ...valid, groupId: Number(groupId) })).body.groupId).toBe(groupId)
        expect((await post({ ...valid, note: 5 })).body.note).toBe('5')
        expect((await post({ ...valid, note: true })).body.note).toBe('true')
        expect(await post({ ...valid, creationRamp: '' })).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'creationRamp is required' } })
        expect(await post({ ...valid, startDate: '' })).toMatchObject({ status: 422, body: { message: 'startDate is required' } })
        for (const [field, value] of [['creationRamp', 'abc'], ['creationRamp', true], ['operationPrototype', 'x'], ['operationPrototype', []], ['note', { a: 1 }], ['groupId', { id: groupId }], ['failedParentId', 'abc'], ['startDate', 4070908800000]] as const) {
          expect(await post({ ...valid, [field]: value }), `${field}: ${JSON.stringify(value)}`).toMatchObject(parseError)
        }
        // the prototype keeps custom fragments, description, and time
        const prototype = { c8y_Restart: { a: 1 }, id: '5', deviceId: a, deviceName: 'x', status: 'SUCCESSFUL', failureReason: 'f', creationTime: '2020-01-01T00:00:00Z', bulkOperationId: 7, self: 'x', description: 'd', time: 't' }
        const stripped = await post({ ...valid, operationPrototype: prototype })
        expect(stripped.body.operationPrototype).toEqual({ c8y_Restart: { a: 1 }, description: 'd', time: 't' })

        // updates parse the same way
        const base = (await post({ ...valid, note: 'base' })).body
        const put = (id: number, body: Record<string, unknown>) => api(client, 'PUT', `/devicecontrol/bulkoperations/${id}`, body)
        expect(await put(base.id, { creationRamp: 'abc' })).toMatchObject(parseError)
        expect(await put(base.id, { operationPrototype: 'x' })).toMatchObject(parseError)
        const replaced = await put(base.id, { operationPrototype: { c8y_Other: {}, deviceId: a, status: 'FAILED' }, note: 7 })
        expect(replaced.status).toBe(200)
        created.push(replaced.body.id)
        expect(replaced.body).toMatchObject({ operationPrototype: { c8y_Other: {} }, note: '7' })
        expect(replaced.body.operationPrototype.deviceId).toBeUndefined()
        // an empty note is a change that keeps the note; a group alone is none
        const kept = await put(replaced.body.id, { note: '' })
        expect(kept.status).toBe(200)
        created.push(kept.body.id)
        expect(kept.body.note).toBe('7')
        expect((await put(kept.body.id, { groupId: other })).status).toBe(422)
        const moved = await put(kept.body.id, { groupId: other, note: 'moved' })
        expect(moved.body).toMatchObject({ groupId: other, note: 'moved' })
        created.push(moved.body.id)
        const zoneless = await put(moved.body.id, { startDate: '2099-01-01T00:00:00' })
        expect(zoneless.body.startDate).toBe('2099-01-01T00:00:00.000Z')
        created.push(zoneless.body.id)

        // a repeated parameter takes its first value
        const listed = await api(client, 'GET', `/devicecontrol/bulkoperations?groupId=${groupId}&groupId=${other}&pageSize=1&pageSize=3&withTotalPages=1`)
        expect(listed.body.statistics).toMatchObject({ pageSize: 1, currentPage: 1 })
        expect(listed.body.bulkOperations).toHaveLength(1)
        expect(listed.body.bulkOperations[0].groupId).toBe(groupId)
      } finally {
        for (const id of created) {
          await api(client, 'DELETE', `/devicecontrol/bulkoperations/${id}`)
        }
      }
    },
  },
  {
    name: 'new device requests: custom properties, id rules, no id in an update, media types',
    verifies: ['new-device-request-fields', 'media-type-415'],
    async run({ client, unique }) {
      const ids = [`r1108data-ndf-${unique}-1`, `r1108data-ndf-${unique}-2`, `r1108data-ndf-${unique}-a.b_c`]
      try {
        const post = (body: Record<string, unknown>) => api(client, 'POST', '/devicecontrol/newDeviceRequests', body)
        const created = await post({ id: ids[0], customProperties: { a: 1, b: { c: 'd' } }, c8y_Other: {} })
        expect(created.status).toBe(201)
        expect(created.body).toMatchObject({ id: ids[0], customProperties: { a: 1, b: { c: 'd' } } })
        expect(created.body.c8y_Other).toBeUndefined()
        expect((await api(client, 'GET', `/devicecontrol/newDeviceRequests/${ids[0]}`)).body.customProperties).toEqual({ a: 1, b: { c: 'd' } })
        expect((await post({ id: ids[1], type: 5 })).body).toMatchObject({ type: '5', customProperties: {} })
        expect((await post({ id: ids[2] })).status).toBe(201)
        for (const id of ['', `${ids[0]}\\x`, `${ids[0]}\tx`, `${ids[0]}+x`]) {
          expect(await post({ id }), JSON.stringify(id)).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'id field cannot contain whitespace, slashes nor any of (+$:) characters.' } })
        }
        expect(await api(client, 'PUT', `/devicecontrol/newDeviceRequests/${ids[0]}`, { status: 'ACCEPTED', id: 'other' })).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'id is not allowed here' } })
        const res = await client.core.fetch('/devicecontrol/newDeviceRequests', { method: 'POST', headers: { 'content-type': 'text/plain', 'accept': 'application/json' }, body: JSON.stringify({ id: `${ids[0]}-x` }) })
        expect(res.status).toBe(415)
        expect(await res.text()).toBe('')
      } finally {
        for (const id of ids) {
          await api(client, 'DELETE', `/devicecontrol/newDeviceRequests/${encodeURIComponent(id)}`)
        }
      }
    },
  },

  {
    name: 'bulk operations: one operation per child asset, progress, general status, manual SUCCESSFUL',
    verifies: ['bulk-operation-numeric-id', 'bulk-operation-general-status', 'bulk-operation-failed-operations', 'operation-update-needs-agent'],
    async run({ client, unique }) {
      const [a, b] = [await agent(client, `bo-a-${unique}`), await agent(client, `bo-b-${unique}`)]
      const { data: plain } = await client.inventory.create({ name: `bo-p-${unique}`, c8y_IsDevice: {} })
      const groupId = await group(client, `bo-g-${unique}`, [a, b, plain.id])

      const created = await api(client, 'POST', '/devicecontrol/bulkoperations', { groupId, startDate: inSeconds(2), creationRamp: 1, operationPrototype: { description: `restart ${unique}`, c8y_Restart: {} } })
      expect(created.status).toBe(201)
      const bulk = created.body
      expect(typeof bulk.id).toBe('number')
      expect(bulk).toMatchObject({ groupId, creationRamp: 1, status: 'ACTIVE', generalStatus: 'SCHEDULED', note: null, create: true, operationPrototype: { c8y_Restart: {} } })
      expect(bulk.progress).toEqual({ pending: 0, successful: 0, failed: 0, executing: 0, all: 3 })

      // the platform creates one operation per ramp, and completes one ramp after the last
      await eventually(async () => {
        const { body } = await api(client, 'GET', `/devicecontrol/bulkoperations/${bulk.id}`)
        expect(body.status).toBe('COMPLETED')
        expect(body.generalStatus).toBe('EXECUTING_WITH_ERROR')
        expect(body.progress).toEqual({ pending: 2, successful: 0, failed: 1, executing: 0, all: 3 })
      }, 20_000)

      const operations = (await api(client, 'GET', `/devicecontrol/operations?bulkOperationId=${bulk.id}&pageSize=10`)).body.operations
      expect(operations.map((operation: { deviceId: string }) => operation.deviceId).sort()).toEqual([a, b, plain.id].sort())
      const failed = operations.find((operation: { deviceId: string }) => operation.deviceId === plain.id)
      expect(failed).toMatchObject({ status: 'FAILED', failureReason: `Agent for device '${plain.id}' does not exist in inventory!`, bulkOperationId: bulk.id, c8y_Restart: {}, description: `restart ${unique}` })
      // the operation of an object without an agent cannot be updated either
      const blocked = await api(client, 'PUT', `/devicecontrol/operations/${failed.id}`, { status: 'SUCCESSFUL' })
      expect(blocked.status).toBe(422)
      expect(blocked.body.message).toBe(`Agent for device '${plain.id}' does not exist in inventory!`)

      const [first, second] = operations.filter((operation: { status: string }) => operation.status === 'PENDING')
      await api(client, 'PUT', `/devicecontrol/operations/${first.id}`, { status: 'EXECUTING' })
      const executing = (await api(client, 'GET', `/devicecontrol/bulkoperations/${bulk.id}`)).body
      expect(executing.progress).toMatchObject({ pending: 1, executing: 1, failed: 1 })
      await api(client, 'PUT', `/devicecontrol/operations/${first.id}`, { status: 'SUCCESSFUL' })
      await api(client, 'PUT', `/devicecontrol/operations/${second.id}`, { status: 'SUCCESSFUL' })
      const done = (await api(client, 'GET', `/devicecontrol/bulkoperations/${bulk.id}`)).body
      expect(done).toMatchObject({ status: 'COMPLETED', generalStatus: 'FAILED', progress: { successful: 2, failed: 1, pending: 0 } })

      // a FAILED bulk operation can be marked SUCCESSFUL, nothing else
      const canceled = await api(client, 'PUT', `/devicecontrol/bulkoperations/${bulk.id}`, { generalStatus: 'CANCELED' })
      expect(canceled.status).toBe(500)
      expect(canceled.body.message).toBe('Manual update general status is possible only from FAILED to SUCCESSFUL')
      const successful = await api(client, 'PUT', `/devicecontrol/bulkoperations/${bulk.id}`, { generalStatus: 'SUCCESSFUL' })
      expect(successful.status).toBe(200)
      expect(successful.body).toMatchObject({ id: bulk.id, generalStatus: 'SUCCESSFUL' })

      // a completed bulk operation can neither be deleted nor changed
      const deleted = await api(client, 'DELETE', `/devicecontrol/bulkoperations/${bulk.id}`)
      expect(deleted.status).toBe(404)
      expect(deleted.body.error).toBe('devicecontrol/Not Found')
      expect((await api(client, 'PUT', `/devicecontrol/bulkoperations/${bulk.id}`, { creationRamp: 2 })).status).toBe(404)
    },
  },
  {
    name: 'bulk operations: validation, update replaces a scheduled one, delete cancels',
    verifies: ['bulk-operation-validation', 'bulk-operation-update-replaces', 'bulk-operation-delete-cancels'],
    async run({ client, unique }) {
      const a = await agent(client, `bv-a-${unique}`)
      const groupId = await group(client, `bv-g-${unique}`, [a])
      const empty = await group(client, `bv-e-${unique}`, [])
      const post = (body: Record<string, unknown>) => api(client, 'POST', '/devicecontrol/bulkoperations', body)
      const valid = { groupId, startDate: inSeconds(3600), creationRamp: 5, operationPrototype: { c8y_Restart: {} } }

      for (const [field, message] of [['creationRamp', 'creationRamp is required'], ['startDate', 'startDate is required'], ['operationPrototype', 'operationPrototype is required']] as const) {
        const result = await post({ ...valid, [field]: undefined })
        expect(result.status, field).toBe(422)
        expect(result.body).toMatchObject({ error: 'undefined/validationError', message })
      }
      expect((await post({ ...valid, groupId: undefined })).body.error).toBe('undefined/validationError')
      expect((await post({ ...valid, startDate: 'tomorrow' })).status).toBe(400)
      expect((await post({ ...valid, creationRamp: 0 })).body).toMatchObject({ error: 'bulkOperationResource/Invalid Data', message: 'Creation ramp must be greater than 0' })
      expect((await post({ ...valid, groupId: '99999999999' })).body).toMatchObject({ error: 'bulkOperationResource/Invalid Data', message: 'Cannot find group for id=\'99999999999\'' })
      const emptyGroup = await post({ ...valid, groupId: empty })
      expect(emptyGroup.status).toBe(422)
      expect(emptyGroup.body.message).toBe(`Cannot execute bulk operation on empty group. Group with id='ID [type=com_cumulocity_model_idtype_GId, value=${empty}]' doesn't have child assets.`)
      expect((await api(client, 'GET', '/devicecontrol/bulkoperations/abc')).status).toBe(422)
      const missing = await api(client, 'GET', '/devicecontrol/bulkoperations/99999999')
      expect(missing.status).toBe(404)
      expect(missing.body).toMatchObject({ error: 'devicecontrol/Not Found', message: 'Finding bulk operation from database failed : Cannot find document with ID 99999999' })

      // the ramp is raised to the minimum of 1 second, custom fragments are kept
      const { body: scheduled } = await post({ ...valid, creationRamp: 0.5, note: `note ${unique}`, c8y_Custom: { a: 1 } })
      expect(scheduled).toMatchObject({ creationRamp: 1, note: `note ${unique}`, c8y_Custom: { a: 1 }, generalStatus: 'SCHEDULED' })

      // an update replaces a bulk operation that did not start yet: new id, old one gone, custom fragments dropped
      expect((await api(client, 'PUT', `/devicecontrol/bulkoperations/${scheduled.id}`, {})).body.error).toBe('bulkOperationResource/Invalid Data')
      const updated = await api(client, 'PUT', `/devicecontrol/bulkoperations/${scheduled.id}`, { creationRamp: 3 })
      expect(updated.status).toBe(200)
      expect(updated.body.id).not.toBe(scheduled.id)
      expect(updated.body).toMatchObject({ groupId, creationRamp: 3, note: `note ${unique}`, status: 'ACTIVE', generalStatus: 'SCHEDULED' })
      expect(updated.body.c8y_Custom).toBeUndefined()
      expect((await api(client, 'GET', `/devicecontrol/bulkoperations/${scheduled.id}`)).status).toBe(404)

      // deleting cancels: still readable, hidden from the list, not deletable twice
      expect((await api(client, 'DELETE', `/devicecontrol/bulkoperations/${updated.body.id}`)).status).toBe(204)
      expect((await api(client, 'GET', `/devicecontrol/bulkoperations/${updated.body.id}`)).body).toMatchObject({ status: 'DELETED', generalStatus: 'CANCELED' })
      const list = await api(client, 'GET', '/devicecontrol/bulkoperations?pageSize=2000')
      expect(list.body.bulkOperations.map((item: { id: number }) => item.id)).not.toContain(updated.body.id)
      const again = await api(client, 'DELETE', `/devicecontrol/bulkoperations/${updated.body.id}`)
      expect(again.status).toBe(404)
      expect(again.body.message).toBe(`Finding bulk operation from database failed : Could not find ACTIVE or IN_PROGRESS entity BulkOperation by ID ID [type=com_cumulocity_model_idtype_GId, value=${updated.body.id}]!`)

      // updating a canceled one that never started schedules it again under a new id
      const revived = await api(client, 'PUT', `/devicecontrol/bulkoperations/${updated.body.id}`, { note: `again ${unique}` })
      expect(revived.status).toBe(200)
      expect(revived.body).toMatchObject({ status: 'ACTIVE', generalStatus: 'SCHEDULED', note: `again ${unique}` })
      expect((await api(client, 'DELETE', `/devicecontrol/bulkoperations/${revived.body.id}`)).status).toBe(204)
    },
  },
  {
    name: 'bulk operations: a start date in the past starts at once, deleting a running one still creates the due operation',
    verifies: ['bulk-operation-delete-cancels'],
    async run({ client, unique, settle }) {
      const [a, b] = [await agent(client, `br-a-${unique}`), await agent(client, `br-b-${unique}`)]
      const groupId = await group(client, `br-g-${unique}`, [a, b])
      const { body: bulk } = await api(client, 'POST', '/devicecontrol/bulkoperations', { groupId, startDate: inSeconds(-600), creationRamp: 30, operationPrototype: { c8y_Restart: {} } })
      await eventually(async () => {
        const { body } = await api(client, 'GET', `/devicecontrol/bulkoperations/${bulk.id}`)
        expect(body).toMatchObject({ status: 'IN_PROGRESS', generalStatus: 'EXECUTING', progress: { pending: 1, all: 2 } })
      })
      // the operation's creation time is when it was created, not the start date
      const [operation] = (await api(client, 'GET', `/devicecontrol/operations?bulkOperationId=${bulk.id}`)).body.operations
      expect(Date.parse(operation.creationTime)).toBeGreaterThan(Date.parse(bulk.startDate) + 60_000)

      expect((await api(client, 'DELETE', `/devicecontrol/bulkoperations/${bulk.id}`)).status).toBe(204)
      // the next operation is due after 30 seconds and is still created after the delete
      await settle(35_000)
      const { body } = await api(client, 'GET', `/devicecontrol/bulkoperations/${bulk.id}`)
      expect(body).toMatchObject({ status: 'DELETED', generalStatus: 'CANCELED', progress: { pending: 2, all: 2 } })
    },
  },
  {
    name: 'new device requests: create, validation, accepting needs a connected device, delete',
    verifies: ['new-device-request-accept-pending-only'],
    async run({ client, unique }) {
      const { data: target } = await client.inventory.create({ name: `ndr-g-${unique}`, c8y_IsDeviceGroup: {} } as any)
      const ids: [string, string, string] = [`ndr-${unique}-1`, `ndr-${unique}-2`, `ndr-${unique}-3`]
      try {
        const post = (body: Record<string, unknown>) => api(client, 'POST', '/devicecontrol/newDeviceRequests', body)
        const created = await post({ id: ids[0], type: 'c8y_Test', groupId: target.id, c8y_Ignored: { a: 1 } })
        expect(created.status).toBe(201)
        expect(created.body).toMatchObject({ id: ids[0], status: 'WAITING_FOR_CONNECTION', type: 'c8y_Test', groupId: target.id, customProperties: {} })
        expect(typeof created.body.owner).toBe('string')
        expect(created.body.c8y_Ignored).toBeUndefined()
        expect((await post({ id: ids[1], enrollmentToken: `otp-${unique}` })).body.status).toBe('ACCEPTED')

        expect((await post({ id: ids[0] })).body).toMatchObject({ error: 'devicecontrol/Non Unique Result', message: `NewDeviceRequest for id = ${ids[0]} already exists.` })
        expect((await post({ type: 'x' })).body).toMatchObject({ error: 'undefined/validationError', message: 'id is required' })
        expect((await post({ id: `${ids[2]} x` })).body.message).toBe('id field cannot contain whitespace, slashes nor any of (+$:) characters.')
        expect((await post({ id: ids[2], status: 'ACCEPTED' })).body.message).toBe('status is not allowed here')
        const unknownGroup = await post({ id: ids[2], groupId: '99999999999' })
        expect(unknownGroup.status).toBe(404)
        expect(unknownGroup.body.error).toBe('inventory/Not Found')

        const list = (await api(client, 'GET', '/devicecontrol/newDeviceRequests?pageSize=2000&withTotalPages=true')).body
        // newest first
        const listed = list.newDeviceRequests.map((request: { id: string }) => request.id).filter((id: string) => ids.includes(id))
        expect(listed).toEqual([ids[1], ids[0]])
        expect((await api(client, 'GET', `/devicecontrol/newDeviceRequests/${ids[0]}`)).body.id).toBe(ids[0])
        expect((await api(client, 'GET', `/devicecontrol/newDeviceRequests/${ids[2]}`)).body).toMatchObject({ error: 'devicecontrol/Not Found', message: `Could not find newDeviceRequest by ID ${ids[2]}` })

        const put = (id: string, body: Record<string, unknown>) => api(client, 'PUT', `/devicecontrol/newDeviceRequests/${id}`, body)
        expect((await put(ids[0], {})).body.message).toBe('status is required')
        expect((await put(ids[0], { status: 'BLOCKED' })).body).toMatchObject({ error: 'devicecontrol/Invalid Data', message: 'Can transpose to ACCEPTED status only.' })
        expect((await put(ids[2], { status: 'PENDING_ACCEPTANCE' })).status).toBe(422)
        expect((await put(ids[0], { status: 'BOGUS' })).status).toBe(500)
        const waiting = await put(ids[0], { status: 'ACCEPTED' })
        expect(waiting.status).toBe(404)
        expect(waiting.body.message).toBe(`NewDeviceRequest for device id ${ids[0]} is in state WAITING_FOR_CONNECTION, (not PENDING_ACCEPTANCE)).`)
        expect((await put(ids[1], { status: 'ACCEPTED' })).body.message).toBe(`NewDeviceRequest for device id ${ids[1]} is in state ACCEPTED, (not PENDING_ACCEPTANCE)).`)
        expect((await put(ids[2], { status: 'ACCEPTED' })).body.message).toBe(`There is no newDeviceRequest for device id ${ids[2]}.`)

        expect((await api(client, 'DELETE', `/devicecontrol/newDeviceRequests/${ids[0]}`)).status).toBe(204)
        expect((await api(client, 'DELETE', `/devicecontrol/newDeviceRequests/${ids[0]}`)).status).toBe(404)
      } finally {
        for (const id of ids) {
          await api(client, 'DELETE', `/devicecontrol/newDeviceRequests/${id}`)
        }
      }
    },
  },
  {
    name: 'operations and alarms: delete by filter',
    verifies: ['alarms-delete-needs-filter', 'operations-delete-status-422'],
    async run({ client, unique }) {
      const device = await agent(client, `df-${unique}`)
      const ids: string[] = []
      for (const status of ['SUCCESSFUL', 'SUCCESSFUL', 'FAILED']) {
        const { body } = await api(client, 'POST', '/devicecontrol/operations', { deviceId: device, c8y_Restart: {} })
        await api(client, 'PUT', `/devicecontrol/operations/${body.id}`, { status })
        ids.push(body.id)
      }
      const remaining = async () => (await api(client, 'GET', `/devicecontrol/operations?deviceId=${device}&pageSize=10`)).body.operations.map((operation: { id: string }) => operation.id)
      const bogus = await api(client, 'DELETE', `/devicecontrol/operations?deviceId=${device}&status=BOGUS`)
      expect(bogus.status).toBe(422)
      expect(bogus.body.error).toBe('undefined/validationError')
      expect((await api(client, 'DELETE', `/devicecontrol/operations?deviceId=${device}&dateFrom=yesterday`)).status).toBe(422)
      // no match is no error
      expect((await api(client, 'DELETE', `/devicecontrol/operations?deviceId=${device}&status=EXECUTING`)).status).toBe(204)
      expect((await api(client, 'DELETE', `/devicecontrol/operations?deviceId=${device}&status=SUCCESSFUL`)).status).toBe(204)
      await eventually(async () => {
        expect(await remaining()).toEqual([ids[2]])
      })
      expect((await api(client, 'DELETE', `/devicecontrol/operations?deviceId=${device}&dateFrom=${new Date(Date.now() - 3_600_000).toISOString()}`)).status).toBe(204)
      await eventually(async () => {
        expect(await remaining()).toEqual([])
      })

      const alarm = (type: string, severity: string) => api(client, 'POST', '/alarm/alarms', { source: { id: device }, type: `${type}-${unique}`, severity, text: type, time: time(1) })
      await alarm('a', 'MAJOR')
      await alarm('b', 'MINOR')
      await alarm('c', 'CRITICAL')
      await api(client, 'PUT', `/alarm/alarms?source=${device}&severity=MINOR`, { status: 'ACKNOWLEDGED' })
      const types = async () => (await api(client, 'GET', `/alarm/alarms?source=${device}&pageSize=10`)).body.alarms.map((item: { type: string }) => item.type).sort()
      // the platform needs a source or a date range, and children need a source
      expect((await api(client, 'DELETE', `/alarm/alarms?type=a-${unique}`)).body).toMatchObject({ error: 'alarm/Unprocessable Entity', message: 'At least one parameter from [source, createdFrom, createdTo, dateFrom, dateTo] has to be provided' })
      expect((await api(client, 'DELETE', `/alarm/alarms?type=a-${unique}&withSourceDevices=true&dateFrom=2099-01-01`)).body.message).toBe('Cannot fetch children alarms if parameter \'source\' is not specified!')
      expect((await api(client, 'DELETE', `/alarm/alarms?source=${device}&dateFrom=yesterday`)).status).toBe(422)
      expect((await api(client, 'DELETE', `/alarm/alarms?source=${device}&type=none-${unique}`)).status).toBe(204)
      expect((await api(client, 'DELETE', `/alarm/alarms?source=${device}&severity=CRITICAL`)).status).toBe(204)
      await eventually(async () => {
        expect(await types()).toEqual([`a-${unique}`, `b-${unique}`])
      })
      expect((await api(client, 'DELETE', `/alarm/alarms?source=${device}&status=ACKNOWLEDGED`)).status).toBe(204)
      await eventually(async () => {
        expect(await types()).toEqual([`a-${unique}`])
      })
    },
  },
]
