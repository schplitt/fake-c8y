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

| Option             | Default                                | Meaning                                                                                                                             |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`           | `'t12345'`                             | Tenant the microservice is deployed in. Requests without a tenant in their Basic auth go here.                                      |
| `user`             | `{ userName: 'test-user', roles: [] }` | User that `GET /user/currentUser` answers with. `null` answers 401. The world also stores it as a user of its tenant.               |
| `subscriptions`    | `service_<tenant>`, `service-password` | Tenants subscribed to the microservice, with their service users.                                                                   |
| `tenantOptions`    | none                                   | Tenant options in the microservice's own settings category.                                                                         |
| `baseUrl`          | `'https://t12345.cumulocity.test'`     | Base URL in `self` and `next` links.                                                                                                |
| `bootstrapUser`    | `'servicebootstrap_test'`              | Bootstrap user, allowed to read `/application/currentApplication`.                                                                  |
| `settingsCategory` | `'service'`                            | The microservice's own tenant option category. Its `credentials.*` options read decrypted.                                          |
| `now`              | `Date.now`                             | Clock for timestamps, in epoch milliseconds.                                                                                        |
| `clock`            | none                                   | A trial clock from `createClock()`. It wins over `now`. See [Trials](trials.md#the-clock).                                          |
| `ids`              | `'scattered'`                          | Id format, see [Ids](#ids).                                                                                                         |
| `schedule`         | `setTimeout(callback, 0)`              | Runs a callback later (Notification 2.0 delivery).                                                                                  |
| `unsupported`      | `'developer'`                          | How to answer a request the world does not emulate. See [The coverage gate](coverage.md).                                           |
| `onUnsupported`    | none                                   | Called with every request the world does not emulate, and the world.                                                                |
| `onChange`         | none                                   | Called with the world when the deployed tenant or the current user changed.                                                         |
| `roles`            | `'enforce'`                            | Checks requests against the caller's rights, like the platform. `'off'` gives every caller full access. See [Roles](#roles).        |
| `freezeDocuments`  | `false`                                | Deep-freezes every stored document, so code that changes one in place throws. For tests of fake-c8y itself; it makes writes slower. |

`DEFAULTS` (exported) holds the default values.

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

Basic auth selects the tenant and the user (`<tenant>/<user>:<password>`). A request without Basic auth works in the deployed tenant as the world's `user`.

## Roles

Roles are enforced by default. A request with Basic auth of a user the tenant stores (other than the world's `user`), or of a registered service's bootstrap or service user, gets the platform's 403 `security/Forbidden` where it lacks the rights, and lists show only what it may see. Three kinds of caller stay unrestricted: requests without Basic auth, the world's own `user`, and user names the tenant does not store. `roles: 'off'` gives every caller full access.

A user you switch to with `setUser()` or `apply({ user })` is stored in its tenant only while it is current: switching away removes it again, or puts back the seeded user of that name, unless the API changed it meanwhile. The user the world starts with stays stored.

Seeded users get the two roles every new user gets on the platform, `ROLE_USER_MANAGEMENT_OWN_READ` and `ROLE_USER_MANAGEMENT_OWN_ADMIN`, plus the `roles` you give.

A user input with its own `tenant` (like a `C8yUser`) is stored in that tenant, not in the seed's, and `tenant` is not kept as a user field. The seed's custom `roles` are added to that tenant's role catalogue too, so one seed can hold callers of several tenants. Such a user cannot have `groups` or `inventoryAssignments`, since they are looked up in the seed's tenant: `seed()` throws a `TypeError` before writing anything, and you seed the user with `{ tenant }` instead.

```ts
const world = createWorld({ tenant: 't12345' })
world.seed({ roles: ['ROLE_PUMP_ADMIN'], users: [{ userName: 'anna', roles: ['ROLE_PUMP_ADMIN'] }, { userName: 'eve', roles: ['ROLE_PUMP_ADMIN'], tenant: 't99999' }] })
world.db.tenant('t99999').users.get('eve') // stored in t99999
```

```ts
const world = createWorld()
const pump = world.device({ name: 'Pump' })
world.seed({ users: [{ userName: 'viewer', roles: ['ROLE_INVENTORY_READ'] }] })
const headers = { authorization: `Basic ${btoa(`${world.tenant}/viewer:any`)}` }
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
| `callCount`      | How many requests this override got, this one included: `2` is its second. A fork counts on its own, and `reset()` starts over.                        |
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
| `apply(state)`, `setUser(user)`       | Change the tenant, user, subscriptions, or tenant options.                                                                              |
| `calls`, `unhandled`, `inflight`      | Requests answered and requests not emulated since the last reset, and the number of requests being answered now.                        |
| `callsTo(pattern)`                    | The calls since the last reset that match an `override()` pattern, in order: `world.callsTo('POST /alarm/alarms')`.                     |
| `muted(fn)`                           | Runs `fn` without publishing Notification 2.0 messages. An async `fn` mutes the whole world until its promise settles.                  |
| `tenant`, `user`, `subscriptions`     | The current deployed tenant, current user, and subscriptions.                                                                           |

