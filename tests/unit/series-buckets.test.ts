/**
 * Series buckets of days and weeks start where the platform's do (verified):
 * `1d` at UTC midnight, `1w` on Sundays, `7d` on Saturdays.
 */
import { expect, it } from 'vitest'
import { createWorld } from '../../src'

it('starts day and week buckets like the platform', async () => {
  const world = createWorld()
  const device = world.device()
  world.seed({ measurements: Array.from({ length: 14 }, (_, day) => ({ source: device, type: 'wk', time: new Date(Date.UTC(2026, 3, 20 + day, 12, 34, 56)).toISOString(), wk: { v: { value: day + 1, unit: 'u' } } })) })
  const keys = async (interval: string) => {
    const response = await world.fetch(new Request(`${world.baseUrl}/measurement/measurements/series?source=${device}&series=wk.v&dateFrom=2026-04-19T00:00:00Z&dateTo=2026-05-04T00:00:00Z&aggregationInterval=${interval}`))
    const values = (await response.json()).values as Record<string, Array<{ min: number, max: number }>>
    return Object.entries(values).map(([key, [value]]) => [key, value!.min, value!.max])
  }
  expect(await keys('1w')).toEqual([['2026-04-19T00:00:00.000Z', 1, 6], ['2026-04-26T00:00:00.000Z', 7, 13], ['2026-05-03T00:00:00.000Z', 14, 14]])
  expect(await keys('7d')).toEqual([['2026-04-18T00:00:00.000Z', 1, 5], ['2026-04-25T00:00:00.000Z', 6, 12], ['2026-05-02T00:00:00.000Z', 13, 14]])
  expect((await keys('1d'))[0]).toEqual(['2026-04-20T00:00:00.000Z', 1, 1])
})
