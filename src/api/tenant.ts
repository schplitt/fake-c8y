/**
 * Tenant API: the current tenant, tenant options, and system options.
 */
import type { C8yRequest } from '../types'
import type { TenantData } from '../store'
import { optionKey } from '../store'
import { toHex } from '../utils'
import { apiError, checkQuery, paged } from './http'
import { auditOptionDeleted } from './audit'
import { applicationOfCredentials, applicationReferences, settingsCategoryOf } from './applications'
import { statisticsApi } from './statistics'
import { loginOptionsApi, tenantsApi } from './tenant-admin'

/**
 * Read-only system options `GET /tenant/system/options` answers with: a
 * subset of what an eu-latest tenant returns.
 */
export const SYSTEM_OPTIONS: ReadonlyArray<{ category: string, key: string, value: string }> = [
  // verified on eu-latest, in this order (a subset)
  { category: 'password', key: 'enforce.strength', value: 'true' },
  { category: 'system', key: 'version', value: '2026.407.0' },
  { category: 'reportMailer', key: 'available', value: 'false' },
  { category: 'two-factor-authentication', key: 'enabled', value: 'false' },
  { category: 'two-factor-authentication', key: 'tenant-scope-settings.enabled', value: 'true' },
  { category: 'two-factor-authentication', key: 'logout-on-browser-termination', value: 'false' },
  { category: 'support-user', key: 'enabled', value: 'true' },
  { category: 'support', key: 'url', value: 'https://cumulocity.com/docs/additional-resources/contacting-support/' },
  { category: 'authentication', key: 'badRequestCounter', value: '100' },
  { category: 'encoding', key: 'test', value: 'Löwenfürsąóę' },
  { category: 'files', key: 'max.size', value: '524288000' },
  { category: 'device-control', key: 'bulkoperation.creationramp', value: '1.0' },
  { category: 'device-control', key: 'bulkoperation.maxcreationramp', value: '3600.0' },
  { category: 'remoteaccess', key: 'pass-through.enabled', value: 'false' },
  { category: 'device-registration', key: 'security-token.policy', value: 'IGNORED' },
  { category: 'application', key: 'versions.limit', value: '20' },
  { category: 'ssl', key: 'shared-truststore.enabled', value: 'false' },
]

const JACKSON_SOURCE = '\n at [Source: REDACTED (`StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION` disabled); line: 1, column: 1]'

/**
 * 400 for a single option's `value` that is an object or an array (verified
 * for objects; the column in the message is not emulated).
 * @param value - The value from the body
 */
function valueNotText(value: unknown): Response | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  const token = Array.isArray(value) ? 'Array value (token `JsonToken.START_ARRAY`)' : 'Object value (token `JsonToken.START_OBJECT`)'
  return apiError(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`java.lang.String\` from ${token}${JACKSON_SOURCE} (through reference chain: com.cumulocity.rest.representation.tenant.OptionRepresentation["value"])`)
}

/**
 * A JSON value as the platform writes it as text: options set in bulk store
 * objects as `{a=1}` and lists as `[1, a]` (verified).
 * @param value - JSON value
 */
