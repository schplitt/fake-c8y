# Applications

The fake emulates `/application/applications/**`, the `applicationsByName`, `ByOwner`, `ByTenant`, and `ByUser` lists, `/application/currentApplication/**`, and the own tenant's subscriptions (`POST` and `DELETE /tenant/tenants/{tenantId}/applications`), like on an eu-latest tenant. The verified details are in [platform-behavior.md, "Applications"](platform-behavior.md#applications).

## Default applications

Every tenant starts with the standard applications of the platform, owned by `management` and subscribed (`DEFAULT_APPLICATIONS`, taken from an eu-latest tenant): administration, cockpit, devicemanagement, Streaming Analytics, feature-microservice-hosting, and the microservices smartrule, apama-ctrl-mt, device-simulator, cloud-remote-access, lwm2m-agent, actility, sms-gateway, opcua-mgmt-service, report-agent, and advanced-software-mgmt. Their roles are in the role catalogue.

A request to one of these microservices (`/service/smartrule/**`) is not emulated (501, kind `'outside-spec'`, the trial is invalid) unless you register it with [`world.service()`](services.md). A microservice the tenant does not have answers 404 `microservice/Not Found`.

## Seeding

```ts
const { applications: [myApp] } = world.seed({
  defaultApplications: false, // remove the defaults first
  applications: [{ name: 'my-app', type: 'HOSTED', contextPath: 'my-app' }],
})
world.db.applications.find() // [{ id: myApp, name: 'my-app', subscribed: true, ... }]
```

- `applications` adds or replaces applications, by `id`, else by name and owner. `seed()` returns their ids in input order; a replacement keeps the replaced application's id. `owner` defaults to the seeded tenant, `key` to `<name>-key`, and `availability` to `MARKET` for `management`, else `PRIVATE`.
- `subscribed` defaults to `true`. A subscribed microservice gets its service user and roles.
- `defaultApplications: false` removes the default applications and the subscriptions to them.
- `world.db.applications` lists what the tenant owns or is subscribed to, each with `subscribed`.

To emulate a microservice that answers requests, use [`world.service()`](services.md) instead.

## Created through the API

A MICROSERVICE created with `POST /application/applications` has no binary. Like on the platform, it keeps its top-level `requiredRoles` and `roles` but not the request's manifest. A `PUT` ignores a manifest too, and a top-level `settingsCategory` does not change where the settings come from. Subscribing creates its service user and roles, and `/service/<contextPath>/**` answers 404 because it does not run.

## Not emulated

- Versions, binaries, `clone`, `authType`, and restricted roles answer 501. They need uploads, and agents rarely use them.
- `GET /tenant/tenants/{tenantId}/applications` answers 403, like on a tenant that is not the management tenant.

## Snapshots and diffs

A tenant snapshot has `applications` and `applicationSubscriptions`, and `diff()` lists both per tenant.
