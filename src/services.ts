/**
 * Service emulations: microservices reached at `/service/<contextPath>/**`
 * (`world.service()`), and the keyed state they keep in the world.
 *
 * Service state is tenant data (`TenantData.serviceState`, keyed
 * `<service>/<store>/<key>`), so forks, freezing, `reset()`, snapshots, and
 * diffs cover it like every other collection.
 */
import type { TenantData } from './store'
import type { C8yMicroserviceManifest } from './api/applications'
import type { C8yManagedObjectInput } from './data'
import { clone } from './utils'

/**
 * A value service state can hold: what survives `JSON.stringify()`.
 */
export type C8yJson = null | boolean | number | string | C8yJson[] | { [key: string]: C8yJson }

/**
 * A keyed store of one service in one tenant. Values are stored as JSON: a
 * `Date` comes back as its ISO string, `undefined` fields are dropped, and
 * `get()` and `list()` return copies.
 */
export interface C8yServiceStore {
  get: (key: string) => C8yJson | undefined
  set: (key: string, value: C8yJson) => void
  /**
   * @returns Whether the key existed
   */
  delete: (key: string) => boolean
  /**
   * Entries in the order they were first set (a key set again keeps its
   * place), optionally only the keys starting with `prefix`, at most `limit`.
   */
  list: (options?: { prefix?: string, limit?: number }) => Array<[string, C8yJson]>
}

/**
 * What a service handler gets besides the request. It is bound to the world
 * (fork) that answers the request and to the caller's tenant.
 */
export interface C8yServiceContext {
  /**
   * The service's context path (`<contextPath>` in `/service/<contextPath>/**`).
   */
  readonly service: string
  /**
   * The caller's tenant: the tenant whose data and service state the
   * request works with.
   */
  readonly tenant: string
  /**
   * The caller's user name (Basic auth), or the world's user without one.
   */
  readonly user: string
  /**
   * The service's own user in the caller's tenant (its service user,
   * `service_<name>` unless `C8yServiceOptions.user` names another), which
   * `fetch()` sends requests as.
   */
  readonly serviceUser: string
  /**
   * The request being answered in the call log (`C8yRequest.id`), and the
   * request a service sent it for (`C8yRequest.parent`), if any. Following
   * `parent` through `world.calls` gives the chain of services this request
   * runs in.
   */
  readonly call: { readonly id: number, readonly parent?: number }
  /**
   * The world's clock (the trial clock of a fork), in epoch milliseconds.
   */
  now: () => number
  /**
   * A new id from the world's id sequence: deterministic per fork, and
   * reset with it.
   */
  newId: () => string
  /**
   * The service's default store (`store('default')`).
   */
  readonly state: C8yServiceStore
  /**
   * A named store of the service in the caller's tenant.
   * @param name - Store name, without `/`
   */
  store: (name: string) => C8yServiceStore
  /**
   * Sends a request to the same world, as the service user (unless the
   * request has its own `authorization` header), like a microservice calls
   * the platform: what it creates is owned by the service user, and audit
   * records name it. Calls to `/service/<other>/**` reach other services.
   * The call log links the request to the one being answered (`parent`).
   * A path (`/inventory/managedObjects`) is resolved against the world's
   * base URL. Rejects only when the request's signal is already aborted
   * (it is not sent then), like `fetch`.
   */
  fetch: (input: Request | string, init?: ConstructorParameters<typeof Request>[1]) => Promise<Response>
  /**
   * Records the request as unhandled (kind `'feature'`, the trial is
   * invalid) and throws; the world answers it like any request it does not
   * emulate. The trial stays invalid even if the handler catches the error.
   * @param reason - What the emulation does not support
   */
  unsupported: (reason: string) => never
}

/**
 * Answers the requests to a service. The request's URL has the path below
 * the context path (`/service/pumps/stats?x=1` arrives as `/stats?x=1`),
 * like a microservice sees it on the platform, and its body can be read.
 * Throwing makes the trial invalid (kind `'error'`, answered 500).
 */
export type C8yServiceHandler = (request: Request, context: C8yServiceContext) => Response | Promise<Response>

/**
 * Settings of a service (`world.service()`).
 */
