# The world

A world is one in-memory Cumulocity platform: tenants with their data, tenant options, users, applications, and Notification 2.0. `createWorld(options?)` creates one.

## Options

```ts
import { createWorld } from 'fake-c8y'

const world = createWorld({
  tenant: 't100',
  user: { userName: 'admin', roles: ['ROLE_INVENTORY_READ'] },
  subscriptions: [{ tenant: 't100', user: 'service_t100', password: 'secret' }],
  tenantOptions: { 'feature.enabled': 'true' },
  baseUrl: 'https://t100.cumulocity.test',
  now: () => Date.parse('2026-01-01T00:00:00Z'),
  unsupported: 'platform',
  onUnsupported: (request) => console.log(request.kind, request.method, request.path),
})
```

| Option             | Default                                  | Meaning                                                                                                                                     |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`           | `'t12345'`                               | Tenant the microservice is deployed in. Requests without a tenant in their Basic auth go here.                                              |
| `user`             | `{ userName: 'test-user', roles: [] }`   | User that `GET /user/currentUser` answers with. `null` answers 401. The world also stores it as a user of its tenant.                       |
| `subscriptions`    | `service_<tenant>`, `service-password`   | Tenants subscribed to the microservice, with their service users and passwords.                                                             |
| `tenantOptions`    | none                                     | Tenant options in the microservice's own settings category.                                                                                 |
| `baseUrl`          | `'https://t12345.cumulocity.test'`       | Base URL in `self` and `next` links.                                                                                                        |
| `bootstrapUser`    | `'servicebootstrap_test'`                | Bootstrap user, allowed to read `/application/currentApplication`. With a `manifest`: `servicebootstrap_<name>`.                            |
| `settingsCategory` | `'service'`                              | The microservice's own tenant option category. Its `credentials.*` options read decrypted. With a `manifest`: the manifest's.               |
| `manifest`         | none                                     | The microservice's `cumulocity.json`. Makes it an application, see [The deployed microservice](services.md#the-deployed-microservice).      |
| `now`              | `Date.now`                               | Clock for timestamps, in epoch milliseconds.                                                                                                |
| `clock`            | none                                     | A trial clock from `createClock()`. It wins over `now`. See [Trials](trials.md#the-clock).                                                  |
| `ids`              | `'scattered'`                            | Id format, see [Ids](#ids).                                                                                                                 |
| `schedule`         | real `setTimeout(callback, 0)`           | Runs a callback later (Notification 2.0 delivery). See [Waiting for background work](#waiting-for-background-work).                         |
| `unsupported`      | `'developer'`                            | How to answer a request the world does not emulate. See [The coverage gate](coverage.md).                                                   |
| `overrideHint`     | `world.override('<METHOD> <path>', ...)` | What the developer 501 tells the reader to answer the request with, as a function of the request. For wrappers with their own override API. |
| `onUnsupported`    | none                                     | Called with every request the world does not emulate, and the world.                                                                        |
| `onChange`         | none                                     | Called with the world when the deployed tenant or the current user changed.                                                                 |
| `roles`            | `'enforce'`                              | Checks requests against the caller's rights, like the platform. `'off'` gives every caller full access. See [Roles](#roles).                |
| `unknownUsers`     | `'allow'`                                | `'unauthorized'` answers 401 for Basic auth of a user name the tenant does not know. See [Roles](#roles).                                   |
| `passwords`        | `'off'`                                  | `'check'` answers 401 for a known user's wrong password. See [Roles](#roles).                                                               |
| `freezeDocuments`  | `false`                                  | Deep-freezes every stored document, so code that changes one in place throws. For tests of fake-c8y itself; it makes writes slower.         |

`DEFAULTS` (exported) holds the default values, plus passwords for credentials a harness builds: `subscriptionPassword` (`'service-password'`, the default subscription's service user), `bootstrapPassword` (`'bootstrap-password'`), and `userPassword` (`'test-password'`). By default the fake checks no passwords; these only spare wrappers their own copies. With `passwords: 'check'`, `subscriptionPassword` is the default subscription's password, and the other two pass only for users without a password (see [Roles](roles.md#wrong-credentials)). The light entry `fake-c8y/defaults` exports `DEFAULTS` and nothing else, so a Vite or Vitest config (or any code that must not load the engine) can import it:

```ts
import { DEFAULTS } from 'fake-c8y/defaults'
```

### Types for wrappers

`C8yUser<Role>`, `C8yWorldState<Role, OptionKey>`, `C8yUserInput<Role>`, `C8yGroupInput<Role>`, and `C8ySeed<Role>` take the role name type and (for the state) the tenant option key type. The defaults are `string`, so nothing changes without them. A harness that knows a service's roles and option keys narrows them for autocomplete instead of copying the interfaces, and passes the narrowed values to `createWorld()`, `apply()`, `setUser()`, and `seed()` without casts:

```ts
import type { C8yWorldState } from 'fake-c8y'
import { createWorld } from 'fake-c8y'

type Role = 'ROLE_PUMP_READ' | 'ROLE_PUMP_ADMIN' | (string & {}) // known roles suggested, others allowed
type OptionKey = 'threshold' | 'unit'

