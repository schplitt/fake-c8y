# AGENTS.md

## Project Overview

**fake-c8y** is an in-memory Cumulocity platform for tests and evals. It answers the platform's REST API from memory: inventory (with the query language), identity, measurements (with series and generated history), events, alarms, operations, bulk operations, new device requests, binaries, tenant options, retention rules, audit records, users and roles, applications, tenant statistics, and Notification 2.0. It also emulates the tenant's own microservices (`world.service()`). It was extracted from `c8y-nitro/testing` (c8y-nitro v0.11.1, commit `8133853`); c8y-nitro is meant to become an adapter on top of it.

It must run in any JavaScript runtime with `fetch` types: Node, workers, and iso4 isolates.

## Architecture

```
src/
├── index.ts                    # Main entry: createWorld() (request dispatch, overrides, built-in routes, seeding, snapshots, forks) and all public exports
├── collection.ts               # Collection: the keyed store every collection lives in (copy-on-write forks, tombstones, freezing)
├── defaults.ts                 # DEFAULTS: tenant, base URL, user, bootstrap user, settings category
├── reason-phrases.ts           # standard HTTP reason phrases for statusText (withReasonPhrase)
├── clock.ts                    # createClock(): the trial clock shared by a world, the agent's sandbox, and the grader
├── availability.ts             # availability monitoring by the clock (UNAVAILABLE, c8y_UnavailabilityAlarm), run by tick()
├── availability-queue.ts       # AvailabilityQueue: per-tenant due-time queue (sorted base array shared by forks + own heap)
├── realtime-entry.ts           # `fake-c8y/realtime` entry: fake consumer WebSocket
├── store.ts                    # TenantData (one Collection per kind of data) + WorldContext (per world: baseUrl, ids, clock, notify, realtime), emptyTenant/forkTenant/freezeTenant
├── user-defaults.ts            # role catalogue, default groups and inventory roles every tenant starts with
├── application-defaults.ts     # the standard applications every tenant starts with (owner `management`, subscribed); data in application-defaults.generated.ts (from a real tenant)
├── data.ts                     # Seed input, db views
├── snapshot.ts                 # JSON snapshots, restore, diff (also from a fork's touched keys: touchedSnapshots)
├── generators.ts               # generated measurement history: compiled generators, tombstones, GeneratedView (merged list, paging, series points, supportedSeries)
├── realtime.ts                 # Notification 2.0 sockets and frames per world (Realtime class); subscriptions and tokens are tenant data (notificationSubscriptions, notificationTokens)
├── websocket.ts                # createFakeWebSocket(), waitForRealtimeStartup()
├── router.ts                   # override() pattern matcher (`[METHOD ]/path` with `:name`, `*`, `**`)
├── services.ts                 # service emulations: defineService(), C8yServiceDefinition/Seed, C8yServiceContext/Handler types, serviceStore() over TenantData.serviceState, key helpers
├── utils.ts                    # clone, base64, hex, multipart parser (no structuredClone/Buffer/FormData)
├── capabilities.generated.ts   # endpoints, enums, spec paths (pnpm gen:capabilities)
└── api/                        # one handler module per API area; every handler gets `data: TenantData`
    ├── index.ts                # platformApi(): routes a request to the API modules
    ├── http.ts                 # UnsupportedRequestError, apiError, paged(), raw request parts
    ├── data.ts                 # measurements, events, alarms, operations (rendering, filters, side effects)
    ├── inventory.ts            # /inventory/managedObjects/** (hierarchy, availability fragments, cascade deletes)
    ├── query.ts                # the inventory query language
    ├── bounded-regexp.ts       # wildcard matcher with a step limit, like the platform's
    ├── identity.ts             # /identity/**
    ├── binaries.ts             # /inventory/binaries/** and event attachments (multipart and raw uploads)
    ├── notifications.ts        # /notification2/** subscriptions and tokens
    ├── bulkoperations.ts       # bulk operations: lifecycle advanced lazily by the world's clock (advanceBulkOperations)
    ├── registration.ts         # new device requests
    ├── tenant.ts               # /tenant/currentTenant, /tenant/options/**, /tenant/system/options/**; routes statistics, tenants, login options
    ├── statistics.ts           # /tenant/statistics/**: seeded days (usageStatistics), the world's UsageLog (requests that reach a platform API, by day of the trial clock; not the core's fallback or paths outside the spec), device counts from the inventory
    ├── tenant-admin.ts         # read-only /tenant/tenants/** (tfa, restricted roles, trusted certificates) and /tenant/loginOptions/**
    ├── media.ts                # the platform's media type per endpoint (MEDIA_TYPES; add new endpoints there), Accept negotiation (406), Location header, ERROR_INFO
    ├── retention.ts            # /retention/retentions/** (stored and served, no deletion)
    ├── audit.ts                # /audit/auditRecords/** and the audit hook: recordAudit() plus one helper per audited write
    ├── text-search.ts          # inventory text= (full-text search: Snowball English stemmer, stop words, phrases, exclusions)
    ├── applications.ts         # /application/** (except the credential checks of currentApplication, in index.ts), /tenant/tenants/{t}/applications/**, subscribe/unsubscribe/delete, microserviceFromManifest(), seedApplications()
    └── users.ts                # /user/** (users, groups, roles, inventory roles and assignments); /user/currentUser stays a built-in route in index.ts
tests/
├── contract/                   # scenarios (shared by the fake and the real-tenant run), spec check, deviations
├── unit/                       # one file per area, e.g. query language property test, platform-behavior doc sync, forks (fork.test.ts), generated measurements against stored ones (generated-measurements.test.ts)
└── iso4/                       # bundles the engine and runs a scenario in an iso4 isolate
scripts/generate-capabilities.ts
scripts/bench-fork.ts           # forks vs snapshot/restore at mid-sized world size (node --expose-gc scripts/bench-fork.ts [fixtures dir]); not part of test:run
scripts/bench-scale.ts          # request latencies at 10k and 100k devices (node --expose-gc scripts/bench-scale.ts [devices...]); not part of test:run
scripts/bench-generated.ts      # generated measurements at mid-sized world size, 5m and 1m (node --expose-gc scripts/bench-generated.ts); not part of test:run
docs/world.md, trials.md, coverage.md, services.md, roles.md, applications.md, emulated-api.md, development.md  # user guides, linked from README.md
docs/generated-measurements.md  # user guide plus internals of generated measurement history: model, ids, tombstones, live generators, cost
docs/platform-behavior.md       # verified platform behaviors, kept in sync with the scenarios by a test
```

