// What wrappers of the fake (test harnesses like c8y-nitro/testing) build on:
// the generic user and state types, the light `fake-c8y/defaults` entry, and
// basicAuth(). The type checks run in `pnpm typecheck` (tsc covers tests/).
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import ts from 'typescript'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { basicAuth, createWorld, DEFAULTS } from '../../src'
import { DEFAULTS as LIGHT_DEFAULTS } from '../../src/defaults-entry'
import type { C8yCredentials, C8yGroupInput, C8ySeed, C8ySubscription, C8yUser, C8yUserInput, C8yWorldState } from '../../src'

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
    // a known key may be left out
    expectTypeOf<NonNullable<C8yWorldState<Role, OptionKey>['tenantOptions']>['threshold']>().toEqualTypeOf<string | undefined>()

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

  it('bundles only the defaults module, and its declarations import nothing', async () => {
    const entry = fileURLToPath(new URL('../../src/defaults-entry.ts', import.meta.url))
    const bundle = await rolldown({ input: entry, platform: 'neutral', treeshake: false })
    const { output } = await bundle.generate({ format: 'esm' })
    await bundle.close()
    // every module the entry reaches, side-effect and dynamic imports included
    const modules = output.flatMap((chunk) => (chunk.type === 'chunk' ? chunk.moduleIds : [])).map((id) => relative(dirname(entry), id))
    expect(modules.sort()).toEqual(['defaults-entry.ts', 'defaults.ts'])
    expect(output.filter((chunk) => chunk.type === 'chunk')).toHaveLength(1)
    // the declarations (isolatedDeclarations: per file) reach no other module
    const declaration = (file: string) => ts.transpileDeclaration(readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8'), { fileName: file, compilerOptions: { isolatedDeclarations: true } }).outputText
    expect(declaration('defaults.ts')).toContain('declare const DEFAULTS')
    expect(declaration('defaults.ts')).not.toMatch(/\bimport\b|\bfrom\s+['"]/)
    expect(declaration('defaults-entry.ts').match(/from\s+['"][^'"]+['"]/g)).toEqual([`from './defaults'`])
  })

  it('is the password of the default subscription and of the default applications\' service users', () => {
    const world = createWorld()
    expect(world.subscriptions).toEqual([{ tenant: DEFAULTS.tenant, user: `service_${DEFAULTS.tenant}`, password: DEFAULTS.subscriptionPassword }])
    const subscriptions = world.snapshot().tenants.find((tenant) => tenant.tenant === world.tenant)!.applicationSubscriptions!
    const microservices = subscriptions.filter((subscription) => subscription.serviceUser !== undefined)
    expect(microservices.length).toBeGreaterThan(0)
    expect(new Set(microservices.map((subscription) => subscription.password))).toEqual(new Set([DEFAULTS.subscriptionPassword]))
  })
})

describe('basicAuth()', () => {
  it('builds the header value, with the default user password', () => {
    expect(basicAuth({ tenant: 't1', user: 'eva', password: 'pw' })).toBe(`Basic ${btoa('t1/eva:pw')}`)
    expect(basicAuth({ tenant: 't1', user: 'eva' })).toBe(`Basic ${btoa(`t1/eva:${DEFAULTS.userPassword}`)}`)
    expectTypeOf<C8ySubscription>().toExtend<C8yCredentials>()
    expectTypeOf<{ tenant: string, user: string }>().toExtend<C8yCredentials>()
    expectTypeOf<C8yCredentials['password']>().toEqualTypeOf<string | undefined>()
  })

  it('encodes UTF-8', () => {
    expect(basicAuth({ tenant: 't1', user: 'jürgen', password: 'pä' })).toBe(`Basic ${Buffer.from('t1/jürgen:pä').toString('base64')}`)
  })

  it('keeps a user name with a slash: the tenant ends at the first one', async () => {
    const world = createWorld()
    world.override('GET /whoami', (_request, ctx) => ({ tenant: ctx.tenant, user: ctx.user }))
    const response = await world.fetch(new Request(`${world.baseUrl}/whoami`, { headers: { authorization: basicAuth({ tenant: world.tenant, user: 'site/eva', password: 'p:w' }) } }))
    expect(await response.json()).toEqual({ tenant: world.tenant, user: 'site/eva' })
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
