/**
 * `world.seed()` returns the ids it created, per list and in input order,
 * and they are the ids the API and `world.db` use.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createWorld } from '../../src'
import type { C8ySeed, World } from '../../src'

const START = Date.parse('2026-03-01T00:00:00.000Z')

async function get(world: World, path: string) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { headers: { accept: 'application/json' } }))
  return { status: response.status, body: await response.json() as Record<string, any> }
}

function newWorld(): World {
  let time = START
  return createWorld({ now: () => (time += 1000) })
}

/**
 * One seed with two items in every list that returns ids.
 * @param pump - Device id
 */
function fullSeed(pump: string): C8ySeed {
  return {
    roles: ['ROLE_CUSTOM_A', 'ROLE_CUSTOM_B'],
    inventoryRoles: [{ name: 'Pump reader' }, { name: 'Pump writer' }],
    groups: [{ name: 'operators' }, { name: 'viewers' }],
    users: [{ userName: 'anna' }, { userName: 'bob' }],
    measurements: [
      { source: pump, type: 'c8y_Temperature', c8y_Temperature: { T: { value: 1, unit: 'C' } } },
      { source: pump, type: 'c8y_Temperature', c8y_Temperature: { T: { value: 2, unit: 'C' } } },
    ],
    events: [{ source: pump, type: 'first' }, { source: pump, type: 'second' }],
    alarms: [{ source: pump, type: 'overheat' }, { source: pump, type: 'leak' }],
    operations: [{ deviceId: pump, description: 'first' }, { deviceId: pump, description: 'second', status: 'SUCCESSFUL' }],
    newDeviceRequests: [{ id: 'SN-1' }, { id: 'SN-2' }],
    retentionRules: [{ maximumAge: 10 }, { maximumAge: 20 }],
    auditRecords: [
      { type: 'User', activity: 'User created', text: 'first', source: 'anna' },
      { type: 'User', activity: 'User created', text: 'second', source: 'bob' },
    ],
    applications: [{ name: 'first-app', type: 'HOSTED' }, { name: 'second-app', type: 'HOSTED' }],
  }
}

