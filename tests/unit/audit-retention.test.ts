// Audit records and retention rules as world state: seeding, snapshots,
// diffs, and the audit hook (API requests only).
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'

const json = { 'content-type': 'application/json' }

describe('audit records', () => {
  it('are written by API requests, not by world helpers', async () => {
    const world = createWorld({ now: () => Date.parse('2026-01-01T00:00:00Z') })
    const pump = world.device({ name: 'Pump', com_cumulocity_model_Agent: {} })
    const valve = world.device({ name: 'Valve' })
    world.seed({ alarms: [{ source: pump, type: 'seeded' }], operations: [{ deviceId: pump, c8y_Restart: {} }] })
    expect(world.db.auditRecords.find()).toEqual([])

    const before = world.snapshot()
    await world.fetch(new Request(`${world.baseUrl}/alarm/alarms`, { method: 'POST', headers: json, body: JSON.stringify({ source: { id: pump }, type: 'hot', text: 'Hot', severity: 'MAJOR', time: '2026-01-01T00:00:00Z' }) }))
    await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects/${valve}`, { method: 'DELETE' }))

    const { tenants } = world.diff(before)
    const audits = tenants[world.tenant]!.auditRecords.created
    expect(audits.map((record) => [record.type, record.activity, record.user])).toEqual([
      ['Alarm', 'Alarm created', 'test-user'],
      ['Inventory', 'Managed object deleted', 'test-user'],
    ])
    // kept apart from the data
    expect(tenants[world.tenant]!.alarms.created).toHaveLength(1)
    expect(world.db.auditRecords.find({ type: 'Inventory' })[0]).toMatchObject({ text: 'Managed object "Valve" deleted', source: { id: valve } })
  })

  it('takes the user from basic auth', async () => {
    const world = createWorld()
    await world.fetch(new Request(`${world.baseUrl}/tenant/options/c/k`, { method: 'PUT', headers: json, body: JSON.stringify({ value: 'v' }) }))
    await world.fetch(new Request(`${world.baseUrl}/tenant/options/c/k`, { method: 'DELETE', headers: { authorization: `Basic ${btoa('t12345/alice:pw')}` } }))
    expect(world.db.auditRecords.find()).toMatchObject([{ type: 'Option', user: 'alice', source: { id: 'c.k' } }])
  })

  it('are seedable, restorable, and listed oldest first', async () => {
    const world = createWorld()
    world.seed({
      auditRecords: [
        { type: 'User', activity: 'User created', text: 'User bob created', source: 'bob', time: '2026-01-02T00:00:00Z' },
        { type: 'User', activity: 'User deleted', text: 'User bob deleted', source: 'bob', time: '2026-01-01T00:00:00Z', user: 'admin' },
      ],
    })
    const snapshot = JSON.parse(JSON.stringify(world.snapshot()))
    world.reset()
    expect(world.db.auditRecords.find()).toEqual([])
    world.restore(snapshot)
    const list = await (await world.fetch(new Request(`${world.baseUrl}/audit/auditRecords?source=bob`))).json()
    expect(list.auditRecords.map((record: any) => [record.activity, record.user])).toEqual([['User deleted', 'admin'], ['User created', 'test-user']])
  })

  it('records Notification 2.0 subscriptions and tokens', async () => {
    const world = createWorld()
    await world.fetch(new Request(`${world.baseUrl}/notification2/subscriptions`, { method: 'POST', headers: json, body: JSON.stringify({ context: 'tenant', subscription: 'all', subscriptionFilter: { apis: ['alarms'] } }) }))
    await world.fetch(new Request(`${world.baseUrl}/notification2/token`, { method: 'POST', headers: json, body: JSON.stringify({ subscriber: 'me', subscription: 'all' }) }))
    const [created, token] = world.db.auditRecords.find()
    expect(created!.text).toBe(`Reliable notification subscription ID [type=com_cumulocity_model_idtype_GId, value=${created!.source.id}] created: context='tenant', subscriptionFilter='NotificationSubscriptionFilter(apis=[alarms], typeFilter=null)', source='ID [type=com_cumulocity_model_idtype_GId, value=t12345]', id='ID [type=com_cumulocity_model_idtype_GId, value=${created!.source.id}]', subscription='all'`)
    expect(token).toMatchObject({ activity: 'Notification token created', text: 'Notification token for topic:\'t12345/relnotif/all\'created created' })
    expect(token).not.toHaveProperty('source')
  })
})

describe('retention rules and options', () => {
  it('are seedable and part of snapshots and diffs', async () => {
    const world = createWorld()
    world.seed({ retentionRules: [{ dataType: 'ALARM', maximumAge: 30 }] })
    expect(() => world.seed({ retentionRules: [{ dataType: 'OPERATION', type: 'x', maximumAge: 1 }] })).toThrow(/TYPE/)
    const before = world.snapshot()
    const [rule] = world.db.retentionRules.find()
    await world.fetch(new Request(`${world.baseUrl}/retention/retentions/${rule!.id}`, { method: 'PUT', headers: json, body: JSON.stringify({ maximumAge: 10 }) }))
    expect(world.diff(before).tenants[world.tenant]!.retentionRules.updated).toMatchObject([{ before: { maximumAge: 30 }, after: { maximumAge: 10 } }])
    // retention rules do not write audit records
    expect(world.db.auditRecords.find()).toEqual([])
  })

  it('keeps an option without a value in snapshots', async () => {
    const world = createWorld()
    await world.fetch(new Request(`${world.baseUrl}/tenant/options`, { method: 'POST', headers: json, body: JSON.stringify({ category: 'c', key: 'bare' }) }))
    const snapshot = world.snapshot()
    expect(snapshot.options).toContainEqual([world.tenant, 'c', 'bare', null])
    world.reset()
    world.restore(snapshot)
    expect((await (await world.fetch(new Request(`${world.baseUrl}/tenant/options/c`))).json())).toEqual({ bare: null })
    expect(world.options.get('bare', { category: 'c' })).toBeUndefined()
  })
})
