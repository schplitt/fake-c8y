/**
 * Forks: copy-on-write worlds on top of a frozen base. A fork must answer
 * every request exactly like a plain world with the same history, stay
 * isolated from other forks and from its base, and report its changes
 * (`diff()`) like a snapshot diff.
 */
import { describe, expect, it } from 'vitest'
import { createWorld, diffSnapshots } from '../../src'
import { Collection } from '../../src/collection'
import type { CollectionDiff, World, WorldDiff, WorldOptions } from '../../src'
import { seedBase } from '../contract/fork-base'
import { parentIndex } from '../../src/api/inventory'
import type { Relations, TenantData } from '../../src/store'

/**
 * A binary upload body (`POST /inventory/binaries`).
 * @param content - File content
 */
function binaryUpload(content: Uint8Array<ArrayBuffer> | string): FormData {
  const form = new FormData()
  form.append('object', JSON.stringify({ name: 'upload', type: 'application/octet-stream' }))
  form.append('file', new Blob([content]), 'upload.bin')
  return form
}

const START = Date.parse('2026-03-01T00:00:00.000Z')

/**
 * A clock that moves one second per reading, so every timestamp differs.
 */
function steppingClock(): () => number {
  let time = START
  return () => (time += 1000)
}

function seededWorld(options: WorldOptions = {}): World {
  const world = createWorld({ now: steppingClock(), ...options })
  seedBase(world)
  return world
}

async function call(world: World, method: string, path: string, body?: unknown, user?: string) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  if (user) {
    headers.authorization = `Basic ${btoa(`${world.tenant}/${user}:password`)}`
  }
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const text = await response.text()
  return { status: response.status, text, body: text ? JSON.parse(text) : undefined }
}

const ids = (list: Array<{ id: string }>) => list.map((item) => item.id)

/**
 * A diff's changes by id, with a document both deleted and created counted
 * as updated when its content changed and as unchanged otherwise (what a
 * snapshot diff reports for it).
 * @param diff - World diff
 */
function foldRecreated(diff: WorldDiff) {
  const tenants = Object.entries(diff.tenants).map(([tenant, changes]) => [tenant, Object.fromEntries(Object.entries(changes).map(([name, value]) => {
    if (!value || Array.isArray(value) || !('updated' in value)) {
      return [name, value]
    }
    const collection = value as CollectionDiff
    const deleted = new Map(collection.deleted.map((document) => [document.id, document]))
    const both = collection.created.filter((document) => deleted.has(document.id))
    const changed = both.filter((document) => JSON.stringify(document) !== JSON.stringify(deleted.get(document.id))).map((document) => document.id)
    const twice = new Set(both.map((document) => document.id))
    return [name, {
      created: collection.created.filter((document) => !twice.has(document.id)).map((document) => document.id).sort(),
      deleted: collection.deleted.filter((document) => !twice.has(document.id)).map((document) => document.id).sort(),
      updated: [...collection.updated.map((change) => change.after.id), ...changed].sort(),
    }]
  }))])
  const options = new Map<string, { before: unknown, after: unknown }>()
  for (const option of diff.options) {
    const key = `${option.tenant}/${option.category}/${option.key}`
    const seen = options.get(key)
    options.set(key, { before: seen ? seen.before : option.before, after: option.after })
  }
  return { tenants, options: [...options].filter(([, change]) => change.before !== change.after).sort() }
}

