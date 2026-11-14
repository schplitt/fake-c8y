/**
 * Measurement, event, alarm, and operation rules from issue #5, verified on a
 * tenant: required filters of deletes and the bulk alarm update, the severity
 * filter alone, alarm type mappings and maintenance suppression, any fragment
 * and series name, and `deviceExternalIDs` of operations listed by agent.
 */
import { expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'

async function send(world: World, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: { 'accept': 'application/json', 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined, location: response.headers.get('location') }
}

const now = (): string => new Date().toISOString()

function alarmWorld() {
  const world = createWorld()
  const device = world.device({ name: 'Pump' })
  world.seed({ alarms: [{ source: device, type: 'a', severity: 'MAJOR' }, { source: device, type: 'b', severity: 'MINOR' }] })
  return { world, device }
}

it('filters alarms by severity alone in the list, the count, the bulk update, and the delete', async () => {
  const { world, device } = alarmWorld()
  expect((await send(world, 'GET', '/alarm/alarms?severity=MAJOR')).body.alarms.map((alarm: any) => alarm.type)).toEqual(['a'])
  expect((await send(world, 'GET', '/alarm/alarms?severity=major,minor')).body.alarms).toHaveLength(2)
  expect((await send(world, 'GET', '/alarm/alarms/count?severity=MAJOR')).body).toBe(1)
  // a list of severities counts nothing (verified)
  expect((await send(world, 'GET', '/alarm/alarms/count?severity=MAJOR,MINOR')).body).toBe(0)
  expect((await send(world, 'PUT', '/alarm/alarms?severity=MINOR', { status: 'ACKNOWLEDGED' })).status).toBe(200)
  expect(world.db.alarms.find().map((alarm) => [alarm.type, alarm.status])).toEqual([['a', 'ACTIVE'], ['b', 'ACKNOWLEDGED']])
  expect((await send(world, 'DELETE', `/alarm/alarms?source=${device}&severity=MINOR`)).status).toBe(204)
  expect(world.db.alarms.find().map((alarm) => alarm.type)).toEqual(['a'])
})

it('rejects a bulk alarm update without query parameters or with withSource* but no source', async () => {
  const { world, device } = alarmWorld()
  expect(await send(world, 'PUT', '/alarm/alarms', { status: 'CLEARED' })).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'Bulk alarm update works only with filter. None known filter is set' } })
  for (const name of ['withSourceDevices', 'withSourceAssets', 'withSourceAdditions', 'withSourceChildren']) {
    // the source check comes before the known-filter check
    expect(await send(world, 'PUT', `/alarm/alarms?${name}=true`, { status: 'CLEARED' })).toMatchObject({ status: 422, body: { error: 'alarm/Invalid Data', message: 'Cannot fetch children alarms if parameter \'source\' is not specified!' } })
  }
  expect(world.db.alarms.find().every((alarm) => alarm.status === 'ACTIVE')).toBe(true)
  expect((await send(world, 'PUT', `/alarm/alarms?source=${device}&withSourceDevices=true`, { status: 'CLEARED' })).status).toBe(200)
  expect(world.db.alarms.find().every((alarm) => alarm.status === 'CLEARED')).toBe(true)
})

it('counts only the known filters for the bulk alarm update guard', async () => {
  const { world, device } = alarmWorld()
  for (const query of ['?foo=1', '?type=a', '?fragmentType=x', '?lastUpdatedFrom=2000-01-01', '?createdFrom=2000-01-01', '?createdTo=2100-01-01', '?pageSize=5', '?severity=']) {
    expect(await send(world, 'PUT', `/alarm/alarms${query}`, { status: 'CLEARED' }), query).toMatchObject({ status: 422, body: { message: 'Bulk alarm update works only with filter. None known filter is set' } })
  }
  expect(world.db.alarms.find().every((alarm) => alarm.status === 'ACTIVE')).toBe(true)
  // type, fragmentType, and lastUpdatedFrom do not filter, also with a source
  expect((await send(world, 'PUT', `/alarm/alarms?source=${device}&type=other&fragmentType=x&lastUpdatedFrom=2100-01-01`, { status: 'ACKNOWLEDGED' })).status).toBe(200)
  expect(world.db.alarms.find().map((alarm) => alarm.status)).toEqual(['ACKNOWLEDGED', 'ACKNOWLEDGED'])
  // createdFrom and createdTo filter together with a known filter
  expect((await send(world, 'PUT', `/alarm/alarms?source=${device}&createdTo=2000-01-01`, { status: 'CLEARED' })).status).toBe(200)
  expect(world.db.alarms.find().map((alarm) => alarm.status)).toEqual(['ACKNOWLEDGED', 'ACKNOWLEDGED'])
  for (const query of ['?dateFrom=2000-01-01', '?dateTo=2100-01-01', '?resolved=false', '?foo=1&status=ACKNOWLEDGED']) {
    expect((await send(world, 'PUT', `/alarm/alarms${query}`, { status: 'ACKNOWLEDGED' })).status, query).toBe(200)
  }
  expect((await send(world, 'PUT', '/alarm/alarms?status=ACKNOWLEDGED', { status: 'CLEARED' })).status).toBe(200)
  expect(world.db.alarms.find().every((alarm) => alarm.status === 'CLEARED')).toBe(true)
})