### Portability rules (src/)

- No `node:*` imports, no `process`, no `Buffer`.
- No `structuredClone`, `atob`/`btoa`, `FormData`, `Blob`, `setInterval`, `crypto`: iso4 lacks them. Use `src/utils.ts`.
- No module-level mutable state: everything lives in a world (`createWorld()`) and reaches handlers through `data.world`.
- Time comes from `data.world.now()`, ids from `data.world.newId(kind)` (bulk operations use their own per-tenant `bulkOperation` sequence). `kind` (`'managedObject'`, `'measurement'`, default `'document'`) picks the platform's id format with `ids: 'scattered'` (the default, `scatteredId()` in `src/index.ts`); one counter (`nextId`) backs all kinds. Do not assume ids are `'1'`, `'2'` in tests or rely on ascending ids being creation order for managed objects.
- No timers for time-based behavior: work due by the clock (bulk operations, availability monitoring) runs in `world.tick()`, which the world calls before every request and every `db` access. `world.advance(ms)` moves the world's `clock` option (`createClock()`) and ticks; a fork's own `now` replaces the base's `clock`.
- Platform handlers are synchronous (`platformApi()` returns a `Response`, not a promise; service handlers are async, see "Service emulations"): `answer()` reads the body, checks that no `reset()`/`restore()` happened meanwhile (the `generation` counter; a stale request answers 503), and then reads and writes the tenant data in one go. An `await` inside a handler would let a reset or another request on the same world come in between (and break the `actor` of audit records).
- Read request bodies with `arrayBuffer()` unconditionally: iso4 reports `request.body === null` for a readable body.

### Store and forks

