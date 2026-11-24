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

  it('seeds a user with its own tenant into that tenant, with the seed\'s custom roles', async () => {
    const world = createWorld({ tenant: 't12345' })
    const result = world.seed({
      roles: ['ROLE_PUMP_ADMIN'],
      users: [
        { userName: 'anna', roles: ['ROLE_PUMP_ADMIN'] },
        { userName: 'eve', roles: ['ROLE_PUMP_ADMIN', 'ROLE_ALARM_READ'], tenant: 't99999' },
        { userName: 'otto', tenant: 't12345' },
      ],
    })
    expect(result.users).toEqual(['anna', 'eve', 'otto'])
    expect(result.roles).toEqual(['ROLE_PUMP_ADMIN'])
    expect(world.db.users.get('eve')).toBeUndefined()
    expect(world.db.users.get('anna')).toBeDefined()
    const eve = world.db.tenant('t99999').users.get('eve')!
    expect(eve).toBeDefined()
    // the tenant is where the user lives, not a user field
    expect(eve).not.toHaveProperty('tenant')
    expect(world.db.users.get('otto')).not.toHaveProperty('tenant')
    expect(world.db.tenant('t99999').users.effectiveRoles('eve')).toEqual(expect.arrayContaining(['ROLE_PUMP_ADMIN', 'ROLE_ALARM_READ']))
    expect(world.db.tenant('t99999').roles.get('ROLE_PUMP_ADMIN')).toBeDefined()
    expect(world.db.roles.get('ROLE_PUMP_ADMIN')).toBeDefined()
    // the user API of its tenant answers for it
    const answer = await world.fetch(new Request(`${world.baseUrl}/user/currentUser`, { headers: { authorization: `Basic ${btoa('t99999/eve:x')}`, accept: 'application/json' } }))
    expect((await answer.json()).effectiveRoles.map((role: any) => role.id)).toContain('ROLE_PUMP_ADMIN')
  })

  it('rejects a user of another tenant with groups or inventory assignments before writing anything', () => {
    const world = createWorld({ tenant: 't12345' })
    const pump = world.device({ name: 'Pump' })
    const tenants = () => world.snapshot().tenants.map((data) => data.tenant)
    const before = world.snapshot()
    expect(() => world.seed({
      roles: ['ROLE_PUMP_ADMIN'],
      groups: [{ name: 'Operators' }],
      users: [{ userName: 'anna' }, { userName: 'gus', tenant: 't77777' }, { userName: 'eve', tenant: 't99999', groups: ['Operators'] }],
    })).toThrow(new TypeError('seed(): user eve has tenant t99999, but the seed is for t12345 and its groups would be looked up there: seed it with { tenant: \'t99999\' }'))
    expect(() => world.seed({
      users: [{ userName: 'eve', tenant: 't99999', inventoryAssignments: [{ managedObject: pump, roles: ['Reader'] }] }],
    })).toThrow(/user eve has tenant t99999.*inventoryAssignments.*seed it with \{ tenant: 't99999' \}/)
    expect(() => world.seed({ roles: ['ROLE_PUMP_ADMIN'], users: [{ userName: 'eve', tenant: 42 as unknown as string }] })).toThrow(/invalid user eve: tenant must be a non-empty string/)
    expect(() => world.seed({ roles: ['ROLE_PUMP_ADMIN'], users: [{ userName: 'eve', tenant: '' }] })).toThrow(/invalid user eve: tenant must be a non-empty string/)
    expect(world.db.users.get('anna')).toBeUndefined()
    expect(world.db.roles.get('ROLE_PUMP_ADMIN')).toBeUndefined()
    expect(world.db.groups.find({ name: 'Operators' })).toEqual([])
    // the other tenants were not even created
    expect(tenants()).toEqual(['t12345'])
    expect(world.diff(before)).toEqual(world.diff(world.snapshot()))
    // empty lists reference nothing
    world.seed({ users: [{ userName: 'eve', tenant: 't99999', groups: [], inventoryAssignments: [] }] })
    expect(world.db.tenant('t99999').users.get('eve')).toBeDefined()
  })

  it('rejects duplicate names and unknown roles of any tenant before writing anything', () => {
    const world = createWorld({ tenant: 't12345', user: { userName: 'me', roles: [] } })
    world.seed({ users: [{ userName: 'eve', tenant: 't99999' }] })
    const tenants = () => world.snapshot().tenants.map((data) => data.tenant).sort()
    const before = world.snapshot()
    const attempts: Array<[Parameters<typeof world.seed>[0], RegExp]> = [
      // unknown role in a tenant the world does not have yet
      [{ roles: ['ROLE_Z'], users: [{ userName: 'gus', tenant: 't55555', roles: ['ROLE_NOPE'] }] }, /invalid user gus: The Given Role does not exist/],
      // unknown role in the seed's tenant, after a user of another tenant
      [{ roles: ['ROLE_Z'], users: [{ userName: 'gus', tenant: 't55555' }, { userName: 'hal', roles: ['ROLE_NOPE'] }] }, /invalid user hal: The Given Role does not exist/],
      // duplicate against a stored user of the other tenant
      [{ roles: ['ROLE_Z'], users: [{ userName: 'gus', tenant: 't55555' }, { userName: 'eve', tenant: 't99999' }] }, /invalid user eve: User with username or alias 'eve' already exists/],
      // duplicate within the seed
      [{ roles: ['ROLE_Z'], users: [{ userName: 'gus', tenant: 't55555' }, { userName: 'gus', tenant: 't55555' }] }, /invalid user gus: User with username or alias 'gus' already exists/],
      // the world's current user is stored in its tenant (existing behavior)
      [{ roles: ['ROLE_Z'], users: [{ userName: 'gus', tenant: 't55555' }, { userName: 'me' }] }, /invalid user me: User with username or alias 'me' already exists/],
    ]
    for (const [seed, error] of attempts) {
      expect(() => world.seed(seed)).toThrow(error)
    }
    expect(tenants()).toEqual(['t12345', 't99999'])
    expect(world.db.roles.get('ROLE_Z')).toBeUndefined()
    expect(world.db.tenant('t99999').roles.get('ROLE_Z')).toBeUndefined()
    expect(world.diff(before)).toEqual(world.diff(world.snapshot()))
    // the seed's own roles count, and the same name in two tenants is two users
    const result = world.seed({ roles: ['ROLE_Z'], users: [{ userName: 'gus', tenant: 't55555', roles: ['ROLE_Z'] }, { userName: 'gus', roles: ['ROLE_Z'] }] })
    expect(result.users).toEqual(['gus', 'gus'])
    expect(world.db.users.get('gus')).toBeDefined()
    expect(world.db.tenant('t55555').users.effectiveRoles('gus')).toContain('ROLE_Z')
  })

  it('seeds users of three tenants in one seed and returns them in input order', () => {
    const world = createWorld({ tenant: 't12345' })
    const result = world.seed({
      tenant: 't20000',
      users: [
        { userName: 'a' },
        { userName: 'b', tenant: 't30000' },
        { userName: 'c', tenant: 't12345' },
        { userName: 'd', tenant: null },
        { userName: 'e', tenant: 't30000' },
        { userName: 'f', tenant: 't20000' },
      ],
    })
    expect(result.users).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    const names = (name: string) => world.db.tenant(name).users.find({}).map((user) => user.userName).filter((userName) => userName.length === 1).sort()
    expect(names('t20000')).toEqual(['a', 'd', 'f'])
    expect(names('t30000')).toEqual(['b', 'e'])
    expect(names('t12345')).toEqual(['c'])
  })

  it('seeds users of other tenants into a fork only, and throws on a frozen base', () => {
    const base = createWorld({ tenant: 't12345' })
    base.seed({ users: [{ userName: 'eve', tenant: 't99999' }] })
    const fork = base.fork()
    expect(() => base.seed({ users: [{ userName: 'mallory', tenant: 't99999' }] })).toThrow(/this world is frozen/)
    // a tenant the base does not have
    expect(() => base.seed({ users: [{ userName: 'mallory', tenant: 't44444' }] })).toThrow(/this world is frozen/)
    expect(() => base.seed({ tenant: 't44444', users: [{ userName: 'mallory' }] })).toThrow(/this world is frozen/)
    expect(base.snapshot().tenants.map((data) => data.tenant).sort()).toEqual(['t12345', 't99999'])
    fork.seed({ users: [{ userName: 'mallory', tenant: 't99999' }, { userName: 'zoe', tenant: 't55555' }] })
    expect(() => fork.seed({ users: [{ userName: 'eve', tenant: 't99999' }] })).toThrow(/invalid user eve: User with username or alias 'eve' already exists/)
    expect(fork.db.tenant('t99999').users.get('eve')).toBeDefined()
    expect(fork.db.tenant('t99999').users.get('mallory')).toBeDefined()
    expect(fork.db.tenant('t55555').users.get('zoe')).toBeDefined()
    expect(base.db.tenant('t99999').users.get('mallory')).toBeUndefined()
    expect(base.db.tenant('t55555').users.get('zoe')).toBeUndefined()
    expect(base.fork().db.tenant('t99999').users.get('mallory')).toBeUndefined()
    fork.reset()
    expect(fork.db.tenant('t99999').users.get('eve')).toBeDefined()
    expect(fork.db.tenant('t99999').users.get('mallory')).toBeUndefined()
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

  it('rejects a user name over 1,000 characters', async () => {
    const world = createWorld()
    const create = (userName: string) => send(world, 'POST', `/user/${world.tenant}/users`, { userName, email: `${userName.length}@example.com`, password: 'Secret-pass-123!' })
    expect((await create('u'.repeat(1001))).status).toBe(422)
    expect((await create('u'.repeat(1000))).status).toBe(201)
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

describe('PUT /user/currentUser', () => {
  const USER_TYPE = 'application/vnd.com.nsn.cumulocity.user+json'
  const put = async (world: World, body: unknown, headers: Record<string, string> = { 'accept': USER_TYPE, 'content-type': USER_TYPE }) => {
    const response = await world.fetch(new Request(`${world.baseUrl}/user/currentUser`, { method: 'PUT', headers, body: JSON.stringify(body) }))
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
  const short = { 'accept': 'application/json', 'content-type': 'application/json' }
  const texts = (world: World) => world.db.auditRecords.find().map((record) => record.text)

  it('writes one audit record by the user with every changed profile field, none for custom properties alone', async () => {
    const world = createWorld({ user: { userName: 'eva', email: 'eva@example.com' } })
    expect((await put(world, { customProperties: { language: 'de' } })).status).toBe(200)
    expect(texts(world)).toEqual([])
    expect((await put(world, { firstName: 'Eva', lastName: 'Ten', displayName: 'E', phone: '+48123456789', email: 'eva2@example.com', shouldResetPassword: true })).status).toBe(200)
    expect((await put(world, { requiredAuthType: 'CERTIFICATES', firstName: 'Eve' }, short)).status).toBe(200)
    expect(texts(world)).toEqual([
      'User eva updated: lastname=\'Ten\', firstname=\'Eva\', email=\'eva2@example.com\', phone=\'+48123456789\', displayName=\'E\', shouldResetPassword=\'true\'',
      'User eva updated: firstname=\'Eve\', requiredAuthType=\'CERTIFICATES\'',
    ])
    expect(world.db.auditRecords.find()[0]).toMatchObject({ type: 'User', activity: 'User updated', user: 'eva', source: { id: 'eva' } })
  })

  it('keeps requiredAuthType as a plain field of the stored user, written only in short mode', async () => {
    const world = createWorld({ user: { userName: 'eva', email: 'eva@example.com' } })
    expect((await put(world, { requiredAuthType: 'CERTIFICATES' })).body).not.toHaveProperty('requiredAuthType')
    expect((await put(world, { requiredAuthType: 'TFA' }, short)).body.requiredAuthType).toBe('NONE')
    const answer = await put(world, { requiredAuthType: 'CERTIFICATES' }, short)
    expect(answer).toMatchObject({ status: 200, body: { requiredAuthType: 'CERTIFICATES' } })
    // the short answer of an update has no effectiveRoles, the GET's has
    expect(answer.body).not.toHaveProperty('effectiveRoles')
    expect((await get(world, '/user/currentUser')).body.effectiveRoles).toEqual(expect.any(Array))
    expect(world.snapshot().tenants.find((tenant) => tenant.tenant === world.tenant)!.users!.find((user: any) => user.id === 'eva')).toMatchObject({ requiredAuthType: 'CERTIFICATES' })
    // the user API and the full shape leave it out
    expect((await get(world, `/user/${world.tenant}/users/eva`)).body).not.toHaveProperty('requiredAuthType')
    expect((await get(world, '/user/currentUser')).body.requiredAuthType).toBe('CERTIFICATES')
  })

  it('writes only the short mode fields with another answer type, and stores the email as given', async () => {
    const world = createWorld({ user: { userName: 'eva', email: 'eva@example.com' } })
    const answer = await put(world, { email: 'not an email', displayName: 'D', newsletter: true, enabled: false, customProperties: { a: 1 }, id: 'x', other: 1 }, short)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ email: 'not an email' })
    const stored = world.db.users.get('eva')!
    expect(stored).toMatchObject({ email: 'not an email', enabled: true })
    expect(stored).not.toHaveProperty('displayName')
    expect(stored).not.toHaveProperty('newsletter')
    expect(stored.customProperties).not.toHaveProperty('a')
    // a wildcard or no Accept header answers without a body
    expect(await put(world, { firstName: 'E' }, { 'content-type': 'application/json' })).toEqual({ status: 200, body: undefined })
    // mixed headers: JSON before the currentuser type before the user type, the highest q first
    const CURRENT_USER_TYPE = 'application/vnd.com.nsn.cumulocity.currentuser+json'
    for (const accept of [`${USER_TYPE}, application/json`, `${USER_TYPE}, ${CURRENT_USER_TYPE}`, `${USER_TYPE};q=0.1, ${CURRENT_USER_TYPE};q=0.5`]) {
      const mixed = await put(world, { displayName: 'D', customProperties: { b: 1 } }, { accept, 'content-type': 'application/json' })
      expect(mixed.body, accept).toHaveProperty('requiredAuthType')
      expect(mixed.body, accept).not.toHaveProperty('customProperties')
    }
    expect(world.db.users.get('eva')).not.toHaveProperty('displayName')
    expect(world.db.users.get('eva')?.customProperties).not.toHaveProperty('b')
    const weighted = await put(world, { displayName: 'D' }, { 'accept': `${CURRENT_USER_TYPE};q=0.1, ${USER_TYPE}`, 'content-type': 'application/json' })
    expect(weighted.body).toMatchObject({ displayName: 'D', customProperties: expect.any(Object) })
  })

  it('validates the email, replaces devicePermissions, and ignores delegatedBy in user mode', async () => {
    const world = createWorld({ user: { userName: 'eva', email: 'eva@example.com' } })
    world.seed({ users: [{ userName: 'otto' }] })
    expect(await put(world, { email: 'not an email' })).toMatchObject({ status: 422, body: { message: 'email field must contain a valid email address' } })
    const permissions = { 12345: ['MANAGED_OBJECT:*:ADMIN'] }
    const answer = await put(world, { devicePermissions: permissions, delegatedBy: 'otto', newsletter: true })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ devicePermissions: permissions, newsletter: true })
    expect(answer.body).not.toHaveProperty('delegatedBy')
    // short mode leaves them, user mode without them clears them
    expect((await put(world, { lastName: 'L' }, short)).status).toBe(200)
    expect(world.db.users.get('eva')?.devicePermissions).toEqual(permissions)
    expect((await put(world, { lastName: 'L' })).body.devicePermissions).toEqual({})
    expect(world.db.users.get('eva')?.devicePermissions).toEqual({})
  })

  it('checks the body types in both modes and refuses a password first', async () => {
    const world = createWorld({ user: { userName: 'eva', email: 'eva@example.com' } })
    for (const headers of [short, { 'accept': USER_TYPE, 'content-type': USER_TYPE }]) {
      for (const body of [{ firstName: { a: 1 } }, { lastName: [] }, { shouldResetPassword: 'no' }]) {
        expect((await put(world, body, headers)).body, JSON.stringify(body)).toMatchObject({ error: 'Failed to parse JSON string' })
      }
      // the short mode ignores customProperties, also of the wrong type
      expect((await put(world, { customProperties: 'x' }, headers)).status).toBe(headers === short ? 200 : 400)
      expect((await put(world, { phone: 7 }, headers)).body.message).toBe('phone is required in the international phone number format +48 123 456 789')
      expect((await put(world, { userName: 'eva', phone: 7, password: '' }, headers)).body.message).toBe('Password cannot be changed with this request. Use PUT /user/currentUser/password.')
      expect((await put(world, { firstName: 7, shouldResetPassword: 'false', password: null }, headers)).status).toBe(200)
      expect(world.db.users.get('eva')).toMatchObject({ firstName: '7', shouldResetPassword: false })
      expect((await put(world, [], headers)).status).toBe(400)
    }
    // no content type at all is accepted (bytes: a string body would get text/plain)
    const response = await world.fetch(new Request(`${world.baseUrl}/user/currentUser`, { method: 'PUT', headers: { accept: USER_TYPE }, body: new TextEncoder().encode('{"lastName":"N"}') }))
    expect(response.status).toBe(200)
    expect(world.db.users.get('eva')).toMatchObject({ lastName: 'N' })
  })

  it('answers 415 for a content type that is not JSON, writing nothing', async () => {
    const world = createWorld({ user: { userName: 'eva', email: 'eva@example.com' } })
    const response = await world.fetch(new Request(`${world.baseUrl}/user/currentUser`, { method: 'PUT', headers: { 'accept': USER_TYPE, 'content-type': 'text/plain' }, body: '{"firstName":"E"}' }))
    expect(response.status).toBe(415)
    expect(world.db.users.get('eva')).not.toHaveProperty('firstName')
  })

  it('needs ROLE_USER_MANAGEMENT_OWN_ADMIN: without it 403 and nothing written', async () => {
    const world = createWorld()
    world.seed({ users: [{ userName: 'otto', roles: [] }] })
    const asOtto = () => world.fetch(new Request(`${world.baseUrl}/user/currentUser`, { method: 'PUT', headers: { 'authorization': `Basic ${btoa(`${world.tenant}/otto:x`)}`, 'accept': USER_TYPE, 'content-type': USER_TYPE }, body: JSON.stringify({ lastName: 'x' }) }))
    expect((await asOtto()).status).toBe(200)
    expect(world.db.users.get('otto')).toMatchObject({ lastName: 'x' })
    expect((await send(world, 'PUT', `/user/${world.tenant}/users/otto`, { lastName: 'y' })).status).toBe(200)
    expect((await send(world, 'DELETE', `/user/${world.tenant}/users/otto/roles/ROLE_USER_MANAGEMENT_OWN_ADMIN`)).status).toBe(204)
    const records = texts(world).length
    const denied = await asOtto()
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: 'security/Forbidden' })
    expect(world.db.users.get('otto')).toMatchObject({ lastName: 'y' })
    expect(texts(world)).toHaveLength(records)
  })

  it('lets a user disable itself: the next request answers 401', async () => {
    const world = createWorld({ user: { userName: 'eva', email: 'eva@example.com' } })
    expect((await put(world, { enabled: false })).body).toMatchObject({ enabled: false })
    expect((await get(world, '/user/currentUser')).status).toBe(401)
  })

  it('answers 403 for an application user and 404 for the world user deleted through the API (unverified)', async () => {
    const world = createWorld({ user: { userName: 'eva', email: 'eva@example.com' }, roles: 'off' })
    world.service('svc', async () => new Response(null), { manifest: { name: 'svc', requiredRoles: ['ROLE_USER_MANAGEMENT_OWN_ADMIN'] } })
    const service = world.db.applications.find({ name: 'svc' })[0]!
    const bootstrap = await world.fetch(new Request(`${world.baseUrl}/application/applications/${service.id}/bootstrapUser`))
    const { name } = await bootstrap.json() as { name: string }
    const asBootstrap = await world.fetch(new Request(`${world.baseUrl}/user/currentUser`, { method: 'PUT', headers: { 'authorization': `Basic ${btoa(`${world.tenant}/${name}:x`)}`, 'content-type': 'application/json', 'accept': 'application/json' }, body: '{"firstName":"E"}' }))
    expect(asBootstrap.status).toBe(403)
    expect((await send(world, 'DELETE', `/user/${world.tenant}/users/eva`)).status).toBe(204)
    expect(await put(world, { firstName: 'E' })).toMatchObject({ status: 404, body: { error: 'users/Not Found' } })
  })

  it('writes the user setUser() switched to, on a fork only, and keeps the change in snapshots', async () => {
    const base = createWorld({ user: { userName: 'eva', email: 'eva@example.com' } })
    base.seed({ users: [{ userName: 'otto' }] })
    const fork = base.fork()
    fork.setUser({ userName: 'otto', roles: [] })
    expect((await put(fork, { customProperties: { language: 'de' } })).body.userName).toBe('otto')
    expect(fork.db.users.get('otto')?.customProperties).toMatchObject({ language: 'de' })
    expect(base.db.users.get('otto')?.customProperties).not.toHaveProperty('language')
    expect(fork.diff().tenants[fork.tenant]!.users.updated).toMatchObject([{ after: { id: 'otto', customProperties: { language: 'de' } } }])
    const snapshot = fork.snapshot()
    fork.reset()
    expect(fork.db.users.get('otto')?.customProperties).not.toHaveProperty('language')
    fork.restore(snapshot)
    expect(fork.db.users.get('otto')?.customProperties).toMatchObject({ language: 'de' })
    // the full shape answers what was written
    fork.setUser({ userName: 'otto', roles: [] })
    const full = await fork.fetch(new Request(`${fork.baseUrl}/user/currentUser`, { headers: { accept: USER_TYPE } }))
    expect(await full.json()).toMatchObject({ userName: 'otto', customProperties: { language: 'de' }, supportUserEnabled: false })
  })
})
