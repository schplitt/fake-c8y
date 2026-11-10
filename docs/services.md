# Services

An agent often calls the tenant's own microservices next to the platform API. A service emulation answers `/service/<contextPath>/**` in a world. Its state lives in the world as tenant data, so it forks, resets, snapshots, restores, and diffs with everything else, and every trial sees only its own.

## A service in its own file

Define a service once with `defineService()`, in its own file next to its `cumulocity.json`:

```ts
// tickets.ts
import { defineService } from 'fake-c8y'
import manifest from './cumulocity.json' with { type: 'json' } // { "name": "tickets", "contextPath": "tickets", "requiredRoles": ["ROLE_EVENT_ADMIN"] }

export const tickets = defineService({
  manifest, // the context path 'tickets' comes from here
  seed: { state: [{ store: 'tickets', key: 't0', value: { device: '0', text: 'seeded' } }] },
  handler: async (request, ctx) => {
    const url = new URL(request.url) // '/tickets' for '/service/tickets/tickets'
    if (request.method === 'POST' && url.pathname === '/tickets') {
      const id = ctx.newId()
      const ticket = { ...await request.json(), by: ctx.user, at: new Date(ctx.now()).toISOString() }
      ctx.store('tickets').set(id, ticket)
      // sent as the service user: it owns what it creates, and audit records name it
      await ctx.fetch('/event/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: { id: ticket.device }, type: 'ticket_opened', text: id, time: ticket.at }),
      })
      return Response.json({ id }, { status: 201 })
    }
    if (request.method === 'GET' && url.pathname === '/tickets') {
      return Response.json(ctx.store('tickets').list())
    }
    return ctx.unsupported(`${request.method} ${url.pathname}`)
  },
})
```

`defineService()` checks the definition and returns it frozen. It belongs to no world, so the same definition registers on any number of worlds. The context path comes from `manifest.contextPath`. A definition without a manifest gives `contextPath` itself, and when both are given they must be the same. An invalid definition throws a `TypeError` that names the service, e.g. `fake-c8y: service ticket: contextPath 'ticket' differs from manifest.contextPath 'tickets'`.

In a test, register it and send requests:

```ts
import { createWorld } from 'fake-c8y'
import { tickets } from './tickets'

const world = createWorld()
const pump = world.device({ name: 'Pump' })
world.service(tickets) // application, service user, seed, handler

const response = await world.fetch(new Request(`${world.baseUrl}/service/tickets/tickets`, {
  method: 'POST',
  headers: { 'accept': 'application/json', 'content-type': 'application/json' },
  body: JSON.stringify({ device: pump, text: 'Leak' }),
}))
const { id } = await response.json() // 201
world.db.serviceState('tickets', 'tickets').list() // [['t0', { device: '0', text: 'seeded' }], [id, { device: pump, text: 'Leak', ... }]]
```

In an eval, register it on the base and give every trial a fork:

```ts
const base = createWorld()
base.service(tickets)
const trial = base.fork() // has the application, the seed, and the handler; its diff starts empty
await runAgent(trial)
const changes = trial.diff().tenants[trial.tenant]?.serviceState // { created, updated, deleted }
```

The handler gets a `Request` whose URL has the path below the context path (`/service/tickets/tickets?x=1` arrives as `/tickets?x=1`), like a microservice sees it on the platform. Its body can be read. The handler returns a `Response` or a promise of one.

## Registration

`world.service(definition, { handler? })` registers a microservice the way the platform does when its zip (with `cumulocity.json`) is uploaded and tenants subscribe to it, then applies the definition's seed. It returns a function that removes the service and deletes its application. `world.services` lists the registered services by context path, each with the definition it was registered with.

A definition has these fields:

