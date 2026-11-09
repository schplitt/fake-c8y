/**
 * Times are read like the platform reads them, never in the host's time
 * zone: a time without a zone and a bare date are UTC, an offset counts.
 */
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'
import { parseIsoTime } from '../../src/utils'

async function send(world: World, method: string, path: string, body?: unknown) {
  const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: { 'accept': 'application/json', 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }))
  return { status: response.status, body: await response.json() }
}

describe.each(['UTC', 'Europe/Berlin', 'America/New_York'])('in time zone %s', (zone) => {
  let previous: string | undefined
  beforeEach(() => {
    previous = process.env.TZ
    process.env.TZ = zone
  })
  afterEach(() => {
    process.env.TZ = previous
  })

  it('stores, filters, and aggregates times the same', async () => {
    const world = createWorld()
    const device = world.device()
    const source = { id: device }
    const sent = ['2026-05-01T10:00:00Z', '2026-05-01T10:00:00.000+01:00', '2026-05-01T10:00:00', '2026-05-01']
    const stored = []
    for (const [index, time] of sent.entries()) {
      stored.push((await send(world, 'POST', '/event/events', { source, type: `t${index}`, text: 't', time })).body.time)
      await send(world, 'POST', '/measurement/measurements', { source, type: 'm', time, m: { v: { value: index } } })
    }
    expect(stored).toEqual(['2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000+01:00', '2026-05-01T10:00:00.000Z', '2026-05-01T00:00:00.000Z'])
    const types = async (from: string, to: string) => (await send(world, 'GET', `/event/events?source=${device}&dateFrom=${from}&dateTo=${to}`)).body.events.map((event: { type: string }) => event.type).sort()
    expect(await types('2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.999Z')).toEqual(['t0', 't2'])
    expect(await types('2026-05-01T09:00:00.000Z', '2026-05-01T09:00:00.999Z')).toEqual(['t1'])
    const series = await send(world, 'GET', `/measurement/measurements/series?source=${device}&series=m.v&dateFrom=2026-04-30T00:00:00Z&dateTo=2026-05-02T00:00:00Z&aggregationInterval=1h`)
    expect(Object.keys(series.body.values)).toEqual(['2026-05-01T00:00:00.000Z', '2026-05-01T09:00:00.000Z', '2026-05-01T10:00:00.000Z'])
  })

  it('answers a time that is no ISO time with 400', async () => {
    const world = createWorld()
    const answer = await send(world, 'POST', '/event/events', { source: { id: world.device() }, type: 't', text: 't', time: '2026-05-01 10:00' })
    expect(answer.status).toBe(400)
    expect(answer.body).toMatchObject({ error: 'Failed to parse JSON string', message: 'Invalid format: "2026-05-01 10:00" is malformed at " 10:00" (through reference chain: com.cumulocity.rest.representation.event.EventRepresentation["time"]) : Invalid format: "2026-05-01 10:00" is malformed at " 10:00"' })
  })
})

describe('parseIsoTime()', () => {
  it('reads the stored form like the general form', () => {
    // the stored form takes a shortcut; the same time with an offset takes the regular expression
    for (const value of ['2026-11-07T19:00:00.123Z', '2024-02-29T23:59:59.999Z', '2100-02-28T00:00:00.000Z', '2000-02-29T12:00:00.000Z', '0100-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
      expect(parseIsoTime(value), value).toBe(parseIsoTime(`${value.slice(0, -1)}+00:00`))
      expect(parseIsoTime(value), value).toBe(Date.parse(value))
    }
    for (const value of ['2026-02-29T00:00:00.000Z', '2100-02-29T00:00:00.000Z', '2026-04-31T00:00:00.000Z', '2026-01-01T24:00:00.000Z', '2026-01-01T00:60:00.000Z', '2026-01-01T00:00:60.000Z', '2026-13-01T00:00:00.000Z', '2026-00-01T00:00:00.000Z', '2026-01-00T00:00:00.000Z', '2026-01-01T00:00:00.0x0Z']) {
      expect(parseIsoTime(value), value).toBeNaN()
    }
    // years below 100 are not 19xx
    expect(parseIsoTime('0050-01-01T00:00:00.000Z')).toBe(parseIsoTime('0050-01-01T00:00:00.000+00:00'))
    expect(new Date(parseIsoTime('0050-01-01T00:00:00.000Z')).getUTCFullYear()).toBe(50)
  })
})
