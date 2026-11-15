/**
 * The glue every harness needs: `installFetchClient()` (fake-c8y/c8y-client)
 * for the real `@c8y/client`, `interceptFetch()` for the global `fetch`, the
 * `ws` flavor of the fake WebSocket, and `overrideHint` for wrappers that
 * expose overrides under their own name.
 */
import { Buffer } from 'node:buffer'
import { BasicAuth, Client, FetchClient } from '@c8y/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorld, interceptFetch } from '../../src'
import type { World } from '../../src'
import { installFetchClient } from '../../src/c8y-client'
import { createFakeWebSocket } from '../../src/realtime-entry'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!()
  }
})

function client(world: World): Client {
  return new Client(new BasicAuth({ tenant: world.tenant, user: 'test-user', password: 'secret' }), world.baseUrl)
}

describe('installFetchClient()', () => {
  it('answers the client\'s requests from the world, with its auth and query', async () => {
    const world = createWorld()
    cleanups.push(installFetchClient(FetchClient, () => world))
    const pump = world.device({ name: 'Pump', type: 'pump' })
    world.device({ name: 'Valve', type: 'valve' })

    const { data } = await client(world).inventory.list({ type: 'pump' })
    expect(data.map((item) => item.id)).toEqual([pump])
    expect(world.calls[0]).toMatchObject({ method: 'GET', tenant: world.tenant, user: 'test-user', query: { type: 'pump' } })

    const { data: created } = await client(world).inventory.create({ name: 'Created' })
    expect(world.db.managedObjects.get(created.id)).toMatchObject({ name: 'Created' })
  })

  it('sends uploads of the Node form-data package as multipart bytes', async () => {
    const world = createWorld()
    cleanups.push(installFetchClient(FetchClient, world))
    const { data, res } = await client(world).inventoryBinary.create(Buffer.from('file content'), { name: 'report.txt', type: 'text/plain' } as any)
    expect(res.status).toBe(201)
    expect(world.db.binaries.content(data.id!)?.text()).toBe('file content')
    expect(world.unhandled).toEqual([])
  })

  it('reads the world per request, so the client follows a new fork', async () => {
    const base = createWorld()
    base.device({ name: 'Base' })
    let current = base.fork()
    cleanups.push(installFetchClient(FetchClient, () => current))
    await client(current).inventory.create({ name: 'In fork 1' })
    const first = current
    current = base.fork()
    const { data } = await client(current).inventory.list({ pageSize: 10 })
    expect(data.map((item) => item.name)).toEqual(['Base'])
    expect(first.db.managedObjects.find({ name: 'In fork 1' })).toHaveLength(1)
  })

  it('puts the client\'s own fetch back', async () => {
    const original = FetchClient.prototype.fetch
    const world = createWorld()
    const uninstall = installFetchClient(FetchClient, world)
    expect(FetchClient.prototype.fetch).not.toBe(original)
    expect((await client(world).user.current()).data.userName).toBe('test-user')
    uninstall()
    expect(FetchClient.prototype.fetch).toBe(original)
  })
})

describe('interceptFetch()', () => {
  function stubFetch(): string[] {
    const passed: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      passed.push(input instanceof Request ? input.url : String(input))
      return new Response('network')
    }) as typeof fetch
    cleanups.push(() => {
      globalThis.fetch = original
    })
    return passed
  }

  it('answers requests to the world\'s origin and passes the rest through', async () => {
    const passed = stubFetch()
    const world = createWorld()
    const pump = world.device({ name: 'Pump' })
    const restore = interceptFetch(() => world)
    const response = await fetch(`${world.baseUrl}/inventory/managedObjects/${pump}`, { headers: { accept: 'application/json' } })
    expect(await response.json()).toMatchObject({ id: pump, name: 'Pump' })
    expect(await (await fetch('https://example.test/x')).text()).toBe('network')
    expect(passed).toEqual(['https://example.test/x'])
    expect(world.calls).toHaveLength(1)

    restore()
    await fetch(`${world.baseUrl}/inventory/managedObjects/${pump}`)
    expect(passed).toHaveLength(2)
    expect(world.calls).toHaveLength(1)
  })

  it('takes another origin and Request objects', async () => {
    const passed = stubFetch()
    const world = createWorld()
    cleanups.push(interceptFetch(world, { origin: 'https://platform.example.test' }))
    const response = await fetch(new Request('https://platform.example.test/user/currentUser'))
    expect(response.status).toBe(200)
    await fetch(`${world.baseUrl}/user/currentUser`)
    expect(passed).toEqual([`${world.baseUrl}/user/currentUser`])
  })
})