| Field         | Default                         | Meaning                                                                      |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `manifest`    | `{}` (name is the context path) | The service's `cumulocity.json`.                                             |
| `contextPath` | `manifest.contextPath`          | `<contextPath>` in `/service/<contextPath>/**`. Must match the manifest's.   |
| `owner`       | the deployed tenant             | The tenant that owns the microservice.                                       |
| `tenants`     | the owner                       | The tenants subscribed to it.                                                |
| `user`        | `service_<name>`                | The service user, in every subscribed tenant.                                |
| `seed`        | none                            | Base data in every subscribed tenant (see [Seeding](#seeding)).              |
| `handler`     | none                            | Answers the requests. `world.service(definition, { handler })` overrides it. |

Without a handler, the application, its users, and the seed are installed, and requests to the service answer 501: the request counts as not emulated (kind `'feature'`, reason `service <contextPath> is registered without a handler`), and the trial is invalid. A fork can supply the handler (see [Forks](#forks)).

A manifest with every field the world reads:

```ts
const world = createWorld({ tenant: 't100' })
world.service(defineService({
  manifest: {
    name: 'pump-service', // default: the context path
    contextPath: 'pumps',
    key: 'pump-service-key', // default: `<name>-key`
    version: '1.2.0',
    apiVersion: '2',
    isolation: 'MULTI_TENANT',
    requiredRoles: ['ROLE_INVENTORY_READ', 'ROLE_INVENTORY_ADMIN'],
    roles: ['ROLE_PUMP_READ', 'ROLE_PUMP_ADMIN'],
    settingsCategory: 'pumpcfg', // default: the context path, else the name
    settings: [{ key: 'interval', defaultValue: '5' }, { key: 'credentials.token', defaultValue: 'abc' }],
  },
  owner: 't100',
  tenants: ['t100', 't200'],
  handler: pumpHandler,
}))

world.db.applications.find({ name: 'pump-service' }) // [{ type: 'MICROSERVICE', availability: 'MARKET', subscribed: true, ... }]
world.options.get('interval', { category: 'pumpcfg', tenant: 't200' }) // '5'
```

The world creates:

- **Application.** A MICROSERVICE application in the owner tenant with the manifest, its `requiredRoles` and `roles`, and the manifest fields the platform copies to the top level. Settings get the platform's `editable`, `inheritFromOwner`, and `overwriteOnUpdate` flags.
- **Subscriptions.** One per tenant in `tenants`; the application becomes `MARKET`. `GET /tenant/currentTenant` and `?subscriber=` list it.
- **Bootstrap user.** `servicebootstrap_<name>` (`GET /application/applications/{id}/bootstrapUser`). It exists from the start, and reading it changes nothing. It reads and updates `/application/currentApplication` and lists the subscriptions with the service users and their passwords.
- **Service users.** One per subscribed tenant, with exactly the `requiredRoles`. Like on the platform, it is not a user of the tenant (the user API answers 404), but `/user/currentUser` answers for it with its roles plus `ROLE_SYSTEM`. It reads only `currentApplication/settings`. It owns what it creates and is the actor of its audit records.
- **Roles.** The manifest `roles` join each subscribed tenant's role catalogue (`GET /user/roles`) and can be assigned to users and groups. Like on the platform, they stay after an unsubscription.
- **Settings.** Each `settings` default becomes a tenant option of the settings category in each subscribed tenant, unless it exists. `GET /application/currentApplication/settings` answers them as `{ key: value }`. `credentials.*` options read decrypted for the service's own users in its settings category.

Without a registered service, `/service/<name>/**` answers 404 `microservice/Not Found` like the platform. Overrides win over services.

What an agent does to the application counts like on the platform. After `DELETE /tenant/tenants/{t}/applications/{id}` or `DELETE /application/applications/{id}`, `/service/<contextPath>/**` answers 404, the service user's credentials answer 401 (the bootstrap user's too, once the application is deleted), and `diff()` shows the change under `applications` and `applicationSubscriptions`. `reset()` creates them again.

### Registering again

- The same definition object again, with the same handler, changes nothing and returns the same remover.
- The same definition object with another handler (`world.service(definition, { handler })`) replaces only the handler. The application and the state stay as they are.
- A different definition with the same context path replaces the registration whole, like a new upload: the application, service users, roles, and settings defaults follow the new manifest, and its seed is applied. The previous registration's remover then does nothing.

## Seeding

A definition's `seed` is the service's own base data: its state and the managed objects it owns. It is applied in every subscribed tenant when the service is registered. `state` entries are what `ctx.store(store).get(key)` reads (`store` defaults to `'default'`). `managedObjects` are created with the service user as owner, unless an input names its own `owner`. Seeding sends no requests and writes no audit records.

The seed can be a function of the tenant. To seed a second tenant, subscribe it and read its state with `db.tenant()`:

```ts
const world = createWorld({ tenant: 't100' })
world.service(defineService({
  ...tickets,
  tenants: ['t100', 't200'],
  seed: (tenant) => ({
    state: [{ store: 'tickets', key: 't0', value: { device: '0', text: `seeded in ${tenant}` } }],
    managedObjects: [{ type: 'tickets_Configuration', name: 'Tickets configuration' }],
  }),
}))
world.db.tenant('t200').serviceState('tickets', 'tickets').get('t0') // { device: '0', text: 'seeded in t200' }
const [configuration] = world.db.tenant('t200').managedObjects.find({ type: 'tickets_Configuration' }) // owner: 'service_tickets'
```

Scenario data, what one test or trial starts with, goes into `world.seed({ serviceState })` instead. It seeds one tenant per call (`tenant`, default: the deployed one) and throws for a service that is not registered on the world:

```ts
base.seed({ serviceState: [{ service: 'tickets', store: 'tickets', key: 't1', value: { device: pump, text: 'Noise' } }] })
```

Where seed data lives decides what forks, `reset()`, snapshots, and diffs do with it:

| Seed Location                                 | Applied When                                               | A Fork Sees It                 | `reset()`                                                                         | `snapshot()` / `restore()`     | `diff()`                                |
| --------------------------------------------- | ---------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------- |
| On the definition (`defineService({ seed })`) | At `world.service(definition)`, in every subscribed tenant | Yes, as base data (empty diff) | Comes back: on a fork it is in the base, and a root world applies the seeds again | In the snapshot like any state | Not listed, unless the trial changed it |
| On the world (`world.seed({ serviceState })`) | At the call, in one tenant                                 | Yes, if seeded before the fork | Comes back on a fork; dropped on a root world                                     | In the snapshot like any state | Not listed, unless the trial changed it |

## The context

The handler's second argument, `C8yServiceContext`, is bound to the world that answers the request (a fork, for a trial) and to the caller's tenant.

| Member                | What It Is                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service`             | The context path.                                                                                                                                                                                                                                    |
| `tenant`              | The caller's tenant: the tenant whose data and service state the request works with.                                                                                                                                                                 |
| `user`                | The caller's user name from Basic auth, else the world's user.                                                                                                                                                                                       |
| `serviceUser`         | The service user in the caller's tenant: `service_<name>` (the manifest's `name`, else the context path), or the `user` field.                                                                                                                       |
| `call`                | `{ id, parent? }`: the request's number in `world.calls`, and the number of the request a service sent it for.                                                                                                                                       |
| `now()`               | The world's clock in epoch milliseconds (the trial clock of a fork).                                                                                                                                                                                 |
| `newId()`             | A new id from the world's id sequence. Forks of the same base hand out the same ids, and `reset()` starts them over.                                                                                                                                 |
| `state`               | The default store, the same as `store('default')`.                                                                                                                                                                                                   |
| `store(name)`         | A named store of the service in the caller's tenant. The name may not be empty or contain `/`.                                                                                                                                                       |
| `fetch(input, init?)` | Sends a request into the same world as the service user, unless the request has its own `authorization` header. A path resolves against the base URL. `/service/<other>/**` reaches other services. Rejects only when the signal is already aborted. |
| `unsupported(reason)` | Records the request as not emulated (kind `'feature'`) and throws. The world answers 501, and the trial stays invalid even if the handler catches the error.                                                                                         |

## State

A store keeps JSON values by key:

- `get(key)` returns a copy of the value, or `undefined`.
- `set(key, value)` stores the JSON form of the value: a `Date` comes back as its ISO string, and `undefined` fields are dropped. A value that is not JSON throws.
- `delete(key)` returns whether the key existed.
- `list({ prefix?, limit? })` returns `[key, value]` pairs in the order the keys were first set.

Each call is atomic. State belongs to the caller's tenant and to the world, so every fork has its own.

Read it in assertions with `world.db.serviceState(service, store?)`, which has `get` and `list` and reads the deployed tenant (`world.db.tenant(name).serviceState(...)` reads another one):

```ts
const trial = base.fork()
await runAgent(trial)
trial.db.serviceState('tickets', 'tickets').list() // [['t0', { device: '0', text: 'seeded' }], ...]
const changes = trial.diff().tenants[trial.tenant]?.serviceState // { created: [{ id: 'tickets/tickets/<key>', service, store, key, value }], updated, deleted }
```

A tenant snapshot holds the state as `[<service>/<store>/<key>, value]` pairs, and `diff()` lists one document per key under `serviceState`.

## Calls and errors

- Every call in `world.calls` has an `id` (from 1 since the last reset), and once answered a `status` and `durationMs` (host time). A call that reached a registered service has its context path in `service`. A request a service sent with `ctx.fetch()` has the id of the request it was answering in `parent`, so following the links gives agent, service, platform. A call that wrote documents lists them in `writes` (`{ collection, id, action }` for the managed objects, measurements, events, alarms, and operations it created, updated, or deleted), so an eval can tell which service changed what by following `parent` up from the write.
- A handler that throws makes the trial invalid (kind `'error'`, answered 500). Requests a service sends that the world does not emulate count like the agent's.
- `ctx.unsupported(reason)` and a service registered without a handler answer 501 (kind `'feature'`), and the trial is invalid.
- A request whose world is reset or restored while its handler runs answers 503. The handler's later state calls, `now()`, and `newId()` throw, and its later `fetch()` calls answer 503, so nothing of it reaches the next trial.

## Forks

- Services stay registered across `reset()`. A root world's `reset()` installs them and applies their seeds again.
- A fork starts with the services its base had when it was forked, and can register or replace its own. Removing a fork's replacement of an inherited service brings back the inherited one.
- Registered before the first fork, or on a frozen base, the application, subscriptions, and seed are base data: forks created afterwards inherit them and their diff starts empty. Forks created earlier do not see them. A service registered on a fork is created and seeded in that fork and shows in its diff.
- `fork()` and `restore()` never create anything, so a deleted or unsubscribed application stays that way.

When the handler differs per trial, for example because it forwards into a sandbox the trial owns, register the definition without a handler on the base and supply the handler on each fork. Use the same definition object on both, so the fork only adds the handler and its diff stays empty:

```ts
const definition = defineService({ ...tickets, handler: undefined })
const base = createWorld()
base.service(definition) // application and seed; requests answer 501
const trial = base.fork()
trial.service(definition, { handler: tickets.handler })
const changes = trial.diff().tenants // {}
```

## The short form

For a one-off service in a test, `world.service(contextPath, handler, options?)` is the same as `world.service({ contextPath, handler, ...options })`. `options` takes `manifest`, `owner`, `tenants`, and `user`:

```ts
const world = createWorld()
world.service('echo', async (request, ctx) => Response.json({ path: new URL(request.url).pathname, user: ctx.user }))
const answer = await world.fetch(new Request(`${world.baseUrl}/service/echo/hello`))
await answer.json() // { path: '/hello', user: 'test-user' }
```

Every call of the short form is a new definition, so registering the same context path again replaces the registration whole, also its manifest.

## Permissions

By default permissions are not enforced, for service users or anyone else. With `createWorld({ roles: 'enforce' })` a service's requests through `ctx.fetch()` get the manifest's `requiredRoles` (and `ROLE_SYSTEM`), like on the platform: a service user without `ROLE_EVENT_READ` gets 403 `Access is denied` on `/event/events`. Turn it on to catch an incomplete `requiredRoles` in tests. See [Roles](roles.md).

## Use from an evals host

A host registers each service definition on the base without a handler (`base.service(definition)`), which installs its application, roles, and seed, and supplies the handler per trial (`trial.service(definition, { handler })`). The handler forwards the request into the service's iso4 isolate with the `C8yServiceContext` as host bindings. The isolate gets the request with the path below the context path and the caller's tenant and user, and calls back through `ctx.fetch()` as its service user.
