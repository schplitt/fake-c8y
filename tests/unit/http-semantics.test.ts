/**
 * What a client sees of HTTP itself: the reason phrase in `statusText`, and
 * a request whose signal is already aborted, which is never sent.
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'

const json = { 'accept': 'application/json', 'content-type': 'application/json' }

describe('reason phrases', () => {
  it('answers platform requests with the standard reason phrase', async () => {
    const world = createWorld()
    const created = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Pump' }) }))
    const missing = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects/404404`, { headers: json }))
    const listed = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { headers: json }))

    expect([created.status, created.statusText]).toEqual([201, 'Created'])
    expect([missing.status, missing.statusText]).toEqual([404, 'Not Found'])
    expect([listed.status, listed.statusText]).toEqual([200, 'OK'])
    expect((await missing.json() as { error: string }).error).toBe('inventory/Not Found')
  })

  it('adds it to a service answer without one and keeps a service\'s own', async () => {
    const world = createWorld()
    world.service('svc', async (request) => (new URL(request.url).pathname === '/own'
      ? new Response('teapot', { status: 418, statusText: 'Short and stout' })
      : Response.json({ message: 'gone' }, { status: 404 })))

    const plain = await world.fetch(new Request(`${world.baseUrl}/service/svc/x`))
    const own = await world.fetch(new Request(`${world.baseUrl}/service/svc/own`))

    expect([plain.status, plain.statusText, await plain.text()]).toEqual([404, 'Not Found', '{"message":"gone"}'])
    expect([own.status, own.statusText]).toEqual([418, 'Short and stout'])
  })

  it('keeps the headers and an empty body', async () => {
    const world = createWorld()
    const created = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Pump' }) }))
    const { id } = await created.json() as { id: string }
    const deleted = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects/${id}`, { method: 'DELETE' }))

    expect(created.headers.get('location')).toContain(`/inventory/managedObjects/${id}`)
    expect([deleted.status, deleted.statusText, await deleted.text()]).toEqual([204, 'No Content', ''])
  })
})

describe('an aborted signal', () => {
  it('rejects a platform request with the signal\'s reason and sends nothing', async () => {
    const world = createWorld()
    const controller = new AbortController()
    controller.abort()

    const sent = world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Pump' }), signal: controller.signal }))

    await expect(sent).rejects.toMatchObject({ name: 'AbortError' })
    expect(world.calls).toEqual([])
    expect(world.db.managedObjects.find({ name: 'Pump' })).toEqual([])
  })

  it('rejects a service\'s request the same way', async () => {
    const world = createWorld()
    const controller = new AbortController()
    controller.abort()
    let thrown: unknown
    world.service('svc', async (_request, ctx) => {
      try {
        await ctx.fetch('/inventory/managedObjects', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Pump' }), signal: controller.signal })
      } catch (error) {
        thrown = error
      }
      return new Response(null, { status: 204 })
    })

    await world.fetch(new Request(`${world.baseUrl}/service/svc/go`, { method: 'POST' }))

    expect(thrown).toMatchObject({ name: 'AbortError' })
    expect(world.calls.map((call) => call.path)).toEqual(['/service/svc/go'])
  })

  it('does not change a request whose signal is not aborted', async () => {
    const world = createWorld()
    const response = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { headers: json, signal: new AbortController().signal }))

    expect(response.status).toBe(200)
  })
})

describe('a signal that fires mid-flight', () => {
  /**
   * A service that answers only when `release` is called.
   * @param world - The world
   */
  function slowService(world: ReturnType<typeof createWorld>): { release: () => void, started: Promise<void> } {
    let release!: () => void
    let begin!: () => void
    const started = new Promise<void>((resolve) => {
      begin = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    world.service('slow', async () => {
      begin()
      await gate
      return Response.json({ done: true })
    })
    return { release, started }
  }

  it('rejects the waiting platform request at once with an AbortError and records the call as aborted', async () => {
    const world = createWorld()
    const { release, started } = slowService(world)
    const controller = new AbortController()

    const sent = world.fetch(new Request(`${world.baseUrl}/service/slow/go`, { signal: controller.signal }))
    await started
    controller.abort()

    await expect(sent).rejects.toMatchObject({ name: 'AbortError' })
    release()
    while (world.inflight > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, 1)
      })
    }
    expect(world.calls.map((call) => [call.path, call.status, call.aborted])).toEqual([['/service/slow/go', 200, true]])
  })

  it('rejects with a custom reason as is', async () => {
    const world = createWorld()
    const { release, started } = slowService(world)
    const controller = new AbortController()
    const reason = new Error('the run ended')

    const sent = world.fetch(new Request(`${world.baseUrl}/service/slow/go`, { signal: controller.signal }))
    await started
    controller.abort(reason)

    await expect(sent).rejects.toBe(reason)
    release()
  })

  it('rejects a service\'s waiting request the same way', async () => {
    const world = createWorld()
    const { release, started } = slowService(world)
    const controller = new AbortController()
    const reason = new Error('stop')
    let thrown: unknown
    world.service('caller', async (_request, ctx) => {
      const pending = ctx.fetch('/service/slow/go', { signal: controller.signal })
      await started
      controller.abort(reason)
      try {
        await pending
      } catch (error) {
        thrown = error
      }
      return new Response(null, { status: 204 })
    })

    const answered = await world.fetch(new Request(`${world.baseUrl}/service/caller/go`, { method: 'POST' }))
    release()

    expect(answered.status).toBe(204)
    expect(thrown).toBe(reason)
  })

  it('does not mark a call answered before the abort', async () => {
    const world = createWorld()
    const controller = new AbortController()
    const response = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { signal: controller.signal }))
    controller.abort()

    expect(response.status).toBe(200)
    expect(world.calls[0]!.aborted).toBeUndefined()
  })
})

