/**
 * The owner of what a request creates is the request's user, the same one
 * audit records name (verified: the login user name).
 */
import { expect, it } from 'vitest'
import { createWorld } from '../../src'

/**
 * A binary upload body (`POST /inventory/binaries`).
 * @param content - File content
 */
function binaryUpload(content: Uint8Array<ArrayBuffer> | string): FormData {
  const form = new FormData()
  form.append('object', JSON.stringify({ name: 'upload', type: 'application/octet-stream' }))
  form.append('file', new Blob([content]), 'upload.bin')
  return form
}

it('makes the request user the owner, also without an Authorization header', async () => {
  const world = createWorld({ user: { userName: 'eva', roles: [] } })
  const post = async (headers: Record<string, string>) => {
    const response = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: 'x' }) }))
    return (await response.json()).owner
  }
  expect(await post({})).toBe('eva')
  expect(await post({ authorization: `Basic ${btoa(`${world.tenant}/bob:pw`)}` })).toBe('bob')

  const binary = await world.fetch(new Request(`${world.baseUrl}/inventory/binaries`, { method: 'POST', headers: { accept: 'application/json' }, body: binaryUpload(new Uint8Array([1])) }))
  expect((await binary.json()).owner).toBe('eva')
})

it('answers the owner as the managed object user, and PUT changes a stored user', async () => {
  const world = createWorld({ user: { userName: 'eva', roles: [] } })
  // adam reads other users and the inventory, and creates and changes objects
  world.seed({ users: [{ userName: 'adam', roles: ['ROLE_USER_MANAGEMENT_READ', 'ROLE_INVENTORY_READ', 'ROLE_INVENTORY_ADMIN'] }] })
  let login: string | undefined
  const call = async (method: string, path: string, body?: unknown) => {
    const authorization: Record<string, string> = login === undefined ? {} : { authorization: `Basic ${btoa(`${world.tenant}/${login}:x`)}` }
    const response = await world.fetch(new Request(`${world.baseUrl}${path}`, { method, headers: { 'accept': 'application/json', 'content-type': 'application/json', ...authorization }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { status: response.status, body: await response.json() }
  }
  const own = (await call('POST', '/inventory/managedObjects', { name: 'own' })).body.id
  expect((await call('GET', `/inventory/managedObjects/${own}/user`)).body).toEqual({ userName: 'eva', enabled: true, self: `${world.baseUrl}/inventory/managedObjects/${own}/user`, customProperties: {} })
  const updated = await call('PUT', `/inventory/managedObjects/${own}/user`, { enabled: false })
  expect(updated).toMatchObject({ status: 200, body: { userName: 'eva', enabled: false } })
  // eva is disabled now: her requests answer 401
  expect((await call('GET', `/user/${world.tenant}/users/eva`)).status).toBe(401)
  login = 'adam'
  expect((await call('GET', `/user/${world.tenant}/users/eva`)).body.enabled).toBe(false)
  expect((await call('GET', `/inventory/managedObjects/${own}/user`)).body.enabled).toBe(false)

  // an owner that is no user: 404, but a service user answers as enabled (nothing stored)
  const ghost = (await call('POST', '/inventory/managedObjects', { name: 'ghost', owner: 'ghost' })).body.id
  expect(await call('GET', `/inventory/managedObjects/${ghost}/user`)).toMatchObject({ status: 404, body: { error: 'users/Not Found' } })
  const foreign = (await call('POST', '/inventory/managedObjects', { name: 'foreign', owner: 'service_x' })).body.id
  expect((await call('PUT', `/inventory/managedObjects/${foreign}/user`, { enabled: false })).body).toMatchObject({ userName: 'service_x', enabled: false })
  expect((await call('GET', `/inventory/managedObjects/${foreign}/user`)).body).toMatchObject({ userName: 'service_x', enabled: true, customProperties: {} })

  // an object without an owner (seeded; on the platform e.g. an application's object)
  const unowned = world.managedObject({ name: 'app', owner: '' })
  const missing = await call('GET', `/inventory/managedObjects/${unowned}/user`)
  expect(missing).toEqual({ status: 404, body: expect.objectContaining({ error: 'inventory/Not Found', message: 'Managed object not owned : No owner' }) })
})