/**
 * A small deterministic PRNG (mulberry32).
 * @param seed - Seed
 */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('a fork', () => {
  it('reads the base and writes only to itself', async () => {
    const base = seededWorld()
    const before = base.snapshot()
    const fork = base.fork()
    const [device] = base.db.managedObjects.find({ name: 'base-device-0' })

    expect((await call(fork, 'GET', `/inventory/managedObjects/${device!.id}`)).body.name).toBe('base-device-0')
    expect((await call(fork, 'PUT', `/inventory/managedObjects/${device!.id}`, { name: 'renamed' })).status).toBe(200)
    expect((await call(fork, 'POST', '/inventory/managedObjects', { name: 'fork-only' })).status).toBe(201)

    expect(fork.db.managedObjects.get(device!.id)!.name).toBe('renamed')
    expect(base.db.managedObjects.get(device!.id)!.name).toBe('base-device-0')
    expect(base.db.managedObjects.find({ name: 'fork-only' })).toEqual([])
    expect(base.snapshot()).toEqual(before)
  })

  it('freezes its base: writes throw, reads work', async () => {
    const base = seededWorld()
    base.fork()
    expect(base.frozen).toBe(true)
    expect(() => base.device({ name: 'late' })).toThrow(/frozen/)
    expect(() => base.setUser(null)).toThrow(/frozen/)
    expect(() => base.reset()).toThrow(/frozen/)
    expect(() => base.options.set('k', 'v')).toThrow(/frozen/)
    // a request never throws: the write fails with 500 and the base's coverage is invalid
    const late = await call(base, 'POST', '/inventory/managedObjects', { name: 'late' })
    expect(late.status).toBe(500)
    expect(late.body.message).toMatch(/frozen/)
    expect(base.coverage().unhandled.map((request) => request.kind)).toEqual(['error'])
    expect((await call(base, 'GET', '/inventory/managedObjects?pageSize=1&withTotalElements=true')).body.statistics.totalElements).toBe(10)
  })

  it('hides deleted base documents everywhere (tombstones)', async () => {
    const base = seededWorld()
    const fork = base.fork()
    const device = fork.db.managedObjects.find({ name: 'base-device-0' })[0]!.id
    const group = fork.db.managedObjects.find({ name: 'base-group' })[0]!.id
    const query = encodeURIComponent(`$filter=(type eq 'base_Device')`)
    const total = async (path: string) => (await call(fork, 'GET', path)).body.statistics.totalElements

    expect(await total(`/inventory/managedObjects?query=${query}&withTotalElements=true`)).toBe(6)
    expect((await call(fork, 'DELETE', `/inventory/managedObjects/${device}`)).status).toBe(204)

    expect((await call(fork, 'GET', `/inventory/managedObjects/${device}`)).status).toBe(404)
    expect(await total(`/inventory/managedObjects?query=${query}&withTotalElements=true`)).toBe(5)
    expect(await total(`/inventory/managedObjects?type=base_Device&withTotalElements=true&pageSize=2`)).toBe(5)
    expect((await call(fork, 'GET', '/inventory/managedObjects/count?type=base_Device')).body).toBe(5)
    expect(ids((await call(fork, 'GET', `/inventory/managedObjects/${group}/childAssets`)).body.references.map((reference: any) => reference.managedObject))).not.toContain(device)
    expect((await call(fork, 'GET', '/identity/externalIds/base_Serial/base-0')).status).toBe(404)
    expect((await call(fork, 'GET', `/measurement/measurements?source=${device}&withTotalElements=true`)).body.statistics.totalElements).toBe(0)
    expect((await call(fork, 'GET', `/alarm/alarms/count?source=${device}`)).body).toBe(0)
    expect(fork.db.inventoryAssignments.find()).toEqual([])

    // the base still has all of it
    expect((await call(base, 'GET', `/inventory/managedObjects/${device}`)).status).toBe(200)
    expect((await call(base, 'GET', '/identity/externalIds/base_Serial/base-0')).status).toBe(200)
    expect(base.db.inventoryAssignments.find()).toHaveLength(1)
  })

  it('answers a random request sequence exactly like a plain world with the same history', async () => {
    for (const seed of [1, 2, 3]) {
      const plain = seededWorld()
      const plainBefore = plain.snapshot()
      const base = seededWorld()
      const fork = base.fork()
      await runSequence(plain, fork, random(seed), 250)
      expect(fork.snapshot(), `seed ${seed}`).toEqual(plain.snapshot())
      expect(fork.diff(base.snapshot()), `seed ${seed}`).toEqual(plain.diff(plainBefore))
      // the fork's own diff lists a key deleted and created again as both,
      // which a snapshot diff cannot see; otherwise they are equal
      expect(foldRecreated(fork.diff()), `seed ${seed}`).toEqual(foldRecreated(plain.diff(plainBefore)))
    }
  })

  it('finds in world.db what a predicate over the rendered documents finds', async () => {
    const base = seededWorld()
    const fork = base.fork()
    await runSequence(seededWorld(), fork, random(5), 120)
    const objects = fork.db.managedObjects.find()
    const [first, second] = objects
    for (const name of ['events', 'alarms', 'measurements', 'operations', 'managedObjects'] as const) {
      const collection = fork.db[name]
      const all = collection.find()
      const filters: Array<[Record<string, unknown>, (document: Record<string, any>) => boolean]> = [
        [{ source: first!.id }, (document) => document.source?.id === first!.id],
        [{ source: second!.id, type: 'e1' }, (document) => document.source?.id === second!.id && document.type === 'e1'],
        [{ type: 't1' }, (document) => document.type === 't1'],
        [{ status: 'ACTIVE', severity: 'MAJOR' }, (document) => document.status === 'ACTIVE' && document.severity === 'MAJOR'],
        // fields a render adds
        [{ source: { name: first!.name } }, (document) => document.source?.name === first!.name],
        [{ self: all[0]?.self }, (document) => document.self === all[0]?.self],
        [{ childAssets: { self: `${first!.self}/childAssets` } }, (document) => document.childAssets?.self === `${first!.self}/childAssets`],
      ]
      for (const [filter, predicate] of filters) {
        expect(collection.find(filter), `${name} ${JSON.stringify(filter)}`).toEqual(all.filter(predicate))
      }
    }
  })

  it('hands out the same ids as every other fork of its base', async () => {
    const base = seededWorld()
    const [a, b] = [base.fork(), base.fork()]
    const created = async (world: World) => (await call(world, 'POST', '/inventory/managedObjects', { name: 'x' })).body.id
    const first = await created(a)
    expect(await created(b)).toBe(first)
    // one counter behind a scattered two-digit prefix
    expect(Number((await created(a)).slice(2))).toBe(Number(first.slice(2)) + 1)
  })

  it('goes back to its creation state on reset', async () => {
    const base = seededWorld()
    const fork = base.fork()
    const remove = fork.override('GET /fork/answer', () => ({ ok: true }))
    const firstId = (await call(fork, 'POST', '/inventory/managedObjects', { name: 'x' })).body.id
    fork.override('GET /fork/other', () => ({}))
    remove()
    await call(fork, 'DELETE', `/inventory/managedObjects/${base.db.managedObjects.find({ name: 'base-agent' })[0]!.id}`)
    fork.options.set('fork.key', 'v')
    expect(fork.calls).toHaveLength(2)

    fork.reset()
    expect(fork.diff().tenants).toEqual({})
    expect(fork.diff().options).toEqual([])
    expect(fork.calls).toEqual([])
    expect(fork.db.managedObjects.find({ name: 'base-agent' })).toHaveLength(1)
    expect((await call(fork, 'POST', '/inventory/managedObjects', { name: 'x' })).body.id).toBe(firstId)
    // overrides are back to those of the fork's creation (none here)
    expect((await call(fork, 'GET', '/fork/other')).status).not.toBe(200)
  })

  it('starts with the overrides of its base, and keeps its own to itself', async () => {
    const base = createWorld()
    base.override('GET /custom/answer', () => ({ from: 'base' }))
    const fork = base.fork()
    fork.override('GET /custom/answer', () => ({ from: 'fork' }))
    const other = base.fork()
    expect((await call(fork, 'GET', '/custom/answer')).body).toEqual({ from: 'fork' })
    expect((await call(other, 'GET', '/custom/answer')).body).toEqual({ from: 'base' })
    fork.reset()
    expect((await call(fork, 'GET', '/custom/answer')).body).toEqual({ from: 'base' })
  })

  it('reports the same diff as a snapshot diff', async () => {
    const base = seededWorld()
    const before = base.snapshot()
    const fork = base.fork()
    const agent = fork.db.managedObjects.find({ name: 'base-agent' })[0]!.id
    const device = fork.db.managedObjects.find({ name: 'base-device-1' })[0]!.id
    await call(fork, 'POST', '/alarm/alarms', { source: { id: device }, type: 'fork_Alarm', text: 'x', severity: 'MAJOR', time: new Date(START).toISOString() })
    await call(fork, 'POST', '/devicecontrol/operations', { deviceId: agent, c8y_Restart: {} })
    await call(fork, 'DELETE', `/inventory/managedObjects/${fork.db.managedObjects.find({ name: 'base-device-5' })[0]!.id}`)
    await call(fork, 'POST', `/inventory/managedObjects/${agent}/childDevices`, { managedObject: { id: device } })
    await call(fork, 'PUT', '/tenant/options/base-fixture/base.key', { value: 'changed' })
    await call(fork, 'DELETE', '/user/t12345/users/base-user')

    const diff = fork.diff()
    expect(diff).toEqual(diffSnapshots(before, fork.snapshot()))
    expect(diff).toEqual(fork.diff(before))
    const tenant = diff.tenants.t12345!
    expect(tenant.alarms.created).toHaveLength(1)
    expect(tenant.operations.created).toHaveLength(1)
    expect(tenant.managedObjects.deleted.map((document) => document.name)).toEqual(['base-device-5'])
    expect(tenant.relations.created).toEqual([{ parent: agent, kind: 'childDevices', child: device }])
    expect(tenant.users.deleted.map((user) => user.userName)).toEqual(['base-user'])
    expect(tenant.auditRecords.created.length).toBeGreaterThan(0)
    expect(diff.options).toEqual([{ tenant: 't12345', category: 'base-fixture', key: 'base.key', before: 'base-value', after: 'changed' }])
  })

  it('runs bulk operations on its own clock', async () => {
    let baseClock = START
    const base = createWorld({ now: () => baseClock })
    const devices = [1, 2].map((n) => base.device({ name: `Pump ${n}`, com_cumulocity_model_Agent: {} }))
    const group = base.managedObject({ name: 'Pumps', c8y_IsDeviceGroup: {}, assets: devices })
    const clocks = [START, START]
    const forks = clocks.map((_, i) => base.fork({ now: () => clocks[i]! }))
    for (const fork of forks) {
      expect((await call(fork, 'POST', '/devicecontrol/bulkoperations', { groupId: group, startDate: new Date(START + 10_000).toISOString(), creationRamp: 5, operationPrototype: { c8y_Restart: {} } })).status).toBe(201)
    }
    clocks[0] = START + 20_000
    baseClock = START + 60_000
    expect(forks[0]!.db.operations.find({ bulkOperationId: 1 })).toHaveLength(2)
    expect(forks[1]!.db.operations.find({ bulkOperationId: 1 })).toHaveLength(0)
    expect(base.db.bulkOperations.find()).toEqual([])
    clocks[1] = START + 12_000
    expect(forks[1]!.db.operations.find({ bulkOperationId: 1 })).toHaveLength(1)
    expect(forks[0]!.db.bulkOperations.get('1')!.status).toBe('COMPLETED')
    expect(forks[1]!.db.bulkOperations.get('1')!.status).toBe('IN_PROGRESS')
  })

  it('serves many forks at once with interleaved requests', async () => {
    const base = seededWorld()
    const before = base.snapshot()
    const forks = Array.from({ length: 20 }, () => base.fork())
    const agent = base.db.managedObjects.find({ name: 'base-agent' })[0]!.id
    await Promise.all(forks.flatMap((fork, i) => [
      call(fork, 'POST', '/inventory/managedObjects', { name: `fork-${i}` }, `user-${i}`),
      call(fork, 'PUT', `/inventory/managedObjects/${agent}`, { name: `agent-${i}` }, `user-${i}`),
      fork.fetch(new Request(`${fork.baseUrl}/inventory/binaries`, { method: 'POST', body: binaryUpload(`content ${i}`) })),
      call(fork, 'POST', '/devicecontrol/operations', { deviceId: agent, c8y_Restart: {} }, `user-${i}`),
    ]))
    for (const [i, fork] of forks.entries()) {
      expect(fork.db.managedObjects.find({ name: `fork-${i}` })).toHaveLength(1)
      expect(fork.db.managedObjects.find((document) => /^fork-/.test(document.name))).toHaveLength(1)
      expect(fork.db.managedObjects.get(agent)!.name).toBe(`agent-${i}`)
      expect(fork.db.binaries.find()).toHaveLength(2)
      expect(new Set(fork.db.auditRecords.find((record) => record.activity === 'Operation created').map((record) => record.user))).toEqual(new Set([`user-${i}`]))
      expect(fork.calls).toHaveLength(4)
    }
    expect(base.snapshot()).toEqual(before)
  })

  it('can be restored from a snapshot and still diffs against its base', async () => {
    const base = seededWorld()
    const fork = base.fork()
    await call(fork, 'POST', '/inventory/managedObjects', { name: 'saved' })
    const saved = fork.snapshot()
    await call(fork, 'POST', '/inventory/managedObjects', { name: 'dropped' })
    fork.restore(saved)
    expect(fork.snapshot()).toEqual(saved)
    expect(fork.diff()).toEqual(diffSnapshots(base.snapshot(), saved))
    expect(fork.diff().tenants.t12345!.managedObjects.created.map((document) => document.name)).toEqual(['saved'])
  })

  it('can itself be forked', async () => {
    const base = seededWorld()
    const middle = base.fork()
    await call(middle, 'POST', '/inventory/managedObjects', { name: 'middle' })
    const leaf = middle.fork()
    await call(leaf, 'DELETE', `/inventory/managedObjects/${leaf.db.managedObjects.find({ name: 'middle' })[0]!.id}`)
    await call(leaf, 'POST', '/inventory/managedObjects', { name: 'leaf' })
    expect(leaf.db.managedObjects.find({ name: 'middle' })).toEqual([])
    expect(middle.db.managedObjects.find({ name: 'middle' })).toHaveLength(1)
    expect(leaf.diff()).toEqual(diffSnapshots(middle.snapshot(), leaf.snapshot()))
  })

  it('has its own Notification 2.0 state', () => {
    const base = createWorld()
    const fork = base.fork()
    expect(fork.realtime).not.toBe(base.realtime)
  })
})

