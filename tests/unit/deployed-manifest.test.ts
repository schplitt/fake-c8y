/**
 * The deployed microservice as an application (`createWorld({ manifest })`):
 * its subscriptions are `world.subscriptions`, with their own service users
 * and passwords, and it behaves like a registered service otherwise.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { C8ySubscription, World, WorldOptions } from '../../src'

async function send(world: World, method: string, path: string, login?: string) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (login) {
    headers.authorization = `Basic ${Buffer.from(`${login}:any`).toString('base64')}`
  }
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers }))
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
    expect((await send(deployedWorld(), 'GET', `/application/applications/${application!.id}/bootstrapUser`)).body).toMatchObject({ name: 'servicebootstrap_pump-service' })
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
})