const state: C8yWorldState<Role, OptionKey> = {
  user: { userName: 'eva', roles: ['ROLE_PUMP_READ'] },
  tenantOptions: { threshold: '3' }, // other keys stay allowed
}
const world = createWorld(state)
```

Leave out `(string & {})` to reject unknown roles. `OptionKey` only adds suggestions: `tenantOptions` accepts any key. Reading a narrowed `tenantOptions` gives `string | undefined` for a known key (it may be left out) and `string` for any other key (like any index signature; with `noUncheckedIndexedAccess`, `string | undefined` too).

`World` itself is not generic: `world.user` stays a `C8yUser`, `world.options.get(key: string)` takes any key, and `world.seed()` takes any `C8ySeed`. A wrapper narrows its own surface and passes the values on.

## Seeding

Things other data points to are created one at a time, and each call returns the id. Everything else goes through `seed()`, which returns the ids it created per list, in input order.

- `world.device(input)` and `world.managedObject(input)` create a managed object and return its id. The input takes fragments plus `children`, `assets`, `additions`, `externalIds`, and `tenant`. `device()` adds `c8y_IsDevice`.
- `world.binary({ name, content, contentType?, tenant? })` creates an inventory binary and returns its id.
- `world.seed({ ... })` adds `measurements`, `measurementGenerators`, `events`, `alarms`, `operations`, `newDeviceRequests`, `retentionRules`, `auditRecords`, `roles`, `groups`, `users`, `inventoryRoles`, `applications`, `serviceState` (of a registered service), `usageStatistics`, and `trustedCertificates`, validated like API writes. `defaultApplications: false` removes the default applications. `tenant` picks the tenant (default: the deployed one).

```ts
const pump = world.device({ name: 'Pump 7' })
const { alarms: [overheat] } = world.seed({
  alarms: [{ source: pump, type: 'overheat' }],
  events: [{ source: pump, type: 'door_open' }],
})
world.db.alarms.get(overheat!) // the seeded alarm
```

### What `seed()` returns

`seed()` returns a `C8ySeedResult`. It has an array for every list the seed has (also an empty one), with one entry per input item, in input order. Each entry is the id the API uses for that item:

| List                                                                                                                                | Entry                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `measurements`, `events`, `alarms`, `operations`, `auditRecords`, `retentionRules`, `groups`, `inventoryRoles`, `newDeviceRequests` | The platform id. A new device request's id is the one you give.                                                               |
| `applications`                                                                                                                      | The application's id. An input that replaces an application (same `id`, else same name and owner) gets the replaced one's id. |
| `users`                                                                                                                             | The `userName`.                                                                                                               |
| `roles`                                                                                                                             | The role name.                                                                                                                |
| `measurementGenerators`                                                                                                             | `{ firstId, lastId }`: the first and last id reserved for the generator's grid points, see below.                             |

`serviceState`, `usageStatistics`, and `trustedCertificates` have no entry: the first two create nothing with an id, and a certificate's key is the fingerprint you give. A seed that throws returns nothing; what it stored before the error stays.

A generator reserves a block of the world's id sequence, one id per grid point in grid order, from `firstId` to `lastId`. No other document gets an id inside the block. `firstId` is the document at `from`, unless a gap covers it. A live generator (no `to`) also reserves ids for points the clock has not reached, so its `lastId` belongs to a point in the future. The id of each document is in [Generated measurements](generated-measurements.md#model). Like the platform, `GET /measurement/measurements/{id}` answers 405; use `world.db.measurements.get(id)` or a list request.

Seeding writes like any other write: on a fork it goes to the fork, and on a frozen base it throws. Forks of the same base that get the same seed get the same ids.

The helpers store what you give them. Only API requests write audit records or derive fragments such as `c8y_Availability`, so a seeded world starts without audit history unless you seed `auditRecords`.

```ts
const pump = world.device({ name: 'Pump', c8y_RequiredAvailability: { responseInterval: 10 } })
world.seed({
  events: [{ source: pump, type: 'door_open', text: 'Door opened' }],
  alarms: [{ source: pump, type: 'overheat', severity: 'MAJOR' }],
  auditRecords: [{ type: 'User', activity: 'User created', text: 'User bob created', source: 'bob', time: '2026-01-01T00:00:00Z' }],
})
```

## Requests

`world.fetch(request)` answers a request to the platform. It never throws. A malformed request gets the platform's 4xx, and an exception inside the fake or an override becomes a 500. It rejects in two cases, like `fetch`: a request whose signal is already aborted rejects with the signal's reason and is not sent (a signal that fires later rejects at once, while the world still answers the request and records its call with `aborted: true`), and an override that answers with `Response.error()` makes it reject with a `TypeError` ([Network errors](#network-errors)). Every answer carries the standard reason phrase as `statusText` (`404 Not Found`).

Like the platform, a write (POST or PUT) answers with its object only if the request accepts JSON (`Accept: application/json` or a Cumulocity vendor type). Without an Accept header, or with `*/*`, the status is the same and the body is empty. Send `Accept: application/json` when you read the result of a write.

Basic auth selects the tenant and the user (`<tenant>/<user>:<password>`). A request without Basic auth works in the deployed tenant as the world's `user`. `basicAuth({ tenant, user, password? })` (input type `C8yCredentials`) returns the `authorization` header value in any runtime (UTF-8, no `btoa` or `Buffer`); the password defaults to `DEFAULTS.userPassword`, and a subscription (`world.subscriptions[0]`) passes as it is. The tenant ends at the first `/`, so a user name may contain one.

### Routing clients to the world

`world.fetch()` is a `fetch`, so a client that takes one needs nothing else. For code you do not control, two helpers route requests to a world. Both take the world or a function that returns it per request (for example the current fork of a trial), and return a function that undoes the change.

The real `@c8y/client` sends every request through `FetchClient.prototype.fetch`. `installFetchClient()` from the `fake-c8y/c8y-client` entry patches it, keeping the client's own URL, query, and auth handling. Uploads made with the Node `form-data` package (`inventoryBinary.create()`, event attachments) are sent as their multipart bytes. `@c8y/client` is not a dependency of fake-c8y: pass its `FetchClient` class.

```ts
import { FetchClient } from '@c8y/client'
import { installFetchClient } from 'fake-c8y/c8y-client'

const uninstall = installFetchClient(FetchClient, () => world)
```

`interceptFetch()` replaces `globalThis.fetch`: requests to the world's origin (the origin of `world.baseUrl`, or `origin`) go to the world, everything else to the `fetch` that was there before. Relative URLs pass through too. With `origin`, the world (or its getter) is read only for requests to that origin, so a lazy getter is not called for unrelated requests. It uses no Node APIs.

Both helpers stack: the newest install answers (for `interceptFetch()`, the newest one whose origin matches), and they can be undone in any order. Once all are undone, the original `fetch` is back, unless other code replaced it meanwhile, which is left alone.

```ts
import { interceptFetch } from 'fake-c8y'

const restore = interceptFetch(() => world, { origin: 'https://t100.cumulocity.test' })
```

## Roles

Roles are enforced by default. A request with Basic auth of a user the tenant stores (other than the world's `user`), or of a registered service's bootstrap or service user, gets the platform's 403 `security/Forbidden` where it lacks the rights, and lists show only what it may see. Three kinds of caller stay unrestricted: requests without Basic auth, the world's own `user`, and user names the tenant does not store (`unknownUsers: 'unauthorized'` answers those 401 instead). The service and bootstrap users of `subscriptions` and `bootstrapUser` are unrestricted too, unless the world has a `manifest` ([The deployed microservice](services.md#the-deployed-microservice)). `roles: 'off'` gives every caller full access.

Credentials are not checked by default. `unknownUsers: 'unauthorized'` answers 401 for a user name the tenant does not know, and `passwords: 'check'` answers 401 for a wrong password of a user that has one (seeded or world `user` with `password`, a user created or updated through the API with one, subscription and registered service users). Requests without Basic auth stay the world's `user`, and the check runs before overrides, so seed the users an override hands out. Details in [docs/roles.md](roles.md#wrong-credentials).

A user you switch to with `setUser()` or `apply({ user })` is stored in its tenant only while it is current: switching away removes it again, or puts back the seeded user of that name, unless the API changed it meanwhile. The user the world starts with stays stored.

Seeded users get the two roles every new user gets on the platform, `ROLE_USER_MANAGEMENT_OWN_READ` and `ROLE_USER_MANAGEMENT_OWN_ADMIN`, plus the `roles` you give.

A user input with its own `tenant` (like a `C8yUser`) is stored in that tenant instead of the seed's; `tenant` is not a user field. `undefined`, `null`, or the seed's tenant mean the seed's tenant; an empty string or a non-string throws. The seed's custom `roles` are added to that tenant's role catalogue too, so one seed can hold callers of several tenants, and `result.users` lists every name in input order (a name used in two tenants appears twice). Such a user cannot have `groups` or `inventoryAssignments`, since they are looked up in the seed's tenant: seed it with `{ tenant }` instead.

Before writing anything, `seed()` checks every user's tenant, the `groups` and `inventoryAssignments` of users of other tenants, duplicate user names (within the seed and against the stored users of each tenant, including the world's current user), and unknown roles (the seed's own `roles` count). A failing check throws a `TypeError` and leaves no data and no new tenant. Other errors still leave what was stored before them.

```ts
const world = createWorld({ tenant: 't12345' })
world.seed({ roles: ['ROLE_PUMP_ADMIN'], users: [{ userName: 'anna', roles: ['ROLE_PUMP_ADMIN'] }, { userName: 'eve', roles: ['ROLE_PUMP_ADMIN'], tenant: 't99999' }] })
world.db.tenant('t99999').users.get('eve') // stored in t99999
```

```ts
const world = createWorld()
const pump = world.device({ name: 'Pump' })
world.seed({ users: [{ userName: 'viewer', roles: ['ROLE_INVENTORY_READ'] }] })
const headers = { authorization: basicAuth({ tenant: world.tenant, user: 'viewer' }) }
await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects/${pump}`, { headers })) // 200
await world.fetch(new Request(`${world.baseUrl}/event/events`, { headers })) // 403 Access is denied
```

A fork can turn it off or on for itself: `base.fork({ roles: 'off' })`. [Roles](roles.md) has the rules per endpoint, ownership, and inventory roles.

## Overrides

`world.override(pattern, handler)` answers matching requests with your handler instead of the emulation. The newest override wins. It returns a function that removes it.

```ts
const remove = world.override('GET /inventory/managedObjects/:id', (request, ctx) => ({ id: ctx.params.id, name: 'Stub' }))
```

Patterns are `"[METHOD ]/path"`: `:name` captures a segment into `ctx.params`, `*` matches one segment, and `**` matches the rest of the path (captured as `ctx.params._`). Without a method, a pattern matches every method.

The handler gets a copy of the request whose body it can read, and a context:

| Field            | What It Is                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `params`         | What the pattern captured.                                                                                                                             |
| `call`           | The request as the world recorded it: a copy of its `world.calls` entry. See [The recorded call](#the-recorded-call).                                  |
| `tenant`, `user` | The caller's tenant and user name (`user` is `undefined` without Basic auth).                                                                          |
| `world`          | The world that got the request: the fork, also for an override registered on the base.                                                                 |
| `callCount`      | How many requests this override got, this one included: `2` is its second. A fork counts on its own, `reset()` starts over, and a log mark does not.   |
| `next()`         | Answers the request as if this override did not exist (the next older matching override, else a service or the emulation) and returns that `Response`. |

The handler returns a `Response`, another value (200 with it as JSON), or nothing (204). `Response.error()` simulates a network failure, see [Network errors](#network-errors). It can throw `UnsupportedRequestError` (exported) to report the request as not emulated (kind `'feature'`). Any other exception answers 500 and is recorded in `unhandled` with kind `'error'`: a broken override, not a simulated failure.

Use overrides for what can't be expressed as data: failures, latency, and endpoints the fake doesn't emulate. Seed normal data instead of rewriting answers, so a test does not depend on the endpoints the code under test calls.

```ts
// fail the second request, pass the others on
world.override('POST /alarm/alarms', (request, ctx) =>
  ctx.callCount === 2 ? Response.json({ error: 'general/internalError' }, { status: 500 }) : ctx.next())

// add latency
world.override('GET /inventory/**', async (request, ctx) => {
  await new Promise((resolve) => {
    setTimeout(resolve, 200)
  })
  return ctx.next()
})

// the platform stores the alarm, the client sees an error
world.override('POST /alarm/alarms', async (request, ctx) => {
  await ctx.next()
  return new Response(null, { status: 503 })
})
```

### The recorded call

`ctx.call` holds what the world parsed from the request, so a handler does not parse the request copy again:

| Field     | What It Is                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------- |
| `method`  | The method in upper case. A `POST` with `X-HTTP-METHOD: PUT` or `DELETE` has the named method.      |
| `path`    | The decoded path without the query, e.g. `/inventory/managedObjects/42`.                            |
| `query`   | The query parameters. A repeated parameter has its first value, like on the platform.               |
| `body`    | The parsed JSON body, else the text, else `undefined`. Multipart and binary bodies are `undefined`. |
| `headers` | The request headers, with lower-case names.                                                         |
| `id`      | The call's number in `world.calls`. The copy has no `status`: the request is not answered yet.      |

`ctx.call` is a copy, taken when the handler first reads it, so changing it leaves the call log as it was. For the bytes of a multipart or binary body, read the request copy: `new Uint8Array(await request.arrayBuffer())`.

```ts
world.override('POST /alarm/alarms', (request, ctx) => {
  const { type } = ctx.call.body as { type?: string }
  return type === 'overheat' ? new Response(null, { status: 503 }) : ctx.next()
})
```

### Network errors

A handler that returns `Response.error()` (the standard network-error response, `type: 'error'`) makes `world.fetch()` reject with a `TypeError` (`fetch failed`), like `fetch` does when the connection fails. Use it to test retries and fallbacks.

```ts
// the first request fails like a dropped connection, the others go through
world.override('GET /inventory/**', (request, ctx) => (ctx.callCount === 1 ? Response.error() : ctx.next()))
```

- The call is recorded with `networkError: true` and `status: 0`. It is not unhandled, so `coverage()` stays valid.
- Combined with `next()`, the platform answers and writes, and the client still sees a failure (`await ctx.next(); return Response.error()`). The call keeps its `writes`, and the usage statistics count what the platform answered and stored.
- When an older override answers with `Response.error()`, `ctx.next()` of a newer one returns that response (`type: 'error'`, `status: 0`) and throws nothing, so `return ctx.next()` passes it on. Its body is empty: check `response.type === 'error'` before reading it. Returning another answer instead recovers the request (no `networkError` on the call).
- A service's `ctx.fetch()` rejects with the `TypeError` too. If the service does not catch it (also when it throws an error with it as `cause`), its request answers 500 like a handler error (the message names the failed request with `unsupported: 'developer'`, the platform's generic 500 otherwise), and the trial stays valid. A service handler can also return `Response.error()` itself.
- If the request's signal fires first, the caller gets the abort reason, and the call has both `aborted: true` and `networkError: true`.

A handler that throws is still a 500 of kind `'error'`, which makes the trial invalid.

### Without a pattern

`world.override(handler)` gets every request. Answer what you want and pass the rest on with `next()`, for example with an HTTP framework. With h3, hand the context to the event and send the routes the app does not have on:

```ts
const app = new H3()
  .post('/alarm/alarms', async (event) => {
    await event.context.c8y.next()
    return new Response(null, { status: 503 })
  })
  .all('/**', (event) => event.context.c8y.next())

world.override((request, ctx) => app.request(request, undefined, { c8y: ctx }))
```

h3 answers errors it throws in its own JSON shape, not the platform's.

### What next() records

`next()` passes on the request the client sent; it takes no other request. What it writes stays written, whatever the handler returns afterwards: the call log has one call (the client's) with the status the handler returned, and its `writes`, the diff, `unhandled`, and `platformErrors` show what the world did. `next()` can be called once per request, and after a `reset()` or `restore()` it answers 503 and changes nothing.

## Reading and changing state

| Member                                | What It Does                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `db`                                  | Read access for assertions, as the API renders the data: `db.alarms.find({ source: pump })`, `db.users.get('anna')`, `db.tenant('t2')`. |
| `db.operations.update(id, update)`    | Updates an operation like a device agent, e.g. `{ status: 'SUCCESSFUL' }`.                                                              |
| `db.newDeviceRequests.connect(id)`    | Moves a new device request to `PENDING_ACCEPTANCE`, like the device's first credentials poll.                                           |
| `options.get/set/delete(key, scope?)` | Tenant options. `scope` is `{ category?, tenant? }`; the default is the own settings category of the deployed tenant.                   |
| `apply(state)`, `setUser(user)`       | Change the tenant, user, subscriptions, or tenant options. With a `manifest`, a change of subscriptions subscribes and unsubscribes.    |
| `calls`, `unhandled`, `inflight`      | Requests answered and requests not emulated since the last reset, and the number of requests being answered now.                        |
| `callsTo(pattern)`                    | The calls since the last reset that match an `override()` pattern, in order: `world.callsTo('POST /alarm/alarms')`.                     |
| `mark()`, `callsSince(mark)`, …       | Windows of the call log without a reset, see [Log windows](#log-windows).                                                               |
| `idle(options?)`                      | Waits until no request is in flight and nothing is scheduled. See [Waiting for background work](#waiting-for-background-work).          |
| `muted(fn)`                           | Runs `fn` without publishing Notification 2.0 messages. An async `fn` mutes the whole world until its promise settles.                  |
| `tenant`, `user`, `subscriptions`     | The current deployed tenant, current user, and subscriptions.                                                                           |

`matchesCall(pattern, call)` (exported) tells whether one recorded call matches a pattern (a string or a `compileRoute()` result), e.g. to filter `calls` of several worlds, `unhandled`, or `coverage().platformErrors`. Both match a recorded call exactly as `override()` matched its request, also with an encoded `/` or `?` inside a segment. For an object the world did not record, `matchesCall()` splits its `path` at `/`.

`db` collections have `get(id)` and `find(filter?)`; a filter is a partial object or a predicate. `db.measurements.find()` builds every matching generated document, so filter it by `source`.

## Log windows

`world.calls` and `world.unhandled` hold everything since the last reset. For the requests of one test or one agent turn, mark a point of the log and read the window since it:

```ts
const turn = world.mark()
await runTurn(world)
const calls = world.callsSince(turn) // C8yRequest[]
const unhandled = world.unhandledSince(turn) // C8yUnhandledRequest[]
turn.release()
```

| Member                                       | What It Does                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mark()`                                     | Marks the current point of the log. O(1). `mark.release()` ends it.                                                                                                            |
| `callsSince(from, until?, options?)`         | The requests that started after `from` and not after `until` (another mark), in the order they were recorded. `options.except` lists ranges (`{ from, until? }`) to leave out. |
| `unhandledSince(from, until?, options?)`     | The unhandled entries of the requests of that window, without those taken by `takeUnhandledSince()`.                                                                           |
| `takeUnhandledSince(from, until?, options?)` | Like `unhandledSince()`, and takes the entries: later windows of any mark leave them out. Taking the same window again returns only what came late. Calls are never taken.     |

The rules:

- A request belongs to the window in which `fetch()` was called. A request a service sends with `ctx.fetch()` belongs to the window of the request the service was answering, so a window never shows a child without its parent. A request still in flight when the next mark is taken is recorded later (its call after its body is read, its unhandled entry when it finishes), but it stays in the window it started in, so `unhandledSince(test, nextTest)` still finds it after the next test began.
- `from === until` and an `until` before `from` give an empty window.
- Reading a window changes nothing; taking unhandled entries changes neither `calls`, `unhandled`, nor `coverage()`. Assigning `world.calls = []` or `world.unhandled = []` changes no window.
- Request ids (`C8yRequest.id`), override call counts (`ctx.callCount`), and usage statistics count on across marks: they are per reset, not per window. To count an override's requests in a window, filter `callsSince(mark)` with `matchesCall(pattern, call)`, or register the override for the window and remove it afterwards.
- A mark belongs to its world and its log: a fork has its own log, and a mark of another world (also of the fork's base) throws a `TypeError`. `restore()` keeps the log and its marks. `reset()` (also `reset({ to })`) starts a new log, and marks from before it throw a `TypeError` (as `from`, `until`, or in `except`): take new marks after a reset. Requests still in flight across a reset answer 503 and never show in a window.
- A released mark throws when used; releasing twice, or a mark ended by a reset, does nothing.

**Retention.** The world keeps the calls and unhandled entries of the requests that started after its oldest live mark, and nothing while no mark is live. Releasing a mark drops what only it needed, and taken unhandled entries are dropped at once. Release the marks you no longer need: a world that is never reset and keeps an old mark keeps every request since. A window costs O(entries kept since its `from` mark).

Assigning new arrays to `calls` and `unhandled` still works, but it is only a partial reset: ids, override call counts, and usage statistics keep counting, a request in flight lands in the new array, and entries kept for live marks stay. Prefer marks.

## Ids

- `ids: 'scattered'` (the default) gives ids in the platform's format. Managed objects get 8 digits with a scattered two-digit prefix in front of one shared counter (`47100001`). Events, alarms, operations, audit records, and retention rules get the bare counter (`100002`), and measurements 24 hex digits. Inventory lists keep creation order, so ascending managed object ids are not creation order, like on the platform.
- `ids: 'sequential'` gives `'1'`, `'2'`, and so on for every collection, which reads better in some tests.
- Both are deterministic: forks of the same base hand out the same ids.
- Groups, inventory roles, their permissions, inventory assignments, and bulk operations count on their own per tenant, like on the platform.

## Notification 2.0

Subscriptions and tokens work through the REST API. Consumers connect with a fake WebSocket from the `fake-c8y/realtime` entry. Pass it where your client expects a `ws`-style WebSocket. By default the `message` event carries the frame's text. `flavor: 'ws'` makes the events look like the `ws` package's: `message` gets a `Buffer` and `isBinary` (`false`), `close` the reason as a `Buffer` (a `Uint8Array` of the UTF-8 bytes where the runtime has no `Buffer`). `encodeMessage` turns a frame into the `message` data yourself and wins over the flavor.

```ts
import { createFakeWebSocket } from 'fake-c8y/realtime'

const WebSocket = createFakeWebSocket(world.realtime, { flavor: 'ws' })
```

Sockets belong to one world, so use `createFakeWebSocket(fork.realtime)` for a fork. Subscriptions and tokens are tenant data: a fork inherits the base's, `reset()` drops the ones created since (`reset({ to, consumers: 'keep' })` keeps open consumers, see [Checkpoints](trials.md#checkpoints)), `restore()` brings back the snapshot's, and `diff()` lists subscriptions under `notificationSubscriptions`.

A persistent subscription keeps frames for later only once a consumer of it has connected, like on the platform. Frames published before the first connect are dropped. `reset()` and `restore()` forget that a consumer connected, and a fork starts without it. Sockets that stay open across a reset or restore still count as connected.

A token expires `expiresInMinutes` after it was created (default 1440, one day), by the world's clock. A socket that is already open stays open and keeps receiving. A reconnect needs a new token: a connect with an expired token fails like one with an unknown token (`error`, then close `1008`). The platform's exact answer there is not verified. To move time in a test, create the world with a `clock` and call `world.advance()`, or pass a `now` function you control.

```ts
import { createClock, createWorld } from 'fake-c8y'

const world = createWorld({ clock: createClock({ start: '2026-01-01T00:00:00Z', realtime: false }) })
await world.fetch(new Request(`${world.baseUrl}/notification2/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: 'tenant', subscription: 'alarms' }) }))
const response = await world.fetch(new Request(`${world.baseUrl}/notification2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: 'alarms', subscriber: 'alarmService', expiresInMinutes: 5 }) }))
const { token } = await response.json()
world.advance(6 * 60_000) // a new socket with this token now gets error and close 1008
```

### Close codes

Only `reset()` and `restore()` use a distinct close code: when one of them removes a consumer's token or its subscription, the consumer's socket closes with code `4410` and reason `notification token removed`. The code is exported as `CONSUMER_REMOVED` (from `fake-c8y` and `fake-c8y/realtime`). This also applies to a socket that is still connecting, which then gets no `open` and no `error`. The consumer no longer exists, so a client should stop instead of reconnecting. The platform documents no close code for this case: `4410` is fake-c8y's own, in the application range (4000-4999), modeled on HTTP 410 Gone.

- A socket still connecting when a reset or restore removes its token or subscription closes right away with `4410`, once. It never opens.
- A connect with an unknown or expired token emits `error` and closes with `1008` (`invalid token`).
- A socket the client closes itself (`close()` or `terminate()`) closes with `1000`, also while it is still connecting (then without `open` or `error`). Every socket on `world.realtime.clear()` closes with `1000` too.
- A client close (`close()` or `terminate()`) keeps the frames the socket had not acknowledged, like `closeConsumers()` (see [below](#closing-consumers-from-the-server-side)). This holds only for a persistent subscription, and only when no other consumer of the subscription is still open. Then the next consumer of the subscription gets them first, with the same ack ids. Otherwise they are lost.
- `POST /notification2/unsubscribe` closes the consumer's socket with `1000` and keeps none of its unacknowledged frames. It also drops the subscription's backlog, and nothing is kept until a consumer of the subscription connects again.
- Removing a subscription through the API (`DELETE /notification2/subscriptions/{id}`, `DELETE /notification2/subscriptions?source=…`, or deleting the managed object a subscription is for) closes no socket: the consumer stays open and receives nothing more. The backlog stays. What the platform does there is not verified.

### Closing consumers from the server side

`world.realtime.closeConsumers(options?)` closes open consumer sockets from the server side, as if the connection dropped or the platform closed it, to test a client's reconnect path. It returns how many sockets it closed.

```ts
world.realtime.closeConsumers() // every open socket, code 1006 (abnormal closure)
world.realtime.closeConsumers({ subscription: 'alarms', code: 1011, reason: 'internal error' })
```

- `tenant`, `subscription`, `subscriber`, and `token` select the sockets (all open ones by default). Sockets still connecting are not closed.
- `code` (default `1006`, what a client sees when the connection drops) must be an integer from 1000 to 4999, and `reason` defaults to `''`. `1006` is allowed on purpose: a peer never sends it in a close frame, but a client sees it when the connection drops.
- Subscriptions and tokens stay stored, so the client can reconnect with the same token or mint a new one.
- Frames are kept for the reconnect only when the subscription is persistent and no other consumer of it stays open (the backlog is per subscription, and filled only while no consumer of it is connected). Then the frames the closed socket had not acknowledged (delivered or still scheduled) go back into the backlog, frames published meanwhile wait there too, and the next consumer of the subscription that connects gets them. If another consumer of the subscription stays open, the frames published meanwhile go to it, and the closed consumer's unacknowledged frames are lost. The platform's redelivery is not verified.
- The `close` event is emitted synchronously, like the closes of a reset.

### Waiting for background work

A service under test reacts to notifications in the background, so a test or a grader has to wait before it judges the world. Two waits do that. They run on the real `setTimeout` and `Date.now`, captured when fake-c8y is loaded, so `vi.useFakeTimers()` or sinon installed later does not stop them. Each wait counts only its own world: a fork waits for its own requests and sockets.

| Wait                                             | Resolves When                                                                                                                                                                                                 | On Timeout                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `world.realtime.settled({ timeout?, quietMs? })` | The live work is done, including notifications caused by the consumers' own writes: no request in flight, no callback scheduled, no socket connecting, and no delivered frame waiting for its acknowledgment. | Rejects with `SettleTimeoutError` |
| `world.idle({ timeout?, quietMs? })`             | No request is in flight and no callback is scheduled (deliveries, socket connects and events). Notifications that are delivered and not acknowledged yet do not count.                                        | Rejects with `SettleTimeoutError` |

Each resolves only after its condition held without interruption for `quietMs` (default 20 ms), checked every few milliseconds, so a client that is between two requests is waited for. A consumer that acknowledges a frame and writes only after a longer await of its own is not visible meanwhile: raise `quietMs` above that await. `timeout` is in milliseconds (default 5000).

```ts
world.seed({ measurements: [{ source: pump, type: 'c8y_Temperature', c8y_Temperature: { T: { value: 95, unit: 'C' } } }] })
const { status } = await world.realtime.settled()
expect(world.db.alarms.find({ source: pump })).toHaveLength(1)
```

`settled()` does not wait for frames stored for a subscription that has no open consumer (`status().backlog`, see [below](#what-is-still-on-its-way)). They are kept for a subscription a consumer has connected to before, until a consumer connects again, which may never happen (a stopped service leaves its token behind). When a consumer connects, it gets those frames at once, and `settled()` waits for them from then on.

`settled()` resolves with `{ waitedMs, status }`, the `realtime.status()` it settled with (`backlog` can be above 0). A timeout rejects with `SettleTimeoutError` (exported from `fake-c8y` and `fake-c8y/realtime`). Its message lists the counts that were still above 0 at the last check, for example `fake-c8y: realtime.settled() timed out after 5000 ms (unacknowledged 1)`, and its `status` has the same counts:

- `settled()`: `inflight`, `scheduled`, `connecting`, and `unacknowledged`.
- `idle()`: `inflight` and `scheduled`.

A consumer that never acknowledges a frame keeps `settled()` waiting until the timeout, with `unacknowledged` above 0. That happens, for example, with a client version that skips the acknowledgment when its handler throws.

Load fake-c8y before fake timers are installed (for example, import it at the top of a setup file that calls `vi.useFakeTimers()`). If the timers were already fake when fake-c8y was loaded, it uses the global timers at the time of the wait when those are real again, and otherwise the wait throws a `TypeError` that says so instead of hanging. fake-c8y recognizes fake timers by the `clock` property that `@sinonjs/fake-timers` (used by Vitest and Jest) puts on `setTimeout` and `Date`.

#### Open consumers

`world.realtime.consumers(filter?)` lists the open consumer sockets, one entry per socket, as new objects `{ tenant, subscription, subscriber, token }` (`token` is the token the socket connected with). Sockets still connecting are not listed, and a closed socket drops out. The filter takes `tenant`, `subscription`, `subscriber`, and `token`, and matches like [`closeConsumers()`](#closing-consumers-from-the-server-side).

```ts
world.realtime.consumers() // [{ tenant: 't12345', subscription: 'alarms', subscriber: 'alarmService', token: 'eyJ…' }]
expect(world.realtime.consumers({ subscription: 'alarms' })).toHaveLength(1)
```

#### When `settled()` is enough

`settled()` sees everything that runs through the fake: requests, scheduled deliveries, connecting sockets, and frames waiting for their acknowledgment. c8y-realtime acknowledges a frame after its handler's promise resolves, so work the handler awaits is covered, also a new listener it opens in reaction to an event. Then `settled()` alone is enough:

```ts
it('raises an alarm for a hot pump', async () => {
  // a write that triggers the service through its open listener
  await client.measurement.create(hotMeasurement)
  await world.realtime.settled()
  expect(world.db.alarms.find({ source: pump })).toHaveLength(1)
})

it('ignores a normal reading', async () => {
  // a negative check: nothing happened once the live work is done
  await client.measurement.create(normalMeasurement)
  await world.realtime.settled()
  expect(world.db.alarms.find({ source: pump })).toHaveLength(0)
})
```

The same holds for chains (the service writes, its own write notifies it again, it writes again), and for startup when the service connects its listeners while it starts:

```ts
beforeAll(async () => {
  await startApp(world) // creates subscriptions and tokens, connects consumers
  await world.realtime.settled()
})
```

#### When to poll first

Some work starts later than the fake can see. Poll until the listener you need is open (`expect.poll()` or `vi.waitFor()`), then call `settled()`:

- After the fake dropped listeners: `closeConsumers()`, or a reset that closed them with `4410`. c8y-realtime reconnects on its own timer, about 1 s after a drop and longer after failed attempts.
- A listener the service opens later on its own timer, a cron job, or a lazy route.
- Work a handler starts on its own timer (`setTimeout`) after it resolved: the frame is acknowledged already. Poll for the result, or raise `quietMs` above the delay.
- An external process (for example a microservice in another process) whose start the fake cannot see.
- A service that yields on its own (a timer, or waiting in real time) between creating the subscription, minting the token, and connecting, or a test that writes before the service started: `settled()` does not wait for that listener. Poll `consumers()` first. Steps that follow each other directly are covered: a request is in flight or the socket is connecting.

```ts
world.realtime.closeConsumers({ subscription: 'alarms' })
await expect.poll(() => world.realtime.consumers({ subscription: 'alarms' }).length, { timeout: 5000 }).toBe(1)
await world.realtime.settled()
```

```ts
await vi.waitFor(() => expect(world.realtime.consumers({ subscriber: 'reportService' })).toHaveLength(1), { timeout: 5000 })
await client.event.create(reportRequest)
await world.realtime.settled()
```

#### Changed: delivery runs on real timers

The default `schedule` is now the real `setTimeout(callback, 0)` captured when fake-c8y is loaded. Before, it read the global `setTimeout` at call time, so fake timers held notification delivery back until the test advanced them. To get that back, pass a `schedule` that reads the global at call time:

```ts
const world = createWorld({ schedule: (callback) => setTimeout(callback, 0) }) // fake timers drive delivery again
```

A custom `schedule` counts in `status().scheduled` until it runs the callback. One that never runs it (`schedule: () => {}`, to mute delivery) keeps `idle()` from resolving until the next `reset()`, `restore()`, or `realtime.clear()`, which drop the scheduled work and its count. `settled()` and `pending()` also count a socket that is still connecting (`status().connecting`). A reset or restore drops it only when it closes the socket (its token or subscription is gone): otherwise they stay busy until the socket connects, its client closes it, or `realtime.clear()` runs.

#### Changed: `settled()` waits only for live work

`settled()` and `pending()` no longer count stored frames (`backlog`), and `settled()` lost its `unclaimed` option: a token whose consumer is gone for good (a stopped service) made them hang. `waitForRealtimeStartup()` and its types (`RealtimeStartupOptions`, `RealtimeStartupResult`) are removed. To migrate:

- `waitForRealtimeStartup(world.realtime, () => world.inflight)` becomes `await world.realtime.settled()`. To wait for a specific listener, poll `world.realtime.consumers()` first (see [When to poll first](#when-to-poll-first)).
- Drop `unclaimed: 'wait'` or `unclaimed: 'ignore'` from `settled()`: it now waits for neither unclaimed frames nor the backlog.
- A test that relied on `settled()` waiting for a consumer to connect polls `consumers()` first.

#### Changed: nothing is kept before a consumer connects

A persistent subscription used to keep every frame from the moment it existed, and the first consumer to connect got them all. Now frames are kept only once a consumer of the subscription has connected, because the platform keeps nothing before a first connect. `status().unclaimed` is always 0 and deprecated. A test that writes data for a consumer must connect the consumer first, then write.

### What is still on its way

`world.realtime.status()` splits up what Notification 2.0 still has on its way:

| Field            | Counts                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inflight`       | Requests the world is answering (their writes may still publish).                                                                                     |
| `scheduled`      | Callbacks given to `schedule` since the last reset that have not run: frame deliveries, socket connects, and socket events (`open`, `close`, `pong`). |
| `connecting`     | Sockets whose connect has not run yet.                                                                                                                |
| `unacknowledged` | Frames delivered to a socket and not acknowledged.                                                                                                    |
| `backlog`        | Frames held for a persistent subscription without an open consumer, kept only once a consumer of it has connected.                                    |
| `unclaimed`      | Always 0 (deprecated): nothing is kept before a consumer connects.                                                                                    |

`world.realtime.pending()` is the live work `settled()` waits for: `inflight` + `scheduled` + `connecting` + `unacknowledged`. `backlog` is informational: neither `settled()` nor `pending()` waits for or counts it. Read `pending()` as zero or not zero, not as a number of tasks: it is a sum of the four counts, and a connecting socket counts twice (its connect callback in `scheduled`, the socket in `connecting`).