/**
 * Sends the same random requests to two worlds that start equal, and checks
 * that every answer is the same.
 * @param a - A world
 * @param b - A world with the same data and history
 * @param next - Random numbers
 * @param steps - Number of requests
 */
async function runSequence(a: World, b: World, next: () => number, steps: number): Promise<void> {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const objects = a.db.managedObjects.find().map((document) => document.id as string)
  const names = ['n1', 'n2', 'n3']
  const users = ['u1', 'u2', 'base-user']
  const optionKeys = ['k1', 'k2', 'base.key']
  const time = () => new Date(START + Math.floor(next() * 3_600_000)).toISOString()
  const requests: Array<() => [string, string, unknown?]> = [
    () => ['POST', '/inventory/managedObjects', { name: pick(names), type: pick(['t1', 't2']), ...(next() < 0.3 ? { c8y_IsDevice: {} } : {}) }],
    () => ['PUT', `/inventory/managedObjects/${pick(objects)}`, { name: pick(names), c8y_Fragment: next() < 0.5 ? null : { v: next() } }],
    () => ['DELETE', `/inventory/managedObjects/${pick(objects)}${next() < 0.3 ? '?cascade=true' : ''}`],
    () => ['POST', `/inventory/managedObjects/${pick(objects)}/${pick(['childAssets', 'childDevices'])}`, { managedObject: { id: pick(objects) } }],
    () => ['DELETE', `/inventory/managedObjects/${pick(objects)}/childAssets/${pick(objects)}`],
    () => ['POST', '/measurement/measurements', { source: { id: pick(objects) }, type: 'm', time: time(), m: { v: { value: Math.floor(next() * 100) } } }],
    () => ['POST', '/event/events', { source: { id: pick(objects) }, type: pick(['e1', 'e2']), text: 'e', time: time() }],
    () => ['POST', '/alarm/alarms', { source: { id: pick(objects) }, type: pick(['a1', 'a2']), text: 'a', severity: pick(['MAJOR', 'MINOR']), time: time() }],
    () => ['PUT', `/alarm/alarms?source=${pick(objects)}`, { status: pick(['ACKNOWLEDGED', 'CLEARED']) }],
    () => ['DELETE', `/event/events?source=${pick(objects)}`],
    () => ['POST', `/identity/globalIds/${pick(objects)}/externalIds`, { type: 'x_Serial', externalId: pick(['s1', 's2', 's3']) }],
    () => ['DELETE', `/identity/externalIds/x_Serial/${pick(['s1', 's2', 's3'])}`],
    () => ['PUT', `/tenant/options/${pick(['base-fixture', 'service'])}/${pick(optionKeys)}`, { value: String(Math.floor(next() * 10)) }],
    () => ['DELETE', `/tenant/options/${pick(['base-fixture', 'service'])}/${pick(optionKeys)}`],
    () => ['POST', '/user/t12345/users', { userName: pick(users), email: `${pick(users)}-${Math.floor(next() * 3)}@example.com`, password: 'Password-123' }],
    () => ['DELETE', `/user/t12345/users/${pick(users)}`],
    () => ['POST', `/user/t12345/groups/${pick(['1', '2', '13'])}/users`, { user: { self: `https://x/user/t12345/users/${pick(users)}` } }],
    () => ['GET', `/inventory/managedObjects?pageSize=${pick([3, 5, 50])}&currentPage=${pick([1, 2])}&withTotalElements=true&withParents=true&withChildrenCount=true`],
    () => ['GET', `/inventory/managedObjects?query=${encodeURIComponent(`$filter=(name eq '${pick(names)}') $orderby=name desc`)}&withTotalElements=true`],
    () => ['GET', `/inventory/managedObjects/${pick(objects)}?withParents=true`],
    () => ['GET', `/inventory/managedObjects?pageSize=50&withGroups=true`],
    () => ['GET', `/inventory/managedObjects/count?type=${pick(['t1', 't2', 'base_Device'])}`],
    () => ['GET', `/measurement/measurements?pageSize=20&withTotalElements=true${next() < 0.5 ? `&source=${pick(objects)}` : ''}`],
    () => ['GET', `/event/events?pageSize=20&withTotalPages=true`],
    () => ['GET', `/event/events?pageSize=3&currentPage=${pick([1, 2, 4])}&withTotalPages=true`],
    () => ['GET', `/measurement/measurements?pageSize=3&currentPage=${pick([1, 3])}&revert=true&dateFrom=2026-01-01T00:00:00.000Z`],
    () => ['GET', `/alarm/alarms?pageSize=20&withTotalElements=true`],
    () => ['GET', `/identity/globalIds/${pick(objects)}/externalIds`],
    () => ['GET', '/tenant/options?pageSize=50'],
    () => ['GET', '/user/t12345/users?pageSize=50&withTotalElements=true'],
    () => ['GET', '/audit/auditRecords?pageSize=50&withTotalElements=true'],
  ]
  for (let step = 0; step < steps; step++) {
    const [method, path, body] = pick(requests)()
    const [left, right] = [await call(a, method, path, body), await call(b, method, path, body)]
    expect(right, `step ${step}: ${method} ${path}`).toEqual(left)
    if (method === 'POST' && path === '/inventory/managedObjects' && left.status === 201) {
      objects.push(left.body.id)
    }
  }
}

