import { Buffer } from 'node:buffer'
import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { eventually } from '../helpers'

interface Answer {
  status: number
  body: any
  /**
   * The content type of the answer
   */
  type: string | null
}

const vendor = (name: string) => `application/vnd.com.nsn.cumulocity.${name}+json;charset=UTF-8;ver=0.9`

async function api(client: Client, method: string, path: string, body?: unknown, auth?: { login: string, password: string }): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'accept': 'application/json' }
  if (auth) {
    headers.authorization = `Basic ${Buffer.from(`${auth.login}:${auth.password}`).toString('base64')}`
  }
  const init = { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }
  // other credentials than the client's: the client would add its own
  const res = auth ? await fetch(`${client.core.baseUrl}${path}`, init) : await client.core.fetch(path, init)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined, type: res.headers.get('content-type') }
}

/**
 * Creates applications for a scenario and deletes them (with their
 * subscriptions) afterwards, also when the scenario fails.
 * @param client
 * @param run
 */
async function withApplications(client: Client, run: (create: (body: Record<string, unknown>) => Promise<Answer>) => Promise<void>): Promise<void> {
  const created: string[] = []
  try {
    await run(async (body) => {
      const answer = await api(client, 'POST', '/application/applications', body)
      if (answer.body?.id) {
        created.push(answer.body.id)
      }
      return answer
    })
  } finally {
    for (const id of created) {
      await api(client, 'DELETE', `/application/applications/${id}`)
    }
  }
}

const ids = (answer: Answer): string[] => answer.body.applications.map((application: { id: string }) => application.id)
const short = (unique: string) => unique.replace(/\W/g, '').slice(-12).toLowerCase()

