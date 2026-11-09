/**
 * Query parameters an endpoint does not have are ignored, like the platform
 * does (verified), also when another endpoint of the same API has them.
 */
import { expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'

async function send(world: World, method: string, path: string, body?: unknown) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: { 'accept': 'application/json', 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

it('filters measurements by fragmentType and ignores status', async () => {
  const world = createWorld()
  const device = world.device()
  world.seed({ measurements: [{ source: device, type: 'm', r: { v: { value: 1 } } }, { source: device, type: 'm', other: { v: { value: 2 } } }] })
  const count = async (query: string) => (await send(world, 'GET', `/measurement/measurements?source=${device}&${query}`)).body.measurements.length
  expect(await count('fragmentType=r')).toBe(1)
  expect(await count('fragmentType=x')).toBe(0)
  expect(await count('status=x')).toBe(2)
})

it('ignores source on the operation list', async () => {
  const world = createWorld()
  const agent = world.device({ com_cumulocity_model_Agent: {} })
  world.seed({ operations: [{ deviceId: agent, c8y_Restart: {} }] })
  expect((await send(world, 'GET', `/devicecontrol/operations?source=${agent}`)).body.operations).toHaveLength(1)
  expect((await send(world, 'GET', '/devicecontrol/operations?source=999')).body.operations).toHaveLength(1)
})

it('ignores type on the bulk alarm update', async () => {
  const world = createWorld()
  const device = world.device()
  world.seed({ alarms: [{ source: device, type: 'a' }, { source: device, type: 'b' }] })
  expect((await send(world, 'PUT', `/alarm/alarms?source=${device}&type=a&status=ACTIVE`, { status: 'ACKNOWLEDGED' })).status).toBe(200)
  expect(world.db.alarms.find().map((alarm) => alarm.status)).toEqual(['ACKNOWLEDGED', 'ACKNOWLEDGED'])
})
