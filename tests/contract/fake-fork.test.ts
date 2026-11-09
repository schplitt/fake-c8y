// Runs the contract scenarios against a fork of a frozen base world that has
// data of its own (tests/contract/fork-base.ts): every request goes through
// the copy-on-write overlay, and the base must stay unchanged.
import { afterAll, expect } from 'vitest'
import { contractSuite } from './contract-suite'
import { fakePlatform } from './fake-platform'

const platform = fakePlatform({ fork: true })
const before = platform.base!.snapshot()

contractSuite('contract scenarios against a fork of the fake tenant', platform)

afterAll(() => {
  expect(platform.base!.snapshot()).toEqual(before)
})
