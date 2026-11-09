/**
 * What `diff()` reports beyond plain document changes: binary contents and
 * event attachments, keys deleted and created again, and a fork restored
 * from an older snapshot.
 */
import { describe, expect, it } from 'vitest'
import { createClock, createWorld } from '../../src'
import type { World } from '../../src'

async function send(world: World, method: string, path: string, body?: string, contentType = 'application/json') {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: { 'accept': 'application/json', 'content-type': contentType }, ...(body !== undefined ? { body } : {}) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

describe('diff()', () => {
  it('shows an upsert without changes as a new lastUpdated and an audit record without changes', async () => {
    // verified on a real tenant: only lastUpdated moves, and the "Alarm updated" record has `changes: []`
    const clock = createClock({ start: '2026-03-01T00:00:00.000Z', realtime: false })
    const base = createWorld({ clock })
    const device = base.device({ name: 'pump' })
    const alarm = (await send(base, 'POST', '/alarm/alarms', JSON.stringify({ source: { id: device }, type: 'overheat', text: 'hot', severity: 'MINOR', time: '2026-02-01T00:00:00Z' }))).body
    const upsert = (fork: World) => send(fork, 'POST', '/alarm/alarms/upsert', JSON.stringify({ source: { id: device }, type: 'overheat' }))
    // at the instant the alarm was written, lastUpdated stays the same, so only the audit record shows
    const same = base.fork()
    expect((await upsert(same)).status).toBe(200)
    let tenant = same.diff().tenants[same.tenant]!
    expect(tenant.alarms).toEqual({ created: [], updated: [], deleted: [] })
    expect(tenant.auditRecords.created).toMatchObject([{ activity: 'Alarm updated', changes: [], source: { id: alarm.id } }])
    // a second later the alarm shows too, with nothing but lastUpdated changed
    const later = base.fork()
    later.advance(1000)
    expect((await upsert(later)).status).toBe(200)
    tenant = later.diff().tenants[later.tenant]!
    expect(tenant.alarms.updated).toHaveLength(1)
    const { before, after } = tenant.alarms.updated[0]!
    expect({ ...after, lastUpdated: before.lastUpdated }).toEqual(before)
    expect(after.lastUpdated).toBe('2026-03-01T00:00:01.000Z')
    expect(tenant.auditRecords.created).toHaveLength(1)
  })

  it('lists event attachments and binary contents', async () => {
    const base = createWorld()
    const device = base.device()
    base.seed({ events: [{ source: device, type: 't', text: 't' }] })
    const eventId = base.db.events.find()[0]!.id
    const binary = base.binary({ name: 'file.txt', content: 'one' })
    const fork = base.fork()

    expect((await send(fork, 'POST', `/event/events/${eventId}/binaries`, 'attached', 'text/plain')).status).toBe(201)
    expect((await send(fork, 'PUT', `/inventory/binaries/${binary}`, 'two', 'text/plain')).status).toBe(201)
    let diff = fork.diff()
    const tenant = diff.tenants[fork.tenant]!
    expect(tenant.eventBinaries.created.map((entry) => entry.id)).toEqual([eventId])
    expect(tenant.binaries.updated.map((change) => [change.before.base64, change.after.base64])).toEqual([[btoa('one'), btoa('two')]])
    expect(diff).toEqual(fork.diff(base.snapshot()))

    expect((await send(fork, 'DELETE', `/event/events/${eventId}/binaries`)).status).toBe(204)
    diff = fork.diff()
    expect(diff.tenants[fork.tenant]!.eventBinaries).toEqual({ created: [], updated: [], deleted: [] })

    const attached = base.fork()
    await send(attached, 'POST', `/event/events/${eventId}/binaries`, 'attached', 'text/plain')
    const frozen = attached.snapshot()
    attached.reset()
    expect(attached.diff().tenants).toEqual({})
    attached.restore(frozen)
    expect(attached.diff().tenants[attached.tenant]!.eventBinaries.created).toHaveLength(1)
  })

  it('lists a user or a tenant option deleted and created again as deleted and created', async () => {
    const base = createWorld()
    const user = { userName: 'alice', email: 'alice@example.com', password: 'Secret-pass-123' }
    expect((await send(base, 'POST', `/user/${base.tenant}/users`, JSON.stringify(user))).status).toBe(201)
    base.options.set('k', 'v', { category: 'c' })
    const fork = base.fork()

    expect((await send(fork, 'DELETE', `/user/${fork.tenant}/users/alice`)).status).toBe(204)
    expect((await send(fork, 'POST', `/user/${fork.tenant}/users`, JSON.stringify(user))).status).toBe(201)
    expect((await send(fork, 'DELETE', '/tenant/options/c/k')).status).toBe(204)
    expect((await send(fork, 'POST', '/tenant/options', JSON.stringify({ category: 'c', key: 'k', value: 'v' }))).status).toBe(200)

    const diff = fork.diff()
    const users = diff.tenants[fork.tenant]!.users
    expect(users.deleted.map((item) => item.id)).toEqual(['alice'])
    expect(users.created.map((item) => item.id)).toEqual(['alice'])
    expect(users.updated).toEqual([])
    expect(diff.options).toEqual([
      { tenant: fork.tenant, category: 'c', key: 'k', before: 'v', after: undefined },
      { tenant: fork.tenant, category: 'c', key: 'k', before: undefined, after: 'v' },
    ])
  })

  it('reports no unrelated updates after restoring an older snapshot into a fork', async () => {
    const base = createWorld()
    base.device({ name: 'd0' })
    const older = base.snapshot()
    for (let i = 1; i < 5; i++) {
      base.device({ name: `d${i}` })
    }
    const fork = base.fork()
    fork.restore(older)
    const created = await send(fork, 'POST', '/inventory/managedObjects', JSON.stringify({ name: 'new-in-fork' }))
    expect(created.status).toBe(201)

    const objects = fork.diff().tenants[fork.tenant]!.managedObjects
    expect(objects.updated).toEqual([])
    expect(objects.created.map((item) => item.name)).toEqual(['new-in-fork'])
    expect(objects.deleted.map((item) => item.name)).toEqual(['d1', 'd2', 'd3', 'd4'])
  })

  it('stays small after restoring the base snapshot into a fork', () => {
    const base = createWorld()
    for (let i = 0; i < 5; i++) {
      base.device({ name: `d${i}` })
    }
    base.options.set('k', 'v')
    const fork = base.fork()
    fork.restore(base.snapshot())
    expect(fork.diff()).toEqual({ tenants: {}, options: [] })
    expect(fork.snapshot()).toEqual(base.snapshot())
  })
})
