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

export const adminNotificationScenarios: ContractScenario[] = [
  scenario('admin notification2: subscription and token validation', [
    { m: 'POST', p: '/inventory/managedObjects', b: { name: '{{u}}mo', c8y_IsDevice: {} }, keep: 'mo', status: 201, match: { name: '{{u}}mo', owner: '{{me}}' } },
    { m: 'POST', p: '/inventory/managedObjects', b: { name: '{{u}}mo2', c8y_IsDevice: {} }, keep: 'mo2', status: 201, match: { name: '{{u}}mo2', owner: '{{me}}' } },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}a', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['alarms'] } }, keep: 'a', status: 201, match: { context: 'mo', subscription: '{{u}}a', nonPersistent: false } },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}b', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['measurements', 'events'], typeFilter: 'c8y_T' }, fragmentsToCopy: ['c8y_X'] }, keep: 'b', status: 201, match: { context: 'mo', subscription: '{{u}}b', nonPersistent: false } },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}c', source: { id: '{{mo2}}' }, subscriptionFilter: { apis: ['*'] } }, keep: 'c', status: 201, match: { context: 'mo', subscription: '{{u}}c', nonPersistent: false } },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'tenant', subscription: '{{u}}t', subscriptionFilter: { apis: ['managedobjects'] } }, keep: 't', status: 201, match: { context: 'tenant', subscription: '{{u}}t', nonPersistent: false } },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'tenant', subscription: '{{u}}t2', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['managedobjects'] } }, status: 422, error: 'undefined/validationError', message: 'Source is not allowed in tenant context' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}a', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['alarms'] } }, status: 409, error: 'reliable-notification/Duplicate' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}d', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['nope'] } }, status: 422, error: 'undefined/validationError', message: 'Only [events, eventsWithChildren, alarms, alarmsWithChildren, measurements, managedobjects, operations] APIs are allowed, unsupported API found: nope' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}e', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['*', 'alarms'] } }, status: 422, error: 'undefined/validationError', message: 'Only [events, eventsWithChildren, alarms, alarmsWithChildren, measurements, managedobjects, operations] APIs are allowed, unsupported API found: *' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}f', source: { id: '{{mo}}' }, subscriptionFilter: {} }, status: 201, match: { context: 'mo', subscription: '{{u}}f', nonPersistent: false } },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}g', source: { id: '{{mo}}' } }, status: 201, match: { context: 'mo', subscription: '{{u}}g', nonPersistent: false } },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}h', source: { id: '{{mo}}' }, subscriptionFilter: { apis: [] } }, status: 201, match: { context: 'mo', subscription: '{{u}}h', nonPersistent: false } },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}i', source: { id: '{{mo}}' }, subscriptionFilter: { apis: 'alarms' } }, status: 400, error: 'Failed to parse JSON string' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}j', source: { id: '{{mo}}' }, subscriptionFilter: { typeFilter: 'x' } }, status: 201, match: { context: 'mo', subscription: '{{u}}j', nonPersistent: false } },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'nope', subscription: '{{u}}k', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['alarms'] } }, status: 422, error: 'undefined/validationError', message: 'Unsupported context: nope' },
    { m: 'POST', p: '/notification2/subscriptions', b: { subscription: '{{u}}l', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['alarms'] } }, status: 422, error: 'undefined/validationError', message: 'context is required' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'MO', subscription: '{{u}}m', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['alarms'] } }, status: 422, error: 'undefined/validationError', message: 'Unsupported context: MO' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}n', subscriptionFilter: { apis: ['alarms'] } }, status: 422, error: 'undefined/validationError', message: 'Source is a mandatory field when in managed object context' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}o', source: { id: '999999999' }, subscriptionFilter: { apis: ['alarms'] } }, status: 404, error: 'reliable-notification/Not Found', message: 'Source object with id <id> doesn\'t exist.' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}p', source: '{{mo}}', subscriptionFilter: { apis: ['alarms'] } }, status: 400, error: 'Failed to parse JSON string' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}-x', source: { id: '{{mo}}' } }, status: 422, error: 'undefined/validationError', message: 'Invalid value for subscription argument. : Subscription argument <\'{{u}}-x\'> cannot be blank and has to be alphanumeric!' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '', source: { id: '{{mo}}' } }, status: 422, error: 'undefined/validationError', message: 'Invalid value for subscription argument. : Subscription argument <\'\'> cannot be blank and has to be alphanumeric!' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', source: { id: '{{mo}}' } }, status: 422, error: 'undefined/validationError', message: 'subscription is required' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}q', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['alarms'] }, fragmentsToCopy: 'c8y_X' }, status: 400, error: 'Failed to parse JSON string' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}r', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['alarms'] }, nonPersistent: true }, status: 201, match: { context: 'mo', subscription: '{{u}}r', nonPersistent: true } },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}s', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['alarms'] }, id: '5' }, status: 422, error: 'undefined/validationError', message: 'id is not allowed here' },
    { m: 'POST', p: '/notification2/subscriptions', b: { context: 'mo', subscription: '{{u}}u', source: { id: '{{mo}}' }, subscriptionFilter: { apis: ['operations', 'events', 'measurements', 'managedobjects', 'alarms'] } }, keep: 'uu', status: 201, match: { context: 'mo', subscription: '{{u}}u', nonPersistent: false } },
    { m: 'POST', p: '/notification2/subscriptions', raw: '[]', status: 400, error: 'Failed to parse JSON string' },
    { m: 'POST', p: '/notification2/subscriptions', raw: '', status: 400, error: 'Failed to parse JSON string' },
    { m: 'GET', p: '/notification2/subscriptions/{{a}}', status: 200, match: { context: 'mo', subscription: '{{u}}a', nonPersistent: false } },
    { m: 'GET', p: '/notification2/subscriptions/{{b}}', status: 200, match: { context: 'mo', subscription: '{{u}}b', nonPersistent: false } },
    { m: 'GET', p: '/notification2/subscriptions/{{t}}', status: 200, match: { context: 'tenant', subscription: '{{u}}t', nonPersistent: false } },
    { m: 'GET', p: '/notification2/subscriptions/999999999', status: 404, error: 'reliable-notification/Not Found', message: 'Finding subscription from database failed : No subscription for gid \'999999999\'!' },
    { m: 'GET', p: '/notification2/subscriptions/abc', status: 404, error: 'reliable-notification/Not Found', message: 'Finding subscription from database failed : No subscription for gid \'abc\'!' },
    { m: 'GET', p: '/notification2/subscriptions/{{a}}?x=1', status: 200, match: { context: 'mo', subscription: '{{u}}a', nonPersistent: false } },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}', status: 200, count: 5 },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}&pageSize=1&withTotalElements=true&withTotalPages=true', status: 200, count: 1 },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}&pageSize=1&currentPage=2', status: 200, count: 1 },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}&subscription={{u}}b', status: 200, count: 1 },
    { m: 'GET', p: '/notification2/subscriptions?subscription={{u}}b', status: 200, count: 1 },
    { m: 'GET', p: '/notification2/subscriptions?subscription={{u}}B', status: 200, count: 0 },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}&context=tenant', status: 200, count: 0 },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}&context=mo', status: 200, count: 5 },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}&context=nope', status: 200, count: 0 },
    { m: 'GET', p: '/notification2/subscriptions?subscription={{u}}t&context=tenant', status: 200, count: 1 },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}&typeFilter=c8y_T', status: 200, count: 1 },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}&typeFilter=nope', status: 200, count: 0 },
    { m: 'GET', p: '/notification2/subscriptions?source=999999999', status: 200, count: 0 },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}&pageSize=x', status: 422, error: 'REST API/Unprocessable Entity', message: 'Parameter \'pageSize\' must have an integer value!' },
    { m: 'POST', p: '/notification2/token', b: { subscriber: '{{u}}s1', subscription: '{{u}}a' }, status: 200, match: {} },
    { m: 'POST', p: '/notification2/token', b: { subscriber: '{{u}}s1', subscription: '{{u}}a', expiresInMinutes: 5, shared: true, type: 'notification', signed: true, nonPersistent: false }, status: 200, match: {} },
    { m: 'POST', p: '/notification2/token', b: { subscriber: '{{u}}s1', subscription: '{{u}}zz' }, status: 200, match: {} },
    { m: 'POST', p: '/notification2/token', b: { subscriber: 'r1108-s', subscription: '{{u}}a' }, status: 422, error: 'reliable-notification/Invalid Data', message: 'Invalid value for subscriber argument. : Subscriber argument <\'r1108-s\'> cannot be blank and has to be alphanumeric!' },
    { m: 'POST', p: '/notification2/token', b: { subscriber: '{{u}}s1' }, status: 422, error: 'undefined/validationError', message: 'subscription is required' },
    { m: 'POST', p: '/notification2/token', b: { subscription: '{{u}}a' }, status: 422, error: 'undefined/validationError', message: 'subscriber is required' },
    { m: 'POST', p: '/notification2/token', b: { subscriber: '{{u}}s1', subscription: '{{u}}a', expiresInMinutes: -1 }, status: 422, error: 'reliable-notification/Invalid Data', message: 'Invalid value for expiresInMinutes argument!' },
    { m: 'POST', p: '/notification2/token', b: { subscriber: '{{u}}s1', subscription: '{{u}}a', expiresInMinutes: 'x' }, status: 400, error: 'Failed to parse JSON string' },
    { m: 'POST', p: '/notification2/token', b: { subscriber: '{{u}}s1', subscription: '{{u}}a', type: 'nope' }, status: 422, error: 'reliable-notification/Invalid Data', message: 'Invalid value for type argument. : Type argument <\'nope\'> has to one of the allowed types!' },
    { m: 'POST', p: '/notification2/token', raw: '', status: 400, error: 'Failed to parse JSON string' },
    { m: 'DELETE', p: '/notification2/subscriptions/{{a}}', status: 204, empty: true },
    { m: 'DELETE', p: '/notification2/subscriptions/{{a}}', status: 404, error: 'reliable-notification/Not Found', message: 'Finding subscription from database failed : No subscription for gid \'{{a}}\'!' },
    { m: 'DELETE', p: '/notification2/subscriptions/abc', status: 404, error: 'reliable-notification/Not Found', message: 'Finding subscription from database failed : No subscription for gid \'abc\'!' },
    { m: 'DELETE', p: '/notification2/subscriptions?source={{mo2}}', status: 204, empty: true },
    { m: 'GET', p: '/notification2/subscriptions/{{c}}', status: 404, error: 'reliable-notification/Not Found', message: 'Finding subscription from database failed : No subscription for gid \'{{c}}\'!' },
    { m: 'DELETE', p: '/notification2/subscriptions?source={{mo}}&context=mo', status: 204, empty: true },
    { m: 'GET', p: '/notification2/subscriptions?source={{mo}}', status: 200, count: 0 },
    { m: 'DELETE', p: '/notification2/subscriptions/{{t}}', status: 204, empty: true },
    { m: 'DELETE', p: '/inventory/managedObjects/{{mo}}?forceCascade=true', status: 204, empty: true },
    { m: 'DELETE', p: '/inventory/managedObjects/{{mo2}}?forceCascade=true', status: 204, empty: true },
  ], ['subscription-validation']),
]
