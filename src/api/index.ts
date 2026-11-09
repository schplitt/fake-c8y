import type { C8yRequest } from '../types'
import type { TenantData } from '../store'
import { documents, RESOURCES } from './data'
import { identity } from './identity'
import { eventBinaries, inventoryBinaries } from './binaries'
import { inventory } from './inventory'
import { notifications } from './notifications'
import { users } from './users'
import { bulkOperations } from './bulkoperations'
import { newDeviceRequests } from './registration'
import { tenantApi } from './tenant'
import { retention } from './retention'
import { audit } from './audit'
import { applicationApi, tenantApplications } from './applications'

export { UnsupportedRequestError } from './http'

/**
 * Answers a request from the emulated platform APIs (inventory, identity,
 * measurements, events, alarms, operations, bulk operations, new device
 * requests, tenant, retention rules, audit, users).
 * @param call - The request
 * @param segments - Decoded path segments
 * @param data - Data of the request's tenant
 * @returns The response, or `undefined` if the endpoint is not emulated
 * (synchronous: a request reads and writes the tenant data in one go, so
 * neither a `reset()` nor another request can come in between)
 */
export function platformApi(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [domain, resource] = segments
  if (domain === 'inventory' && resource === 'binaries') {
    return inventoryBinaries(call, segments, data)
  }
  if (domain === 'event' && resource === 'events' && segments[3] === 'binaries' && segments.length === 4) {
    return eventBinaries(call, segments[2]!, data)
  }
  if (domain === 'inventory' && resource === 'managedObjects') {
    return inventory(call, segments, data)
  }
  if (domain === 'identity') {
    return identity(call, segments, data)
  }
  if (domain === 'measurement' && resource === 'measurements') {
    return documents(call, segments, data, RESOURCES.measurement)
  }
  if (domain === 'event' && resource === 'events') {
    return documents(call, segments, data, RESOURCES.event)
  }
  if (domain === 'alarm' && resource === 'alarms') {
    return documents(call, segments, data, RESOURCES.alarm)
  }
  if (domain === 'notification2') {
    return notifications(call, segments, data)
  }
  if (domain === 'user') {
    return users(call, segments, data)
  }
  if (domain === 'devicecontrol' && resource === 'operations') {
    return documents(call, segments, data, RESOURCES.devicecontrol)
  }
  if (domain === 'devicecontrol' && resource === 'bulkoperations') {
    return bulkOperations(call, segments, data)
  }
  if (domain === 'devicecontrol' && resource === 'newDeviceRequests') {
    return newDeviceRequests(call, segments, data)
  }
  if (domain === 'application' && resource !== 'currentApplication') {
    return applicationApi(call, segments, data)
  }
  // the restricted roles are tenant administration (tenantApi)
  if (domain === 'tenant' && resource === 'tenants' && segments[3] === 'applications' && segments[4] !== 'restricted-roles') {
    return tenantApplications(call, segments, data)
  }
  if (domain === 'tenant') {
    return tenantApi(call, segments, data)
  }
  if (domain === 'retention' && resource === 'retentions') {
    return retention(call, segments, data)
  }
  if (domain === 'audit' && resource === 'auditRecords') {
    return audit(call, segments, data)
  }
  return undefined
}
