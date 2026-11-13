import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'

// Users, groups, and inventory roles created here carry the run id and are
// deleted in `finally`: the real-tenant cleanup only knows inventory data.

async function api(client: Client, method: string, path: string, body?: unknown) {
  const res = await client.core.fetch(path, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, body: json }
}

const PASSWORD = 'Contract-Pass-2026!x'

/**
 * Path and query of a link: the platform links to its own host name, which
 * need not be the one the client uses.
 * @param link
 */
function url(link: string) {
  const parsed = new URL(link)
  return `${parsed.pathname}${parsed.search}`
}

/**
 * Creates users and groups for a scenario and deletes them afterwards.
 * @param client
 * @param tenant
 */
function fixture(client: Client, tenant: string) {
  const users: string[] = []
  const groups: number[] = []
  const inventoryRoles: number[] = []
  return {
    async user(userName: string, extra: Record<string, unknown> = {}) {
      const result = await api(client, 'POST', `/user/${tenant}/users`, { userName, email: `${userName.toLowerCase()}@example.com`, password: PASSWORD, ...extra })
      expect(result.status, JSON.stringify(result.body)).toBe(201)
      users.push(userName)
      return result.body
    },
    async group(name: string) {
      const result = await api(client, 'POST', `/user/${tenant}/groups`, { name })
      expect(result.status, JSON.stringify(result.body)).toBe(201)
      groups.push(result.body.id)
      return result.body
    },
    async inventoryRole(body: Record<string, unknown>) {
      const result = await api(client, 'POST', '/user/inventoryroles', body)
      expect(result.status, JSON.stringify(result.body)).toBe(201)
      inventoryRoles.push(result.body.id)
      return result.body
    },
    track: { users, groups },
    async cleanup() {
      for (const userName of users) {
        await api(client, 'DELETE', `/user/${tenant}/users/${encodeURIComponent(userName)}`)
      }
      for (const id of groups) {
        await api(client, 'DELETE', `/user/${tenant}/groups/${id}`)
      }
      for (const id of inventoryRoles) {
        await api(client, 'DELETE', `/user/inventoryroles/${id}`)
      }
    },
  }
}