export interface C8yServiceOptions {
  /**
   * The service user its `fetch()` calls are sent as, in every subscribed
   * tenant.
   * @default `service_<name>` (the manifest's name, else the context path), like the platform
   */
  user?: string
  /**
   * The microservice's manifest (`cumulocity.json`). The world creates what
   * the platform creates when the microservice is uploaded and subscribed:
   * the MICROSERVICE application with the manifest, the subscriptions, a
   * bootstrap user, a service user per subscribed tenant with exactly the
   * `requiredRoles`, the `roles` in each subscribed tenant's role catalogue,
   * and the `settings` defaults as tenant options of the settings category.
   * @default `{}` (name and context path are the context path)
   */
  manifest?: C8yMicroserviceManifest
  /**
   * The tenant that owns the microservice.
   * @default the deployed tenant (`world.tenant`)
   */
  owner?: string
  /**
   * The tenants subscribed to it.
   * @default the owner
   */
  tenants?: string[]
}

/**
 * Base data of a service in one subscribed tenant
 * (`C8yServiceDefinition.seed`).
 */
export interface C8yServiceSeed {
  /**
   * Service state, as `ctx.store(store).get(key)` reads it. `store`
   * defaults to `'default'`.
   */
  state?: Array<{ store?: string, key: string, value: C8yJson }>
  /**
   * Managed objects the service owns (its configuration object, ...),
   * created in the tenant being seeded with the service user as owner
   * (unless the input names an `owner`).
   */
  managedObjects?: Array<Omit<C8yManagedObjectInput, 'tenant'>>
}

/**
 * A microservice emulation, independent of any world: `defineService()`
 * checks it, and `world.service(definition)` registers it on a world.
 */
export interface C8yServiceDefinition extends C8yServiceOptions {
  /**
   * `<contextPath>` in `/service/<contextPath>/**`. With a manifest that
   * has one, both must be the same.
   * @default `manifest.contextPath`
   */
  contextPath?: string
  /**
   * Base data in every subscribed tenant, or a function that returns it
   * per tenant. Applied when the service is registered, and again by a
   * root world's `reset()`.
   */
  seed?: C8yServiceSeed | ((tenant: string) => C8yServiceSeed)
  /**
   * Answers the service's requests. Without one, the application, its
   * users, and the seed are installed, and requests answer 501 (kind
   * `'feature'`) until a registration supplies a handler
   * (`world.service(definition, { handler })`, e.g. on a fork).
   */
  handler?: C8yServiceHandler | undefined
}

/**
 * A checked service definition (`defineService()`), frozen, with its
 * context path resolved.
 */
export interface C8yService extends Readonly<C8yServiceDefinition> {
  readonly contextPath: string
}

/**
 * Throws a `TypeError` naming the service.
 * @param service - Context path (or `?` when unknown)
 * @param message - What is wrong
 */
function invalid(service: string, message: string): never {
  throw new TypeError(`fake-c8y: service ${service}: ${message}`)
}

/**
 * Checks the seed of a service for one tenant (or the static seed).
 * @param service - Context path
 * @param seed - The seed
 * @param tenant - The tenant it is for (a seed function's result)
 */
export function checkServiceSeed(service: string, seed: unknown, tenant?: string): asserts seed is C8yServiceSeed {
  const where = tenant === undefined ? 'seed' : `seed for ${tenant}`
  if (typeof seed !== 'object' || seed === null) {
    invalid(service, `${where} must be an object with state and managedObjects`)
  }
  const { state, managedObjects } = seed as C8yServiceSeed
  if (state !== undefined && !Array.isArray(state)) {
    invalid(service, `${where}: state must be a list`)
  }
  for (const entry of state ?? []) {
    if (entry.store !== undefined && (typeof entry.store !== 'string' || !entry.store || entry.store.includes('/'))) {
      invalid(service, `${where}: invalid store name '${String(entry.store)}' (not empty, no '/')`)
    }
    if (typeof entry.key !== 'string') {
      invalid(service, `${where}: every state entry needs a string key`)
    }
    if (JSON.stringify(entry.value) === undefined) {
      invalid(service, `${where}: the value of '${entry.key}' is not JSON`)
    }
  }
  if (managedObjects !== undefined && !Array.isArray(managedObjects)) {
    invalid(service, `${where}: managedObjects must be a list`)
  }
  for (const input of managedObjects ?? []) {
    if (typeof input !== 'object' || input === null) {
      invalid(service, `${where}: every managed object must be an object`)
    }
  }
}

