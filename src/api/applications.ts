/**
 * Application API: `/application/applications/**`, the `applicationsBy*`
 * lists, `/application/currentApplication/**` (for an application's own
 * credentials), and a tenant's subscriptions
 * (`/tenant/tenants/{tenantId}/applications/**`).
 *
 * Applications are stored in the tenant that owns them
 * (`TenantData.applications`); every tenant also has its own copies of the
 * platform's default applications (owner `management`, see
 * `src/application-defaults.ts`). Subscriptions are stored in the subscribed
 * tenant (`TenantData.applicationSubscriptions`, by application id), with the
 * service user of a microservice.
 */
import type { C8yRequest } from '../types'
import type { C8yEndpoint } from '../capabilities.generated'
import type { StoredDocument, TenantData } from '../store'
import { nextSequence, optionKey } from '../store'
import { clone, toHex } from '../utils'
import { apiError, checkQuery, paged } from './http'

const TYPES: readonly string[] = ['EXTERNAL', 'HOSTED', 'MICROSERVICE']

/**
 * Ids of new applications start after this (the platform's ids are in this range).
 */
const FIRST_APPLICATION_ID = 120_000

/**
 * The fields of an application in the platform's order; the manifest fields
 * the platform copies to the top level follow `self`.
 */
const LEADING_FIELDS = ['id', 'name', 'key', 'type', 'availability', 'owner', 'contextPath', 'resourcesUrl', 'externalUrl', 'manifest', 'activeVersionId', 'applicationVersions', 'requiredRoles', 'roles'] as const

/**
 * Manifest fields an uploaded microservice also has on its top level
 * (verified on the platform's own and on uploaded microservices).
 */
const MANIFEST_TOP_LEVEL = ['livenessProbe', 'settings', 'apiVersion', 'billingMode', 'provider', 'readinessProbe', 'isolation', 'scale', 'replicas', 'resources', 'requestedResources', 'extensions', 'description', 'version']

/**
 * The manifest a microservice created through the API gets: the platform
 * drops the one in the request (verified: the create answer echoes it, a
 * read shows this one).
 */
const API_MANIFEST = { requiredRoles: [], roles: [], billingMode: 'RESOURCES', deploymentMethod: 'CORE', noAppSwitcher: true }

/**
 * A microservice manifest (`cumulocity.json`), the fields the fake reads.
 * Any other field is kept in `manifest` as given.
 */
export interface C8yMicroserviceManifest {
  /**
   * Application name.
   * @default the context path
   */
  name?: string
  contextPath?: string
  /**
   * @default `<name>-key`
   */
  key?: string
  version?: string
  apiVersion?: string
  /**
   * Roles the service user gets in every subscribed tenant.
   */
  requiredRoles?: string[]
  /**
   * Roles the microservice adds to the role catalogue of every subscribed
   * tenant, for users and groups.
   */
  roles?: string[]
  /**
   * Tenant options of the settings category with their defaults.
   */
  settings?: Array<{ key: string, defaultValue?: string, editable?: boolean, inheritFromOwner?: boolean, overwriteOnUpdate?: boolean }>
  /**
   * Category of the settings (`currentApplication/settings`).
   * @default the context path, else the name
   */
  settingsCategory?: string
  /**
   * `MULTI_TENANT` or `PER_TENANT` (a plain string, so an imported
   * `cumulocity.json` fits).
   */
  isolation?: string
  provider?: { name?: string, [field: string]: unknown }
  [field: string]: unknown
}

function nextApplicationId(data: TenantData): string {
  let id: string
  do {
    id = String(FIRST_APPLICATION_ID + nextSequence(data, 'application'))
  } while (data.applications.has(id))
  return id
}

/**
 * A password like the platform's (32 characters), deterministic per user.
 * @param name - User name
 */
function applicationPassword(name: string): string {
  return toHex(name).padEnd(32, '0').slice(-32)
}

