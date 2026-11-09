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

export const adminRetentionScenarios: ContractScenario[] = [
  scenario('admin retention rules: maximum age, data types, updates', [
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}T', maximumAge: 3650 }, keep: 'e1', status: 201, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}T', source: '*', maximumAge: 3650, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'MEASUREMENT', type: '{{u}}T', fragmentType: '{{u}}Tf', source: '12345', maximumAge: 3650 }, keep: 'm1', status: 201, match: { dataType: 'MEASUREMENT', fragmentType: '{{u}}Tf', type: '{{u}}T', source: '12345', maximumAge: 3650, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'ALARM', type: '{{u}}T', maximumAge: 3650 }, keep: 'a1', status: 201, match: { dataType: 'ALARM', fragmentType: '*', type: '{{u}}T', source: '*', maximumAge: 3650, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'ALARM', type: '{{u}}T', fragmentType: 'x', maximumAge: 3650 }, status: 422, error: 'retention/Invalid Data', message: 'Failed to add retention rule : Properties [FRAGMENT_TYPE] can\'t be used in ALARM api.' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'AUDIT', type: '{{u}}T', maximumAge: 3650 }, keep: 'au1', status: 201, match: { dataType: 'AUDIT', fragmentType: '*', type: '{{u}}T', source: '*', maximumAge: 3650, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'OPERATION', fragmentType: '{{u}}Tf', maximumAge: 3650 }, keep: 'o1', status: 201, match: { dataType: 'OPERATION', fragmentType: '{{u}}Tf', type: '*', source: '*', maximumAge: 3650, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'OPERATION', fragmentType: '{{u}}Tf', type: 'x', maximumAge: 3650 }, status: 422, error: 'retention/Invalid Data', message: 'Failed to add retention rule : Properties [TYPE] can\'t be used in OPERATION api.' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'BULK_OPERATION', type: '{{u}}T', maximumAge: 3650 }, status: 422, error: 'retention/Invalid Data', message: 'Failed to add retention rule : Properties [TYPE] can\'t be used in BULK_OPERATION api.' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'event', type: '{{u}}T', maximumAge: 3650 }, status: 422, error: 'undefined/validationError', message: 'Invalid data, correct values:[ALARM, AUDIT, EVENT, MEASUREMENT, OPERATION, *] : No enum constant com.cumulocity.model.retention.RetentionDataType.event' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: '*', type: '{{u}}T', fragmentType: '{{u}}Tf', maximumAge: 3650 }, status: 422, error: 'retention/Invalid Data', message: 'Failed to add retention rule : Properties [FRAGMENT_TYPE] can\'t be used in ALARM api.' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: '*', type: '{{u}}T', maximumAge: 3650 }, status: 422, error: 'retention/Invalid Data', message: 'Failed to add retention rule : Properties [TYPE] can\'t be used in OPERATION api.' },
    { m: 'POST', p: '/retention/retentions', b: { type: '{{u}}Tnodt', fragmentType: '{{u}}Tnodt', maximumAge: 3650 }, status: 422, error: 'retention/Invalid Data', message: 'Failed to add retention rule : Properties [FRAGMENT_TYPE] can\'t be used in ALARM api.' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}T' }, status: 422, error: 'undefined/validationError', message: 'maximumAge is required' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}T', maximumAge: null }, status: 422, error: 'undefined/validationError', message: 'maximumAge is required' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}Tneg', maximumAge: -1 }, keep: 'neg', status: 201, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Tneg', source: '*', maximumAge: -1, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}Tzero', maximumAge: 0 }, keep: 'zero', status: 201, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Tzero', source: '*', maximumAge: 0, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}Tfrac', maximumAge: 3649.7 }, keep: 'frac', status: 201, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Tfrac', source: '*', maximumAge: 3649, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}Tstr', maximumAge: '3650' }, keep: 'str', status: 201, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Tstr', source: '*', maximumAge: 3650, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}T', maximumAge: 'abc' }, status: 400, error: 'Failed to parse JSON string' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}Tbig', maximumAge: 99999999999 }, keep: 'big', status: 422, error: 'undefined/validationError', message: 'Maximum age cannot be bigger than 10 years.' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}T', maximumAge: 3650, id: 5 }, status: 422, error: 'undefined/validationError', message: 'id is not allowed here' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}Ted', maximumAge: 3650, editable: false }, keep: 'ed', status: 201, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Ted', source: '*', maximumAge: 3650, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}Tnum', source: 5, maximumAge: 3650 }, keep: 'num', status: 201, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Tnum', source: '5', maximumAge: 3650, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}Tx', maximumAge: 3650, extra: 1 }, keep: 'x', status: 201, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Tx', source: '*', maximumAge: 3650, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '', fragmentType: '{{u}}Temptytype', maximumAge: 3650 }, status: 201, match: { dataType: 'EVENT', fragmentType: '{{u}}Temptytype', type: '', source: '*', maximumAge: 3650, editable: true } },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'EVENT', type: '{{u}}Tmax', maximumAge: 3651 }, status: 422, error: 'undefined/validationError', message: 'Maximum age cannot be bigger than 10 years.' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'NOPE', type: '{{u}}Tmax', maximumAge: 3651 }, status: 422, error: 'undefined/validationError', message: 'Invalid data, correct values:[ALARM, AUDIT, EVENT, MEASUREMENT, OPERATION, *] : No enum constant com.cumulocity.model.retention.RetentionDataType.NOPE' },
    { m: 'POST', p: '/retention/retentions', b: { dataType: 'ALARM', type: '{{u}}Tmax', fragmentType: 'x', maximumAge: 99999 }, status: 422, error: 'undefined/validationError', message: 'Maximum age cannot be bigger than 10 years.' },
    { m: 'POST', p: '/retention/retentions', raw: '[]', status: 400, error: 'Failed to parse JSON string' },
    { m: 'POST', p: '/retention/retentions', raw: '', status: 400, error: 'Failed to parse JSON string' },
    { m: 'GET', p: '/retention/retentions/{{e1}}', status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}T', source: '*', maximumAge: 3650, editable: true } },
    { m: 'GET', p: '/retention/retentions/{{m1}}', status: 200, match: { dataType: 'MEASUREMENT', fragmentType: '{{u}}Tf', type: '{{u}}T', source: '12345', maximumAge: 3650, editable: true } },
    { m: 'GET', p: '/retention/retentions/{{neg}}', status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Tneg', source: '*', maximumAge: -1, editable: true } },
    { m: 'GET', p: '/retention/retentions/{{frac}}', status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Tfrac', source: '*', maximumAge: 3649, editable: true } },
    { m: 'GET', p: '/retention/retentions/{{str}}', status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Tstr', source: '*', maximumAge: 3650, editable: true } },
    { m: 'GET', p: '/retention/retentions/{{ed}}', status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Ted', source: '*', maximumAge: 3650, editable: true } },
    { m: 'GET', p: '/retention/retentions/{{num}}', status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}Tnum', source: '5', maximumAge: 3650, editable: true } },
    { m: 'GET', p: '/retention/retentions/999999999', status: 404, error: 'retention/Not Found', message: 'Finding retentionRule from database failed : No retentionRule for gid \'999999999\'!' },
    { m: 'GET', p: '/retention/retentions/abc', status: 422, error: 'undefined/validationError', message: 'retentionRuleId=\'abc\' isn\'t correct number mut be used' },
    { m: 'GET', p: '/retention/retentions/-1', status: 404, error: 'retention/Not Found', message: 'Finding retentionRule from database failed : No retentionRule for gid \'-1\'!' },
    { m: 'GET', p: '/retention/retentions/{{e1}}?x=1', status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}T', source: '*', maximumAge: 3650, editable: true } },
    { m: 'GET', p: '/retention/retentions?pageSize=x', status: 422, error: 'REST API/Unprocessable Entity', message: 'Parameter \'pageSize\' must have an integer value!' },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', b: { maximumAge: 40000 }, status: 422, error: 'undefined/validationError', message: 'Maximum age cannot be bigger than 10 years.' },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', b: { type: '{{u}}T2' }, status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}T2', source: '*', maximumAge: 3650, editable: true } },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', b: { type: null, maximumAge: null }, status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}T2', source: '*', maximumAge: 3650, editable: true } },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', b: {}, status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}T2', source: '*', maximumAge: 3650, editable: true } },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', b: { dataType: 'OPERATION' }, status: 422, error: 'retention/Invalid Data', message: 'Failed to add retention rule : Properties [TYPE] can\'t be used in OPERATION api.' },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', b: { dataType: 'NOPE' }, status: 422, error: 'undefined/validationError', message: 'Invalid data, correct values:[ALARM, AUDIT, EVENT, MEASUREMENT, OPERATION, *] : No enum constant com.cumulocity.model.retention.RetentionDataType.NOPE' },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', b: { maximumAge: 'abc' }, status: 400, error: 'Failed to parse JSON string' },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', b: { maximumAge: -5 }, status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}T2', source: '*', maximumAge: -5, editable: true } },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', b: { maximumAge: 3650, id: 7, editable: false }, status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}T2', source: '*', maximumAge: 3650, editable: true } },
    { m: 'PUT', p: '/retention/retentions/{{a1}}', b: { fragmentType: 'x' }, status: 422, error: 'retention/Invalid Data', message: 'Failed to add retention rule : Properties [FRAGMENT_TYPE] can\'t be used in ALARM api.' },
    { m: 'PUT', p: '/retention/retentions/999999999', b: { maximumAge: 3650 }, status: 404, error: 'retention/Not Found', message: 'Finding retentionRule from database failed : No retentionRule for gid \'999999999\'!' },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', b: { maximumAge: 3651 }, status: 422, error: 'undefined/validationError', message: 'Maximum age cannot be bigger than 10 years.' },
    { m: 'PUT', p: '/retention/retentions/abc', b: { maximumAge: 3650 }, status: 422, error: 'undefined/validationError', message: 'retentionRuleId=\'abc\' isn\'t correct number mut be used' },
    { m: 'PUT', p: '/retention/retentions/{{e1}}', raw: '', status: 400, error: 'Failed to parse JSON string' },
    { m: 'GET', p: '/retention/retentions/{{e1}}', status: 200, match: { dataType: 'EVENT', fragmentType: '*', type: '{{u}}T2', source: '*', maximumAge: 3650, editable: true } },
    { m: 'DELETE', p: '/retention/retentions/{{e1}}', status: 204, empty: true },
    { m: 'DELETE', p: '/retention/retentions/{{e1}}', status: 404, error: 'retention/Not Found', message: 'Finding retentionRule from database failed : No retentionRule for gid \'{{e1}}\'!' },
    { m: 'DELETE', p: '/retention/retentions/abc', status: 422, error: 'undefined/validationError', message: 'retentionRuleId=\'abc\' isn\'t correct number mut be used' },
    { m: 'POST', p: '/retention/retentions/{{m1}}', b: {}, status: 405, empty: true },
  ], ['retention-validation']),
]
