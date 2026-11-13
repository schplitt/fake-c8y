import type { C8yCoverage, C8yOverrideContext, C8yOverrideHandler, C8yRequest, C8ySubscription, C8yUnhandledRequest, C8yUser, C8yWorldState, C8yWrite } from './types'
import type { CompiledRoute } from './router'
import type { StoredDocument, TenantCollection, TenantData, WorldContext } from './store'
import type { Collection } from './collection'
import type { RealtimeApi } from './realtime'
import type { C8yBinaryInput, C8yDb, C8yManagedObjectInput, C8ySeed, C8ySeedResultFor } from './data'
import type { WorldDiff, WorldSnapshot } from './snapshot'
import type { Clock } from './clock'
import type { Access } from './api/access'
import type { C8yService, C8yServiceContext, C8yServiceDefinition, C8yServiceHandler, C8yServiceOptions } from './services'
import { DEFAULTS } from './defaults'
import { withReasonPhrase } from './reason-phrases'
import { compileRoute, matchRoute, splitPath } from './router'
import { emptyTenant, forkTenant, freezeTenant, optionKey, TENANT_COLLECTIONS } from './store'
import { Realtime } from './realtime'
import { platformApi, UnsupportedRequestError } from './api'
import { UsageLog } from './api/statistics'
import { applicationAccess, authorize, userAccess } from './api/access'
import { apiError, rawRequests } from './api/http'
import { mediaType, negotiate, notAcceptable, withLocation, withMediaType } from './api/media'
import { applySeed, createBinaryFromInput, createDb, createFromInput } from './data'
import { diffSnapshots, diffWorld, restoreTenants, snapshotOptions, snapshotTenants, touchedSnapshots } from './snapshot'
import { advanceBulkOperations } from './api/bulkoperations'
import { advanceAvailability } from './availability'
import { decodeBase64, encodeBase64, parseIsoTime } from './utils'
import { renderCurrentUser, upsertWorldUser } from './api/users'
import { C8Y_SPEC_PATHS } from './capabilities.generated'
import { checkServiceSeed, defineService, serviceStateKey, serviceStore, toJson } from './services'
import type { C8yMicroserviceManifest } from './api/applications'
import { applicationOfCredentials, applicationSettings, deleteApplication, microserviceFromManifest, renderApplication, renderApplicationUser, settingsCategoryOf, subscribe, subscribedMicroservice, unsubscribe, updateApplication } from './api/applications'

// The spec's endpoints, to tell "not emulated" (501) from "the platform does not
// have this endpoint" (404) or "not this method" (405).
const SPEC_ROUTES = C8Y_SPEC_PATHS.map((entry) => {
  const [method, template] = entry.split(' ') as [string, string]
  const pattern = template.split(/\{[^}]+\}/).map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')
  return { method, pattern: new RegExp(`^${pattern}/?$`) }
})
const SPEC_DOMAINS = new Set(C8Y_SPEC_PATHS.map((entry) => entry.split('/')[1]!))
// Verified: these APIs answer a write that declares JSON but has no body with 400
const EMPTY_ERROR_DOMAINS = new Set(['user', 'tenant', 'audit', 'retention', 'notification2'])

/**
 * How the platform would answer a request the fake does not emulate: 404 for a
 * path the spec does not know (within the spec's APIs), 405 for a known path
 * with another method, otherwise nothing (the request is unsupported).
 * @param method - Request method
 * @param path - Raw request path
 */
function specAnswer(method: string, path: string): (Response & { status: 404 | 405 }) | undefined {
  if (!SPEC_DOMAINS.has(path.split('/')[1]!)) {
    return undefined
  }
  const known = SPEC_ROUTES.filter((route) => route.pattern.test(path))
  // verified for every API: an unknown path (404) and a wrong method (405)
  // answer with an empty body, whatever the Accept header
  if (known.length === 0) {
    return new Response(null, { status: 404 }) as Response & { status: 404 }
  }
  if (!known.some((route) => route.method === method)) {
    return new Response(null, { status: 405 }) as Response & { status: 405 }
  }
  return undefined
}

// Verified: the APIs whose path may not start with a double slash, and the
// prefixes of first segments the platform routes to the core service
const NO_DOUBLE_SLASH = new Set(['devicecontrol', 'identity', 'tenant', 'user', 'notification2', 'application'])
const CORE_PREFIXES = ['alarm', 'event', 'measurement', 'devicecontrol', 'identity', 'tenant', 'user', 'notification', 'retention', 'application']

/**
 * How the core service answers a path no API of it handles (verified): a
 * leading double slash on some APIs (`//tenant/currentTenant`) or a first
 * segment that only starts like an API (`/users`, `/alarms`). GET answers 404
 * `System/Not Found` and POST 405 `System/Method Not Allowed`, both as
 * indented plain JSON without `info`; PUT and DELETE answer 405 and other
 * methods 501 without a body. A first segment that starts like `inventory`
 * or `audit` answers 404 without a body.
 * @param method - Request method
 * @param pathname - Raw request path
 */
function coreFallback(method: string, pathname: string): Response | undefined {
  const first = pathname.split('/').find(Boolean) ?? ''
  const doubleSlash = pathname.startsWith('//') && NO_DOUBLE_SLASH.has(first)
  if (!doubleSlash && SPEC_DOMAINS.has(first)) {
    return undefined
  }
  if (!doubleSlash && (first.startsWith('inventory') || first.startsWith('audit'))) {
    return new Response(null, { status: 404 })
  }
  if (!doubleSlash && !CORE_PREFIXES.some((prefix) => first.startsWith(prefix))) {
    return undefined
  }
  const indented = (status: number, error: string, message: string) => new Response(JSON.stringify({ error, message }, null, 2), { status, headers: { 'content-type': 'application/json' } })
  if (method === 'GET') {
    return indented(404, 'System/Not Found', 'Not Found')
  }
  if (method === 'POST') {
    return indented(405, 'System/Method Not Allowed', `HTTP method ${method} is not supported by this URL`)
  }
  return new Response(null, { status: method === 'PUT' || method === 'DELETE' ? 405 : 501 })
}

/**
 * Verified: a write (POST or PUT answered 200 or 201) returns its document
 * unless the request has no Accept header, exactly `*\/*` (Node's `fetch`
 * sends that when none is set), or one that does not parse (`foo`): then the
 * body is empty and the status the same, except an event update (204). The
 * content-type and Location headers stay, except on event, alarm,
 * measurement, and Notification 2.0 subscription creation without a header or
 * with `*\/*`. Reads sent as POST (`/identity/search`) answer empty too.
 * Endpoints that answer plain JSON (`/notification2/token`) keep their body.
 * @param method - Request method
 * @param segments - Decoded path segments
 * @param path - Raw request path
 * @param accept - The request's Accept header
 * @param response - The emulation's answer
 */
function writeAnswer(method: string, segments: readonly string[], path: string, accept: string | null, response: Response): Response {
  if ((method !== 'POST' && method !== 'PUT') || (response.status !== 200 && response.status !== 201) || mediaType(method, segments) === 'application/json') {
    return response
  }
  const ranges = (accept ?? '').split(',').map((range) => range.split(';')[0]!.trim())
  if (accept?.trim() && accept.trim() !== '*/*' && ranges.every((range) => /^[\w.+*-]+\/[\w.+*-]+$/.test(range))) {
    return response
  }
  if (method === 'PUT' && /^\/event\/events\/[^/]+\/?$/.test(path)) {
    return new Response(null, { status: 204 })
  }
  const headers = new Headers(response.headers)
  if (method === 'POST' && (!accept?.trim() || accept.trim() === '*/*') && /^\/(?:event\/events|alarm\/alarms(?:\/upsert)?|measurement\/measurements|notification2\/subscriptions)\/?$/.test(path)) {
    // verified: these creates then have neither a content type nor a Location
    headers.delete('content-type')
    headers.delete('location')
  }
  return new Response(null, { status: response.status, headers })
}

/**
 * Mixes a sequence number into 32 scattered bits; the same number always gives
 * the same bits, so ids stay deterministic.
 * @param n - Sequence number
 */
function mix(n: number): number {
  let x = Math.imul(n ^ (n >>> 16), 0x45D9F3B)
  x = Math.imul(x ^ (x >>> 16), 0x45D9F3B)
  return (x ^ (x >>> 16)) >>> 0
}

/**
 * An id in the platform's format (verified): one counter for all documents,
 * a managed object gets a scattered two-digit prefix in front of it
 * (`47100001`, `52100002`, `54100003` in a row), events, alarms, operations,
 * audit records, and retention rules get the bare counter (`100004`), and
 * measurements a 24 digit hex id.
 * @param n - Sequence number (from 1)
 * @param kind - What the id is for
 */
function scatteredId(n: number, kind: 'managedObject' | 'measurement' | 'document'): string {
  const counter = 100_000 + n
  if (kind === 'managedObject') {
    return `${10 + (mix(n) % 90)}${counter}`
  }
  if (kind === 'measurement') {
    const hex = (value: number) => value.toString(16).padStart(8, '0')
    return `${hex(0x6A000000 + n)}${hex(mix(n))}${hex(mix(n ^ 0x5BD1E995))}`
  }
  return String(counter)
}

/**
 * How a world answers a request it does not emulate.
 *
 * - `'developer'`: 501 naming the request and the reason, with a hint to answer
 *   it with `world.override()`.
 * - `'platform'`: a neutral 501 without hints, for clients that must not see
 *   the fake (e.g. an AI agent under evaluation).
 * - a function: your own response.
 *
 * The request is recorded in `world.unhandled` and passed to `onUnsupported`
 * in every case.
 */