/**
 * The tenant data an application lives in: the owner's, or the tenant's own
 * copy of a default application.
 * @param data - Tenant asking
 * @param id - Application id
 * @param owner - Owner tenant
 */
function ownerData(data: TenantData, id: string, owner: string): TenantData | undefined {
  if (owner === data.tenant || data.applications.get(id)?.owner === owner) {
    return data
  }
  return data.world.tenantData?.(owner)
}

/**
 * An application visible to a tenant: owned by it, or subscribed.
 * @param data - Tenant data
 * @param id - Application id
 */
export function findApplication(data: TenantData, id: string): Readonly<StoredDocument> | undefined {
  const own = data.applications.get(id)
  if (own && (own.owner === data.tenant || data.applicationSubscriptions.has(id))) {
    return own
  }
  const subscription = data.applicationSubscriptions.get(id)
  return subscription ? ownerData(data, id, subscription.owner as string)?.applications.get(id) : undefined
}

/**
 * The applications a tenant sees, in the platform's order (by id as text,
 * verified): the ones it owns and the ones it is subscribed to.
 * @param data - Tenant data
 */
export function visibleApplications(data: TenantData): Array<Readonly<StoredDocument>> {
  const result = new Map<string, Readonly<StoredDocument>>()
  for (const [id, application] of data.applications) {
    if (application.owner === data.tenant || data.applicationSubscriptions.has(id)) {
      result.set(id, application)
    }
  }
  for (const [id, subscription] of data.applicationSubscriptions) {
    if (!result.has(id)) {
      const application = ownerData(data, id, subscription.owner as string)?.applications.get(id)
      if (application) {
        result.set(id, application)
      }
    }
  }
  return [...result.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * The microservice a tenant reaches at `/service/<contextPath>`: one it is
 * subscribed to.
 * @param data - Tenant data
 * @param contextPath - Context path
 */
export function subscribedMicroservice(data: TenantData, contextPath: string): Readonly<StoredDocument> | undefined {
  for (const id of data.applicationSubscriptions.keys()) {
    const application = findApplication(data, id)
    if (application?.type === 'MICROSERVICE' && application.contextPath === contextPath) {
      return application
    }
  }
  return undefined
}

/**
 * An application as the API returns it.
 * @param data - Tenant data (base URL)
 * @param application - Stored application
 */
export function renderApplication(data: TenantData, application: Readonly<StoredDocument>): Record<string, unknown> {
  const origin = new URL(data.world.baseUrl).origin
  const result: Record<string, unknown> = {}
  for (const field of LEADING_FIELDS) {
    if (application[field] === undefined) {
      continue
    }
    result[field] = field === 'owner'
      ? { self: `${origin}/tenant/tenants/${application.owner as string}`, tenant: { id: application.owner } }
      : clone(application[field])
  }
  result.self = `${origin}/application/applications/${application.id}`
  for (const [field, value] of Object.entries(application)) {
    if (!Object.hasOwn(result, field) && !field.startsWith('__')) {
      result[field] = clone(value)
    }
  }
  return result
}

/**
 * The settings category of a microservice: `settingsCategory` of its
 * manifest, else its context path, else its name (documented; verified that
 * the context path wins over the name).
 * @param application - Stored application
 */
export function settingsCategoryOf(application: Readonly<StoredDocument>): string {
  const manifest = (application.manifest ?? {}) as C8yMicroserviceManifest
  return [manifest.settingsCategory, application.contextPath, application.name].find((value): value is string => typeof value === 'string' && value.trim() !== '')!
}

/**
 * The settings of a microservice in a tenant: its tenant options of the
 * settings category, `{ key: value }` (verified: also before a subscription,
 * and options a user created keep their full key).
 * @param data - Tenant data
 * @param category - Settings category
 */
export function applicationSettings(data: TenantData, category: string): Record<string, string> {
  const prefix = optionKey(category, '')
  const settings: Record<string, string> = {}
  for (const [id, value] of data.options) {
    if (id.startsWith(prefix) && value !== null) {
      settings[id.slice(prefix.length)] = value
    }
  }
  return settings
}

/**
 * An application of the tenant, created like `POST /application/applications`.
 * @param data - Owner tenant
 * @param body - Fields
 */
function buildApplication(data: TenantData, body: Record<string, unknown>): StoredDocument {
  const { id: _id, owner: _owner, self: _self, ...fields } = body
  const application: StoredDocument = {
    id: nextApplicationId(data),
    name: fields.name,
    key: fields.key,
    type: fields.type,
    // verified: a new application is PRIVATE unless it says otherwise
    availability: fields.availability ?? 'PRIVATE',
    owner: data.tenant,
  }
  for (const [field, value] of Object.entries(fields)) {
    if (!Object.hasOwn(application, field) && value !== undefined && value !== null) {
      application[field] = clone(value)
    }
  }
  if (application.type === 'MICROSERVICE') {
    application.manifest = clone(API_MANIFEST)
    application.requiredRoles = [...((fields.requiredRoles ?? []) as string[])]
    application.roles = [...((fields.roles ?? []) as string[])]
  }
  return application
}

/**
 * A microservice of the tenant from its manifest, as the platform stores an
 * uploaded one: the manifest (settings get the platform's flags), its
 * `requiredRoles` and `roles`, and the manifest fields the platform copies
 * to the top level.
 * @param data - Owner tenant
 * @param contextPath - Context path
 * @param manifest - The manifest
 * @param id - Its id (default: a new one)
 */
export function microserviceFromManifest(data: TenantData, contextPath: string, manifest: C8yMicroserviceManifest, id: string = nextApplicationId(data)): StoredDocument {
  const name = manifest.name ?? contextPath
  // verified in the create answer: settings get these flags
  const settings = manifest.settings?.map((setting) => ({ editable: false, inheritFromOwner: true, overwriteOnUpdate: true, ...setting }))
  const stored: C8yMicroserviceManifest = { ...clone(manifest) as C8yMicroserviceManifest, contextPath, ...(settings ? { settings } : {}), requiredRoles: manifest.requiredRoles ?? [], roles: manifest.roles ?? [], billingMode: manifest.billingMode ?? 'RESOURCES' }
  const application: StoredDocument = {
    id,
    name,
    key: manifest.key ?? `${name}-key`,
    type: 'MICROSERVICE',
    availability: 'PRIVATE',
    owner: data.tenant,
    contextPath,
    manifest: stored,
    requiredRoles: [...stored.requiredRoles!],
    roles: [...stored.roles!],
  }
  for (const field of MANIFEST_TOP_LEVEL) {
    if (stored[field] !== undefined) {
      application[field] = clone(stored[field])
    }
  }
  return application
}

/**
 * An application to seed (`world.seed({ applications })`): the fields as the
 * API shows them, with the owner as a tenant id.
 */
export interface C8yApplicationInput {
  /**
   * Replaces the application with this id (a default one, for instance).
   * @default a new id
   */
  id?: string
  name: string
  type: 'EXTERNAL' | 'HOSTED' | 'MICROSERVICE'
  /**
   * @default `<name>-key`
   */
  key?: string
  /**
   * Owner tenant: the seeded tenant, or `management` for an application of
   * the platform.
   * @default the seeded tenant
   */
  owner?: string
  /**
   * @default 'MARKET' for `management`, else 'PRIVATE'
   */
  availability?: string
  contextPath?: string
  /**
   * Whether the tenant is subscribed (a microservice then gets its service
   * user and roles).
   * @default true
   */
  subscribed?: boolean
  [field: string]: unknown
}

/**
 * Seeds applications (`world.seed()`).
 * @param data - Tenant data
 * @param inputs - Applications to add or replace
 * @param withoutDefaults - Remove the default applications first
 * @returns The id of each input's application, in input order
 */
export function seedApplications(data: TenantData, inputs: readonly C8yApplicationInput[], withoutDefaults: boolean): string[] {
  const ids: string[] = []
  if (withoutDefaults) {
    for (const [id, application] of data.applications) {
      if (application.owner === 'management') {
        data.applications.delete(id)
        data.applicationSubscriptions.delete(id)
      }
    }
  }
  for (const { subscribed = true, id, owner = data.tenant, ...fields } of inputs) {
    if (!TYPES.includes(fields.type)) {
      throw new TypeError(`seed(): application ${fields.name} has an invalid type ${String(fields.type)}`)
    }
    const existing = id !== undefined ? data.applications.get(id) : [...data.applications.values()].find((application) => application.name === fields.name && application.owner === owner)
    const application: StoredDocument = {
      id: existing?.id ?? id ?? nextApplicationId(data),
      name: fields.name,
      key: fields.key ?? `${fields.name}-key`,
      type: fields.type,
      availability: fields.availability ?? (owner === 'management' ? 'MARKET' : 'PRIVATE'),
      owner,
    }
    for (const [field, value] of Object.entries(fields)) {
      if (!(field in application) && value !== undefined) {
        application[field] = clone(value)
      }
    }
    if (application.type === 'MICROSERVICE') {
      application.requiredRoles ??= []
      application.roles ??= []
    }
    data.applications.set(application.id, application)
    data.applicationSubscriptions.delete(application.id)
    if (subscribed) {
      subscribe(data, application)
    }
    ids.push(application.id)
  }
  return ids
}

/**
 * Subscribes a tenant to an application. The application becomes MARKET
 * (verified), a microservice's roles join the tenant's role catalogue
 * (verified) and its tenant gets a service user (`service_<name>`,
 * verified); the manifest's settings defaults become tenant options of the
 * settings category where the option does not exist (documented, not
 * verifiable without an upload).
 * @param data - Subscribing tenant
 * @param application - The application
 * @param serviceUser - Name of the service user (default `service_<name>`)
 * @param refresh - Bring an existing subscription up to date (service user,
 *   roles, settings defaults) instead of leaving it as it is
 * @returns `false` if the tenant was subscribed already
 */
export function subscribe(data: TenantData, application: Readonly<StoredDocument>, serviceUser?: string, refresh = false): boolean {
  const existing = data.applicationSubscriptions.get(application.id)
  if (existing && !refresh) {
    return false
  }
  const owner = ownerData(data, application.id, application.owner as string)
  if (owner && application.availability !== 'MARKET') {
    owner.applications.set(application.id, { ...application, availability: 'MARKET' })
  }
  const subscription: StoredDocument = { id: application.id, owner: application.owner }
  if (application.type === 'MICROSERVICE') {
    subscription.serviceUser = serviceUser ?? `service_${application.name as string}`
    subscription.password = applicationPassword(subscription.serviceUser as string)
    for (const role of (application.roles ?? []) as string[]) {
      if (!data.roles.has(role)) {
        data.roles.set(role, role)
      }
    }
    const category = settingsCategoryOf(application)
    for (const setting of ((application.manifest as C8yMicroserviceManifest | undefined)?.settings ?? [])) {
      const id = optionKey(category, setting.key)
      if (setting.defaultValue !== undefined && !data.options.has(id)) {
        data.options.set(id, setting.defaultValue)
      }
    }
  }
  if (!existing || existing.owner !== subscription.owner || existing.serviceUser !== subscription.serviceUser) {
    data.applicationSubscriptions.set(application.id, subscription)
  }
  return !existing
}

/**
 * Ends a subscription. The service user goes; the microservice's roles stay
 * in the role catalogue and with the users and groups that have them
 * (verified).
 * @param data - Subscribed tenant
 * @param id - Application id
 * @returns `false` if the tenant was not subscribed
 */
export function unsubscribe(data: TenantData, id: string): boolean {
  return data.applicationSubscriptions.delete(id)
}

/**
 * Deletes an application its tenant owns, after ending every subscription to
 * it in all tenants of the world (verified: no `force` needed).
 * @param data - Owner tenant
 * @param id - Application id
 */
export function deleteApplication(data: TenantData, id: string): boolean {
  const application = data.applications.get(id)
  if (!application) {
    return false
  }
  for (const tenant of data.world.tenants?.() ?? [data]) {
    if (tenant.applicationSubscriptions.get(id)?.owner === application.owner) {
      unsubscribe(tenant, id)
    }
  }
  data.applications.delete(id)
  return true
}

const bootstrapName = (application: Readonly<StoredDocument>): string => `servicebootstrap_${application.name as string}`

/**
 * The application whose own credentials a request uses: its bootstrap user
 * (in the owner tenant, also without a subscription) or its service user in
 * a subscribed tenant.
 * @param tenants - All tenants of the world
 * @param tenant - Caller's tenant
 * @param user - Caller's user name
 */
export function applicationOfCredentials(tenants: Iterable<TenantData>, tenant: string, user: string): { data: TenantData, application: Readonly<StoredDocument>, bootstrap: boolean } | undefined {
  for (const data of tenants) {
    if (data.tenant !== tenant) {
      continue
    }
    for (const subscription of data.applicationSubscriptions.values()) {
      if (subscription.serviceUser === user) {
        const application = findApplication(data, subscription.id)
        if (application) {
          return { data, application, bootstrap: false }
        }
      }
    }
    if (user.startsWith('servicebootstrap_')) {
      for (const application of data.applications.values()) {
        if (application.owner === tenant && application.type === 'MICROSERVICE' && bootstrapName(application) === user) {
          return { data, application, bootstrap: true }
        }
      }
    }
  }
  return undefined
}

/**
 * The bootstrap user of a microservice (`servicebootstrap_<name>`,
 * verified). It exists from the upload on; name and password follow from the
 * application's name, so nothing is stored and reading it changes nothing.
 * @param data - Owner tenant
 * @param application - The microservice
 */
export function bootstrapUser(data: TenantData, application: Readonly<StoredDocument>): { tenant: string, name: string, password: string } {
  const name = bootstrapName(application)
  return { tenant: data.tenant, name, password: applicationPassword(name) }
}

/**
 * `GET /user/currentUser` for an application's own credentials (verified):
 * the bootstrap user has `ROLE_SYSTEM`, a service user its required roles
 * and `ROLE_SYSTEM`.
 * @param data - Caller's tenant
 * @param user - User name
 * @param roles - Global roles
 */
export function renderApplicationUser(data: TenantData, user: string, roles: readonly string[]): Record<string, unknown> {
  const origin = new URL(data.world.baseUrl).origin
  return {
    self: `${origin}/user/currentUser`,
    id: user,
    userName: user,
    shouldResetPassword: false,
    requiredAuthType: 'NONE',
    effectiveRoles: [...roles, 'ROLE_SYSTEM'].map((role) => ({ self: `${origin}/user/roles/${role}`, id: role, name: role })),
    lastPasswordChange: data.world.now(),
  }
}

const notFound = (id: string) => apiError(404, 'applications/Not Found', `Error occurred when trying to find an Application for id ID [type=com_cumulocity_model_idtype_GId, value=${id}] : Could not find application by ID ${id}`)
const noSuchApplication = (id: string) => apiError(404, 'application/Not Found', `Could not find application by ID ${id}`)

const PAGING = ['currentPage', 'pageSize', 'withTotalElements', 'withTotalPages']

/**
 * The applications matching the filters of `GET /application/applications`
 * (verified): `name` is exact and case-sensitive, `type` a case-insensitive
 * comma list, and `owner`, `subscriber`, `providedFor`, and `tenant` match
 * only the caller's own tenant (the platform's default applications are not
 * listed for `owner=management`). `user` lists everything for a known user.
 * `availability` filters too, although the spec does not list it.
 * @param data - Tenant data
 * @param query - The filters
 */
function filtered(data: TenantData, query: Record<string, string>): Array<Readonly<StoredDocument>> | Response {
  const { name, owner, providedFor, subscriber, tenant, type, user, hasVersions, availability } = query
  if (user && !data.users.has(user)) {
    return apiError(404, 'application/User not found', `User ${user} not found`)
  }
  const types = type ? type.split(',').map((item) => item.toUpperCase()) : undefined
  const own = (application: Readonly<StoredDocument>) => application.owner === data.tenant
  const subscribed = (application: Readonly<StoredDocument>) => data.applicationSubscriptions.has(application.id)
  const versions = hasVersions?.toLowerCase()
  return visibleApplications(data).filter((application) => (!name || application.name === name)
    && (!availability || application.availability === availability)
    && (!types || types.includes(application.type as string))
    && (!owner || (owner === data.tenant && own(application)))
    && (!subscriber || (subscriber === data.tenant && subscribed(application)))
    && (!providedFor || (providedFor === data.tenant && subscribed(application) && !own(application)))
    && (!tenant || (tenant === data.tenant && (own(application) || subscribed(application))))
    && (versions !== 'true' || ((application.applicationVersions as unknown[] | undefined)?.length ?? 0) > 0)
    && (versions !== 'false' || ((application.applicationVersions as unknown[] | undefined)?.length ?? 0) === 0))
}

/**
 * Answers `/application/**` (except `currentApplication`, which needs the
 * caller's credentials: see `src/index.ts`).
 * @param call - The request
 * @param segments - Decoded path segments
 * @param data - Data of the caller's tenant
 */
export function applicationApi(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, resource, id, sub] = segments
  const { method } = call
  const render = (application: Readonly<StoredDocument>) => renderApplication(data, application)

  if (resource === 'applications' && segments.length === 2) {
    if (method === 'GET') {
      checkQuery('GET /application/applications', call, [...PAGING, 'name', 'owner', 'providedFor', 'subscriber', 'tenant', 'type', 'user', 'hasVersions'])
      const types = call.query.type?.split(',')
      if (types?.some((item) => item !== '' && !TYPES.includes(item.toUpperCase())) && call.query.type !== '') {
        // verified: an unknown type answers an empty first page of the default size
        return paged(data, { ...call, query: {} }, 'applications', [], '/application/applications')
      }
      const list = filtered(data, call.query)
      return list instanceof Response ? list : paged(data, call, 'applications', list, '/application/applications', { render })
    }
    if (method === 'POST') {
      checkQuery('POST /application/applications', call, [])
      return createApplication(data, (call.body ?? {}) as Record<string, unknown>)
    }
    return undefined
  }
  if (resource === 'applications' && segments.length === 3) {
    if (method === 'GET') {
      checkQuery('GET /application/applications/{id}', call, [])
      const application = findApplication(data, id!)
      return application ? Response.json(render(application)) : notFound(id!)
    }
    if (method === 'PUT') {
      checkQuery('PUT /application/applications/{id}', call, [])
      const application = findApplication(data, id!)
      if (!application) {
        return notFound(id!)
      }
      if (application.owner !== data.tenant) {
        // unverified (the probe did not change applications it did not own)
        return apiError(403, 'security/Forbidden', 'Access Denied')
      }
      return updateApplication(data, application, (call.body ?? {}) as Record<string, unknown>)
    }
    if (method === 'DELETE') {
      checkQuery('DELETE /application/applications/{id}', call, ['force'])
      const application = findApplication(data, id!)
      if (!application) {
        return noSuchApplication(id!)
      }
      if (application.owner !== data.tenant) {
        // unverified (the probe did not delete applications it did not own)
        return apiError(403, 'security/Forbidden', 'Access Denied')
      }
      deleteApplication(data, id!)
      return new Response(null, { status: 204 })
    }
    return undefined
  }
  if (resource === 'applications' && sub === 'bootstrapUser' && segments.length === 4 && method === 'GET') {
    checkQuery('GET /application/applications/{id}/bootstrapUser', call, [])
    const application = findApplication(data, id!)
    if (!application) {
      return notFound(id!)
    }
    if (application.owner !== data.tenant) {
      return apiError(403, 'applications/Forbidden', 'Can not get bootstrap user. Application owner does not match with authorized tenant')
    }
    if (application.type !== 'MICROSERVICE') {
      return apiError(400, 'applications/Bad Request', 'Can not get bootstrap user. Application is not a microservice')
    }
    return Response.json(bootstrapUser(data, application))
  }
  if (segments.length === 3 && method === 'GET') {
    const lists: Record<string, [string, C8yEndpoint] | undefined> = { applicationsByName: ['name', 'GET /application/applicationsByName/{name}'], applicationsByOwner: ['owner', 'GET /application/applicationsByOwner/{tenantId}'], applicationsByTenant: ['tenant', 'GET /application/applicationsByTenant/{tenantId}'], applicationsByUser: ['user', 'GET /application/applicationsByUser/{username}'] }
    const by = Object.hasOwn(lists, resource!) ? lists[resource!] : undefined
    if (!by) {
      return undefined
    }
    checkQuery(by[1], call, PAGING)
    if (by[0] === 'user' && !data.users.has(id!)) {
      // verified: a platform bug
      return apiError(500, 'general/internalError', `Error creating bean with name 'applicationsByUserCollectionResource': Error retrieving user ${id}`)
    }
    const list = filtered(data, { [by[0]]: id! }) as Array<Readonly<StoredDocument>>
    // verified: the links point to the plain list, without the filter
    const { currentPage, pageSize, withTotalElements, withTotalPages } = call.query
    const paging = Object.fromEntries(Object.entries({ currentPage, pageSize, withTotalElements, withTotalPages }).filter(([, value]) => value !== undefined)) as Record<string, string>
    return paged(data, { ...call, query: paging }, 'applications', list, '/application/applications', { render })
  }
  return undefined
}

function createApplication(data: TenantData, body: Record<string, unknown>): Response {
  // verified: checked in this order, one at a time
  for (const field of ['key', 'name', 'type']) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      return apiError(422, 'undefined/validationError', `${field} is required`)
    }
  }
  if (!TYPES.includes(String(body.type))) {
    return apiError(422, 'undefined/validationError', 'type invalid value')
  }
  const visible = visibleApplications(data)
  for (const field of ['name', 'key'] as const) {
    if (visible.some((application) => application[field] === body[field])) {
      return apiError(409, 'applications/Duplicate', `Application for tenant ${data.tenant} with properties ( ${field}:${String(body[field])} ) already exists or is subscribed`)
    }
  }
  if (body.contextPath !== undefined && body.contextPath !== null && visible.some((application) => application.type === body.type && application.contextPath === body.contextPath)) {
    return apiError(409, 'applications/Duplicate', `${String(body.type)} Application for tenant ${data.tenant} with properties ( contextPath:${String(body.contextPath)} ) already exists or is subscribed`)
  }
  if (body.type === 'HOSTED' && (body.contextPath === undefined || body.contextPath === null)) {
    // verified: no message
    return Response.json({ error: 'Invalid value for contextPath argument! Value cannot be null!/Invalid Data', info: 'https://cumulocity.com/api/core/' }, { status: 422 })
  }
  const application = buildApplication(data, body)
  data.applications.set(application.id, application)
  return Response.json(renderApplication(data, application), { status: 201 })
}

