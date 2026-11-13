// The user management state of a world: default content, seeding, the
// current user as a stored user, and snapshots and diffs with relations.
import { describe, expect, it } from 'vitest'
import { createWorld, DEFAULT_ROLES } from '../../src'
import { NEW_USER_ROLES } from '../../src/api/users'
import type { World } from '../../src'

async function get(world: World, path: string) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`))
  return { status: response.status, body: await response.json() as any }
}

async function send(world: World, method: string, path: string, body?: unknown) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', 'accept': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

describe('user management', () => {
  it('starts every tenant with the role catalogue, default groups, and inventory roles', () => {
    const world = createWorld()
    // the core roles, then the roles of the subscribed default microservices
    const roles = world.db.roles.find().map((role) => role.id)
    expect(roles.slice(0, DEFAULT_ROLES.length)).toEqual(DEFAULT_ROLES)
    expect(roles).toEqual(expect.arrayContaining(['ROLE_SMARTRULE_READ', 'ROLE_SMS_ADMIN']))
    expect(world.db.groups.find().map((group) => group.name)).toEqual(['business', 'admins', 'readers', 'devices', 'Tenant Manager', 'CEP Manager', 'Devicemanagement User', 'Cockpit User', 'Global User Manager', 'Shared User Manager', 'Global Reader', 'Global Manager'])
    expect(world.db.groups.get('2')?.roles.references).toHaveLength(DEFAULT_ROLES.length)
    expect(world.db.inventoryRoles.find().map((role) => role.name)).toEqual(['Reader', 'Manager', 'Operations: All', 'Operations: Restart Device'])
    expect(world.db.tenant('t2').groups.find()).toHaveLength(12)
  })

  it('stores the current user, with the roles of its groups in currentUser', async () => {
    const world = createWorld({ user: { userName: 'eva', roles: ['ROLE_CUSTOM'], groups: ['readers'], email: 'eva@example.com' } })
    expect(world.db.users.get('eva')).toMatchObject({ userName: 'eva', email: 'eva@example.com' })
    expect(world.db.users.effectiveRoles('eva')).toEqual(expect.arrayContaining(['ROLE_CUSTOM', 'ROLE_USER_MANAGEMENT_READ']))
    // an unknown role joins the catalogue, so its references resolve
    expect(world.db.roles.get('ROLE_CUSTOM')).toBeDefined()

    const { body } = await get(world, '/user/currentUser')
    expect(body).toMatchObject({ id: 'eva', userName: 'eva', email: 'eva@example.com', shouldResetPassword: false })
    expect(body.effectiveRoles.map((role: any) => role.id)).toEqual(world.db.users.effectiveRoles('eva'))

    // API changes to the user show in currentUser
    await send(world, 'POST', `/user/${world.tenant}/groups/9/users`, { user: { self: `${world.baseUrl}/user/${world.tenant}/users/eva` } })
    const after = await get(world, '/user/currentUser')
    expect(after.body.effectiveRoles.map((role: any) => role.id)).toContain('ROLE_USER_MANAGEMENT_ADMIN')

    world.setUser({ userName: 'eva', roles: [] })
    expect(world.db.users.get('eva')?.roles.references).toEqual([])
    world.setUser({ userName: 'otto', tenant: 't2' })
    expect(world.db.tenant('t2').users.get('otto')).toBeDefined()
  })

  it('answers currentUser from the world user after the stored user was deleted', async () => {
    const world = createWorld({ user: { userName: 'eva', roles: ['ROLE_ALARM_READ'] } })
    expect((await send(world, 'DELETE', `/user/${world.tenant}/users/eva`)).status).toBe(204)
    const { body } = await get(world, '/user/currentUser')
    expect(body.effectiveRoles.map((role: any) => role.id)).toEqual(['ROLE_ALARM_READ'])
  })

  it('answers currentUser for the Basic-auth user with its own roles, also on a fork', async () => {
    const base = createWorld({ user: { userName: 'eva', roles: ['ROLE_ALARM_READ'] } })
    base.seed({ users: [{ userName: 'otto', roles: ['ROLE_INVENTORY_ADMIN'] }] })
    const as = (world: World, name: string) => world.fetch(new Request(`${world.baseUrl}/user/currentUser`, { headers: { authorization: `Basic ${btoa(`${world.tenant}/${name}:x`)}`, accept: 'application/json' } }))
    for (const world of [base, base.fork()]) {
      const otto = await (await as(world, 'otto')).json()
      expect(otto.userName).toBe('otto')
      expect(otto.effectiveRoles.map((role: any) => role.id)).toContain('ROLE_INVENTORY_ADMIN')
      expect(otto.effectiveRoles.map((role: any) => role.id)).not.toContain('ROLE_ALARM_READ')
      expect((await (await as(world, 'eva')).json()).userName).toBe('eva')
      expect((await get(world, '/user/currentUser')).body.userName).toBe('eva')
      // a user the tenant does not store gets the world's user, as before stored users answered
      const nobody = await as(world, 'nobody')
      expect(nobody.status).toBe(200)
      expect((await nobody.json()).userName).toBe('eva')
    }
  })

  it('answers currentUser for a same-name user of another tenant with that user\'s roles', async () => {
    const world = createWorld({ user: { userName: 'eva', roles: ['ROLE_INVENTORY_ADMIN'] } })
    world.seed({ tenant: 't2', users: [{ userName: 'eva', roles: ['ROLE_ALARM_READ'] }] })
    const answer = await world.fetch(new Request(`${world.baseUrl}/user/currentUser`, { headers: { authorization: `Basic ${btoa('t2/eva:x')}`, accept: 'application/json' } }))
    const roles = (await answer.json()).effectiveRoles.map((role: any) => role.id)
    expect(roles).toContain('ROLE_ALARM_READ')
    expect(roles).not.toContain('ROLE_INVENTORY_ADMIN')
  })

  it('locks a disabled user out of every request, like the platform', async () => {
    const world = createWorld({ user: { userName: 'eva', roles: ['ROLE_INVENTORY_ADMIN', 'ROLE_USER_MANAGEMENT_ADMIN'] } })
    const device = (await send(world, 'POST', '/inventory/managedObjects', { name: 'pump', c8y_IsDevice: {} })).body.id
    expect((await send(world, 'POST', `/user/${world.tenant}/users`, { userName: 'otto', password: 'Contract-Pass-2026!x', email: 'otto@example.com' })).status).toBe(201)
    // otto may enable users
    expect((await send(world, 'POST', `/user/${world.tenant}/users/otto/roles`, { role: { self: `${world.baseUrl}/user/roles/ROLE_USER_MANAGEMENT_ADMIN` } })).status).toBe(201)
    expect((await send(world, 'PUT', `/inventory/managedObjects/${device}/user`, { enabled: false })).status).toBe(200)
    const locked = { status: 401, body: { error: 'security/Unauthorized', message: 'Authentication failed! : User account is locked', info: 'https://cumulocity.com/api/core/' } }
    for (const path of ['/inventory/managedObjects', '/user/currentUser', `/user/${world.tenant}/users/eva`]) {
      expect(await send(world, 'GET', path)).toEqual(locked)
    }
    expect(await send(world, 'PUT', `/user/${world.tenant}/users/eva`, { enabled: true })).toEqual(locked)
    // another user is not affected and can enable it again
    const otto = new Request(`${world.baseUrl}/user/${world.tenant}/users/eva`, { method: 'PUT', headers: { 'authorization': `Basic ${btoa(`${world.tenant}/otto:x`)}`, 'content-type': 'application/json', 'accept': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    expect((await world.fetch(otto)).status).toBe(200)
    expect((await send(world, 'GET', '/inventory/managedObjects')).status).toBe(200)
  })

  it('seeds roles, inventory roles, groups, users, and assignments', () => {
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    world.seed({
      roles: ['ROLE_PUMP_ADMIN'],
      inventoryRoles: [{ name: 'Pump operator', permissions: [{ permission: 'ADMIN', scope: 'OPERATION', type: '*' }] }],
      groups: [{ name: 'Operators', description: 'Run pumps', roles: ['ROLE_PUMP_ADMIN', 'ROLE_ALARM_READ'] }],
      users: [
        { userName: 'anna@example.com', firstName: 'Anna', groups: ['Operators', 3], inventoryAssignments: [{ managedObject: pump, roles: ['Pump operator', 1] }] },
        { userName: 'ben', roles: ['ROLE_EVENT_READ'], owner: 'anna@example.com' },
      ],
    })
    const anna = world.db.users.get('anna@example.com')!
    // every new user gets the two OWN roles, like on the platform
    expect(anna).toMatchObject({ email: 'anna@example.com', firstName: 'Anna' })
    expect(anna.roles.references.map((reference: any) => reference.role.id)).toEqual(NEW_USER_ROLES)
    expect(world.db.users.get('ben')?.roles.references.map((reference: any) => reference.role.id)).toEqual([...NEW_USER_ROLES, 'ROLE_EVENT_READ'])
    expect(anna.groups.references.map((reference: any) => reference.group.name)).toEqual(['Operators', 'readers'])
    expect(world.db.users.get('ben')?.email).toBe('ben@example.com')
    expect(world.db.users.effectiveRoles('anna@example.com')).toContain('ROLE_PUMP_ADMIN')
    expect(world.db.inventoryAssignments.find({ user: 'anna@example.com' })).toMatchObject([{ managedObject: pump, roles: [{ name: 'Pump operator' }, { name: 'Reader' }] }])
    expect(world.db.groups.find({ name: 'Operators' })).toHaveLength(1)

    expect(() => world.seed({ users: [{ userName: 'ben' }] })).toThrow(/invalid user ben: User with username or alias 'ben' already exists/)
    expect(() => world.seed({ users: [{ userName: 'carl', groups: ['nope'] }] })).toThrow(/unknown group nope/)
    expect(() => world.seed({ groups: [{ name: 'X', roles: ['ROLE_NOPE'] }] })).toThrow(/The Given Role does not exist/)
  })

  it('keeps relations in snapshots and reports them in diffs', async () => {
    const world = createWorld()
    world.seed({ users: [{ userName: 'eva', groups: ['business'] }] })
    const before = world.snapshot()

    const group = await send(world, 'POST', `/user/${world.tenant}/groups`, { name: 'Ops' })
    await send(world, 'POST', `/user/${world.tenant}/groups/${group.body.id}/roles`, { role: { self: `${world.baseUrl}/user/roles/ROLE_ALARM_READ` } })
    await send(world, 'POST', `/user/${world.tenant}/groups/${group.body.id}/users`, { user: { self: `${world.baseUrl}/user/${world.tenant}/users/eva` } })
    const role = await send(world, 'POST', '/user/inventoryroles', { name: 'R' })
    const pump = world.device({ name: 'Pump' })
    await send(world, 'POST', `/user/${world.tenant}/users/eva/roles/inventory`, { managedObject: pump, roles: [{ id: role.body.id }] })
    await send(world, 'DELETE', `/user/${world.tenant}/groups/1`)

    const diff = world.diff(before).tenants[world.tenant]!
    expect(diff.groups.created).toMatchObject([{ name: 'Ops', roles: ['ROLE_ALARM_READ'] }])
    expect(diff.groups.deleted).toMatchObject([{ name: 'business' }])
    expect(diff.users.updated).toMatchObject([{ before: { groups: ['1'] }, after: { groups: [String(group.body.id)] } }])
    expect(diff.inventoryRoles.created).toMatchObject([{ name: 'R' }])
    expect(diff.inventoryAssignments.created).toMatchObject([{ user: 'eva', managedObject: pump, roles: [String(role.body.id)] }])

    const after = world.snapshot()
    world.restore(before)
    expect(world.db.groups.find({ name: 'Ops' })).toEqual([])
    world.restore(JSON.parse(JSON.stringify(after)))
    expect(world.db.users.effectiveRoles('eva')).toEqual([...NEW_USER_ROLES, 'ROLE_ALARM_READ'])
    // the sequences come back too: the next group gets the next id
    expect((await send(world, 'POST', `/user/${world.tenant}/groups`, { name: 'Next' })).body.id).toBe(group.body.id + 1)
  })

  it('restores a snapshot without user management with the default content', () => {
    const world = createWorld()
    const snapshot = world.snapshot()
    for (const tenant of snapshot.tenants) {
      delete tenant.users
      delete tenant.groups
      delete tenant.roles
      delete tenant.inventoryRoles
      delete tenant.inventoryAssignments
      delete tenant.sequences
    }
    world.restore(snapshot)
    expect(world.db.groups.find()).toHaveLength(12)
  })

  it('writes the platform\'s audit records for user writes, none for group writes', async () => {
    const world = createWorld()
    const T = world.tenant
    const pump = world.device({ name: 'Pump' })
    const texts = () => world.db.auditRecords.find().map((record) => record.text)
    await send(world, 'POST', `/user/${T}/users`, { userName: 'ev.a', email: 'ev.a@example.com', password: 'Audit-Pass-1' })
    await send(world, 'PUT', `/user/${T}/users/ev.a`, { firstName: 'Eva', lastName: 'Ten', enabled: false, phone: '+48123456789' })
    await send(world, 'POST', `/user/${T}/users/ev.a/roles`, { role: { self: `${world.baseUrl}/user/roles/ROLE_ALARM_READ` } })
    await send(world, 'POST', `/user/${T}/users/ev.a/roles`, { role: { self: `${world.baseUrl}/user/roles/ROLE_ALARM_READ` } })
    const group = await send(world, 'POST', `/user/${T}/groups`, { name: 'Readers' })
    await send(world, 'PUT', `/user/${T}/groups/${group.body.id}`, { name: 'Readers' })
    await send(world, 'POST', `/user/${T}/groups/${group.body.id}/users`, { user: { self: `${world.baseUrl}/user/${T}/users/ev.a` } })
    await send(world, 'POST', `/user/${T}/groups/${group.body.id}/roles`, { role: { self: `${world.baseUrl}/user/roles/ROLE_EVENT_READ` } })
    await send(world, 'POST', `/user/${T}/users/ev.a/roles/inventory`, { managedObject: pump, roles: [{ id: 1 }] })
    const role = await send(world, 'POST', '/user/inventoryroles', { name: 'Reader2', permissions: [{ permission: 'READ', scope: 'ALARM', type: '*' }] })
    await send(world, 'PUT', `/user/inventoryroles/${role.body.id}`, { name: 'Reader3', permissions: [{ permission: 'ADMIN', scope: 'EVENT', type: '*' }] })
    await send(world, 'DELETE', `/user/inventoryroles/${role.body.id}`)
    await send(world, 'DELETE', `/user/${T}/groups/${group.body.id}/users/ev.a`)
    await send(world, 'DELETE', `/user/${T}/users/ev.a/roles/ROLE_ALARM_READ`)
    await send(world, 'DELETE', `/user/${T}/groups/${group.body.id}`)
    await send(world, 'DELETE', `/user/${T}/users/ev.a`)
    expect(texts()).toEqual([
      'User ev.a created',
      'User ev.a updated: enabled=\'false\', lastname=\'Ten\', firstname=\'Eva\'',
      'User ev.a updated: roles [\'ROLE_ALARM_READ\'] added',
      'User ev.a updated: global roles [\'Readers\'] added',
      'Global Role Readers updated: roles [\'ROLE_EVENT_READ\'] added',
      `User ev.a updated: inventoryAssignment ['(managedObject=${pump}, roles=[Reader])'] added`,
      'Inventory Role Reader2 created',
      'Inventory Role Reader3 updated: permissions [\'EVENT:*:ADMIN\'] added, name=\'Reader3\', permissions [\'ALARM:*:READ\'] removed',
      'Inventory Role Reader3 removed',
      'User ev.a updated: global roles [\'Readers\'] removed',
      'User ev.a updated: roles [\'ROLE_ALARM_READ\'] removed',
      'User ev.a deleted',
    ])
    expect(world.db.auditRecords.find({ text: 'User ev.a created' })).toMatchObject([{ type: 'User', activity: 'User created', source: { id: 'ev.a' } }])
    // seeding writes none
    world.seed({ users: [{ userName: 'quiet' }] })
    expect(texts()).toHaveLength(12)
  })

  it('reports a request with another tenant id in the path as forbidden, not unsupported', async () => {
    const world = createWorld()
    expect((await get(world, '/user/t999/users')).status).toBe(403)
    // verified: the user API answers an unknown path with an empty 404
    expect((await world.fetch(new Request(`${world.baseUrl}/user/t999/nope`))).status).toBe(404)
    expect(world.unhandled).toEqual([])
  })
})

describe('switching the current user', () => {
  const as = (world: World, name: string, path = '/user/currentUser') => world.fetch(new Request(`${world.baseUrl}${path}`, { headers: { authorization: `Basic ${btoa(`${world.tenant}/${name}:x`)}`, accept: 'application/json' } }))

  it('removes a user that setUser() created when the user changes again', async () => {
    const world = createWorld()
    const before = world.snapshot()
    const admin = world.user
    world.setUser({ userName: 'persona', roles: ['ROLE_ALARM_READ'] })
    // the user the world started with stays stored
    expect(world.db.users.get(admin!.userName)).toBeDefined()
    expect((await (await as(world, 'persona')).json()).effectiveRoles.map((role: any) => role.id)).toEqual(['ROLE_ALARM_READ'])
    world.setUser(admin)
    expect(world.db.users.get('persona')).toBeUndefined()
    // in-flight work with the persona's credentials stays unrestricted
    expect((await as(world, 'persona', '/inventory/managedObjects')).status).toBe(200)
    expect(world.diff(before)).toEqual({ tenants: {}, options: [] })
  })

  it('puts a seeded user back with its roles', async () => {
    const world = createWorld()
    world.seed({ users: [{ userName: 'operator', roles: ['ROLE_INVENTORY_READ'] }] })
    const seeded = world.db.users.get('operator')
    const admin = world.user
    world.setUser({ userName: 'operator', roles: [] })
    expect(world.db.users.get('operator')?.roles.references).toEqual([])
    world.setUser(admin)
    expect(world.db.users.get('operator')).toEqual(seeded)
    expect(world.db.users.effectiveRoles('operator')).toEqual(expect.arrayContaining(['ROLE_INVENTORY_READ', ...NEW_USER_ROLES]))
    expect((await as(world, 'operator')).status).toBe(200)
  })

  it('keeps changes the API made to the user while it was current, across switches, until reset()', async () => {
    const world = createWorld()
    world.seed({ users: [{ userName: 'olivia', roles: [] }] })
    const admin = world.user
    world.setUser({ userName: 'olivia', roles: [] })
    expect((await send(world, 'POST', `/user/${world.tenant}/groups/2/users`, { user: { self: `${world.baseUrl}/user/${world.tenant}/users/olivia` } })).status).toBe(201)
    for (let round = 0; round < 3; round++) {
      world.setUser(admin)
      expect(world.db.users.effectiveRoles('olivia')).toContain('ROLE_INVENTORY_ADMIN')
      expect((await as(world, 'olivia', '/inventory/managedObjects')).status).toBe(200)
      world.setUser({ userName: 'olivia', roles: [] })
      expect(world.db.users.effectiveRoles('olivia')).toContain('ROLE_INVENTORY_ADMIN')
    }
    world.setUser(admin)
    expect(world.db.users.effectiveRoles('olivia')).toContain('ROLE_INVENTORY_ADMIN')
    world.reset()
    expect(world.db.users.get('olivia')).toBeUndefined()
  })

  it('lets two personas take turns without a 403', async () => {
    const world = createWorld()
    for (const name of ['a', 'b', 'a', 'b']) {
      world.setUser({ userName: name, roles: [] })
      for (const other of ['a', 'b']) {
        expect((await as(world, other, '/inventory/managedObjects')).status).toBe(200)
      }
    }
  })

  it('restores the base user on a fork and after its reset()', () => {
    const base = createWorld()
    base.seed({ users: [{ userName: 'operator', roles: ['ROLE_INVENTORY_READ'] }] })
    const seeded = base.db.users.get('operator')
    base.setUser({ userName: 'operator', roles: [] })
    const fork = base.fork()
    fork.setUser({ userName: 'other', roles: [] })
    expect(fork.db.users.get('operator')).toEqual(seeded)
    expect(base.db.users.get('operator')?.roles.references).toEqual([])
    fork.reset()
    expect(fork.db.users.get('operator')?.roles.references).toEqual([])
    fork.setUser(null)
    expect(fork.db.users.get('operator')).toEqual(seeded)
  })
})