`matchesCall(pattern, call)` (exported) tells whether one recorded call matches a pattern (a string or a `compileRoute()` result), e.g. to filter `calls` of several worlds, `unhandled`, or `coverage().platformErrors`. Both match a recorded call exactly as `override()` matched its request, also with an encoded `/` or `?` inside a segment. For an object the world did not record, `matchesCall()` splits its `path` at `/`.

`db` collections have `get(id)` and `find(filter?)`; a filter is a partial object or a predicate. `db.measurements.find()` builds every matching generated document, so filter it by `source`.

## Ids

- `ids: 'scattered'` (the default) gives ids in the platform's format. Managed objects get 8 digits with a scattered two-digit prefix in front of one shared counter (`47100001`). Events, alarms, operations, audit records, and retention rules get the bare counter (`100002`), and measurements 24 hex digits. Inventory lists keep creation order, so ascending managed object ids are not creation order, like on the platform.
- `ids: 'sequential'` gives `'1'`, `'2'`, and so on for every collection, which reads better in some tests.
- Both are deterministic: forks of the same base hand out the same ids.
- Groups, inventory roles, their permissions, inventory assignments, and bulk operations count on their own per tenant, like on the platform.

## Notification 2.0

Subscriptions and tokens work through the REST API. Consumers connect with a fake WebSocket from the `fake-c8y/realtime` entry. Pass it where your client expects a `ws`-style WebSocket. `encodeMessage` turns a frame into the `message` event's data (default: the text).

```ts
import { Buffer } from 'node:buffer'
import { createFakeWebSocket } from 'fake-c8y/realtime'

const WebSocket = createFakeWebSocket(world.realtime, { encodeMessage: (text) => Buffer.from(text) })
```

Sockets belong to one world, so use `createFakeWebSocket(fork.realtime)` for a fork. Subscriptions and tokens are tenant data: a fork inherits the base's, `reset()` drops the ones created since (`reset({ to, consumers: 'keep' })` keeps open consumers, see [Checkpoints](trials.md#checkpoints)), `restore()` brings back the snapshot's, and `diff()` lists subscriptions under `notificationSubscriptions`.

### Close codes

Only `reset()` and `restore()` use a distinct close code: when one of them removes a consumer's token or its subscription, the consumer's open socket closes with code `4410` and reason `notification token removed`, exported as `CONSUMER_REMOVED` (from `fake-c8y` and `fake-c8y/realtime`). The consumer no longer exists, so a client should stop instead of reconnecting. The platform documents no close code for this case: `4410` is fake-c8y's own, in the application range (4000-4999), modeled on HTTP 410 Gone.

- A socket still connecting when a reset or restore removes its token is not closed by it: its connect then fails like any connect with an unknown token.
- A connect with an unknown token emits `error` and closes with `1008` (`invalid token`).
- A socket the client closes itself closes with `1000`, and so does every socket on `world.realtime.clear()`.
- `POST /notification2/unsubscribe` closes the consumer's socket with `1000`.
- Removing a subscription through the API (`DELETE /notification2/subscriptions/{id}`, `DELETE /notification2/subscriptions?source=…`, or deleting the managed object a subscription is for) closes no socket: the consumer stays open and receives nothing more. What the platform does there is not verified.

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