- Every kind of tenant data is a `Collection` (`src/collection.ts`) in `TenantData`: `get`, `has`, `set`, `delete`, `update`, `size`, and `keys`/`values`/`entries` in the order a `Map` with the same history has. External ids are keyed by `externalIdKey(type, externalId)`, global roles by their name, children by parent id (`Relations` values), and the per-tenant counters (groups, inventory roles, permissions, assignments, bulk operations, Notification 2.0 subscriptions and tokens) live in `sequences` (`nextSequence()`).
- Never change a stored value in place, also not a nested part of it: read it, copy what changes (`{ ...doc, field }`, `clone()`, or `collection.update(id, (draft) => ...)`), and `set()` the copy. A handler that gets a stored document and changes it works on a copy and stores it (`updateDocument()` returns the stored copy, `updateGeneralStatus()` changes the copy it is given). `get()` returns `Readonly<V>`, which catches direct assignments at compile time.
- The contract suite runs with `freezeDocuments: true` (every stored value is deep-frozen on `set()`), so an in-place change throws there. `tests/contract/fake-fork.test.ts` runs all scenarios once more on a fork of a frozen base with data of its own (`tests/contract/fork-base.ts`) and checks the base is unchanged afterwards.
- Tenant options live in `TenantData.options` (`category\u0000key` → value or `null`); the snapshot keeps them in the top-level `options` list.
- A fork's `reset()` also sets the fork's own clock copy (`ForkBase.ownClock`: no `clock`/`now` passed to `fork()`) back to the time the fork started at, so a replay after a reset gets the same ids and times.
- `world.fork()` freezes the world (its collections throw on writes, its documents are deep-frozen, `tick()` stops) and builds a new world (`buildWorld()` with a `ForkBase`) whose tenants are `forkTenant()` overlays: `#changed` (new values at base positions), `#added` (new keys and re-created ones, at the end), `#hidden` (tombstones). A fork has its own `WorldContext`, ids (starting at the base's next id), clock, `Realtime`, handlers (a copy of the base's), call log, and `unhandled` list.
- `Collection.replace()` on a fork keeps base values the new content has unchanged at their base position (so `restore()` into a fork keeps the base's indexes and a small diff) and hides the rest. `touched().recreated` lists base keys deleted and set again; `diffWorld()` reports them as deleted plus created, so a fork's `diff()` differs from a snapshot diff only there.
- A fork's `diff()` builds partial snapshots from `Collection.touched()` (the touched keys before and after, in collection order) and runs the normal `diffSnapshots()` on them; untouched keys are equal on both sides, so the result equals the full snapshot diff. Keep new collections in `TENANT_COLLECTIONS` and in `tenantSnapshot()`, so forks, freezing, snapshots, and diffs pick them up.

### Usage statistics

- What requests add to `/tenant/statistics` lives in the world's `UsageLog` (`WorldContext.usage()`), next to the call log: `dispatch()` records every answered request with its status after the answer, `reset()` and `restore()` start a new log (a snapshot does not carry it), and a fork starts with an empty one. It is not tenant data, so it never shows in a diff; seeded days are (`TenantData.usageStatistics`).
- Device counts come from `deviceCounts()`: cached per managed objects collection and `Collection.version`, so a frozen base counts once and its untouched forks reuse that; a fork counts again after a write. Do not scan the inventory per statistics day.

### Generated measurements

- `seed({ measurementGenerators })` stores compiled generators (`MeasurementStream`) in `TenantData.measurementGenerators` and reserves one counter number per grid point with `WorldContext.reserveIds` (the id is `measurementId(number)`, decoded back with `measurementSequence(id)`, so it follows the world's `ids` format); deletes of generated documents are `measurementTombstones` (point: keyed by id, with the document; range: `range#<n>`, with `until` and `count`). Both are in `TENANT_COLLECTIONS`, so forks, snapshots, and diffs need no special code beyond `tenantSnapshot()`/`restoreTenants()`/`diffMeasurements()`.
- Every read of measurements must see generated documents: use `generatedView(data)` (undefined without generators, then keep the stored-only path unchanged). Today that is the measurement list, delete by id and by filter, `series`, `supportedSeries`/`supportedMeasurements`, `deleteManagedObject()`, and `world.db.measurements`. A new reader of `data.measurements` needs the same.
- The promise is equality with a world that stores the same documents in id order (`tests/unit/generated-measurements.test.ts`). Keep the list tie order (ascending id), point order in `series` (id order), and first-appearance order in `supportedSeries` aligned with the stored path when changing either.
- `paged()` takes a lazy list (`length`, `slice`), so a handler can count and render only the page.

### Overrides

- `world.override(pattern?, handler)`: the handler is `(request, ctx) => unknown` (`C8yOverrideHandler`), like a service handler `(request, ctx)`; `ctx` has only what the request does not carry (`params`, `tenant`, `user`, `world`, `callCount`, `next()`). Without a pattern (`route: undefined`) it gets every request. `answer()` takes a copy of `handlers` when the request comes in (`stack`) and walks it newest first (`route()`); `ctx.next()` continues below the override (`route(i)`), then `emulate()` (core fallback, built-in routes, services, platform). One request is one call: `next()` records nothing new, `dispatch()` sets the final status.
- `ctx.callCount` comes from the per-world `callCounts` map (keyed by the registered entry): a fork starts with an empty map, `reset()` clears it, `restore()` keeps it. `next()` throws on a second call and answers 503 when `generation` changed; a handler that finishes after a reset or restore answers 503.

### Service emulations

- `defineService(definition)` (`src/services.ts`) checks a `C8yServiceDefinition` (context path against `manifest.contextPath`, handler, a static seed) and returns it frozen with `contextPath` resolved; a checked definition comes back as it is. `world.service(definition, { handler? })` registers it in the world's `services` map (`RegisteredService`: the checked `definition`, the `source` object passed in, the effective `handler`, possibly `undefined`); the short form `world.service(contextPath, handler, options)` builds a new definition per call. `registerService()` in `src/index.ts`: the same `source` with the same handler returns this world's remover (`removers`, a per-world WeakMap; inherited entries have none), the same `source` with another handler swaps only the handler (no data writes), anything else replaces the registration whole (`installService(..., previous)` plus `seedService()`). `world.services` maps the entries to their definitions. It is not an override: `reset()` keeps the map, `fork()` copies it into `ForkBase.services`, and a fork registers or replaces its own. `answer()` routes `/service/<name>/**` to it after overrides and built-in routes and before the platform 404 (`answerService()`); the handler gets a request whose URL has the path below the context path.
- The context (`serviceContext()`) is per request and bound to the world and to `call.tenant`. It carries `call` (the call log entry of the request being answered, the same object as in `world.calls`), so a handler can follow its chain through `parent`. Its state calls, `now()`, and `newId()` throw once `generation` changed (a reset or restore while the handler ran), its `fetch()` answers 503 then, and `answerService()` answers 503 for the whole request, so a stale handler cannot write into the next trial or its call log.
- State lives in `TenantData.serviceState` (`<service>/<store>/<key>` → JSON, `serviceStateKey()`); values go through `toJson()` on `set()` and are cloned on read. Snapshots carry it as `serviceState` pairs, diffs as one document per key (`{ id, service, store, key, value }`).
- `ctx.fetch()` goes through `dispatch(request, parent)` (the same path as `world.fetch()`) with Basic auth of `<tenant>/<serviceUser>`, so the platform handlers see the service user as `call.user` and the audit `actor`. The service user is not stored in `users` (decided: minimal; it only names owner and actor). Calls get `id` (from 1 per reset, `callCount`) and `parent` (the request the service was answering). `dispatch()` sets `status` and `durationMs` on every recorded call when it answers (host time: `performance.now()`, else `Date.now()` in iso4), and `routeService()` sets `service` when a registered handler answers.
- `ctx.unsupported()` records the request in `unhandled` right away (kind `'feature'`) and throws; `answerService()` recognizes the thrown error (`reported` WeakMap) and answers 501 without recording again. Any other exception goes to `dispatch()`'s catch: kind `'error'`, 500.
- `seedService()` applies a definition's `seed` (static or per tenant, checked with `checkServiceSeed()`) in every subscribed tenant: state into `serviceState`, managed objects through `createFromInput()` with the service user as owner (no requests, no audit records). It runs inside the registration's `registrationWrite()`, in a root world's `reset()` after `installService()`, and in a fork's `reset()` for its own registrations whose `source` differs from the inherited one. Without a handler, `routeService()` answers 501 and records kind `'feature'`. `world.seed({ serviceState })` throws for a service name not in `services`.
- With a manifest (and without: the manifest is then `{}`) a service is also a MICROSERVICE application: `installService()` in `src/index.ts` creates it in the owner tenant (`microserviceFromManifest()`) and subscribes the `tenants` (`subscribe()`: service user on the subscription document, manifest roles into the catalogue, settings defaults as options). It runs only at registration and in `reset()` (a plain world installs every service; a fork only its own registrations, since its base's data has the inherited ones). `fork()` and `restore()` never install: they keep what the base or the snapshot has, also a deleted or unsubscribed application. On a frozen base, `registrationWrite()` puts the writes into a new frozen layer of the base's tenants (only collections that changed get one), so later forks start with them as base data; `fork()` hands each fork a copy of the tenants map, so earlier forks keep theirs. Registering a different definition for a context path brings the application and subscriptions up to date (`installService(..., previous)`, `subscribe(..., refresh)`, both no-ops when `sameRegistration()`). Removing a fork's replacement gives way to the inherited registration (and its application); removing anything else deletes the application. `/service/<ctx>/**` reaches the handler only while the caller's tenant is subscribed to a MICROSERVICE with that context path (`subscribedMicroservice()`); otherwise 404, or 501 (`'outside-spec'`) for a subscribed default microservice of `management` without a handler.
- Applications live in the owner's `TenantData.applications` (every tenant has its own copies of the defaults, owner `management`); subscriptions in the subscriber's `applicationSubscriptions` by application id with `owner`, so another tenant's application is found through `WorldContext.tenantData()`. New ids come from the per-tenant `application` sequence (from 120001), so registering a service does not move the world's document ids. The bootstrap user of a MICROSERVICE is derived, not stored (`servicebootstrap_<name>`, password from the name): it works from creation on and reading it writes nothing. An application's own users answer `/user/currentUser` and `/application/currentApplication/**` (`applicationOfCredentials()`); Basic auth of another user than the world's (compared by name and tenant) answers `/user/currentUser` with that stored user of the caller's tenant and its roles, or with the world's user when the tenant does not store it (the pre-`df1e7a4` behavior); `service_*`/`servicebootstrap_*` names that no longer match and are not users of the tenant answer 401.
- `tests/unit/tenant-collections.test.ts` has one fixture and one diff entry per `TenantCollection` (typed as `Record`, so a new collection fails the typecheck) and checks that each one survives snapshot and restore and shows in `diffSnapshots()` (or is left out on purpose).

### Role enforcement

- `createWorld({ roles })`: `'enforce'` by default, `'off'` gives full access (also a `ForkOptions` field). Seeded and API-created users get `NEW_USER_ROLES` (`src/api/users.ts`), the two `OWN` roles of a new platform user. `callerAccess()` in `src/index.ts` builds the `Access` of a request: a stored user of the caller's tenant other than the world's user (`userAccess()`: effective roles, inventory assignments, device permissions), or a registered service's bootstrap or service user (`applicationAccess()`). No Basic auth, the world's user, unknown names, and the world's own `subscriptions` users stay unrestricted (`undefined`).
- `answer()` sets `access` around `platformApi()` (`WorldContext.access()`, like `actor`) and calls `authorize()` first. `RULES` in `src/api/access.ts` maps endpoint templates to checks; the match with the most literal segments wins. A check on a document by id lets an unknown id through, so the handler answers 404 like the platform.
- Lists that filter instead of answering 403 call `visible()` with `listed()`/`listedManagedObject()` in their handlers (inventory list and count, binaries, measurements, events, alarms and the alarm count, operations, audit). Keep new list handlers on that path. Filtering materializes the whole list, only for restricted callers.
- docs/roles.md documents every rule with its source (probe or spec); docs/platform-behavior.md has the verified `roles-*` rows, checked by `tests/contract/scenarios/roles.ts` (the fake contract suite runs with `roles: 'enforce'`).

### Unhandled requests and coverage

- `answer()` in `src/index.ts` records a request in `world.unhandled` with a `kind`: `'feature'` when a handler throws `UnsupportedRequestError` (unsupported query parameter or request variant), `'endpoint'` for a spec endpoint no handler answers, `'outside-spec'` for a path outside the spec's APIs (`SPEC_DOMAINS`) and outside `/service/**` (a microservice without a registered service answers 404 `microservice/Not Found` into `platformErrors`, overrides and services win), `'error'` for any other exception (caught in `dispatch()`, answered 500: `fetch()` never throws; after a reset or restore it answers 503 instead and records nothing). `dispatch()` gives every answer without a `statusText` the standard reason phrase (`withReasonPhrase()`, `src/reason-phrases.ts`), and `world.fetch()`/a service's `ctx.fetch()` reject a request whose signal is already aborted, without sending it. Malformed percent-encoding in the path answers 400, a JSON body that is not an object 400 `Failed to parse JSON string` (before the platform handlers, after overrides), so handlers can rely on `call.body` being an object or `undefined` for JSON requests. `specAnswer()` answers unknown paths (404) and wrong methods (405) like the platform; those go to `platformErrors` and do not make `world.coverage()` invalid.

### Audit records

- A write the platform audits calls a helper from `src/api/audit.ts` (`auditAlarmCreated`, `auditOperation`, `auditUser`, …) right after the change; docs/platform-behavior.md has the table of what the platform audits.
- `recordAudit()` does nothing outside a request (`data.world.actor()` is `undefined`), so world helpers and seeding write no records. Keep audited handler code synchronous: the actor is set around the dispatch.

### Operations and measurements

- An operation stores the agent its device had at creation in `__agentId` (`AGENT_ID` in `src/api/data.ts`), which `renderDocument()` leaves out; `GET`/`DELETE /devicecontrol/operations?agentId=` read it (`operationAgent()`, falling back to the device's current agent for operations stored without one). It shows in snapshots and `world.db.operations`.
- Measurement filters (`valueFragmentType`, `valueFragmentSeries`, `fragmentType`) only see series with a numeric `value` (`hasValueFragment()`), and `type` is one value compared as a whole; the generated path (`MeasurementQuery.types`, range tombstones) follows the same rules.
- Measurement validation runs in phases over all items before anything is stored (`measurementErrors()`); a collection is only read with the collection content type (`postMeasurementCollection()`).

### Lists

- Lookups that would scan a collection once per listed document use an index: `Collection.groupedBy(by)` (keys by a derived value, e.g. `externalIdsByObject()`), built once on a frozen base and reused by its forks, which layer their own changes on top; a writable collection keeps the index of its own values up to date on every write, so a write never rebuilds it. Pass a module-level function (it is the cache key). `Collection.sortedBy(by)` does the same for a sort order (stable, ties in collection order) and returns a lazy `SortedList` (a fork merges its own values into the base's order up to the end of the page; read it before the next write, it throws after one): measurements, events, and alarms lists take a single `source` from a source index and everything else from the time order of the frozen base.
- `Collection.position(key)`/`inOrder(keys)` order a few keys by collection position without a scan (every key gets an insertion number; forks continue the base's numbers), e.g. a child list in creation order.
- A list handler filters and sorts stored documents, then hands them to `paged()` with a `render` option: only the requested page is rendered (cloned, enriched with parents, children, names), while totals count all matches. Do not map the whole result to response objects before paging.

### Side effects

- A write also changes the documents the platform changes with it (the "Side effects" table in docs/platform-behavior.md): `refreshActiveAlarms()` in `src/api/data.ts` recalculates `c8y_ActiveAlarmsStatus` after every alarm write, `recordTraffic()` moves `c8y_Availability.lastMessage` for data sent in a request (not for seeding), and `updateAvailability()` in `src/api/inventory.ts` derives the availability fragments from `c8y_RequiredAvailability`.
- `deleteManagedObject()` (`src/store.ts`) deletes everything that belongs to an object; which descendants go too (`cascade`, `forceCascade`, subgroups) is decided by `deletedWith()` in `src/api/inventory.ts`.
- Seeding through `world.device()` stores fragments as given (also `c8y_Availability`); only API requests derive them at once. The availability monitor then brings monitored devices up to the clock on the first tick (an old `lastMessage` turns a device seeded AVAILABLE UNAVAILABLE, with an alarm).
- Availability by the clock (`src/availability.ts`): `TenantData.availability` (an `AvailabilityQueue`, not tenant data) holds hints (device, due time, alarm pending). `tick()` pops what is due (O(1) when nothing is) and `evaluate()` recomputes the device from its stored fragments and its generators. Writes that change `c8y_RequiredAvailability` or record traffic call `scheduleAvailability()`; a new or restored tenant scans its managed objects on the first tick; `freeze()` ticks, so forks inherit a built queue (`fork()` flattens it once into a shared sorted array). Alarm writes outside requests (the monitor) use `alarmsBySource()` once per tick, never a scan per device. The monitor stores only switches (status changes, with `lastMessage` at the switch), always on top of the stored document (`write()`); a generator-fed device's later points show in renders through `renderedAvailability()` (called from `renderManagedObject()`), so the stored state, diffs, and snapshots do not depend on the tick cadence. Queue ties pop by device id (`before()` in `availability-queue.ts`), on plain worlds and forks alike. `restore()` ticks once, so `build()` sees the restore time: an UNAVAILABLE device without an open alarm whose alarm time is still ahead gets it scheduled. Raising deduplicates into the open `c8y_UnavailabilityAlarm` with the earliest `time`, like `openAlarm()`; data clears every open one (a device can have several: a cleared one set ACTIVE again).

## Development

```sh
pnpm install          # Install dependencies
pnpm lint:fix         # Lint and auto-fix
pnpm typecheck        # TypeScript type checking (src, tests, scripts)
pnpm test:run         # Run tests once (unit, contract against the fake, spec check, iso4)
pnpm build            # Build with tsdown (platform: neutral, .mjs)
pnpm gen:capabilities # Regenerate from the live OpenAPI spec, then pnpm lint:fix
```

The gate before a commit: `pnpm lint:fix && pnpm typecheck && pnpm test:run && pnpm build`.

**Never run `pnpm test:contract` unless the user asks for it.** It runs the scenarios against a REAL tenant with the credentials in `.env` (or the environment) and creates and deletes data there. Never print `.env`. `pnpm test:run` covers the fake. `pnpm test` starts watch mode; do not use it in automation.

## Code Style

- ESM only (`"type": "module"`)
- TypeScript strict mode, `exactOptionalPropertyTypes`, `isolatedDeclarations`
- Uses `tsdown` for building
- Uses `@schplitt/eslint-config` for linting
- Uses `vitest` for testing

## Testing

- `tests/contract/fake-platform.ts` (`fakePlatform({ fork? })`) routes the real `@c8y/client` and the global `fetch` to one world and resets it before every test; a test fails if it sent a request the world does not emulate. `tests/contract/contract-suite.ts` registers the scenarios; `fake.test.ts` runs them on a plain world, `fake-fork.test.ts` on a fork.
- `tests/unit/fork.test.ts` checks forks: isolation, tombstones, a random request sequence answered identically by a plain world and a fork (and equal snapshots and diffs afterwards), ids, reset, bulk operation clocks, concurrent forks.
- A new or changed platform behavior needs a contract scenario (`tests/contract/scenarios/`), and, if it differs from the API docs, a row in `docs/platform-behavior.md` with the scenario's `verifies` id.
- Every emulated endpoint must be exercised by a scenario (checked in `tests/contract/contract-suite.ts`).
- `tests/iso4/engine.test.ts` guards portability: it bundles a scenario with the engine and runs it in an iso4 isolate.

## Maintaining Documentation

- **`AGENTS.md`**: architecture, file structure, internal patterns and conventions, testing strategy, and tool quirks for AI agents.
- **`README.md`**: what the package is, install, quick start, and links to the guides. Keep it short.
- **`docs/*.md` guides**: user-facing documentation. Update the guide for the topic when a change adds or changes an export, an option, a default, or behavior users see. Examples in the guides must run against the current code.
- **`docs/platform-behavior.md`**: reference doc on the real platform (see "Testing").
- Quirks to retest (surprising or unverified platform behavior) live in a local, untracked `docs/private/platform-quirks.md`. Never link it from tracked files.

When you update `README.md`, `AGENTS.md`, or a guide, call out the changes at the end of your response so the user can review them.

## Agent Guidelines

1. **Run the gate** after changes: `pnpm lint:fix && pnpm typecheck && pnpm test:run && pnpm build`. Prefer `pnpm lint:fix` over fixing lint issues by hand.
2. **Update this file** when adding modules or APIs or changing architecture.
3. **Keep exports in `src/index.ts`**: all public API is exported from the main entry point (`fake-c8y/realtime` is the only other entry).
4. **Add tests** for new functionality in `tests/`.
5. **Record learnings**: when the user corrects a recurring mistake or explains how something should be done, add it to "Project Context & Learnings" below.
6. **Git workflow**: use available MCP or devtools first, else the `gh` CLI. Branch names use conventional prefixes (`feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`, `build/`, `types/`, `style/`, `perf/`, `examples/`, `ci/`); commit subjects and PR titles use conventional-commit style.
7. **Pull requests**: open them from the current branch to `main` unless the user asks otherwise, and always include a body (with an issue reference if one is known).
8. **Ask when requirements are unclear**: ask one focused question instead of guessing.
9. **Prefer simple inline logic**: no tiny one-line helpers or throwaway `parse*`/`normalize*` wrappers for one-off logic.

## Project Context & Learnings

Project-specific knowledge and lessons that are likely to recur. Before adding something, check that it is not a one-time fix.

- (none yet beyond the guidelines above)