describe('collection', () => {
  it('keeps the order of a Map with the same history', () => {
    const next = random(7)
    for (let round = 0; round < 20; round++) {
      const map = new Map<string, number>()
      const base = new Collection<number>()
      for (let i = 0; i < 20; i++) {
        map.set(String(i), i)
        base.set(String(i), i)
      }
      base.freeze(true)
      const fork = base.fork()
      for (let step = 0; step < 60; step++) {
        const key = String(Math.floor(next() * 30))
        if (next() < 0.4) {
          expect(fork.delete(key)).toBe(map.delete(key))
        } else {
          const value = Math.floor(next() * 1000)
          map.set(key, value)
          fork.set(key, value)
        }
        expect([...fork.entries()]).toEqual([...map.entries()])
        expect(fork.size).toBe(map.size)
      }
      expect(() => base.set('x', 1)).toThrow(/frozen/)
      fork.discard()
      expect([...fork.entries()]).toEqual([...base.entries()])
    }
  })

  it('groups, sorts, and orders keys like a scan of its entries, also on forks of forks', () => {
    const next = random(11)
    const byRest = (value: number) => (value % 7 === 0 ? undefined : String(value % 4))
    // many equal sort keys: ties must stay in collection order
    const byTens = (value: number) => -Math.floor(value / 10)
    const scan = (collection: Collection<number>, group: string) => [...collection.entries()].filter(([, value]) => byRest(value) === group).map(([key]) => key)
    // every possible key, some not stored, in a scrambled order
    const asked = Array.from({ length: 32 }, (_, index) => String((index * 13) % 32))
    const inOrder = (collection: Collection<number>) => [...collection.keys()].filter((key) => asked.includes(key))
    for (let round = 0; round < 20; round++) {
      let collection = new Collection<number>()
      for (let i = 0; i < 20; i++) {
        collection.set(String(i), Math.floor(next() * 100))
      }
      // a delete and a new set move the key to the end, an overwrite keeps it
      collection.delete('3')
      collection.set('3', 1)
      collection.set('5', 2)
      expect(collection.inOrder(asked)).toEqual(inOrder(collection))
      for (let depth = 0; depth < 3; depth++) {
        collection.freeze()
        const frozen = collection
        expect(frozen.groupedBy(byRest)('1')).toEqual(scan(frozen, '1'))
        expect([...frozen.sortedBy(byTens)]).toEqual([...frozen.values()].sort((a, b) => byTens(a) - byTens(b)))
        expect([...frozen.sortedBy(byTens, { reverse: true })]).toEqual([...frozen.values()].sort((a, b) => byTens(a) - byTens(b)).reverse())
        collection = frozen.fork()
        for (let step = 0; step < 30; step++) {
          const key = String(Math.floor(next() * 30))
          if (next() < 0.3) {
            collection.delete(key)
          } else {
            collection.set(key, Math.floor(next() * 100))
          }
          const groups = collection.groupedBy(byRest)
          for (const group of ['0', '1', '2', '3']) {
            expect(groups(group)).toEqual(scan(collection, group))
          }
          expect([...collection.sortedBy(byTens)]).toEqual([...collection.values()].sort((a, b) => byTens(a) - byTens(b)))
          expect([...collection.sortedBy(byTens, { reverse: true })]).toEqual([...collection.values()].sort((a, b) => byTens(a) - byTens(b)).reverse())
          expect(collection.inOrder(asked)).toEqual(inOrder(collection))
        }
      }
    }
  })

  it('keeps its indexes and sort orders through writes, and pages a sorted list lazily', () => {
    const next = random(23)
    const byRest = (value: number) => (value % 7 === 0 ? undefined : String(value % 4))
    const byTens = (value: number) => -Math.floor(value / 10)
    const scan = (collection: Collection<number>, group: string) => [...collection.entries()].filter(([, value]) => byRest(value) === group).map(([key]) => key)
    const sorted = (collection: Collection<number>) => [...collection.values()].sort((a, b) => byTens(a) - byTens(b))
    for (let round = 0; round < 20; round++) {
      const plain = new Collection<number>()
      const base = new Collection<number>()
      for (let i = 0; i < 20; i++) {
        base.set(String(i), Math.floor(next() * 100))
      }
      base.freeze()
      for (const collection of [plain, base.fork()]) {
        // the indexes are built before the writes and kept up to date by them
        collection.groupedBy(byRest)
        collection.sortedBy(byTens)
        for (let step = 0; step < 40; step++) {
          const key = String(Math.floor(next() * 30))
          if (next() < 0.3) {
            collection.delete(key)
          } else {
            collection.set(key, Math.floor(next() * 100))
          }
          const groups = collection.groupedBy(byRest)
          for (const group of ['0', '1', '2', '3']) {
            expect(groups(group)).toEqual(scan(collection, group))
          }
          const expected = sorted(collection)
          const ascending = collection.sortedBy(byTens)
          const descending = collection.sortedBy(byTens, { reverse: true })
          expect(ascending.length).toBe(expected.length)
          const start = Math.floor(next() * (expected.length + 2))
          const end = start + Math.floor(next() * 6)
          expect(ascending.slice(start, end)).toEqual(expected.slice(start, end))
          expect(descending.slice(start, end)).toEqual([...expected].reverse().slice(start, end))
          expect([...descending]).toEqual([...expected].reverse())
        }
        const stale = collection.sortedBy(byTens)
        collection.set('stale', 1)
        expect(() => stale.slice(0, 1)).toThrow(/after a write/)
      }
    }
  })

  it('updates its indexes per write instead of rebuilding them per call', () => {
    let calls = 0
    const byGroup = (value: number) => {
      calls++
      return String(value % 10)
    }
    const byValue = (value: number) => {
      calls++
      return value
    }
    const base = new Collection<number>(Array.from({ length: 1000 }, (_, i) => [String(i), i] as const))
    base.freeze()
    for (const collection of [new Collection<number>(), base.fork()]) {
      collection.groupedBy(byGroup)
      collection.sortedBy(byValue)
      calls = 0
      for (let i = 0; i < 1000; i++) {
        collection.set(`new${i}`, i)
        // an overwrite of a base key on the fork
        collection.set(String(i), i + 1)
        collection.groupedBy(byGroup)('none')
        collection.sortedBy(byValue).slice(0, 5)
        collection.sortedBy(byValue, { reverse: true }).slice(0, 5)
      }
      // a constant number of calls per write, not one per stored value
      expect(calls).toBeLessThan(10 * 2000)
    }
  })

  it('deep-freezes the values of a frozen base', () => {
    const base = new Collection<{ id: string, nested: { value: number } }>([['1', { id: '1', nested: { value: 1 } }]])
    base.freeze(true)
    expect(() => {
      (base.get('1') as { nested: { value: number } }).nested.value = 2
    }).toThrow(TypeError)
  })
})