/**
 * Changes an application (`PUT /application/applications/{id}`, and the
 * bootstrap user's `PUT /application/currentApplication`): every field but
 * `id`, `owner`, `self`, and `manifest`; `type` answers 422 (verified).
 * @param data - Owner tenant
 * @param application - Stored application
 * @param body - Request body
 */
export function updateApplication(data: TenantData, application: Readonly<StoredDocument>, body: Record<string, unknown>): Response {
  if (body.type !== undefined && body.type !== null) {
    return apiError(422, 'undefined/validationError', 'type is not allowed here')
  }
  // verified: the manifest stays as it is
  const { id: _id, owner: _owner, self: _self, type: _type, manifest: _manifest, ...fields } = body
  const next: StoredDocument = { ...application }
  for (const [field, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      next[field] = clone(value)
    }
  }
  data.applications.set(application.id, next)
  return Response.json(renderApplication(data, next))
}

/**
 * Answers `/tenant/tenants/{tenantId}/applications/**` (verified on a tenant
 * that is not the management tenant): the list answers 403 even for the own
 * tenant; an admin subscribes and unsubscribes the own tenant. Another
 * tenant answers 403 (unverified).
 * @param call - The request
 * @param segments - Decoded path segments
 * @param data - Data of the caller's tenant
 */
