/**
 * Ids sent as JSON numbers are stored as strings (verified), so alarm
 * deduplication and lookups by id work for them.
 */
import { expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'

async function send(world: World, method: string, path: string, body?: unknown) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: { 'accept': 'application/json', 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  return { status: response.status, body: await response.json() }
}

it('stores numeric source ids and device ids as strings', async () => {
  const world = createWorld()
  const device = world.device({ com_cumulocity_model_Agent: {} })
  const alarm = { source: { id: Number(device) }, type: 'dup', text: 't', severity: 'MINOR', time: '2026-01-01T00:00:00Z' }
  const first = await send(world, 'POST', '/alarm/alarms', alarm)
  const second = await send(world, 'POST', '/alarm/alarms', alarm)
  expect(first.body.source.id).toBe(device)
  expect(second.body.id).toBe(first.body.id)
  expect(second.body.count).toBe(2)
  expect((await send(world, 'GET', `/alarm/alarms?source=${device}`)).body.alarms).toHaveLength(1)

  const operation = await send(world, 'POST', '/devicecontrol/operations', { deviceId: Number(device), c8y_Restart: {} })
  expect(operation.body.deviceId).toBe(device)
  expect((await send(world, 'GET', `/devicecontrol/operations?deviceId=${device}`)).body.operations.map((item: { id: string }) => item.id)).toEqual([operation.body.id])
})

it('matches an unquoted id in the query language with nothing', async () => {
  const world = createWorld()
  const device = world.device()
  const query = (filter: string) => send(world, 'GET', `/inventory/managedObjects?query=${encodeURIComponent(filter)}`)
  expect((await query(`$filter=(id eq ${device})`)).body.managedObjects).toEqual([])
  expect((await query(`$filter=(id eq '${device}')`)).body.managedObjects).toHaveLength(1)
})
