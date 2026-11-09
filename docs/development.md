# Development

```sh
pnpm install
pnpm lint:fix          # lint and fix
pnpm typecheck         # src, tests, and scripts
pnpm test:run          # unit tests, contract scenarios against the fake, the OpenAPI spec check, the iso4 check
pnpm build             # tsdown, platform neutral, .mjs
pnpm gen:capabilities  # regenerate src/capabilities.generated.ts from the live OpenAPI spec, then run pnpm lint:fix
```

Before a commit, run `pnpm lint:fix && pnpm typecheck && pnpm test:run && pnpm build`. Use `pnpm test:run`, not `pnpm test`, which starts watch mode.

## The real-tenant contract run

> [!WARNING]
> `pnpm test:contract` runs the contract scenarios against a **real Cumulocity tenant**, not the fake. It reads the tenant only from `C8Y_CONTRACT_BASEURL`, `C8Y_CONTRACT_TENANT`, `C8Y_CONTRACT_USER`, and `C8Y_CONTRACT_PASSWORD`, set in the environment or in a local `.env` (copy `.env.example`). It creates data on that tenant and deletes it afterwards; audit records stay. Use a tenant meant for it. In CI the contract workflow runs only when started by hand.

`pnpm test:run` covers the fake and never touches a tenant. It runs the same scenarios against a plain world and against a fork.

Every row in <platform-behavior.md> names a behavior a scenario verifies, and a test keeps the two in sync. A new or changed platform behavior needs a scenario in `tests/contract/scenarios/` and, if it differs from the API docs, a row there.

## Benchmarks

Not part of `pnpm test:run`:

- `node --expose-gc scripts/bench-fork.ts [fixtures dir]`: forks against snapshot and restore at eval-world size.
- `node --expose-gc scripts/bench-scale.ts [devices...]`: request latencies at 10k and 100k devices.
- `node --expose-gc scripts/bench-generated.ts`: generated measurements at 5 minute and 1 minute intervals.
