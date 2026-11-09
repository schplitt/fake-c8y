import type { ContractScenario } from '../helpers'
import { cleanup, runChecks } from '../admin-checks'
import type { Check } from '../admin-checks'

// Requests read from a real tenant (see admin-checks.ts). Every name starts
// with the scenario's prefix and is deleted afterwards.

function scenario(name: string, checks: Check[], verifies: string[] = []): ContractScenario {
  return {
    name,
    verifies,
    async run({ client, tenant, unique }) {
      const prefix = `r1108admin${unique}`
      try {
        await runChecks(client, tenant, prefix, checks)
      } finally {
        await cleanup(client, tenant, prefix)
      }
    },
  }
}

export const adminAuditScenarios: ContractScenario[] = [
  scenario('admin audit records: create, filters, order', [
    { m: 'POST', p: '/inventory/managedObjects', b: { name: '{{u}}Amo', type: '{{u}}At' }, keep: 'mo', status: 201, match: { type: '{{u}}At', name: '{{u}}Amo', owner: '{{me}}' } },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: '2026-01-01T10:01:00.000Z', text: 'one', source: { id: '{{mo}}' }, activity: 'act1', severity: 'information' }, keep: 'r1', status: 201, match: { type: '{{u}}A', text: 'one', user: '{{me}}', activity: 'act1', severity: 'information' } },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: '2026-01-01T10:02:00.000Z', text: 'two', source: { id: '{{mo}}' }, activity: 'act2', severity: 'MAJOR', application: '{{u}}Aapp', user: '{{u}}Auser' }, keep: 'r2', status: 201, match: { type: '{{u}}A', text: 'two', user: '{{u}}Auser', application: '{{u}}Aapp', activity: 'act2', severity: 'MAJOR' } },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}Ab', time: '2026-01-01T10:03:00.000Z', text: 'three', source: { id: '{{mo}}' }, activity: 'act3', changes: [{ attribute: 'a', type: 'java.lang.String', previousValue: 'x', newValue: 'y', changeType: 'REPLACED' }], c8y_Custom: { a: 1 } }, keep: 'r3', status: 201, match: { type: '{{u}}Ab', text: 'three', user: '{{me}}', activity: 'act3' } },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: '2026-01-01T10:03:00.000Z', text: 'nosource', activity: 'act' }, keep: 'r4', status: 201, match: { type: '{{u}}A', text: 'nosource', user: '{{me}}', activity: 'act' } },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: '2026-01-01T10:04:00.000Z', source: { id: '{{mo}}' }, activity: 'a' }, status: 422, error: 'undefined/validationError', message: 'text is required' },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: '2026-01-01T10:04:00.000Z', text: 'x', source: { id: '{{mo}}' } }, status: 422, error: 'undefined/validationError', message: 'activity is required' },
    { m: 'POST', p: '/audit/auditRecords', b: { time: '2026-01-01T10:04:00.000Z', text: 'x', source: { id: '{{mo}}' }, activity: 'a' }, status: 422, error: 'undefined/validationError', message: 'type is required' },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', text: 'notime', source: { id: '{{mo}}' }, activity: 'a' }, keep: 'r5', status: 422, error: 'undefined/validationError', message: 'time is required' },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: 'bad', text: 'x', source: { id: '{{mo}}' }, activity: 'a' }, status: 400, error: 'Failed to parse JSON string', message: 'Invalid format: "bad" (through reference chain: com.cumulocity.rest.representation.audit.AuditRecordRepresentation["time"]) : Invalid format: "bad"' },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: '2026-01-01T10:04:00.000Z', text: 'x', source: { id: '999999999' }, activity: 'a' }, status: 201, match: { type: '{{u}}A', text: 'x', user: '{{me}}', activity: 'a' } },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: '2026-01-01T10:04:00.000Z', text: 'x', source: '{{mo}}', activity: 'a' }, status: 400, error: 'Failed to parse JSON string' },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: '2026-01-01T10:04:00.000Z', text: 'x', source: { id: '{{mo}}' }, activity: 'a', severity: 'nope' }, status: 201, match: { type: '{{u}}A', text: 'x', user: '{{me}}', activity: 'a', severity: 'nope' } },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: '2026-01-01T10:04:00.000Z', text: 'x', source: { id: '{{mo}}' }, activity: 'a', id: '5' }, status: 422, error: 'undefined/validationError', message: 'id is not allowed here' },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '', time: '2026-01-01T10:04:00.000Z', text: 'x', source: { id: '{{mo}}' }, activity: 'a' }, status: 201, match: { type: '', text: 'x', user: '{{me}}', activity: 'a' } },
    { m: 'POST', p: '/audit/auditRecords', b: { type: '{{u}}A', time: '2026-01-01T10:04:00.000Z', text: '', source: { id: '{{mo}}' }, activity: '' }, status: 201, match: { type: '{{u}}A', text: '', user: '{{me}}', activity: '' } },
    { m: 'POST', p: '/audit/auditRecords', raw: '[]', status: 400, error: 'Failed to parse JSON string' },
    { m: 'POST', p: '/audit/auditRecords', raw: '', status: 400, error: 'Failed to parse JSON string' },
    { m: 'GET', p: '/audit/auditRecords/{{r1}}', status: 200, match: { type: '{{u}}A', text: 'one', user: '{{me}}', activity: 'act1', severity: 'information' } },
    { m: 'GET', p: '/audit/auditRecords/{{r2}}', status: 200, match: { type: '{{u}}A', text: 'two', user: '{{u}}Auser', application: '{{u}}Aapp', activity: 'act2', severity: 'MAJOR' } },
    { m: 'GET', p: '/audit/auditRecords/{{r3}}', status: 200, match: { type: '{{u}}Ab', text: 'three', user: '{{me}}', activity: 'act3' } },
    { m: 'GET', p: '/audit/auditRecords/{{r4}}', status: 200, match: { type: '{{u}}A', text: 'nosource', user: '{{me}}', activity: 'act' } },
    { m: 'GET', p: '/audit/auditRecords/999999999', status: 404, error: 'audit/Not Found', message: 'Can\'t find audit record with given id ID [type=com_cumulocity_model_idtype_GId, value=999999999]' },
    { m: 'GET', p: '/audit/auditRecords/abc', status: 404, error: 'audit/Not Found', message: 'Can\'t find audit record with given id ID [type=com_cumulocity_model_idtype_GId, value=abc]' },
    { m: 'GET', p: '/audit/auditRecords/{{r1}}?x=1', status: 200, match: { type: '{{u}}A', text: 'one', user: '{{me}}', activity: 'act1', severity: 'information' } },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&pageSize=100', status: 200, count: 6 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&pageSize=100&revert=true', status: 200, count: 6 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&pageSize=100&revert=false', status: 200, count: 6 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&dateFrom=2026-01-01T10:02:00.000Z&pageSize=100', status: 200, count: 5 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&dateFrom=2026-01-01T10:02:00.000Z&pageSize=100&revert=true', status: 200, count: 5 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&dateTo=2026-01-01T10:02:00.000Z&pageSize=100', status: 200, count: 1 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&dateFrom=2026-01-01T10:01:00.000Z&dateTo=2026-01-01T10:03:00.000Z&pageSize=100', status: 200, count: 2 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&dateFrom=2026-01-01T10:03:00.000Z&dateTo=2026-01-01T10:01:00.000Z', status: 200, count: 0 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&dateFrom=bad', status: 422, error: 'bad is not a valid date./Invalid Data' },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}Ab', status: 200, count: 1 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}a', status: 200, count: 0 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A,{{u}}Ab', status: 200, count: 0 },
    { m: 'GET', p: '/audit/auditRecords?source={{mo}}&pageSize=100', status: 200, count: 6 },
    { m: 'GET', p: '/audit/auditRecords?source={{mo}}&type={{u}}Ab', status: 200, count: 1 },
    { m: 'GET', p: '/audit/auditRecords?user={{u}}Auser', status: 200, count: 1 },
    { m: 'GET', p: '/audit/auditRecords?application={{u}}Aapp', status: 200, count: 1 },
    { m: 'GET', p: '/audit/auditRecords?application={{u}}Aapp&user=nobody', status: 200, count: 0 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&pageSize=2&currentPage=2&withTotalElements=true&withTotalPages=true', status: 200, count: 2 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&pageSize=x', status: 422, error: 'REST API/Unprocessable Entity', message: 'Parameter \'pageSize\' must have an integer value!' },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&pageSize=0', status: 200, count: 1 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&currentPage=0', status: 200, count: 5 },
    { m: 'GET', p: '/audit/auditRecords?type={{u}}A&revert=x', status: 200, count: 5 },
    { m: 'PUT', p: '/audit/auditRecords/{{r1}}', b: { text: 'changed' }, status: 405, empty: true },
    { m: 'DELETE', p: '/audit/auditRecords/{{r1}}', status: 405, empty: true },
    { m: 'DELETE', p: '/audit/auditRecords?type={{u}}A', status: 405, empty: true },
    { m: 'DELETE', p: '/inventory/managedObjects/{{mo}}?forceCascade=true', status: 204, empty: true },
    { m: 'GET', p: '/audit/auditRecords/{{r1}}', status: 200, match: { type: '{{u}}A', text: 'one', user: '{{me}}', activity: 'act1', severity: 'information' } },
  ], ['audit-create', 'date-error-no-message']),
]
