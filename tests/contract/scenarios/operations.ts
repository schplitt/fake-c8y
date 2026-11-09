import { expect } from 'vitest'
import type { ContractScenario } from '../helpers'
import type { Client } from '@c8y/client'
import { eventually, rejection, sleep } from '../helpers'

async function api(client: Client, method: string, path: string, body?: unknown) {
  const res = await client.core.fetch(path, { method, headers: { 'content-type': 'application/json', 'accept': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

const DAY = 86_400_000

export const operationsScenarios: ContractScenario[] = [
  {
    name: 'operations: agentId lists the operations of an agent and its devices, as at creation',
    verifies: ['operation-agent-id'],
    async run({ client, unique, settle }) {
      const object = async (name: string, extra: Record<string, unknown> = {}) => (await client.inventory.create({ name: `r1108data-${name}-${unique}`, c8y_IsDevice: {}, ...extra } as any)).data.id
      const agent = await object('oa-agent', { com_cumulocity_model_Agent: {} })
      const child = await object('oa-child')
      const grandChild = await object('oa-grand')
      const subAgent = await object('oa-sub', { com_cumulocity_model_Agent: {} })
      const other = await object('oa-other', { com_cumulocity_model_Agent: {} })
      await client.inventory.childDevicesAdd(child, agent)
      await client.inventory.childDevicesAdd(grandChild, child)
      await client.inventory.childDevicesAdd(subAgent, agent)
      for (const [deviceId, description] of [[agent, 'agent'], [child, 'child'], [grandChild, 'grand'], [subAgent, 'sub'], [other, 'other']]) {
        expect((await api(client, 'POST', '/devicecontrol/operations', { deviceId, c8y_X: {}, description })).status).toBe(201)
      }
      const list = async (query: string) => {
        const result = await api(client, 'GET', `/devicecontrol/operations?pageSize=100&${query}`)
        return result.status === 200 ? result.body.operations.map((operation: { description: string }) => operation.description) : result
      }

      // the nearest agent: a device below another agent belongs to that one
      expect(await list(`agentId=${agent}`)).toEqual(['agent', 'child', 'grand'])
      expect(await list(`agentId=${subAgent}`)).toEqual(['sub'])
      expect(await list(`agentId=${child}`)).toEqual([])
      expect(await list('agentId=999999999999')).toEqual([])
      expect(await list('agentId=abc')).toEqual([])
      expect(await list(`agentId=${agent}&fragmentType=c8y_X&status=PENDING&revert=TRUE&dateFrom=2020-01-01`)).toEqual(['grand', 'child', 'agent'])
      expect(await list(`agentId=${agent}&deviceId=`)).toEqual(['agent', 'child', 'grand'])
      expect(await list(`agentId=&deviceId=${agent}`)).toEqual(['agent'])
      expect(await list(`agentId=${agent}&deviceId=${child}`)).toMatchObject({ status: 422, body: { error: 'devicecontrol/Invalid Data', message: 'cannot find by agentId and deviceId, only one parameter is possible' } })

      // moving a device to another agent keeps its operations where they were
      await client.inventory.childDevicesRemove(child, agent)
      await client.inventory.childDevicesAdd(child, other)
      expect(await list(`agentId=${agent}`)).toEqual(['agent', 'child', 'grand'])
      expect(await list(`agentId=${other}`)).toEqual(['other'])
      expect((await api(client, 'POST', '/devicecontrol/operations', { deviceId: child, c8y_X: {}, description: 'moved' })).status).toBe(201)
      expect(await list(`agentId=${other}`)).toEqual(['other', 'moved'])

      // delete by filter: agentId and deviceId together select the operations of both
      expect((await api(client, 'DELETE', `/devicecontrol/operations?agentId=${agent}&deviceId=${other}`)).status).toBe(204)
      expect((await api(client, 'DELETE', `/devicecontrol/operations?agentId=${agent}&deviceId=${child}`)).status).toBe(204)
      await eventually(async () => {
        expect(await list(`agentId=${agent}`)).toEqual(['agent', 'grand'])
      })
      expect((await api(client, 'DELETE', `/devicecontrol/operations?agentId=${agent}&status=pending`)).body).toMatchObject({ error: 'undefined/validationError', message: 'Incorrect argument:  : No enum constant com.cumulocity.model.operation.OperationStatus.pending' })
      expect((await api(client, 'DELETE', `/devicecontrol/operations?agentId=${agent}&dateTo=2026-01-01T10:00:00`)).status).toBe(422)
      expect((await api(client, 'DELETE', `/devicecontrol/operations?agentId=${agent}`)).status).toBe(204)
      await eventually(async () => {
        expect(await list(`agentId=${agent}`)).toEqual([])
      })
      await settle(1000)
      expect(await list(`deviceId=${subAgent}`)).toEqual(['sub'])
      expect(await list(`agentId=${other}`)).toEqual(['other', 'moved'])
    },
  },
  {
    name: 'operations: validation messages, no lastUpdated, filters, media types',
    verifies: ['operation-validation-messages', 'media-type-415', 'query-booleans-not-false'],
    async run({ client, unique }) {
      const { data: agent } = await client.inventory.create({ name: `r1108data-ov-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const { data: plain } = await client.inventory.create({ name: `r1108data-ovp-${unique}`, c8y_IsDevice: {} })
      const post = (body: Record<string, unknown>) => api(client, 'POST', '/devicecontrol/operations', body)
      const invalid = (message: string, error = 'undefined/validationError') => ({ status: 422, body: { error, message } })
      expect(await post({ c8y_X: {} })).toMatchObject(invalid('deviceId is required'))
      expect(await post({ deviceId: null, c8y_X: {} })).toMatchObject(invalid('deviceId is required'))
      expect(await post({ deviceId: agent.id })).toMatchObject(invalid('weak-typed property must be included in operation', 'devicecontrol/Invalid Data'))
      for (const [field, value] of [['id', '5'], ['creationTime', '2026-01-01T00:00:00.000Z'], ['status', 'PENDING'], ['failureReason', 'x']] as const) {
        expect(await post({ deviceId: agent.id, c8y_X: {}, [field]: value }), field).toMatchObject(invalid(`${field} is not allowed here`))
      }
      expect(await post({ deviceId: '999999999999', c8y_X: {} })).toMatchObject(invalid('Device \'999999999999\' does not exist in inventory! : Finding device data from database failed', 'devicecontrol/Unprocessable Entity'))
      expect(await post({ deviceId: plain.id, c8y_X: {} })).toMatchObject(invalid(`Agent for device '${plain.id}' does not exist in inventory!`, 'devicecontrol/Unprocessable Entity'))

      // the platform keeps no lastUpdated of its own: a given one is stored as sent, like bulkOperationId and time; deviceName and self are its own
      expect(await post({ deviceId: agent.id, c8y_X: {}, bulkOperationId: 'abc' })).toMatchObject({ status: 400, body: { error: 'Failed to parse JSON string' } })
      const created = await post({ deviceId: Number(agent.id), c8y_X: {}, bulkOperationId: 999999999, deviceName: 'x', self: 'x', lastUpdated: '2020-01-01T00:00:00Z', time: 'garbage' })
      expect(created.status).toBe(201)
      expect(created.body).toMatchObject({ deviceId: agent.id, deviceName: `r1108data-ov-${unique}`, bulkOperationId: 999999999, status: 'PENDING', time: 'garbage', lastUpdated: '2020-01-01T00:00:00Z' })
      expect(Object.keys(created.body).sort()).toEqual(['bulkOperationId', 'c8y_X', 'creationTime', 'deviceId', 'deviceName', 'id', 'lastUpdated', 'self', 'status', 'time'])
      const { id } = created.body
      const put = (body: Record<string, unknown>) => api(client, 'PUT', `/devicecontrol/operations/${id}`, body)
      expect(await put({ description: 'x' })).toMatchObject(invalid('status is required'))
      expect(await put({ status: null })).toMatchObject(invalid('status is required'))
      const badStatus = invalid('Operation Status value is not correct. Allowed values: [PENDING, SUCCESSFUL, FAILED, EXECUTING]', 'Operation API/Invalid Data')
      expect(await put({ status: 'executing' })).toMatchObject(badStatus)
      expect(await put({ status: 5 })).toMatchObject(badStatus)
      // the device can never be sent, not even the same one
      expect(await put({ status: 'EXECUTING', deviceId: agent.id })).toMatchObject(invalid('deviceId is not allowed here'))
      expect(await put({ status: 'EXECUTING', creationTime: '2026-01-01T00:00:00.000Z' })).toMatchObject(invalid('creationTime is not allowed here'))
      expect(await put({ status: 'SUCCESSFUL', failureReason: 'x' })).toMatchObject(invalid('Invalid value for failureReason argument! : Should be set only when operation status is FAILED!', 'devicecontrol/Invalid Data'))
      // an update of an operation of an unknown bulk operation is stored, but answers 500
      expect(await put({ status: 'FAILED', failureReason: 5, bulkOperationId: 7 })).toMatchObject({ status: 500, body: { error: 'general/internalError', message: 'Cannot find document with ID 999999999' } })
      expect((await api(client, 'GET', `/devicecontrol/operations/${id}`)).body).toMatchObject({ status: 'FAILED', failureReason: '5', bulkOperationId: 999999999 })
      expect((await put({ status: 'FAILED', failureReason: '' })).status).toBe(500)
      const read = await api(client, 'GET', `/devicecontrol/operations/${id}`)
      expect(read.body.failureReason).toBe('')
      expect(Object.keys(read.body).sort()).toEqual(['bulkOperationId', 'c8y_X', 'creationTime', 'deviceId', 'failureReason', 'id', 'lastUpdated', 'self', 'status', 'time'])

      // list filters: a status in upper case, an empty one is no filter, any property is a fragment
      const list = async (query: string) => {
        const result = await api(client, 'GET', `/devicecontrol/operations?deviceId=${agent.id}&${query}`)
        return result.status === 200 ? result.body.operations.map((operation: { id: string }) => operation.id) : result
      }
      expect(await list('status=failed')).toMatchObject(invalid('Incorrect argument:  : No enum constant com.cumulocity.model.operation.OperationStatus.failed'))
      expect(await list('status=')).toEqual([id])
      for (const fragment of ['c8y_X', 'time', 'status', 'deviceId', 'bulkOperationId', '']) {
        expect(await list(`fragmentType=${fragment}`), fragment).toEqual([id])
      }
      expect(await list('fragmentType=c8y_Y')).toEqual([])
      expect(await list('bulkOperationId=999999999')).toEqual([id])
      expect(await list('bulkOperationId=6')).toEqual([])
      for (const value of ['abc', '1.5']) {
        expect(await api(client, 'GET', `/devicecontrol/operations?deviceId=${agent.id}&bulkOperationId=${value}`)).toEqual({ status: 404, body: undefined })
      }
      expect((await api(client, 'GET', `/devicecontrol/operations?deviceId=${agent.id}&withTotalPages=yes&withTotalElements=TRUE`)).body.statistics).toEqual({ currentPage: 1, pageSize: 5, totalPages: 1, totalElements: 1 })
      expect((await api(client, 'GET', `/devicecontrol/operations?deviceId=${agent.id}&dateFrom=2026-01-01T00:00:00`)).status).toBe(422)

      // other media types answer an empty 415, the vendor type is fine
      for (const [method, path] of [['POST', '/devicecontrol/operations'], ['PUT', `/devicecontrol/operations/${id}`]] as const) {
        const res = await client.core.fetch(path, { method, headers: { 'content-type': 'text/plain', 'accept': 'application/json' }, body: JSON.stringify({ deviceId: agent.id, status: 'SUCCESSFUL', c8y_X: {} }) })
        expect(res.status, method).toBe(415)
        expect(await res.text()).toBe('')
      }
      const plainOperation = (await post({ deviceId: agent.id, c8y_Y: {} })).body.id
      const vendor = await client.core.fetch(`/devicecontrol/operations/${plainOperation}`, { method: 'PUT', headers: { 'content-type': 'application/vnd.com.nsn.cumulocity.operation+json', 'accept': 'application/vnd.com.nsn.cumulocity.operation+json' }, body: JSON.stringify({ status: 'SUCCESSFUL' }) })
      expect(vendor.status).toBe(200)
      expect((await vendor.json()).status).toBe('SUCCESSFUL')
    },
  },

  {
    name: 'operations: need an agent, PENDING on create, status updates, list by device and status',
    async run({ client, unique }) {
      const { data: plain } = await client.inventory.create({ name: `o-plain-${unique}`, c8y_IsDevice: {} })
      expect((await rejection(client.operation.create({ deviceId: plain.id, c8y_Restart: {} } as any))).res.status).toBe(422)

      const { data: device } = await client.inventory.create({ name: `o-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const { data: operation } = await client.operation.create({ deviceId: device.id, c8y_Restart: {} } as any)
      expect(operation.status).toBe('PENDING')

      await client.operation.update({ id: operation.id, status: 'EXECUTING' } as any)
      const { data: done } = await client.operation.update({ id: operation.id, status: 'SUCCESSFUL' } as any)
      expect(done.status).toBe('SUCCESSFUL')

      const { data: list } = await client.operation.list({ deviceId: device.id, status: 'SUCCESSFUL' } as any)
      expect(list.map((item) => item.id)).toEqual([operation.id])

      expect((await rejection(client.operation.update({ id: operation.id, status: 'DONE' } as any))).res.status).toBe(422)
    },
  },
  {
    name: 'operations: devices below an agent, failure reason, status filter',
    async run({ client, unique }) {
      const { data: agent } = await client.inventory.create({ name: `ag-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const { data: child } = await client.inventory.create({ name: `ch-${unique}`, c8y_IsDevice: {} })
      await client.inventory.childDevicesAdd(child.id, agent.id)

      const { data: operation } = await client.operation.create({ deviceId: child.id, c8y_Command: { text: 'reboot' } } as any)
      expect(operation.status).toBe('PENDING')

      const { data: failed } = await client.operation.update({ id: operation.id, status: 'FAILED', failureReason: 'Device offline' } as any)
      expect(failed).toMatchObject({ status: 'FAILED', failureReason: 'Device offline' })

      const { data: list } = await client.operation.list({ deviceId: child.id, status: 'FAILED' } as any)
      expect(list.map((item) => item.id)).toEqual([operation.id])
      expect((await client.operation.list({ deviceId: child.id, status: 'PENDING' } as any)).data).toEqual([])
    },
  },
  {
    name: 'operations: single operation, 404, unknown device, invalid bodies',
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `os-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const created = await api(client, 'POST', '/devicecontrol/operations', { deviceId: device.id, c8y_Restart: {}, description: 'restart' })
      expect(created.status).toBe(201)
      expect(created.body).toMatchObject({ deviceId: device.id, deviceName: `os-${unique}`, status: 'PENDING', description: 'restart' })
      const id = created.body.id

      const fetched = await api(client, 'GET', `/devicecontrol/operations/${id}`)
      expect(fetched.status).toBe(200)
      expect(fetched.body).toMatchObject({ id, deviceId: device.id, status: 'PENDING', c8y_Restart: {}, description: 'restart' })
      // the platform adds the device name to created and updated operations and list items, but not to a single read
      expect(fetched.body.deviceName).toBeUndefined()

      const missing = await api(client, 'GET', '/devicecontrol/operations/99999999999')
      expect(missing.status).toBe(404)
      expect(missing.body.error).toBe('devicecontrol/Not Found')
      expect((await api(client, 'PUT', '/devicecontrol/operations/99999999999', { status: 'EXECUTING' })).status).toBe(404)

      const post = (body: Record<string, unknown>) => api(client, 'POST', '/devicecontrol/operations', body)
      expect((await post({ deviceId: '99999999999', c8y_Restart: {} })).status).toBe(422)
      expect((await post({ c8y_Restart: {} })).status).toBe(422)
      expect((await post({})).status).toBe(422)
      // an operation needs at least one property besides the device; the description counts
      expect((await post({ deviceId: device.id })).status).toBe(422)
      expect((await post({ deviceId: device.id, description: 'only a description' })).status).toBe(201)
      // the platform owns id, status, failureReason, and creationTime
      for (const field of [{ id: '5' }, { status: 'SUCCESSFUL' }, { failureReason: 'x' }, { creationTime: '2026-01-01T00:00:00.000Z' }]) {
        expect((await post({ deviceId: device.id, c8y_Restart: {}, ...field })).status, JSON.stringify(field)).toBe(422)
      }
    },
  },
  {
    name: 'operations: status transitions are unrestricted, failureReason and read-only fields',
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `ot-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const { data: plain } = await client.inventory.create({ name: `ot2-${unique}`, c8y_IsDevice: {} })
      const { id } = (await api(client, 'POST', '/devicecontrol/operations', { deviceId: device.id, c8y_Config: { a: 1 }, description: 'before' })).body
      const put = (body: Record<string, unknown>) => api(client, 'PUT', `/devicecontrol/operations/${id}`, body)

      // any status can follow any other, even backwards
      for (const status of ['SUCCESSFUL', 'PENDING', 'EXECUTING', 'FAILED', 'SUCCESSFUL', 'PENDING']) {
        const result = await put({ status })
        expect(result.status, status).toBe(200)
        expect(result.body.status).toBe(status)
      }
      expect((await put({ status: 'BOGUS' })).status).toBe(422)
      expect((await api(client, 'GET', `/devicecontrol/operations/${id}`)).body.status).toBe('PENDING')
      expect((await put({ description: 'no status' })).status).toBe(422)

      // failureReason belongs to FAILED, and is dropped when the status moves on
      expect((await put({ status: 'SUCCESSFUL', failureReason: 'x' })).status).toBe(422)
      expect((await put({ status: 'FAILED', failureReason: 'Device offline' })).body).toMatchObject({ status: 'FAILED', failureReason: 'Device offline' })
      const recovered = await put({ status: 'SUCCESSFUL' })
      expect(recovered.body.status).toBe('SUCCESSFUL')
      expect(recovered.body.failureReason).toBeUndefined()

      // device, creation time are fixed; id, deviceName are ignored
      expect((await put({ status: 'EXECUTING', deviceId: plain.id })).status).toBe(422)
      expect((await put({ status: 'EXECUTING', creationTime: '2026-01-01T00:00:00.000Z' })).status).toBe(422)
      const ignored = await put({ status: 'EXECUTING', id: '5', deviceName: 'renamed' })
      expect(ignored.status).toBe(200)
      expect(ignored.body).toMatchObject({ id, deviceId: device.id, deviceName: `ot-${unique}` })

      // fragments are replaced as a whole, null removes one
      expect((await put({ status: 'EXECUTING', c8y_Config: { b: 2 }, description: 'after' })).body).toMatchObject({ c8y_Config: { b: 2 }, description: 'after' })
      expect((await api(client, 'GET', `/devicecontrol/operations/${id}`)).body.c8y_Config).toEqual({ b: 2 })
      const removed = await put({ status: 'EXECUTING', description: null })
      expect(removed.status).toBe(200)
      expect(removed.body.description).toBeUndefined()
    },
  },
  {
    name: 'operations: list ordering, revert, dates, fragmentType, paging',
    verifies: ['operations-status-filter-422', 'date-parameters-lenient'],
    async run({ client, unique }) {
      const { data: device } = await client.inventory.create({ name: `ol-${unique}`, c8y_IsDevice: {}, com_cumulocity_model_Agent: {} } as any)
      const created: Array<{ id: string, creationTime: string }> = []
      for (const fragment of ['c8y_A', 'c8y_B', 'c8y_C', 'c8y_D']) {
        created.push((await api(client, 'POST', '/devicecontrol/operations', { deviceId: device.id, [fragment]: {} })).body)
        await sleep(30)
      }
      const [a, b, c, d] = created.map((operation) => operation.id) as [string, string, string, string]
      const base = `/devicecontrol/operations?deviceId=${device.id}`
      const ids = async (query: string) => {
        const result = await api(client, 'GET', `${base}&pageSize=100&${query}`)
        expect(result.status, query).toBe(200)
        return result.body.operations.map((operation: { id: string }) => operation.id)
      }
      const before = new Date(Date.now() - DAY).toISOString()
      const after = new Date(Date.now() + DAY).toISOString()

      // oldest first; revert only takes effect together with a date range
      expect(await ids('')).toEqual([a, b, c, d])
      expect(await ids('revert=true')).toEqual([a, b, c, d])
      expect(await ids('revert=false')).toEqual([a, b, c, d])
      expect(await ids(`dateFrom=${before}`)).toEqual([a, b, c, d])
      expect(await ids(`dateFrom=${before}&revert=false`)).toEqual([a, b, c, d])
      expect(await ids(`dateFrom=${before}&revert=true`)).toEqual([d, c, b, a])
      expect(await ids(`dateTo=${after}&revert=true`)).toEqual([d, c, b, a])

      // dateFrom inclusive, dateTo exclusive, on the creation time
      expect(await ids(`dateFrom=${created[1]!.creationTime}`)).toEqual([b, c, d])
      expect(await ids(`dateTo=${created[1]!.creationTime}`)).toEqual([a])
      expect(await ids(`dateFrom=${after}`)).toEqual([])
      expect(await ids(`dateTo=${before}`)).toEqual([])
      expect((await api(client, 'GET', `${base}&dateFrom=garbage`)).status).toBe(422)

      expect(await ids('fragmentType=c8y_B')).toEqual([b])
      expect(await ids('fragmentType=c8y_Missing')).toEqual([])

      // status is a single value: lists and unknown values are rejected
      expect(await ids('status=PENDING')).toEqual([a, b, c, d])
      expect(await ids('status=FAILED')).toEqual([])
      expect((await api(client, 'GET', `${base}&status=PENDING,FAILED`)).status).toBe(422)
      expect((await api(client, 'GET', `${base}&status=BOGUS`)).status).toBe(422)

      // list items carry the device name
      const listed = await api(client, 'GET', `${base}&pageSize=1`)
      expect(listed.body.operations[0]).toMatchObject({ id: a, deviceName: `ol-${unique}` })
      const unknown = await api(client, 'GET', '/devicecontrol/operations?deviceId=99999999999')
      expect(unknown.status).toBe(200)
      expect(unknown.body.operations).toEqual([])

      // paging: totals only on request, the next link stops after the last page when totals are asked for
      const page = (query: string) => api(client, 'GET', `${base}&${query}`).then((result) => result.body)
      const first = await page('pageSize=3&currentPage=1&withTotalElements=true&withTotalPages=true')
      expect(first.statistics).toEqual({ currentPage: 1, pageSize: 3, totalElements: 4, totalPages: 2 })
      expect(first.operations.map((operation: { id: string }) => operation.id)).toEqual([a, b, c])
      expect(first.next).toEqual(expect.any(String))
      expect(first.prev).toBeUndefined()
      const second = await page('pageSize=3&currentPage=2&withTotalElements=true&withTotalPages=true')
      expect(second.operations.map((operation: { id: string }) => operation.id)).toEqual([d])
      expect(second.next).toBeUndefined()
      expect(second.prev).toEqual(expect.any(String))
      const beyond = await page('pageSize=3&currentPage=7&withTotalPages=true')
      expect(beyond.operations).toEqual([])
      expect(beyond.next).toBeUndefined()
      const plain = await page('pageSize=3&currentPage=2')
      expect(plain.statistics).toEqual({ currentPage: 2, pageSize: 3 })
      expect(plain.next).toEqual(expect.any(String))
      const partial = await page('pageSize=3&withTotalElements=true')
      expect(partial.statistics).toEqual({ currentPage: 1, pageSize: 3, totalElements: 4 })
    },
  },
]
