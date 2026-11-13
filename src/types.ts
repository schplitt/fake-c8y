import type { World } from './index'

/**
 * The user calling the platform (returned by `GET /user/currentUser`). The
 * world stores it as a user of its tenant, so the user API sees it too.
 */
export interface C8yUser {
  userName: string
  /**
   * Global roles assigned to the user directly. Its effective roles are these
   * plus the roles of its `groups`.
   */
  roles?: string[]
  /**
   * Tenant the user belongs to: the tenant it is stored in and that
   * `/user/currentUser` matches Basic auth against.
   * @default the deployed tenant
   */
  tenant?: string
  /**
   * Groups the user is a member of, by name or id (e.g. `['admins']`). Their
   * roles add to the effective roles.
   */
  groups?: Array<string | number>
  /**
   * Any other `ICurrentUser` fields (email, firstName, …).
   */
  [field: string]: unknown
}

/**
 * Service user credentials of a tenant subscribed to the microservice.
 */
export interface C8ySubscription {
  tenant: string
  user: string
  password: string
}

/**
 * State of the fake Cumulocity platform: the baseline a world starts (and
 * resets) with, and partial updates in `world.apply()`.
 */
export interface C8yWorldState {
  /**
   * Tenant the microservice is deployed in (the bootstrap tenant).
   * @default 't12345'
   */
  tenant?: string
  /**
   * User calling the microservice. `null` makes `GET /user/currentUser`
   * answer 401.
   * @default { userName: 'test-user', roles: [] }
   */
  user?: C8yUser | null
  /**
   * Tenants subscribed to the microservice, with their service users.
   * @default one subscription for the deployed tenant
   */
  subscriptions?: C8ySubscription[]
  /**
   * Tenant options of the microservice's own settings category, in the deployed tenant.
   */
  tenantOptions?: Record<string, string>
}

/**
 * A request the microservice sent to the (fake) platform.
 */
export interface C8yRequest {
  /**
   * Number of the request in the world's call log (from 1, again after a
   * reset).
   */
  id: number
  /**
   * For a request a service emulation sent while answering another one
   * (`ctx.fetch()`): the `id` of that request. Following the links gives
   * the trace, e.g. agent -> service -> platform.
   */
  parent?: number
  method: string
  /**
   * Path without query, e.g. `/inventory/managedObjects/42`.
   */
  path: string
  query: Record<string, string>
  /**
   * Parsed JSON body, raw text, or `undefined`.
   */
  body: unknown
  headers: Record<string, string>
  /**
   * Tenant the request works in: the caller's tenant (Basic auth prefix),
   * else the deployed tenant. The fake does not read `targetTenant`.
   */
  tenant: string
  /**
   * User name from basic auth, if any.
   */
  user: string | undefined
  /**
   * HTTP status of the answer, set once the world answered the request.
   */
  status?: number
  /**
   * How long the world took to answer, in milliseconds of host time (not the
   * trial clock), set with `status`.
   */
  durationMs?: number
  /**
   * Set when the caller's signal fired before the answer: the caller got the
   * signal's reason, while the world still answered the request.
   */
  aborted?: true
  /**
   * The context path of the registered service (`world.service()`) that
   * answered the request, for a request to `/service/<contextPath>/**` that
   * reached its handler.
   */
  service?: string
  /**
   * The documents the request wrote, in order: managed objects,
   * measurements, events, alarms, and operations it created, updated, or
   * deleted (audit records and the platform's own time-based work are left
   * out). An eval reads who changed what from it, following `parent` up to
   * the service that sent the request.
   */
  writes?: C8yWrite[]
}

/**
 * A document a request wrote (`C8yRequest.writes`).
 */
export interface C8yWrite {
  collection: 'managedObjects' | 'measurements' | 'events' | 'alarms' | 'operations'
  id: string
  action: 'created' | 'updated' | 'deleted'
}

/**
 * A platform request the fake tenant could not answer.
 */