export type UnsupportedResponse = 'developer' | 'platform' | ((request: C8yUnhandledRequest, world: World) => Response)

export interface WorldOptions extends C8yWorldState {
  /**
   * Base URL the fake platform pretends to live at.
   * @default 'https://t12345.cumulocity.test'
   */
  baseUrl?: string
  /**
   * Bootstrap user of the microservice: may address `/application/currentApplication`.
   * @default 'servicebootstrap_test'
   */
  bootstrapUser?: string
  /**
   * The microservice's own tenant option category: `tenantOptions` live there,
   * and its `credentials.*` options read decrypted.
   * @default 'service'
   */
  settingsCategory?: string
  /**
   * Clock for timestamps, in epoch milliseconds.
   * @default Date.now
   */
  now?: () => number
  /**
   * A trial clock (`createClock()`): the world reads its time from it (it
   * wins over `now`), and `world.advance()` moves it. Give the agent's
   * sandbox and the grader the same clock.
   */
  clock?: Clock
  /**
   * Id format of new documents. Both are deterministic: forks of the same
   * base hand out the same ids.
   *
   * - `'scattered'`: like the platform. Managed objects get 8 digits with a
   *   scattered two-digit prefix (`47100001`), so ascending ids are not
   *   creation order; events, alarms, operations, audit records, and
   *   retention rules get 6 digits (`100002`); measurements a 24 digit hex id.
   * - `'sequential'`: `'1'`, `'2'`, ... for every collection, easier to read
   *   in tests.
   * @default 'scattered'
   */
  ids?: 'scattered' | 'sequential'
  /**
   * Runs a callback later (Notification 2.0 delivery).
   * @default (callback) => setTimeout(callback, 0)
   */
  schedule?: (callback: () => void) => void
  /**
   * @default 'developer'
   */
  unsupported?: UnsupportedResponse
  /**
   * Called for every request the world does not emulate, with the world
   * that got it (a fork inherits the callback of its base).
   */
  onUnsupported?: (request: C8yUnhandledRequest, world: World) => void
  /**
   * Called when the deployed tenant or the current user changed, with the
   * world that changed (a fork inherits the callback of its base).
   */
  onChange?: (world: World) => void
  /**
   * Deep-freezes every stored document, so code that changes one in place
   * throws. For tests of fake-c8y itself: it makes every write slower.
   * @default false
   */
  freezeDocuments?: boolean
  /**
   * Whether requests are checked against the caller's rights, like on the
   * platform. `'off'` gives every caller full access. With `'enforce'` (the
   * default), a request with Basic auth of a stored user
   * (other than the world's `user`) or of a registered service's bootstrap or
   * service user answers 403 where the platform would, and lists show only
   * what the caller may see: global roles (own and from groups), ownership,
   * and inventory roles on an object and its parents. Requests without Basic
   * auth, as the world's `user`, or as a user the tenant does not store stay
   * unrestricted. See docs/roles.md.
   * @default 'enforce'
   */
  roles?: 'enforce' | 'off'
}

/**
 * What a fork can set for itself; everything else comes from its base.
 */
export type ForkOptions = Pick<WorldOptions, 'now' | 'clock' | 'schedule' | 'unsupported' | 'onUnsupported' | 'onChange' | 'roles'>

/**
 * Where a tenant option lives. Defaults: own settings category, deployed tenant.
 */
export interface C8yTenantOptionScope {
  category?: string
  tenant?: string
}

/**
 * An in-memory Cumulocity platform: tenants with their data, tenant options,
 * the deployed microservice's subscriptions, and Notification 2.0.
 */
export interface World {
  /**
   * Base URL of the fake platform, without a trailing slash.
   */
  readonly baseUrl: string
  /**
   * Tenant the microservice is deployed in (the bootstrap tenant).
   */
  readonly tenant: string
  /**
   * User `GET /user/currentUser` answers with, or `null` (401).
   */
  readonly user: C8yUser | null
  /**
   * Tenants subscribed to the microservice, with their service users.
   */
  readonly subscriptions: readonly C8ySubscription[]
  /**
   * Every request answered since the last reset, in order.
   */
  calls: C8yRequest[]
  /**
   * Requests since the last reset the world could not answer.
   */
  unhandled: C8yUnhandledRequest[]
  /**
   * Whether the requests since the last reset stayed inside the emulation:
   * `valid` is `false` as soon as one request was unhandled (the world made
   * up a 501). Requests the platform also rejects (404 for an unknown path,
   * 405 for a wrong method) are listed in `platformErrors` and keep the trial
   * valid. For eval harnesses: grade only valid trials, report the others.
   */
  coverage: () => C8yCoverage
  /**
   * Requests being answered right now.
   */
  readonly inflight: number
  /**
   * Notification 2.0 state (consumer sockets: `fake-c8y/realtime`).
   */
  readonly realtime: Realtime
  /**
   * The data of the deployed tenant (`db.tenant(name)` for others).
   */
  readonly db: C8yDb
  /**
   * Answers a request to the platform, with the standard reason phrase as
   * `statusText`. The request's signal works like `fetch`'s: an aborted
   * signal rejects with its reason and nothing is sent; a signal that fires
   * before the answer rejects at once with its reason, while the request
   * still runs to its end (its call is recorded with `aborted: true`).
   */
  fetch: (request: Request) => Promise<Response>
  /**
   * Restores the baseline: data (also Notification 2.0 subscriptions and
   * tokens), tenant options, overrides, call log, and ids start over.
   * Undelivered notifications are dropped, and sockets whose token is gone
   * are closed. A request still in flight answers 503 and changes nothing
   * (also with `restore()`).
   *
   * A fork goes back to the state it was forked in: its own writes, ids,
   * overrides, and call log are dropped, the base shows again, and a clock
   * the fork got as a copy of the base's goes back to the fork's start. A
   * `baseline` is applied on top of that.
   * @param baseline - A new baseline (default: the current one)
   */
  reset: (baseline?: C8yWorldState) => void
  /**
   * Applies a partial state on top of the current one.
   */
  apply: (state: Partial<C8yWorldState>) => void
  /**
   * Sets the user `GET /user/currentUser` answers with.
   */
  setUser: (user: C8yUser | null) => void
  /**
   * Tenant options (default: the own settings category of the deployed tenant).
   */
  readonly options: {
    get: (key: string, scope?: C8yTenantOptionScope) => string | undefined
    set: (key: string, value: string, scope?: C8yTenantOptionScope) => void
    delete: (key: string, scope?: C8yTenantOptionScope) => boolean
  }
  /**
   * Answers matching requests with a handler instead of the emulation. The
   * most recently registered handler wins; `ctx.next()` passes the request
   * on to the next older matching override, else the emulation, and returns
   * its answer. `ctx.callCount` says how many requests this override got.
   * The handler gets the answering world in `ctx.world` (a fork, for an
   * override registered on its base) and a request whose body it can read.
   * Allowed on a frozen base: forks created afterwards get it, earlier ones
   * do not.
   * Without a pattern, the handler gets every request (e.g. to answer them
   * with an HTTP framework that calls `ctx.next()` for the routes it does
   * not have).
   * @returns A function that removes the handler
   */
  override: {
    /**
     * @param pattern - `"[METHOD ]/path"`: `:name` captures a segment into
     * `ctx.params`, `*` matches one segment, `**` the rest (also none)
     * @param handler - Answers the matching requests
     */
    (pattern: string, handler: C8yOverrideHandler): () => void
    /**
     * @param handler - Answers every request
     */
    (handler: C8yOverrideHandler): () => void
  }
  /**
   * Emulates a microservice: requests to `/service/<contextPath>/**` go to
   * its handler (overrides still win), in every subscribed tenant. The
   * registration installs what the platform creates for an uploaded and
   * subscribed microservice (application, service users, roles, settings),
   * then applies the definition's seed in every subscribed tenant. The
   * handler's context is bound to the world answering the request: its
   * clock, ids, service state (tenant data, so forks, `reset()`, snapshots,
   * and diffs cover it), and a `fetch()` back into the same world as the
   * service user.
   *
   * `options.handler` replaces the definition's handler. Without either,
   * requests answer 501 (kind `'feature'`). Registering the same definition
   * object again with the same handler changes nothing and returns the same
   * remover; with another handler, only the handler changes. A different
   * definition with the same context path replaces the registration whole.
   *
   * Services stay registered across `reset()`; a root world's `reset()`
   * installs them and applies their seeds again. A fork starts with the
   * services of its base (registered before the fork) and may register or
   * replace its own. Registered on a frozen base, the application and the
   * seed are base data of the forks created afterwards. Without a
   * registered service, `/service/<name>/**` answers 404
   * `microservice/Not Found` like the platform.
   * @param definition - The service (`defineService()`, or a definition to check)
   * @param options - The handler, if not the definition's
   * @returns A function that removes the service (on a fork, a replacement
   *   gives way to the inherited service)
   */
  service: {
    (definition: C8yService | C8yServiceDefinition, options?: { handler?: C8yServiceHandler | undefined }): () => void
    /**
     * The short form for one-off services: the same as
     * `service({ contextPath, handler, ...options })`, a new definition on
     * every call.
     * @param contextPath - The service's context path, without `/`
     * @param handler - Answers its requests
     * @param options - Settings (manifest, service user, owner, tenants)
     */
    (contextPath: string, handler: C8yServiceHandler, options?: C8yServiceOptions): () => void
  }
  /**
   * The registered services by context path (a copy), each with the
   * definition it was registered with.
   */
  readonly services: ReadonlyMap<string, C8yService>
  /**
   * Creates a managed object. Things other data points to (managed
   * objects, devices, binaries) are created one at a time and return their
   * id; everything else goes through `seed()`.
   * @returns Its id
   */
  managedObject: (input?: C8yManagedObjectInput) => string
  /**
   * Creates a device (a managed object with `c8y_IsDevice`).
   * @returns Its id
   */
  device: (input?: C8yManagedObjectInput) => string
  /**
   * Creates an inventory binary.
   * @returns Its id
   */
  binary: (input: C8yBinaryInput) => string
  /**
   * Seeds everything other data does not point to: measurements and
   * generators, events, alarms, operations, new device requests, retention
   * rules, audit records, users, groups, roles, inventory roles,
   * applications, service state, usage statistics, and trusted
   * certificates. Managed objects, devices, and binaries come from
   * `managedObject()`, `device()`, and `binary()`, which return the id.
   * @example
   * const pump = world.device({ name: 'Pump 7' })
   * const { alarms: [overheat] } = world.seed({ alarms: [{ source: pump, type: 'overheat' }], events: [{ source: pump, type: 'door_open' }] })
   * @returns The ids it created per list, in input order (see `C8ySeedResult`)
   */
  seed: <S extends C8ySeed>(seed: S) => C8ySeedResultFor<S>
  /**
   * Runs the platform's time-based work that is due by the world's clock:
   * bulk operations create their operations, and availability monitoring
   * marks devices UNAVAILABLE (with a `c8y_UnavailabilityAlarm`) or
   * AVAILABLE again. The world also does this before every request and
   * every `db` access.
   */
  tick: () => void
  /**
   * Moves the world's clock (the `clock` option) forward and runs the work
   * that is now due (`tick()`), e.g. to let bulk operations finish before
   * grading. Throws if the world has no `clock`.
   * @param ms - Milliseconds to move forward
   */
  advance: (ms: number) => void
  /**
   * Runs a function without publishing Notification 2.0 notifications for the
   * data it changes. An async function keeps the world muted until its
   * promise settles (also for other requests meanwhile).
   */
  muted: <T>(operation: () => T) => T
  /**
   * The data and platform state as JSON, with Notification 2.0
   * subscriptions and tokens (no overrides, no sockets).
   */
  snapshot: () => WorldSnapshot
  /**
   * Replaces the data and platform state with a snapshot.
   */
  restore: (snapshot: WorldSnapshot) => void
  /**
   * What changed in the data since a snapshot. Without a snapshot (forks
   * only): what the fork changed in its base. That diff comes straight from
   * the fork's own writes, so it costs time in proportion to the changes,
   * not to the data, and it equals `diff(base.snapshot())`, except that a
   * key deleted and set again (a user, a tenant option) is listed as deleted
   * and created, which a snapshot diff cannot see.
   * @param since - The earlier snapshot
   */
  diff: (since?: WorldSnapshot) => WorldDiff
  /**
   * A new world on top of this one: it reads this world's data, writes only
   * to its own copy-on-write overlay (deletes are tombstones), and starts with
   * this world's tenant, user, subscriptions, overrides, and next id. It has
   * its own clock, call log, overrides, and Notification 2.0 state, so forks
   * are isolated from each other and from their base, and forks of the same
   * base hand out the same ids.
   *
   * The first fork freezes this world: from then on its data cannot change
   * (writes throw), and its time-based work (bulk operations) stops; forks
   * run their own.
   * @param options - Settings of the fork (default: the base's)
   */
  fork: (options?: ForkOptions) => World
  /**
   * Whether this world is the frozen base of forks.
   */
  readonly frozen: boolean
}