export function tenantApplications(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, , tenantId, , applicationId] = segments
  const { method } = call
  if (segments.length === 4 && method === 'GET') {
    checkQuery('GET /tenant/tenants/{tenantId}/applications', call, PAGING)
    return apiError(403, 'security/Forbidden', 'Access Denied')
  }
  if (segments.length === 4 && method === 'POST') {
    checkQuery('POST /tenant/tenants/{tenantId}/applications', call, [])
    if (tenantId !== data.tenant) {
      return apiError(403, 'security/Forbidden', 'Access Denied')
    }
    const reference = ((call.body as { application?: { self?: unknown, id?: unknown } } | undefined)?.application ?? {})
    const id = reference.id ?? (typeof reference.self === 'string' ? reference.self.split('/').pop() : undefined)
    if (id === undefined || id === null || id === '') {
      return apiError(422, 'tenant/Unprocessable Entity', 'Application self or id must not be empty!')
    }
    const application = findApplication(data, String(id))
    if (!application) {
      return noSuchApplication(String(id))
    }
    if (!subscribe(data, application)) {
      return apiError(409, 'tenants/Duplicate', `Application with id ID [type=com_cumulocity_model_idtype_GId, value=${application.id}] is already assigned to the tenant ${data.tenant}`)
    }
    // verified: the platform builds a broken self link here
    const host = new URL(data.world.baseUrl).host
    return Response.json({ self: `${new URL(data.world.baseUrl).origin}/http:/${host}/tenant/tenants/${data.tenant}/${application.id}`, application: renderApplication(data, findApplication(data, application.id)!) }, { status: 201 })
  }
  if (segments.length === 5 && method === 'DELETE') {
    checkQuery('DELETE /tenant/tenants/{tenantId}/applications/{applicationId}', call, [])
    if (tenantId !== data.tenant) {
      return apiError(403, 'security/Forbidden', 'Access Denied')
    }
    if (!unsubscribe(data, applicationId!)) {
      return apiError(404, 'tenants/Not Found', `Application with id ${applicationId} is NOT assigned to the tenant ${data.tenant}`)
    }
    return new Response(null, { status: 204 })
  }
  return undefined
}

/**
 * The application references of `GET /tenant/currentTenant`: the
 * subscribed applications, with an `http://` self link (verified).
 * @param data - Tenant data
 */
export function applicationReferences(data: TenantData): Array<Record<string, unknown>> {
  const base = data.world.baseUrl.replace(/^https:/, 'http:')
  return visibleApplications(data)
    .filter((application) => data.applicationSubscriptions.has(application.id))
    .map((application) => ({ self: `${base}/application/applications/${application.id}`, application: renderApplication(data, application) }))
}