export const applicationScenarios: ContractScenario[] = [
  {
    name: 'applications: list order and filters',
    verifies: ['applications-list-order', 'applications-list-filters'],
    async run({ client, tenant, unique }) {
      const u = `fk${short(unique)}`
      await withApplications(client, async (create) => {
        const hosted = (await create({ name: `${u}-h`, key: `${u}-h-key`, type: 'HOSTED', contextPath: `${u}-h`, resourcesUrl: '/' })).body
        const external = (await create({ name: `${u}-e`, key: `${u}-e-key`, type: 'EXTERNAL', externalUrl: 'https://example.com' })).body
        const list = async (query: string) => api(client, 'GET', `/application/applications?pageSize=2000&${query}`)

        // ordered by id as text
        const all = ids(await list(''))
        expect(all).toEqual([...all].sort())
        expect(all).toEqual(expect.arrayContaining([hosted.id, external.id]))
        // a default application of the platform is listed
        const cockpits = (await list('name=cockpit')).body.applications
        expect(cockpits.some((application: any) => application.owner.tenant.id === 'management')).toBe(true)

        // name: exact and case-sensitive, no wildcards, no lists
        expect(ids(await list(`name=${u}-h`))).toEqual([hosted.id])
        expect(ids(await list(`name=${u.toUpperCase()}-H`))).toEqual([])
        expect(ids(await list(`name=${u}-*`))).toEqual([])
        expect(ids(await list(`name=${u}-h,${u}-e`))).toEqual([])
        // type: case-insensitive, a comma list without spaces
        const hostedIds = ids(await list('type=hosted'))
        expect(hostedIds).toEqual(ids(await list('type=HOSTED')))
        expect(hostedIds).toContain(hosted.id)
        expect(hostedIds).not.toContain(external.id)
        expect(ids(await list('type=HOSTED,EXTERNAL'))).toEqual(expect.arrayContaining([hosted.id, external.id]))
        expect(ids(await list('type=HOSTED, EXTERNAL'))).not.toContain(external.id)
        // an unknown type: an empty first page of the default size
        const unknownType = await list('type=FOO')
        expect(unknownType.body.applications).toEqual([])
        expect(unknownType.body.statistics.pageSize).toBe(5)

        // owner, subscriber, providedFor, tenant: only the own tenant matches
        expect(ids(await list(`owner=${tenant}`))).toEqual(expect.arrayContaining([hosted.id, external.id]))
        expect(ids(await list('owner=management'))).toEqual([])
        expect(ids(await list(`subscriber=${tenant}`))).not.toContain(hosted.id)
        expect(ids(await list(`subscriber=${tenant}`))).toContain(cockpits.find((application: any) => application.owner.tenant.id === 'management').id)
        expect(ids(await list(`tenant=${tenant}`))).toEqual(all)
        expect(ids(await list('tenant=management'))).toEqual([])
        const provided = ids(await list(`providedFor=${tenant}`))
        expect(provided).not.toContain(hosted.id)
        expect(provided.length).toBeGreaterThan(0)
        // user: a known user sees the list, an unknown one is a 404
        const unknownUser = await list(`user=${u}-nouser`)
        expect(unknownUser.status).toBe(404)
        expect(unknownUser.body.error).toBe('application/User not found')
        // contextPath and key are ignored, hasVersions with another value too
        expect(ids(await list(`contextPath=${u}-h&key=${u}-h-key&hasVersions=x`))).toEqual(all)
        // availability filters, although the spec does not list it
        expect(ids(await list('availability=PRIVATE'))).toEqual(expect.arrayContaining([hosted.id, external.id]))
        expect(ids(await list('availability=MARKET'))).not.toContain(hosted.id)
        expect(ids(await list('availability=MARKET'))).toContain(cockpits.find((application: any) => application.owner.tenant.id === 'management').id)
        expect(ids(await list('hasVersions=true'))).not.toContain(hosted.id)
        expect(ids(await list('hasVersions=false'))).toContain(hosted.id)
      })
    },
  },
  {
    name: 'applications: the by-name, by-owner, by-tenant, and by-user lists',
    verifies: ['applications-by-lists'],
    async run({ client, tenant, unique }) {
      const u = `fk${short(unique)}`
      await withApplications(client, async (create) => {
        const hosted = (await create({ name: `${u}-h`, key: `${u}-h-key`, type: 'HOSTED', contextPath: `${u}-h`, resourcesUrl: '/' })).body
        const byName = await api(client, 'GET', `/application/applicationsByName/${u}-h`)
        expect(ids(byName)).toEqual([hosted.id])
        expect(byName.type).toBe(vendor('applicationcollection'))
        // the links point to the plain list, without the filter
        expect(byName.body.self).toMatch(/\/application\/applications\?/)
        expect(byName.body.self).not.toContain(u)
        expect(byName.body.statistics).toEqual({ pageSize: 5, currentPage: 1 })
        expect(ids(await api(client, 'GET', `/application/applicationsByOwner/${tenant}?pageSize=2000`))).toContain(hosted.id)
        expect(ids(await api(client, 'GET', '/application/applicationsByOwner/management'))).toEqual([])
        expect(ids(await api(client, 'GET', `/application/applicationsByTenant/${tenant}?pageSize=2000`))).toContain(hosted.id)
        const me = (await api(client, 'GET', '/user/currentUser')).body.userName
        expect(ids(await api(client, 'GET', `/application/applicationsByUser/${encodeURIComponent(me)}?pageSize=2000`))).toContain(hosted.id)
        // a platform bug: an unknown user is a 500
        const unknown = await api(client, 'GET', `/application/applicationsByUser/${u}-nouser`)
        expect(unknown.status).toBe(500)
        expect(unknown.body.error).toBe('general/internalError')
      })
    },
  },
  {
    name: 'applications: create, validate, update, delete',
    verifies: ['applications-create', 'applications-update', 'applications-not-found', 'application-optional-fields'],
    async run({ client, tenant, unique }) {
      const u = `fk${short(unique)}`
      await withApplications(client, async (create) => {
        const hosted = await create({ name: `${u}-h`, key: `${u}-h-key`, type: 'HOSTED', contextPath: `${u}-h`, resourcesUrl: '/' })
        expect(hosted.status).toBe(201)
        expect(hosted.type).toBe(vendor('application'))
        expect(hosted.body).toMatchObject({ name: `${u}-h`, key: `${u}-h-key`, type: 'HOSTED', availability: 'PRIVATE', owner: { tenant: { id: tenant } }, contextPath: `${u}-h`, resourcesUrl: '/' })
        expect(Object.keys(hosted.body)).toEqual(['id', 'name', 'key', 'type', 'availability', 'owner', 'contextPath', 'resourcesUrl', 'self'])
        const external = await create({ name: `${u}-e`, key: `${u}-e-key`, type: 'EXTERNAL', externalUrl: 'https://example.com' })
        expect(external.status).toBe(201)
        expect(external.body.externalUrl).toBe('https://example.com')
        // no version without an upload, no resourcesUrl on an external application
        expect(hosted.body.activeVersionId).toBeUndefined()
        expect(external.body.resourcesUrl).toBeUndefined()

        // a microservice without a binary: the manifest of the request is dropped
        const ms = await create({ name: `${u}-m`, key: `${u}-m-key`, type: 'MICROSERVICE', contextPath: `${u}-m`, requiredRoles: ['ROLE_INVENTORY_READ'], manifest: { requiredRoles: ['ROLE_ALARM_READ'], version: '1.0.0' } })
        expect(ms.status).toBe(201)
        const stored = await api(client, 'GET', `/application/applications/${ms.body.id}`)
        expect(stored.type).toBe(vendor('application'))
        expect(stored.body.manifest).toEqual({ requiredRoles: [], roles: [], billingMode: 'RESOURCES', deploymentMethod: 'CORE', noAppSwitcher: true })
        expect(stored.body.requiredRoles).toEqual(['ROLE_INVENTORY_READ'])
        expect(stored.body.roles).toEqual([])

        // validation, one field at a time
        const failures: Array<[Record<string, unknown>, number, string, string?]> = [
          [{}, 422, 'undefined/validationError', 'key is required'],
          [{ key: `${u}-v` }, 422, 'undefined/validationError', 'type is required'],
          [{ key: `${u}-v`, name: `${u}-v` }, 422, 'undefined/validationError', 'type is required'],
          [{ key: `${u}-v`, type: 'HOSTED' }, 422, 'undefined/validationError', 'name is required'],
          [{ key: `${u}-v`, type: 'FOO' }, 422, 'undefined/validationError', 'name is required'],
          [{ key: `${u}-v`, name: `${u}-v`, type: 'FOO' }, 422, 'undefined/validationError', 'type invalid value'],
          [{ key: `${u}-v`, name: `${u}-h`, type: 'HOSTED', contextPath: `${u}-v` }, 409, 'applications/Duplicate', `Application for tenant ${tenant} with properties ( name:${u}-h ) already exists or is subscribed`],
          [{ key: `${u}-h-key`, name: `${u}-v`, type: 'HOSTED', contextPath: `${u}-v` }, 409, 'applications/Duplicate', `Application for tenant ${tenant} with properties ( key:${u}-h-key ) already exists or is subscribed`],
          [{ key: `${u}-v`, name: `${u}-v`, type: 'HOSTED', contextPath: `${u}-h`, resourcesUrl: '/' }, 409, 'applications/Duplicate', `HOSTED Application for tenant ${tenant} with properties ( contextPath:${u}-h ) already exists or is subscribed`],
          [{ key: `${u}-v`, name: `${u}-v`, type: 'HOSTED' }, 422, 'Invalid value for contextPath argument! Value cannot be null!/Invalid Data'],
        ]
        for (const [body, status, error, message] of failures) {
          const answer = await create(body)
          expect([JSON.stringify(body), answer.status, answer.body.error, answer.body.message]).toEqual([JSON.stringify(body), status, error, message])
        }

        // update: every field but the type; an id in the body is ignored
        const id = hosted.body.id
        const renamed = await api(client, 'PUT', `/application/applications/${id}`, { id: '1', name: `${u}-h2`, key: `${u}-h2-key`, contextPath: `${u}-h2`, description: 'd' })
        expect(renamed.status).toBe(200)
        expect(renamed.type).toBe(vendor('application'))
        expect(renamed.body).toMatchObject({ id, name: `${u}-h2`, key: `${u}-h2-key`, contextPath: `${u}-h2`, description: 'd', type: 'HOSTED' })
        const type = await api(client, 'PUT', `/application/applications/${id}`, { type: 'EXTERNAL' })
        expect([type.status, type.body.error, type.body.message]).toEqual([422, 'undefined/validationError', 'type is not allowed here'])

        // not found: reads and updates answer one message, deletes another
        for (const method of ['GET', 'PUT']) {
          const missing = await api(client, method, '/application/applications/999999999', method === 'PUT' ? { description: 'x' } : undefined)
          expect([method, missing.status, missing.body.error, missing.body.message]).toEqual([method, 404, 'applications/Not Found', 'Error occurred when trying to find an Application for id ID [type=com_cumulocity_model_idtype_GId, value=999999999] : Could not find application by ID 999999999'])
        }
        expect((await api(client, 'DELETE', `/application/applications/${external.body.id}`)).status).toBe(204)
        const gone = await api(client, 'DELETE', `/application/applications/${external.body.id}`)
        expect([gone.status, gone.body.error, gone.body.message]).toEqual([404, 'application/Not Found', `Could not find application by ID ${external.body.id}`])
        expect((await api(client, 'GET', `/application/applications/${external.body.id}`)).status).toBe(404)
      })
    },
  },
  {
    name: 'applications: the own tenant subscribes and unsubscribes',
    verifies: ['applications-subscriptions', 'tenant-applications-list-403', 'current-tenant-application-references'],
    async run({ client, tenant, unique }) {
      const u = `fk${short(unique)}`
      await withApplications(client, async (create) => {
        const hosted = (await create({ name: `${u}-h`, key: `${u}-h-key`, type: 'HOSTED', contextPath: `${u}-h`, resourcesUrl: '/' })).body
        const ms = (await create({ name: `${u}-m`, key: `${u}-m-key`, type: 'MICROSERVICE', contextPath: `${u}-m` })).body
        const path = `/tenant/tenants/${tenant}/applications`
        // the list answers 403, also for the own tenant
        expect((await api(client, 'GET', path)).status).toBe(403)

        const subscribed = await api(client, 'POST', path, { application: { self: `/application/applications/${hosted.id}` } })
        expect(subscribed.status).toBe(201)
        expect(subscribed.type).toBe(vendor('applicationreference'))
        // the application becomes MARKET; the self link is broken
        expect(subscribed.body.application).toMatchObject({ id: hosted.id, availability: 'MARKET' })
        expect(subscribed.body.self).toMatch(new RegExp(`/http:/[^/]+/tenant/tenants/${tenant}/${hosted.id}$`))
        expect((await api(client, 'POST', path, { application: { id: ms.id } })).status).toBe(201)
        expect((await api(client, 'GET', `/application/applications/${hosted.id}`)).body.availability).toBe('MARKET')

        const again = await api(client, 'POST', path, { application: { id: hosted.id } })
        expect([again.status, again.body.error, again.body.message]).toEqual([409, 'tenants/Duplicate', `Application with id ID [type=com_cumulocity_model_idtype_GId, value=${hosted.id}] is already assigned to the tenant ${tenant}`])
        const missing = await api(client, 'POST', path, { application: { id: '999999999' } })
        expect([missing.status, missing.body.error, missing.body.message]).toEqual([404, 'application/Not Found', 'Could not find application by ID 999999999'])
        const empty = await api(client, 'POST', path, {})
        expect([empty.status, empty.body.error, empty.body.message]).toEqual([422, 'tenant/Unprocessable Entity', 'Application self or id must not be empty!'])

        // subscribed: in the subscriber filter (not providedFor: the tenant owns it) and in the current tenant
        const list = (query: string) => api(client, 'GET', `/application/applications?pageSize=2000&${query}`).then(ids)
        expect(await list(`subscriber=${tenant}`)).toEqual(expect.arrayContaining([hosted.id, ms.id]))
        expect(await list(`providedFor=${tenant}`)).not.toContain(hosted.id)
        const current = (await api(client, 'GET', '/tenant/currentTenant')).body.applications
        expect(current.self).toMatch(new RegExp(`^http://.*/tenant/tenants/${tenant}/applications$`))
        const reference = current.references.find((item: any) => item.application.id === hosted.id)
        expect(Object.keys(reference)).toEqual(['self', 'application'])
        expect(reference.self).toMatch(new RegExp(`^http://.*/application/applications/${hosted.id}$`))

        expect((await api(client, 'DELETE', `${path}/${hosted.id}`)).status).toBe(204)
        const notAssigned = await api(client, 'DELETE', `${path}/${hosted.id}`)
        expect([notAssigned.status, notAssigned.body.error, notAssigned.body.message]).toEqual([404, 'tenants/Not Found', `Application with id ${hosted.id} is NOT assigned to the tenant ${tenant}`])
        expect(await list(`subscriber=${tenant}`)).not.toContain(hosted.id)
        // deleting a subscribed application ends the subscription
        expect((await api(client, 'DELETE', `/application/applications/${ms.id}`)).status).toBe(204)
        expect(await list(`subscriber=${tenant}`)).not.toContain(ms.id)
      })
    },
  },
  {
    name: 'applications: a microservice\'s bootstrap and service users',
    verifies: ['applications-bootstrap-user', 'applications-service-user', 'current-application-credentials', 'current-application-settings'],
    async run({ client, tenant, unique }) {
      const u = `fk${short(unique)}`
      const options: string[] = []
      try {
        await withApplications(client, async (create) => {
          const hosted = (await create({ name: `${u}-h`, key: `${u}-h-key`, type: 'HOSTED', contextPath: `${u}-h`, resourcesUrl: '/' })).body
          const ms = (await create({ name: `${u}-m`, key: `${u}-m-key`, type: 'MICROSERVICE', contextPath: `${u}-c`, requiredRoles: ['ROLE_INVENTORY_READ'] })).body
          const notMicroservice = await api(client, 'GET', `/application/applications/${hosted.id}/bootstrapUser`)
          expect([notMicroservice.status, notMicroservice.body.error, notMicroservice.body.message]).toEqual([400, 'applications/Bad Request', 'Can not get bootstrap user. Application is not a microservice'])
          const cockpit = (await api(client, 'GET', '/application/applications?name=cockpit&pageSize=2000')).body.applications.find((application: any) => application.owner.tenant.id === 'management')
          const foreign = await api(client, 'GET', `/application/applications/${cockpit.id}/bootstrapUser`)
          expect([foreign.status, foreign.body.error]).toEqual([403, 'applications/Forbidden'])

          const bootstrap = await api(client, 'GET', `/application/applications/${ms.id}/bootstrapUser`)
          expect(bootstrap.status).toBe(200)
          expect(bootstrap.type).toBe(vendor('user'))
          expect(bootstrap.body).toEqual({ tenant, name: `servicebootstrap_${u}-m`, password: expect.stringMatching(/^.{32}$/) })
          const asBootstrap = { login: `${tenant}/${bootstrap.body.name}`, password: bootstrap.body.password }

          // settings: the options of the context path's category, before any subscription
          for (const [category, key, value] of [[`${u}-c`, 'plain', 'c1'], [`${u}-c`, 'credentials.secret', 's1'], [`${u}-m`, 'byname', 'n1']]) {
            expect((await api(client, 'POST', '/tenant/options', { category, key, value })).status).toBeLessThan(300)
            options.push(`${category}/${key}`)
          }
          const settings = await api(client, 'GET', '/application/currentApplication/settings', undefined, asBootstrap)
          expect({ status: settings.status, body: settings.body }).toEqual({ status: 200, body: { 'plain': 'c1', 'credentials.secret': 's1' } })
          expect(settings.type).toBe(vendor('option'))

          // a PUT keeps a top-level settingsCategory without using it, and ignores the manifest
          const put = await api(client, 'PUT', `/application/applications/${ms.id}`, { settingsCategory: `${u}-x`, manifest: { settings: [{ key: 'plain', defaultValue: 'd' }] } })
          expect([put.status, put.body.settingsCategory, put.body.manifest.settings]).toEqual([200, `${u}-x`, undefined])
          expect(await api(client, 'GET', '/application/currentApplication/settings', undefined, asBootstrap)).toEqual(settings)

          // the bootstrap user: the current application, also unsubscribed
          const current = await api(client, 'GET', '/application/currentApplication', undefined, asBootstrap)
          expect(current.status).toBe(200)
          expect(current.type).toBe(vendor('application'))
          expect(current.body).toMatchObject({ id: ms.id, name: `${u}-m`, type: 'MICROSERVICE' })
          const noUsers = await api(client, 'GET', '/application/currentApplication/subscriptions', undefined, asBootstrap)
          expect(noUsers.body).toEqual({ users: [] })
          expect(noUsers.type).toBe(vendor('applicationusercollection'))
          const me = await api(client, 'GET', '/user/currentUser', undefined, asBootstrap)
          expect(me.body).toMatchObject({ id: bootstrap.body.name, userName: bootstrap.body.name, shouldResetPassword: false })
          expect(me.body.effectiveRoles.map((role: { id: string }) => role.id)).toEqual(['ROLE_SYSTEM'])
          const updated = await api(client, 'PUT', '/application/currentApplication', { description: 'by bootstrap' }, asBootstrap)
          expect([updated.status, updated.body.description]).toEqual([200, 'by bootstrap'])
          expect(updated.type).toBe(vendor('application'))

          // subscribed: a service user with the required roles
          expect((await api(client, 'POST', `/tenant/tenants/${tenant}/applications`, { application: { id: ms.id } })).status).toBe(201)
          let service: { tenant: string, name: string, password: string } | undefined
          await eventually(async () => {
            const users = (await api(client, 'GET', '/application/currentApplication/subscriptions', undefined, asBootstrap)).body.users
            service = users.find((user: { tenant: string }) => user.tenant === tenant)
            expect(service).toEqual({ tenant, name: `service_${u}-m`, password: expect.stringMatching(/^.{32}$/) })
          }, 15_000)
          const asService = { login: `${tenant}/${service!.name}`, password: service!.password }
          await eventually(async () => {
            const serviceUser = await api(client, 'GET', '/user/currentUser', undefined, asService)
            expect(serviceUser.body.effectiveRoles.map((role: { id: string }) => role.id)).toEqual(['ROLE_INVENTORY_READ', 'ROLE_SYSTEM'])
          }, 15_000)
          // the service user is not a user of the tenant
          expect((await api(client, 'GET', `/user/${tenant}/users/${service!.name}`)).status).toBe(404)
          // it reads the settings, not the application or its subscriptions
          expect(await api(client, 'GET', '/application/currentApplication/settings', undefined, asService)).toEqual(settings)
          for (const [method, path] of [['GET', '/application/currentApplication'], ['PUT', '/application/currentApplication'], ['GET', '/application/currentApplication/subscriptions']]) {
            expect([method, path, (await api(client, method!, path!, method === 'PUT' ? {} : undefined, asService)).status]).toEqual([method, path, 403])
          }
          // the bootstrap user changes the service user's roles
          await api(client, 'PUT', '/application/currentApplication', { requiredRoles: ['ROLE_INVENTORY_READ', 'ROLE_EVENT_READ'] }, asBootstrap)
          await eventually(async () => {
            const serviceUser = await api(client, 'GET', '/user/currentUser', undefined, asService)
            expect(serviceUser.body.effectiveRoles.map((role: { id: string }) => role.id)).toEqual(['ROLE_INVENTORY_READ', 'ROLE_EVENT_READ', 'ROLE_SYSTEM'])
          }, 15_000)

          // unsubscribed: the service user is gone, the bootstrap user stays
          expect((await api(client, 'DELETE', `/tenant/tenants/${tenant}/applications/${ms.id}`)).status).toBe(204)
          await eventually(async () => {
            expect((await api(client, 'GET', '/user/currentUser', undefined, asService)).status).toBe(401)
          }, 15_000)
          expect((await api(client, 'GET', '/application/currentApplication', undefined, asBootstrap)).status).toBe(200)
          // deleted: the bootstrap user is gone too
          expect((await api(client, 'DELETE', `/application/applications/${ms.id}`)).status).toBe(204)
          await eventually(async () => {
            expect((await api(client, 'GET', '/application/currentApplication', undefined, asBootstrap)).status).toBe(401)
          }, 15_000)
        })
      } finally {
        for (const option of options) {
          await api(client, 'DELETE', `/tenant/options/${option}`)
        }
      }
    },
  },
  {
    name: 'applications: a microservice is reachable only while subscribed and running',
    verifies: ['microservice-not-running-404'],
    async run({ client, tenant, unique }) {
      const u = `fk${short(unique)}`
      await withApplications(client, async (create) => {
        const ms = (await create({ name: `${u}-m`, key: `${u}-m-key`, type: 'MICROSERVICE', contextPath: `${u}-m` })).body
        const reach = async () => {
          for (const method of ['GET', 'POST']) {
            const answer = await api(client, method, `/service/${u}-m/health`, method === 'POST' ? {} : undefined)
            expect([method, answer.status, answer.body]).toEqual([method, 404, expect.objectContaining({ error: 'microservice/Not Found', message: `Microservice ${u}-m not found.` })])
          }
        }
        // not subscribed, subscribed without a binary, unsubscribed, deleted: all 404
        await reach()
        expect((await api(client, 'POST', `/tenant/tenants/${tenant}/applications`, { application: { id: ms.id } })).status).toBe(201)
        await reach()
        expect((await api(client, 'DELETE', `/tenant/tenants/${tenant}/applications/${ms.id}`)).status).toBe(204)
        await reach()
        expect((await api(client, 'DELETE', `/application/applications/${ms.id}`)).status).toBe(204)
        await reach()
      })
    },
  },
]
