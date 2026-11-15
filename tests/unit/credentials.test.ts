// Opt-in credential checks: `unknownUsers: 'unauthorized'` answers 401 for a
// user name the caller's tenant does not know, `passwords: 'check'` for a
// known user's wrong password. Requests without Basic auth stay the world's user.
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World, WorldOptions } from '../../src'

const UNAUTHORIZED = { error: 'security/Unauthorized', message: 'Invalid credentials!', info: 'https://cumulocity.com/api/core/' }

async function get(world: World, path: string, login?: string) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (login !== undefined) {
    headers.authorization = `Basic ${btoa(login)}`
  }
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { headers }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

function setup(options: WorldOptions = {}) {
  const world = createWorld({
    ids: 'sequential',
    user: { userName: 'me', roles: ['ROLE_INVENTORY_READ'], password: 'my-secret' },
    subscriptions: [{ tenant: 't100', user: 'service_t100', password: 'sub-secret' }],
    ...options,
  })
  world.seed({ users: [{ userName: 'alice', roles: ['ROLE_INVENTORY_READ'], password: 'alice-secret' }, { userName: 'bob', roles: ['ROLE_INVENTORY_READ'] }] })
  return world
}

describe('unknownUsers', () => {
  it('runs an unknown user unrestricted by default', async () => {
    const world = setup()
    expect((await get(world, '/inventory/managedObjects', `${world.tenant}/ghost:x`)).status).toBe(200)
  })

  it('answers 401 for an unknown user with unauthorized', async () => {
    const world = setup({ unknownUsers: 'unauthorized' })
    expect(await get(world, '/inventory/managedObjects', `${world.tenant}/ghost:x`)).toEqual({ status: 401, body: UNAUTHORIZED })
    // also the built-in routes and a known user's name in another tenant
    expect((await get(world, '/user/currentUser', `${world.tenant}/ghost:x`)).status).toBe(401)
    expect((await get(world, '/inventory/managedObjects', 't100/alice:alice-secret')).status).toBe(401)
    expect(world.calls).toHaveLength(3)
  })

  it('knows the world user, its microservice users, and stored users, with any password', async () => {
    const world = setup({ unknownUsers: 'unauthorized' })
    for (const login of [`${world.tenant}/me:x`, `${world.tenant}/servicebootstrap_test:x`, 't100/service_t100:x', `${world.tenant}/alice:x`, `${world.tenant}/bob:x`, 'alice:x']) {
      expect((await get(world, '/inventory/managedObjects', login)).status, login).toBe(200)
    }
  })

  it('leaves requests without Basic auth to the world user', async () => {
    const world = setup({ unknownUsers: 'unauthorized', passwords: 'check' })
    expect(await get(world, '/user/currentUser')).toMatchObject({ status: 200, body: { userName: 'me' } })
  })

  it('knows users created through the API and forgets deleted ones', async () => {
    const world = setup({ unknownUsers: 'unauthorized' })
    const created = await world.fetch(new Request(`${world.baseUrl}/user/${world.tenant}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: 'carol', email: 'carol@example.com', password: 'Carol-Secret-1' }),
    }))
    expect(created.status).toBe(201)
    expect((await get(world, '/user/currentUser', `${world.tenant}/carol:any`)).status).toBe(200)
    await world.fetch(new Request(`${world.baseUrl}/user/${world.tenant}/users/carol`, { method: 'DELETE' }))
    expect((await get(world, '/user/currentUser', `${world.tenant}/carol:any`)).status).toBe(401)
  })
})

describe('passwords', () => {
  it('accepts any password by default', async () => {
    const world = setup()
    expect((await get(world, '/user/currentUser', `${world.tenant}/alice:wrong`)).status).toBe(200)
  })

  it('answers 401 for a wrong password with check', async () => {
    const world = setup({ passwords: 'check' })
    const cases: Array<[string, number]> = [
      [`${world.tenant}/alice:alice-secret`, 200],
      [`${world.tenant}/alice:wrong`, 401],
      [`${world.tenant}/me:my-secret`, 200],
      [`${world.tenant}/me:wrong`, 401],
      ['t100/service_t100:sub-secret', 200],
      ['t100/service_t100:wrong', 401],
      // without a password, any works
      [`${world.tenant}/bob:anything`, 200],
      [`${world.tenant}/servicebootstrap_test:anything`, 200],
      // unknown users follow unknownUsers
      [`${world.tenant}/ghost:anything`, 200],
    ]
    for (const [login, status] of cases) {
      expect((await get(world, '/user/currentUser', login)).status, login).toBe(status)
    }
    expect(await get(world, '/inventory/managedObjects', `${world.tenant}/alice:wrong`)).toEqual({ status: 401, body: UNAUTHORIZED })
  })

  it('never renders the password', async () => {
    const world = setup()
    expect(world.db.users.find({ userName: 'alice' })[0]).not.toHaveProperty('password')
    expect(world.db.users.find({ userName: 'alice' })[0]).not.toHaveProperty('__password')
    const me = await get(world, '/user/currentUser')
    expect(me.body).not.toHaveProperty('password')
    expect(me.body).not.toHaveProperty('__password')
    expect(JSON.stringify((await get(world, `/user/${world.tenant}/users/alice`)).body)).not.toContain('alice-secret')
  })

  it('checks the password a user was created with and the one it sets', async () => {
    // roles off: only the password matters here
    const world = setup({ passwords: 'check', roles: 'off' })
    const send = (method: string, path: string, body: unknown, login?: string) => world.fetch(new Request(`${world.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(login ? { authorization: `Basic ${btoa(login)}` } : {}) },
      body: JSON.stringify(body),
    }))
    expect((await send('POST', `/user/${world.tenant}/users`, { userName: 'carol', email: 'carol@example.com', password: 'Carol-Secret-1' })).status).toBe(201)
    expect((await get(world, '/user/currentUser', `${world.tenant}/carol:wrong`)).status).toBe(401)
    expect((await get(world, '/user/currentUser', `${world.tenant}/carol:Carol-Secret-1`)).status).toBe(200)
    // only the user itself sets its password
    expect((await send('PUT', `/user/${world.tenant}/users/carol`, { password: 'Carol-Secret-2' }, `${world.tenant}/carol:Carol-Secret-1`)).status).toBe(200)
    expect((await get(world, '/user/currentUser', `${world.tenant}/carol:Carol-Secret-1`)).status).toBe(401)
    expect((await get(world, '/user/currentUser', `${world.tenant}/carol:Carol-Secret-2`)).status).toBe(200)
  })

  it('checks the passwords of a registered service\'s users, which its fetch() sends', async () => {
    const world = createWorld({ passwords: 'check', unknownUsers: 'unauthorized' })
    world.service('svc', async (_request, ctx) => {
      const response = await ctx.fetch('/application/currentApplication/settings')
      return Response.json({ status: response.status, serviceUser: ctx.serviceUser })
    })
    const answer = await get(world, '/service/svc/anything')
    expect(answer).toEqual({ status: 200, body: { status: 200, serviceUser: expect.any(String) } })
    const serviceUser = answer.body.serviceUser as string
    expect((await get(world, '/user/currentUser', `${world.tenant}/${serviceUser}:wrong`)).status).toBe(401)

    const applications = await get(world, '/application/applications?name=svc')
    const id = applications.body.applications[0].id as string
    const bootstrap = await get(world, `/application/applications/${id}/bootstrapUser`)
    expect((await get(world, '/application/currentApplication', `${world.tenant}/${bootstrap.body.name}:${bootstrap.body.password}`)).status).toBe(200)
    expect((await get(world, '/application/currentApplication', `${world.tenant}/${bootstrap.body.name}:wrong`)).status).toBe(401)
    const subscriptions = await get(world, '/application/currentApplication/subscriptions', `${world.tenant}/${bootstrap.body.name}:${bootstrap.body.password}`)
    const { name, password } = subscriptions.body.users[0]
    expect((await get(world, '/user/currentUser', `${world.tenant}/${name}:${password}`)).status).toBe(200)
  })
})

