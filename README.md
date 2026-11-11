# fake-c8y

An in-memory Cumulocity platform for tests and evals. It answers the platform's REST API from memory: inventory (with the query language), identity, measurements (with series), events, alarms, operations, bulk operations, new device requests, binaries, tenant options, retention rules, audit records, users and roles, applications, tenant statistics, and Notification 2.0. It runs in any JavaScript runtime with `fetch`: Node, workers, and [iso4](https://github.com/schplitt/iso4) isolates. It has no dependencies and uses no Node APIs. A contract suite checks the emulated behavior against a real tenant.

## Install

```sh
pnpm add -D fake-c8y
```

## Quick start

```ts
import { createWorld } from 'fake-c8y'

const world = createWorld()
const pump = world.device({ name: 'Pump', externalIds: { c8y_Serial: 'SN-1' } })
const { alarms: [overheat] } = world.seed({ alarms: [{ source: pump, type: 'overheat' }] })

const response = await world.fetch(new Request(`${world.baseUrl}/alarm/alarms/${overheat}`))
const alarm = await response.json()
```

`device()`, `managedObject()`, and `binary()` return the id of what they create, since other data points to it. `seed()` creates everything else and returns the ids per list, in input order ([seeding](https://github.com/schplitt/fake-c8y/blob/main/docs/world.md#seeding)).

`world.fetch()` takes a `Request` to the platform and returns a `Response`. Pass it as the `fetch` of your HTTP client to route the client's requests to the world.

## Guides

- [The world](https://github.com/schplitt/fake-c8y/blob/main/docs/world.md): `createWorld()` options, seeding, requests, overrides, and reading the data.
- [Trials](https://github.com/schplitt/fake-c8y/blob/main/docs/trials.md): forks, reset, snapshots, diffs, and the trial clock.
- [The coverage gate](https://github.com/schplitt/fake-c8y/blob/main/docs/coverage.md): telling a faithful trial from one that hit a request the fake does not emulate.
- [Services](https://github.com/schplitt/fake-c8y/blob/main/docs/services.md): emulating the tenant's own microservices with `defineService()` and `world.service()`.
- [Roles](https://github.com/schplitt/fake-c8y/blob/main/docs/roles.md): checking requests against the caller's roles, ownership, and inventory roles, on by default (`roles: 'off'` gives full access).
- [Applications](https://github.com/schplitt/fake-c8y/blob/main/docs/applications.md): the default applications and the application API.
- [Generated measurements](https://github.com/schplitt/fake-c8y/blob/main/docs/generated-measurements.md): measurement history computed on read.
- [Emulated API](https://github.com/schplitt/fake-c8y/blob/main/docs/emulated-api.md): what the fake emulates, and where it simplifies.
- [Development](https://github.com/schplitt/fake-c8y/blob/main/docs/development.md): tests, the real-tenant contract run, and regenerating from the OpenAPI spec.

Reference:

- [Platform behavior](https://github.com/schplitt/fake-c8y/blob/main/docs/platform-behavior.md): every verified place where the platform differs from its API docs.

## License

MIT
