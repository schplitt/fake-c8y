/**
 * Request variants the spec documents for writes: the processing mode
 * (`X-Cumulocity-Processing-Mode`), method emulation (`X-HTTP-METHOD`), the
 * bulk create of managed objects, and `withDeviceUser` on a delete that would
 * leave objects of the device user without an owner. None of these answers is
 * verified on a tenant; the tests pin what the fake does.
 */
import { describe, expect, it } from 'vitest'
import { Collection } from '../../src/collection'
import { createClock, createWorld } from '../../src'
import type { World } from '../../src'
import { createFakeWebSocket } from '../../src/realtime-entry'

const JSON_HEADERS = { 'accept': 'application/json', 'content-type': 'application/json' }
const COLLECTION = 'application/vnd.com.nsn.cumulocity.managedobjectcollection+json'

async function call(world: World, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, {
    method,
    headers: { ...JSON_HEADERS, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString()

/**
 * A world whose scheduled callbacks run only when `run()` is called.
 */
function manualWorld() {
  const queue: Array<() => void> = []
  const world = createWorld({ schedule: (callback) => queue.push(callback) })
  const run = () => {
    while (queue.length > 0) {
      queue.shift()!()
    }
  }
  return { world, run }
}

describe('processing mode', () => {
  it('validates and answers TRANSIENT and CEP writes like persistent ones and stores nothing', async () => {
    const world = createWorld()
    const device = world.device({ name: 'Pump', c8y_RequiredAvailability: { responseInterval: 10 } })
    world.seed({ alarms: [{ source: device, type: 'seeded', severity: 'MAJOR' }] })
    const before = world.snapshot()

    for (const mode of ['TRANSIENT', 'CEP']) {
      const headers = { 'X-Cumulocity-Processing-Mode': mode }
      const measurement = await call(world, 'POST', '/measurement/measurements', { source: { id: device }, type: 't', time: at(0), c8y_T: { T: { value: 1 } } }, headers)
      expect(measurement.status).toBe(201)
      expect(measurement.body).toMatchObject({ id: expect.any(String), type: 't' })
      expect((await call(world, 'POST', '/event/events', { source: { id: device }, type: 't', text: 'x', time: at(0) }, headers)).status).toBe(201)
      expect((await call(world, 'POST', '/alarm/alarms', { source: { id: device }, type: 'new', text: 'x', severity: 'CRITICAL', time: at(0) }, headers)).status).toBe(201)
      expect((await call(world, 'POST', '/inventory/managedObjects', { name: 'transient' }, headers)).status).toBe(201)
      const updated = await call(world, 'PUT', `/inventory/managedObjects/${device}`, { name: 'Renamed', c8y_RequiredAvailability: null }, headers)
      expect(updated.body).toMatchObject({ name: 'Renamed' })
      // validation still answers
      expect((await call(world, 'POST', '/measurement/measurements', { source: { id: device }, type: 't' }, headers)).status).toBe(422)
    }

    // the ids handed out stay used
    expect({ ...world.snapshot(), nextId: before.nextId }).toEqual(before)
    expect(world.calls.every((recorded) => recorded.writes === undefined)).toBe(true)
  })

  it('leaves availability monitoring as it was', async () => {
    const worlds = [0, 1].map(() => {
      const clock = createClock({ start: Date.UTC(2026, 0, 1, 10), realtime: false })
      const world = createWorld({ clock })
      const device = world.device({ name: 'Pump', c8y_RequiredAvailability: { responseInterval: 1 } })
      return { world, device }
    })
    worlds[0]!.world.advance(30 * 60_000)
    worlds[1]!.world.advance(30 * 60_000)
    await call(worlds[1]!.world, 'POST', '/measurement/measurements', { source: { id: worlds[1]!.device }, type: 't', time: at(30), c8y_T: { T: { value: 1 } } }, { 'X-Cumulocity-Processing-Mode': 'TRANSIENT' })
    for (const { world } of worlds) {
      world.advance(30 * 60_000)
    }
    const [plain, transient] = worlds.map(({ world }) => world.snapshot())
    expect({ ...transient!, nextId: plain!.nextId }).toEqual(plain)
  })

  // two worlds in lockstep, the transient request only in the second: by
  // every minute both must hold the same data
  async function lockstep(fork: boolean, transientAt: number, transient: (world: World, device: string) => Promise<unknown>) {
    const worlds = [0, 1].map(() => {
      const clock = createClock({ start: Date.UTC(2026, 0, 1, 10), realtime: false })
      const world = createWorld({ clock })
      const device = world.device({ name: 'Pump', c8y_RequiredAvailability: { responseInterval: 5 } })
      return { world: fork ? world.fork() : world, device }
    })
    for (let minute = 1; minute <= 30; minute++) {
      for (const { world } of worlds) {
        world.advance(60_000)
      }
      if (minute === transientAt) {
        await transient(worlds[1]!.world, worlds[1]!.device)
      }
      // ids differ (the transient request used some), the state must not
      const [plain, other] = worlds.map(({ world, device }) => {
        const { c8y_Availability, c8y_ActiveAlarmsStatus } = world.db.managedObjects.get(device)!
        const alarms = world.db.alarms.find().map(({ type, status, severity, time, count }) => ({ type, status, severity, time, count }))
        return { c8y_Availability, c8y_ActiveAlarmsStatus, alarms, audits: world.db.auditRecords.find().length }
      })
      expect(other, `minute ${minute}`).toEqual(plain)
    }
    expect(worlds[0]!.world.db.alarms.find({ type: 'c8y_UnavailabilityAlarm' })).toHaveLength(1)
  }
  const transientHeaders = { 'X-Cumulocity-Processing-Mode': 'TRANSIENT' }

  for (const fork of [false, true]) {
    describe(fork ? 'availability queue on a fork' : 'availability queue', () => {
      it('keeps the pending unavailability alarm of an UNAVAILABLE device', async () => {
        // UNAVAILABLE from minute 6, the alarm comes at minute 10
        await lockstep(fork, 8, (world, device) => call(world, 'POST', '/measurement/measurements', { source: { id: device }, type: 't', time: at(8), c8y_T: { T: { value: 1 } } }, transientHeaders))
      })

      it('does not reschedule from the discarded lastMessage', async () => {
        await lockstep(fork, 3, (world, device) => call(world, 'POST', '/event/events', { source: { id: device }, type: 't', text: 'x', time: at(3) }, transientHeaders))
      })

      it('keeps monitoring a device after a transient PUT that removes its required availability', async () => {
        await lockstep(fork, 2, (world, device) => call(world, 'PUT', `/inventory/managedObjects/${device}`, { c8y_RequiredAvailability: null }, transientHeaders))
      })
    })
  }

  it('stores QUIESCENT writes, and deletes nothing with TRANSIENT', async () => {
    const world = createWorld()
    const device = world.device({ name: 'Pump' })
    const headers = { 'X-Cumulocity-Processing-Mode': 'QUIESCENT' }
    expect((await call(world, 'POST', '/event/events', { source: { id: device }, type: 't', text: 'x', time: at(0) }, headers)).status).toBe(201)
    expect(world.db.events.find()).toHaveLength(1)
    // verified: a TRANSIENT delete answers 204 and deletes nothing
    expect((await call(world, 'DELETE', `/inventory/managedObjects/${device}`, undefined, { 'X-Cumulocity-Processing-Mode': 'TRANSIENT' })).status).toBe(204)
    expect((await call(world, 'DELETE', `/event/events?source=${device}`, undefined, { 'X-Cumulocity-Processing-Mode': 'TRANSIENT' })).status).toBe(204)
    expect(world.db.managedObjects.find()).toHaveLength(1)
    expect(world.db.events.find()).toHaveLength(1)
  })

  it('works on a fork: nothing shows in its diff', async () => {
    const base = createWorld()
    const device = base.device({ name: 'Pump' })
    const fork = base.fork()
    await call(fork, 'POST', '/measurement/measurements', { source: { id: device }, type: 't', time: at(0), c8y_T: { T: { value: 1 } } }, { 'X-Cumulocity-Processing-Mode': 'TRANSIENT' })
    await call(fork, 'PUT', `/inventory/managedObjects/${device}`, { name: 'Renamed' }, { 'X-Cumulocity-Processing-Mode': 'CEP' })
    expect(fork.diff()).toEqual(base.diff(base.snapshot()))
    expect((await call(fork, 'GET', `/inventory/managedObjects/${device}`)).body.name).toBe('Pump')
  })

  it('notifies TRANSIENT writes in real time, not CEP and QUIESCENT ones', async () => {
    const { world, run } = manualWorld()
    const device = world.device({ name: 'Pump' })
    await call(world, 'POST', '/notification2/subscriptions', { context: 'tenant', subscription: 'all', subscriptionFilter: { apis: ['events'] } })
    const token = (await call(world, 'POST', '/notification2/token', { subscription: 'all', subscriber: 's' })).body.token as string
    const WebSocket = createFakeWebSocket(world.realtime)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    const received: string[] = []
    socket.on('message', (text: string) => received.push(text))
    run()

    for (const mode of ['TRANSIENT', 'CEP', 'QUIESCENT', 'PERSISTENT']) {
      await call(world, 'POST', '/event/events', { source: { id: device }, type: 't', text: `text ${mode}`, time: at(0) }, { 'X-Cumulocity-Processing-Mode': mode })
    }
    run()
    expect(['TRANSIENT', 'CEP', 'QUIESCENT', 'PERSISTENT'].filter((mode) => received.some((frame) => frame.includes(`text ${mode}`)))).toEqual(['TRANSIENT', 'PERSISTENT'])
  })
})

describe('collection journal', () => {
  it('rolls back sets and deletes with their positions, also on a fork', () => {
    const plain = new Collection<number>([['a', 1], ['b', 2], ['c', 3]])
    const base = new Collection<number>([['a', 1], ['b', 2], ['c', 3]])
    base.freeze()
    for (const collection of [plain, base.fork()]) {
      collection.set('d', 4)
      collection.journal()
      collection.set('b', 20)
      collection.delete('a')
      collection.set('a', 10)
      collection.set('e', 5)
      collection.delete('d')
      collection.rollback()
      expect([...collection]).toEqual([['a', 1], ['b', 2], ['c', 3], ['d', 4]])
      collection.set('f', 6)
      expect([...collection.keys()]).toEqual(['a', 'b', 'c', 'd', 'f'])
      expect(collection.position('d')! < collection.position('f')!).toBe(true)
    }
  })

  it('keeps group indexes and sort orders right', () => {
    const byParity = (value: number) => (value % 2 === 0 ? 'even' : 'odd')
    const byValue = (value: number) => value
    const collection = new Collection<number>([['a', 1], ['b', 2], ['c', 3]])
    const groups = collection.groupedBy(byParity)
    collection.sortedBy(byValue)
    collection.journal()
    collection.set('a', 4)
    collection.delete('c')
    collection.set('x', 5)
    collection.rollback()
    expect([groups('odd'), groups('even')]).toEqual([['a', 'c'], ['b']])
    expect(collection.sortedBy(byValue).slice(0, 10).map((entry) => entry)).toEqual([1, 2, 3])
  })
})

describe('collection journal, randomized', () => {
  interface Item { n: number }
  // module-level functions: they are the index cache keys
  const byParity = (item: Item) => (item.n % 3 === 0 ? undefined : `g${item.n % 3}`)
  const byN = (item: Item) => item.n
  const KEYS = Array.from({ length: 10 }, (_, index) => `k${index}`)

  // mulberry32: a small seeded PRNG, so every run checks the same histories
  function prng(seed: number) {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6D2B79F5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  type Op = (collection: Collection<Item>) => void
  function randomOp(random: () => number): Op {
    const key = KEYS[Math.floor(random() * KEYS.length)]!
    const n = Math.floor(random() * 6)
    const kind = random()
    if (kind < 0.45) {
      return (collection) => collection.set(key, { n })
    }
    if (kind < 0.75) {
      return (collection) => collection.delete(key)
    }
    if (kind < 0.9) {
      return (collection) => collection.update(key, (draft) => {
        draft.n = n
      })
    }
    // read an index (builds it, or uses the one there)
    return (collection) => kind < 0.95 ? collection.groupedBy(byParity) : collection.sortedBy(byN).slice()
  }

  function state(collection: Collection<Item>, random: () => number) {
    const groups = collection.groupedBy(byParity)
    const subset = KEYS.filter(() => random() < 0.5)
    const touched = collection.touched()
    return {
      entries: [...collection],
      size: collection.size,
      has: KEYS.map((key) => collection.has(key)),
      positions: KEYS.map((key) => collection.position(key)),
      inOrder: collection.inOrder([...subset].reverse()),
      groups: ['g1', 'g2'].map((group) => groups(group)),
      sorted: collection.sortedBy(byN).slice(),
      reversed: collection.sortedBy(byN, { reverse: true }).slice(),
      sortedPage: collection.sortedBy(byN).slice(1, 3),
      touched: { before: touched.before, after: touched.after, recreated: [...touched.recreated].sort() },
      ownKeys: [...collection.ownKeys()].sort(),
    }
  }

  it('leaves a collection as a twin without the journaled writes, on plain collections and forks', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = prng(seed)
      const fork = seed % 2 === 0
      const ops = (count: number) => Array.from({ length: count }, () => randomOp(random))
      let subject: Collection<Item>
      let twin: Collection<Item>
      if (fork) {
        const base = new Collection<Item>()
        for (const op of ops(Math.floor(random() * 12))) {
          op(base)
        }
        if (random() < 0.5) {
          base.groupedBy(byParity)
          base.sortedBy(byN)
        }
        base.freeze()
        subject = base.fork()
        twin = base.fork()
      } else {
        subject = new Collection<Item>()
        twin = new Collection<Item>()
      }
      const indexFirst = random() < 0.5
      if (indexFirst) {
        for (const collection of [subject, twin]) {
          collection.groupedBy(byParity)
          collection.sortedBy(byN)
        }
      }
      const before = ops(Math.floor(random() * 10))
      const journaled = ops(1 + Math.floor(random() * 10))
      const after = ops(Math.floor(random() * 6))
      for (const op of before) {
        op(subject)
        op(twin)
      }
      subject.journal()
      for (const op of journaled) {
        op(subject)
      }
      subject.rollback()
      const label = `seed ${seed}`
      const check = (stateSeed: number) => expect(state(subject, prng(stateSeed)), label).toEqual(state(twin, prng(stateSeed)))
      check(seed)
      for (const op of after) {
        op(subject)
        op(twin)
      }
      check(seed + 1)
    }
  })
})

describe('X-HTTP-METHOD', () => {
  it('runs a POST as PUT or DELETE', async () => {
    const world = createWorld()
    const device = world.device({ name: 'Pump' })
    const updated = await call(world, 'POST', `/inventory/managedObjects/${device}`, { name: 'Renamed' }, { 'X-HTTP-METHOD': 'PUT' })
    expect([updated.status, updated.body.name]).toEqual([200, 'Renamed'])
    expect(world.calls.at(-1)!.method).toBe('PUT')
    expect((await call(world, 'POST', `/inventory/managedObjects/${device}`, undefined, { 'X-HTTP-METHOD': 'delete' })).status).toBe(204)
    expect(world.db.managedObjects.find()).toHaveLength(0)
  })

  it('reaches overrides with the named method', async () => {
    const world = createWorld()
    world.override('PUT /inventory/managedObjects/:id', (request, ctx) => ({ method: request.method, id: ctx.params.id }))
    expect((await call(world, 'POST', '/inventory/managedObjects/42', {}, { 'X-HTTP-METHOD': 'PUT' })).body).toEqual({ method: 'PUT', id: '42' })
  })
})

describe('bulk create of managed objects', () => {
  it('creates every item in request order', async () => {
    const world = createWorld()
    const created = await call(world, 'POST', '/inventory/managedObjects', { managedObjects: [{ name: 'a', externalIds: [{ type: 'c8y_Serial', externalId: 'A' }] }, { name: 'b', c8y_BatchId_x: { index: 1 } }] }, { 'content-type': COLLECTION, 'accept': COLLECTION })
    expect(created.status).toBe(200)
    expect(created.body.managedObjects.map((item: { name: string }) => item.name)).toEqual(['a', 'b'])
    expect(created.body.managedObjects[1]).not.toHaveProperty('c8y_BatchId_x')
    expect(world.db.externalIds.find()).toEqual([expect.objectContaining({ externalId: 'A', managedObjectId: created.body.managedObjects[0].id })])
  })

  it('checks everything before it creates anything', async () => {
    const world = createWorld()
    world.device({ name: 'bound', externalIds: { c8y_Serial: 'B' } })
    const failures: Array<[unknown, number, Record<string, unknown>]> = [
      [{ managedObjects: [] }, 422, { error: 'undefined/validationError' }],
      [{}, 422, { error: 'undefined/validationError' }],
      [{ managedObjects: Array.from({ length: 51 }, () => ({ name: 'x' })) }, 422, { error: 'undefined/validationError' }],
      [{ managedObjects: [{ name: 'ok' }, { name: 'x', lastUpdated: at(0) }] }, 422, { bulkRequest: { failedIndex: 1 } }],
      [{ managedObjects: [{ name: 'ok' }, { name: 'x', externalIds: [{ type: 'c8y_Serial', externalId: 'B' }] }] }, 409, { error: 'identity/Duplicate', bulkRequest: { failedIndex: 1 } }],
      [{ managedObjects: [{ name: 'x', externalIds: [{ type: 'c8y_Serial', externalId: 'C' }] }, { name: 'y', externalIds: [{ type: 'c8y_Serial', externalId: 'C' }] }] }, 409, { bulkRequest: { failedIndex: 1 } }],
      [{ managedObjects: {} }, 400, { error: 'Failed to parse JSON string' }],
      // elements that are no objects
      [{ managedObjects: [null] }, 500, { error: 'general/internalError', message: 'Cannot invoke "Object.getClass()" because "source" is null' }],
      // a null among two or more items: the collection's external id check
      ...[[{ name: 'ok' }, null], [null, null], [{ name: 'ok' }, null, { name: 'ok' }], [null, { id: '1' }]].map((managedObjects): [unknown, number, Record<string, unknown>] => [{ managedObjects }, 422, { error: 'undefined/validationError', message: 'HV000028: Unexpected exception during isValid call. : Cannot invoke "com.cumulocity.rest.representation.inventory.ManagedObjectRepresentation.getExternalIds()" because "managedObject" is null' }]),
      [{ managedObjects: [{ name: 'ok' }, { id: '1' }] }, 422, { message: 'post.managedObjectCollection.managedObjects[1].id: is not allowed here', bulkRequest: { failedIndex: 1 } }],
      ...[['x'], [{ name: 'ok' }, 5], [{ name: 'ok' }, []], [null, 'x'], [{ name: 'ok' }, true]].map((managedObjects): [unknown, number, Record<string, unknown>] => [{ managedObjects }, 400, { error: 'Failed to parse JSON string' }]),
      [{ managedObjects: [...Array.from({ length: 51 }, () => ({ name: 'x' })), 'x'] }, 400, { error: 'Failed to parse JSON string' }],
    ]
    for (const [body, status, error] of failures) {
      const failed = await call(world, 'POST', '/inventory/managedObjects', body, { 'content-type': COLLECTION })
      expect(failed.status, JSON.stringify(body)).toBe(status)
      expect(failed.body, JSON.stringify(body)).toMatchObject(error)
      if (!('bulkRequest' in error)) {
        expect(failed.body).not.toHaveProperty('bulkRequest')
      }
    }
    expect(world.db.managedObjects.find().map((item) => item.name)).toEqual(['bound'])
  })
})

describe('withDeviceUser', () => {
  it('answers 409 before deleting anything when the device user owns other objects', async () => {
    const world = createWorld()
    world.seed({ users: [{ userName: 'device_X', email: 'x@example.com' }] })
    const device = world.device({ name: 'D', owner: 'device_X' })
    const child = world.device({ name: 'child', owner: 'device_X' })
    world.managedObject({ name: 'other', owner: 'device_X' })
    await call(world, 'POST', `/inventory/managedObjects/${device}/childDevices`, { managedObject: { id: child } })

    const conflict = await call(world, 'DELETE', `/inventory/managedObjects/${device}?withDeviceUser=true&cascade=true`)
    expect(conflict.status).toBe(409)
    expect(conflict.body).toMatchObject({ error: 'inventory/Update Conflict', message: 'Can\'t delete user because it is used by another managed object' })
    expect(world.db.managedObjects.find()).toHaveLength(3)

    // objects the delete takes along do not count
    const other = world.db.managedObjects.find({ name: 'other' })[0]!
    expect((await call(world, 'DELETE', `/inventory/managedObjects/${other.id}`)).status).toBe(204)
    expect((await call(world, 'DELETE', `/inventory/managedObjects/${device}?withDeviceUser=true&cascade=true`)).status).toBe(204)
    expect(world.db.managedObjects.find()).toHaveLength(0)
    expect((await call(world, 'GET', `/user/${world.tenant}/users/device_X`)).status).toBe(404)
  })
})
