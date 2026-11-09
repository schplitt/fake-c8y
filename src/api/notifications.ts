import type { C8yRequest } from '../types'
import type { TenantData } from '../store'
import type { NotificationSubscription } from '../realtime'
import { nextSequence } from '../store'
import { apiError, checkQuery, paged, UnsupportedRequestError } from './http'
import { moSelf } from './inventory'
import { auditSubscriptionCreated, auditSubscriptionDeleted, auditSubscriptionsDeletedBySource, auditTokenCreated, auditUnsubscribed } from './audit'

const APIS = ['*', 'managedobjects', 'measurements', 'events', 'alarms', 'operations']
const JACKSON_SOURCE = '\n at [Source: REDACTED (`StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION` disabled); line: 1, column: 1]'
const SUBSCRIPTION_TYPE = 'com.cumulocity.rest.representation.reliable.notification.NotificationSubscriptionRepresentation'
const UNSUPPORTED_APIS = ['alarmsWithChildren', 'eventsWithChildren']

function render(data: TenantData, subscription: NotificationSubscription, created = false) {
  const { tenant, ...rest } = subscription
  return {
    nonPersistent: false,
    ...rest,
    self: `${data.world.baseUrl}/notification2/subscriptions/${subscription.id}`,
    // verified: a tenant subscription's source is the tenant
    source: subscription.source
      ? { id: subscription.source.id, self: moSelf(data, subscription.source.id), ...(created ? sourceName(data, subscription.source.id) : {}) }
      : { id: tenant, self: `${data.world.baseUrl}/tenant/tenants/${tenant}` },
    // verified: a filter without apis shows an empty list
    ...(subscription.subscriptionFilter ? { subscriptionFilter: { apis: [], ...subscription.subscriptionFilter } } : {}),
  }
}

// verified: the answer to a new subscription shows the source's name, if it has one (reads do not)
function sourceName(data: TenantData, id: string): { name?: string } {
  const name = data.managedObjects.get(id)?.name
  return typeof name === 'string' ? { name } : {}
}

/**
 * 400 for a field the platform cannot read as a list of strings (verified for a string).
 * @param value - The field's value
 * @param chain - The reference chain of the message
 */
