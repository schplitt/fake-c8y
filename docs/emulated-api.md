# Emulated API

The endpoints and query parameters come from the Cumulocity OpenAPI spec (`src/capabilities.generated.ts`, exported as `C8Y_ENDPOINTS`). A query parameter the endpoint knows but the world does not emulate is reported as unsupported (see [The coverage gate](coverage.md)). Unknown parameters are ignored, like on the platform.

| Area                                     | What the Fake Does                                                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory, identity, binaries            | Query language, `text` search, hierarchy, `cascade` and `forceCascade`. Deleting an object deletes what belongs to it. `GET /inventory/managedObjects/count` works. `withLatestValues` is accepted and ignored. |
| Measurements, events, alarms, operations | Lists, `series`, `supportedSeries`, event attachments, alarm counts. Generated history: see [Generated measurements](generated-measurements.md).                                                                |
| Bulk operations, new device requests     | See [below](#bulk-operations-and-device-registration). `POST /devicecontrol/deviceCredentials` is not emulated.                                                                                                 |
| Availability                             | See [below](#availability).                                                                                                                                                                                     |
| Users, groups, roles                     | Users, groups, global and inventory roles, inventory assignments, device permissions. See [below](#users-groups-and-roles).                                                                                     |
| Tenant options, retention rules, audit   | See [below](#tenant-options-and-retention-rules) and [Audit records](#audit-records).                                                                                                                           |
| Tenant statistics and administration     | See [below](#usage-statistics-and-tenant-administration).                                                                                                                                                       |
| Applications and microservices           | See [Applications](applications.md) and [Services](services.md).                                                                                                                                                |
| Notification 2.0                         | Subscriptions and tokens through REST, consumers through `createFakeWebSocket()`. See [The world](world.md#notification-20).                                                                                    |
| Auth                                     | Basic auth selects the tenant and the user. A tenant prefix the world does not have answers 401, and `targetTenant` is not read.                                                                                |

Permission checks are on by default: stored users and service users get 403 where the platform answers it. Requests without Basic auth, the world's own `user`, and unknown user names stay unrestricted, and `createWorld({ roles: 'off' })` gives every caller full access ([Roles](roles.md)). <platform-behavior.md> lists every verified place where the platform differs from its API docs.

## Deletes

Deleting a managed object deletes what belongs to it, like the platform: its references, external ids, binary, measurements (also generated ones), events with their attachments, alarms, operations, Notification 2.0 subscriptions, and inventory assignments on it. Which descendants go too follows `cascade` and `forceCascade`.

## Availability

- `c8y_RequiredAvailability` written through the API sets `c8y_Availability` and `c8y_Connection`: AVAILABLE for an interval above 0, MAINTENANCE for 0 or less, both removed without an interval. Data sent through the API moves `c8y_Availability.lastMessage`.
- By the world's clock, a device without data turns UNAVAILABLE at the first full minute after `lastMessage + responseInterval`. A `c8y_UnavailabilityAlarm` (MAJOR) follows at twice the interval unless data came first.
- Data (a POSTed measurement, event, or alarm, or a generated measurement) makes the device AVAILABLE again and clears every open `c8y_UnavailabilityAlarm` of it. An update of the device without changes (`{}` or only its `id`) also counts as data. Real updates, operations, alarm upserts, and requests with the `X-Cumulocity-Application-Key` header do not.
- `world.device()` stores the fragments as given. A device seeded UNAVAILABLE gets no alarm unless it is still due (`lastMessage` less than twice the interval ago). A device seeded AVAILABLE, or with only `c8y_RequiredAvailability`, is brought up to the clock on the first tick, so an old `lastMessage` turns it UNAVAILABLE with an alarm at once. A device seeded without the fragments also gets `c8y_Connection`.
- Devices due at the same time are handled in device id order, on a plain world and on a fork alike. A restored snapshot keeps an alarm that was still due.
- A live measurement generator keeps its device AVAILABLE while it runs, and the device turns UNAVAILABLE in a gap. The API shows the last generated point as `c8y_Availability.lastMessage`, but the stored document changes only when the status switches, so `$filter` and `query` on that field see the stored value.
- `GET .../availability` always answers 404 "not found in cache", as on the platform for objects fed through the REST API.

## Bulk operations and device registration

A bulk operation creates one operation per child asset of its group: the first at `startDate` (at once if it lies in the past), then one every `creationRamp` seconds, by the world's clock. With the default clock (`Date.now`) it progresses in real time, seen on the next request. A device without an agent gets a FAILED operation, like on the platform. `world.db.operations.update(id, { status })` acts like the device's agent and recalculates the bulk operation's general status.

```ts
let now = Date.parse('2026-01-01T10:00:00Z')
const world = createWorld({ now: () => now })
// ... an agent creates a bulk operation starting in 10 seconds with a ramp of 5
now += 20_000
world.db.bulkOperations.find() // [{ status: 'IN_PROGRESS', progress: { all: 4, ... }, ... }]
```

New device requests start as `WAITING_FOR_CONNECTION`. A user can accept one only in `PENDING_ACCEPTANCE`, which on the platform the device's credentials poll causes. Seed it in that state, or call `world.db.newDeviceRequests.connect(id)`.

## Users, groups, and roles

Every tenant starts with:

- a role catalogue of the core platform roles (`DEFAULT_ROLES`: alarm, event, inventory, measurement, user management, tenant management, and others, as `READ` and `ADMIN`). Roles of optional applications and microservices are left out; add them with `seed({ roles })`.
- the platform's twelve default groups with their ids and descriptions (`business` 1, `admins` 2, `readers` 3, `devices` 4, up to `Global Manager` 12), with their roles limited to the catalogue (`admins` has all of it).
- the four default inventory roles: `Reader`, `Manager`, `Operations: All`, and `Operations: Restart Device`.

```ts
const world = createWorld({ user: { userName: 'eva', groups: ['readers'] } })
const pump = world.device({ name: 'Pump' })
world.seed({
  roles: ['ROLE_PUMP_ADMIN'],
  inventoryRoles: [{ name: 'Pump operator', permissions: [{ permission: 'ADMIN', scope: 'OPERATION', type: '*' }] }],
  groups: [{ name: 'Operators', roles: ['ROLE_PUMP_ADMIN', 'ROLE_ALARM_READ'] }],
  users: [{ userName: 'anna@example.com', firstName: 'Anna', groups: ['Operators'], inventoryAssignments: [{ managedObject: pump, roles: ['Pump operator'] }] }],
})

world.db.users.get('anna@example.com') // as GET /user/{tenantId}/users/{userId} renders it
world.db.users.effectiveRoles('eva') // her roles plus the readers' roles
world.db.inventoryAssignments.find({ user: 'anna@example.com' })
```

- The world's `user` is a stored user of its tenant: `roles` are its own global roles, `groups` (names or ids) its memberships, and `GET /user/currentUser` answers with its effective roles (its own plus its groups'). Changes through the API show there. `setUser()` creates or updates the stored user and never deletes one. If the stored user is deleted through the API, `currentUser` answers with the world's `user` as given.
- A request with Basic auth of another stored user gets that user in `currentUser`, with its own effective roles, so several users with different roles can share one world. A user the tenant does not store gets the world's `user`, so a forwarded header that names another user keeps working.
- Every new user starts with `ROLE_USER_MANAGEMENT_OWN_READ` and `ROLE_USER_MANAGEMENT_OWN_ADMIN`, like on the platform: seeded users get them in addition to the roles given, and so do users created through the API. The email defaults to the user name if it is an email address, else `<userName>@example.com`. Passwords are validated but not kept.

## Audit records

The world writes the audit records the platform writes: alarm creation and changes (with `changes[]`), operation creation and updates, managed object and tenant option deletion, Notification 2.0 subscriptions and tokens, users (creation, field updates, roles, group membership, inventory assignments, deletion), group roles, and inventory roles. Creating or updating managed objects, events, measurements, retention rules, and tenant options, and creating, renaming, or deleting groups writes none. [platform-behavior.md, "Audit"](platform-behavior.md#audit) has the full table.

- Records are written only for API requests. Their `user` is the Basic auth user, else the world's user. World helpers (`seed()`, `device()`, `db.operations.update()`) write none; seed history with `seed({ auditRecords })`.
- `GET /audit/auditRecords` lists the oldest first, and the newest first with `dateFrom` or `dateTo`, like the platform.
- `POST /audit/auditRecords` stores a record of your own (`type`, `time`, `text`, and `activity` required; `user` defaults to the caller).

## Tenant options and retention rules

- `POST` upserts. `credentials.*` values come back encrypted on writes and read `<<Encrypted>>`, except in the world's own settings category, and for a registered service's own users in its settings category. An option can exist without a value.
- `PUT …/editable` answers 403, as for any tenant other than management. `GET /tenant/system/options` answers the platform's fixed set of system options.
- Retention rules are validated, stored, and served like the platform's, but the world deletes no data by them.

## Usage statistics and tenant administration

`GET /tenant/statistics`, `/summary`, and `/device/{tenantId}/daily|monthly/{date}` answer from three sources:

- **Seeded days** (`seed({ usageStatistics })`): history with any counters, `storageSize`, `resources`, `subscribedApplications`, and per-device counts (`devices`). They are tenant data, so they show in snapshots, diffs, and forks.
- **The trial's requests**: every request since the last `reset()` or `restore()` counts on its day of the trial clock. A fork shows its own activity on top of the base's seeds. This is not tenant data and never shows in a diff.
- **The inventory**: today's device counts come from the managed objects, counted once per frozen base. A fork counts again after its writes.

```ts
world.seed({ usageStatistics: [{ day: '2026-10-01', requestCount: 15000, deviceRequestCount: 400, measurementsCreatedCount: 20000, deviceCount: 100, storageSize: 400000000, devices: { [pump]: 100 } }] })
```

| Counter                                                                   | Where It Comes From                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestCount`                                                            | Every request of the trial, plus the seed. The request being answered is not counted yet.                                                                                             |
| `deviceRequestCount`                                                      | Requests of `device_*` users outside `/user`, `/tenant`, and `/application`, plus the seed.                                                                                           |
| `measurementsCreatedCount`                                                | Successful creates (each measurement of a collection counts), plus the seed.                                                                                                          |
| `events*`, `alarms*`, `inventories*`, `operations*` (created and updated) | Successful `POST` and `PUT` by id, plus the seed. An approximation: a deduplicated alarm counts as created, bulk alarm updates and child references created with a body do not count. |
| `deviceCount`, `deviceWithChildrenCount`, `deviceEndpointCount`           | Today: the inventory. Other days: the last seed on or before the day.                                                                                                                 |
| `storageSize`, `subscribedApplications`                                   | Seeded only: the last seed on or before the day, else 0 and `[]`.                                                                                                                     |
| `resources`                                                               | Seeded only, per day.                                                                                                                                                                 |
| device statistics (`count`)                                               | The day's seeded `devices` plus the trial's measurements, events, and alarms per source, shown once the day (or month) is over.                                                       |

Days run from the first seeded or active day to today, oldest first, also without activity. The summary sums counters and resources and takes the last day's storage, devices, and applications. `allTenantsSummary` answers `[]`, and statistics files answer 403, like for a tenant admin.

The rest of the tenant admin API is read-only: `GET /tenant/tenants` is empty and a single tenant answers 403. TFA settings and restricted roles answer the platform's defaults. `GET /tenant/loginOptions/**` answers the default basic and OAI-Secure login options without access mappings. Trusted certificates come from `seed({ trustedCertificates: [{ fingerprint, name, issuer, subject, notAfter, ... }] })`; the fake does not parse certificates. Writes answer 501.

## Other simplifications

- `supportedSeries` and `supportedMeasurements` come from the measurements stored for the object. The platform drops a series a few seconds after its last measurement is deleted; the world drops it at once.
