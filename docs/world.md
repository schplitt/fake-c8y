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
| `freezeDocuments`  | `false`                                | Deep-freezes every stored document, so code that changes one in place throws. For tests of fake-c8y itself; it makes writes slower. |

`DEFAULTS` (exported) holds the default values.

## Seeding

- `world.device(input)` and `world.managedObject(input)` create a managed object and return its id. The input takes fragments plus `children`, `assets`, `additions`, `externalIds`, and `tenant`. `device()` adds `c8y_IsDevice`.
- `world.binary({ name, content, contentType?, tenant? })` creates an inventory binary and returns its id.
- `world.seed({ ... })` adds `measurements`, `measurementGenerators`, `events`, `alarms`, `operations`, `newDeviceRequests`, `retentionRules`, `auditRecords`, `roles`, `groups`, `users`, `inventoryRoles`, `applications`, `serviceState` (of a registered service), `usageStatistics`, and `trustedCertificates`, validated like API writes. `defaultApplications: false` removes the default applications. `tenant` picks the tenant (default: the deployed one).

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

`world.fetch(request)` answers a request to the platform. It never throws. A malformed request gets the platform's 4xx, and an exception inside the fake or an override becomes a 500. The one exception is a request whose signal is already aborted: like `fetch`, it rejects with the signal's reason and is not sent. A signal that fires later rejects at once, while the world still answers the request (its call is recorded with `aborted: true`). Every answer carries the standard reason phrase as `statusText` (`404 Not Found`).

Like the platform, a write (POST or PUT) answers with its object only if the request accepts JSON (`Accept: application/json` or a Cumulocity vendor type). Without an Accept header, or with `*/*`, the status is the same and the body is empty. Send `Accept: application/json` when you read the result of a write.

Basic auth selects the tenant and the user (`<tenant>/<user>:<password>`). A request without Basic auth works in the deployed tenant as the world's `user`.

## Overrides

`world.override(pattern, handler, { once? })` answers matching requests with your handler instead of the emulation. The newest override wins. It returns a function that removes it.

```ts
const remove = world.override('GET /inventory/managedObjects/:id', (ctx) => ({ id: ctx.params.id, name: 'Stub' }))
```

The handler gets the request fields (`method`, `path`, `query`, `body`, `headers`, `tenant`, `user`), `params`, `request` (a copy whose body it can read), and `world` (the fork that got the request, also for an override registered on the base). It returns a `Response`, another value (200 with it as JSON), or nothing (204). It can throw `UnsupportedRequestError` (exported) to report the request as not emulated (kind `'feature'`).

## Reading and changing state

| Member                                | What It Does                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `db`                                  | Read access for assertions, as the API renders the data: `db.alarms.find({ source: pump })`, `db.users.get('anna')`, `db.tenant('t2')`. |
| `db.operations.update(id, update)`    | Updates an operation like a device agent, e.g. `{ status: 'SUCCESSFUL' }`.                                                              |
| `db.newDeviceRequests.connect(id)`    | Moves a new device request to `PENDING_ACCEPTANCE`, like the device's first credentials poll.                                           |
| `options.get/set/delete(key, scope?)` | Tenant options. `scope` is `{ category?, tenant? }`; the default is the own settings category of the deployed tenant.                   |
| `apply(state)`, `setUser(user)`       | Change the tenant, user, subscriptions, or tenant options.                                                                              |
| `calls`, `unhandled`, `inflight`      | Requests answered and requests not emulated since the last reset, and the number of requests being answered now.                        |
| `muted(fn)`                           | Runs `fn` without publishing Notification 2.0 messages. An async `fn` mutes the whole world until its promise settles.                  |
| `tenant`, `user`, `subscriptions`     | The current deployed tenant, current user, and subscriptions.                                                                           |

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

Sockets belong to one world, so use `createFakeWebSocket(fork.realtime)` for a fork. Subscriptions and tokens are tenant data: a fork inherits the base's, `reset()` drops the ones created since, `restore()` brings back the snapshot's, and `diff()` lists subscriptions under `notificationSubscriptions`.
