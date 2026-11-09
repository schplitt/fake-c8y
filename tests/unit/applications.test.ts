/**
 * Applications: the default ones every tenant has, seeding them, and
 * microservices registered from a manifest (`world.service(..., { manifest })`).
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createWorld, defineService } from '../../src'
import type { C8yServiceHandler, World } from '../../src'

async function send(world: World, method: string, path: string, body?: unknown, login?: string) {
  const headers: Record<string, string> = { 'accept': 'application/json', 'content-type': 'application/json' }
  if (login) {
    headers.authorization = `Basic ${Buffer.from(`${login}:secret`).toString('base64')}`
  }
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

const names = (answer: { body: { applications: Array<{ name: string }> } }) => answer.body.applications.map((application) => application.name)

const echo: C8yServiceHandler = async (request, ctx) => {
  const url = new URL(request.url)
  if (url.pathname === '/whoami') {
    return Response.json({ serviceUser: ctx.serviceUser, tenant: ctx.tenant })
  }
  if (url.pathname === '/create') {
    const created = await ctx.fetch('/inventory/managedObjects', { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json' }, body: JSON.stringify({ name: 'made by service' }) })
    return Response.json(await created.json(), { status: created.status })
  }
  return ctx.unsupported(url.pathname)
}

const manifest = {
  name: 'pump-service',
  version: '1.2.0',
  apiVersion: '2',
  isolation: 'MULTI_TENANT' as const,
  provider: { name: 'Pumps Inc.' },
  requiredRoles: ['ROLE_INVENTORY_READ', 'ROLE_INVENTORY_ADMIN'],
  roles: ['ROLE_PUMP_READ', 'ROLE_PUMP_ADMIN'],
  settingsCategory: 'pumpcfg',
  settings: [{ key: 'interval', defaultValue: '5' }, { key: 'credentials.token', defaultValue: 'abc' }],
}

describe('default applications', () => {
  it('lists the platform applications a standard tenant is subscribed to', async () => {
    const world = createWorld()
    const list = await send(world, 'GET', '/application/applications?pageSize=100')
    expect(names(list)).toEqual(expect.arrayContaining(['administration', 'cockpit', 'devicemanagement', 'smartrule', 'apama-ctrl-mt']))
    expect(list.body.applications.every((application: any) => application.owner.tenant.id === 'management')).toBe(true)
    // the platform's order: by id as text
    const ids = list.body.applications.map((application: { id: string }) => application.id)
    expect(ids).toEqual([...ids].sort())
    expect(world.db.applications.find({ name: 'cockpit' })).toEqual([expect.objectContaining({ id: '7', type: 'HOSTED', subscribed: true })])
    const references = (await send(world, 'GET', '/tenant/currentTenant')).body.applications.references
    expect(references.map((reference: any) => reference.application.id)).toEqual(ids)
    // their microservices' roles are in the role catalogue
    expect((await send(world, 'GET', '/user/roles/ROLE_SMARTRULE_ADMIN')).status).toBe(200)
  })

  it('a platform microservice without an emulation makes the trial invalid', async () => {
    const world = createWorld()
    expect((await send(world, 'GET', '/service/smartrule/health')).status).toBe(501)
    expect(world.coverage().unhandled.map((request) => request.kind)).toEqual(['outside-spec'])
    // one the tenant does not have is the agent's mistake: a platform 404
    world.reset()
    expect((await send(world, 'GET', '/service/dtm/health')).status).toBe(404)
    expect(world.coverage().valid).toBe(true)
  })

  it('can be replaced and extended through seed()', async () => {
    const world = createWorld()
    world.seed({ defaultApplications: false, applications: [
      { id: '7', name: 'cockpit', type: 'HOSTED', owner: 'management', contextPath: 'cockpit', resourcesUrl: '/' },
      { name: 'my-app', type: 'HOSTED', contextPath: 'my-app', resourcesUrl: '/', subscribed: false },
      { name: 'my-service', type: 'MICROSERVICE', contextPath: 'my-service', requiredRoles: ['ROLE_EVENT_READ'], roles: ['ROLE_MINE'] },
    ] })
    const list = await send(world, 'GET', '/application/applications?pageSize=100')
    expect(names(list).sort()).toEqual(['cockpit', 'my-app', 'my-service'])
    expect(list.body.applications.find((application: any) => application.name === 'my-app')).toMatchObject({ availability: 'PRIVATE', owner: { tenant: { id: world.tenant } } })
    expect(names(await send(world, 'GET', `/application/applications?subscriber=${world.tenant}&pageSize=100`)).sort()).toEqual(['cockpit', 'my-service'])
    expect(world.db.roles.get('ROLE_MINE')).toBeDefined()
    // a reset brings the defaults back
    world.reset()
    expect(world.db.applications.find({ name: 'administration' })).toHaveLength(1)
  })
})

describe('microservices registered from a manifest', () => {
  it('creates the application, subscription, users, roles, and settings', async () => {
    const world = createWorld()
    world.service('pumps', echo, { manifest })
    const tenant = world.tenant

    // the application, with the manifest the platform stores for an upload
    const [application] = (await send(world, 'GET', '/application/applicationsByName/pump-service')).body.applications
    expect(application).toMatchObject({ name: 'pump-service', key: 'pump-service-key', type: 'MICROSERVICE', availability: 'MARKET', owner: { tenant: { id: tenant } }, contextPath: 'pumps', requiredRoles: manifest.requiredRoles, roles: manifest.roles, version: '1.2.0', isolation: 'MULTI_TENANT' })
    expect(application.manifest).toMatchObject({ contextPath: 'pumps', settingsCategory: 'pumpcfg', billingMode: 'RESOURCES' })
    expect(application.manifest.settings[0]).toEqual({ key: 'interval', defaultValue: '5', editable: false, inheritFromOwner: true, overwriteOnUpdate: true })
    expect(world.db.applications.find({ name: 'pump-service' })[0]!.subscribed).toBe(true)

    // the bootstrap user, and through it the subscriptions with the service user
    const bootstrap = (await send(world, 'GET', `/application/applications/${application.id}/bootstrapUser`)).body
    expect(bootstrap).toEqual({ tenant, name: 'servicebootstrap_pump-service', password: expect.stringMatching(/^.{32}$/) })
    const asBootstrap = `${tenant}/${bootstrap.name}`
    expect((await send(world, 'GET', '/application/currentApplication', undefined, asBootstrap)).body.id).toBe(application.id)
    const { users } = (await send(world, 'GET', '/application/currentApplication/subscriptions', undefined, asBootstrap)).body
    expect(users).toEqual([{ tenant, name: 'service_pump-service', password: expect.stringMatching(/^.{32}$/) }])
    const asService = `${tenant}/service_pump-service`
    const me = (await send(world, 'GET', '/user/currentUser', undefined, asService)).body
    expect(me.effectiveRoles.map((role: { id: string }) => role.id)).toEqual(['ROLE_INVENTORY_READ', 'ROLE_INVENTORY_ADMIN', 'ROLE_SYSTEM'])
    expect((await send(world, 'GET', `/user/${tenant}/users/service_pump-service`)).status).toBe(404)
    expect((await send(world, 'GET', '/application/currentApplication', undefined, asService)).status).toBe(403)

    // the manifest roles are in the catalogue and assignable
    expect((await send(world, 'GET', '/user/roles/ROLE_PUMP_ADMIN')).status).toBe(200)
    const group = (await send(world, 'POST', `/user/${tenant}/groups`, { name: 'pump admins' })).body
    expect((await send(world, 'POST', `/user/${tenant}/groups/${group.id}/roles`, { role: { self: '/user/roles/ROLE_PUMP_ADMIN' } })).status).toBe(201)

    // the settings are tenant options of the settings category
    expect((await send(world, 'GET', '/application/currentApplication/settings', undefined, asService)).body).toEqual({ 'interval': '5', 'credentials.token': 'abc' })
    expect((await send(world, 'GET', '/tenant/options/pumpcfg/interval')).body.value).toBe('5')
    // a secret of its own category reads decrypted for the service, encrypted for anyone else
    expect((await send(world, 'GET', '/tenant/options/pumpcfg/credentials.token', undefined, asService)).body.value).toBe('abc')
    expect((await send(world, 'GET', '/tenant/options/pumpcfg', undefined, asService)).body['credentials.token']).toBe('abc')
    expect((await send(world, 'GET', '/tenant/options/pumpcfg/credentials.token')).body.value).toBe('<<Encrypted>>')
    await send(world, 'POST', '/tenant/options', { category: 'othercfg', key: 'credentials.token', value: 'xyz' })
    expect((await send(world, 'GET', '/tenant/options/othercfg/credentials.token', undefined, asService)).body.value).toBe('<<Encrypted>>')

    // the service works as its service user
    expect((await send(world, 'GET', '/service/pumps/whoami')).body).toEqual({ serviceUser: 'service_pump-service', tenant })
    const created = (await send(world, 'POST', '/service/pumps/create')).body
    expect(created.owner).toBe('service_pump-service')
    expect(world.coverage().valid).toBe(true)
  })

  it('subscribes every tenant in `tenants`, each with its own service user', async () => {
    const world = createWorld({ tenant: 't1' })
    world.service('pumps', echo, { manifest, tenants: ['t1', 't2'] })
    expect(world.db.tenant('t2').applications.find({ name: 'pump-service' })).toEqual([expect.objectContaining({ subscribed: true, owner: { self: expect.any(String), tenant: { id: 't1' } } })])
    const answer = await send(world, 'GET', '/service/pumps/whoami', undefined, 't2/someone')
    expect(answer.body).toEqual({ serviceUser: 'service_pump-service', tenant: 't2' })
    expect(world.db.tenant('t2').roles.get('ROLE_PUMP_READ')).toBeDefined()
  })

  it('answers 404 once unsubscribed or deleted, until the next reset', async () => {
    const world = createWorld()
    world.service('pumps', echo, { manifest })
    const id = world.db.applications.find({ name: 'pump-service' })[0]!.id
    expect((await send(world, 'DELETE', `/tenant/tenants/${world.tenant}/applications/${id}`)).status).toBe(204)
    const unsubscribed = await send(world, 'GET', '/service/pumps/whoami')
    expect([unsubscribed.status, unsubscribed.body.error]).toEqual([404, 'microservice/Not Found'])
    // the roles stay in the catalogue, the service user is gone
    expect(world.db.roles.get('ROLE_PUMP_READ')).toBeDefined()
    expect((await send(world, 'GET', '/user/currentUser', undefined, `${world.tenant}/service_pump-service`)).status).toBe(401)
    expect(world.coverage().valid).toBe(true)

    world.reset()
    expect((await send(world, 'GET', '/service/pumps/whoami')).status).toBe(200)
    expect((await send(world, 'DELETE', `/application/applications/${id}`)).status).toBe(204)
    expect((await send(world, 'GET', '/service/pumps/whoami')).status).toBe(404)
  })

  it('removing the service deletes its application', async () => {
    const world = createWorld()
    const remove = world.service('pumps', echo, { manifest })
    remove()
    expect(world.db.applications.find({ name: 'pump-service' })).toEqual([])
    expect((await send(world, 'GET', '/service/pumps/whoami')).status).toBe(404)
  })

  it('forks inherit it without a diff; their changes show in the diff', async () => {
    const base = createWorld()
    base.service('pumps', echo, { manifest })
    const fork = base.fork()
    expect(fork.diff().tenants).toEqual({})
    const id = fork.db.applications.find({ name: 'pump-service' })[0]!.id
    await send(fork, 'DELETE', `/tenant/tenants/${fork.tenant}/applications/${id}`)
    const diff = fork.diff().tenants[fork.tenant]!
    expect(diff.applicationSubscriptions.deleted).toEqual([expect.objectContaining({ id, serviceUser: 'service_pump-service' })])
    fork.reset()
    expect(fork.diff().tenants).toEqual({})
    expect((await send(fork, 'GET', '/service/pumps/whoami')).status).toBe(200)
  })

  it('goes through a snapshot and back', async () => {
    const world = createWorld()
    world.service('pumps', echo, { manifest })
    await send(world, 'POST', '/application/applications', { name: 'mine', key: 'mine-key', type: 'EXTERNAL', externalUrl: 'https://example.com' })
    const snapshot = world.snapshot()
    world.reset()
    expect(world.db.applications.find({ name: 'mine' })).toEqual([])
    world.restore(snapshot)
    expect(world.db.applications.find({ name: 'mine' })).toHaveLength(1)
    expect(world.diff(snapshot)).toEqual({ tenants: {}, options: [] })
  })
})

describe('registrations across forks, resets, and restores', () => {
  const other: C8yServiceHandler = async () => Response.json({ other: true })

  it('installs a service registered on a frozen base into the base, for later forks only', async () => {
    const base = createWorld()
    const early = base.fork()
    base.service('pumps', echo, { manifest })
    expect(base.db.applications.find({ name: 'pump-service' })).toHaveLength(1)
    const fork = base.fork()
    expect(fork.diff().tenants).toEqual({})
    expect((await send(fork, 'GET', '/service/pumps/whoami')).status).toBe(200)
    fork.reset()
    expect(fork.diff().tenants).toEqual({})
    expect((await send(fork, 'GET', '/service/pumps/whoami')).status).toBe(200)
    // a fork from before the registration has neither the handler nor the application
    expect(early.db.applications.find({ name: 'pump-service' })).toEqual([])
    expect(early.diff().tenants).toEqual({})
  })

  it('keeps an application the trial deleted or unsubscribed deleted in its forks and restores', async () => {
    const base = createWorld()
    base.service('pumps', echo, { manifest })
    const trial = base.fork()
    const id = trial.db.applications.find({ name: 'pump-service' })[0]!.id
    expect((await send(trial, 'DELETE', `/tenant/tenants/${trial.tenant}/applications/${id}`)).status).toBe(204)
    const unsubscribed = trial.snapshot()
    expect((await send(trial, 'DELETE', `/application/applications/${id}`)).status).toBe(204)
    const deleted = trial.snapshot()

    const followUp = trial.fork()
    expect(followUp.diff().tenants).toEqual({})
    expect((await send(followUp, 'GET', '/service/pumps/whoami')).status).toBe(404)

    const world = base.fork()
    world.restore(unsubscribed)
    expect(world.diff(unsubscribed)).toEqual({ tenants: {}, options: [] })
    expect((await send(world, 'GET', '/service/pumps/whoami')).status).toBe(404)
    world.restore(deleted)
    expect(world.diff(deleted)).toEqual({ tenants: {}, options: [] })
    expect(world.db.applications.find({ name: 'pump-service' })).toEqual([])
  })

  it('updates the application when a context path is registered again with other options', async () => {
    const base = createWorld()
    base.service('pumps', echo, { manifest })
    const fork = base.fork()
    fork.service('pumps', echo, { manifest: { ...manifest, name: 'pump-v2', requiredRoles: ['ROLE_B'], roles: ['ROLE_NEW'] } })
    const check = async () => {
      const applications = fork.db.applications.find({ type: 'MICROSERVICE' }).filter((application) => application.contextPath === 'pumps')
      expect(applications).toEqual([expect.objectContaining({ name: 'pump-v2', requiredRoles: ['ROLE_B'], roles: ['ROLE_NEW'] })])
      expect((await send(fork, 'GET', '/service/pumps/whoami')).body.serviceUser).toBe('service_pump-v2')
      const me = (await send(fork, 'GET', '/user/currentUser', undefined, `${fork.tenant}/service_pump-v2`)).body
      expect(me.effectiveRoles.map((role: { id: string }) => role.id)).toEqual(['ROLE_B', 'ROLE_SYSTEM'])
      expect((await send(fork, 'GET', '/user/roles/ROLE_NEW')).status).toBe(200)
      expect((await send(fork, 'GET', '/user/currentUser', undefined, `${fork.tenant}/service_pump-service`)).status).toBe(401)
      const diff = fork.diff().tenants[fork.tenant]!
      expect(diff.applications.updated).toHaveLength(1)
      expect(diff.applicationSubscriptions.updated).toEqual([expect.objectContaining({ after: expect.objectContaining({ serviceUser: 'service_pump-v2' }) })])
    }
    await check()
    fork.reset()
    await check()

    // the short form is a new definition every time: without options it
    // replaces the manifest too
    const third = base.fork()
    third.service('pumps', other)
    expect(third.db.applications.find({ type: 'MICROSERVICE' }).filter((application) => application.contextPath === 'pumps').map((application) => application.name)).toEqual(['pumps'])
  })

  it('changes only the handler when the same definition is registered again with another handler', async () => {
    const pumps = defineService({ contextPath: 'pumps', manifest, handler: echo })
    const base = createWorld()
    base.service(pumps)
    const fork = base.fork()
    fork.service(pumps, { handler: other })
    expect(fork.diff().tenants).toEqual({})
    expect((await send(fork, 'GET', '/service/pumps/x')).body).toEqual({ other: true })
    fork.reset()
    expect(fork.diff().tenants).toEqual({})
    expect((await send(fork, 'GET', '/service/pumps/x')).body).toEqual({ other: true })
  })

  it('gives a fork\'s replacement up for the inherited service on removal', async () => {
    const base = createWorld()
    base.service('pumps', echo, { manifest })
    const fork = base.fork()
    const remove = fork.service('pumps', other, { manifest: { ...manifest, requiredRoles: ['ROLE_B'] } })
    remove()
    expect(fork.diff().tenants).toEqual({})
    expect((await send(fork, 'GET', '/service/pumps/whoami')).body.serviceUser).toBe('service_pump-service')
    fork.reset()
    expect(fork.diff().tenants).toEqual({})
    expect((await send(fork, 'GET', '/service/pumps/whoami')).status).toBe(200)
  })

  it('derives the bootstrap user: it works before the first read, and a read writes nothing', async () => {
    const base = createWorld()
    base.service('pumps', echo, { manifest })
    const fork = base.fork()
    const asBootstrap = `${fork.tenant}/servicebootstrap_pump-service`
    expect((await send(fork, 'GET', '/application/currentApplication/subscriptions', undefined, asBootstrap)).status).toBe(200)
    const id = fork.db.applications.find({ name: 'pump-service' })[0]!.id
    expect((await send(fork, 'GET', `/application/applications/${id}/bootstrapUser`)).body.name).toBe('servicebootstrap_pump-service')
    expect(fork.diff().tenants).toEqual({})
    expect((await send(base.fork(), 'GET', '/user/currentUser', undefined, asBootstrap)).status).toBe(200)
  })

  it('answers /user/currentUser for a tenant user whose name starts with service_', async () => {
    const world = createWorld()
    expect((await send(world, 'POST', `/user/${world.tenant}/users`, { userName: 'service_ops', password: 'Secret123!x', email: 'ops@example.com' })).status).toBe(201)
    expect((await send(world, 'GET', '/user/currentUser', undefined, `${world.tenant}/service_ops`)).status).toBe(200)
    expect((await send(world, 'GET', '/user/currentUser', undefined, `${world.tenant}/service_gone`)).status).toBe(401)
  })
})
