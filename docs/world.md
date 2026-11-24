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

Changed: `GET /user/currentUser` answered the short shape (with `effectiveRoles`) for every Accept header. With the `user` type (`application/vnd.com.nsn.cumulocity.user+json`) it now answers the full user, like the platform, so `client.user.current()` gets `customProperties`, `groups`, `roles`, `devicePermissions`, `applications`, and `enabled`, and no longer `effectiveRoles` or `requiredAuthType`. Read roles with `client.user.currentWithEffectiveRoles()`. `PUT /user/currentUser` is now emulated, see [Emulated API](emulated-api.md#users-groups-and-roles).

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

### Given ids

A seed input may bring its own `id`, and the world stores it under that id: `managedObject()`, `device()`, `binary()`, managed objects in a service's seed, and in `seed()` measurements, events, alarms, operations, retention rules, and audit records. Use it to load data whose references (dashboards, `childDevices`, links) name ids.

```ts
const world = createWorld({ ids: 'sequential' })
world.managedObject({ id: '50', name: 'Pump' })
world.seed({ events: [{ id: '4713', source: '50', type: 'door_open' }] })
world.managedObject({ name: 'Valve' }) // '4714': the counter jumped past both
```

- An id is a string of digits without a leading zero (`'4711'`, `'49132520'`). A measurement id may also be 24 lower-case hex characters. Anything else (a number, `'007'`) throws a `TypeError`.
- An id the tenant already has for that kind throws: binaries count as managed objects, and generated measurements, with every id of their block, count as measurements. An event `'7'` and an alarm `'7'` may both exist.
- `seed()` checks every given id of all its lists before it writes anything.
- An alarm with a given id that would merge into an open alarm of the same source and type (stored, or earlier in the same list) throws instead of merging. Alarms without an id merge as before.
- The world's id counter jumps past every number that could make the given id, for any kind, so the world never hands it out later: also in forks, after `reset()`, `reset({ to })`, and `restore()`. With scattered ids every id of six or more digits is a counter number (`'47100001'` makes the next ids start after 47000001). A number above 2^31 does not move the counter.
- API requests still reject an `id` in the body (422).

Changed: `managedObject()`, `device()`, and `binary()` used to drop a given `id`, and `seed()` threw an `is not allowed here` error for one (audit records kept it, without these checks). Code that passed an `id` and relied on a new one now gets the given one, or a `TypeError` if it is not a valid id.

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
- An id a seed gives moves the counter past it (see [Given ids](#given-ids)).
- Groups, inventory roles, their permissions, inventory assignments, and bulk operations count on their own per tenant, like on the platform.

## Notification 2.0

Subscriptions and tokens work through the REST API. Consumers connect with a fake WebSocket from the `fake-c8y/realtime` entry. Pass it where your client expects a `ws`-style WebSocket. By default the `message` event carries the frame's text. `flavor: 'ws'` makes the events look like the `ws` package's: `message` gets a `Buffer` and `isBinary` (`false`), `close` the reason as a `Buffer` (a `Uint8Array` of the UTF-8 bytes where the runtime has no `Buffer`). `encodeMessage` turns a frame into the `message` data yourself and wins over the flavor.

```ts
import { createFakeWebSocket } from 'fake-c8y/realtime'

const WebSocket = createFakeWebSocket(world.realtime, { flavor: 'ws' })
```

Sockets belong to one world, so use `createFakeWebSocket(fork.realtime)` for a fork. Subscriptions are tenant data: a fork inherits the base's, `reset()` drops the ones created since (`reset({ to, consumers: 'keep' })` closes no socket, see [Checkpoints](trials.md#checkpoints)), `restore()` brings back the snapshot's, and `diff()` lists them under `notificationSubscriptions`.

A token is stateless and JWT-shaped: `<header>.<claims>.<checksum>` in base64url. The claims hold the tenant, subscription, subscriber, expiry (`exp`, in seconds), and `shared` (only when minted with `shared: true`); an open socket shows them as `socket.token` (`NotificationToken`, with `expires` in epoch milliseconds). The checksum only catches a changed or broken token. It is not a security measure: a token works in any world, also in a fork and after a reset or restore, until it expires. Nothing is random, so the same request at the same time gives the same token. Minting does not check that the subscription exists: such a socket opens and gets frames once a subscription of that name exists.

Every subscriber of a subscription (tenant, subscription, and subscriber of its token) gets each frame once and has its own backlog (see [One backlog per subscriber](#one-backlog-per-subscriber)). A persistent subscription keeps frames for a subscriber only once that subscriber has connected, like on the platform. Frames published before its first connect are dropped for it. `reset()` and `restore()` forget which subscribers connected, and a fork starts without any. The subscriber of a socket that stays open across a reset or restore still counts as connected.

### One backlog per subscriber

- Each subscriber gets every frame of its subscription once: on its open socket, or, for a persistent subscription, in its own backlog while it has no open socket. The next socket of that subscriber that opens gets the backlog first, with the same ack ids. Two subscribers of one subscription each get every frame.
- A subscriber has one open socket. A second connect of the same tenant, subscription, and subscriber is refused with 409 (see [Refused connects](#refused-connects)), unless the new token and the tokens of all its open sockets were minted with `shared: true`. Sockets still connecting do not count, and a closed socket frees the slot at once, so a reconnect after a close works. This is inferred: no verified row yet.
- The open sockets of a shared subscriber split the frames by source: all frames of one source go to one socket, and each frame reaches only one of them. Which socket gets a source is not specified. Acknowledgements count per socket. When a shared socket closes, its unacknowledged frames go to another open socket of the subscriber (persistent subscriptions only). This split is inferred, not verified.
- `world.realtime.backlog` holds one entry per subscriber; its keys are opaque. `status().backlog` sums the frames of all subscribers.
- Delivery to a socket pauses while it has 1000 frames not acknowledged (delivered or on their way). Later frames for that socket wait, in order, and go out as acks arrive, one per ack. A shared socket at the limit keeps the frames of its sources: they wait for it and do not move to another socket. When the socket closes, the waiting frames go back into the subscriber's backlog with its unacknowledged ones, in ack order (persistent subscriptions only). A reset, a restore, or an unsubscribe drops them. Waiting frames show in neither `status().unacknowledged` nor `status().backlog`. The limit is fixed. It is inferred from the platform's documented limit of unacknowledged messages per consumer, not verified.

A token expires `expiresInMinutes` after it was created (default 1440, one day; 0 also means the default), by the world's clock. A negative `expiresInMinutes` or a subscriber or subscription name that is not alphanumeric answers 422. A socket that is already open stays open and keeps receiving. A reconnect needs a new token: a connect with an expired token is refused with 401, like one with a token that does not parse or fails its checksum (see [Refused connects](#refused-connects)). To move time in a test, create the world with a `clock` and call `world.advance()`, or pass a `now` function you control.

```ts
import { createClock, createWorld } from 'fake-c8y'

const world = createWorld({ clock: createClock({ start: '2026-01-01T00:00:00Z', realtime: false }) })
await world.fetch(new Request(`${world.baseUrl}/notification2/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: 'tenant', subscription: 'alarms' }) }))
const response = await world.fetch(new Request(`${world.baseUrl}/notification2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: 'alarms', subscriber: 'alarmService', expiresInMinutes: 5 }) }))
const { token } = await response.json()
world.advance(6 * 60_000) // a new socket with this token is now refused with 401
```

### Close codes

`reset()` and `restore()` close a socket (open or still connecting) whose subscription (tenant and name) the new state does not have, as a dropped connection: code `1006`, empty reason. A socket whose subscription stays is kept. `reset({ consumers: 'keep' })` closes nothing. The token stays valid, so a client may reconnect with it. The platform's behavior here is inferred, not verified. A refused socket held by an `unexpected-response` listener (see [Refused connects](#refused-connects)) is not tracked: reset, restore, and `world.realtime.clear()` leave it to the caller, and it stays `CONNECTING` until `close()` or `terminate()`.

- A socket still connecting when a reset or restore removes its subscription closes right away with `1006`, once. It never opens and gets no `error`.
- A refused connect (see [Refused connects](#refused-connects)) never opens: `error`, then close `1006` with an empty reason, unless a `ws`-flavor socket has an `unexpected-response` listener.
- An open socket with no frame either way for 5 minutes of real elapsed time closes with `1001` and an empty reason. Activity is the open, a frame delivered to the socket, an ack from it, or a `ping()` from it; each one starts the 5 minutes again, and so does a reset or restore for the sockets that stay. The time is the real time captured when fake-c8y loaded, not the world clock: `world.advance()` and fake timers do not age a socket. The check runs on a request, on a `db` access, and on `world.tick()`, never on socket activity, so the sockets of a world nobody calls never close, and neither do the sockets of a frozen base (a fork's do). The close runs through the `schedule` option, never inside the request, so `realtime.settled()` waits for it. A socket waiting at the limit of 1000 unacknowledged frames whose client stays silent closes too. Its unacknowledged and waiting frames go back into the backlog as with any close. This is inferred, not verified.
- A socket the client closes itself (`close()` or `terminate()`) closes with `1000`, also while it is still connecting (then without `open` or `error`). A close before the connect ran keeps `1000` here, where `ws` emits `error` and close `1006`. The exception is a refused socket held by an `unexpected-response` listener: its close emits `error` and close `1006`. Every socket on `world.realtime.clear()` closes with `1000` too, except such a held refused socket, which it leaves alone.
- A client close (`close()` or `terminate()`) keeps the frames the socket had not acknowledged, like `closeConsumers()` (see [below](#closing-consumers-from-the-server-side)). This holds only for a persistent subscription. They go back into the subscriber's backlog: another open socket of the same subscriber (a shared token) gets them at once, else the subscriber's next socket gets them first, with the same ack ids. For a non-persistent subscription they are lost.
- `POST /notification2/unsubscribe` finds the consumer by the token's claims (tenant, subscription, subscriber), not by the token text, answers `{ result: 'DONE' }`, and drops that subscriber's backlog, also the unacknowledged frames of its open sockets: a later close of such a socket brings none of them back. Frames already on their way still arrive while the socket stays open; a frame still on its way when the socket closes is lost, not kept. `settled()` still waits for frames delivered before the unsubscribe until they are acknowledged, and they count toward the limit of 1000 unacknowledged frames until then. It closes no socket, and the token stays valid. Inferred: the open socket keeps receiving (the platform re-creates the subscriber), so frames published afterwards arrive there and are kept for the subscriber again once the socket closes, and a repeat unsubscribe answers 200 while the socket is open. It answers 422 without a token, and 500 for a token that does not parse, fails its checksum, has expired, belongs to another tenant, or has no open socket of its subscriber. That an expired token answers 500 is inferred: the platform checks the token (signature and expiry) before it unsubscribes. Other subscribers of the subscription keep their backlog.
- Removing a subscription through the API (`DELETE /notification2/subscriptions/{id}`, `DELETE /notification2/subscriptions?source=…`, or deleting the managed object a subscription is for) closes no socket: the consumer stays open and receives nothing more. The backlog stays. What the platform does there is not verified.

### Refused connects

A connect with a bad token is refused before any socket opens, with an HTTP status instead of the WebSocket upgrade:

- 401: the token does not parse, fails its checksum, or has expired. This is inferred: no verified row yet.
- 400: no `token` parameter, an empty one (`?token=`), or more than one. The empty and the repeated case are inferred.
- 409: the subscriber (tenant, subscription, and subscriber of the token) already has an open socket, and the new token or that socket's token is not shared. This is inferred: no verified row yet. See [One backlog per subscriber](#one-backlog-per-subscriber).

The socket's events follow the `ws` package. Without an `unexpected-response` listener, it never emits `open`: it emits `error` (`Unexpected server response: 401`), then `close` with `1006` and an empty reason, and `readyState` is `CLOSED`. The `text` flavor always behaves like this, as a browser WebSocket has no `unexpected-response` event.

In the `ws` flavor, an `unexpected-response` listener added with `on()` gets the refusal instead (`addEventListener()` ignores this event, like `ws`), as `(request, response)` with `response.statusCode` and `response.statusMessage` (no headers), and nothing else happens: the socket stays `CONNECTING` (it does not count in `status().connecting`) until the caller closes it. `terminate()` or `close()` then emits `error` (`WebSocket was closed before the connection was established`) and `close` `1006` with an empty reason, like `ws`:

```ts
const WebSocket = createFakeWebSocket(world.realtime, { flavor: 'ws' })
const socket = new WebSocket(`${world.baseUrl.replace(/^http/, 'ws')}/notification2/consumer/?token=garbage`)
socket.on('unexpected-response', (_request, response) => {
  console.log(response.statusCode, response.statusMessage) // 401 Unauthorized
  socket.terminate() // then error and close 1006
})
```

### Closing consumers from the server side

`world.realtime.closeConsumers(options?)` closes open consumer sockets from the server side, as if the connection dropped or the platform closed it, to test a client's reconnect path. It returns how many sockets it closed.

```ts
world.realtime.closeConsumers() // every open socket, code 1006 (abnormal closure)
world.realtime.closeConsumers({ subscription: 'alarms', code: 1011, reason: 'internal error' })
```

- `tenant`, `subscription`, `subscriber`, and `token` select the sockets (all open ones by default). Sockets still connecting are not closed.
- `code` (default `1006`, what a client sees when the connection drops) must be an integer from 1000 to 4999, and `reason` defaults to `''`. `1006` is allowed on purpose: a peer never sends it in a close frame, but a client sees it when the connection drops.
- Subscriptions stay stored and the token stays valid, so the client can reconnect with the same token or mint a new one.
- Frames are kept for the reconnect only when the subscription is persistent. Then the frames the closed socket had not acknowledged (delivered or still scheduled) go back into its subscriber's backlog. Another open socket of the same subscriber (a shared token) gets them at once; otherwise they wait with the frames published meanwhile, and the subscriber's next socket gets them. Other subscribers of the subscription are not affected. The platform's redelivery is not verified.
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

`settled()` does not wait for frames stored for a subscriber that has no open socket (`status().backlog`, see [below](#what-is-still-on-its-way)). They are kept for a subscriber that has connected before, until it connects again, which may never happen (a stopped service leaves its token behind). When it connects, it gets those frames at once, and `settled()` waits for them from then on.

`settled()` resolves with `{ waitedMs, status }`, the `realtime.status()` it settled with (`backlog` can be above 0). A timeout rejects with `SettleTimeoutError` (exported from `fake-c8y` and `fake-c8y/realtime`). Its message lists the counts that were still above 0 at the last check, for example `fake-c8y: realtime.settled() timed out after 5000 ms (unacknowledged 1)`, and its `status` has the same counts:

- `settled()`: `inflight`, `scheduled`, `connecting`, and `unacknowledged`.
- `idle()`: `inflight` and `scheduled`.

A consumer that never acknowledges a frame keeps `settled()` waiting until the timeout, with `unacknowledged` above 0. That happens, for example, with a client version that skips the acknowledgment when its handler throws. A socket at the limit of 1000 unacknowledged frames (see [One backlog per subscriber](#one-backlog-per-subscriber)) also keeps `settled()` waiting, with `unacknowledged` at 1000.

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

- After the fake dropped listeners: `closeConsumers()`, or a reset or restore that closed them with `1006`. c8y-realtime reconnects on its own timer, about 1 s after a drop and longer after failed attempts.
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

A custom `schedule` counts in `status().scheduled` until it runs the callback. One that never runs it (`schedule: () => {}`, to mute delivery) keeps `idle()` from resolving until the next `reset()`, `restore()`, or `realtime.clear()`, which drop the scheduled work and its count. `settled()` and `pending()` also count a socket that is still connecting (`status().connecting`). A reset or restore drops it only when it closes the socket (its subscription is gone): otherwise they stay busy until the socket connects, its client closes it, or `realtime.clear()` runs.

#### Changed: `settled()` waits only for live work

`settled()` and `pending()` no longer count stored frames (`backlog`), and `settled()` lost its `unclaimed` option: a token whose consumer is gone for good (a stopped service) made them hang. `waitForRealtimeStartup()` and its types (`RealtimeStartupOptions`, `RealtimeStartupResult`) are removed. To migrate:

- `waitForRealtimeStartup(world.realtime, () => world.inflight)` becomes `await world.realtime.settled()`. To wait for a specific listener, poll `world.realtime.consumers()` first (see [When to poll first](#when-to-poll-first)).
- Drop `unclaimed: 'wait'` or `unclaimed: 'ignore'` from `settled()`: it now waits for neither unclaimed frames nor the backlog.
- A test that relied on `settled()` waiting for a consumer to connect polls `consumers()` first.

#### Changed: stateless tokens, and resets close by subscription

Tokens used to be stored (`fake-token-<n>-<subscription>-<subscriber>`), and a reset or restore closed the sockets whose token or subscription was gone with `4410` (`CONSUMER_REMOVED`). Now tokens are JWT-shaped and stateless (see [Notification 2.0](#notification-20)), and a reset or restore closes only the sockets whose subscription is gone, with `1006` and an empty reason. To migrate:

- Drop `CONSUMER_REMOVED` (from `fake-c8y` and `fake-c8y/realtime`) and checks for `4410`: expect `1006` and `''`. A client sees the close as a dropped connection and may reconnect; its old token still works.
- `realtime.tokens`, the `tokens` option of `Realtime`, and the `notificationTokens` collection are removed. Read a socket's claims from `socket.token`. Snapshots no longer have `notificationTokens` or `sequences.notificationToken`; `restore()` ignores them in older snapshots.
- `reset({ consumers: 'keep' })` now closes nothing, also not a socket whose subscription the state reset to does not have. The default closes by subscription only, so a socket with a token minted after a checkpoint stays open when the checkpoint has its subscription.
- Two requests with the same claims at the same time get the same token. Mint with another subscriber or expiry to get another one.
- The public type `NotificationToken` changed: `expires` (epoch milliseconds) is always set, and it has a new optional `shared`.

#### Changed: refused connects answer with an HTTP status

A connect with a bad token used to emit `error` (`Invalid notification token`) and close with `1008` (`invalid token`). Now it is refused with 401 or 400 before any socket opens (see [Refused connects](#refused-connects)): `error` (`Unexpected server response: <status>`), then close `1006` with an empty reason, or only `unexpected-response` in the `ws` flavor with a listener for it. Replace checks for `1008` with checks for `1006`, or read the status in an `unexpected-response` listener. A connect without exactly one non-empty `token` parameter used to count as a bad token too; it now answers 400. A socket class of your own (one that is not from `createFakeWebSocket()`) now gets `error` and close `1006` one scheduled tick later, through the world's `schedule`, instead of `error` and `1008` synchronously in the connect.

#### Changed: one backlog per subscriber

The backlog used to be per subscription: the open sockets of a subscription all got every frame, and frames waited for the subscription while none was open. Now every subscriber has its own (see [One backlog per subscriber](#one-backlog-per-subscriber)). To migrate:

- Two subscribers of one subscription each get every frame, also when one of them connects only later: frames wait for each subscriber that has connected before.
- A second open socket with the same subscriber is refused with 409, unless all its sockets use shared tokens. Give each client its own subscriber, or mint with `shared: true` (the sockets then split the frames by source).
- The keys of `realtime.backlog` are now per subscriber and opaque. `realtime.unsubscribed(tenant, subscription, subscriber)` takes the subscriber as a required third argument and drops only that subscriber's backlog.

#### Changed: unsubscribe no longer closes the socket

`POST /notification2/unsubscribe` used to close the subscriber's open sockets with `1000`. Now it closes no socket, like the platform: it drops the subscriber's backlog and the socket keeps receiving. A test that expected the close must close the socket itself. A repeat unsubscribe now answers 200 while the socket is open; it answers 500 only once no socket of the subscriber is open. `realtime.unsubscribed()` used to do nothing while a socket of the subscriber was open; now it drops the backlog and the open sockets' unacknowledged frames, and the subscriber stays connected.

#### Changed: nothing is kept before a consumer connects

A persistent subscription used to keep every frame from the moment it existed, and the first consumer to connect got them all. Now frames are kept only once a consumer of the subscription has connected, because the platform keeps nothing before a first connect. `status().unclaimed` is always 0 and deprecated. A test that writes data for a consumer must connect the consumer first, then write.

### What is still on its way

`world.realtime.status()` splits up what Notification 2.0 still has on its way:

| Field            | Counts                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inflight`       | Requests the world is answering (their writes may still publish).                                                                                              |
| `scheduled`      | Callbacks given to `schedule` since the last reset that have not run: frame deliveries, socket connects, and socket events (`open`, `close`, `pong`).          |
| `connecting`     | Sockets whose connect has not run yet.                                                                                                                         |
| `unacknowledged` | Frames delivered to a socket and not acknowledged.                                                                                                             |
| `backlog`        | Frames held for the subscribers of a persistent subscription that have no open socket, summed over all subscribers, kept only once a subscriber has connected. |
| `unclaimed`      | Always 0 (deprecated): nothing is kept before a consumer connects.                                                                                             |

`world.realtime.pending()` is the live work `settled()` waits for: `inflight` + `scheduled` + `connecting` + `unacknowledged`. `backlog` is informational: neither `settled()` nor `pending()` waits for or counts it. Read `pending()` as zero or not zero, not as a number of tasks: it is a sum of the four counts, and a connecting socket counts twice (its connect callback in `scheduled`, the socket in `connecting`).