it('rejects deleting events and measurements without a source or a date', async () => {
  const world = createWorld()
  const device = world.device()
  world.seed({ events: [{ source: device, type: 't' }], measurements: [{ source: device, type: 't', c8y_T: { T: { value: 1 } } }] })
  for (const query of ['', '?type=t', '?fragmentType=c8y_T', '?source=']) {
    expect(await send(world, 'DELETE', `/event/events${query}`), query).toMatchObject({ status: 422, body: { error: 'event/Unprocessable Entity', message: 'At least one parameter from [source, createdFrom, createdTo, dateFrom, dateTo] has to be provided' } })
  }
  for (const query of ['', '?type=t', '?fragmentType=c8y_T']) {
    expect(await send(world, 'DELETE', `/measurement/measurements${query}`), query).toMatchObject({ status: 422, body: { error: 'measurement/Unprocessable Entity', message: 'At least one parameter from [source, dateFrom, dateTo] has to be provided' } })
  }
  // verified: an empty source on measurements deletes nothing and answers 204
  expect((await send(world, 'DELETE', '/measurement/measurements?source=')).status).toBe(204)
  expect([world.db.events.find().length, world.db.measurements.find().length]).toEqual([1, 1])
  expect((await send(world, 'DELETE', '/event/events?createdFrom=2000-01-01')).status).toBe(204)
  expect((await send(world, 'DELETE', '/measurement/measurements?dateTo=2100-01-01T00:00:00Z')).status).toBe(204)
  expect([world.db.events.find().length, world.db.measurements.find().length]).toEqual([0, 0])
})

it('applies alarm.type.mapping on alarm creation', async () => {
  const world = createWorld()
  const device = world.device()
  const options: Array<[string, string]> = [['both', 'CRITICAL|mapped'], ['text', '|text only'], ['severity', 'WARNING|'], ['none', 'NONE|'], ['lower', 'none|other text'], ['pipes', 'MAJOR|a|b'], ['spaced', ' WARNING | spaced '], ['nonespace', 'NONE |x']]
  for (const [key, value] of options) {
    expect((await send(world, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key, value })).status).toBe(200)
  }
  // an unusable seeded value is ignored
  world.options.set('bare', 'MAJOR', { category: 'alarm.type.mapping' })
  const create = (type: string) => send(world, 'POST', '/alarm/alarms', { source: { id: device }, type, text: 'sent', severity: 'MINOR', time: now() })
  expect((await create('both')).body).toMatchObject({ severity: 'CRITICAL', text: 'mapped' })
  expect((await create('text')).body).toMatchObject({ severity: 'MINOR', text: 'text only' })
  expect((await create('severity')).body).toMatchObject({ severity: 'WARNING', text: 'sent' })
  // split at the last pipe, the whole value trimmed, the parts not
  expect((await create('pipes')).body).toMatchObject({ severity: 'MAJOR|a', text: 'b' })
  expect((await create('spaced')).body).toMatchObject({ severity: 'WARNING ', text: ' spaced' })
  // NONE with a trailing space does not suppress
  expect((await create('nonespace')).body).toMatchObject({ severity: 'NONE ', text: 'x' })
  expect((await create('bare')).body).toMatchObject({ severity: 'MINOR', text: 'sent' })
  expect((await create('other')).body).toMatchObject({ severity: 'MINOR', text: 'sent' })
  // NONE (any case): answered like a new alarm with an id, mapped like any
  // other (the option's severity, its text if not empty), but nothing is stored
  for (const [type, severity, text] of [['none', 'NONE', 'sent'], ['lower', 'none', 'other text']] as const) {
    const suppressed = await create(type)
    expect(suppressed, type).toMatchObject({ status: 201, body: { type, text, severity, status: 'ACTIVE', count: 1, source: { id: device } } })
    expect(suppressed.body.self).toBe(`${world.baseUrl}/alarm/alarms/${suppressed.body.id}`)
    expect(suppressed.location).toBe(suppressed.body.self)
    expect([typeof suppressed.body.creationTime, typeof suppressed.body.lastUpdated]).toEqual(['string', 'string'])
    expect((await send(world, 'GET', `/alarm/alarms/${suppressed.body.id}`)).status).toBe(404)
  }
  expect(world.db.alarms.find().map((alarm) => alarm.type).sort()).toEqual(['bare', 'both', 'nonespace', 'other', 'pipes', 'severity', 'spaced', 'text'])
  // seeding stores alarms as given
  world.seed({ alarms: [{ source: device, type: 'none', severity: 'MINOR' }] })
  expect(world.db.alarms.find().some((alarm) => alarm.type === 'none')).toBe(true)
})