describe('forks', () => {
  it('sets both on a fork, which falls back to its base', async () => {
    const base = setup()
    const strict = base.fork({ unknownUsers: 'unauthorized', passwords: 'check' })
    const inherited = strict.fork()
    const lenient = strict.fork({ unknownUsers: 'allow', passwords: 'off' })
    expect((await get(base, '/user/currentUser', `${base.tenant}/ghost:x`)).status).toBe(200)
    expect((await get(strict, '/user/currentUser', `${base.tenant}/ghost:x`)).status).toBe(401)
    expect((await get(strict, '/user/currentUser', `${base.tenant}/alice:wrong`)).status).toBe(401)
    expect((await get(inherited, '/user/currentUser', `${base.tenant}/alice:wrong`)).status).toBe(401)
    expect((await get(lenient, '/user/currentUser', `${base.tenant}/ghost:x`)).status).toBe(200)
    expect((await get(lenient, '/user/currentUser', `${base.tenant}/alice:wrong`)).status).toBe(200)
  })
})

async function send(world: World, method: string, path: string, body: unknown, login?: string) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, {
    method,
    headers: { 'accept': 'application/json', 'content-type': 'application/json', ...(login !== undefined ? { authorization: `Basic ${btoa(login)}` } : {}) },
    body: JSON.stringify(body),
  }))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

