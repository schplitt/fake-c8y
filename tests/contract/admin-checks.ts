import { expect } from 'vitest'
import type { Client } from '@c8y/client'

/**
 * One request of an administration scenario and what the platform answers.
 * The expectations were read from a real tenant; the scenario runs against
 * both the fake and a real tenant.
 */
export interface Check {
  m: string
  /**
   * Path with `{{tenant}}`, `{{u}}` (the scenario's prefix for the names it
   * creates), `{{me}}` (the caller's user name), and captured values (`keep`).
   */
  p: string
  b?: unknown
  /**
   * Raw body instead of `b`.
   */
  raw?: string
  /**
   * Request headers (default: JSON in and out).
   */
  h?: Record<string, string>
  /**
   * `name` or `name=field`: captures `field` (default `id`) of the response for `{{name}}`.
   */
  keep?: string
  status: number
  /**
   * Expected `error` of an error body.
   */
  error?: string
  /**
   * Expected `message`; ids are written as `<id>`, the host as `HOST`, the tenant as `TENANT`.
   */
  message?: string
  /**
   * Scalar fields of the response (`toMatchObject`).
   */
  match?: Record<string, unknown>
  /**
   * Length of the response's collection (the array-valued top-level field).
   */
  count?: number
  /**
   * Expected `Content-Length` of an empty body is not checked; this asserts the body is empty.
   */
  empty?: boolean
}

const normalize = (text: string, tenant: string) => text.replace(/(id |ID |Group |groups=)\d+/g, '$1<id>').replace(/https?:\/\/[^/\s]+/g, 'HOST').split(tenant).join('TENANT')

/**
 * Runs checks in order against the tenant of `client`. Names created by the
 * checks start with `prefix`; `cleanup` removes whatever is left.
 * @param client - The client
 * @param tenant - Tenant id
 * @param prefix - Prefix of every name the checks create
 * @param checks - The checks
 */
export async function runChecks(client: Client, tenant: string, prefix: string, checks: Check[]): Promise<void> {
  const captured: Record<string, string> = {}
  if (JSON.stringify(checks).includes('{{me}}')) {
    // the caller's user name (audit records name it)
    const res = await client.core.fetch('/user/currentUser', { headers: { accept: 'application/json' } })
    captured.me = String(((await res.json()) as { userName: string }).userName)
  }
  for (const [index, check] of checks.entries()) {
    const sub = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => name === 'tenant' ? tenant : name === 'u' ? prefix : captured[name] ?? `{{${name}}}`)
    const body = check.raw !== undefined ? sub(check.raw) : check.b === undefined ? undefined : sub(JSON.stringify(check.b))
    const headers = { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...check.h }
    const res = await client.core.fetch(sub(check.p), { method: check.m, headers, ...(body === undefined ? {} : { body }) })
    const text = await res.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {}
    const label = `#${index} ${check.m} ${sub(check.p)} ${body ?? ''}: ${text.slice(0, 300)}`
    expect(res.status, label).toBe(check.status)
    if (check.error !== undefined) {
      expect(json?.error, label).toBe(check.error)
    }
    if (check.message !== undefined) {
      expect(normalize(String(json?.message), tenant), label).toBe(normalize(sub(check.message), tenant))
    }
    if (check.empty) {
      expect(text, label).toBe('')
    }
    if (check.match) {
      expect(json, label).toMatchObject(JSON.parse(sub(JSON.stringify(check.match))))
    }
    if (check.count !== undefined) {
      const list = Object.values(json ?? {}).find((value) => Array.isArray(value)) as unknown[] | undefined
      expect(list?.length, label).toBe(check.count)
    }
    if (check.keep && json && typeof json === 'object') {
      const [name, field = 'id'] = check.keep.split('=')
      captured[name!] = String(json[field])
    }
  }
}

/**
 * Deletes what an administration scenario left behind: users, groups,
 * inventory roles, tenant options, retention rules, and Notification 2.0
 * subscriptions whose names start with the prefix.
 * @param client - The client
 * @param tenant - Tenant id
 * @param prefix - The scenario's prefix
 */
export async function cleanup(client: Client, tenant: string, prefix: string): Promise<void> {
  const get = async (path: string) => {
    const res = await client.core.fetch(path, { headers: { accept: 'application/json' } })
    return res.ok ? await res.json() as any : {}
  }
  const remove = (path: string) => client.core.fetch(path, { method: 'DELETE' }).catch(() => undefined)
  for (const user of (await get(`/user/${tenant}/users?pageSize=2000&username=${encodeURIComponent(prefix)}`)).users ?? []) {
    await remove(`/user/${tenant}/users/${encodeURIComponent(user.userName)}`)
  }
  for (const group of (await get(`/user/${tenant}/groups?pageSize=2000`)).groups ?? []) {
    if (String(group.name).startsWith(prefix)) {
      await remove(`/user/${tenant}/groups/${group.id}`)
    }
  }
  for (const role of (await get('/user/inventoryroles?pageSize=2000')).roles ?? []) {
    if (String(role.name).startsWith(prefix)) {
      await remove(`/user/inventoryroles/${role.id}`)
    }
  }
  for (const option of (await get('/tenant/options?pageSize=2000')).options ?? []) {
    if (String(option.category).startsWith(prefix)) {
      await remove(`/tenant/options/${option.category}/${option.key}`)
    }
  }
  for (const rule of (await get('/retention/retentions?pageSize=2000')).retentionRules ?? []) {
    if ([rule.type, rule.fragmentType, rule.source].some((value) => String(value).startsWith(prefix))) {
      await remove(`/retention/retentions/${rule.id}`)
    }
  }
  for (const subscription of (await get('/notification2/subscriptions?pageSize=2000')).subscriptions ?? []) {
    if (String(subscription.subscription).startsWith(prefix)) {
      await remove(`/notification2/subscriptions/${subscription.id}`)
    }
  }
}