describe('a pre-aborted signal with a custom reason', () => {
  it('rejects with that reason, from world.fetch and from ctx.fetch', async () => {
    const world = createWorld()
    const controller = new AbortController()
    const reason = new Error('x')
    controller.abort(reason)
    let thrown: unknown
    world.service('svc', async (_request, ctx) => {
      try {
        await ctx.fetch('/inventory/managedObjects', { signal: controller.signal })
      } catch (error) {
        thrown = error
      }
      return new Response(null, { status: 204 })
    })

    await expect(world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects`, { signal: controller.signal }))).rejects.toBe(reason)
    await world.fetch(new Request(`${world.baseUrl}/service/svc/go`, { method: 'POST' }))
    expect(thrown).toBe(reason)
  })
})

describe('a streamed answer', () => {
  it('reaches the caller with its reason phrase before the body ends, chunk by chunk', async () => {
    const world = createWorld()
    let push!: (chunk: string) => void
    world.service('stream', async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        push = (chunk) => controller.enqueue(encoder.encode(chunk))
        push('first')
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))

    const response = await Promise.race([
      world.fetch(new Request(`${world.baseUrl}/service/stream/events`)),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('the answer waited for the body')), 500)
      }),
    ])
    expect([response.status, response.statusText]).toEqual([200, 'OK'])

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toBe('first')
    push('second')
    expect(decoder.decode((await reader.read()).value)).toBe('second')
    await reader.cancel()
  })
})

describe('the reason phrase table', () => {
  it('equals Node\'s http.STATUS_CODES', async () => {
    const { STATUS_CODES } = await import('node:http')
    const world = createWorld()
    world.service('status', async (request) => new Response(null, { status: Number(new URL(request.url).pathname.slice(1)) }))
    const answers: Record<number, string> = {}
    for (const code of Object.keys(STATUS_CODES).map(Number).filter((code) => code >= 200)) {
      answers[code] = (await world.fetch(new Request(`${world.baseUrl}/service/status/${code}`))).statusText
    }

    expect(answers).toEqual(Object.fromEntries(Object.entries(STATUS_CODES).filter(([code]) => Number(code) >= 200)))
  })
})

describe('reason phrases of the fake\'s own answers', () => {
  it('a service that fails gets 500 Internal Server Error', async () => {
    const world = createWorld()
    world.service('broken', async () => {
      throw new Error('boom')
    })

    const response = await world.fetch(new Request(`${world.baseUrl}/service/broken/go`))

    expect([response.status, response.statusText]).toEqual([500, 'Internal Server Error'])
  })

  it('a service that fails after a reset gets 503 Service Unavailable', async () => {
    const base = createWorld()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    base.service('late', async () => {
      await gate
      throw new Error('after the reset')
    })
    const fork = base.fork()

    const pending = fork.fetch(new Request(`${fork.baseUrl}/service/late/go`))
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    fork.reset()
    release()
    const response = await pending

    expect([response.status, response.statusText]).toEqual([503, 'Service Unavailable'])
  })

  it('an override that fails after a reset gets 503 Service Unavailable', async () => {
    const world = createWorld()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    world.override('GET /custom/late', async () => {
      await gate
      throw new Error('after the reset')
    })

    const pending = world.fetch(new Request(`${world.baseUrl}/custom/late`))
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    world.reset()
    release()
    const response = await pending

    expect([response.status, response.statusText]).toEqual([503, 'Service Unavailable'])
  })

  it('a service\'s request after a reset gets 503 Service Unavailable', async () => {
    const base = createWorld()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let stale: Response | undefined
    base.service('late', async (_request, ctx) => {
      await gate
      stale = await ctx.fetch('/inventory/managedObjects')
      return new Response(null, { status: 204 })
    })
    const fork = base.fork()

    const pending = fork.fetch(new Request(`${fork.baseUrl}/service/late/go`))
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    fork.reset()
    release()
    await pending

    expect([stale?.status, stale?.statusText]).toEqual([503, 'Service Unavailable'])
  })
})