const status = async (world: World, login: string, path = '/user/currentUser') => (await get(world, path, login)).status

describe('passwords: changes', () => {
  it('keeps the password when another user or a request without Basic auth tries to change it', async () => {
    const world = setup({ passwords: 'check', roles: 'off' })
    const t = world.tenant
    expect(await send(world, 'PUT', `/user/${t}/users/alice`, { password: 'Other-Secret-1' }, `${t}/bob:any`)).toMatchObject({ status: 422, body: { message: 'Cannot change password for another user.' } })
    expect((await send(world, 'PUT', `/user/${t}/users/alice`, { password: 'Other-Secret-1' })).status).toBe(422)
    expect(await status(world, `${t}/alice:alice-secret`)).toBe(200)
    expect(await status(world, `${t}/alice:Other-Secret-1`)).toBe(401)
  })

  it('keeps the password on an update without one', async () => {
    const world = setup({ passwords: 'check', roles: 'off' })
    const t = world.tenant
    expect((await send(world, 'PUT', `/user/${t}/users/alice`, { firstName: 'Alice' }, `${t}/alice:alice-secret`)).status).toBe(200)
    expect(await status(world, `${t}/alice:alice-secret`)).toBe(200)
    expect(await status(world, `${t}/alice:wrong`)).toBe(401)
  })

  it('accepts any password for a user created through the API without one', async () => {
    const world = setup({ passwords: 'check', roles: 'off' })
    expect((await send(world, 'POST', `/user/${world.tenant}/users`, { userName: 'dave', email: 'dave@example.com', sendPasswordResetEmail: true })).status).toBe(201)
    expect(await status(world, `${world.tenant}/dave:anything`)).toBe(200)
  })

  it('lets the world user change its own password', async () => {
    const world = setup({ passwords: 'check', roles: 'off' })
    const t = world.tenant
    expect((await send(world, 'PUT', `/user/${t}/users/me`, { password: 'My-Secret-2' }, `${t}/me:my-secret`)).status).toBe(200)
    expect(await status(world, `${t}/me:my-secret`)).toBe(401)
    expect(await status(world, `${t}/me:My-Secret-2`)).toBe(200)
    expect(await get(world, '/user/currentUser')).toMatchObject({ status: 200, body: { userName: 'me' } })
  })

  it('treats an empty password as none', async () => {
    const world = createWorld({ passwords: 'check', user: { userName: 'me', password: '' } })
    world.seed({ users: [{ userName: 'erin', password: '' }] })
    expect(await status(world, `${world.tenant}/erin:anything`)).toBe(200)
    expect(await status(world, `${world.tenant}/me:anything`)).toBe(200)
  })
})

describe('passwords: Basic auth parsing', () => {
  it('takes everything after the first colon as the password', async () => {
    const world = setup({ passwords: 'check' })
    world.seed({ users: [{ userName: 'colon', password: 'a:b:c' }] })
    expect(await status(world, `${world.tenant}/colon:a:b:c`)).toBe(200)
    expect(await status(world, `${world.tenant}/colon:a`)).toBe(401)
  })

  it('reads credentials without a colon as an empty password', async () => {
    const world = setup({ passwords: 'check' })
    expect(await status(world, `${world.tenant}/alice`)).toBe(401)
    expect(await status(world, `${world.tenant}/bob`)).toBe(200)
  })
})

