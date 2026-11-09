// Inventory, identity, and binaries details found by running the same requests
// against the fake and a real tenant (eu-latest).
import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'
import { eventually } from '../helpers'

type Json = Record<string, any>

const MO = '/inventory/managedObjects'

async function api(client: Client, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number, body: any }> {
  const res = await client.core.fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'accept': 'application/json', ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: unknown = text
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    // not JSON
  }
  return { status: res.status, body: json }
}

async function create(client: Client, body: Json): Promise<Json> {
  const { status, body: created } = await api(client, 'POST', MO, body)
  expect(status, JSON.stringify(body)).toBe(201)
  return created
}

function queryPath(query: string, extra = ''): string {
  return `${MO}?pageSize=100${extra}&query=${encodeURIComponent(query)}`
}

export const inventoryParityScenarios: ContractScenario[] = [
  {
    name: 'inventory: wildcards are regular expressions anchored by the position of the stars',
    verifies: ['query-wildcards'],
    async run({ client, unique }) {
      const type = `wild-${unique}`
      const words = ['ho', 'hho', 'hxo', 'xho', 'hox', 'aho', 'oh', 'h.o', 'aab', 'ab', 'b', 'a+b', 'HELLO', 'start', 'mid start end', 'line\nbreak']
      for (const [index, word] of words.entries()) {
        await create(client, { name: `w${index}-${unique}`, type, str: word })
      }
      const match = async (pattern: string) => {
        const { status, body } = await api(client, 'GET', queryPath(`$filter=(type eq '${type}' and str eq '${pattern}')`))
        expect(status, pattern).toBe(200)
        return body.managedObjects.map((mo: Json) => mo.str).sort()
      }
      // x* starts with x, *x ends with x, *x* contains x (case-insensitive)
      expect(await match('h*')).toEqual(['HELLO', 'h.o', 'hho', 'ho', 'hox', 'hxo'].sort())
      expect(await match('*o')).toEqual(['HELLO', 'aho', 'h.o', 'hho', 'ho', 'hxo', 'xho'].sort())
      expect(await match('*ll*')).toEqual(['HELLO'])
      expect(await match('*')).toEqual([...words].sort())
      expect(await match('*break')).toEqual(['line\nbreak'])
      // stars inside a prefix or suffix pattern are dropped
      expect(await match('h*o*')).toEqual(['ho', 'hox'])
      expect(await match('*h*o')).toEqual(['aho', 'hho', 'ho', 'xho'].sort())
      // without a star at either end the pattern is unanchored, a star matches anything
      expect(await match('h*o')).toEqual(['HELLO', 'aho', 'h.o', 'hho', 'ho', 'hox', 'hxo', 'xho'].sort())
      expect(await match('s*t')).toEqual(['mid start end', 'start'])
      expect(await match('*h*o*')).toEqual(['HELLO', 'aho', 'h.o', 'hho', 'ho', 'hox', 'hxo', 'xho'].sort())
      // the rest of the pattern supports regular expression syntax
      expect(await match('h.*')).toEqual(['HELLO', 'h.o', 'hho', 'ho', 'hox', 'hxo'].sort())
      expect(await match('a+b*')).toEqual(['aab', 'ab'])
      expect(await match('*a+b')).toEqual(['aab', 'ab'])
      expect(await match('a|b*')).toEqual(['a+b', 'aab', 'ab', 'aho', 'b', 'line\nbreak'].sort())
      expect(await match('*[x]*')).toEqual(['hox', 'hxo', 'xho'].sort())
      // without a star the comparison is exact and case-sensitive
      expect(await match('h.o')).toEqual(['h.o'])
      expect(await match('hello')).toEqual([])
      // a pattern with invalid syntax is rejected
      for (const pattern of ['*{*', 'HELLO\\*', 'h\\o*']) {
        const { status, body } = await api(client, 'GET', queryPath(`$filter=(type eq '${type}' and str eq '${pattern}')`))
        expect(status, pattern).toBe(422)
        expect(body.error).toBe('inventory/Invalid Data')
      }
    },
  },
  {
    name: 'inventory: wildcards accept a set of regular expression features',
    verifies: ['query-wildcard-java-syntax'],
    async run({ client, unique }) {
      const type = `syntax-${unique}`
      const words = ['a]b', 'x}y', 'p.q', 'A-B', 'a_b', 'a b', 'a:b', 'Case', 'case', 'aab', 'x9']
      for (const [index, word] of words.entries()) {
        await create(client, { name: `j${index}-${unique}`, type, str: word })
      }
      const match = async (pattern: string) => {
        const { status, body } = await api(client, 'GET', queryPath(`$filter=(type eq '${type}' and str eq '${pattern}')`))
        expect(status, pattern).toBe(200)
        return body.managedObjects.map((mo: Json) => mo.str).sort()
      }
      // lone brackets and braces are literals, punctuation may be escaped
      expect(await match('*]*')).toEqual(['a]b'])
      expect(await match('*}*')).toEqual(['x}y'])
      expect(await match('*[]x]*')).toEqual(['a]b', 'x}y', 'x9'].sort())
      expect(await match('*\\-*')).toEqual(['A-B'])
      expect(await match('*\\_*')).toEqual(['a_b'])
      expect(await match('*\\:*')).toEqual(['a:b'])
      // quoting, shorthands, POSIX classes, possessive and atomic groups, inline flags
      expect(await match('*\\Q.\\E*')).toEqual(['p.q'])
      expect(await match('*\\h*')).toEqual(['a b'])
      expect(await match('*[[:digit:]]*')).toEqual(['x9'])
      expect(await match('*\\x{2D}*')).toEqual(['A-B'])
      expect(await match('*\\Ap*')).toEqual(['p.q'])
      expect(await match('*a++b*')).toEqual(['aab'])
      expect(await match('*(?>aa)b*')).toEqual(['aab'])
      expect(await match('*(?-i)C*')).toEqual(['Case'])
      expect(await match('*(?i)C*')).toEqual(['Case', 'case'])
      // the stars of *x* stay in the expression: a leading quantifier is fine
      expect(await match('*?*')).toEqual([...words].sort())
      // what the platform rejects
      for (const pattern of ['*\\u0041*', '*(?#c)*', '*\\p{IsAlphabetic}*', '*(?u)a*', '*\\K*']) {
        const { status } = await api(client, 'GET', queryPath(`$filter=(type eq '${type}' and str eq '${pattern}')`))
        expect(status, pattern).toBe(422)
      }
    },
  },
  {
    name: 'inventory: text= is a full-text search over id, type, name, owner, and external ids',
    verifies: ['inventory-text-search'],
    async run({ client, unique }) {
      const type = `txt-${unique}`
      // every name carries the run id, so the real-tenant run deletes the objects afterwards
      const purge = await create(client, { name: `Purge 90-day-old TIMED_OUT approval requests ${unique}`, type })
      const gdansk = await create(client, { name: `Werk Gdańsk Facilities ${unique}`, type })
      const zeiss = await create(client, { name: `CMM ZEISS CONTURA ${unique}`, type, c8y_Hardware: { model: 'Prisma', serialNumber: 'ZX-77' } })
      const cmm = await create(client, { name: `HH-CMM-02 ${unique}`, type, nhv_Location: { site: 'Hamburg' } })
      const hall = await create(client, { name: `Machining hall ${unique}`, type })
      expect((await api(client, 'POST', `/identity/globalIds/${zeiss.id}/externalIds`, { type: `c8y_Serial`, externalId: `ZEISS-CT-${unique}` })).status).toBe(201)
      const names = { [purge.id]: 'purge', [gdansk.id]: 'gdansk', [zeiss.id]: 'zeiss', [cmm.id]: 'cmm', [hall.id]: 'hall' }
      const search = async (text: string) => {
        const { status, body } = await api(client, 'GET', `${MO}?pageSize=100&type=${type}&text=${encodeURIComponent(text)}`)
        expect(status, text).toBe(200)
        return body.managedObjects.map((mo: Json) => names[mo.id]).sort()
      }
      // the text index is updated asynchronously
      await eventually(async () => {
        expect(await search('ZX-77 c8y_Serial')).toEqual(['zeiss'])
      }, 15000)
      // whole words, stemmed (English), without case, diacritics, and stop words
      expect(await search('purging')).toEqual(['purge'])
      expect(await search('approvals')).toEqual(['purge'])
      expect(await search('machine')).toEqual(['hall'])
      expect(await search('timed')).toEqual([])
      expect(await search('TIMED_OUT')).toEqual(['purge'])
      expect(await search('the')).toEqual([])
      expect(await search('GDANSK')).toEqual(['gdansk'])
      expect(await search('CONT')).toEqual([])
      expect(await search('CMMs')).toEqual([])
      expect(await search('cmm')).toEqual(['cmm', 'zeiss'])
      // any word; fragments are not searched, external id types and values are
      expect(await search('Hamburg Prisma')).toEqual([])
      expect(await search('CT')).toEqual(['zeiss'])
      expect(await search(zeiss.id)).toEqual(['zeiss'])
      // phrases (all of them, as text within one field) and exclusions
      expect(await search('"werk gdansk"')).toEqual(['gdansk'])
      expect(await search('"ZEISS-CT"')).toEqual(['zeiss'])
      expect(await search('"ZEISS CT"')).toEqual([])
      expect(await search('"CMM ZEISS" "ZEISS CONTURA"')).toEqual(['zeiss'])
      expect(await search('"CMM ZEISS" "HH-CMM-02"')).toEqual([])
      expect(await search('cmm -contura')).toEqual(['cmm'])
      expect(await search('cmm -"cmm zeiss"')).toEqual(['cmm'])
      expect(await search('-contura')).toEqual([])
    },
  },
  {
    name: 'inventory: function arguments are single words or strings',
    verifies: ['query-function-arguments'],
    async run({ client, unique }) {
      const status = async (call: string) => (await api(client, 'GET', queryPath(`$filter=(type eq 'none-${unique}' and ${call})`))).status
      for (const call of ['bygroupid(abc)', 'bygroupid(\'x\')', 'bygroupid(1, 2)', 'bygroupid(-1)', 'isinhierarchyof(a.b)', 'isinhierarchyof($x)', 'has(a.)', 'has(\'x\')', 'hasany(a-, b)']) {
        expect(await status(call), call).toBe(200)
      }
      for (const call of ['bygroupid(12 34)', 'isinhierarchyof(<5 area ids>)', 'isinhierarchyof(...)', 'bygroupid()', 'bygroupid(-)', 'bygroupid(*)', 'bygroupid("x")', 'has(.a)', 'has(1)', 'has(-a)', 'hasany(a b)']) {
        expect(await status(call), call).toBe(422)
      }
    },
  },
  {
    name: 'inventory: $orderby syntax and order of the parts, boolean comparisons',
    verifies: ['query-orderby-syntax', 'query-boolean-order'],
    async run({ client, unique }) {
      const type = `ord-${unique}`
      for (const [name, num, flag] of [['c', 3, true], ['a', 1, false], ['b', 2, true]] as const) {
        await create(client, { name: `${name}-${unique}`, type, num, flag })
      }
      const names = async (query: string) => {
        const { status, body } = await api(client, 'GET', queryPath(query))
        expect(status, query).toBe(200)
        return body.managedObjects.map((mo: Json) => mo.name.split('-')[0])
      }
      const filter = `$filter=(type eq '${type}')`
      expect(await names(`${filter} $orderby=num desc`)).toEqual(['c', 'b', 'a'])
      expect(await names(`${filter}$orderby=num`)).toEqual(['a', 'b', 'c'])
      expect(await names(`${filter} $orderby=flag desc, num asc`)).toEqual(['b', 'c', 'a'])
      // the parts can come in any order
      expect(await names(`$orderby=num desc ${filter}`)).toEqual(['c', 'b', 'a'])
      // only lower-case directions, no trailing comma, no third word
      for (const orderBy of ['num DESC', 'num ASC', 'num asc,', 'num desc desc', 'num foo']) {
        const { status, body } = await api(client, 'GET', queryPath(`${filter} $orderby=${orderBy}`))
        expect(status, orderBy).toBe(422)
        expect(body.message).toBe(`Find by filter query failed : Query '${filter} $orderby=${orderBy}' could not be understood. Please try again.`)
      }
      // booleans compare with false before true
      expect((await names(`$filter=(type eq '${type}' and flag gt false) $orderby=num`))).toEqual(['b', 'c'])
      expect((await names(`$filter=(type eq '${type}' and flag le false)`))).toEqual(['a'])
      expect((await names(`$filter=(type eq '${type}' and flag lt true)`))).toEqual(['a'])
    },
  },
  {
    name: 'inventory: which of several $filter= and $orderby= parts count',
    verifies: ['query-several-parts'],
    async run({ client, unique }) {
      const types = { A: `pa-${unique}`, B: `pb-${unique}`, C: `pc-${unique}` }
      for (const [key, names] of [['A', ['a2', 'a3', 'a1']], ['B', ['b1', 'b2']], ['C', ['c1']]] as const) {
        for (const name of names) {
          await create(client, { name: `${name}-${unique}`, type: types[key] })
        }
      }
      const F = (key: keyof typeof types) => `$filter=(type eq '${types[key]}')`
      const O = '$orderby=name desc'
      const names = async (query: string) => {
        const { status, body } = await api(client, 'GET', queryPath(query))
        expect(status, query).toBe(200)
        return body.managedObjects.map((mo: Json) => mo.name.split('-')[0])
      }
      const sorted = (list: string[]) => [...list].sort()
      // two filters: the second, also when more follow (they are not checked)
      expect(sorted(await names(`${F('A')} ${F('B')}`))).toEqual(['b1', 'b2'])
      expect(sorted(await names(`${F('A')} ${F('B')} ${F('C')}`))).toEqual(['b1', 'b2'])
      expect(sorted(await names(`${F('A')} ${F('B')} $filter=(name zz)`))).toEqual(['b1', 'b2'])
      // ... but the first, without order, once an $orderby follows (not checked either)
      expect(sorted(await names(`${F('A')} ${F('B')} ${O}`))).toEqual(['a1', 'a2', 'a3'])
      expect(sorted(await names(`${F('A')} ${F('B')} ${F('C')} $orderby=name DESC`))).toEqual(['a1', 'a2', 'a3'])
      // a filter and an order among the first two parts: both, the rest is ignored
      expect(await names(`${F('A')} ${O} ${F('B')}`)).toEqual(['a3', 'a2', 'a1'])
      expect(await names(`${O} ${F('A')} ${F('B')}`)).toEqual(['a3', 'a2', 'a1'])
      expect(await names(`${F('A')} ${O} $orderby=name DESC`)).toEqual(['a3', 'a2', 'a1'])
      // text before the first part is ignored, an empty $filter= at the end too
      expect(sorted(await names(`(type eq '${types.A}') ${F('B')}`))).toEqual(['b1', 'b2'])
      expect(sorted(await names(`${F('A')} $filter=`))).toEqual(['a1', 'a2', 'a3'])
      // both of the first two parts must be valid; two orders are rejected
      for (const query of [`$filter=(name zz) ${F('A')}`, `${F('A')} $filter=(name zz) ${O}`, `${F('A')} $orderby=name DESC ${F('B')}`, `${O} ${O} ${F('A')}`]) {
        expect((await api(client, 'GET', queryPath(query))).status, query).toBe(422)
      }
    },
  },
  {
    name: 'inventory: query and q ignore the other list filters, except text and onlyRoots',
    verifies: ['query-ignores-filters'],
    async run({ client, unique }) {
      const group = await create(client, { name: `g-${unique}`, type: `p-${unique}`, c8y_IsDeviceGroup: {} })
      const device = await create(client, { name: `a-${unique}`, type: `p-${unique}`, c8y_IsDevice: {}, frag: {} })
      const child = await create(client, { name: `b-${unique}`, type: `p-${unique}`, c8y_IsDevice: {}, owner: `someone-${unique}` })
      const addition = await create(client, { name: `c-${unique}`, type: `q-${unique}` })
      for (const [parent, kind, id] of [[group.id, 'childAssets', device.id], [device.id, 'childDevices', child.id], [device.id, 'childAdditions', addition.id]]) {
        expect((await api(client, 'POST', `${MO}/${parent}/${kind}`, { managedObject: { id } })).status).toBe(201)
      }
      const names = async (params: string) => {
        const { status, body } = await api(client, 'GET', `${MO}?pageSize=100&${params}`)
        expect(status, params).toBe(200)
        return body.managedObjects.map((mo: Json) => mo.name.split('-')[0]).sort()
      }
      const all = ['a', 'b', 'c', 'g']
      const query = `query=${encodeURIComponent(`$filter=(name eq '*${unique}')`)}`
      for (const ignored of [`type=q-${unique}`, 'fragmentType=frag', `ids=${addition.id}`, `owner=someone-${unique}`, `childAssetId=${device.id}`, `childDeviceId=${child.id}`, `childAdditionId=${addition.id}`]) {
        expect(await names(`${query}&${ignored}`), ignored).toEqual(all)
        // without a query they filter
        expect((await names(`${ignored}`)).length, ignored).toBeLessThan(all.length)
      }
      expect(await names(`${query}&text=b`)).toEqual(['b'])
      expect(await names(`${query}&onlyRoots=true`)).toEqual(['g'])
      // q: the device query, the same rules
      const q = `q=${encodeURIComponent(`$filter=(name eq '*${unique}')`)}`
      expect(await names(`${q}&ids=${addition.id}`)).toEqual(['a', 'b'])
      expect(await names(`${q}&fragmentType=frag`)).toEqual(['a', 'b'])
      // with both, query wins and q is ignored with its device-only rule
      expect(await names(`${q}&query=${encodeURIComponent(`$filter=(type eq 'q-${unique}')`)}`)).toEqual(['c'])
    },
  },
  {
    name: 'inventory: create and update read the body like the platform',
    verifies: ['managed-object-body-types', 'managed-object-server-fields', 'managed-object-update-nothing', 'managed-object-body-format'],
    async run({ client, unique }) {
      // name, type, and owner take scalars as strings; null drops them on a create
      const scalars = await create(client, { name: 5, type: true, owner: 1.5, extra: `x-${unique}` })
      expect(scalars).toMatchObject({ name: '5', type: 'true', owner: '1.5' })
      const nameless = await create(client, { name: null, type: `t-${unique}` })
      expect(nameless).not.toHaveProperty('name')
      // their names do not contain the run id the cleanup looks for
      for (const unnamed of [scalars, nameless]) {
        expect((await api(client, 'DELETE', `${MO}/${unnamed.id}`)).status).toBe(204)
      }
      for (const body of [{ name: { x: 1 } }, { name: ['x'] }, { type: {} }, { childDevices: 5 }, { creationTime: 'nope' }]) {
        const { status, body: error } = await api(client, 'POST', MO, body)
        expect(status, JSON.stringify(body)).toBe(400)
        expect(error.error).toBe('Failed to parse JSON string')
      }
      // server fields: a create may set creationTime, not lastUpdated or id
      const dated = await create(client, { name: `dated-${unique}`, creationTime: '2020-01-01T10:00:00+02:00' })
      expect(dated.creationTime).toBe('2020-01-01T10:00:00.000+02:00')
      for (const [field, value] of [['id', '1'], ['lastUpdated', '2020-01-01T00:00:00Z']] as const) {
        const { status, body } = await api(client, 'POST', MO, { name: `x-${unique}`, [field]: value })
        expect(status, field).toBe(422)
        expect(body).toMatchObject({ error: 'undefined/validationError', message: `post.managedObjectRepresentation.${field}: is not allowed here` })
      }
      const id = dated.id
      const lastUpdate = await api(client, 'PUT', `${MO}/${id}`, { lastUpdated: '2020-01-01T00:00:00Z' })
      expect(lastUpdate.status).toBe(422)
      expect(lastUpdate.body.message).toBe('put.managedObjectRepresentation.lastUpdated: is not allowed here')

      // an update ignores creationTime, id, and links, and null for name, type, and owner
      const updated = await api(client, 'PUT', `${MO}/${id}`, { creationTime: '2021-01-01T00:00:00Z', id: '1', name: null, type: 7, f: 1 })
      expect(updated.status).toBe(200)
      expect(updated.body).toMatchObject({ id, name: `dated-${unique}`, type: '7', f: 1, creationTime: '2020-01-01T10:00:00.000+02:00' })
      // with nothing to change, nothing changes and the answer has only the links
      for (const body of [{}, { name: null, owner: null }, { id }, { self: 'x', childAssets: { references: [] } }]) {
        const nothing = await api(client, 'PUT', `${MO}/${id}`, body)
        expect(nothing.status, JSON.stringify(body)).toBe(200)
        expect(Object.keys(nothing.body), JSON.stringify(body)).toEqual(['self', 'id', 'childDevices', 'childAssets', 'childAdditions', 'deviceParents', 'assetParents', 'additionParents'])
      }
      expect((await api(client, 'GET', `${MO}/${id}`)).body).toMatchObject({ name: `dated-${unique}`, type: '7', lastUpdated: updated.body.lastUpdated })
      const dollar = await api(client, 'PUT', `${MO}/${id}`, { $x: 1 })
      expect(dollar.status).toBe(500)
      expect(dollar.body.message).toContain('The dollar ($) prefixed field \'$x\'')
      const unknown = await api(client, 'PUT', `${MO}/99999999999`, { f: 1 })
      expect(unknown).toMatchObject({ status: 404, body: { error: 'inventory/Not Found', message: 'Could not find managed object in database for update. : No managedObject for id \'99999999999\'!' } })

      // the body must be JSON: other content types 415 without a body, empty 400, null 500
      for (const method of ['POST', 'PUT']) {
        const path = method === 'POST' ? MO : `${MO}/${id}`
        const text = await api(client, method, path, { name: 'x' }, { 'content-type': 'text/plain' })
        expect(text, method).toEqual({ status: 415, body: undefined })
        const other = await api(client, method, path, { name: 'x' }, { 'content-type': 'application/vnd.com.nsn.cumulocity.event+json' })
        expect(other.status, method).toBe(415)
        const empty = await api(client, method, path, '')
        expect(empty.status, method).toBe(400)
        expect(empty.body.message).toContain('No content to map due to end-of-input')
        expect((await api(client, method, path, 'null')).status, method).toBe(500)
      }
      const vendor = await api(client, 'POST', MO, { name: `vendor-${unique}` }, { 'content-type': 'application/vnd.com.nsn.cumulocity.managedobject+json; charset=UTF-8' })
      expect(vendor.status).toBe(201)
    },
  },
  {
    name: 'inventory: updating several managed objects at once',
    verifies: ['managed-object-bulk-update'],
    async run({ client, unique }) {
      const a = await create(client, { name: `a-${unique}`, f: 1 })
      const b = await create(client, { name: `b-${unique}`, f: 1 })
      expect((await api(client, 'POST', `${MO}/${a.id}/childAssets`, { managedObject: { id: b.id } })).status).toBe(201)
      const { status, body } = await api(client, 'PUT', MO, { managedObjects: [{ id: b.id, g: 3 }, { id: a.id, f: 2, name: null }] })
      expect(status).toBe(200)
      expect(body.self).toMatch(/\/inventory\/managedObjects\?currentPage=1&pageSize=1000000$/)
      expect(body.statistics).toEqual({ totalPages: 1, pageSize: 1000000, currentPage: 1 })
      // the order of the answer is not stable; children come without names
      const byId = Object.fromEntries(body.managedObjects.map((mo: Json) => [mo.id, mo]))
      expect(byId[a.id]).toMatchObject({ name: `a-${unique}`, f: 2 })
      expect(byId[a.id].childAssets.references[0].managedObject).toEqual({ self: expect.any(String), id: b.id })
      expect(byId[b.id]).toMatchObject({ f: 1, g: 3 })

      // validation before any change: ids given, distinct, and known
      const failures: Array<[Json, number, Json]> = [
        [{ managedObjects: [] }, 422, { message: 'put.managedObjectCollection.managedObjects: At least one managed object is required for a bulk request' }],
        [{}, 422, { message: 'put.managedObjectCollection.managedObjects: At least one managed object is required for a bulk request' }],
        [{ managedObjects: [{ id: a.id, f: 3 }, { f: 4 }] }, 422, { message: 'put.managedObjectCollection.managedObjects[1].id: is required', bulkRequest: { failedIndex: 1 } }],
        [{ managedObjects: [{ id: a.id, f: 3 }, { id: a.id, f: 4 }] }, 422, { message: `put.managedObjectCollection.managedObjects: Duplicate ids: ${a.id}` }],
        [{ managedObjects: [{ id: a.id, f: 3 }, { id: '99999999999' }] }, 404, { error: 'inventory/Not Found', message: 'Could not find managed object in database for update. : No managedObject for id \'99999999999\'!', bulkRequest: { failedIndex: 1 } }],
        [{ managedObjects: {} }, 400, { error: 'Failed to parse JSON string' }],
      ]
      for (const [request, expected, error] of failures) {
        const failed = await api(client, 'PUT', MO, request)
        expect(failed.status, JSON.stringify(request)).toBe(expected)
        expect(failed.body, JSON.stringify(request)).toMatchObject(error)
      }
      expect((await api(client, 'GET', `${MO}/${a.id}`)).body.f).toBe(2)
      // a write error stops the request, earlier updates stay
      const dollar = await api(client, 'PUT', MO, { managedObjects: [{ id: a.id, f: 7 }, { id: b.id, $g: 3 }] })
      expect(dollar.status).toBe(500)
      expect((await api(client, 'GET', `${MO}/${a.id}`)).body.f).toBe(7)
    },
  },
  {
    name: 'inventory: adding child references, one or a collection by content type',
    verifies: ['child-reference-content-type', 'child-reference-errors', 'child-reference-response'],
    async run({ client, unique }) {
      const parent = await create(client, { name: `p-${unique}` })
      const kids: Json[] = []
      for (let i = 0; i < 4; i++) {
        kids.push(await create(client, { name: `k${i}-${unique}` }))
      }
      const grandchild = await create(client, { name: `gc-${unique}` })
      expect((await api(client, 'POST', `${MO}/${kids[0]!.id}/childAssets`, { managedObject: { id: grandchild.id } })).status).toBe(201)
      const path = `${MO}/${parent.id}/childDevices`
      const COLLECTION = { 'content-type': 'application/vnd.com.nsn.cumulocity.managedobjectreferencecollection+json' }
      const ids = async () => (await api(client, 'GET', `${path}?pageSize=100`)).body.references.map((reference: Json) => reference.managedObject.id).sort()

      // one reference: the child as it was before the link, its children without names
      const one = await api(client, 'POST', path, { managedObject: { id: kids[0]!.id } })
      expect(one.status).toBe(201)
      expect(one.body.self).toMatch(new RegExp(`/inventory/managedObjects/${parent.id}/childDevices/${kids[0]!.id}$`))
      expect(one.body.managedObject).toMatchObject({ id: kids[0]!.id, name: `k0-${unique}` })
      expect(one.body.managedObject.childAssets.references.map((reference: Json) => reference.managedObject)).toEqual([{ self: expect.any(String), id: grandchild.id }])
      const self = await create(client, { name: `self-${unique}` })
      const loop = await api(client, 'POST', `${MO}/${self.id}/childAssets`, { managedObject: { id: self.id } })
      expect(loop.status).toBe(201)
      expect(loop.body.managedObject.childAssets.references).toEqual([])
      // the id from a self link
      const linked = await api(client, 'POST', path, { managedObject: { self: `https://example.com/inventory/managedObjects/${kids[1]!.id}` } })
      expect(linked.body.managedObject.id).toBe(kids[1]!.id)
      // with plain JSON, `references` is not read: a reference without managedObject
      const plain = await api(client, 'POST', path, { references: [{ managedObject: { id: kids[2]!.id } }] })
      expect(plain).toMatchObject({ status: 422, body: { error: 'inventory/Invalid Data', message: 'no child reference provided for ManagedObjectRepresentation' } })

      // a collection: all or nothing, duplicates once
      const many = await api(client, 'POST', path, { references: [{ managedObject: { id: kids[2]!.id } }, { managedObject: { id: '99999999999' } }] }, COLLECTION)
      expect(many).toMatchObject({ status: 404, body: { error: 'inventory/Not Found', message: 'Finding device data from database failed : Some managedObjects don\'t exist in database: \'[ID [type=com_cumulocity_model_idtype_GId, value=99999999999]]\'' } })
      expect(await ids()).toEqual([kids[0]!.id, kids[1]!.id].sort())
      const added = await api(client, 'POST', path, { references: [{ managedObject: { id: kids[2]!.id } }, { managedObject: { id: kids[2]!.id } }, { managedObject: { id: kids[3]!.id } }] }, COLLECTION)
      expect(added.status).toBe(201)
      expect(added.body.self).toMatch(new RegExp(`/inventory/managedObjects/${parent.id}/childDevices$`))
      // the answer's order is not stable on the platform (the fake keeps the request order)
      expect(added.body.references.map((reference: Json) => reference.managedObject.id).sort()).toEqual([kids[2]!.id, kids[3]!.id].sort())
      expect(await ids()).toEqual(kids.map((kid) => kid.id).sort())
      for (const body of [{ references: [] }, {}, { managedObject: { id: grandchild.id } }]) {
        const empty = await api(client, 'POST', path, body, COLLECTION)
        expect(empty.status, JSON.stringify(body)).toBe(201)
        expect(empty.body.references, JSON.stringify(body)).toEqual([])
      }

      // invalid references
      const invalid: Array<[unknown, Record<string, string>, number, string]> = [
        [{}, {}, 422, 'no child reference provided for ManagedObjectRepresentation'],
        [{ managedObject: null }, {}, 422, 'no child reference provided for ManagedObjectRepresentation'],
        [{ managedObject: {} }, {}, 422, 'no child id provided for ManagedObjectRepresentation'],
        [{ managedObject: { id: null } }, {}, 422, 'no child id provided for ManagedObjectRepresentation'],
        [{ managedObject: { self: 'garbage' } }, {}, 422, 'invalid self url provided for ManagedObjectRepresentation: garbage'],
        [{ managedObject: { id: 'abc' } }, {}, 404, 'Finding device data from database failed : Some managedObjects don\'t exist in database: \'[ID [type=com_cumulocity_model_idtype_GId, value=abc]]\''],
        [{ references: [{}] }, COLLECTION, 422, 'no child reference provided for ManagedObjectRepresentation'],
        [{ references: [{ managedObject: {} }] }, COLLECTION, 422, 'no child id provided for ManagedObjectRepresentation'],
      ]
      for (const [body, headers, status, message] of invalid) {
        const rejected = await api(client, 'POST', path, body, headers)
        expect(rejected.status, JSON.stringify(body)).toBe(status)
        expect(rejected.body.message, JSON.stringify(body)).toBe(message)
      }
      expect((await api(client, 'POST', path, { managedObject: { id: kids[0]!.id } }, { 'content-type': 'text/plain' })).status).toBe(415)
      // creating a child validates like a create, with `create.` in the message
      const withId = await api(client, 'POST', `${MO}/${parent.id}/childAssets`, { name: `c-${unique}`, id: '1' }, { 'content-type': 'application/vnd.com.nsn.cumulocity.managedobject+json' })
      expect(withId).toMatchObject({ status: 422, body: { message: 'create.managedObjectRepresentation.id: is not allowed here' } })
    },
  },
  {
    name: 'inventory: child lists in creation order, the object in link order',
    verifies: ['child-list-creation-order'],
    async run({ client, unique }) {
      const parent = await create(client, { name: `p-${unique}` })
      const kids: string[] = []
      for (let i = 0; i < 6; i++) {
        kids.push((await create(client, { name: `k${i}-${unique}` })).id)
      }
      const linkOrder = [4, 1, 5, 0, 3, 2].map((index) => kids[index]!)
      for (const kid of linkOrder) {
        expect((await api(client, 'POST', `${MO}/${parent.id}/childAssets`, { managedObject: { id: kid } })).status).toBe(201)
      }
      const listed = await api(client, 'GET', `${MO}/${parent.id}/childAssets?pageSize=100`)
      expect(listed.body.references.map((reference: Json) => reference.managedObject.id)).toEqual(kids)
      const filtered = await api(client, 'GET', `${MO}/${parent.id}/childAssets?pageSize=100&query=${encodeURIComponent('$filter=(name eq \'k*\')')}`)
      expect(filtered.body.references.map((reference: Json) => reference.managedObject.id)).toEqual(kids)
      const groups = await api(client, 'GET', queryPath(`$filter=(bygroupid(${parent.id}))`))
      expect(groups.body.managedObjects.map((mo: Json) => mo.id)).toEqual(kids)
      const detail = await api(client, 'GET', `${MO}/${parent.id}`)
      expect(detail.body.childAssets.references.map((reference: Json) => reference.managedObject.id)).toEqual(linkOrder)
      // linked again after a removal: last in the object, still in creation order in the list
      expect((await api(client, 'DELETE', `${MO}/${parent.id}/childAssets/${linkOrder[0]}`)).status).toBe(204)
      expect((await api(client, 'POST', `${MO}/${parent.id}/childAssets`, { managedObject: { id: linkOrder[0] } })).status).toBe(201)
      expect((await api(client, 'GET', `${MO}/${parent.id}`)).body.childAssets.references.map((reference: Json) => reference.managedObject.id)).toEqual([...linkOrder.slice(1), linkOrder[0]])
      expect((await api(client, 'GET', `${MO}/${parent.id}/childAssets?pageSize=100`)).body.references.map((reference: Json) => reference.managedObject.id)).toEqual(kids)
      const badPage = await api(client, 'GET', `${MO}/${parent.id}/childAssets?pageSize=x`)
      expect(badPage).toMatchObject({ status: 422, body: { error: 'REST API/Unprocessable Entity', message: 'Parameter \'pageSize\' must have an integer value!' } })
      // withDeviceUser is accepted for an object without a device user
      expect((await api(client, 'DELETE', `${MO}/${kids[0]}?withDeviceUser=true`)).status).toBe(204)
    },
  },
  {
    name: 'identity: shape, values read as strings, unknown and invalid global ids, search',
    verifies: ['external-id-values', 'external-id-global-id', 'identity-search-answer'],
    async run({ client, unique }) {
      const device = await create(client, { name: `d-${unique}` })
      const type = `t_${unique}`
      const created = await api(client, 'POST', `/identity/globalIds/${device.id}/externalIds`, { type, externalId: `x1-${unique}`, managedObject: { id: '1' }, foo: 1 })
      expect(created.status).toBe(201)
      expect(Object.keys(created.body)).toEqual(['self', 'externalId', 'type', 'managedObject'])
      expect(created.body.managedObject).toEqual({ self: expect.stringMatching(new RegExp(`/inventory/managedObjects/${device.id}$`)), id: device.id })
      // scalars become strings, whitespace is kept
      const number = await api(client, 'POST', `/identity/globalIds/${device.id}/externalIds`, { type, externalId: 5 })
      expect(number.body).toMatchObject({ externalId: '5', type })
      expect((await api(client, 'GET', `/identity/externalIds/${type}/5`)).body.externalId).toBe('5')
      const spaced = await api(client, 'POST', `/identity/globalIds/${device.id}/externalIds`, { type, externalId: ` sp ${unique} ` })
      expect(spaced.body.self).toMatch(/\/%20sp%20.*%20$/)
      for (const body of [{ type, externalId: { x: 1 } }, { type: [type], externalId: 'y' }]) {
        const rejected = await api(client, 'POST', `/identity/globalIds/${device.id}/externalIds`, body)
        expect(rejected.status, JSON.stringify(body)).toBe(400)
        expect(rejected.body.error).toBe('Failed to parse JSON string')
      }
      expect((await api(client, 'POST', `/identity/globalIds/${device.id}/externalIds`, { type, externalId: 'z' }, { 'content-type': 'text/plain' })).status).toBe(415)
      expect((await api(client, 'POST', `/identity/globalIds/${device.id}/externalIds`, '')).status).toBe(400)

      // unknown global ids: 404 for a number, 422 otherwise
      const unknown = await api(client, 'POST', '/identity/globalIds/99999999999/externalIds', { type, externalId: `u-${unique}` })
      expect(unknown).toMatchObject({ status: 404, body: { error: 'identity/Not Found', message: 'Global id not found;' } })
      const invalid = await api(client, 'POST', '/identity/globalIds/abc/externalIds', { type, externalId: `u-${unique}` })
      expect(invalid).toMatchObject({ status: 422, body: { error: 'identity/Invalid Data', message: 'GId value has to be a number !' } })

      // search: no self link, unknown ids left out, repeated ones repeated
      const search = await api(client, 'POST', '/identity/search', { externalIds: [{ type, externalId: `x1-${unique}` }, { type, externalId: 'nope' }, { type, externalId: '5' }, { type, externalId: `x1-${unique}` }] })
      expect(search.status).toBe(200)
      expect(Object.keys(search.body)).toEqual(['externalIds'])
      expect(search.body.externalIds.map((entry: Json) => entry.externalId)).toEqual([`x1-${unique}`, '5', `x1-${unique}`])
      expect(search.body.externalIds[0]).toEqual(created.body)
    },
  },
  {
    name: 'inventory binaries: upload validation, the binary representation, replace, and list filters',
    verifies: ['binary-upload-validation', 'binary-representation', 'binary-replace-raw', 'binaries-list-filters', 'binaries-unknown-messages'],
    async run({ client, unique }) {
      // a hand-made multipart body: the client would send a FormData as JSON
      const upload = async (object: unknown, file?: string) => {
        const parts = [
          ...(object !== undefined ? [`Content-Disposition: form-data; name="object"\r\n\r\n${typeof object === 'string' ? object : JSON.stringify(object)}`] : []),
          ...(file !== undefined ? [`Content-Disposition: form-data; name="file"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\n${file}`] : []),
        ]
        const body = `${parts.map((part) => `--xyz\r\n${part}\r\n`).join('')}--xyz--\r\n`
        return api(client, 'POST', '/inventory/binaries', body, { 'content-type': 'multipart/form-data; boundary=xyz' })
      }
      const type = `custom-${unique}`
      const created = await upload({ name: `a-${unique}`, type, extra: 1 }, 'hello')
      expect(created.status).toBe(201)
      expect(created.body.self).toMatch(new RegExp(`/inventory/binaries/${created.body.id}$`))
      expect(created.body).toMatchObject({ type, name: `a-${unique}`, length: 5, contentType: 'text/plain', c8y_IsBinary: '', extra: 1 })
      for (const field of ['creationTime', 'childDevices', 'childAssets', 'assetParents']) {
        expect(created.body, field).not.toHaveProperty(field)
      }
      expect((await api(client, 'GET', `${MO}/${created.body.id}`)).body).toHaveProperty('childAssets')
      const second = await upload({ name: `b-${unique}`, type }, 'x')
      const named = await upload({ name: 7, type: '' }, 'x')
      expect(named.body).toMatchObject({ name: '7', type: '' })
      expect((await api(client, 'DELETE', `/inventory/binaries/${named.body.id}`)).status).toBe(204)

      // validation
      const missingPart = { error: 'inventory/Bad Request', message: 'Missing field in form. The fields \'object\' and \'file\' are necessary for this request.' }
      expect(await upload(undefined, 'x')).toMatchObject({ status: 400, body: missingPart })
      expect(await upload({ name: `n-${unique}`, type })).toMatchObject({ status: 400, body: missingPart })
      for (const object of [{ name: `n-${unique}` }, { type }, {}]) {
        expect(await upload(object, 'x'), JSON.stringify(object)).toMatchObject({ status: 400, body: { error: 'inventory/Bad Request', message: 'Missing field in object. The fields \'name\' and \'type\' are necessary for this request.' } })
      }
      expect(await upload({ name: `n-${unique}`, id: '1' }, 'x')).toMatchObject({ status: 422, body: { error: 'undefined/validationError', message: 'id is not allowed here' } })
      for (const object of ['{nope', '[1]']) {
        expect((await upload(object, 'x')).status, object).toBe(500)
      }
      expect((await api(client, 'POST', '/inventory/binaries', { name: `j-${unique}` })).status).toBe(400)
      expect((await api(client, 'POST', '/inventory/binaries', 'raw', { 'content-type': 'application/octet-stream' })).status).toBe(415)

      // list filters: one of ids, type, owner; two of them match nothing; text fails
      const names = async (params: string) => {
        const { status, body } = await api(client, 'GET', `/inventory/binaries?pageSize=100&${params}`)
        expect(status, params).toBe(200)
        return body.managedObjects.map((mo: Json) => mo.name).sort()
      }
      expect(await names(`type=${type}`)).toEqual([`a-${unique}`, `b-${unique}`])
      expect(await names(`ids=${created.body.id},${second.body.id}`)).toEqual([`a-${unique}`, `b-${unique}`])
      expect(await names(`ids=${created.body.id},${second.body.id}&fragmentType=extra`)).toEqual([`a-${unique}`, `b-${unique}`])
      const listed = await api(client, 'GET', `/inventory/binaries?ids=${created.body.id}`)
      expect(listed.body.managedObjects[0].self).toMatch(/\/inventory\/binaries\/\d+$/)
      expect(listed.body.managedObjects[0]).not.toHaveProperty('childAssets')
      for (const combined of [`ids=${second.body.id}&type=${type}`, `ids=${created.body.id}&owner=${created.body.owner}`, `type=${type}&owner=${created.body.owner}`, `ids=${created.body.id}&text=a`]) {
        expect(await names(combined), combined).toEqual([])
      }
      expect((await api(client, 'GET', '/inventory/binaries?text=a')).status).toBe(500)
      expect((await api(client, 'GET', '/inventory/binaries?pageSize=x')).body.error).toBe('REST API/Unprocessable Entity')

      // replace: the raw body and its content type as they come, answered with the binary
      const replaced = await api(client, 'PUT', `/inventory/binaries/${created.body.id}`, 'a,b', { 'content-type': 'text/csv' })
      expect(replaced.status).toBe(201)
      expect(replaced.body).toMatchObject({ id: created.body.id, type: 'text/csv', contentType: 'text/csv', length: 3, extra: 1 })
      expect((await api(client, 'PUT', `/inventory/binaries/${created.body.id}`, '', { 'content-type': 'text/plain' }))).toMatchObject({ status: 400, body: missingPart })
      const part = '--xyz\r\nContent-Disposition: form-data; name="file"; filename="mp.txt"\r\nContent-Type: text/plain\r\n\r\nmp\r\n--xyz--\r\n'
      const multipart = await api(client, 'PUT', `/inventory/binaries/${second.body.id}`, part, { 'content-type': 'multipart/form-data; boundary=xyz' })
      expect(multipart.body).toMatchObject({ type: 'multipart/form-data; boundary=xyz', length: part.length })
      const download = await client.core.fetch(`/inventory/binaries/${second.body.id}`)
      expect(await download.text()).toBe(part)

      // unknown ids and objects that are no binaries
      const device = await create(client, { name: `d-${unique}` })
      for (const id of [device.id, '99999999999']) {
        for (const [method, body] of [['GET', undefined], ['PUT', 'x']] as const) {
          const missing = await api(client, method, `/inventory/binaries/${id}`, body, { 'content-type': 'text/plain' })
          expect(missing, `${method} ${id}`).toMatchObject({ status: 404, body: { error: 'inventory/Not Found', message: `Resource ID [type=com_cumulocity_model_idtype_GId, value=${id}] for this request not found.` } })
        }
      }
      expect((await api(client, 'DELETE', '/inventory/binaries/99999999999'))).toMatchObject({ status: 404, body: { message: 'Delete attachment query failed. : Attachment not found' } })
    },
  },
  {
    name: 'paging: key order of pages and statistics, flag values',
    verifies: ['paging-key-order', 'flag-values'],
    async run({ client, unique }) {
      const type = `pg-${unique}`
      for (const name of ['a', 'b', 'c']) {
        await create(client, { name: `${name}-${unique}`, type })
      }
      const page = async (params: string) => (await api(client, 'GET', `${MO}?type=${type}&pageSize=1&${params}`)).body
      const second = await page('currentPage=2&withTotalPages=true&withTotalElements=true')
      expect(Object.keys(second)).toEqual(['self', 'prev', 'next', 'managedObjects', 'statistics'])
      expect(Object.keys(second.statistics)).toEqual(['totalPages', 'pageSize', 'currentPage', 'totalElements'])
      expect(Object.keys(await page('currentPage=3&withTotalPages=true'))).toEqual(['self', 'prev', 'managedObjects', 'statistics'])
      // the totals count with any value but false, other flags are case-insensitive
      for (const value of ['TRUE', 'yes', '1', '']) {
        expect((await page(`withTotalPages=${value}&withTotalElements=${value}`)).statistics, value).toEqual({ totalPages: 3, pageSize: 1, currentPage: 1, totalElements: 3 })
      }
      expect((await page('withTotalPages=FALSE')).statistics).toEqual({ pageSize: 1, currentPage: 1 })
      const group = await create(client, { name: `g-${unique}`, c8y_IsDeviceGroup: {} })
      const asset = await create(client, { name: `x-${unique}` })
      expect((await api(client, 'POST', `${MO}/${group.id}/childAssets`, { managedObject: { id: asset.id } })).status).toBe(201)
      const children = async (params: string) => (await api(client, 'GET', `${MO}/${group.id}?${params}`)).body.childAssets.references.length
      expect(await children('withChildren=no')).toBe(1)
      expect(await children('withChildren=FALSE')).toBe(0)
      // cascade=TRUE takes the plain asset along
      expect((await api(client, 'DELETE', `${MO}/${group.id}?cascade=TRUE`)).status).toBe(204)
      await eventually(async () => {
        expect((await api(client, 'GET', `${MO}/${asset.id}`)).status).toBe(404)
      })
    },
  },
]