it('rejects alarm.type.mapping values without a pipe or with both parts empty', async () => {
  const world = createWorld()
  const wrong = (value: string) => ({ status: 422, body: { error: 'options/Invalid Data', message: `Wrong format: '${value}'!` } })
  const empty = { status: 422, body: { error: 'options/Invalid Data', message: 'Priority or text must not be empty in alarm mapping!' } }
  for (const value of ['MAJOR', '']) {
    expect(await send(world, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: 'k', value })).toMatchObject(wrong(value))
    expect(await send(world, 'PUT', '/tenant/options/alarm.type.mapping/k', { value })).toMatchObject(wrong(value))
  }
  expect(await send(world, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: 'k', value: '|' })).toMatchObject(empty)
  // the whole value is trimmed first (unverified for the check)
  expect(await send(world, 'PUT', '/tenant/options/alarm.type.mapping/k', { value: ' | ' })).toMatchObject(empty)
  expect(await send(world, 'PUT', '/tenant/options/alarm.type.mapping/k', { value: '|' })).toMatchObject(empty)
  // the bulk write checks every value before it stores any
  expect(await send(world, 'PUT', '/tenant/options/alarm.type.mapping', { a: 'MAJOR|', b: 'MAJOR' })).toMatchObject(wrong('MAJOR'))
  expect((await send(world, 'GET', '/tenant/options/alarm.type.mapping/a')).status).toBe(404)
  // other categories take any value
  expect((await send(world, 'POST', '/tenant/options', { category: 'other', key: 'k', value: 'MAJOR' })).status).toBe(200)
})

it('stores an empty severity a type mapping replaces and answers 201', async () => {
  const world = createWorld()
  const device = world.device()
  await send(world, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: 'mapped', value: 'CRITICAL|' })
  await send(world, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: 'text', value: '|text only' })
  const mapped = await send(world, 'POST', '/alarm/alarms', { source: { id: device }, type: 'mapped', text: 'x', severity: '', time: now() })
  expect(mapped).toMatchObject({ status: 201, body: { severity: 'CRITICAL' } })
  // without a severity after the mapping: the verified 500
  const unmapped = await send(world, 'POST', '/alarm/alarms', { source: { id: device }, type: 'text', text: 'x', severity: '', time: now() })
  expect(unmapped.status).toBe(500)
  expect(world.db.alarms.find().map((alarm) => [alarm.type, alarm.severity, alarm.text])).toEqual([['mapped', 'CRITICAL', 'x'], ['text', undefined, 'text only']])
})

it('applies alarm.type.mapping and maintenance to an upsert that creates an alarm, not to one that updates', async () => {
  const world = createWorld()
  const device = world.device()
  const resting = world.device({ c8y_RequiredAvailability: { responseInterval: -1 } })
  await send(world, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: 'mapped', value: 'CRITICAL|mapped' })
  await send(world, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: 'none', value: 'NONE|' })
  const upsert = (source: string, type: string, extra: Record<string, unknown> = {}) => send(world, 'POST', '/alarm/alarms/upsert', { source: { id: source }, type, text: 'sent', ...extra })
  expect(await upsert(device, 'mapped')).toMatchObject({ status: 201, body: { alarm: { severity: 'CRITICAL', text: 'mapped' }, previousState: null } })
  // an update of the open alarm applies what it sends
  expect(await upsert(device, 'mapped', { severity: 'MINOR' })).toMatchObject({ status: 200, body: { alarm: { severity: 'MINOR', text: 'sent' } } })
  for (const [source, type] of [[device, 'none'], [resting, 'other'], [resting, 'mapped']] as const) {
    const suppressed = await upsert(source, type)
    expect(suppressed, type).toEqual({ status: 200, body: { alarm: { self: `${world.baseUrl}/alarm/alarms/null`, count: 1 }, previousState: null }, location: `${world.baseUrl}/alarm/alarms/null` })
  }
  expect(world.db.alarms.find().map((alarm) => alarm.type)).toEqual(['mapped'])
  // an open alarm of a source in maintenance is still updated
  world.seed({ alarms: [{ source: resting, type: 'open', severity: 'MINOR' }] })
  expect(await upsert(resting, 'open', { severity: 'WARNING' })).toMatchObject({ status: 200, body: { alarm: { severity: 'WARNING' } } })
})

