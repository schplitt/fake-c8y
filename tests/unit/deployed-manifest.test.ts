/**
 * The deployed microservice as an application (`createWorld({ manifest })`):
 * its subscriptions are `world.subscriptions`, with their own service users
 * and passwords, and it behaves like a registered service otherwise.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createWorld, defineService } from '../../src'
import type { C8ySubscription, World, WorldOptions } from '../../src'

async function send(world: World, method: string, path: string, login?: string, body?: unknown) {
  const headers: Record<string, string> = { 'accept': 'application/json', 'content-type': 'application/json' }
  if (login) {
    headers.authorization = `Basic ${Buffer.from(`${login}:any`).toString('base64')}`
  }
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

const manifest = {
  name: 'pump-service',
  contextPath: 'pumps',
  requiredRoles: ['ROLE_INVENTORY_READ'],
  roles: ['ROLE_PUMP_READ'],
  settings: [{ key: 'interval', defaultValue: '5' }, { key: 'mode', defaultValue: 'auto' }],
}

const t100: C8ySubscription = { tenant: 't100', user: 'service_t100', password: 'pw-100' }
const t200: C8ySubscription = { tenant: 't200', user: 'service_t200', password: 'pw-200' }
const t300: C8ySubscription = { tenant: 't300', user: 'service_t300', password: 'pw-300' }

function deployedWorld(options: WorldOptions = {}): World {
  return createWorld({ tenant: 't100', manifest, subscriptions: [t100, t200], ...options })
}

const deployedApplication = (world: World, tenant = world.tenant) => world.db.tenant(tenant).applications.find({ name: 'pump-service' })

const subscribed = async (world: World) => (await send(world, 'GET', '/application/currentApplication/subscriptions', `${world.tenant}/servicebootstrap_pump-service`)).body?.users

describe('createWorld({ manifest })', () => {
  it('creates the microservice in the deployed tenant with the subscriptions\' users and passwords', async () => {
    const world = deployedWorld()
    const [application] = deployedApplication(world)
    expect(application).toMatchObject({ type: 'MICROSERVICE', contextPath: 'pumps', availability: 'MARKET', owner: expect.objectContaining({ tenant: { id: 't100' } }), requiredRoles: ['ROLE_INVENTORY_READ'] })
    expect(application).not.toHaveProperty('__bootstrapUser')
    expect(deployedApplication(world, 't200')).toEqual([expect.objectContaining({ id: application!.id, subscribed: true })])
    expect(await subscribed(world)).toEqual([
      { tenant: 't100', name: 'service_t100', password: 'pw-100' },
      { tenant: 't200', name: 'service_t200', password: 'pw-200' },
    ])
    expect((await send(world, 'GET', '/application/currentApplication', 't100/servicebootstrap_pump-service')).body).toMatchObject({ id: application!.id, name: 'pump-service' })
  })

  it('adds the manifest roles and settings defaults to every subscribed tenant, below explicit tenant options', async () => {
    const world = deployedWorld({ tenantOptions: { interval: '60' } })
    for (const tenant of ['t100', 't200']) {
      expect(world.db.tenant(tenant).roles.get('ROLE_PUMP_READ')).toBeDefined()
      expect(world.options.get('mode', { tenant, category: 'pumps' })).toBe('auto')
    }
    // the settings category comes from the manifest: tenantOptions live there
    expect(world.options.get('interval')).toBe('60')
    expect(world.options.get('interval', { tenant: 't200' })).toBe('5')
    expect((await send(world, 'GET', '/application/currentApplication/settings', 't200/service_t200')).body).toEqual({ interval: '5', mode: 'auto' })
  })

  it('gives the service users the required roles and the bootstrap user ROLE_SYSTEM under enforcement', async () => {
    const world = deployedWorld()
    const pump = world.device({ name: 'Pump' })
    expect((await send(world, 'GET', `/inventory/managedObjects/${pump}`, 't100/service_t100')).status).toBe(200)
    expect((await send(world, 'GET', '/event/events', 't100/service_t100')).status).toBe(403)
    expect((await send(world, 'GET', '/event/events', 't100/servicebootstrap_pump-service')).status).toBe(403)
    const me = (await send(world, 'GET', '/user/currentUser', 't200/service_t200')).body
    expect(me.effectiveRoles.map((role: { id: string }) => role.id)).toEqual(['ROLE_INVENTORY_READ', 'ROLE_SYSTEM'])
    // roles: 'off' gives full access, as for registered services
    const open = deployedWorld({ roles: 'off' })
    expect((await send(open, 'GET', '/event/events', 't100/service_t100')).status).toBe(200)
  })

  it('subscribes and unsubscribes tenants with apply({ subscriptions })', async () => {
    const world = deployedWorld()
    world.apply({ subscriptions: [t100, { ...t300, password: 'other' }] })
    expect(await subscribed(world)).toEqual([
      { tenant: 't100', name: 'service_t100', password: 'pw-100' },
      { tenant: 't300', name: 'service_t300', password: 'other' },
    ])
    expect(world.db.tenant('t300').roles.get('ROLE_PUMP_READ')).toBeDefined()
    // like after an unsubscription on the platform: the service user is gone, the roles stay
    expect((await send(world, 'GET', '/user/currentUser', 't200/service_t200')).status).toBe(401)
    expect(world.db.tenant('t200').roles.get('ROLE_PUMP_READ')).toBeDefined()
    // a new password replaces the subscription's
    world.apply({ subscriptions: [{ ...t100, password: 'rotated' }] })
    expect(await subscribed(world)).toEqual([{ tenant: 't100', name: 'service_t100', password: 'rotated' }])
  })

  it('keeps unsubscriptions through the API when apply() leaves the subscriptions out', async () => {
    const world = deployedWorld()
    const [application] = deployedApplication(world)
    expect((await send(world, 'DELETE', `/tenant/tenants/t200/applications/${application!.id}`, 't200/admin')).status).toBe(204)
    world.apply({ user: { userName: 'other', roles: [] } })
    expect((await send(world, 'GET', '/user/currentUser', 't200/service_t200')).status).toBe(401)
    expect(world.subscriptions).toEqual([t100, t200])
  })

  it('takes the bootstrap user from the option, else from the manifest name', async () => {
    const world = deployedWorld({ bootstrapUser: 'servicebootstrap_custom' })
    const [application] = deployedApplication(world)
    expect((await send(world, 'GET', `/application/applications/${application!.id}/bootstrapUser`)).body).toMatchObject({ tenant: 't100', name: 'servicebootstrap_custom' })
    expect((await send(world, 'GET', '/application/currentApplication/subscriptions', 't100/servicebootstrap_custom')).status).toBe(200)
    expect((await send(world, 'GET', '/application/currentApplication/subscriptions', 't100/servicebootstrap_pump-service')).status).toBe(401)
    const plain = deployedWorld()
    const [own] = deployedApplication(plain)
    expect((await send(plain, 'GET', `/application/applications/${own!.id}/bootstrapUser`)).body).toMatchObject({ name: 'servicebootstrap_pump-service' })
  })

  it('answers /service/<contextPath>/** with 501 in subscribed tenants and 404 elsewhere, and keeps its context path from world.service()', async () => {
    const world = deployedWorld()
    expect((await send(world, 'GET', '/service/pumps/health')).status).toBe(501)
    expect(world.unhandled).toEqual([expect.objectContaining({ kind: 'feature', service: 'pumps' })])
    expect((await send(world, 'GET', '/service/pumps/health', 't300/someone')).status).toBe(401)
    world.apply({ subscriptions: [t200] })
    expect((await send(world, 'GET', '/service/pumps/health')).status).toBe(404)
    expect(() => world.service('pumps', () => new Response(null))).toThrow(/deployed microservice/)
  })

  it('moves the microservice with the deployed tenant', () => {
    const world = deployedWorld()
    world.apply({ tenant: 't200' })
    // t100 stays subscribed, now to t200's application
    expect(world.db.tenant('t100').applications.find({ name: 'pump-service' })).toEqual([expect.objectContaining({ owner: expect.objectContaining({ tenant: { id: 't200' } }) })])
    expect(deployedApplication(world, 't200')).toEqual([expect.objectContaining({ owner: expect.objectContaining({ tenant: { id: 't200' } }), subscribed: true })])
  })

  it('is base data of forks, checkpoints, and reset baselines', async () => {
    const base = deployedWorld()
    const fork = base.fork()
    expect(fork.diff().tenants).toEqual({})
    fork.apply({ subscriptions: [t100, t200, t300] })
    const diff = fork.diff().tenants
    // t300 is a new tenant: its default data shows too
    expect(diff.t300?.applicationSubscriptions?.created).toEqual(expect.arrayContaining([expect.objectContaining({ serviceUser: 'service_t300', password: 'pw-300' })]))
    expect(diff.t300?.roles?.created).toContain('ROLE_PUMP_READ')
    expect(Object.keys(diff)).toEqual(['t300'])
    fork.reset()
    expect(fork.diff().tenants).toEqual({})
    expect(await subscribed(fork)).toHaveLength(2)

    const world = deployedWorld()
    const checkpoint = world.checkpoint()
    world.apply({ subscriptions: [t100] })
    expect(await subscribed(world)).toHaveLength(1)
    world.reset({ to: checkpoint })
    expect(await subscribed(world)).toHaveLength(2)
    world.reset({ to: checkpoint, subscriptions: [t300] })
    expect(await subscribed(world)).toEqual([{ tenant: 't300', name: 'service_t300', password: 'pw-300' }])

    // a new root baseline
    world.reset({ tenant: 't100', subscriptions: [t200] })
    expect(await subscribed(world)).toEqual([{ tenant: 't200', name: 'service_t200', password: 'pw-200' }])
    world.reset({})
    expect(await subscribed(world)).toEqual([{ tenant: 't12345', name: 'service_t12345', password: 'service-password' }])
  })

  it('keeps the subscriptions in snapshots', async () => {
    const world = deployedWorld()
    const snapshot = world.snapshot()
    world.apply({ subscriptions: [t300] })
    world.restore(snapshot)
    expect(await subscribed(world)).toHaveLength(2)
    expect(world.subscriptions).toEqual([t100, t200])
  })

  it('checks the manifest', () => {
    expect(() => createWorld({ manifest: {} })).toThrow(/contextPath or a name/)
    expect(() => createWorld({ manifest, settingsCategory: 'other' })).toThrow(/differs from the manifest's settings category 'pumps'/)
    expect(createWorld({ manifest: { ...manifest, settingsCategory: 'cfg' }, settingsCategory: 'cfg' }).options.get('mode')).toBe('auto')
  })

  it('changes nothing without a manifest', async () => {
    const world = createWorld({ tenant: 't100', subscriptions: [t100, t200] })
    expect(world.db.applications.find({ type: 'MICROSERVICE', owner: { tenant: { id: 't100' } } })).toEqual([])
    expect(await send(world, 'GET', '/application/currentApplication/subscriptions', 't100/servicebootstrap_test')).toMatchObject({ status: 200, body: { users: [{ name: 'service_t100' }, { name: 'service_t200' }] } })
    expect((await send(world, 'GET', '/event/events', 't100/service_t100')).status).toBe(200)
  })

  it('gives the bootstrap user ROLE_SYSTEM', async () => {
    const world = deployedWorld()
    const pump = world.device({ name: 'Pump' })
    const me = (await send(world, 'GET', '/user/currentUser', 't100/servicebootstrap_pump-service')).body
    expect(me.effectiveRoles.map((role: { id: string }) => role.id)).toEqual(['ROLE_SYSTEM'])
    // ROLE_SYSTEM creates audit records (docs/roles.md)
    const record = { type: 'Pump', activity: 'checked', text: 'ok', time: '2026-01-01T00:00:00Z', source: { id: pump } }
    expect((await send(world, 'POST', '/audit/auditRecords', 't100/servicebootstrap_pump-service', record)).status).toBe(201)
    world.seed({ users: [{ userName: 'plain' }] })
    expect((await send(world, 'POST', '/audit/auditRecords', 't100/plain', record)).status).toBe(403)
  })

  it('answers 401 for a removed service user with any name, and for the bootstrap user of a deleted application', async () => {
    const world = deployedWorld({ subscriptions: [t100, { tenant: 't200', user: 's2', password: 'x' }] })
    expect((await send(world, 'GET', '/user/currentUser', 't200/s2')).status).toBe(200)
    world.apply({ subscriptions: [] })
    expect((await send(world, 'GET', '/user/currentUser', 't200/s2')).status).toBe(401)
    expect((await send(world, 'GET', '/application/currentApplication/settings', 't200/s2')).status).toBe(401)
    const [application] = deployedApplication(world)
    expect((await send(world, 'DELETE', `/application/applications/${application!.id}`, 't100/admin')).status).toBe(204)
    expect((await send(world, 'GET', '/application/currentApplication', 't100/servicebootstrap_pump-service')).status).toBe(401)
  })

  it('keeps settings defaults deleted through the API when the subscriptions change', async () => {
    const world = deployedWorld()
    expect((await send(world, 'DELETE', '/tenant/options/pumps/mode', 't100/admin')).status).toBe(204)
    world.apply({ subscriptions: [{ ...t100, password: 'rotated' }, t200, t300] })
    expect(world.options.get('mode')).toBeUndefined()
    expect(world.options.get('mode', { tenant: 't300' })).toBe('auto')
  })

  it('reads credentials.* settings decrypted for its service users', async () => {
    const world = createWorld({
      tenant: 't100',
      manifest: { ...manifest, requiredRoles: ['ROLE_OPTION_MANAGEMENT_READ'], settings: [{ key: 'credentials.token', defaultValue: 'abc' }] },
      subscriptions: [t100],
    })
    expect((await send(world, 'GET', '/application/currentApplication/settings', 't100/service_t100')).body).toEqual({ 'credentials.token': 'abc' })
    expect((await send(world, 'GET', '/tenant/options/pumps/credentials.token', 't100/service_t100')).body).toMatchObject({ value: 'abc' })
    // without ROLE_OPTION_MANAGEMENT_READ in requiredRoles, the option API answers 403
    expect((await send(deployedWorld(), 'GET', '/tenant/options/pumps/interval', 't100/service_t100')).status).toBe(403)
  })

  it('takes the context path and settings category from a manifest with only a name or only a context path', () => {
    const named = createWorld({ manifest: { name: 'only-name', settings: [{ key: 'k', defaultValue: 'v' }] } })
    expect(named.db.applications.find({ name: 'only-name' })).toEqual([expect.objectContaining({ contextPath: 'only-name' })])
    expect(named.options.get('k', { category: 'only-name' })).toBe('v')
    const pathOnly = createWorld({ manifest: { contextPath: 'only-path', settings: [{ key: 'k', defaultValue: 'v' }] } })
    expect(pathOnly.db.applications.find({ name: 'only-path' })).toEqual([expect.objectContaining({ contextPath: 'only-path' })])
    expect(pathOnly.options.get('k')).toBe('v')
  })

  it('puts tenantOptions, also from apply(), into the manifest\'s settings category', () => {
    const world = deployedWorld({ tenantOptions: { a: '1' } })
    world.apply({ tenantOptions: { b: '2' } })
    expect(world.options.get('a', { category: 'pumps' })).toBe('1')
    expect(world.options.get('b', { category: 'pumps' })).toBe('2')
    expect(world.options.get('b', { category: 'service' })).toBeUndefined()
  })

  it('moves the application, its users, and its bootstrap user name with the deployed tenant', async () => {
    const world = deployedWorld({ bootstrapUser: 'servicebootstrap_custom' })
    const [old] = deployedApplication(world)
    world.apply({ tenant: 't300', subscriptions: [t300] })
    expect(world.db.tenant('t100').applications.find({ id: old!.id, name: 'pump-service' })).toEqual([])
    expect((await send(world, 'GET', '/user/currentUser', 't100/service_t100')).status).toBe(401)
    expect((await send(world, 'GET', '/application/currentApplication', 't100/servicebootstrap_custom')).status).toBe(401)
    expect((await send(world, 'GET', '/application/currentApplication/subscriptions', 't300/servicebootstrap_custom')).body).toEqual({ users: [{ tenant: 't300', name: 'service_t300', password: 'pw-300' }] })
  })

  it('moves the application on a fork, and lets a fork unsubscribe a base tenant', () => {
    const base = deployedWorld()
    const moved = base.fork()
    moved.apply({ tenant: 't200' })
    const diff = moved.diff().tenants
    expect(diff.t100?.applications.deleted).toEqual([expect.objectContaining({ name: 'pump-service' })])
    expect(diff.t200?.applications.created).toEqual([expect.objectContaining({ name: 'pump-service', owner: 't200' })])
    const fewer = base.fork()
    fewer.apply({ subscriptions: [t100] })
    expect(fewer.diff().tenants.t200?.applicationSubscriptions.deleted).toEqual([expect.objectContaining({ serviceUser: 'service_t200' })])
    expect(base.db.tenant('t200').applications.find({ name: 'pump-service' })).toHaveLength(1)
    expect(() => base.apply({ subscriptions: [t100] })).toThrow(/frozen/)
  })

  it('keeps a custom bootstrap user name through forks, snapshots, restore, and reset, but not in diffs', async () => {
    const base = deployedWorld({ bootstrapUser: 'servicebootstrap_custom' })
    const asBootstrap = async (world: World) => (await send(world, 'GET', '/application/currentApplication', `${world.tenant}/servicebootstrap_custom`)).status
    const snapshot = base.snapshot()
    expect(snapshot.tenants.find((tenant) => tenant.tenant === 't100')?.applications?.find((application) => application.name === 'pump-service')).toMatchObject({ __bootstrapUser: 'servicebootstrap_custom' })
    base.apply({ subscriptions: [] })
    base.restore(snapshot)
    expect(await asBootstrap(base)).toBe(200)
    base.reset()
    expect(await asBootstrap(base)).toBe(200)
    const fork = base.fork()
    expect(await asBootstrap(fork)).toBe(200)
    fork.apply({ tenant: 't200' })
    expect(await asBootstrap(fork)).toBe(200)
    const created = fork.diff().tenants.t200?.applications.created ?? []
    expect(created).toEqual([expect.objectContaining({ name: 'pump-service' })])
    expect(created[0]).not.toHaveProperty('__bootstrapUser')
  })

  it('lets world.service() register other context paths next to it', async () => {
    const world = deployedWorld()
    world.service('other', () => Response.json({ ok: true }))
    expect((await send(world, 'GET', '/service/other/x')).body).toEqual({ ok: true })
    expect((await send(world, 'GET', '/service/pumps/x')).status).toBe(501)
  })
})

describe('manifest types', () => {
  // the type checks run in `pnpm typecheck` (tsc covers tests/)
  interface StrictManifest {
    name: string
    contextPath?: string
    provider?: { name: string, domain?: string, support?: string }
    requiredRoles?: string[]
  }
  interface ProviderManifest {
    name: string
    contextPath?: string
    provider: { name: string, domain?: string, support?: string }
  }

  const handler = () => Response.json({})

  it('takes a manifest typed as an interface', () => {
    const strict: StrictManifest = { name: 'strict', contextPath: 'strict', provider: { name: 'acme', domain: 'acme.com' } }
    const withProvider: ProviderManifest = { name: 'provided', contextPath: 'provided', provider: { name: 'acme' } }
    for (const manifest of [strict, withProvider]) {
      createWorld({ manifest })
      defineService({ manifest })
      createWorld().service({ manifest })
      createWorld().service(manifest.contextPath!, handler, { manifest })
    }
  })

  it('takes literals with more fields', () => {
    createWorld({ manifest: { name: 'extra', livenessProbe: {}, provider: { name: 'acme', support: 'help@acme.com' } } })
    defineService({ manifest: { contextPath: 'extra', livenessProbe: {}, provider: { name: 'acme', support: 'help@acme.com' } } })
    createWorld().service({ contextPath: 'extra', manifest: { livenessProbe: {}, provider: { name: 'acme', support: 'help@acme.com' } } })
    createWorld().service('extra', handler, { manifest: { livenessProbe: {}, provider: { name: 'acme', support: 'help@acme.com' } } })
    createWorld().service(defineService({ contextPath: 'nested', manifest: { livenessProbe: {} } }))
    const options: WorldOptions = { manifest: { name: 'extra', livenessProbe: {} } }
    createWorld(options)
  })

  it('rejects wrong types on known fields and unknown definition fields', () => {
    // @ts-expect-error a known field with the wrong type
    expect(() => createWorld({ manifest: { name: 1 } })).toThrow()
    // @ts-expect-error a known field with the wrong type
    createWorld({ manifest: { name: 'wrong', provider: { name: 1 } } })
    // @ts-expect-error a known field with the wrong type
    expect(() => defineService({ manifest: { contextPath: 1 } })).toThrow()
    // @ts-expect-error a known field with the wrong type
    expect(() => createWorld().service({ manifest: { contextPath: 1 } })).toThrow()
    // @ts-expect-error a known field with the wrong type
    createWorld().service('wrong', handler, { manifest: { name: 1 } })
    // @ts-expect-error a typo in a definition field
    expect(() => createWorld().service({ contextPat: 'typo', manifest: { name: 'typo' } })).toThrow()

    const world = createWorld()
    world.service({ contextPath: 'read', manifest: { livenessProbe: {} } })
    expectTypeOf(world.services.get('read')!.manifest!.contextPath).toEqualTypeOf<string | undefined>()
    // @ts-expect-error reading an unknown field
    expect(world.services.get('read')!.manifest!.livenessProbe).toEqual({})
  })

  it('stores unknown manifest fields on the application', () => {
    const world = createWorld({ manifest: { name: 'extra', x_custom: { level: 2 }, provider: { name: 'acme', support: 'help@acme.com' } } })
    const [application] = world.db.applications.find({ name: 'extra' })
    expect(application!.manifest).toMatchObject({ x_custom: { level: 2 }, provider: { name: 'acme', support: 'help@acme.com' } })
  })
})

describe('hidden application fields', () => {
  it('are never taken from the API or a seed', async () => {
    const world = createWorld({ tenant: 't100' })
    world.seed({ users: [{ userName: 'bob', roles: ['ROLE_APPLICATION_MANAGEMENT_READ'] }] })
    const created = await send(world, 'POST', '/application/applications', undefined, { name: 'evil', key: 'evil-key', type: 'MICROSERVICE', __bootstrapUser: 'bob' })
    expect(created.status).toBe(201)
    const [id] = world.seed({ applications: [{ name: 'evil2', type: 'MICROSERVICE', __bootstrapUser: 'bob' }] }).applications
    expect((await send(world, 'PUT', `/application/applications/${id}`, undefined, { __bootstrapUser: 'bob' })).status).toBe(200)
    const stored = world.snapshot().tenants.find((tenant) => tenant.tenant === 't100')!.applications!.filter((application) => String(application.name).startsWith('evil'))
    expect(stored).toHaveLength(2)
    for (const application of stored) {
      expect(application).not.toHaveProperty('__bootstrapUser')
    }
    expect((await send(world, 'GET', '/application/currentApplication', 't100/bob')).status).toBe(403)
  })
})

describe('createWorld() without a manifest', () => {
  it('keeps the legacy service users: a removed service_* user answers 401, other names stay unrestricted', async () => {
    const world = createWorld({ tenant: 't100', subscriptions: [t100, t200] })
    world.apply({ subscriptions: [t100] })
    expect((await send(world, 'GET', '/user/currentUser', 't200/service_t200')).status).toBe(401)
    expect((await send(world, 'GET', '/event/events', 't100/servicebootstrap_x')).status).toBe(200)
    expect((await send(world, 'GET', '/event/events', 't100/service_t100')).status).toBe(200)
    expect((await send(world, 'GET', '/application/currentApplication/settings', 't100/servicebootstrap_test')).status).toBe(200)
  })
})