export const usersScenarios: ContractScenario[] = [
  {
    name: 'users: create, read, update, delete',
    verifies: ['user-default-roles', 'user-update', 'user-optional-fields'],
    async run({ client, tenant, unique }) {
      const data = fixture(client, tenant)
      try {
        const name = `ev.usr.${unique}.a`
        const user = await data.user(name, { firstName: 'Eva', customProperties: { team: 'x' } })
        expect(user).toMatchObject({
          id: name,
          userName: name,
          firstName: 'Eva',
          email: `${name}@example.com`,
          customProperties: { team: 'x', userOrigin: 'BASIC' },
          passwordStrength: 'GREEN',
          shouldResetPassword: false,
          enabled: true,
          devicePermissions: {},
          applications: [],
          groups: { references: [] },
        })
        expect(user.self).toMatch(new RegExp(`/user/${tenant}/users/${name}$`))
        expect(user.roles.references.map((reference: any) => reference.role.id)).toEqual(['ROLE_USER_MANAGEMENT_OWN_READ', 'ROLE_USER_MANAGEMENT_OWN_ADMIN'])
        expect(user.lastPasswordChange).toEqual(expect.any(String))
        expect(user).not.toHaveProperty('password')
        // the spec lists both as always present
        expect(user).not.toHaveProperty('owner')
        expect(user).not.toHaveProperty('twoFactorAuthenticationEnabled')

        expect((await api(client, 'GET', `/user/${tenant}/users/${name}`)).body.userName).toBe(name)
        expect((await api(client, 'GET', `/user/${tenant}/userByName/${name}`)).body.userName).toBe(name)

        const updated = await api(client, 'PUT', `/user/${tenant}/users/${name}`, { lastName: 'Lee', customProperties: { other: 1 } })
        expect(updated.status).toBe(200)
        expect(updated.body).toMatchObject({ firstName: 'Eva', lastName: 'Lee', customProperties: { team: 'x', other: 1, userOrigin: 'BASIC' } })
        const rename = await api(client, 'PUT', `/user/${tenant}/users/${name}`, { userName: `${name}.b` })
        expect(rename).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'userName is not allowed here' } })
        expect((await api(client, 'PUT', `/user/${tenant}/users/${name}`, { email: 'nope' })).body.message).toBe('email field must contain a valid email address')

        expect((await api(client, 'DELETE', `/user/${tenant}/users/${name}`)).status).toBe(204)
        const missing = await api(client, 'GET', `/user/${tenant}/users/${name}`)
        expect(missing).toMatchObject({ status: 404, body: { error: 'users/Not Found', message: `Error retrieving user ${name}! : Cannot find document with ID ${name}` } })
        expect((await api(client, 'DELETE', `/user/${tenant}/users/${name}`)).status).toBe(404)
        expect((await api(client, 'PUT', `/user/${tenant}/users/${name}`, { firstName: 'x' })).status).toBe(404)
        expect((await api(client, 'GET', `/user/${tenant}/userByName/${name}`)).status).toBe(404)
      } finally {
        await data.cleanup()
      }
    },
  },
  {
    name: 'users: validation and duplicates',
    verifies: ['user-required-fields', 'user-names-case-sensitive', 'user-duplicate-email'],
    async run({ client, tenant, unique }) {
      const data = fixture(client, tenant)
      const post = (body: Record<string, unknown>) => api(client, 'POST', `/user/${tenant}/users`, body)
      try {
        const name = `ev.usr.${unique}.v`
        const email = `${name}@example.com`
        expect(await post({ email, password: PASSWORD })).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'userName is required' } })
        expect(await post({ userName: name, password: PASSWORD })).toMatchObject({ status: 422, body: { message: 'email is required' } })
        expect(await post({ userName: name, email: 'not-an-email', password: PASSWORD })).toMatchObject({ status: 422, body: { message: 'email field must contain a valid email address' } })
        expect(await post({ userName: name, email })).toMatchObject({ status: 422, body: { message: 'Password is required.' } })
        expect(await post({ userName: name, email, sendPasswordResetEmail: false })).toMatchObject({ status: 422, body: { message: 'Password is required.' } })
        expect(await post({ userName: name, email, password: 'abc' })).toMatchObject({ status: 422, body: { error: 'users/Invalid Data', message: 'Error during password validation. : Password must have at least 8 characters and no more than 32 and must contain only Latin1 characters.' } })
        for (const invalid of [`${name} x`, `${name}+x`, `${name}:x`]) {
          expect(await post({ userName: invalid, email, password: PASSWORD })).toMatchObject({ status: 422, body: { message: 'userName field cannot contain whitespace, slashes nor any of (+$:) characters.' } })
        }

        await data.user(name)
        expect(await post({ userName: name, email: `other.${email}`, password: PASSWORD })).toMatchObject({ status: 409, body: { error: 'users/Duplicate', message: `User with username or alias '${name}' already exists! : Duplicated: ${name}` } })
        // the email check ignores case
        expect(await post({ userName: `${name}.2`, email: email.toUpperCase(), password: PASSWORD })).toMatchObject({ status: 409, body: { error: 'users/Duplicate', message: `User with email '${email.toUpperCase()}' already exists! : Duplicated: ${email.toUpperCase()}` } })

        // user names are case-sensitive: the upper-case name is another user
        const upper = name.toUpperCase()
        await data.user(upper, { email: `upper.${email}` })
        expect((await api(client, 'GET', `/user/${tenant}/users/${upper}`)).body.userName).toBe(upper)
        const mixed = `Ev.Usr.${unique}.V`
        expect(await api(client, 'GET', `/user/${tenant}/users/${mixed}`)).toMatchObject({ status: 404, body: { message: `Error retrieving user ${mixed}! : Cannot find document with ID ${mixed}` } })
        expect((await api(client, 'GET', `/user/${tenant}/userByName/${mixed}`)).status).toBe(404)

        // another user's email
        const taken = await api(client, 'PUT', `/user/${tenant}/users/${upper}`, { email })
        expect(taken).toMatchObject({ status: 422, body: { error: 'users/Invalid Data', message: 'Email field error : Cannot change email for another user.' } })

        // without a password the user has to set one
        const reset = await post({ userName: `${name}.r`, email: `r.${email}`, sendPasswordResetEmail: true })
        expect(reset.status).toBe(201)
        data.track.users.push(`${name}.r`)
        expect(reset.body).toMatchObject({ shouldResetPassword: true, passwordStrength: 'GREEN' })
      } finally {
        await data.cleanup()
      }
    },
  },
  {
    name: 'users: list filters and paging',
    verifies: ['user-list-filters', 'user-paging-error-code', 'user-tenant-in-path'],
    async run({ client, tenant, unique }) {
      const data = fixture(client, tenant)
      const list = async (query: string) => {
        const result = await api(client, 'GET', `/user/${tenant}/users?${query}`)
        expect(result.status, JSON.stringify(result.body)).toBe(200)
        return result.body
      }
      try {
        const prefix = `ev.usr.${unique}`
        await data.user(`${prefix}.b`)
        await data.user(`${prefix}.a`)
        await data.user(`${prefix.toUpperCase()}.C`, { email: `${prefix}.c2@example.com` })
        const group = await data.group(`EV-usr-${unique}-list`)
        await api(client, 'POST', `/user/${tenant}/groups/${group.id}/users`, { user: { self: `${client.core.baseUrl}/user/${tenant}/users/${prefix}.b` } })

        // `username` is a case-insensitive prefix, sorted by character code
        const all = await list(`username=${prefix.toUpperCase()}&pageSize=10&withTotalElements=true`)
        expect(all.users.map((user: any) => user.userName)).toEqual([`${prefix.toUpperCase()}.C`, `${prefix}.a`, `${prefix}.b`])
        expect(all.statistics).toMatchObject({ currentPage: 1, pageSize: 10, totalElements: 3 })
        expect((await list(`username=${unique}`)).users).toEqual([])
        // `usernameContains` is a case-insensitive substring
        expect((await list(`usernameContains=${unique.toUpperCase()}.A&pageSize=10`)).users.map((user: any) => user.userName)).toEqual([`${prefix}.a`])
        expect(await api(client, 'GET', `/user/${tenant}/users?username=${prefix}&usernameContains=${unique}`)).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'Cannot use both filters: usernameContains and username. Set only one of them.' } })
        expect((await list(`groups=${group.id}&username=${prefix}`)).users.map((user: any) => user.userName)).toEqual([`${prefix}.b`])
        expect((await list(`username=${prefix}&onlyDevices=true`)).users).toEqual([])
        const withCount = await list(`username=${prefix}.a&withSubusersCount=true`)
        expect(withCount.users[0].subusersCount).toBe(0)

        // paging like other collections, totals only on request
        const page = await list(`username=${prefix}&pageSize=1&currentPage=2`)
        expect(page.users.map((user: any) => user.userName)).toEqual([`${prefix}.a`])
        expect(page.statistics).toEqual({ currentPage: 2, pageSize: 1 })
        expect(page.next).toContain('currentPage=3')
        expect(page.prev).toContain('currentPage=1')
        expect(await api(client, 'GET', `/user/${tenant}/users?pageSize=x`)).toMatchObject({ status: 422, body: { error: 'REST API/Unprocessable Entity', message: 'Parameter \'pageSize\' must have an integer value!' } })

        // another tenant's id in the path
        const other = tenant === 't0000001' ? 't0000002' : 't0000001'
        for (const path of [`/user/${other}/users`, `/user/${other}/users/${prefix}.a`, `/user/${other}/groups`]) {
          expect(await api(client, 'GET', path)).toMatchObject({ status: 403, body: { error: 'userManagement/Forbidden', message: 'authenticated user\'s tenant different from the one in URL path' } })
        }
      } finally {
        await data.cleanup()
      }
    },
  },
  {
    name: 'groups: create, rename, delete',
    verifies: ['group-embedded-references', 'group-name-rules', 'group-ids-sorted-as-text'],
    async run({ client, tenant, unique }) {
      const data = fixture(client, tenant)
      try {
        const name = `EV-usr-${unique}-g1`
        const group = await data.group(name)
        expect(group).toMatchObject({ id: expect.any(Number), name, customProperties: {}, devicePermissions: {}, applications: [], roles: { references: [] } })
        expect(group.self).toMatch(new RegExp(`/user/${tenant}/groups/${group.id}$`))
        expect(group.users.references).toEqual([])
        expect(url(group.users.self)).toBe(`/${group.id}/users`)
        expect(group).not.toHaveProperty('description')

        expect(await api(client, 'POST', `/user/${tenant}/groups`, { name })).toMatchObject({ status: 409, body: { error: 'groups/Duplicate', message: `Group '${name}' already exists! : Duplicated: ${name}` } })
        expect(await api(client, 'POST', `/user/${tenant}/groups`, { description: 'x' })).toMatchObject({ status: 422, body: { error: 'usermangement/Invalid Data', message: 'A Groupname has to be provided when posting to group collection' } })
        // names are case-sensitive
        const lower = await data.group(name.toLowerCase())
        expect(lower.id).not.toBe(group.id)
        expect((await api(client, 'GET', `/user/${tenant}/groupByName/${name}`)).body.id).toBe(group.id)
        const mixed = `ev-usr-${unique}-G1`
        expect(await api(client, 'GET', `/user/${tenant}/groupByName/${mixed}`)).toMatchObject({ status: 404, body: { error: 'groups/Not Found', message: `Error retrieving group ${mixed}! : No group for name ${mixed}!` } })
        expect((await api(client, 'GET', `/user/${tenant}/groups/${group.id}`)).body.name).toBe(name)
        expect(await api(client, 'GET', `/user/${tenant}/groups/999999`)).toMatchObject({ status: 404, body: { error: 'groups/Not Found', message: 'Error retrieving group with id 999999! : Cannot find document with ID 999999' } })

        // an update needs the name; custom properties are merged
        expect(await api(client, 'PUT', `/user/${tenant}/groups/${group.id}`, { description: 'd' })).toMatchObject({ status: 422, body: { error: 'usermangement/Invalid Data', message: 'A Groupname has to be provided when updating the group.' } })
        expect(await api(client, 'PUT', `/user/${tenant}/groups/${group.id}`, { name: lower.name })).toMatchObject({ status: 409, body: { error: 'groups/Duplicate' } })
        await api(client, 'PUT', `/user/${tenant}/groups/${group.id}`, { name, customProperties: { a: 1 } })
        const renamed = await api(client, 'PUT', `/user/${tenant}/groups/${group.id}`, { name: `${name}r`, description: 'd', customProperties: { b: 2 } })
        expect(renamed).toMatchObject({ status: 200, body: { name: `${name}r`, description: 'd', customProperties: { a: 1, b: 2 } } })
        expect((await api(client, 'PUT', `/user/${tenant}/groups/999999`, { name: 'x' })).status).toBe(404)

        // the list is sorted by id as text, with the total pages always
        const listed = await api(client, 'GET', `/user/${tenant}/groups?pageSize=2000`)
        const ids: number[] = listed.body.groups.map((item: any) => item.id)
        expect(ids).toEqual([...ids].sort((a, b) => String(a).localeCompare(String(b))))
        expect(listed.body.statistics).toMatchObject({ currentPage: 1, pageSize: 2000, totalPages: 1 })
        expect(listed.body).not.toHaveProperty('next')

        expect((await api(client, 'DELETE', `/user/${tenant}/groups/${group.id}`)).status).toBe(204)
        expect(await api(client, 'DELETE', `/user/${tenant}/groups/${group.id}`)).toMatchObject({ status: 404, body: { message: `Error retrieving group with id ${group.id}! : Cannot find document with ID ${group.id}` } })
      } finally {
        await data.cleanup()
      }
    },
  },
  {
    name: 'groups: members',
    verifies: ['group-member-duplicate-409', 'group-member-remove-lenient', 'user-reference-self-link', 'collection-total-pages-always'],
    async run({ client, tenant, unique }) {
      const data = fixture(client, tenant)
      try {
        const name = `ev.usr.${unique}.m`
        await data.user(name)
        const group = await data.group(`EV-usr-${unique}-m`)
        const other = await data.group(`EV-usr-${unique}-m2`)
        const members = `/user/${tenant}/groups/${group.id}/users`
        const self = `${client.core.baseUrl}/user/${tenant}/users/${name}`

        const added = await api(client, 'POST', members, { user: { self } })
        expect(added.status).toBe(201)
        expect(url(added.body.self)).toBe(`${members}/${name}`)
        expect(added.body.user.groups.references.map((reference: any) => reference.group.id)).toEqual([group.id])
        expect(await api(client, 'POST', members, { user: { self } })).toMatchObject({ status: 409, body: { error: 'groups/Duplicate', message: `Error retrieving data for group with id ${group.id} and user with username ${name}! : Group ${group.id} already has user ${name} as member!` } })
        // the user is found by the path of its link, not by an id
        expect(await api(client, 'POST', members, { user: { id: name } })).toMatchObject({ status: 422, body: { error: 'usermangement/Invalid Data', message: 'Could not Identify the user by provided self link.' } })
        expect((await api(client, 'POST', `/user/${tenant}/groups/${other.id}/users`, { user: { self: `https://elsewhere.example.com/user/${tenant}/users/${name}` } })).status).toBe(201)
        const unknown = `${name}.nope`
        expect(await api(client, 'POST', members, { user: { self: `${client.core.baseUrl}/user/${tenant}/users/${unknown}` } })).toMatchObject({ status: 422, body: { error: 'groups/Invalid Data', message: `Error retrieving data for group with id ${group.id} and user with username ${unknown}! : Cannot find document with ID ${unknown}` } })
        expect(await api(client, 'POST', `/user/${tenant}/groups/999999/users`, { user: { self } })).toMatchObject({ status: 404, body: { error: 'groups/Not Found' } })

        const listed = await api(client, 'GET', `${members}?withTotalElements=true`)
        expect(listed.body.references.map((reference: any) => reference.user.userName)).toEqual([name])
        expect(listed.body.statistics).toEqual({ currentPage: 1, pageSize: 5, totalPages: 1, totalElements: 1 })
        expect((await api(client, 'GET', `/user/${tenant}/groups/999999/users`)).status).toBe(404)

        const groups = await api(client, 'GET', `/user/${tenant}/users/${name}/groups`)
        expect(groups.body.references.map((reference: any) => reference.group.id)).toEqual([group.id, other.id].sort((a, b) => String(a).localeCompare(String(b))))
        expect(groups.body.statistics).toEqual({ currentPage: 1, pageSize: 5, totalPages: 1 })
        expect(await api(client, 'GET', `/user/${tenant}/users/${unknown}/groups`)).toMatchObject({ status: 404, body: { error: 'users/Not Found', message: `User with username '${unknown}' does not exist! : Cannot find document with ID ${unknown}` } })
        expect((await api(client, 'GET', `/user/${tenant}/users?groups=${group.id}&username=${name}`)).body.users).toHaveLength(1)

        // removing: a user outside the group is fine, an unknown user is a server error
        expect((await api(client, 'DELETE', `${members}/${name}`)).status).toBe(204)
        expect((await api(client, 'DELETE', `${members}/${name}`)).status).toBe(204)
        expect(await api(client, 'DELETE', `${members}/${unknown}`)).toMatchObject({ status: 500, body: { error: 'general/internalError', message: `Cannot find document with ID ${unknown}` } })
        expect((await api(client, 'DELETE', `/user/${tenant}/groups/999999/users/${name}`)).status).toBe(404)

        // deleting a group keeps its users, without the membership
        expect((await api(client, 'DELETE', `/user/${tenant}/groups/${other.id}`)).status).toBe(204)
        const user = await api(client, 'GET', `/user/${tenant}/users/${name}`)
        expect(user.body.groups.references).toEqual([])
      } finally {
        await data.cleanup()
      }
    },
  },
  {
    name: 'roles: catalogue and role references',
    verifies: ['group-role-links', 'group-role-remove-statuses', 'role-reference-without-self', 'user-role-reassign'],
    async run({ client, tenant, unique }) {
      const data = fixture(client, tenant)
      try {
        const roles = await api(client, 'GET', '/user/roles?pageSize=2000&withTotalElements=true')
        const names: string[] = roles.body.roles.map((role: any) => role.name)
        expect(names).toContain('ROLE_ALARM_READ')
        expect(names).toEqual([...names].sort())
        expect(roles.body.statistics).toMatchObject({ totalPages: 1, totalElements: names.length })
        expect(roles.body.roles[0]).toMatchObject({ id: names[0], name: names[0] })
        expect(url(roles.body.roles[0].self)).toBe(`/user/roles/${names[0]}`)
        const firstPage = await api(client, 'GET', '/user/roles')
        expect(firstPage.body.statistics).toEqual({ currentPage: 1, pageSize: 5, totalPages: Math.ceil(names.length / 5) })
        expect((await api(client, 'GET', '/user/roles/ROLE_ALARM_READ')).body).toMatchObject({ id: 'ROLE_ALARM_READ', name: 'ROLE_ALARM_READ' })
        expect(await api(client, 'GET', '/user/roles/role_alarm_read')).toMatchObject({ status: 404, body: { error: 'authorities/Not Found', message: 'Cannot find document with ID role_alarm_read' } })

        const role = (name: string) => ({ role: { self: `${client.core.baseUrl}/user/roles/${name}` } })
        const name = `ev.usr.${unique}.r`
        await data.user(name)
        const userRoles = `/user/${tenant}/users/${name}/roles`
        const assigned = await api(client, 'POST', userRoles, role('ROLE_ALARM_READ'))
        expect(assigned).toMatchObject({ status: 201, body: { role: { id: 'ROLE_ALARM_READ' } } })
        expect(url(assigned.body.self)).toBe(`/users/${name}/roles/ROLE_ALARM_READ`)
        expect((await api(client, 'POST', userRoles, role('ROLE_ALARM_READ'))).status).toBe(201)
        expect(await api(client, 'POST', userRoles, role('ROLE_NOPE'))).toMatchObject({ status: 422, body: { error: 'usermangement/Invalid Data', message: 'The Given Role does not exist.' } })
        expect(await api(client, 'POST', userRoles, { role: { id: 'ROLE_EVENT_READ' } })).toMatchObject({ status: 500, body: { error: 'general/internalError' } })
        expect((await api(client, 'POST', `/user/${tenant}/users/${name}.nope/roles`, role('ROLE_ALARM_READ'))).status).toBe(404)
        const user = await api(client, 'GET', `/user/${tenant}/users/${name}`)
        expect(user.body.roles.references.map((reference: any) => reference.role.id)).toEqual(['ROLE_USER_MANAGEMENT_OWN_READ', 'ROLE_USER_MANAGEMENT_OWN_ADMIN', 'ROLE_ALARM_READ'])
        expect((await api(client, 'DELETE', `${userRoles}/ROLE_ALARM_READ`)).status).toBe(204)
        expect(await api(client, 'DELETE', `${userRoles}/ROLE_ALARM_READ`)).toMatchObject({ status: 404, body: { error: 'users/Not Found', message: `User ${name} does not contain authority with authorityName ROLE_ALARM_READ !` } })
        expect(await api(client, 'DELETE', `${userRoles}/ROLE_NOPE`)).toMatchObject({ status: 404, body: { message: `Error retrieving data for user id ${name} and authority with authorityName ROLE_NOPE! : Cannot find document with ID ROLE_NOPE` } })

        const group = await data.group(`EV-usr-${unique}-r`)
        const groupRoles = `/user/${tenant}/groups/${group.id}/roles`
        const added = await api(client, 'POST', groupRoles, role('ROLE_ALARM_READ'))
        expect(added).toMatchObject({ status: 201, body: { role: { id: 'ROLE_ALARM_READ' } } })
        expect(url(added.body.self)).toBe(`/groups/${group.id}/users/roles/ROLE_ALARM_READ`)
        expect(await api(client, 'POST', groupRoles, role('ROLE_ALARM_READ'))).toMatchObject({ status: 409, body: { error: 'groups/Duplicate', message: `Error retrieving data for group with id ${group.id} and authority with authorityName ROLE_ALARM_READ! : Group ${group.id} already has authority ROLE_ALARM_READ assigned!` } })
        expect(await api(client, 'POST', groupRoles, { role: { id: 'ROLE_EVENT_READ' } })).toMatchObject({ status: 500, body: { error: 'general/internalError', message: 'Cannot invoke "java.lang.CharSequence.length()" because "this.text" is null' } })
        expect(await api(client, 'POST', groupRoles, role('ROLE_NOPE'))).toMatchObject({ status: 422, body: { message: 'The Given Role does not exist.' } })
        expect((await api(client, 'POST', groupRoles, { role: { self: 'https://elsewhere.example.com/user/roles/ROLE_EVENT_READ' } })).status).toBe(201)
        expect((await api(client, 'POST', `/user/${tenant}/groups/999999/roles`, role('ROLE_ALARM_READ'))).status).toBe(404)

        const listed = await api(client, 'GET', `${groupRoles}?pageSize=1`)
        expect(listed.body.statistics).toEqual({ currentPage: 1, pageSize: 1, totalPages: 2 })
        expect(new URL(listed.body.self).pathname).toBe(`/groups/${group.id}/users/roles`)
        expect(listed.body.references.map((reference: any) => [url(reference.self), url(reference.role.self), reference.role.id])).toEqual([[`/groups/${group.id}/users/roles/ROLE_ALARM_READ`, '/user/roles/ROLE_ALARM_READ', 'ROLE_ALARM_READ']])
        const last = await api(client, 'GET', `${groupRoles}?pageSize=1&currentPage=2`)
        expect(last.body).not.toHaveProperty('next')
        expect((await api(client, 'GET', `/user/${tenant}/groups/999999/roles`)).status).toBe(404)
        const embedded = await api(client, 'GET', `/user/${tenant}/groups/${group.id}`)
        expect(embedded.body.roles.references.map((reference: any) => reference.self)).toEqual([`${embedded.body.self}/roles/ROLE_ALARM_READ`, `${embedded.body.self}/roles/ROLE_EVENT_READ`])

        expect((await api(client, 'DELETE', `${groupRoles}/ROLE_ALARM_READ`)).status).toBe(204)
        expect(await api(client, 'DELETE', `${groupRoles}/ROLE_ALARM_READ`)).toMatchObject({ status: 404, body: { error: 'groups/Not Found', message: `Error retrieving data for group with id ${group.id} and authority with authorityName ROLE_ALARM_READ! : Group ${group.id} has no authority ROLE_ALARM_READ assigned!` } })
        expect(await api(client, 'DELETE', `${groupRoles}/ROLE_NOPE`)).toMatchObject({ status: 422, body: { error: 'groups/Invalid Data' } })
      } finally {
        await data.cleanup()
      }
    },
  },
  {
    name: 'inventory roles and assignments',
    verifies: ['inventory-role-validation', 'inventory-assignment-rules'],
    async run({ client, tenant, unique }) {
      const data = fixture(client, tenant)
      try {
        const name = `EV-usr-${unique}-ir`
        const role = await data.inventoryRole({ name, permissions: [{ permission: 'READ', scope: 'ALARM', type: '*' }] })
        expect(role).toMatchObject({ id: expect.any(Number), name, description: null, permissions: [{ id: expect.any(Number), permission: 'READ', scope: 'ALARM', type: '*' }] })
        expect(url(role.self)).toBe(`/user/inventoryroles/${role.id}`)
        const empty = await data.inventoryRole({ name: `${name}-empty` })
        expect(empty.permissions).toEqual([])
        expect(await api(client, 'POST', '/user/inventoryroles', { name })).toMatchObject({ status: 409, body: { error: 'users/Duplicate', message: `InventoryRole with name ${name} already exists!` } })
        expect(await api(client, 'POST', '/user/inventoryroles', { description: 'x' })).toMatchObject({ status: 422, body: { message: 'name is required' } })
        for (const [permission, message] of [
          [{ permission: 'WRITE', scope: 'ALARM', type: '*' }, 'permission invalid value'],
          [{ permission: 'READ', scope: 'FOO', type: '*' }, 'scope invalid value'],
          [{ scope: 'ALARM', type: '*' }, 'permission is required'],
          [{ permission: 'READ', type: '*' }, 'scope is required'],
          [{ permission: 'READ', scope: 'ALARM' }, 'type is required'],
          // the required fields in order: type, permission, scope
          [{}, 'type is required'],
          [{ scope: 'ALARM' }, 'type is required'],
          [{ type: '*' }, 'permission is required'],
          [{ permission: 'WRITE' }, 'type is required'],
          [{ scope: 'FOO', type: '*' }, 'permission is required'],
        ] as const) {
          expect(await api(client, 'POST', '/user/inventoryroles', { name: `${name}-x`, permissions: [permission] })).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message } })
        }
        expect((await api(client, 'GET', `/user/inventoryroles/${role.id}`)).body.name).toBe(name)
        expect(await api(client, 'GET', '/user/inventoryroles/999999')).toMatchObject({ status: 404, body: { error: 'users/Not Found', message: 'Cannot find document with ID 999999' } })
        const updated = await api(client, 'PUT', `/user/inventoryroles/${role.id}`, { description: 'new', permissions: [{ permission: 'ADMIN', scope: 'EVENT', type: '*' }] })
        expect(updated.body).toMatchObject({ name, description: 'new', permissions: [{ permission: 'ADMIN', scope: 'EVENT' }] })
        expect(updated.body.permissions[0].id).not.toBe(role.permissions[0].id)
        // only creation checks the name
        expect((await api(client, 'PUT', `/user/inventoryroles/${empty.id}`, { name })).status).toBe(200)
        expect((await api(client, 'PUT', '/user/inventoryroles/999999', { description: 'x' })).status).toBe(404)
        const listed = await api(client, 'GET', '/user/inventoryroles?pageSize=2000&withTotalElements=true')
        expect(listed.body.roles.map((item: any) => item.id)).toContain(role.id)
        expect(listed.body.statistics).toMatchObject({ totalPages: 1, totalElements: listed.body.roles.length })

        const userName = `ev.usr.${unique}.ir`
        await data.user(userName)
        const { data: device } = await client.inventory.create({ name: `ir-${unique}`, c8y_IsDevice: {} })
        const assignments = `/user/${tenant}/users/${userName}/roles/inventory`
        const assigned = await api(client, 'POST', assignments, { managedObject: device.id, roles: [{ id: role.id }] })
        expect(assigned.status).toBe(200)
        expect(assigned.body).toMatchObject({ id: expect.any(Number), managedObject: device.id, roles: [{ id: role.id, name, description: 'new' }] })
        expect(url(assigned.body.self)).toBe(`/user/${userName}/roles/inventory/${assigned.body.id}`)
        expect(await api(client, 'POST', assignments, { managedObject: device.id, roles: [{ id: 1 }] })).toMatchObject({ status: 409, body: { error: 'users/Duplicate', message: `Error adding user inventory assignments ${userName}! : Inventory role is already assigned to the '${device.id}' managed object!` } })
        expect(await api(client, 'POST', assignments, { managedObject: device.id, roles: [{ id: 999999 }] })).toMatchObject({ status: 404, body: { message: `Error adding user inventory assignments ${userName}! : Inventory role 'null' with id 'ID [type=com_cumulocity_model_idtype_GId, value=999999]' does not exist!` } })
        expect(await api(client, 'POST', assignments, { managedObject: '999999999', roles: [{ id: role.id }] })).toMatchObject({ status: 404, body: { message: 'Managed object with id \'999999999\' does not exist! : Cannot find document with ID 999999999' } })
        expect(await api(client, 'POST', assignments, { roles: [{ id: role.id }] })).toMatchObject({ status: 422, body: { message: 'managedObject is required' } })
        expect(await api(client, 'POST', `/user/${tenant}/users/${userName}.nope/roles/inventory`, { managedObject: device.id, roles: [] })).toMatchObject({ status: 404, body: { message: `User with username '${userName}.nope' does not exist! : Cannot find document with ID ${userName}.nope` } })

        const list = await api(client, 'GET', assignments)
        expect(list.body.inventoryAssignments).toEqual([assigned.body])
        expect(url(list.body.self)).toBe(`/user/${userName}/roles/inventory`)
        expect(list.body).not.toHaveProperty('statistics')
        const one = `${assignments}/${assigned.body.id}`
        expect((await api(client, 'GET', one)).body).toEqual(assigned.body)
        expect(await api(client, 'GET', `${assignments}/999999`)).toMatchObject({ status: 404, body: { message: `Inventory Assignment with id 'ID [type=com_cumulocity_model_idtype_GId, value=999999]' not found in user '${userName}' : Inventory assignment not found!` } })
        const replaced = await api(client, 'PUT', one, { roles: [{ id: 1 }, { id: role.id }] })
        expect(replaced.body.roles.map((item: any) => item.id)).toEqual([1, role.id])
        expect((await api(client, 'PUT', `${assignments}/999999`, { roles: [] })).status).toBe(404)

        expect(await api(client, 'DELETE', `/user/inventoryroles/${role.id}`)).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'Cannot remove used InventoryRole' } })
        expect((await api(client, 'DELETE', one)).status).toBe(204)
        expect((await api(client, 'DELETE', one)).status).toBe(404)
        expect((await api(client, 'DELETE', `/user/inventoryroles/${role.id}`)).status).toBe(204)
        expect((await api(client, 'DELETE', '/user/inventoryroles/999999')).status).toBe(404)

        // deleting a user deletes its assignments
        await api(client, 'POST', assignments, { managedObject: device.id })
        await api(client, 'DELETE', `/user/${tenant}/users/${userName}`)
        await data.user(userName)
        expect((await api(client, 'GET', assignments)).body.inventoryAssignments).toEqual([])

        expect((await api(client, 'GET', `/user/devicePermissions/${device.id}`)).body).toEqual({ users: [], groups: [] })
      } finally {
        await data.cleanup()
      }
    },
  },
  {
    name: 'current user: a stored user with the roles of its groups',
    async run({ client, tenant }) {
      const current = (await api(client, 'GET', '/user/currentUser')).body
      expect(url(current.self)).toBe('/user/currentUser')
      const stored = await api(client, 'GET', `/user/${tenant}/users/${encodeURIComponent(current.userName)}`)
      expect(stored.status).toBe(200)
      const expected = new Set<string>(stored.body.roles.references.map((reference: any) => reference.role.id))
      for (const reference of stored.body.groups.references) {
        for (const roleReference of reference.group.roles.references) {
          expected.add(roleReference.role.id)
        }
      }
      const effective = new Set<string>(current.effectiveRoles.map((role: any) => role.id))
      for (const role of expected) {
        expect(effective.has(role), role).toBe(true)
      }
    },
  },
]
