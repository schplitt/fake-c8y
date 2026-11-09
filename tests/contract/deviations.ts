import type { C8yEndpoint } from '../../src'

/**
 * Where the platform deviates from its OpenAPI spec, by the id of its row in
 * docs/platform-behavior.md. Used by tests/contract/spec.test.ts
 * (to allow the response) and tests/unit/platform-behavior.test.ts (every id
 * must be documented).
 */

/**
 * Statuses the platform answers although the spec does not document them.
 */
export const DEVIATIONS: Partial<Record<C8yEndpoint, Record<number, string>>> = {
  'GET /measurement/measurements/{id}': { 405: 'measurement-by-id-405' },
  'GET /measurement/measurements/series': { 400: 'series-validation-statuses', 422: 'series-validation-statuses' },
  'GET /measurement/measurements': { 422: 'date-parameters-lenient' },
  'POST /measurement/measurements': { 400: 'time-unparsable-400' },
  'GET /event/events': { 404: 'source-unknown', 422: 'date-parameters-lenient' },
  'GET /alarm/alarms': { 404: 'source-unknown', 422: 'date-parameters-lenient' },
  'GET /alarm/alarms/count': { 404: 'source-unknown', 422: 'with-source-without-source-422' },
  'DELETE /inventory/managedObjects/{id}/childDevices': { 500: 'delete-children-all-or-nothing' },
  'DELETE /inventory/managedObjects/{id}/childAssets': { 500: 'delete-children-all-or-nothing' },
  'DELETE /inventory/managedObjects/{id}/childAdditions': { 500: 'delete-children-all-or-nothing' },
  'POST /alarm/alarms': { 400: 'time-unparsable-400', 404: 'alarm-unknown-source-404' },
  'POST /event/events': { 400: 'time-unparsable-400' },
  'POST /identity/globalIds/{id}/externalIds': { 422: 'required-fields-422' },
  'GET /devicecontrol/operations': { 422: 'operations-status-filter-422' },
  'GET /inventory/binaries/{id}': { 404: 'binaries-unknown-404' },
  'DELETE /inventory/binaries/{id}': { 404: 'binaries-unknown-404' },
  'POST /notification2/unsubscribe': { 422: 'unsubscribe-statuses', 500: 'unsubscribe-statuses' },
  'PUT /user/{tenantId}/groups/{groupId}': { 409: 'group-name-rules' },
  'POST /user/{tenantId}/groups/{groupId}/users': { 409: 'group-member-duplicate-409' },
  'DELETE /user/{tenantId}/groups/{groupId}/users/{userId}': { 500: 'group-member-remove-lenient' },
  'POST /user/{tenantId}/groups/{groupId}/roles': { 500: 'role-reference-without-self' },
  'DELETE /user/{tenantId}/groups/{groupId}/roles/{roleId}': { 422: 'group-role-remove-statuses' },
  'POST /user/{tenantId}/users/{userId}/roles/inventory': { 409: 'inventory-assignment-rules' },
  'DELETE /user/inventoryroles/{id}': { 422: 'inventory-role-validation' },
  'POST /devicecontrol/bulkoperations': { 400: 'bulk-operation-validation', 422: 'bulk-operation-validation' },
  'GET /devicecontrol/bulkoperations/{id}': { 422: 'bulk-operation-validation' },
  'PUT /devicecontrol/bulkoperations/{id}': { 422: 'bulk-operation-validation', 500: 'bulk-operation-general-status' },
  'PUT /devicecontrol/newDeviceRequests/{requestId}': { 422: 'new-device-request-accept-pending-only', 500: 'new-device-request-accept-pending-only' },
  'DELETE /devicecontrol/operations': { 422: 'operations-delete-status-422' },
  'DELETE /alarm/alarms': { 422: 'alarms-delete-needs-filter' },
  'GET /tenant/system/options/{category}/{key}': { 404: 'system-option-unknown-404' },
  'POST /retention/retentions': { 400: 'retention-validation' },
  'GET /retention/retentions/{id}': { 422: 'retention-validation' },
  'GET /audit/auditRecords': { 422: 'date-parameters-lenient' },
  'GET /audit/auditRecords/{id}': { 404: 'audit-unknown-404' },
  'POST /identity/search': { 422: 'identity-search-422' },
  'GET /application/applications': { 404: 'applications-list-filters' },
  'PUT /application/applications/{id}': { 422: 'applications-update' },
  'GET /application/applicationsByUser/{username}': { 500: 'applications-by-lists' },
  'GET /tenant/statistics': { 422: 'statistics-invalid-date' },
  'GET /tenant/statistics/summary': { 422: 'statistics-invalid-date' },
  'GET /tenant/statistics/allTenantsSummary': { 422: 'statistics-invalid-date' },
  'GET /tenant/statistics/device/{tenantId}/daily/{date}': { 422: 'statistics-invalid-date' },
  'GET /tenant/statistics/device/{tenantId}/monthly/{date}': { 422: 'statistics-invalid-date' },
  'GET /tenant/statistics/files': { 422: 'statistics-invalid-date' },
  'GET /tenant/statistics/files/latest/{month}': { 422: 'statistics-invalid-date' },
  'GET /tenant/loginOptions': { 401: 'login-options-tenant-id' },
  'GET /tenant/loginOptions/{typeOrId}/accessMappings': { 404: 'login-option-unknown-404' },
  'GET /tenant/loginOptions/{typeOrId}/inventoryAccessMappings': { 404: 'login-option-unknown-404' },
}

/**
 * Documented statuses the platform answers with an empty body instead of the documented one.
 */
export const EMPTY_BODY_DEVIATIONS: Partial<Record<C8yEndpoint, Record<number, string>>> = {
  'GET /tenant/tenants/{tenantId}/trusted-certificates/{fingerprint}': { 404: 'trusted-certificate-unknown-404' },
}

/**
 * Schema problems the platform itself has (the spec is wrong there).
 */
export const SCHEMA_DEVIATIONS: Array<{ id: string, problem: RegExp }> = [
  { id: 'binary-fragment-empty-string', problem: /c8y_IsBinary: expected an object, got ""/ },
  { id: 'user-optional-fields', problem: /\.(owner|twoFactorAuthenticationEnabled): required$/ },
  { id: 'group-role-links', problem: /^\$\.references: expected an object, got \[/ },
  { id: 'inventory-role-validation', problem: /\.description: null is not a string$/ },
  { id: 'bulk-operation-numeric-id', problem: /^\$(\.bulkOperations\[\d+\])?\.id: expected a string, got \d+$/ },
  { id: 'bulk-operation-general-status', problem: /\.generalStatus: "EXECUTING_WITH_ERROR" is not one of / },
  { id: 'managed-object-bulk-update', problem: /^\$\.statistics\.pageSize: 1000000 is outside 1\.\.2000$/ },
  { id: 'audit-optional-fields', problem: /\.(application|c8y_Metadata|changes|severity): required$/ },
  { id: 'date-error-no-message', problem: /^\$\.message: required$/ },
  { id: 'application-optional-fields', problem: /\.(activeVersionId|resourcesUrl): required$|\.references\[\d+\]\.id: required$|\.dynamicOptionsUrl: expected a string, got true$/ },
  { id: 'login-option-views', problem: /^\$(\.loginOptions\[\d+\])?\.(greenMinLength: null is not a integer|providerName: required)$/ },
]
