import { fileURLToPath } from 'node:url'
import { createSandbox } from '@iso4/sandbox'
import { rolldown } from 'rolldown'
import { afterAll, beforeAll, expect, it } from 'vitest'

// The engine must run in a V8 isolate without Node APIs. Bundle a scenario
// with the engine, run it in a fresh iso4 isolate, and check its results.
let sandbox: Awaited<ReturnType<typeof createSandbox>>
let code: string

beforeAll(async () => {
  const bundle = await rolldown({ input: fileURLToPath(new URL('./scenario.ts', import.meta.url)), platform: 'neutral' })
  const { output } = await bundle.generate({ format: 'esm', codeSplitting: false })
  code = output[0].code
  sandbox = await createSandbox({ memoryMb: 128 })
})

afterAll(async () => {
  await sandbox?.dispose()
})

it('the bundle imports nothing', () => {
  expect(code).not.toMatch(/^import\s/m)
})

it('answers platform requests inside an isolate', async () => {
  const result = await sandbox.run({ code, call: { export: 'default' }, limits: { wallTimeMs: 10_000 } })
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}\n${result.error.stack ?? ''}`)
  }
  expect(result.value).toMatchObject({
    created: { status: 201, body: { type: 'overheat', severity: 'MAJOR', status: 'ACTIVE' } },
    totalElements: 1,
    identity: true,
    optionValue: '66616b652d6369706865723a736563726574',
    upload: { status: 201, length: 15 },
    downloaded: 'hello from iso4',
    unsupported: 501,
    unhandled: ['subscription api "eventsWithChildren" is not emulated'],
    diff: { alarms: 1, managedObjects: 1, deletedMeasurementRanges: 0 },
    generated: { total: 25, times: ['2026-01-01T00:00:00.000Z', '2025-12-31T23:00:00.000Z'], deleted: [6] },
    options: [{ tenant: 't12345', category: 'service', key: 'credentials.key', before: undefined, after: 'secret' }],
    fork: { status: 200, baseName: 'Pump', updated: ['Forked pump'] },
  })
  expect(Object.keys(result.value as object)).toContain('series')
})
