/**
 * `world.fetch()` answers every request: malformed input gets the platform's
 * 4xx, and an exception of the fake or of an override becomes a 500 that
 * makes the trial invalid (`coverage().valid === false`, kind `'error'`).
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'

async function send(world: World, method: string, path: string, body?: string, contentType = 'application/json') {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, {
    method,
    headers: { 'accept': 'application/json', 'content-type': contentType },
    ...(body !== undefined ? { body } : {}),
  }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

const json = (world: World, method: string, path: string, body: unknown) => send(world, method, path, JSON.stringify(body))

describe('world.fetch never throws', () => {
  it('rejects a subscription filter of the wrong type and keeps later writes working', async () => {
    const world = createWorld()
    const device = world.device()
    expect((await json(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 's', subscriptionFilter: { typeFilter: 5 } })).status).toBe(400)
    expect((await json(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 's', subscriptionFilter: { apis: 'alarms' } })).status).toBe(400)
    expect((await json(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 's', subscriptionFilter: { apis: [5] } })).status).toBe(400)
    expect((await json(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 's', fragmentsToCopy: 'c8y_Position' })).status).toBe(400)
    expect(world.realtime.subscriptions).toEqual([])
    expect((await json(world, 'POST', '/alarm/alarms', { source: { id: device }, type: 't', text: 't', severity: 'MAJOR', time: '2026-01-01T00:00:00Z' })).status).toBe(201)
    expect((await json(world, 'POST', '/inventory/managedObjects', { name: 'x' })).status).toBe(201)
    expect(world.coverage().valid).toBe(true)
  })

  it('answers a malformed percent-encoding in the path with 400', async () => {
    const world = createWorld()
    for (const path of ['/inventory/managedObjects/%', '/identity/externalIds/%zz/x', '/inventory/managedObjects/%E0%A4%A']) {
      expect((await send(world, 'GET', path)).status).toBe(400)
    }
    expect(world.calls).toHaveLength(3)
    expect(world.coverage().valid).toBe(true)
  })

  it('answers a body that is not a JSON object with 400', async () => {
    const world = createWorld()
    const device = world.device()
    for (const body of ['"str"', '1', 'true', '[1,2]', '{not json', 'abc']) {
      const answer = await send(world, 'PUT', `/inventory/managedObjects/${device}`, body)
      expect(answer.status).toBe(400)
      expect(answer.body.error).toBe('Failed to parse JSON string')
      expect((await send(world, 'POST', '/inventory/managedObjects', body)).status).toBe(400)
      expect((await send(world, 'PUT', '/tenant/options/c', body)).status).toBe(400)
    }
    expect(world.db.managedObjects.find()).toHaveLength(1)
    expect(world.coverage().valid).toBe(true)
  })

  it('answers null entries in lists like other entries without fields', async () => {
    const world = createWorld()
    const device = world.device()
    expect((await json(world, 'POST', '/measurement/measurements', { measurements: [null] })).status).toBe(422)
    // a single reference without `managedObject` (only the collection content type reads `references`)
    expect((await json(world, 'POST', `/inventory/managedObjects/${device}/childDevices`, { references: [null] })).status).toBe(422)
    expect(world.coverage().valid).toBe(true)
  })

  it('turns an exception into a 500 that makes the trial invalid', async () => {
    const world = createWorld({ unsupported: 'platform' })
    world.override('GET /service/broken/**', () => {
      throw new TypeError('boom')
    })
    const answer = await send(world, 'GET', '/service/broken/x')
    expect(answer.status).toBe(500)
    expect(answer.body.error).toBe('general/Internal Server Error')
    const coverage = world.coverage()
    expect(coverage.valid).toBe(false)
    expect(coverage.unhandled.map((request) => [request.kind, request.reason])).toEqual([['error', 'TypeError: boom']])
    expect(world.calls).toHaveLength(1)
    expect(world.inflight).toBe(0)
  })

  it('also when an async override rejects', async () => {
    const world = createWorld()
    world.override('/service/broken/**', async () => {
      throw new Error('later')
    })
    const answer = await send(world, 'POST', '/service/broken/x', '{}')
    expect(answer.status).toBe(500)
    expect(answer.body.message).toMatch(/later/)
    expect(world.coverage().unhandled[0]!.kind).toBe('error')
  })
})

describe('prototype keys are ordinary names', () => {
  const names = (body: { managedObjects: { name: string }[] }) => body.managedObjects.map((mo) => mo.name).sort()

  it('searches, filters, and renders `constructor` and `__proto__` like any other word or fragment', async () => {
    const world = createWorld()
    world.managedObject({ name: 'Bridge constructor 7' })
    world.managedObject({ name: 'Constructors yard' })
    world.managedObject({ name: 'Pump __proto__ x' })
    expect(names((await send(world, 'GET', '/inventory/managedObjects?pageSize=100&text=constructor')).body)).toEqual(['Bridge constructor 7', 'Constructors yard'])
    expect(names((await send(world, 'GET', '/inventory/managedObjects?pageSize=100&text=yard%20-constructor')).body)).toEqual([])
    expect(names((await send(world, 'GET', '/inventory/managedObjects?pageSize=100&text=__proto__')).body)).toEqual(['Pump __proto__ x'])
    expect((await send(world, 'GET', '/inventory/managedObjects?pageSize=100&fragmentType=constructor')).body.managedObjects).toEqual([])
    expect((await send(world, 'GET', '/event/events?fragmentType=toString')).body.events).toEqual([])

    const created = await send(world, 'POST', '/inventory/managedObjects', '{"name":"p","constructor":{"x":1},"__proto__":{"y":2}}')
    expect(Object.hasOwn(created.body, 'constructor') && Object.hasOwn(created.body, '__proto__')).toBe(true)
    expect(names((await send(world, 'GET', '/inventory/managedObjects?pageSize=100&fragmentType=constructor')).body)).toEqual(['p'])
    expect(world.coverage().valid).toBe(true)
  })

  it('answers a prototype key in the path like an unknown name', async () => {
    const world = createWorld()
    expect(await send(world, 'GET', '/application/constructor/x')).toEqual(await send(world, 'GET', '/application/foo/x'))
    expect(world.coverage().valid).toBe(true)
  })

  it('counts an alarm severity named like a prototype key as a number', async () => {
    const world = createWorld()
    const device = world.device()
    for (const severity of ['constructor', 'constructor', '__proto__']) {
      await json(world, 'POST', '/alarm/alarms', { source: { id: device }, type: `t-${severity}`, text: 't', severity, time: '2026-01-01T00:00:00Z' })
    }
    const status = (await send(world, 'GET', `/inventory/managedObjects/${device}`)).body.c8y_ActiveAlarmsStatus
    expect(Object.values(status).every((count) => typeof count === 'number')).toBe(true)
  })
})