describe('createFakeWebSocket({ flavor })', () => {
  async function receive(options: Parameters<typeof createFakeWebSocket>[1], { withoutBuffer = false } = {}) {
    const queue: Array<() => void> = []
    const world = createWorld({ schedule: (callback) => queue.push(callback) })
    const run = () => {
      while (queue.length > 0) {
        queue.shift()!()
      }
    }
    const post = (path: string, body: unknown) => world.fetch(new Request(`${world.baseUrl}${path}`, { method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    await post('/notification2/subscriptions', { context: 'tenant', subscription: 'sub' })
    const { token } = await (await post('/notification2/token', { subscription: 'sub', subscriber: 'a' })).json()
    const WebSocket = createFakeWebSocket(world.realtime, options)
    const socket = new WebSocket(`wss://example.test/notification2/consumer/?token=${token}`)
    const messages: unknown[][] = []
    const closes: unknown[][] = []
    socket.on('message', (...args: unknown[]) => messages.push(args))
    socket.on('close', (...args: unknown[]) => closes.push(args))
    run()
    await post('/inventory/managedObjects', { name: 'Pump' })
    // the frame is encoded on delivery: take Buffer away only there (undici needs it)
    const buffer: unknown = Reflect.get(globalThis, 'Buffer')
    if (withoutBuffer) {
      Reflect.deleteProperty(globalThis, 'Buffer')
    }
    try {
      run()
    } finally {
      Reflect.set(globalThis, 'Buffer', buffer)
    }
    socket.close()
    run()
    return { messages, closes }
  }

  it('emits the text by default', async () => {
    const { messages, closes } = await receive(undefined)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toHaveLength(1)
    expect(typeof messages[0]![0]).toBe('string')
    expect(closes).toEqual([[1000, '']])
  })

  it('emits a Buffer and isBinary like the ws package', async () => {
    const { messages, closes } = await receive({ flavor: 'ws' })
    const [data, isBinary] = messages[0]!
    expect(Buffer.isBuffer(data)).toBe(true)
    expect(String(data)).toContain('"name":"Pump"')
    expect(isBinary).toBe(false)
    expect(Buffer.isBuffer(closes[0]![1])).toBe(true)
  })

  it('uses UTF-8 bytes where the runtime has no Buffer', async () => {
    const { messages } = await receive({ flavor: 'ws' }, { withoutBuffer: true })
    const [data] = messages[0]!
    expect(data).toBeInstanceOf(Uint8Array)
    expect(Buffer.isBuffer(data)).toBe(false)
    expect(new TextDecoder().decode(data as Uint8Array)).toContain('"name":"Pump"')
  })

  it('lets encodeMessage win over the flavor', async () => {
    const { messages } = await receive({ flavor: 'ws', encodeMessage: (text) => ({ text }) })
    expect(messages[0]![0]).toMatchObject({ text: expect.stringContaining('Pump') })
    expect(messages[0]![1]).toBe(false)
    expect((await receive({ encodeMessage: (text) => text.length })).messages[0]![0]).toBeTypeOf('number')
  })
})

describe('overrideHint', () => {
  const get = (world: World, path: string) => world.fetch(new Request(`${world.baseUrl}${path}`))

  it('names world.override() by default', async () => {
    const world = createWorld()
    const body = await (await get(world, '/nowhere/assets')).json()
    expect(body.message).toContain('Answer it with world.override(\'GET /nowhere/assets\', ...).')
  })

  it('names the wrapper\'s API in the developer 501, also on a fork', async () => {
    const world = createWorld({ overrideHint: (request) => `c8y.override('${request.method} ${request.path}', ...)` })
    const response = await get(world, '/nowhere/assets')
    expect(response.status).toBe(501)
    expect((await response.json()).message).toContain('Answer it with c8y.override(\'GET /nowhere/assets\', ...).')
    const fork = world.fork()
    expect((await (await get(fork, '/nowhere/assets')).json()).message).toContain('c8y.override(')
    const own = world.fork({ overrideHint: () => 'my.hint()' })
    expect((await (await get(own, '/nowhere/assets')).json()).message).toContain('Answer it with my.hint().')
  })

  it('tells how to answer with an error in the developer 500', async () => {
    const world = createWorld()
    world.override('GET /custom', () => {
      throw new Error('boom')
    })
    const response = await get(world, '/custom')
    expect(response.status).toBe(500)
    expect((await response.json()).message).toContain('return a Response with that status instead')
    expect(world.unhandled).toMatchObject([{ kind: 'error' }])
  })
})
