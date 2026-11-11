/**
 * The trial clock: one time for the world, the agent's sandbox, and the grader.
 */
import { describe, expect, it } from 'vitest'
import { createClock, createWorld } from '../../src'
import { sleep } from '../contract/helpers'

const START = '2026-10-24T00:00:00.000Z'
const DAY = 24 * 60 * 60_000

describe('createClock', () => {
  it('starts at a fixed time, runs with wall time, and jumps', async () => {
    const clock = createClock({ start: START })
    expect(clock.now() - Date.parse(START)).toBeLessThan(1000)
    await sleep(20)
    expect(clock.now() - Date.parse(START)).toBeGreaterThanOrEqual(15)
    clock.advance(DAY)
    expect(clock.now() - Date.parse(START) - DAY).toBeLessThan(1000)
    clock.set(Date.parse(START))
    expect(clock.now() - Date.parse(START)).toBeLessThan(1000)
  })

  it('stands still without realtime', () => {
    const clock = createClock({ start: Date.parse(START), realtime: false })
    expect(clock.now()).toBe(Date.parse(START))
    clock.advance(1000)
    expect(clock.now()).toBe(Date.parse(START) + 1000)
    clock.set('2026-10-25T00:00:00Z')
    expect(clock.now()).toBe(Date.parse(START) + DAY)
    expect(() => clock.set('yesterday')).toThrow(TypeError)
  })
})

describe('a world on a trial clock', () => {
  it('runs bulk operations on advance, without waiting', async () => {
    const clock = createClock({ start: START, realtime: false })
    const base = createWorld({ clock })
    const devices = [1, 2].map((n) => base.device({ name: `Pump ${n}`, com_cumulocity_model_Agent: {} }))
    const group = base.managedObject({ name: 'Pumps', c8y_IsDeviceGroup: {}, assets: devices })
    const trial = base.fork({ clock: createClock({ start: START, realtime: false }) })
    const startDate = new Date(Date.parse(START) + 60_000).toISOString()
    const response = await trial.fetch(new Request(`${trial.baseUrl}/devicecontrol/bulkoperations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ groupId: group, startDate, creationRamp: 10, operationPrototype: { c8y_Restart: {} } }),
    }))
    expect(response.status).toBe(201)
    const before = trial.diff()
    expect(before.tenants.t12345?.operations?.created ?? []).toHaveLength(0)

    trial.advance(60 * 60_000)
    const after = trial.diff()
    expect(after.tenants.t12345?.operations?.created).toHaveLength(2)
    // the base's clock did not move
    expect(clock.now()).toBe(Date.parse(START))
  })

  it('keeps data seeded relative to the start inside "the last 7 days"', async () => {
    const clock = createClock({ start: START })
    const world = createWorld({ clock })
    const pump = world.device({ name: 'Pump' })
    world.seed({ events: [1, 3, 6].map((days) => ({ source: pump, type: 'c8y_Restart', text: 'Restart', time: new Date(Date.parse(START) - days * DAY).toISOString() })) })
    expect(Date.parse(world.db.managedObjects.get(pump)!.creationTime as string) - Date.parse(START)).toBeLessThan(1000)

    // the agent computes "the last 7 days" from the same clock
    const dateFrom = new Date(clock.now() - 7 * DAY).toISOString()
    const response = await world.fetch(new Request(`${world.baseUrl}/event/events?source=${pump}&dateFrom=${dateFrom}&dateTo=${new Date(clock.now()).toISOString()}`))
    expect((await response.json()).events).toHaveLength(3)
  })

  it('lets a fork replace the base clock with its own now', () => {
    const base = createWorld({ clock: createClock({ start: START, realtime: false }) })
    const fork = base.fork({ now: () => Date.parse('2030-01-01T00:00:00Z') })
    expect(fork.db.managedObjects.get(fork.managedObject())!.creationTime).toBe('2030-01-01T00:00:00.000Z')
    expect(() => fork.advance(1)).toThrow(TypeError)
  })
})