describe('parent index', () => {
  it('is built once per children version and layers a fork\'s relations on its base', () => {
    const relations = (childAssets: string[], childDevices: string[] = []): Relations => ({ childAssets, childDevices, childAdditions: [] })
    const children = new Collection<Relations>([['g1', relations(['d1', 'd2'])], ['g2', relations(['d2'], ['d3'])], ['g3', relations(['g1'])]])
    children.freeze()
    const base = { children } as TenantData
    expect(parentIndex(base)).toBe(parentIndex(base))
    const fork = { children: children.fork() } as TenantData
    expect(parentIndex(fork)).toBe(parentIndex(base))
    fork.children.set('g1', relations(['d2', 'd4']))
    fork.children.delete('g3')
    fork.children.set('g4', relations(['d1', 'd2'], ['d1']))
    const index = parentIndex(fork)
    expect(parentIndex(fork)).toBe(index)
    // what a scan of the fork's relations gives
    const plain = { children: new Collection<Relations>([...fork.children.entries()]) } as TenantData
    for (const child of ['d1', 'd2', 'd3', 'd4', 'g1', 'g3']) {
      expect(index.get(child), child).toEqual(parentIndex(plain).get(child))
    }
    expect(parentIndex(base).get('d1')).toEqual([{ parent: 'g1', kind: 'childAssets' }])
  })
})