export interface C8yUnhandledRequest extends C8yRequest {
  /**
   * Why the fake tenant could not answer it.
   */
  reason: string
  /**
   * What the fake is missing:
   * - `'endpoint'`: an endpoint of the platform's API (in its OpenAPI spec)
   *   that the fake does not emulate.
   * - `'feature'`: an emulated endpoint, but a query parameter or a variant of
   *   the request (e.g. a bulk operation on a dynamic group) is not emulated.
   * - `'outside-spec'`: a path outside the core API's spec and outside
   *   `/service/**`. The platform answers it somehow; the fake cannot know
   *   how. (A microservice without an override answers 404 like the
   *   platform, in `platformErrors`.)
   * - `'error'`: the fake (or a `world.override()` handler) threw while
   *   answering; the world answered 500.
   */
  kind: 'endpoint' | 'feature' | 'outside-spec' | 'error'
}

/**
 * Whether the requests since the last reset stayed inside the emulation, for
 * an eval harness to tell a trial it can grade from one it cannot
 * (`world.coverage()`).
 */
export interface C8yCoverage {
  /**
   * `true` if the world answered every request as the platform would: no
   * request was unhandled. A trial with `valid: false` saw at least one
   * made-up answer (a 501) and is not a faithful run.
   */
  valid: boolean
  /**
   * The requests the world could not answer (`world.unhandled`), each with
   * its `kind`. Any of them makes the trial invalid.
   */
  unhandled: C8yUnhandledRequest[]
  /**
   * Requests to a path the platform does not have (404) or with a method the
   * path does not take (405). The world answers them like the platform, so
   * they are the client's mistakes and do not make the trial invalid.
   */
  platformErrors: Array<C8yRequest & { status: 404 | 405 }>
}

/**
 * What every handler the world calls gets besides the request: an override
 * (`world.override()`) and a service (`world.service()`).
 */
export interface C8yHandlerContext {
  /**
   * The caller's tenant: the tenant whose data the request works with.
   */
  readonly tenant: string
  /**
   * The request being answered, as the call log records it (`world.calls`):
   * `id` (its number in the log), `parent` (the request a service sent it
   * for), and the parsed `query` and `body`. `status` and `durationMs` are
   * set once the world answered it.
   */
  readonly call: Readonly<C8yRequest>
  /**
   * Records the request as unhandled (kind `'feature'`, the trial is
   * invalid) and throws; the world answers it like any request it does not
   * emulate. The trial stays invalid even if the handler catches the error.
   * @param reason - What the emulation does not support
   */
  unsupported: (reason: string) => never
}

/**
 * What a `world.override()` handler gets besides the request.
 */
export interface C8yOverrideContext extends C8yHandlerContext {
  /**
   * The caller's user name (Basic auth), if any.
   */
  readonly user: string | undefined
  /**
   * The params the pattern captured: `:name` segments, and `_` for the rest
   * a `**` matched.
   */
  readonly params: Record<string, string>
  /**
   * The world answering the request: the fork it was sent to, also for an
   * override registered on the base.
   */
  readonly world: World
  /**
   * Which match of this override this is in the answering world, from 1:
   * `matchCount === 2` is the second request it matched. A fork counts on
   * its own (from 1), and `reset()` starts over.
   */
  readonly matchCount: number
  /**
   * Answers the request as if this override did not exist: the next older
   * matching override, else a service or the emulated platform, and returns
   * that answer. What it writes stays written, whatever the handler returns
   * afterwards. The call log keeps one call (the client's), with the status
   * the handler finally returns. Callable once per request; after a reset
   * or restore it answers 503 and changes nothing.
   */
  next: () => Promise<Response>
}

/**
 * Answers a request instead of the world. The request is a copy whose body
 * can be read. Return a `Response` for full control (status, headers), any
 * other value to answer `200` with it as JSON, or nothing for `204`.
 */
export type C8yOverrideHandler = (request: Request, context: C8yOverrideContext) => unknown
