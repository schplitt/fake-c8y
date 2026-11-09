/**
 * Id formats: scattered like the platform (default), or sequential.
 */
import { expect, it } from 'vitest'
import { createWorld } from '../../src'

it('hands out platform-like ids by default, the same in every fork', () => {
  const base = createWorld()
  const pump = base.device({ name: 'Pump' })
  base.seed({
    events: [{ source: pump, type: 't', text: 'e', time: '2026-01-01T00:00:00Z' }],
    measurements: [{ source: pump, type: 't', time: '2026-01-01T00:00:00Z', c8y_T: { T: { value: 1, unit: 'C' } } }],
  })
  expect(pump).toMatch(/^[1-9]\d{7}$/)
  expect(base.db.events.find()[0]!.id).toMatch(/^1\d{5}$/)
  expect(base.db.measurements.find()[0]!.id).toMatch(/^[0-9a-f]{24}$/)

  const [a, b] = [base.fork(), base.fork()]
  const created = [a!, b!].map((fork) => [1, 2, 3].map((n) => fork.managedObject({ name: `mo ${n}` })))
  expect(created[0]).toEqual(created[1])
  // scattered: ascending ids are not creation order
  const ids = created[0]!
  expect([...ids].sort()).not.toEqual(ids)
  // inventory lists keep creation order
  expect(a!.db.managedObjects.find((mo) => /^mo /.test(mo.name)).map((mo) => mo.id)).toEqual(ids)
})

it('hands out sequential ids on request', () => {
  const world = createWorld({ ids: 'sequential' })
  expect([world.device(), world.managedObject()]).toEqual(['1', '2'])
})
