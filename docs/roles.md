# Roles

By default (`roles: 'enforce'`), the world checks every request against the caller's rights the way the platform does: it answers 403 where the platform would, and lists show only what the caller may see. `createWorld({ roles: 'off' })` turns the checks off: every caller may do everything.

```ts
import { createWorld } from 'fake-c8y'

const world = createWorld()
const plant = world.managedObject({ name: 'Plant', c8y_IsDeviceGroup: {} })
const pump = world.device({ name: 'Pump' })
await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects/${plant}/childAssets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ managedObject: { id: pump } }),
}))
world.seed({
  users: [{ userName: 'operator', inventoryAssignments: [{ managedObject: plant, roles: ['Reader'] }] }],
})

const asOperator = { authorization: `Basic ${btoa(`${world.tenant}/operator:any`)}` }
await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects/${pump}`, { headers: asOperator })) // 200: Reader on its group
await world.fetch(new Request(`${world.baseUrl}/tenant/options`, { headers: asOperator })) // 403 security/Forbidden
```

## Who is checked

| Caller (Basic Auth `<tenant>/<user>`)                                   | Rights                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| No Basic auth                                                           | Unrestricted (the request runs as the world's `user`).                                          |
| The world's `user`                                                      | Unrestricted, whatever its `roles`.                                                             |
| A user the caller's tenant stores                                       | Its global roles (own and from its groups), ownership, inventory roles, and device permissions. |
| A registered service's service user (`world.service()`)                 | The manifest's `requiredRoles` and `ROLE_SYSTEM`.                                               |
| A registered service's bootstrap user                                   | `ROLE_SYSTEM` only.                                                                             |
| A name the tenant does not store, the world's own `subscriptions` users | Unrestricted (the fake checks no passwords).                                                    |

So under enforcement only stored users and a service's bootstrap and service users are restricted. Requests without Basic auth, the world's own `user`, and user names the tenant does not store keep full access, so tests that send no credentials work unchanged.

Every new user gets `ROLE_USER_MANAGEMENT_OWN_READ` and `ROLE_USER_MANAGEMENT_OWN_ADMIN`, like on the platform: users seeded with `world.seed({ users })` (in addition to the `roles` you give) and users created with `POST /user/{tenant}/users`. Without `OWN_READ`, `GET /user/currentUser` answers 403; delete the role through the API to test that. The world's `user` keeps exactly its `roles`, since it is unrestricted anyway. A user is unrestricted only while it is the world's `user`: after `setUser()` switches away, it is restricted by what the tenant stores for it, which is what was there before the switch.

A fork takes the option of its base unless it sets its own: `base.fork({ roles: 'off' })`.

## How a request is checked

- **The answer.** 403 `{ error: 'security/Forbidden', message: 'Access Denied', info }` with the error media type. The lists of measurements, events, alarms, and operations, the inventory list for a microservice user, and `GET /application/applications/{id}` say `Access is denied`.
- **Order.** A body that is not JSON answers 400 first. An unknown id answers 404 also without rights. Then the rights, then validation: an invalid body answers 403 without the role and 422 with it.
- **Global roles.** An `_ADMIN` role does not include its `_READ` role: `ROLE_EVENT_ADMIN` creates and updates events but does not read them.
- **Ownership.** The user that created a managed object owns it (`owner`). It may read, change, and delete the object and its events, alarms, measurements, operations, and external ids by id, without any role. Ownership does not reach children the user does not own.
- **Inventory roles.** An inventory role assigned on an object applies to it and to everything below it, through child assets and child devices (not child additions). A permission is `READ`, `ADMIN`, or `*` on a scope (`MANAGED_OBJECT`, `MEASUREMENT`, `EVENT`, `ALARM`, `OPERATION`, `AUDIT`, or `*`). A permission with a type other than `*` covers only documents with a fragment of that name. Typed `OPERATION` permissions cover nothing, as observed on the platform. Device permissions (`SCOPE:TYPE:PERMISSION` in a user's or group's `devicePermissions`) count the same way.
- **Lists.** The inventory list and count show objects the caller owns or may read. The lists of measurements, events, alarms, and operations need the `_READ` role or any inventory role assignment, and then show the documents whose source the caller may read; ownership does not count there. The alarm count, the audit list, and the binaries list never answer 403 and show what the caller may read.

A restricted list is filtered in full before paging, so it costs more than an unrestricted one. Generated measurement history is built in full for a restricted caller that lists measurements.

## The rules

Source: **probe** means checked on a real tenant (November 2026, `docs/platform-behavior.md` and the `roles:` contract scenarios), **spec** means taken from the "Required roles" of the [OpenAPI spec](https://cumulocity.com/api/core/) without a probe. "Object rights" means: the global role, ownership of the object, or an inventory permission of that scope and level on it or a parent.

### Inventory and identity

| Endpoint                                                                                                                     | Needs                                                                                                                                             | Source |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `GET /inventory/managedObjects`, `.../count`                                                                                 | Nothing; shows owned objects and objects with `MANAGED_OBJECT` read. Microservice users need `ROLE_INVENTORY_READ` or `ROLE_MANAGED_OBJECT_READ`. | probe  |
| `POST /inventory/managedObjects`                                                                                             | `ROLE_INVENTORY_ADMIN`, `_CREATE`, `ROLE_MANAGED_OBJECT_ADMIN`, or `_CREATE`; the caller owns the result.                                         | probe  |
| `GET /inventory/managedObjects/{id}` and its `supportedSeries`, `supportedMeasurements`, `availability`, `user`, child lists | Object rights, read (`ROLE_INVENTORY_READ` or `ROLE_MANAGED_OBJECT_READ`).                                                                        | probe  |
| `PUT`, `DELETE /inventory/managedObjects/{id}`, `PUT .../user`                                                               | Object rights, admin (`ROLE_INVENTORY_ADMIN` or `ROLE_MANAGED_OBJECT_ADMIN`).                                                                     | probe  |
| `PUT /inventory/managedObjects` (bulk)                                                                                       | The global admin role.                                                                                                                            | spec   |
| `POST .../{id}/childDevices`, `childAssets`, `childAdditions`                                                                | The global admin role, or admin rights on the parent and on the child; a new child also needs a create role.                                      | probe  |
| `DELETE` a child reference                                                                                                   | Admin rights on the parent, or ownership of the child.                                                                                            | spec   |
| `GET /inventory/binaries`                                                                                                    | Nothing; `ROLE_INVENTORY_READ`, `ROLE_BINARY_READ`, or `_ADMIN` show all, else owned and readable ones.                                           | probe  |
| `POST /inventory/binaries`                                                                                                   | `ROLE_INVENTORY_ADMIN`, `_CREATE`, `ROLE_BINARY_ADMIN`, or `_CREATE`.                                                                             | spec   |
| `GET`, `PUT`, `DELETE /inventory/binaries/{id}`                                                                              | `ROLE_BINARY_READ`/`_ADMIN`, or object rights.                                                                                                    | spec   |
| `GET /identity/globalIds/{id}/externalIds`, `GET /identity/externalIds/{type}/{id}`                                          | `ROLE_IDENTITY_READ`, ownership, or a `MANAGED_OBJECT` read permission; `ROLE_INVENTORY_READ` does not count.                                     | probe  |
| `POST .../externalIds`, `DELETE /identity/externalIds/{type}/{id}`                                                           | `ROLE_IDENTITY_ADMIN`, ownership, or a `MANAGED_OBJECT` admin permission.                                                                         | probe  |
| `POST /identity/search`                                                                                                      | `ROLE_IDENTITY_READ`.                                                                                                                             | probe  |

### Measurements, events, alarms, operations, audit

| Endpoint                                                                | Needs                                                                                                                                                 | Source |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `GET` lists of measurements, events, alarms, operations                 | The `_READ` role (`ROLE_MEASUREMENT_READ`, `ROLE_EVENT_READ`, `ROLE_ALARM_READ`, `ROLE_DEVICE_CONTROL_READ`), or any inventory assignment (filtered). | probe  |
| `GET /measurement/measurements/series`                                  | Object rights on `source`, read.                                                                                                                      | probe  |
| `GET /alarm/alarms/count`                                               | Nothing; counts what the caller may read.                                                                                                             | probe  |
| `POST` a measurement, event, alarm (also upsert), operation             | Object rights on the source in the body, admin; an unknown source answers 403.                                                                        | probe  |
| `GET`, `PUT`, `DELETE` one event, alarm, operation (and event binaries) | Object rights on its source: read for `GET`, admin otherwise.                                                                                         | probe  |
| `DELETE /measurement/measurements/{id}`                                 | Object rights on its source, admin.                                                                                                                   | spec   |
| `DELETE`/`PUT` by filter (`/event/events?source=`, `PUT /alarm/alarms`) | The `_ADMIN` role.                                                                                                                                    | probe  |
| `GET /audit/auditRecords`                                               | Nothing; `ROLE_AUDIT_READ` shows all, else records whose source has an `AUDIT` read permission.                                                       | probe  |
| `GET /audit/auditRecords/{id}`                                          | `ROLE_AUDIT_READ` or an `AUDIT` read permission on its source.                                                                                        | spec   |
| `POST /audit/auditRecords`                                              | `ROLE_AUDIT_ADMIN`, `ROLE_SYSTEM`, or an `AUDIT` admin permission on the source.                                                                      | probe  |

### Bulk operations, device registration, tenant, applications, Notification 2.0

| Endpoint                                                                              | Needs                                                                                            | Source |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ |
| `/devicecontrol/bulkoperations/**`                                                    | `ROLE_BULK_OPERATION_READ` to read, `_ADMIN` to write.                                           | probe  |
| `/devicecontrol/newDeviceRequests/**`                                                 | `ROLE_DEVICE_CONTROL_READ` to read, `_ADMIN` to write; delete also `ROLE_USER_MANAGEMENT_ADMIN`. | probe  |
| `/tenant/options/**`                                                                  | `ROLE_OPTION_MANAGEMENT_READ` to read, `_ADMIN` to write.                                        | probe  |
| `GET /tenant/system/options`, `GET /tenant/currentTenant`, `GET /tenant/loginOptions` | Nothing.                                                                                         | probe  |
| `GET /tenant/system/options/{category}/{key}`                                         | `ROLE_OPTION_MANAGEMENT_ADMIN`.                                                                  | spec   |
| `/retention/retentions/**`                                                            | `ROLE_RETENTION_RULE_READ` to read, `_ADMIN` to write.                                           | probe  |
| `/notification2/**` (not `unsubscribe`)                                               | `ROLE_NOTIFICATION_2_ADMIN`.                                                                     | probe  |
| `GET /tenant/statistics`, `.../device/**`                                             | `ROLE_TENANT_STATISTICS_READ`.                                                                   | probe  |
| `GET /tenant/statistics/summary`                                                      | `ROLE_TENANT_STATISTICS_READ`, `ROLE_INVENTORY_READ`, or `ROLE_MANAGED_OBJECT_READ`.             | spec   |
| `/tenant/tenants/**`, statistics files, trusted certificates, login options           | The tenant management roles of the spec.                                                         | spec   |
| `GET /application/**`                                                                 | `ROLE_APPLICATION_MANAGEMENT_READ`.                                                              | probe  |
| Application writes, binaries, versions, `bootstrapUser`, subscriptions                | `ROLE_APPLICATION_MANAGEMENT_ADMIN` (subscriptions also the tenant management admin roles).      | probe  |
| `GET /application/applicationsByUser/{user}`                                          | `OWN_READ` for oneself, else `ROLE_USER_MANAGEMENT_READ` and `ROLE_APPLICATION_MANAGEMENT_READ`. | spec   |

### Users, groups, roles

| Endpoint                                                                                                             | Needs                                                                                        | Source |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| `GET /user/currentUser`                                                                                              | `ROLE_USER_MANAGEMENT_OWN_READ` (microservice users always).                                 | probe  |
| `PUT /user/currentUser`, `.../password`                                                                              | `ROLE_USER_MANAGEMENT_OWN_ADMIN`.                                                            | spec   |
| `GET /user/{tenant}/users`, `/groups`, `/groupByName/**`, `/user/roles/**`, `/user/inventoryroles/**`, group members | `ROLE_USER_MANAGEMENT_READ` or `_CREATE`.                                                    | probe  |
| `GET /user/{tenant}/users/{user}`                                                                                    | `ROLE_USER_MANAGEMENT_READ`, or `_CREATE` for oneself and one's subusers (not `OWN_READ`).   | probe  |
| `GET .../userByName/{user}`, a user's groups and inventory assignments                                               | `ROLE_USER_MANAGEMENT_READ`, or `_CREATE` for one's subusers (`_ADMIN` alone does not read). | probe  |
| `GET /user/{tenant}/groups/{id}`, group roles, a user's roles                                                        | `ROLE_USER_MANAGEMENT_READ`.                                                                 | probe  |
| `POST /user/{tenant}/users`, `/groups`, group members                                                                | `ROLE_USER_MANAGEMENT_ADMIN` or `_CREATE`.                                                   | probe  |
| `PUT`, `DELETE` a user, its roles and inventory assignments                                                          | `ROLE_USER_MANAGEMENT_ADMIN`, or `_CREATE` for one's subusers (not deleting oneself).        | spec   |
| Group, group role, and inventory role writes                                                                         | `ROLE_USER_MANAGEMENT_ADMIN`.                                                                | spec   |

## Not emulated

- The `ROLE_USER_MANAGEMENT_CREATE` rules on what a subuser may get ("has access to roles, groups, device permissions and applications") beyond the checks the user API already does.
- Per-application access ("current user has explicit access to the application").
- A body that is JSON but has no source in `POST /audit/auditRecords` answers 500 on the platform without the role; the fake answers 403.
