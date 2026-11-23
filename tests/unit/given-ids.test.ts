/**
 * Seeds keep the ids they give (#32): managed objects, devices, binaries,
 * and in `seed()` measurements, events, alarms, operations, retention
 * rules, and audit records. The id sequence jumps past a given id, so the
 * world never hands it out again (also in forks, after a reset, a
 * checkpoint, or a restore).
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'

const TIME = '2026-01-01T00:00:00.000Z'
const json = { 'content-type': 'application/json', 'accept': 'application/json' }

async function get(world: World, path: string) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { headers: { accept: 'application/json' } }))
  return { status: response.status, body: await response.json() as Record<string, any> }
}

/**
 * The id hash of the world's scattered ids (as in src/index.ts).
 * @param n - Counter
 */
function mix(n: number): number {
  let x = Math.imul(n ^ (n >>> 16), 0x45D9F3B)
  x = Math.imul(x ^ (x >>> 16), 0x45D9F3B)
  return (x ^ (x >>> 16)) >>> 0
}

describe('given ids', () => {
  it('are kept for every kind', async () => {
    const world = createWorld()
    expect(world.managedObject({ id: '4711', name: 'Pump' })).toBe('4711')
    expect(world.device({ id: '4712', name: 'Agent', com_cumulocity_model_Agent: {} })).toBe('4712')
    expect(world.binary({ id: '4713', name: 'manual.txt', content: 'read me' })).toBe('4713')
    const result = world.seed({
      measurements: [{ id: '6aef50d7037163db185ec439', source: '4711', type: 'c8y_T', time: TIME, c8y_T: { T: { value: 1, unit: 'C' } } }],
      events: [{ id: '7', source: '4711', type: 'door', time: TIME }],
      // an event and an alarm may have the same id
      alarms: [{ id: '7', source: '4711', type: 'hot', time: TIME }],
      operations: [{ id: '49132520', deviceId: '4712', c8y_Restart: {}, status: 'SUCCESSFUL' }],
      retentionRules: [{ id: '31', dataType: 'EVENT', maximumAge: 30 }],
      auditRecords: [{ id: '8', type: 'User', activity: 'User created', text: 'User bob created', source: 'bob' }],
    })
    expect(result).toMatchObject({ measurements: ['6aef50d7037163db185ec439'], events: ['7'], alarms: ['7'], operations: ['49132520'], retentionRules: ['31'], auditRecords: ['8'] })

    expect((await get(world, '/inventory/managedObjects/4711')).body).toMatchObject({ id: '4711', name: 'Pump' })
    expect((await get(world, '/inventory/managedObjects/4712')).body).toMatchObject({ id: '4712', name: 'Agent', c8y_IsDevice: {} })
    expect(world.db.binaries.content('4713')!.text()).toBe('read me')
    expect((await get(world, '/measurement/measurements?source=4711')).body.measurements.map((item: { id: string }) => item.id)).toEqual(['6aef50d7037163db185ec439'])
    expect((await get(world, '/event/events/7')).body).toMatchObject({ id: '7', type: 'door' })
    expect((await get(world, '/alarm/alarms/7')).body).toMatchObject({ id: '7', type: 'hot' })
    expect((await get(world, '/devicecontrol/operations/49132520')).body).toMatchObject({ id: '49132520', status: 'SUCCESSFUL' })
    expect((await get(world, '/retention/retentions/31')).body).toMatchObject({ id: '31', dataType: 'EVENT' })
    expect((await get(world, '/audit/auditRecords/8')).body).toMatchObject({ id: '8', activity: 'User created' })
  })

  it('reach a service\'s seed', async () => {
    const world = createWorld()
    world.service({ contextPath: 'seeded', seed: { managedObjects: [{ name: 'other' }, { id: '5', name: 'five' }] } })
    expect((await get(world, '/inventory/managedObjects/5')).body).toMatchObject({ id: '5', name: 'five' })
  })

  it('must be digit strings, or 24 lower-case hex characters for a measurement', () => {
    const world = createWorld()
    const pump = world.device()
    expect(() => world.managedObject({ id: 4711 })).toThrow('managedObject(): id must be a string')
    expect(() => world.device({ id: '007' })).toThrow('device(): id \'007\' must be digits without a leading zero')
    expect(() => world.managedObject({ id: '' })).toThrow('managedObject(): id \'\' must be digits without a leading zero')
    expect(() => world.binary({ id: 'abc', name: 'x', content: 'x' })).toThrow('binary(): id \'abc\' must be digits without a leading zero')
    expect(() => world.seed({ events: [{ id: '0', source: pump, type: 't' }] })).toThrow('seed(): invalid event: id \'0\' must be digits without a leading zero')
    expect(() => world.seed({ measurements: [{ id: '6AEF50D7037163DB185EC439', source: pump, type: 't' }] })).toThrow('seed(): invalid measurement: id \'6AEF50D7037163DB185EC439\' must be digits without a leading zero or 24 lower-case hex characters')
    expect(() => world.seed({ alarms: [{ id: '6aef50d7037163db185ec439', source: pump, type: 't' }] })).toThrow(/invalid alarm: id .* must be digits/)
    expect(() => world.seed({ retentionRules: [{ dataType: 'EVENT', maximumAge: 30, id: 31 as unknown as string }] })).toThrow('seed(): invalid retention rule: id must be a string')
    // a measurement may have a digit id too
    expect(world.seed({ measurements: [{ id: '12', source: pump, type: 't' }] }).measurements).toEqual(['12'])
  })

  it('throw when the kind already has them in the tenant', () => {
    const world = createWorld()
    world.managedObject({ id: '50' })
    expect(() => world.device({ id: '50' })).toThrow('device(): managed object 50 already exists')
    // binaries are managed objects
    expect(() => world.binary({ id: '50', name: 'x', content: 'x' })).toThrow('binary(): managed object 50 already exists')
    world.seed({ events: [{ id: '60', source: '50', type: 't' }] })
    expect(() => world.seed({ events: [{ id: '60', source: '50', type: 't' }] })).toThrow('seed(): invalid event: event 60 already exists')
    expect(() => world.seed({ alarms: [{ id: '61', source: '50', type: 'a' }, { id: '61', source: '50', type: 'b' }] })).toThrow('seed(): invalid alarm: alarm 61 already exists')
    // another tenant has its own
    expect(world.managedObject({ id: '50', tenant: 't2' })).toBe('50')
    // a service seed over existing data
    expect(() => world.service({ contextPath: 'again', seed: { managedObjects: [{ id: '50' }] } })).toThrow('fake-c8y: service again: seed for t12345: invalid managed object: managed object 50 already exists')
  })

  it('are all checked before a seed writes anything', () => {
    const world = createWorld({ ids: 'sequential' })
    const pump = world.device()
    expect(() => world.seed({
      events: [{ source: pump, type: 'first' }, { id: '70', source: pump, type: 'second' }],
      alarms: [{ id: '007', source: pump, type: 'a' }],
    })).toThrow('seed(): invalid alarm: id \'007\' must be digits without a leading zero')
    expect(world.db.events.find()).toEqual([])
    expect(world.device()).toBe('2')
    // all given ids move the sequence first: the event without one gets 71
    expect(world.seed({ events: [{ source: pump, type: 'first' }, { id: '70', source: pump, type: 'second' }] }).events).toEqual(['71', '70'])
  })

  it('are never handed out again, with sequential ids', () => {
    const world = createWorld({ ids: 'sequential' })
    world.managedObject({ id: '50' })
    expect(world.managedObject({ name: 'A' })).toBe('51')
    // a smaller id does not move the sequence back
    world.managedObject({ id: '3' })
    expect(world.seed({ events: [{ source: '50', type: 't' }] }).events).toEqual(['52'])
    // an id the sequence cannot reach leaves it alone
    world.managedObject({ id: '99999999999999999999' })
    expect(world.managedObject()).toBe('53')
  })

  it('are never handed out again, with scattered ids', () => {
    // ids a plain world hands out at counters 1, 2, and 3
    const other = createWorld()
    const managedObject = other.managedObject()
    const event = other.seed({ events: [{ source: managedObject, type: 't' }] }).events[0]!
    const measurement = other.seed({ measurements: [{ source: managedObject, type: 't', time: TIME }] }).measurements[0]!
    expect(event).toBe('100002')

    const next = (world: World) => world.seed({ events: [{ source: world.managedObject({ id: '1' }), type: 't' }] }).events[0]
    const world = createWorld()
    world.seed({ measurements: [{ id: measurement, source: world.managedObject({ id: '2' }), type: 't', time: TIME }] })
    expect(next(world)).toBe('100004')
    // a document id: its counter behind 100000
    const documents = createWorld()
    documents.managedObject({ id: '100050' })
    expect(next(documents)).toBe('100051')
    // every digit id of six or more digits is one: a managed object's too
    const objects = createWorld()
    objects.managedObject({ id: managedObject })
    expect(next(objects)).toBe(String(Number(managedObject) + 1))

    // a managed object id whose counter only the prefix decodes (the whole
    // id is too big for a document's): only with the prefix of its counter
    const n = 2 ** 31 - 5
    const prefix = 10 + (mix(n) % 90)
    const big = createWorld()
    big.managedObject({ id: `${prefix}${100_000 + n}` })
    expect(next(big)).toBe(String(100_000 + n + 1))
    const wrong = createWorld()
    wrong.managedObject({ id: `${prefix === 10 ? 11 : 10}${100_000 + n}` })
    expect(next(wrong)).toBe('100001')
  })

  it('stay taken in forks, after resets, checkpoints, and restores', () => {
    const base = createWorld({ ids: 'sequential' })
    base.managedObject({ id: '50' })
    const fork = base.fork()
    expect(fork.managedObject()).toBe('51')
    const forkOfFork = (fork.managedObject({ id: '80' }), fork.fork())
    expect(forkOfFork.managedObject()).toBe('81')

    // a fork's reset goes back to the base's sequence: a replay gets the same ids
    const replay = base.fork()
    const first = [replay.managedObject({ id: '60' }), replay.managedObject()]
    replay.reset()
    expect([replay.managedObject({ id: '60' }), replay.managedObject()]).toEqual(first)
    expect(first).toEqual(['60', '61'])

    const world = createWorld({ ids: 'sequential' })
    const startup = world.checkpoint()
    world.managedObject({ id: '90' })
    const snapshot = world.snapshot()
    world.reset({ to: startup })
    expect(world.managedObject()).toBe('1')
    world.restore(snapshot)
    expect(world.managedObject()).toBe('91')

    const checkpointed = createWorld({ ids: 'sequential' })
    checkpointed.managedObject({ id: '40' })
    const seeded = checkpointed.checkpoint()
    checkpointed.managedObject()
    checkpointed.reset({ to: seeded })
    expect(checkpointed.managedObject()).toBe('41')
  })

  it('do not move the sequence when a frozen world refuses them', () => {
    const base = createWorld({ ids: 'sequential' })
    base.managedObject({ id: '50' })
    base.fork()
    expect(() => base.managedObject({ id: '900' })).toThrow('this world is frozen')
    expect(() => base.seed({ events: [{ id: '800', source: '50', type: 't', time: TIME }] })).toThrow('this world is frozen')
    expect(base.fork().managedObject({ name: 'x' })).toBe('51')
  })

  it('throw for an alarm that would merge into an open one', () => {
    const world = createWorld({ ids: 'sequential' })
    world.managedObject({ id: '50' })
    world.seed({ alarms: [{ id: '100', source: '50', type: 'hot', time: TIME }] })
    // the open alarm is stored
    expect(() => world.seed({ alarms: [{ id: '200', source: '50', type: 'hot', time: TIME }] })).toThrow('seed(): invalid alarm: id 200 would merge into open alarm 100')
    // the open alarm comes earlier in the list, with or without an id
    const before = world.snapshot()
    expect(() => world.seed({ events: [{ id: '300', source: '50', type: 'e', time: TIME }], alarms: [{ id: '201', source: '50', type: 'cold', time: TIME }, { id: '202', source: '50', type: 'cold', time: TIME }] })).toThrow('seed(): invalid alarm: id 202 would merge into open alarm 201')
    expect(() => world.seed({ alarms: [{ source: '50', type: 'wet', time: TIME }, { id: '203', source: '50', type: 'wet', time: TIME }] })).toThrow('seed(): invalid alarm: id 203 would merge into the open alarm of source 50 and type wet')
    // nothing stored
    expect(world.snapshot()).toEqual(before)
    // a CLEARED one does not merge, nor does one after a CLEARED one
    expect(world.seed({ alarms: [{ id: '204', source: '50', type: 'hot', status: 'CLEARED', time: TIME }, { source: '50', type: 'dry', status: 'CLEARED', time: TIME }, { id: '205', source: '50', type: 'dry', time: TIME }] }).alarms).toEqual(['204', '206', '205'])
    // an alarm without an id still merges
    expect(world.seed({ alarms: [{ source: '50', type: 'hot', time: TIME }] }).alarms).toEqual(['100'])
    expect(world.db.alarms.get('100')).toMatchObject({ count: 2 })
  })

  it('are still rejected in requests', async () => {
    const world = createWorld()
    const pump = world.device()
    const post = async (path: string, body: Record<string, unknown>) => (await world.fetch(new Request(`${world.baseUrl}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) }))).status
    expect(await post('/inventory/managedObjects', { id: '4711', name: 'x' })).toBe(422)
    expect(await post('/event/events', { id: '4711', source: { id: pump }, type: 't', text: 't', time: TIME })).toBe(422)
    expect(await post('/measurement/measurements', { id: '4711', source: { id: pump }, type: 't', time: TIME })).toBe(422)
    expect(await post('/retention/retentions', { id: '4711', maximumAge: 1 })).toBe(422)
  })
})
