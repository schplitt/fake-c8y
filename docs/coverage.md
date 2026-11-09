# The coverage gate

A request the world does not emulate gets a made-up 501, an answer the platform never gives. A trial that got one is not a faithful run: the agent reacted to an invented response. `world.coverage()` tells a harness whether to grade the trial:

```ts
const trial = base.fork({ unsupported: 'platform' })
await runAgent(trial, question)

const { valid, unhandled, platformErrors } = trial.coverage()
if (valid) {
  grade(trial.diff())
} else {
  reportNotFaithful(question, unhandled.map((request) => `${request.kind}: ${request.method} ${request.path}`))
}
```

| Field            | What It Is                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valid`          | `false` as soon as one request since the last reset was unhandled.                                                                                            |
| `unhandled`      | The requests the world could not answer (`world.unhandled`), each with a `reason` and a `kind`, see below.                                                    |
| `platformErrors` | Requests answered 404 (unknown path, unknown microservice) or 405 (wrong method), like the platform. They are the client's mistakes and keep the trial valid. |

The `kind` of an unhandled request:

- `'endpoint'`: a platform endpoint (in the OpenAPI spec) that the fake does not emulate.
- `'feature'`: an emulated endpoint, but a query parameter or request variant is not emulated. Override handlers and services report this kind with `UnsupportedRequestError` and `ctx.unsupported()`.
- `'outside-spec'`: a path outside the core API and outside `/service/**`, or a default microservice (such as `smartrule`) without a registered service. The platform answers it somehow; the fake cannot know how.
- `'error'`: the fake, an override, or a service handler threw. The world answered 500.

## The 501 answer

The `unsupported` option of `createWorld()` and `fork()` sets the answer:

- `'developer'` (default): a 501 that names the request and the reason, with a hint to answer it with `world.override()`.
- `'platform'`: a neutral 501 without hints, for clients that must not notice the fake, such as an agent under evaluation.
- a function `(request, world) => Response`: your own answer.

In every case the request is recorded in `world.unhandled` and passed to `onUnsupported`.

Report invalid trials apart from passes and failures, and count them per endpoint: they show where the emulation needs to grow.