function notAList(value: unknown, chain: string): Response | undefined {
  if (value === undefined || value === null || (Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
    return undefined
  }
  return apiError(400, 'Failed to parse JSON string', `Cannot construct instance of \`java.util.ArrayList\` (although at least one Creator exists): no String-argument constructor/factory method to deserialize from String value ('${String(value)}')${JACKSON_SOURCE} (through reference chain: ${chain})`)
}

function notFound(id: string): Response {
  // verified
  return apiError(404, 'reliable-notification/Not Found', `Finding subscription from database failed : No subscription for gid '${id}'!`)
}

const NAME = /^[a-z0-9]+$/i

/**
 * Checks a new subscription like the platform (verified, one problem at a
 * time; the order of several problems is not verified).
 * @param data - Tenant data
 * @param body - Request body
 */
function checkSubscription(data: TenantData, body: Record<string, any>): Response | undefined {
  const invalid = (message: string) => apiError(422, 'undefined/validationError', message)
  if (body.id !== undefined && body.id !== null) {
    return invalid('id is not allowed here')
  }
  for (const field of ['context', 'subscription']) {
    if (body[field] === undefined || body[field] === null) {
      return invalid(`${field} is required`)
    }
  }
  const filter = body.subscriptionFilter
  if (filter !== undefined && filter !== null && (typeof filter !== 'object' || Array.isArray(filter) || (filter.typeFilter !== undefined && filter.typeFilter !== null && typeof filter.typeFilter !== 'string'))) {
    return apiError(400, 'Failed to parse JSON string', `Cannot deserialize the subscription filter ${JSON.stringify(filter)}${JACKSON_SOURCE}`)
  }
  const notList = notAList(filter?.apis, `${SUBSCRIPTION_TYPE}["subscriptionFilter"]->com.cumulocity.rest.representation.reliable.notification.NotificationSubscriptionFilterRepresentation["apis"]`)
    ?? notAList(body.fragmentsToCopy, `${SUBSCRIPTION_TYPE}["fragmentsToCopy"]`)
  if (notList) {
    return notList
  }
  const source = body.source
  if (source !== undefined && source !== null && (typeof source !== 'object' || Array.isArray(source))) {
    return apiError(400, 'Failed to parse JSON string', `Cannot construct instance of \`com.cumulocity.rest.representation.inventory.ManagedObjectRepresentation\` (although at least one Creator exists): no String-argument constructor/factory method to deserialize from String value ('${String(source)}')${JACKSON_SOURCE} (through reference chain: ${SUBSCRIPTION_TYPE}["source"])`)
  }
  if (body.context !== 'mo' && body.context !== 'tenant') {
    return invalid(`Unsupported context: ${String(body.context)}`)
  }
  if (!NAME.test(String(body.subscription))) {
    return invalid(`Invalid value for subscription argument. : Subscription argument <'${String(body.subscription)}'> cannot be blank and has to be alphanumeric!`)
  }
  const apis: string[] = filter?.apis ?? []
  const unsupported = apis.filter((api) => UNSUPPORTED_APIS.includes(api))
  if (unsupported.length > 0) {
    throw new UnsupportedRequestError(`subscription api "${unsupported.join(', ')}" is not emulated`)
  }
  // `*` stands alone
  const wrong = apis.find((api) => !APIS.includes(api) || (api === '*' && apis.length > 1))
  if (wrong !== undefined) {
    return invalid(`Only [events, eventsWithChildren, alarms, alarmsWithChildren, measurements, managedobjects, operations] APIs are allowed, unsupported API found: ${wrong}`)
  }
  if (body.context === 'tenant' && source !== undefined && source !== null) {
    return invalid('Source is not allowed in tenant context')
  }
  if (body.context === 'mo' && (source?.id === undefined || source.id === null)) {
    return invalid('Source is a mandatory field when in managed object context')
  }
  if (body.context === 'mo' && !data.managedObjects.has(String(source.id))) {
    return apiError(404, 'reliable-notification/Not Found', `Source object with id ${String(source.id)} doesn't exist.`)
  }
  const sourceId = body.context === 'mo' ? String(source.id) : undefined
  const duplicate = [...data.notificationSubscriptions.values()].find((item) => item.subscription === body.subscription && item.source?.id === sourceId)
  if (duplicate) {
    // the platform appends its stored document to the message
    return apiError(409, 'reliable-notification/Duplicate', `Subscription with source <'${sourceId ?? data.tenant}'>, context <'${String(body.context)}'> & subscription <'${String(body.subscription)}'> already exists! : Duplicated: ${JSON.stringify({ subscription: body.subscription, context: body.context })}`)
  }
  return undefined
}

const TOKEN_TYPES = ['notification', 'tenant']

/**
 * Checks a token request like the platform (verified).
 * @param body - Request body
 */
function checkToken(body: Record<string, any>): Response | undefined {
  for (const field of ['subscriber', 'subscription']) {
    if (body[field] === undefined || body[field] === null) {
      return apiError(422, 'undefined/validationError', `${field} is required`)
    }
  }
  const minutes = body.expiresInMinutes
  if (minutes !== undefined && minutes !== null && (typeof minutes === 'string' ? !/^-?\d+$/.test(minutes) : typeof minutes !== 'number')) {
    return apiError(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`long\` from String ${JSON.stringify(String(minutes))}: not a valid \`long\` value${JACKSON_SOURCE} (through reference chain: com.cumulocity.rest.representation.reliable.notification.NotificationTokenRequestRepresentation["expiresInMinutes"])`)
  }
  if (!NAME.test(String(body.subscriber))) {
    return apiError(422, 'reliable-notification/Invalid Data', `Invalid value for subscriber argument. : Subscriber argument <'${String(body.subscriber)}'> cannot be blank and has to be alphanumeric!`)
  }
  if (minutes !== undefined && minutes !== null && Number(minutes) < 1) {
    return apiError(422, 'reliable-notification/Invalid Data', 'Invalid value for expiresInMinutes argument!')
  }
  if (body.type !== undefined && body.type !== null && !TOKEN_TYPES.includes(String(body.type))) {
    return apiError(422, 'reliable-notification/Invalid Data', `Invalid value for type argument. : Type argument <'${String(body.type)}'> has to one of the allowed types!`)
  }
  return undefined
}

/**
 * Notification 2.0 API: subscriptions, tokens, and unsubscribing consumers.
 * The consumer WebSocket itself is in `../websocket` (the `fake-c8y/realtime` entry).
 * @param call - The request
 * @param segments - Path segments
 * @param data - Data of the request's tenant
 */
export function notifications(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, resource, id] = segments
  const { method } = call
  const tenant = data.tenant
  const body = (call.body ?? {}) as Record<string, any>

  if (resource === 'subscriptions' && id === undefined) {
    if (method === 'POST') {
      checkQuery('POST /notification2/subscriptions', call, [])
      const invalid = checkSubscription(data, body)
      if (invalid) {
        return invalid
      }
      const sourceId = body.context === 'mo' ? String(body.source.id) : undefined
      const created: NotificationSubscription = {
        id: String(nextSequence(data, 'notification')),
        tenant,
        context: body.context,
        subscription: body.subscription,
        ...(sourceId ? { source: { id: sourceId } } : {}),
        ...(body.subscriptionFilter ? { subscriptionFilter: body.subscriptionFilter } : {}),
        ...(body.fragmentsToCopy ? { fragmentsToCopy: body.fragmentsToCopy } : {}),
        ...(body.nonPersistent !== undefined ? { nonPersistent: body.nonPersistent } : {}),
      }
      data.notificationSubscriptions.set(created.id, created)
      auditSubscriptionCreated(data, created)
      return Response.json(render(data, created, true), { status: 201 })
    }
    if (method === 'GET') {
      checkQuery('GET /notification2/subscriptions', call, ['context', 'currentPage', 'pageSize', 'source', 'subscription', 'typeFilter', 'withTotalElements', 'withTotalPages'])
      const { query } = call
      // verified: `typeFilter` matches the subscription's type filter exactly
      const items = [...data.notificationSubscriptions.values()].filter((item) => (query.subscription === undefined || item.subscription === query.subscription)
        && (query.context === undefined || item.context === query.context)
        && (query.source === undefined || item.source?.id === query.source)
        && (query.typeFilter === undefined || item.subscriptionFilter?.typeFilter === query.typeFilter))
      return paged(data, call, 'subscriptions', items, '/notification2/subscriptions', { errorCode: 'REST API/Unprocessable Entity', render: (item) => render(data, item) })
    }
    if (method === 'DELETE') {
      checkQuery('DELETE /notification2/subscriptions', call, ['context', 'source'])
      let deleted = 0
      for (const [key, item] of [...data.notificationSubscriptions]) {
        if ((call.query.context === undefined || item.context === call.query.context)
          && (call.query.source === undefined || item.source?.id === call.query.source)) {
          data.notificationSubscriptions.delete(key)
          deleted++
        }
      }
      if (call.query.source !== undefined) {
        auditSubscriptionsDeletedBySource(data, call.query.source, deleted)
      }
      return new Response(null, { status: 204 })
    }
    return undefined
  }

  if (resource === 'subscriptions' && id !== undefined && segments.length === 3) {
    const subscription = data.notificationSubscriptions.get(id)
    if (method === 'GET') {
      return subscription ? Response.json(render(data, subscription)) : notFound(id)
    }
    if (method === 'DELETE') {
      if (!subscription) {
        return notFound(id)
      }
      data.notificationSubscriptions.delete(id)
      auditSubscriptionDeleted(data, subscription.id)
      return new Response(null, { status: 204 })
    }
    return undefined
  }

  if (resource === 'token' && method === 'POST' && segments.length === 2) {
    checkQuery('POST /notification2/token', call, [])
    const invalid = checkToken(body)
    if (invalid) {
      return invalid
    }
    const token = `fake-token-${nextSequence(data, 'notification')}-${body.subscription}`
    data.notificationTokens.set(token, { tenant, subscription: body.subscription, subscriber: body.subscriber })
    auditTokenCreated(data, String(body.subscription))
    return Response.json({ token })
  }

  if (resource === 'unsubscribe' && method === 'POST' && segments.length === 2) {
    // verified: 422 without a token, 500 for an unknown token or one without
    // a connected consumer
    const token = call.query.token ?? ''
    if (!token) {
      return apiError(422, 'reliable-notification/Invalid Data', 'Missing token')
    }
    const consumers = [...data.world.realtime.sockets].filter((socket) => new URL(socket.url).searchParams.get('token') === token)
    const stored = data.notificationTokens.get(token)
    if (!stored || consumers.length === 0) {
      return apiError(500, 'reliable-notification/Internal Server Error', 'Unsubscribing the consumer failed')
    }
    const { subscriber, subscription } = stored
    data.notificationTokens.delete(token)
    auditUnsubscribed(data, subscriber, subscription)
    for (const socket of consumers) {
      socket.close()
    }
    return Response.json({ result: 'DONE' })
  }

  return undefined
}