it('suppresses alarms of a source in maintenance without writing anything', async () => {
  const world = createWorld()
  const device = world.device({ c8y_RequiredAvailability: { responseInterval: 0 } })
  await send(world, 'POST', '/tenant/options', { category: 'alarm.type.mapping', key: 'm', value: 'CRITICAL|mapped' })
  const before = world.snapshot()
  const time = '2026-01-01T00:00:00.000Z'
  const created = await send(world, 'POST', '/alarm/alarms', { source: { id: device }, type: 'm', text: 'x', severity: 'MAJOR', status: 'ACKNOWLEDGED', time, c8y_Custom: { a: 1 } })
  // checked before the mapping, which does not apply
  expect(created).toEqual({
    status: 201,
    body: { self: `${world.baseUrl}/alarm/alarms/null`, type: 'm', text: 'x', severity: 'MAJOR', count: 1, source: { self: `${world.baseUrl}/inventory/managedObjects/${device}`, id: device }, time, c8y_Custom: { a: 1 } },
    location: `${world.baseUrl}/alarm/alarms/null`,
  })
  expect(world.diff(before)).toEqual(world.diff(world.snapshot()))
  expect(world.db.alarms.find()).toEqual([])
  // validation still comes first
  expect((await send(world, 'POST', '/alarm/alarms', { source: { id: device }, type: 'm', severity: 'MAJOR', time: now() })).status).toBe(422)
})

it('accepts fragment and series names with dots, whitespace, or special characters', async () => {
  const world = createWorld()
  const device = world.device()
  const post = (fragments: Record<string, unknown>) => send(world, 'POST', '/measurement/measurements', { source: { id: device }, type: 't', time: now(), ...fragments })
  for (const fragments of [{ 'c8y.T': { T: { value: 1 } } }, { 'c8y T': { T: { value: 1 } } }, { c8y_T: { 'a b': { value: 1 } } }, { c8y_T: { 'T(1)': { value: 1 } } }, { c8y_T: { '@T,$*[]': { value: 1 } } }]) {
    expect((await post(fragments)).status, JSON.stringify(fragments)).toBe(201)
  }
  const collection = await world.fetch(new Request(`${world.baseUrl}/measurement/measurements`, {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/vnd.com.nsn.cumulocity.measurementcollection+json' },
    body: JSON.stringify({ measurements: [{ source: { id: device }, type: 't', time: now(), c8y_T: { T: { value: 1 } } }, { source: { id: device }, type: 't', time: now(), c8y_T: { 'T.1': { value: 1 } } }] }),
  }))
  expect(collection.status).toBe(201)
  expect(world.db.measurements.find()).toHaveLength(7)
})

it('stores any fragment and series name when seeding', () => {
  const world = createWorld()
  const device = world.device()
  world.seed({ measurements: [{ 'source': device, 'type': 't', 'c8y.T': { 'a b': { value: 1 } } }] })
  expect(world.db.measurements.find()).toHaveLength(1)
})

it('renders deviceExternalIDs on operations listed by agentId only', async () => {
  const world = createWorld()
  const agent = world.device({ com_cumulocity_model_Agent: {}, externalIds: { c8y_Serial: 'S1' } })
  const plain = world.device({ com_cumulocity_model_Agent: {} })
  world.seed({ operations: [{ deviceId: agent, c8y_Restart: {} }, { deviceId: plain, c8y_Restart: {} }] })
  const [listed] = (await send(world, 'GET', `/devicecontrol/operations?agentId=${agent}`)).body.operations
  expect(listed.deviceExternalIDs).toEqual({
    self: `${world.baseUrl}/identity/globalIds/${agent}/externalIds`,
    externalIds: [{ self: `${world.baseUrl}/identity/externalIds/c8y_Serial/S1`, externalId: 'S1', type: 'c8y_Serial', managedObject: { self: `${world.baseUrl}/inventory/managedObjects/${agent}`, id: agent } }],
  })
  expect((await send(world, 'GET', `/devicecontrol/operations?agentId=${plain}`)).body.operations[0].deviceExternalIDs.externalIds).toEqual([])
  expect((await send(world, 'GET', `/devicecontrol/operations?deviceId=${agent}`)).body.operations[0].deviceExternalIDs).toBeUndefined()
})