describe('world.seed() result', () => {
  it('returns the ids per list, in input order, matching world.db and GET by id', async () => {
    const world = newWorld()
    const pump = world.device({ name: 'Pump 7', com_cumulocity_model_Agent: {} })
    const result = world.seed(fullSeed(pump))

    expect(result.roles).toEqual(['ROLE_CUSTOM_A', 'ROLE_CUSTOM_B'])
    expect(result.users).toEqual(['anna', 'bob'])
    expect(result.newDeviceRequests).toEqual(['SN-1', 'SN-2'])

    // the platform answers GET /measurement/measurements/{id} with 405, so a measurement is found in the list
    const listed = async (path: string, list: string, id: string) => {
      const response = await get(world, path)
      return { status: response.status, body: (response.body[list] as Array<Record<string, any>>).find((item) => item.id === id) ?? {} }
    }
    const checks: Array<{ ids: string[] | undefined, db: (id: string) => Record<string, any> | undefined, path: (id: string) => string, read?: (id: string) => Promise<{ status: number, body: Record<string, any> }>, field: string, values: unknown[] }> = [
      { ids: result.roles, db: (id) => world.db.roles.get(id), path: (id) => `/user/roles/${id}`, field: 'name', values: ['ROLE_CUSTOM_A', 'ROLE_CUSTOM_B'] },
      { ids: result.inventoryRoles, db: (id) => world.db.inventoryRoles.get(id), path: (id) => `/user/inventoryroles/${id}`, field: 'name', values: ['Pump reader', 'Pump writer'] },
      { ids: result.groups, db: (id) => world.db.groups.get(id), path: (id) => `/user/${world.tenant}/groups/${id}`, field: 'name', values: ['operators', 'viewers'] },
      { ids: result.users, db: (id) => world.db.users.get(id), path: (id) => `/user/${world.tenant}/users/${id}`, field: 'userName', values: ['anna', 'bob'] },
      { ids: result.measurements, db: (id) => world.db.measurements.get(id), path: () => `/measurement/measurements?source=${pump}`, read: (id) => listed(`/measurement/measurements?source=${pump}`, 'measurements', id), field: 'c8y_Temperature', values: [{ T: { value: 1, unit: 'C' } }, { T: { value: 2, unit: 'C' } }] },
      { ids: result.events, db: (id) => world.db.events.get(id), path: (id) => `/event/events/${id}`, field: 'type', values: ['first', 'second'] },
      { ids: result.alarms, db: (id) => world.db.alarms.get(id), path: (id) => `/alarm/alarms/${id}`, field: 'type', values: ['overheat', 'leak'] },
      { ids: result.operations, db: (id) => world.db.operations.get(id), path: (id) => `/devicecontrol/operations/${id}`, field: 'description', values: ['first', 'second'] },
      { ids: result.newDeviceRequests, db: (id) => world.db.newDeviceRequests.get(id), path: (id) => `/devicecontrol/newDeviceRequests/${id}`, field: 'id', values: ['SN-1', 'SN-2'] },
      { ids: result.retentionRules, db: (id) => world.db.retentionRules.get(id), path: (id) => `/retention/retentions/${id}`, field: 'maximumAge', values: [10, 20] },
      { ids: result.auditRecords, db: (id) => world.db.auditRecords.get(id), path: (id) => `/audit/auditRecords/${id}`, field: 'text', values: ['first', 'second'] },
      { ids: result.applications, db: (id) => world.db.applications.get(id), path: (id) => `/application/applications/${id}`, field: 'name', values: ['first-app', 'second-app'] },
    ]
    for (const { ids, db, path, read = (id: string) => get(world, path(id)), field, values } of checks) {
      expect(ids).toHaveLength(values.length)
      for (const [index, id] of ids!.entries()) {
        expect(db(id)?.[field]).toEqual(values[index])
        const response = await read(id)
        expect(response.status, path(id)).toBe(200)
        expect(response.body[field]).toEqual(values[index])
      }
    }
  })

  it('has entries only for the lists the seed has, also for empty ones', () => {
    const world = newWorld()
    expect(world.seed({ events: [], serviceState: [], usageStatistics: [], trustedCertificates: [{ fingerprint: 'ab' }] })).toEqual({ events: [] })
  })

  it('keeps the input order when one call creates many items', () => {
    const world = newWorld()
    const pump = world.device()
    const types = Array.from({ length: 50 }, (_, index) => `type_${(index * 37) % 50}`)
    const { events } = world.seed({ events: types.map((type) => ({ source: pump, type })) })
    expect(events!.map((id) => world.db.events.get(id)!.type)).toEqual(types)
  })

  it('returns the id of a replaced application', () => {
    const world = newWorld()
    const [first] = world.seed({ applications: [{ name: 'dashboard', type: 'HOSTED' }] }).applications!
    const { applications } = world.seed({ applications: [{ name: 'other', type: 'HOSTED' }, { name: 'dashboard', type: 'HOSTED', key: 'new-key' }] })
    expect(applications![1]).toBe(first)
    expect(world.db.applications.get(first!)!.key).toBe('new-key')
    expect(applications![0]).not.toBe(first)
  })

  it('returns the id range of each measurement generator', async () => {
    const world = newWorld()
    const pump = world.device()
    const from = new Date(START - 10 * 60_000).toISOString()
    const to = new Date(START).toISOString()
    const series = [{ fragment: 'c8y_Temperature', series: 'T', value: 20 }]
    const { measurementGenerators } = world.seed({
      measurementGenerators: [
        { source: pump, type: 'a', from, to, interval: '1m', series },
        { source: pump, type: 'b', from, to, interval: '1m', series },
      ],
    })
    const [a, b] = measurementGenerators!
    const ofType = (type: string) => world.db.measurements.find({ source: pump, type }).map((document) => String(document.id)).sort()
    expect([ofType('a')[0], ofType('a').at(-1)]).toEqual([a!.firstId, a!.lastId])
    expect([ofType('b')[0], ofType('b').at(-1)]).toEqual([b!.firstId, b!.lastId])
    expect(a!.lastId < b!.firstId).toBe(true)
    expect(world.db.measurements.get(a!.firstId)!.time).toBe(from)
    const { body } = await get(world, `/measurement/measurements?source=${pump}&type=a&dateFrom=${from}&dateTo=${to}&revert=false&pageSize=1`)
    expect(body.measurements[0].id).toBe(a!.firstId)
  })

  it('works on a fork, keeps the base untouched, and throws on the frozen base as before', async () => {
    const base = newWorld()
    const pump = base.device({ name: 'Pump 7', com_cumulocity_model_Agent: {} })
    const fork = base.fork()
    const result = fork.seed(fullSeed(pump))
    expect(fork.db.alarms.get(result.alarms![0]!)!.type).toBe('overheat')
    expect((await get(fork, `/alarm/alarms/${result.alarms![1]}`)).body.type).toBe('leak')
    expect(base.db.alarms.get(result.alarms![0]!)).toBeUndefined()
    expect(() => base.seed({ alarms: [{ source: pump, type: 'late' }] })).toThrow(/frozen/)
  })

  it('gives the same ids on forks of the same base', () => {
    const base = newWorld()
    const pump = base.device({ com_cumulocity_model_Agent: {} })
    base.seed({ events: [{ source: pump, type: 'base' }] })
    const first = base.fork().seed(fullSeed(pump))
    const second = base.fork().seed(fullSeed(pump))
    expect(second).toEqual(first)
  })
  it('types the lists the seed passes as required arrays, so they destructure', () => {
    const world = newWorld()
    const pump = world.device({ name: 'Pump' })
    const { alarms: [overheat], events } = world.seed({ alarms: [{ source: pump, type: 'overheat' }], events: [] })
    expectTypeOf(events).toEqualTypeOf<string[]>()
    expect(world.db.alarms.get(overheat!)?.type).toBe('overheat')
    const seed: C8ySeed = { alarms: [{ source: pump, type: 'later' }] }
    expectTypeOf(world.seed(seed).alarms).toEqualTypeOf<string[] | undefined>()
  })
})