const WRITE_COLLECTIONS: Record<RealtimeApi, C8yWrite['collection']> = {
  managedobjects: 'managedObjects',
  measurements: 'measurements',
  events: 'events',
  alarms: 'alarms',
  operations: 'operations',
}

const WRITE_ACTIONS = { CREATE: 'created', UPDATE: 'updated', DELETE: 'deleted' } as const

interface RegisteredHandler {
  // undefined: every request
  route: CompiledRoute | undefined
  handler: C8yOverrideHandler
}

interface RegisteredService {
  definition: C8yService
  /**
   * The object passed to `world.service()`: registering it again changes no
   * data.
   */
  source: object
  /**
   * Answers the requests; without one they answer 501.
   */
  handler: C8yServiceHandler | undefined
  /**
   * Service user name (`C8yServiceOptions.user`), if not the platform's.
   */
  user: string | undefined
  manifest: C8yMicroserviceManifest
  owner: string | undefined
  tenants: string[] | undefined
}

/**
 * Whether two registrations of a context path create the same application
 * and subscriptions (they may differ in the handler).
 * @param a - A registration
 * @param b - Another one
 */
function sameRegistration(a: RegisteredService, b: RegisteredService): boolean {
  return a.user === b.user && a.owner === b.owner && JSON.stringify(a.tenants) === JSON.stringify(b.tenants) && JSON.stringify(a.manifest) === JSON.stringify(b.manifest)
}

/**
 * The MICROSERVICE application a tenant owns for a context path.
 * @param data - Owner tenant
 * @param contextPath - Context path
 */
function microserviceOf(data: TenantData, contextPath: string): Readonly<StoredDocument> | undefined {
  for (const application of data.applications.values()) {
    if (application.owner === data.tenant && application.type === 'MICROSERVICE' && application.contextPath === contextPath) {
      return application
    }
  }
  return undefined
}

function defaultSubscription(tenant: string): C8ySubscription {
  return { tenant, user: `service_${tenant}`, password: 'service-password' }
}

function parseBasicAuth(header: string | null): { tenant?: string, user: string } | undefined {
  if (!header?.startsWith('Basic ')) {
    return undefined
  }
  const decoded = new TextDecoder().decode(decodeBase64(header.slice(6)))
  const login = decoded.slice(0, decoded.indexOf(':'))
  const slash = login.indexOf('/')
  return slash === -1 ? { user: login } : { tenant: login.slice(0, slash), user: login.slice(slash + 1) }
}

/**
 * Why a request whose signal is aborted is not answered: the signal's reason, or
 * an `AbortError` (iso4 has no `DOMException`).
 * @param signal - The aborted signal
 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
}

function staleAnswer(): Response {
  return apiError(503, 'general/Service Unavailable', 'The platform was reset while the request was in flight')
}

function toResponse(result: unknown): Response {
  if (result instanceof Response) {
    return result
  }
  if (result === undefined) {
    return new Response(null, { status: 204 })
  }
  return Response.json(result)
}

/**
 * Creates an in-memory Cumulocity platform.
 * @param options - Baseline state and behavior
 * @example
 * ```ts
 * const world = createWorld({ tenant: 't100', user: { userName: 'admin', roles: ['ROLE_INVENTORY_READ'] } })
 * const pump = world.device({ name: 'Pump' })
 * const response = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects/${pump}`))
 * ```
 */
export function createWorld(options: WorldOptions = {}): World {
  return buildWorld(options, undefined)
}

/**
 * The frozen state a fork starts from.
 */
interface ForkBase {
  tenants: ReadonlyMap<string, TenantData>
  nextId: number
  tenant: string
  user: C8yUser | null
  subscriptions: C8ySubscription[]
  handlers: RegisteredHandler[]
  services: ReadonlyMap<string, RegisteredService>
  /**
   * Whether the fork's clock is its own copy of the base's (`reset()` sets
   * it back to the time the fork started at).
   */
  ownClock: boolean
}

function copyUser(user: C8yUser | null): C8yUser | null {
  return user && { ...user, roles: [...(user.roles ?? [])] }
}

