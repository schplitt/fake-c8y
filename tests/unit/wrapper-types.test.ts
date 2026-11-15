// What wrappers of the fake (test harnesses like c8y-nitro/testing) build on:
// the generic user and state types, the light `fake-c8y/defaults` entry, and
// basicAuth(). The type checks run in `pnpm typecheck` (tsc covers tests/).
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { basicAuth, createWorld, DEFAULTS } from '../../src'
import { DEFAULTS as LIGHT_DEFAULTS } from '../../src/defaults-entry'
import type { C8yGroupInput, C8ySeed, C8ySubscription, C8yUser, C8yUserInput, C8yWorldState } from '../../src'

type Role = 'ROLE_PUMP_READ' | 'ROLE_PUMP_ADMIN'
type OptionKey = 'threshold' | 'unit'

describe('generic user and state types', () => {
  it('keeps the wide types by default', () => {
    expectTypeOf<C8yUser['roles']>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<C8yUserInput['roles']>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<C8yGroupInput['roles']>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<C8ySeed['roles']>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<C8yWorldState['user']>().toEqualTypeOf<C8yUser | null | undefined>()
    expectTypeOf<NonNullable<C8yWorldState['tenantOptions']>[string]>().toEqualTypeOf<string>()
    expectTypeOf<NonNullable<C8yWorldState['tenantOptions']>>().toExtend<Record<string, string>>()
    expectTypeOf<Record<string, string>>().toExtend<NonNullable<C8yWorldState['tenantOptions']>>()
  })

  it('narrows roles and option keys, and the narrowed types pass where the wide ones go', () => {
    expectTypeOf<C8yUser<Role>['roles']>().toEqualTypeOf<Role[] | undefined>()
    expectTypeOf<C8yWorldState<Role, OptionKey>['user']>().toEqualTypeOf<C8yUser<Role> | null | undefined>()

    // @ts-expect-error an unknown role
    const wrong: C8yUser<Role> = { userName: 'eva', roles: ['ROLE_OTHER'] }
    // `(string & {})` keeps other names allowed and the known ones suggested
    const open: C8yUser<Role | (string & {})> = { userName: 'eva', roles: ['ROLE_OTHER', 'ROLE_PUMP_READ'] }
    // @ts-expect-error option keys only add suggestions: values must still be strings
    const badValue: C8yWorldState<Role, OptionKey> = { tenantOptions: { threshold: 3 } }
    const user: C8yUser<Role> = { userName: 'eva', roles: ['ROLE_PUMP_READ'] }
    const state: C8yWorldState<Role, OptionKey> = { user, tenantOptions: { threshold: '3', other: 'kept' } }
    const seed: C8ySeed<Role> = { roles: ['ROLE_PUMP_ADMIN'], groups: [{ name: 'pumps', roles: ['ROLE_PUMP_READ'] }], users: [{ userName: 'otto', roles: ['ROLE_PUMP_ADMIN'] }] }
    // @ts-expect-error an unknown role in a seeded user
    const badSeed: C8ySeed<Role> = { users: [{ userName: 'otto', roles: ['ROLE_OTHER'] }] }
    expect([wrong, open, badValue, badSeed]).toHaveLength(4)

    // no casts: a narrowed state is a C8yWorldState
    const world = createWorld(state)
    world.apply(state)
    world.setUser(user)
    const { users } = world.seed(seed)
    expect(users).toHaveLength(1)
    expect(world.options.get('threshold')).toBe('3')
    expect(world.options.get('other')).toBe('kept')
    expect(world.db.users.effectiveRoles('eva')).toContain('ROLE_PUMP_READ')
  })
})

describe('fake-c8y/defaults', () => {
  it('exports the same DEFAULTS as the main entry, with the harness passwords', () => {
    expect(LIGHT_DEFAULTS).toBe(DEFAULTS)
    expect(DEFAULTS).toMatchObject({ subscriptionPassword: 'service-password', bootstrapPassword: 'bootstrap-password', userPassword: 'test-password' })
  })

  it('imports nothing but the defaults module, which imports only types', () => {
    const imports = (file: string) => [...readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8').matchAll(/^(?:import|export)\s.*from '([^']+)'/gm)].map((match) => match[0])
    expect(imports('defaults-entry.ts')).toEqual([`export { DEFAULTS } from './defaults'`])
    expect(imports('defaults.ts').every((line) => line.startsWith('import type '))).toBe(true)
  })

  it('is the password of the default subscription', () => {
    expect(createWorld().subscriptions).toEqual([{ tenant: DEFAULTS.tenant, user: `service_${DEFAULTS.tenant}`, password: DEFAULTS.subscriptionPassword }])
  })
})

describe('basicAuth()', () => {
  it('builds the header value, with the default user password', () => {
    expect(basicAuth({ tenant: 't1', user: 'eva', password: 'pw' })).toBe(`Basic ${btoa('t1/eva:pw')}`)
    expect(basicAuth({ tenant: 't1', user: 'eva' })).toBe(`Basic ${btoa(`t1/eva:${DEFAULTS.userPassword}`)}`)
    expectTypeOf<C8ySubscription>().toExtend<Parameters<typeof basicAuth>[0]>()
  })

  it('encodes UTF-8', () => {
    expect(basicAuth({ tenant: 't1', user: 'jürgen', password: 'pä' })).toBe(`Basic ${Buffer.from('t1/jürgen:pä').toString('base64')}`)
  })

  it('takes a subscription as it is, and the world sees the user', async () => {
    const world = createWorld({ roles: 'off' })
    world.seed({ users: [{ userName: 'viewer' }] })
    const response = await world.fetch(new Request(`${world.baseUrl}/user/currentUser`, { headers: { authorization: basicAuth({ tenant: world.tenant, user: 'viewer' }), accept: 'application/json' } }))
    expect(await response.json()).toMatchObject({ userName: 'viewer' })
    const [subscription] = world.subscriptions
    expect(basicAuth(subscription!)).toBe(`Basic ${btoa(`${world.tenant}/service_${world.tenant}:service-password`)}`)
  })
})
