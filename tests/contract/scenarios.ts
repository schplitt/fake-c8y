/**
 * All contract scenarios, one file per API area in ./scenarios.
 * They run against the fake (tests/contract/fake.test.ts) and a real tenant
 * (tests/contract/real-tenant.test.ts, `pnpm test:contract`).
 */
import type { ContractScenario } from './helpers'
import { alarmsConformanceScenarios, alarmsScenarios } from './scenarios/alarms'
import { alarmsUpsertScenarios } from './scenarios/alarms-upsert'
import { auditScenarios } from './scenarios/audit'
import { binariesScenarios } from './scenarios/binaries'
import { deviceControlScenarios } from './scenarios/devicecontrol'
import { eventsScenarios } from './scenarios/events'
import { httpScenarios } from './scenarios/http'
import { identityScenarios } from './scenarios/identity'
import { inventoryConformanceScenarios, inventoryScenarios } from './scenarios/inventory'
import { inventoryDetailsScenarios } from './scenarios/inventory-details'
import { inventoryParityScenarios } from './scenarios/inventory-parity'
import { measurementsConformanceScenarios, measurementsScenarios } from './scenarios/measurements'
import { notificationsScenarios } from './scenarios/notifications'
import { operationsScenarios } from './scenarios/operations'
import { optionsScenarios } from './scenarios/options'
import { acceptScenarios, orderScenarios, platformConformanceScenarios, platformScenarios } from './scenarios/platform'
import { usersScenarios } from './scenarios/users'
import { retentionScenarios } from './scenarios/retention'
import { sideEffectsScenarios } from './scenarios/side-effects'
import { adminAuditScenarios } from './scenarios/admin-audit'
import { adminInventoryRoleScenarios } from './scenarios/admin-inventory-roles'
import { adminNotificationScenarios } from './scenarios/admin-notifications'
import { adminOptionScenarios } from './scenarios/admin-options'
import { adminRetentionScenarios } from './scenarios/admin-retention'
import { adminUserListScenarios } from './scenarios/admin-user-lists'
import { adminUsersScenarios } from './scenarios/admin-users'
import { applicationScenarios } from './scenarios/applications'
import { tenantAdminScenarios } from './scenarios/tenant-admin'

export type { ContractContext, ContractScenario } from './helpers'

export const scenarios: ContractScenario[] = [
  ...alarmsScenarios,
  ...binariesScenarios,
  ...deviceControlScenarios,
  ...eventsScenarios,
  ...identityScenarios,
  ...inventoryScenarios,
  ...measurementsScenarios,
  ...notificationsScenarios,
  ...operationsScenarios,
  ...optionsScenarios,
  ...platformScenarios,
  ...usersScenarios,
  ...retentionScenarios,
  ...auditScenarios,
  ...sideEffectsScenarios,
  // platform behaviors that differ from, or go beyond, the API docs
  ...inventoryConformanceScenarios,
  ...inventoryDetailsScenarios,
  ...inventoryParityScenarios,
  ...alarmsConformanceScenarios,
  ...alarmsUpsertScenarios,
  ...measurementsConformanceScenarios,
  ...platformConformanceScenarios,
  ...acceptScenarios,
  ...orderScenarios,
  ...adminUsersScenarios,
  ...applicationScenarios,
  ...tenantAdminScenarios,
  ...adminUserListScenarios,
  ...adminInventoryRoleScenarios,
  ...adminOptionScenarios,
  ...adminRetentionScenarios,
  ...adminAuditScenarios,
  ...adminNotificationScenarios,
  // cross-cutting HTTP behavior (media types, Accept, error bodies, paths, links, headers)
  ...httpScenarios,
]