function buildWorld(options: WorldOptions, base: ForkBase | undefined): World {
  const baseUrl = (options.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '')
  const bootstrapUser = options.bootstrapUser ?? DEFAULTS.bootstrapUser
  const settingsCategory = options.settingsCategory ?? DEFAULTS.settingsCategory
  const clock = options.clock?.now ?? options.now ?? Date.now
  const unsupported = options.unsupported ?? 'developer'
  // a fork's reset() goes back to this time on its own clock
  const forkStart = base?.ownClock ? clock() : undefined

  let baseline: C8yWorldState = pickState(options)
  let tenant: string = baseline.tenant ?? DEFAULTS.tenant
  let user: C8yUser | null = null
  let subscriptions: C8ySubscription[] = []
  let nextId = 1
  // operations running in muted() (async ones until they settle)
  let muted = 0
  let inflight = 0
  // bumped by reset() and restore(): a request that started before does not
  // touch the new state
  let generation = 0
  let frozen = false
  let handlers: RegisteredHandler[] = []
  // how many requests each override got in this world (ctx.callCount); a
  // fork starts its own count, reset() starts over
  let callCounts = new Map<RegisteredHandler, number>()
  // kept by reset(): services are part of the platform, not of a trial
  const services = new Map<string, RegisteredService>(base?.services)
  // the removers of this world's own registrations
  const removers = new WeakMap<RegisteredService, () => void>()
  let calls: C8yRequest[] = []
  // what the calls added to the usage statistics (cleared with the calls)
  let usage = new UsageLog()
  // calls that never reached a platform API (the core's fallback, paths
  // outside the spec): the usage statistics leave them out
  const uncounted = new WeakSet<C8yRequest>()
  // number of the last recorded request (C8yRequest.id)
  let callCount = 0
  // errors thrown by ctx.unsupported(), already recorded as unhandled
  const reported = new WeakMap<object, C8yUnhandledRequest>()
  let unhandledRequests: C8yUnhandledRequest[] = []
  let platformErrors: C8yCoverage['platformErrors'] = []
  // user name of the request being answered, for audit records
  let actor: string | undefined
  // the request being answered (its headers decide what counts as device traffic)
  let current: C8yRequest | undefined
  // the restricted caller of the request being answered (roles: 'enforce')
  let access: Access | undefined
  const tenants = new Map<string, TenantData>()
  // the world object below, for callbacks and override handlers

  let world: World

  const realtime = new Realtime({
    ...(options.schedule ? { schedule: options.schedule } : {}),
    inflight: () => inflight,
    subscriptions: () => [...tenants.values()].flatMap((data) => [...data.notificationSubscriptions.values()]),
    tokens: () => [...tenants.values()].flatMap((data) => [...data.notificationTokens.entries()]),
  })

  const context: WorldContext = {
    baseUrl,
    newId: (kind = 'document') => (options.ids === 'sequential' ? String(nextId++) : scatteredId(nextId++, kind)),
    reserveIds: (count) => {
      const first = nextId
      nextId += count
      return first
    },
    measurementId: (n) => (options.ids === 'sequential' ? String(n) : scatteredId(n, 'measurement')),
    measurementSequence: (id) => {
      if (options.ids === 'sequential') {
        return /^[1-9]\d*$/.test(id) ? Number(id) : Number.NaN
      }
      // the first 8 hex digits carry the sequence number, the rest its hashes
      // (as in scatteredId(), compared as numbers: no strings to build)
      if (!/^[0-9a-f]{24}$/.test(id)) {
        return Number.NaN
      }
      const n = Number.parseInt(id.slice(0, 8), 16) - 0x6A000000
      return n > 0 && Number.parseInt(id.slice(8, 16), 16) === mix(n) && Number.parseInt(id.slice(16), 16) === mix(n ^ 0x5BD1E995) ? n : Number.NaN
    },
    now: () => new Date(clock()).toISOString(),
    realtime,
    notify(data: TenantData, api: RealtimeApi, action: 'CREATE' | 'UPDATE' | 'DELETE', document: StoredDocument, sourceId: string | undefined) {
      if (current) {
        // the request being answered wrote it (handlers run synchronously)
        (current.writes ??= []).push({ collection: WRITE_COLLECTIONS[api], id: document.id, action: WRITE_ACTIONS[action] })
      }
      if (muted === 0) {
        realtime.publish(data.tenant, api, action, document, sourceId, data.notificationSubscriptions.values())
      }
    },
    settingsCategory,
    actor: () => actor,
    request: () => current,
    access: () => access,
    freezeDocuments: options.freezeDocuments ?? false,
    tenantData: (name) => (tenants.has(name) || base?.tenants.has(name) ? tenantData(name) : undefined),
    tenants: () => tenants.values(),
    usage: () => usage,
  }

  function tenantData(name: string): TenantData {
    let data = tenants.get(name)
    if (!data) {
      const baseTenant = base?.tenants.get(name)
      data = baseTenant ? forkTenant(baseTenant, context) : emptyTenant(name, context)
      if (frozen) {
        // a frozen world gets no new tenants: reads see an empty one
        freezeTenant(data, false)
        return data
      }
      tenants.set(name, data)
    }
    return data
  }

  function writable(): void {
    if (frozen) {
      throw new TypeError('fake-c8y: this world is frozen (it is the base of forks); change a fork instead')
    }
  }

  function tick(): void {
    if (frozen) {
      return
    }
    for (const data of tenants.values()) {
      advanceBulkOperations(data)
      advanceAvailability(data)
    }
  }

  function setUser(next: C8yUser | null): void {
    writable()
    user = copyUser(next)
    storeUser()
    options.onChange?.(world)
  }

  // the current user is also a user of its tenant (user API, effective roles)
  function storeUser(): void {
    if (user) {
      upsertWorldUser(tenantData(user.tenant ?? tenant), user)
    }
  }

  const worldOptions: World['options'] = {
    get: (key, scope = {}) => tenantData(scope.tenant ?? tenant).options.get(optionKey(scope.category ?? settingsCategory, key)) ?? undefined,
    set: (key, value, scope = {}) => {
      tenantData(scope.tenant ?? tenant).options.set(optionKey(scope.category ?? settingsCategory, key), value)
    },
    delete: (key, scope = {}) => tenantData(scope.tenant ?? tenant).options.delete(optionKey(scope.category ?? settingsCategory, key)),
  }

  function apply(state: Partial<C8yWorldState>): void {
    writable()
    if (state.tenant !== undefined) {
      tenant = state.tenant
    }
    if (state.user !== undefined) {
      user = state.user ? { ...state.user, roles: [...(state.user.roles ?? [])] } : null
      storeUser()
    }
    if (state.subscriptions !== undefined) {
      subscriptions = state.subscriptions.map((subscription) => ({ ...subscription }))
    }
    for (const [key, value] of Object.entries(state.tenantOptions ?? {})) {
      worldOptions.set(key, value)
    }
    options.onChange?.(world)
  }

  /**
   * The restricted caller of a request (`roles: 'enforce'`): a stored user of
   * the caller's tenant other than the world's user, or a registered
   * service's bootstrap or service user. Everyone else is unrestricted.
   * @param call - The recorded request
   */
  function callerAccess(call: C8yRequest): Access | undefined {
    if ((options.roles ?? 'enforce') === 'off' || call.user === undefined) {
      return undefined
    }
    if (user && call.user === user.userName && call.tenant === (user.tenant ?? tenant)) {
      return undefined
    }
    const own = applicationOfCredentials(tenants.values(), call.tenant, call.user)
    if (own) {
      return applicationAccess(call.user, own.bootstrap ? ['ROLE_SYSTEM'] : [...(own.application.requiredRoles as string[] ?? []), 'ROLE_SYSTEM'])
    }
    const data = context.tenantData?.(call.tenant)
    const stored = data?.users.get(call.user)
    return data && stored ? userAccess(data, stored) : undefined
  }

  /**
   * Platform endpoints a microservice relies on: the current user and the
   * microservice's subscriptions.
   * @param call - The recorded request
   * @param segments - Decoded path segments
   */
  function builtInRoute(call: C8yRequest, segments: string[]): Response | undefined {
    const { method } = call
    const [a, b] = segments

    if (method === 'GET' && a === 'user' && b === 'currentUser' && segments.length === 2) {
      const own = call.user === undefined ? undefined : applicationOfCredentials(tenants.values(), call.tenant, call.user)
      if (own) {
        // verified: an application's own users are not users of the tenant
        return Response.json(renderApplicationUser(own.data, call.user!, own.bootstrap ? [] : own.application.requiredRoles as string[] ?? []))
      }
      if (formerApplicationUser(call)) {
        return apiError(401, 'security/Unauthorized', 'Invalid credentials!')
      }
      const restricted = callerAccess(call)
      if (restricted && !restricted.roles.has('ROLE_USER_MANAGEMENT_OWN_READ')) {
        return apiError(403, 'security/Forbidden', 'Access Denied')
      }
      if (call.user !== undefined && (call.user !== user?.userName || call.tenant !== (user.tenant ?? tenant))) {
        // Basic auth of another user (by name or tenant): that user of the
        // caller's tenant, with its roles. A user the tenant does not store
        // gets the world's user, as before stored users answered here (the
        // fake checks no passwords, so a forwarded header naming another user
        // keeps working)
        const data = context.tenantData?.(call.tenant)
        const stored = data?.users.get(call.user)
        if (data && stored) {
          return Response.json(renderCurrentUser(data, stored))
        }
      }
      if (!user) {
        return Response.json({ error: 'security/Unauthorized', message: 'Invalid credentials!' }, { status: 401 })
      }
      const data = tenants.get(user.tenant ?? tenant)
      const stored = data?.users.get(user.userName)
      if (data && stored) {
        return Response.json(renderCurrentUser(data, stored))
      }
      // the user was deleted through the API: answer with the world's user
      const { roles = [], tenant: _tenant, groups: _groups, ...rest } = user
      return Response.json({
        id: user.userName,
        ...rest,
        effectiveRoles: roles.map((name) => ({ id: name, name })),
      })
    }

    if (a === 'application' && b === 'currentApplication') {
      return currentApplication(call, segments)
    }

    return undefined
  }

  /**
   * `/application/currentApplication/**`: answers only for an application's
   * own credentials (verified: a user gets 403). The world's own microservice
   * (`bootstrapUser`, `subscriptions`) has no stored application; a
   * registered service (`world.service()`) has one.
   * @param call - The recorded request
   * @param segments - Decoded path segments
   */
  function currentApplication(call: C8yRequest, segments: string[]): Response | undefined {
    const { method } = call
    const category = segments[2]
    if (call.user === undefined) {
      return apiError(401, 'security/Unauthorized', 'Invalid credentials!')
    }
    const own = applicationOfCredentials(tenants.values(), call.tenant, call.user)
    const legacy = !own && (call.user === bootstrapUser || subscriptions.some((subscription) => subscription.user === call.user))
    if (!own && !legacy && formerApplicationUser(call)) {
      return apiError(401, 'security/Unauthorized', 'Invalid credentials!')
    }
    if (!own && !legacy) {
      return apiError(403, 'security/Forbidden', 'Access Denied')
    }
    if (method === 'GET' && category === 'settings' && segments.length === 3) {
      // verified for the bootstrap user and a service user
      return Response.json(applicationSettings(tenantData(call.tenant), own ? settingsCategoryOf(own.application) : settingsCategory))
    }
    if (own && !own.bootstrap) {
      // verified: a service user reads only the settings
      return apiError(403, 'security/Forbidden', 'Access Denied')
    }
    if (method === 'GET' && category === 'subscriptions' && segments.length === 3) {
      if (!own) {
        return Response.json({
          users: subscriptions.map((subscription) => ({ tenant: subscription.tenant, name: subscription.user, password: subscription.password })),
        })
      }
      const users = [...tenants.values()].flatMap((data) => {
        const subscription = data.applicationSubscriptions.get(own.application.id)
        return subscription && subscription.owner === own.application.owner ? [{ tenant: data.tenant, name: subscription.serviceUser, password: subscription.password }] : []
      })
      return Response.json({ users })
    }
    if (segments.length === 2 && own && method === 'GET') {
      return Response.json(renderApplication(own.data, own.application))
    }
    if (segments.length === 2 && own && method === 'PUT') {
      return updateApplication(own.data, own.application, (call.body ?? {}) as Record<string, unknown>)
    }
    return undefined
  }

  /**
   * Whether a request uses the credentials of an application user that is
   * gone: a service user after its unsubscription, a bootstrap user after
   * its application's deletion (verified: 401). The world's own microservice
   * users and users of the tenant with such a name are not.
   * @param call - The recorded request
   */
  function formerApplicationUser(call: C8yRequest): boolean {
    return /^service(?:bootstrap)?_/.test(call.user ?? '') && call.user !== bootstrapUser && !subscriptions.some((subscription) => subscription.user === call.user)
      // a user of the tenant may have such a name too
      && !tenantData(call.tenant).users.has(call.user!)
  }

  function unsupportedAnswer(request: C8yUnhandledRequest): Response {
    if (typeof unsupported === 'function') {
      return unsupported(request, world)
    }
    if (unsupported === 'platform') {
      return apiError(501, 'general/Not Implemented', `${request.method} ${request.path} is not implemented`)
    }
    return apiError(501, 'fake-c8y/unsupported', `${request.method} ${request.path}: ${request.reason} by the fake Cumulocity platform. Answer it with world.override('${request.method} ${request.path}', ...).`)
  }

  const unhandledOf = new WeakMap<C8yRequest, C8yUnhandledRequest>()

  function recordUnhandled(call: C8yRequest, reason: string, kind: C8yUnhandledRequest['kind']): C8yUnhandledRequest {
    const unhandled: C8yUnhandledRequest = { ...call, reason, kind }
    unhandledRequests.push(unhandled)
    // a copy of the call: dispatch() sets its status and duration too
    unhandledOf.set(call, unhandled)
    options.onUnsupported?.(unhandled, world)
    return unhandled
  }

  /**
   * Records a request the world could not answer and answers it.
   * @param call - The recorded request
   * @param reason - Why
   * @param kind - What the fake is missing
   */
  function unhandledAnswer(call: C8yRequest, reason: string, kind: C8yUnhandledRequest['kind']): Response {
    const unhandled = recordUnhandled(call, reason, kind)
    if (kind !== 'error') {
      return unsupportedAnswer(unhandled)
    }
    return unsupported === 'developer'
      ? apiError(500, 'fake-c8y/error', `${call.method} ${call.path}: the fake Cumulocity platform failed: ${reason}`)
      : apiError(500, 'general/Internal Server Error', 'Internal server error')
  }

  /**
   * Answers a request, recording it in `calls` first.
   * @param request - The request
   * @param recorded - Receives the recorded request, for the caller's error handling
   * @param parent - The request a service sent this one for (`C8yRequest.parent`)
   */
  async function answer(request: Request, recorded: (call: C8yRequest) => void, parent: number | undefined): Promise<Response> {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()
    let segments: string[] | undefined
    try {
      segments = splitPath(url.pathname).map(decodeURIComponent)
    } catch {
      // malformed percent-encoding: answered below, after the call is recorded
    }
    const path = segments ? `/${segments.join('/')}` : url.pathname
    const caller = parseBasicAuth(request.headers.get('authorization'))
    const started = generation
    // read unconditionally: some runtimes (iso4) report `body === null` for a readable body
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (generation !== started) {
      // the world was reset or restored while the body was read: the request
      // belongs to the previous trial and must not change or show in this one
      return staleAnswer()
    }
    const contentType = request.headers.get('content-type') ?? ''
    const isBinary = contentType.startsWith('multipart/') || contentType.includes('octet-stream')
    const text = bytes.length > 0 && !isBinary ? new TextDecoder().decode(bytes) : ''
    let body: unknown = text || undefined
    let parsed = false
    try {
      body = text ? JSON.parse(text) : undefined
      parsed = true
    } catch {
      // keep text body
    }
    const call: C8yRequest = {
      id: ++callCount,
      ...(parent !== undefined ? { parent } : {}),
      method,
      path,
      // verified: a repeated parameter takes its first value
      query: [...url.searchParams].reduce<Record<string, string>>((query, [name, value]) => (Object.hasOwn(query, name) ? query : { ...query, [name]: value }), {}),
      body,
      headers: Object.fromEntries(request.headers),
      // the request works in the caller's tenant; `targetTenant` is not read
      tenant: caller?.tenant ?? tenant,
      user: caller?.user,
    }
    calls.push(call)
    recorded(call)
    rawRequests.set(call, { bytes, contentType, params: url.searchParams })
    if (!segments) {
      return apiError(400, 'general/Bad Request', `Malformed percent-encoding in the path ${url.pathname}`)
    }
    if (caller?.tenant !== undefined && caller.tenant !== tenant && !tenants.has(caller.tenant) && !subscriptions.some((subscription) => subscription.tenant === caller.tenant)) {
      // verified: credentials of a tenant the platform does not have answer
      // 401; a request never creates a tenant
      return apiError(401, 'security/Unauthorized', 'Invalid credentials!')
    }
    // verified: every request of a disabled user answers 401 (also one that
    // would enable it again); a request without credentials is the world's user
    const login = caller === undefined ? user && { tenant: user.tenant ?? tenant, name: user.userName } : { tenant: call.tenant, name: caller.user }
    if (login && tenants.get(login.tenant)?.users.get(login.name)?.enabled === false) {
      return apiError(401, 'security/Unauthorized', 'Authentication failed! : User account is locked')
    }
    tick()

    // the overrides registered when the request came in
    const stack = [...handlers]

    /**
     * Answers a request to an override.
     * @param entry - The override
     * @param params - What its pattern captured
     * @param below - Answers the request without it
     */
    const answerOverride = async (entry: RegisteredHandler, params: Record<string, string>, below: () => Promise<Response>): Promise<Response> => {
      const callCount = (callCounts.get(entry) ?? 0) + 1
      callCounts.set(entry, callCount)
      let passed = false
      const context: C8yOverrideContext = {
        tenant: call.tenant,
        user: call.user,
        params,
        world,
        callCount,
        next: async () => {
          if (passed) {
            throw new TypeError(`fake-c8y: next() was called twice for ${method} ${path}`)
          }
          passed = true
          return withReasonPhrase(generation === started ? await below() : staleAnswer())
        },
      }
      // a copy whose body can still be read
      const copy = new Request(request.url, { method: request.method, headers: request.headers, ...(bytes.length > 0 ? { body: bytes } : {}) })
      const result = await entry.handler(copy, context)
      return generation === started ? toResponse(result) : staleAnswer()
    }

    // what answers the request without overrides
    const emulate = async (): Promise<Response> => {
      const fallback = coreFallback(method, url.pathname)
      if (fallback) {
        uncounted.add(call)
        if (fallback.status === 404 || fallback.status === 405) {
          platformErrors.push({ ...call, status: fallback.status })
        }
        return fallback
      }

      // verified: an Accept header the endpoint cannot produce answers 406
      // before anything else is checked or written
      const accept = request.headers.get('accept')
      if (negotiate(method, segments, accept, contentType) === null) {
        return notAcceptable(method, segments, accept)
      }

      const builtIn = builtInRoute(call, segments)
      if (builtIn) {
        return withMediaType(method, segments, builtIn, contentType, accept)
      }

      if (segments[0] === 'service' && segments.length >= 2) {
        return routeService(segments[1]!, call, request, bytes, started)
      }

      // verified: the platform answers a JSON body that is not an object with
      // 400 (binary uploads are read from the raw bytes; other content types
      // are the handlers' business, e.g. 415 for an event update)
      if (text && /json/i.test(contentType) && !/\/binaries(?:\/|$)/.test(path) && (!parsed || (body !== null && (typeof body !== 'object' || Array.isArray(body))))) {
        const value = !parsed ? undefined : Array.isArray(body) ? 'Array value (token `JsonToken.START_ARRAY`)' : `${typeof body === 'string' ? 'String' : typeof body === 'number' ? 'Number' : 'Boolean'} value (${JSON.stringify(body)})`
        return apiError(400, 'Failed to parse JSON string', value
          ? `Cannot deserialize the request body from ${value}`
          : `Unrecognized token '${text.trim().split(/[\s,:{}[\]]/)[0]}': was expecting (JSON String, Number, Array, Object or token 'null', 'true' or 'false')`)
      }

      if (EMPTY_ERROR_DOMAINS.has(segments[0] ?? '')) {
        // verified: a write that declares JSON but has no body fails while parsing it
        if ((method === 'POST' || method === 'PUT') && !text && /json/i.test(contentType) && !path.endsWith('/unsubscribe')) {
          return apiError(400, 'Failed to parse JSON string', 'No content to map due to end-of-input\n at [Source: REDACTED (`StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION` disabled); line: 1]')
        }
      }

      let reason = 'endpoint not emulated'
      let kind: C8yUnhandledRequest['kind'] | undefined
      try {
        // the handlers run synchronously, so the value cannot belong to
        // another request while they read it
        actor = call.user ?? user?.userName ?? DEFAULTS.user.userName
        current = call
        access = callerAccess(call)
        const denied = access && authorize(call, segments, tenantData(call.tenant), access)
        if (denied) {
          return withMediaType(method, segments, denied, contentType, accept)
        }
        // the raw pathname (an encoded `/` in a path parameter is not a
        // segment), with repeated slashes collapsed like the platform does
        const specPath = url.pathname.replace(/\/{2,}/g, '/')
        let response = platformApi(call, segments, tenantData(call.tenant))
        if (response && response.status >= 400 && response.status !== 406 && mediaType(method, segments) === undefined) {
          // verified: a path or method the API does not have answers with an
          // empty body, also where a handler reads it as a resource
          const empty = specAnswer(method, specPath)
          response = empty && (empty.status === 404 || response.status === 405) ? empty : response
        }
        if (response) {
          return withLocation(withMediaType(method, segments, response, contentType, accept)).then((answered) => writeAnswer(method, segments, url.pathname, accept, answered))
        }
        const specResponse = specAnswer(method, specPath)
        if (specResponse) {
          platformErrors.push({ ...call, status: specResponse.status })
          return specResponse
        }
      } catch (error) {
        if (!(error instanceof UnsupportedRequestError)) {
          throw error
        }
        reason = error.message
        kind = 'feature'
      } finally {
        actor = undefined
        current = undefined
        access = undefined
      }

      if (kind === undefined) {
        // a path in the spec's APIs reaching this point is a known endpoint (specAnswer() answers the others)
        kind = SPEC_DOMAINS.has(url.pathname.split('/')[1]!) ? 'endpoint' : 'outside-spec'
      }
      if (kind === 'outside-spec') {
        uncounted.add(call)
      }
      return unhandledAnswer(call, reason, kind)
    }

    // overrides first, most recently registered wins; next() goes on to the
    // older ones, then to the emulation
    const route = async (below: number): Promise<Response> => {
      for (let i = below - 1; i >= 0; i--) {
        const entry = stack[i]!
        const params = entry.route ? matchRoute(entry.route, method, segments) : {}
        if (params) {
          return answerOverride(entry, params, () => route(i))
        }
      }
      return emulate()
    }

    return route(stack.length)
  }

  /**
   * Answers `/service/<contextPath>/**` like the platform: a microservice the
   * caller's tenant is subscribed to reaches its registered service; without
   * a subscription (also after the application was deleted) the platform
   * answers 404 `microservice/Not Found`.
   * @param contextPath - The microservice's context path
   * @param call - The recorded request
   * @param request - The original request
   * @param bytes - Its body
   * @param started - The generation the request started in
   */
  function routeService(contextPath: string, call: C8yRequest, request: Request, bytes: Uint8Array<ArrayBuffer>, started: number): Response | Promise<Response> {
    const application = subscribedMicroservice(tenantData(call.tenant), contextPath)
    const service = services.get(contextPath)
    if (application && service) {
      call.service = contextPath
      if (!service.handler) {
        return unhandledAnswer(call, `service ${contextPath} is registered without a handler`, 'feature')
      }
      return answerService(service, service.handler, contextPath, call, request, bytes, started)
    }
    if (application && application.owner === 'management') {
      // a microservice of the platform the world does not emulate
      return unhandledAnswer(call, `microservice ${contextPath} is subscribed but not emulated (register it with world.service('${contextPath}', ...))`, 'outside-spec')
    }
    // verified: a microservice the tenant does not have, one it is no
    // longer subscribed to, and a subscribed one without an uploaded binary
    // (not running) are a platform 404 (answer one with
    // world.override('/service/<name>/**', ...))
    platformErrors.push({ ...call, status: 404 })
    return apiError(404, 'microservice/Not Found', `Microservice ${contextPath} not found.`)
  }

  /**
   * Answers a request to a registered service.
   * @param service - The service
   * @param handler - Its handler
   * @param name - Its context path
   * @param call - The recorded request
   * @param request - The original request
   * @param bytes - Its body
   * @param started - The generation the request started in
   */
  async function answerService(service: RegisteredService, handler: C8yServiceHandler, name: string, call: C8yRequest, request: Request, bytes: Uint8Array<ArrayBuffer>, started: number): Promise<Response> {
    const url = new URL(request.url)
    // the microservice sees the path below its context path
    const rest = url.pathname.replace(/^\/service\/[^/]+/, '') || '/'
    const forwarded = new Request(`${url.origin}${rest}${url.search}`, { method: request.method, headers: request.headers, ...(bytes.length > 0 ? { body: bytes } : {}) })
    let result: Response
    try {
      result = await handler(forwarded, serviceContext(service, name, call, started))
    } catch (error) {
      if (generation !== started) {
        return staleAnswer()
      }
      const unhandled = typeof error === 'object' && error !== null ? reported.get(error) : undefined
      if (unhandled) {
        return unsupportedAnswer(unhandled)
      }
      throw error
    }
    return generation === started ? toResponse(result) : staleAnswer()
  }

  /**
   * The service user of a registered service in a tenant: from its
   * subscription, else the name it was registered with.
   * @param service - The service
   * @param contextPath - Its context path
   * @param name - Tenant
   */
  function serviceUserOf(service: RegisteredService, contextPath: string, name: string): { name: string, password: string } {
    const data = tenantData(name)
    const application = subscribedMicroservice(data, contextPath)
    const subscription = application && data.applicationSubscriptions.get(application.id)
    if (subscription?.serviceUser) {
      return { name: subscription.serviceUser as string, password: subscription.password as string }
    }
    return { name: service.user ?? `service_${service.manifest.name ?? contextPath}`, password: 'service-password' }
  }

  /**
   * Creates what the platform creates for an uploaded and subscribed
   * microservice, unless it is there: the application (in the owner tenant)
   * and the subscriptions with their service users, roles, and settings.
   * With `previous` (the registration the data shows) and other options, it
   * brings the application and the subscriptions up to date instead, like a
   * new upload of the microservice.
   * @param contextPath - Its context path
   * @param service - The service
   * @param previous - The registration it replaces
   */
  function installService(contextPath: string, service: RegisteredService, previous?: RegisteredService): void {
    const owner = service.owner ?? tenant
    const refresh = previous !== undefined && !sameRegistration(previous, service)
    if (refresh && (previous.owner ?? tenant) !== owner) {
      removeApplication(contextPath, previous)
    }
    const data = tenantData(owner)
    let application = microserviceOf(data, contextPath)
    if (!application) {
      application = microserviceFromManifest(data, contextPath, service.manifest)
      data.applications.set(application.id, application)
    } else if (refresh) {
      const updated: StoredDocument = { ...microserviceFromManifest(data, contextPath, service.manifest, application.id), availability: application.availability }
      if (JSON.stringify(updated) !== JSON.stringify(application)) {
        data.applications.set(application.id, updated)
        application = updated
      }
      const subscribers = service.tenants ?? [owner]
      for (const former of previous.tenants ?? [previous.owner ?? tenant]) {
        if (!subscribers.includes(former)) {
          unsubscribe(tenantData(former), application.id)
        }
      }
    }
    for (const subscriber of service.tenants ?? [owner]) {
      subscribe(tenantData(subscriber), application, service.user, refresh)
    }
  }

  /**
   * Deletes the application of a registered service, if it is there.
   * @param contextPath - Its context path
   * @param service - The service
   */
  function removeApplication(contextPath: string, service: RegisteredService): void {
    const data = tenantData(service.owner ?? tenant)
    const application = microserviceOf(data, contextPath)
    if (application) {
      deleteApplication(data, application.id)
    }
  }

  /**
   * Applies a service definition's seed in every subscribed tenant: its
   * state, and its managed objects with the service user as owner.
   * @param contextPath - Its context path
   * @param service - The service
   */
  function seedService(contextPath: string, service: RegisteredService): void {
    const { seed } = service.definition
    if (!seed) {
      return
    }
    for (const subscriber of service.tenants ?? [service.owner ?? tenant]) {
      const tenantSeed = typeof seed === 'function' ? seed(subscriber) : seed
      if (typeof seed === 'function') {
        checkServiceSeed(contextPath, tenantSeed, subscriber)
      }
      const data = tenantData(subscriber)
      for (const { store = 'default', key, value } of tenantSeed.state ?? []) {
        data.serviceState.set(serviceStateKey(contextPath, store, key), toJson(value))
      }
      const serviceUser = serviceUserOf(service, contextPath, subscriber).name
      for (const input of tenantSeed.managedObjects ?? []) {
        try {
          createFromInput(data, input, serviceUser)
        } catch (error) {
          throw new TypeError(`fake-c8y: service ${contextPath}: seed for ${subscriber}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /**
   * Registers a service definition (`world.service()`).
   * @param source - The object passed in
   * @param definition - It, checked
   * @param handler - The handler it answers with
   */
  function registerService(source: object, definition: C8yService, handler: C8yServiceHandler | undefined): () => void {
    const { contextPath } = definition
    const previous = services.get(contextPath)
    if (previous?.source === source) {
      const own = removers.get(previous)
      if (own && previous.handler === handler) {
        return own
      }
      // the same definition with another handler (a fork answering what its
      // base installed): the data stays as it is
      const entry: RegisteredService = { ...previous, handler }
      services.set(contextPath, entry)
      return removerOf(contextPath, entry)
    }
    const manifest = definition.manifest ? { ...definition.manifest } : {}
    const entry: RegisteredService = { definition, source, handler, user: definition.user, manifest, owner: definition.owner, tenants: definition.tenants ? [...definition.tenants] : undefined }
    services.set(contextPath, entry)
    registrationWrite(() => {
      installService(contextPath, entry, previous)
      seedService(contextPath, entry)
    })
    return removerOf(contextPath, entry)
  }

  /**
   * The function that removes a registration of this world.
   * @param contextPath - Its context path
   * @param entry - The registration
   */
  function removerOf(contextPath: string, entry: RegisteredService): () => void {
    const remove = (): void => {
      if (services.get(contextPath) !== entry) {
        return
      }
      // a fork's replacement gives way to the service it inherited
      const inherited = base?.services.get(contextPath)
      if (inherited) {
        services.set(contextPath, inherited)
        registrationWrite(() => installService(contextPath, inherited, entry))
        return
      }
      services.delete(contextPath)
      registrationWrite(() => removeApplication(contextPath, entry))
    }
    removers.set(entry, remove)
    return remove
  }

  /**
   * Runs the writes of a service registration. On a frozen base they go into
   * a new frozen layer on top of its tenants, so forks created afterwards
   * start with them as base data (an empty diff) and earlier forks, which
   * keep the tenants they were forked from, do not see them.
   * @param write - The writes
   */
  function registrationWrite(write: () => void): void {
    if (!frozen) {
      write()
      return
    }
    const before = new Map(tenants)
    for (const [name, data] of before) {
      const layer = { ...data }
      for (const collection of TENANT_COLLECTIONS) {
        (layer as unknown as Record<TenantCollection, Collection<unknown>>)[collection] = data[collection].fork()
      }
      tenants.set(name, layer)
    }
    frozen = false
    try {
      write()
    } finally {
      frozen = true
      for (const [name, layer] of tenants) {
        const original = before.get(name)
        if (!original) {
          // a tenant the registration created
          freezeTenant(layer, true)
          continue
        }
        let changed = false
        for (const collection of TENANT_COLLECTIONS) {
          if (layer[collection].pristine) {
            (layer as unknown as Record<TenantCollection, Collection<unknown>>)[collection] = original[collection]
          } else {
            layer[collection].freeze(true)
            changed = true
          }
        }
        tenants.set(name, changed ? layer : original)
      }
    }
  }

  function serviceContext(service: RegisteredService, name: string, call: C8yRequest, started: number): C8yServiceContext {
    const live = () => {
      if (generation !== started) {
        throw new TypeError('fake-c8y: the world was reset or restored while this service request was in flight')
      }
    }
    const data = () => tenantData(call.tenant)
    const state = serviceStore(data, name, 'default', live)
    const serviceUser = serviceUserOf(service, name, call.tenant)
    const login = encodeBase64(new TextEncoder().encode(`${call.tenant}/${serviceUser.name}:${serviceUser.password}`))
    return {
      service: name,
      tenant: call.tenant,
      user: call.user ?? user?.userName ?? DEFAULTS.user.userName,
      serviceUser: serviceUser.name,
      call: call.parent === undefined ? { id: call.id } : { id: call.id, parent: call.parent },
      now: () => {
        live()
        return clock()
      },
      newId: () => {
        live()
        return context.newId()
      },
      state,
      store: (store) => (store === 'default' ? state : serviceStore(data, name, store, live)),
      fetch: async (input, init) => {
        if (generation !== started) {
          return await withReasonPhrase(staleAnswer())
        }
        const outgoing = new Request(typeof input === 'string' && input.startsWith('/') ? `${baseUrl}${input}` : input, init)
        if (!outgoing.headers.has('authorization')) {
          outgoing.headers.set('authorization', `Basic ${login}`)
        }
        return send(outgoing, call.id)
      },
      unsupported: (reason) => {
        const error = new UnsupportedRequestError(reason)
        if (generation === started) {
          reported.set(error, recordUnhandled(call, reason, 'feature'))
        }
        throw error
      },
    }
  }

  /**
   * Answers a request (`world.fetch()`, and requests of services). Never throws.
   * @param request - The request
   * @param parent - The request a service sent this one for
   */
  /**
   * Sends a request like `fetch` does with its signal: an aborted signal
   * rejects with its reason and nothing is sent; a signal that fires before
   * the answer rejects the waiting caller at once (the request still runs to
   * its end and is recorded as `aborted`).
   * @param request - The request
   * @param parent - The request a service sent this one for
   */
  function send(request: Request, parent: number | undefined): Promise<Response> {
    const { signal } = request
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal))
    }
    const answered = dispatch(request, parent)
    if (!signal) {
      return answered
    }
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(abortReason(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      answered.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort)).catch(() => undefined)
    })
  }

  async function dispatch(request: Request, parent: number | undefined): Promise<Response> {
    inflight++
    const started = generation
    // iso4 has no `performance`
    const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now()
    let call: C8yRequest | undefined
    let status = 500
    try {
      const response = await answer(request, (recorded) => {
        call = recorded
      }, parent)
      status = response.status
      return await withReasonPhrase(response)
    } catch (error) {
      if (generation !== started) {
        // an override or a service failed after a reset: not a request of this trial
        return await withReasonPhrase(staleAnswer())
      }
      // a failure of the fake (or of an override or a service) is a 500
      // that makes the trial invalid
      if (!call) {
        call = { id: ++callCount, ...(parent !== undefined ? { parent } : {}), method: request.method.toUpperCase(), path: request.url, query: {}, body: undefined, headers: {}, tenant, user: undefined }
        calls.push(call)
      }
      const reason = error instanceof Error ? error.message : String(error)
      const response = error instanceof UnsupportedRequestError
        ? unhandledAnswer(call, reason, 'feature')
        : unhandledAnswer(call, `${error instanceof Error ? error.name : 'Error'}: ${reason}`, 'error')
      status = response.status
      return await withReasonPhrase(response)
    } finally {
      inflight--
      if (call) {
        call.status = status
        if (request.signal?.aborted) {
          call.aborted = true
        }
        call.durationMs = (typeof performance === 'undefined' ? Date.now() : performance.now()) - startedAt
        const unhandled = unhandledOf.get(call)
        if (unhandled) {
          unhandled.status = call.status
          unhandled.durationMs = call.durationMs
        }
      }
      if (call && generation === started && !uncounted.has(call)) {
        usage.record(call, status, clock(), tenants.get(call.tenant))
      }
    }
  }

  function snapshot(): WorldSnapshot {
    return {
      version: 1,
      nextId,
      tenant,
      user: copyUser(user),
      subscriptions: subscriptions.map((subscription) => ({ ...subscription })),
      options: snapshotOptions(tenants),
      tenants: snapshotTenants(tenants),
    }
  }

  function freeze(): void {
    if (frozen) {
      return
    }
    tick()
    for (const data of tenants.values()) {
      freezeTenant(data, true)
    }
    frozen = true
  }

  function owner(): string {
    return user?.userName ?? DEFAULTS.user.userName
  }

  // every db access first catches up with the clock (bulk operations)
  const caughtUp = (name: string) => {
    tick()
    return tenantData(name)
  }
  const db = {
    ...createDb(() => caughtUp(tenant)),
    tenant: (name: string) => createDb(() => caughtUp(name)),
  } as C8yDb

  world = {
    baseUrl,
    get tenant() {
      return tenant
    },
    get user() {
      return user
    },
    get subscriptions() {
      return subscriptions
    },
    get calls() {
      return calls
    },
    set calls(value) {
      calls = value
    },
    get unhandled() {
      return unhandledRequests
    },
    set unhandled(value) {
      unhandledRequests = value
    },
    coverage() {
      return { valid: unhandledRequests.length === 0, unhandled: [...unhandledRequests], platformErrors: [...platformErrors] }
    },
    get inflight() {
      return inflight
    },
    realtime,
    db,
    options: worldOptions,

    fetch: (request) => send(request, undefined),

    reset(next) {
      writable()
      generation++
      calls = []
      usage = new UsageLog()
      callCount = 0
      callCounts = new Map()
      unhandledRequests = []
      platformErrors = []
      tenants.clear()
      if (base) {
        // back to the state of the fork's creation, then the new baseline on top
        if (forkStart !== undefined && clock() !== forkStart) {
          options.clock!.set(forkStart)
        }
        handlers = [...base.handlers]
        nextId = base.nextId
        tenant = base.tenant
        user = copyUser(base.user)
        subscriptions = base.subscriptions.map((subscription) => ({ ...subscription }))
        for (const [name, data] of base.tenants) {
          tenants.set(name, forkTenant(data, context))
        }
        apply(next ? pickState(next) : {})
        // the base's data has the services it had at fork time; the fork's
        // own registrations go on top
        for (const [contextPath, service] of services) {
          const inherited = base.services.get(contextPath)
          if (service !== inherited) {
            installService(contextPath, service, inherited)
            if (service.source !== inherited?.source) {
              seedService(contextPath, service)
            }
          }
        }
        realtime.resync()
        return
      }
      if (next) {
        baseline = pickState(next)
      }
      tenant = baseline.tenant ?? DEFAULTS.tenant
      handlers = []
      nextId = 1
      apply({
        user: baseline.user === undefined ? DEFAULTS.user : baseline.user,
        subscriptions: baseline.subscriptions ?? [defaultSubscription(tenant)],
        ...(baseline.tenantOptions ? { tenantOptions: baseline.tenantOptions } : {}),
      })
      // services are base data: installed and seeded again
      for (const [contextPath, service] of services) {
        installService(contextPath, service)
        seedService(contextPath, service)
      }
      realtime.resync()
    },

    apply,
    setUser,

    service: ((first: string | C8yServiceDefinition, second?: C8yServiceHandler | { handler?: C8yServiceHandler | undefined }, third?: C8yServiceOptions) => {
      if (typeof first === 'string') {
        const definition = defineService({ ...third, contextPath: first, handler: second as C8yServiceHandler })
        return registerService(definition, definition, definition.handler)
      }
      const definition = defineService(first)
      const options = second as { handler?: C8yServiceHandler | undefined } | undefined
      if (options?.handler !== undefined && typeof options.handler !== 'function') {
        throw new TypeError(`fake-c8y: service ${definition.contextPath}: handler must be a function`)
      }
      return registerService(first, definition, options?.handler ?? definition.handler)
    }) as World['service'],

    get services() {
      return new Map([...services].map(([contextPath, service]) => [contextPath, service.definition]))
    },

    override(first: string | C8yOverrideHandler, second?: C8yOverrideHandler) {
      const entry: RegisteredHandler = typeof first === 'string' ? { route: compileRoute(first), handler: second! } : { route: undefined, handler: first }
      handlers.push(entry)
      return () => {
        handlers = handlers.filter((item) => item !== entry)
      }
    },

    managedObject(input = {}) {
      return createFromInput(tenantData(input.tenant ?? tenant), input, owner())
    },

    device(input = {}) {
      return createFromInput(tenantData(input.tenant ?? tenant), { c8y_IsDevice: {}, ...input }, owner())
    },

    binary(input) {
      return createBinaryFromInput(tenantData(input.tenant ?? tenant), input, owner())
    },

    seed(seed) {
      for (const { service } of seed.serviceState ?? []) {
        if (!services.has(service)) {
          throw new TypeError(`fake-c8y: seed(): service ${service} is not registered (register it with world.service() first)`)
        }
      }
      return applySeed(tenantData(seed.tenant ?? tenant), seed, owner()) as C8ySeedResultFor<typeof seed>
    },

    tick,

    advance(ms) {
      if (!options.clock) {
        throw new TypeError('fake-c8y: advance() needs a world created with a clock (createWorld({ clock: createClock(...) }))')
      }
      options.clock.advance(ms)
      tick()
    },

    muted(operation) {
      muted++
      let result: ReturnType<typeof operation>
      try {
        result = operation()
      } catch (error) {
        muted--
        throw error
      }
      if (result instanceof Promise) {
        // muted until the promise settles
        return result.finally(() => {
          muted--
        }) as typeof result
      }
      muted--
      return result
    },

    snapshot,

    restore(snapshot) {
      writable()
      generation++
      // the statistics of requests are not part of a snapshot: they start
      // over like after reset() (the call log stays)
      usage = new UsageLog()
      nextId = snapshot.nextId
      tenant = snapshot.tenant
      user = copyUser(snapshot.user)
      subscriptions = snapshot.subscriptions.map((subscription) => ({ ...subscription }))
      tenants.clear()
      for (const data of restoreTenants(snapshot.tenants, context, (name) => base?.tenants.get(name))) {
        tenants.set(data.tenant, data)
      }
      for (const [name, data] of base?.tenants ?? []) {
        if (!tenants.has(name)) {
          // a fork hides the base tenants the snapshot does not have
          const hidden = forkTenant(data, context)
          for (const collection of TENANT_COLLECTIONS) {
            hidden[collection].replace([])
          }
          tenants.set(name, hidden)
        }
      }
      const restoredOptions = new Map<string, Array<[string, string | null]>>()
      for (const [optionTenant, category, key, value] of snapshot.options) {
        const entries = restoredOptions.get(optionTenant) ?? []
        entries.push([optionKey(category, key), value])
        restoredOptions.set(optionTenant, entries)
      }
      for (const [optionTenant, entries] of restoredOptions) {
        // in one go, so a fork keeps the base's unchanged options
        tenantData(optionTenant).options.replace(entries)
      }
      // the snapshot has the applications of the services as they were
      // (also deleted or unsubscribed ones): nothing is installed here
      realtime.resync()
      // build the availability queues at the time of the restore, so an
      // alarm still to come at that time is raised later (availability.ts)
      tick()
      options.onChange?.(world)
    },

    diff(since) {
      if (since) {
        return diffSnapshots(since, snapshot())
      }
      if (!base) {
        throw new TypeError('fake-c8y: diff() needs a snapshot, except on a fork (world.fork())')
      }
      const touched = touchedSnapshots(tenants, (name) => base.tenants.has(name))
      return diffWorld(touched.before, touched.after, touched.recreated)
    },

    fork(forkOptions = {}) {
      freeze()
      const merged: WorldOptions = { ...options, ...forkOptions }
      if (forkOptions.now && !forkOptions.clock) {
        // the fork's own `now` replaces the base's clock
        delete merged.clock
      } else if (!forkOptions.clock && options.clock) {
        // a clock of its own at the base's time, so advance() moves only this fork
        const baseClock = options.clock
        merged.clock = baseClock.copy?.() ?? offsetClock(baseClock)
      }
      return buildWorld(merged, {
        // a copy: a service registered on the frozen base later replaces
        // tenants with layers that only later forks see
        tenants: new Map(tenants),
        nextId,
        tenant,
        user: copyUser(user),
        subscriptions: subscriptions.map((subscription) => ({ ...subscription })),
        handlers: [...handlers],
        services: new Map(services),
        ownClock: !forkOptions.clock && !forkOptions.now && options.clock !== undefined,
      })
    },

    get frozen() {
      return frozen
    },
  }

  world.reset()
  return world
}

/**
 * A clock that follows another one, moved by its own `advance()` and `set()`
 * (for clocks without `copy()`).
 * @param base - The clock to follow
 */
function offsetClock(base: Clock): Clock {
  let offset = 0
  const clock: Clock = {
    now: () => base.now() + offset,
    advance: (ms) => {
      offset += ms
    },
    set: (time) => {
      offset = (typeof time === 'number' ? time : parseIsoTime(time)) - base.now()
    },
    copy: () => {
      const copy = offsetClock(base)
      copy.advance(offset)
      return copy
    },
  }
  return clock
}

function pickState(state: C8yWorldState): C8yWorldState {
  const { tenant, user, subscriptions, tenantOptions } = state
  return {
    ...(tenant !== undefined ? { tenant } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(subscriptions !== undefined ? { subscriptions } : {}),
    ...(tenantOptions !== undefined ? { tenantOptions } : {}),
  }
}

export { createClock } from './clock'
export type { Clock, ClockOptions } from './clock'
export { diffSnapshots } from './snapshot'
export type { BinarySnapshot, CollectionDiff, RelationChange, TenantDiff, TenantSnapshot, UserSequences, WorldDiff, WorldSnapshot } from './snapshot'
export { UnsupportedRequestError } from './api'
export { compileRoute, matchRoute, splitPath } from './router'
export type { CompiledRoute } from './router'
export { DEFAULTS } from './defaults'
export { Realtime, SOCKET_STATE } from './realtime'
export type { NotificationFrame, NotificationSocket, NotificationSubscription, NotificationToken, RealtimeApi, RealtimeOptions } from './realtime'
export type * from './types'
export type { C8yAlarmInput, C8yAuditRecordInput, C8yBinaryContent, C8yBinaryInput, C8yDb, C8yDbCollection, C8yDbFilter, C8yEventInput, C8yGroupInput, C8yIdInput, C8yInventoryRoleInput, C8yManagedObjectInput, C8yMeasurementInput, C8yNewDeviceRequestInput, C8yOperationInput, C8yRetentionRuleInput, C8ySeed, C8ySeedResult, C8ySeedResultFor, C8yUserInput } from './data'
export { DEFAULT_ROLES } from './user-defaults'
export { LIVE_CAPACITY } from './generators'
export type { C8yGeneratedSeriesInput, C8yMeasurementGeneratorInput, C8yTimeRange, C8yWave, GeneratorSnapshot, MeasurementTombstone, PointTombstone, RangeTombstone } from './generators'
export type { C8yNewDeviceRequestStatus } from './api/registration'
export type { C8yApplicationInput, C8yMicroserviceManifest } from './api/applications'
export { DEFAULT_APPLICATIONS } from './application-defaults'
export { defineService } from './services'
export type { C8yJson, C8yService, C8yServiceContext, C8yServiceDefinition, C8yServiceHandler, C8yServiceOptions, C8yServiceSeed, C8yServiceStateInput, C8yServiceStore } from './services'
export type { AuditChange } from './api/audit'
export type { C8yAlarmSeverity, C8yAlarmStatus, C8yEndpoint, C8yOperationStatus } from './capabilities.generated'
export { C8Y_ENDPOINTS, C8Y_ENUMS, C8Y_SPEC_PATHS } from './capabilities.generated'