/**
 * Checks a service definition and returns it frozen, with its context path
 * resolved from the manifest. The result does not belong to a world: the
 * same definition registers on any number of worlds (`world.service()`).
 * A definition that is already checked comes back as it is.
 * @param definition - The service
 * @example
 * ```ts
 * import manifest from './cumulocity.json' with { type: 'json' }
 *
 * export const tickets = defineService({
 *   manifest, // the context path comes from here
 *   seed: { state: [{ store: 'tickets', key: 't0', value: { text: 'seeded' } }] },
 *   handler: async (request, ctx) => ctx.unsupported(`${request.method} ${new URL(request.url).pathname}`),
 * })
 * ```
 */
export function defineService<T extends C8yServiceDefinition>(definition: T): Readonly<T> & C8yService {
  if (typeof definition !== 'object' || definition === null) {
    throw new TypeError('fake-c8y: defineService() needs a definition object')
  }
  const fromManifest = definition.manifest?.contextPath
  const contextPath = definition.contextPath ?? fromManifest
  if (typeof contextPath !== 'string' || !contextPath || contextPath.includes('/')) {
    throw new TypeError(contextPath === undefined
      ? 'fake-c8y: defineService() needs a contextPath, or a manifest with one'
      : `fake-c8y: invalid service context path '${String(contextPath)}' (not empty, no '/')`)
  }
  if (fromManifest !== undefined && fromManifest !== contextPath) {
    invalid(contextPath, `contextPath '${contextPath}' differs from manifest.contextPath '${String(fromManifest)}'`)
  }
  if (definition.handler !== undefined && typeof definition.handler !== 'function') {
    invalid(contextPath, 'handler must be a function')
  }
  if (definition.seed !== undefined && typeof definition.seed !== 'function') {
    checkServiceSeed(contextPath, definition.seed)
  }
  if (Object.isFrozen(definition) && definition.contextPath === contextPath) {
    return definition as Readonly<T> & C8yService
  }
  return Object.freeze({ ...definition, contextPath }) as Readonly<T> & C8yService
}

/**
 * Service state to seed (`world.seed({ serviceState })`).
 */
export interface C8yServiceStateInput {
  service: string
  /**
   * @default 'default'
   */
  store?: string
  key: string
  value: C8yJson
}

/**
 * Key of a service state entry in `TenantData.serviceState`. Service and
 * store names have no `/`, so the key may.
 * @param service - Context path
 * @param store - Store name
 * @param key - Key in the store
 */
export function serviceStateKey(service: string, store: string, key: string): string {
  if (!service || service.includes('/')) {
    throw new TypeError(`fake-c8y: invalid service name '${service}' (not empty, no '/')`)
  }
  if (!store || store.includes('/')) {
    throw new TypeError(`fake-c8y: invalid service store name '${store}' (not empty, no '/')`)
  }
  return `${service}/${store}/${key}`
}

/**
 * Splits a `TenantData.serviceState` key.
 * @param id - Key from `serviceStateKey()`
 */
export function splitServiceStateKey(id: string): { service: string, store: string, key: string } {
  const first = id.indexOf('/')
  const second = id.indexOf('/', first + 1)
  return { service: id.slice(0, first), store: id.slice(first + 1, second), key: id.slice(second + 1) }
}

/**
 * The JSON form of a value, as stored.
 * @param value - Value to store
 */
export function toJson(value: unknown): C8yJson {
  const text = JSON.stringify(value)
  if (text === undefined) {
    throw new TypeError(`fake-c8y: service state values must be JSON, got ${typeof value}`)
  }
  return JSON.parse(text) as C8yJson
}

/**
 * A store of one service in one tenant.
 * @param data - Returns the tenant's data (looked up on every access)
 * @param service - Context path
 * @param store - Store name
 * @param check - Runs before every access (e.g. throws when the request is stale)
 */
export function serviceStore(data: () => TenantData, service: string, store: string, check: () => void = () => {}): C8yServiceStore {
  const prefix = serviceStateKey(service, store, '')
  return {
    get(key) {
      check()
      const value = data().serviceState.get(prefix + key)
      return value === undefined ? undefined : clone(value) as C8yJson
    },
    set(key, value) {
      check()
      data().serviceState.set(prefix + key, toJson(value))
    },
    delete(key) {
      check()
      return data().serviceState.delete(prefix + key)
    },
    list(options = {}) {
      check()
      const start = prefix + (options.prefix ?? '')
      const limit = options.limit ?? Infinity
      const result: Array<[string, C8yJson]> = []
      for (const [id, value] of data().serviceState.entries()) {
        if (result.length >= limit) {
          break
        }
        if (id.startsWith(start)) {
          result.push([id.slice(prefix.length), clone(value) as C8yJson])
        }
      }
      return result
    },
  }
}