describe('each option alone', () => {
  it('checks no password with unknownUsers alone', async () => {
    const world = setup({ unknownUsers: 'unauthorized', passwords: 'off' })
    expect(await status(world, `${world.tenant}/alice:wrong`)).toBe(200)
    expect(await status(world, `${world.tenant}/ghost:x`)).toBe(401)
  })

  it('lets unknown users through with passwords alone', async () => {
    const world = setup({ unknownUsers: 'allow', passwords: 'check' })
    expect(await status(world, `${world.tenant}/ghost:x`)).toBe(200)
    expect(await status(world, `${world.tenant}/alice:wrong`)).toBe(401)
  })
})

describe('disabled users', () => {
  it('answers a wrong password before the locked account', async () => {
    const world = setup({ passwords: 'check' })
    world.seed({ users: [{ userName: 'locked', password: 'locked-secret', enabled: false }] })
    expect(await get(world, '/user/currentUser', `${world.tenant}/locked:wrong`)).toEqual({ status: 401, body: UNAUTHORIZED })
    expect(await get(world, '/user/currentUser', `${world.tenant}/locked:locked-secret`)).toMatchObject({ status: 401, body: { message: 'Authentication failed! : User account is locked' } })
  })
})

describe('service users of another subscribed tenant', () => {
  it('checks them in their tenant and their fetch() passes', async () => {
    const world = createWorld({ passwords: 'check', unknownUsers: 'unauthorized' })
    world.service('svc', async (_request, ctx) => {
      const response = await ctx.fetch('/application/currentApplication/settings')
      return Response.json({ status: response.status, tenant: ctx.tenant })
    }, { tenants: [world.tenant, 't200'] })
    const id = (await get(world, '/application/applications?name=svc')).body.applications[0].id as string
    const bootstrap = (await get(world, `/application/applications/${id}/bootstrapUser`)).body
    const { users } = (await get(world, '/application/currentApplication/subscriptions', `${world.tenant}/${bootstrap.name}:${bootstrap.password}`)).body
    const other = users.find((entry: { tenant: string }) => entry.tenant === 't200')
    expect(other).toBeDefined()
    expect(await status(world, `t200/${other.name}:${other.password}`)).toBe(200)
    expect(await status(world, `t200/${other.name}:wrong`)).toBe(401)
    expect(await get(world, '/service/svc/x', `t200/${other.name}:${other.password}`)).toEqual({ status: 200, body: { status: 200, tenant: 't200' } })
  })
})

describe('the password is never rendered', () => {
  const leaks = (value: unknown) => JSON.stringify(value).includes('__password') || JSON.stringify(value).includes('secret')

  it('not for the world user, the user list, currentUser, or a fork', async () => {
    const world = setup()
    expect(leaks(world.db.users.find({ userName: 'me' }))).toBe(false)
    expect(leaks((await get(world, `/user/${world.tenant}/users`)).body)).toBe(false)
    expect(leaks((await get(world, '/user/currentUser', `${world.tenant}/alice:alice-secret`)).body)).toBe(false)
    const fork = world.fork()
    expect(leaks(fork.db.users.find({}))).toBe(false)
    expect(leaks((await get(fork, `/user/${world.tenant}/users/alice`)).body)).toBe(false)
    expect(leaks((await get(fork, '/user/currentUser')).body)).toBe(false)
  })

  it('not for the world user after the API deleted it', async () => {
    const world = setup({ roles: 'off' })
    expect((await send(world, 'DELETE', `/user/${world.tenant}/users/me`, undefined)).status).toBe(204)
    const me = await get(world, '/user/currentUser')
    expect(me).toMatchObject({ status: 200, body: { userName: 'me' } })
    expect(me.body).not.toHaveProperty('password')
    expect(leaks(me.body)).toBe(false)
  })

  it('redacts it in diffs, also a change, and keeps it in snapshots', async () => {
    const world = setup({ roles: 'off' })
    const t = world.tenant
    const before = world.snapshot()
    expect((await send(world, 'POST', `/user/${t}/users`, { userName: 'carol', email: 'carol@example.com', password: 'Carol-Secret-1' })).status).toBe(201)
    expect((await send(world, 'PUT', `/user/${t}/users/alice`, { password: 'Alice-Secret-2' }, `${t}/alice:alice-secret`)).status).toBe(200)
    const { users } = world.diff(before).tenants[t]!
    expect(users.created).toMatchObject([{ userName: 'carol', __password: '[redacted]' }])
    expect(users.updated).toMatchObject([{ before: { userName: 'alice', __password: '[redacted]' }, after: { userName: 'alice', __password: '[redacted]' } }])
    expect(JSON.stringify(world.diff(before))).not.toContain('Secret')
    expect(JSON.stringify(world.snapshot())).toContain('Alice-Secret-2')
  })
})