function javaText(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(javaText).join(', ')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).map(([name, item]) => `${name}=${javaText(item)}`).join(', ')}}`
  }
  return String(value)
}

/**
 * A JSON object in the given key order (`Response.json` would put integer-like keys first).
 * @param entries - Keys and values in order
 */
function orderedJson(entries: Array<[string, unknown]>): Response {
  const text = `{${entries.map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`).join(',')}}`
  return new Response(text, { headers: { 'content-type': 'application/json' } })
}

function optionNotFound(category: string, key: string): Response {
  return apiError(404, 'options/Not Found', `Unable to find option by given key: ${category}/${key}`)
}

/**
 * The value a write answers with: `credentials.` options come back encrypted.
 * @param key - Option key
 * @param value - Stored value
 */
function encrypted(key: string, value: string): string {
  return key.startsWith('credentials.') ? toHex(`fake-cipher:${value}`) : value
}

/**
 * The value a read answers with: `credentials.` options read `<<Encrypted>>`,
 * except in a microservice's own settings category, which the platform
 * decrypts for that microservice: the world's category, and the category of
 * the application whose service or bootstrap user sends the request
 * (verified for other categories).
 * @param call - The request
 * @param data - Tenant data
 * @param category - Option category
 * @param key - Option key
 * @param value - Stored value
 */
function readable(call: C8yRequest, data: TenantData, category: string, key: string, value: string): string {
  if (!key.startsWith('credentials.') || category === data.world.settingsCategory) {
    return value
  }
  const own = call.user === undefined ? undefined : applicationOfCredentials([data], call.tenant, call.user)
  return own && settingsCategoryOf(own.application) === category ? value : '<<Encrypted>>'
}

/**
 * An option as the API returns it; an option stored without a value has no
 * `value` (verified).
 * @param data - Tenant data
 * @param category - Option category
 * @param key - Option key
 * @param value - The value to show, or `null`
 */
function renderOption(data: TenantData, category: string, key: string, value: string | null): Record<string, string> {
  const self = `${new URL(data.world.baseUrl).origin}/tenant/options/${encodeURIComponent(category)}/${encodeURIComponent(key)}`
  return { self, category, key, ...(value === null ? {} : { value }) }
}

/**
 * Stores an option. A missing or `null` value keeps the current one, or
 * stores the option without a value (verified for single writes).
 * @param data - Tenant data
 * @param category - Option category
 * @param key - Option key
 * @param value - Value from the request body
 * @returns The stored value
 */
function setOption(data: TenantData, category: string, key: string, value: unknown): string | null {
  const id = optionKey(category, key)
  const stored = value === undefined || value === null ? (data.options.get(id) ?? null) : String(value)
  data.options.set(id, stored)
  return stored
}

/**
 * Tenant API: `/tenant/currentTenant`, `/tenant/options/**`, and
 * `/tenant/system/options/**`.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data of the request's tenant
 */
export function tenantApi(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const { method } = call
  const [, resource] = segments

  if (resource === 'currentTenant' && segments.length === 2 && method === 'GET') {
    checkQuery('GET /tenant/currentTenant', call, ['withParent'])
    const origin = new URL(data.world.baseUrl).origin
    return Response.json({
      name: data.tenant,
      // verified: only with withParent=true; the fake's tenants have no parent
      // tenant, so it names the management tenant
      ...(call.query.withParent === 'true' ? { parent: 'management' } : {}),
      domainName: new URL(data.world.baseUrl).host,
      allowCreateTenants: false,
      // the fake does not emulate the application API
      applications: { self: `${origin.replace(/^https:/, 'http:')}/tenant/tenants/${data.tenant}/applications`, references: applicationReferences(data) },
      // verified: without `/tenant`
      self: `${origin}/currentTenant`,
      customProperties: {},
    })
  }

  if (resource === 'system' && segments[2] === 'options' && method === 'GET') {
    const [, , , category, key] = segments
    if (segments.length === 3) {
      checkQuery('GET /tenant/system/options', call, [])
      // verified: no paging, no links
      return Response.json({ options: SYSTEM_OPTIONS.map((option) => ({ ...option })) })
    }
    if (segments.length === 5) {
      checkQuery('GET /tenant/system/options/{category}/{key}', call, [])
      const option = SYSTEM_OPTIONS.find((item) => item.category === category && item.key === key)
      return option
        ? Response.json({ ...option })
        : apiError(404, 'options/Not Found', `Unable to find option by given key: ${category}/${key} : There is no system property for key system.${category}.${key}`)
    }
    return undefined
  }

  if (resource === 'statistics') {
    return statisticsApi(call, segments, data)
  }
  if (resource === 'tenants') {
    return tenantsApi(call, segments, data)
  }
  if (resource === 'loginOptions') {
    return loginOptionsApi(call, segments, data)
  }

  if (resource !== 'options') {
    return undefined
  }
  return options(call, segments, data)
}

function options(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const { method } = call
  const [, , category, key, editable] = segments
  const body = call.body as Record<string, unknown> | undefined

  if (category === undefined) {
    if (method === 'GET') {
      checkQuery('GET /tenant/options', call, ['currentPage', 'pageSize', 'withTotalPages'])
      // verified: like the binaries list, always `totalPages` and no `next`
      // after the last page
      return paged(data, call, 'options', [...data.options], '/tenant/options', {
        statistics: 'binaries',
        // verified: the user API's code for an invalid paging parameter
        errorCode: 'REST API/Unprocessable Entity',
        render: ([id, value]) => {
          const [optionCategory, optionKey] = id.split('\u0000') as [string, string]
          return renderOption(data, optionCategory, optionKey, value === null ? null : readable(call, data, optionCategory, optionKey, value))
        },
      })
    }
    if (method === 'POST') {
      checkQuery('POST /tenant/options', call, [])
      const { category: newCategory, key: newKey } = body ?? {}
      if (newCategory === undefined || newCategory === null || newKey === undefined || newKey === null || newCategory === '' || newKey === '') {
        // verified
        return apiError(422, 'options/Invalid Data', `OptionId ${String(newCategory ?? null)}/${String(newKey ?? null)} must be fully specified!`)
      }
      const notText = valueNotText(body?.value)
      if (notText) {
        return notText
      }
      // verified: an existing option is overwritten
      const stored = setOption(data, String(newCategory), String(newKey), body?.value)
      return Response.json(renderOption(data, String(newCategory), String(newKey), stored === null ? null : encrypted(String(newKey), stored)))
    }
    return undefined
  }

  if (key === undefined) {
    if (method === 'GET') {
      checkQuery('GET /tenant/options/{category}', call, [])
      const prefix = optionKey(category, '')
      // verified: in the order the options were created
      const result: Array<[string, string | null]> = []
      for (const [id, value] of data.options) {
        if (id.startsWith(prefix)) {
          const name = id.slice(prefix.length)
          result.push([name, value === null ? null : readable(call, data, category, name, value)])
        }
      }
      return orderedJson(result)
    }
    if (method === 'PUT') {
      checkQuery('PUT /tenant/options/{category}', call, [])
      // verified: `null` stores the option without a value; the response
      // echoes the body as sent
      for (const [name, value] of Object.entries(body ?? {})) {
        data.options.set(optionKey(category, name), value === null ? null : javaText(value))
      }
      return Response.json(body ?? {})
    }
    return undefined
  }

  if (editable === 'editable' && segments.length === 5) {
    if (method !== 'PUT') {
      return undefined
    }
    checkQuery('PUT /tenant/options/{category}/{key}/editable', call, [])
    // verified: only the management tenant may change it
    return apiError(403, 'security/Forbidden', 'Access Denied')
  }
  if (segments.length !== 4) {
    return undefined
  }
  const id = optionKey(category, key)
  if (method === 'GET') {
    checkQuery('GET /tenant/options/{category}/{key}', call, [])
    if (!data.options.has(id)) {
      return optionNotFound(category, key)
    }
    const value = data.options.get(id)!
    return Response.json(renderOption(data, category, key, value === null ? null : readable(call, data, category, key, value)))
  }
  if (method === 'PUT') {
    checkQuery('PUT /tenant/options/{category}/{key}', call, [])
    const notText = valueNotText(body?.value)
    if (notText) {
      return notText
    }
    const stored = setOption(data, category, key, body?.value)
    return Response.json(renderOption(data, category, key, stored === null ? null : encrypted(key, stored)))
  }
  if (method === 'DELETE') {
    checkQuery('DELETE /tenant/options/{category}/{key}', call, [])
    if (!data.options.delete(id)) {
      // verified
      return apiError(404, 'options/Not Found', `Cannot delete option. : Unable to find option by given key: ${category}/${key}`)
    }
    auditOptionDeleted(data, category, key)
    return new Response(null, { status: 204 })
  }
  return undefined
}
