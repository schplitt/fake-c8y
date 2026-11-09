// Runs the contract scenarios against a plain fake world.
import { contractSuite } from './contract-suite'
import { fakePlatform } from './fake-platform'

contractSuite('contract scenarios against the fake tenant', fakePlatform())