describe('passwords across forks, reset, checkpoints, and restore', () => {
  it('keeps them in a fork and its reset()', async () => {
    const world = setup({ passwords: 'check', roles: 'off' })
    const t = world.tenant
    const change = (target: World, password: string, current: string) => send(target, 'PUT', `/user/${t}/users/alice`, { password }, `${t}/alice:${current}`)

    // a fork changes its own copy, and its reset() brings back the base's
    const fork = world.fork()
    const changed = await change(fork, 'Fork-Secret-1', 'alice-secret')
    expect(changed, JSON.stringify(fork.unhandled)).toMatchObject({ status: 200 })
    expect(await status(fork, `${t}/alice:Fork-Secret-1`)).toBe(200)
    expect(await status(world, `${t}/alice:alice-secret`)).toBe(200)
    fork.reset()
    expect(await status(fork, `${t}/alice:alice-secret`)).toBe(200)
    expect(await status(fork, `${t}/alice:Fork-Secret-1`)).toBe(401)
  })

  it('keeps them in a snapshot, a checkpoint, and reset()', async () => {
    // a base with forks is frozen: use a world of its own
    const world = setup({ passwords: 'check', roles: 'off' })
    const t = world.tenant
    const change = (target: World, password: string, current: string) => send(target, 'PUT', `/user/${t}/users/alice`, { password }, `${t}/alice:${current}`)

    // a snapshot restores the password it was taken with
    const snapshot = world.snapshot()
    expect((await change(world, 'Later-Secret-1', 'alice-secret')).status).toBe(200)
    world.restore(snapshot)
    expect(await status(world, `${t}/alice:alice-secret`)).toBe(200)

    // a checkpoint too
    const checkpoint = world.checkpoint()
    expect((await change(world, 'Later-Secret-2', 'alice-secret')).status).toBe(200)
    world.reset({ to: checkpoint })
    expect(await status(world, `${t}/alice:alice-secret`)).toBe(200)

    // and reset() the seeded one
    expect((await change(world, 'Later-Secret-3', 'alice-secret')).status).toBe(200)
    world.reset()
    world.seed({ users: [{ userName: 'alice', password: 'alice-secret' }] })
    expect(await status(world, `${t}/alice:alice-secret`)).toBe(200)
    expect(await status(world, `${t}/alice:Later-Secret-3`)).toBe(401)
  })
})

describe('users seeded into another tenant', () => {
  it('checks their password in their tenant only', async () => {
    const world = createWorld({ passwords: 'check', unknownUsers: 'unauthorized' })
    world.seed({ users: [{ userName: 'remote', tenant: 't300', password: 'remote-secret', roles: ['ROLE_INVENTORY_READ'] }] })
    expect(await status(world, 't300/remote:remote-secret')).toBe(200)
    expect(await status(world, 't300/remote:wrong')).toBe(401)
    expect(await status(world, `${world.tenant}/remote:remote-secret`)).toBe(401)
  })
})

describe('the deployed microservice with a manifest', () => {
  it('checks the subscriptions\' passwords and accepts any for the bootstrap user', async () => {
    const world = createWorld({
      manifest: { name: 'pumps', requiredRoles: ['ROLE_INVENTORY_READ'] },
      subscriptions: [{ tenant: 't12345', user: 'service_pumps', password: 'pumps-secret' }],
      passwords: 'check',
      unknownUsers: 'unauthorized',
    })
    expect(await status(world, 't12345/service_pumps:pumps-secret', '/inventory/managedObjects')).toBe(200)
    expect(await status(world, 't12345/service_pumps:wrong', '/inventory/managedObjects')).toBe(401)
    expect(await status(world, 't12345/servicebootstrap_pumps:anything', '/application/currentApplication')).toBe(200)
  })
})
