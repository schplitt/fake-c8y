/**
 * Routes the real `@c8y/client` (every request goes through
 * `FetchClient.prototype.fetch`) and the global `fetch` to the platform's URL
 * to one world, the same way a test framework adapter does. Resets the world
 * before every test and fails a test that sent a request the world does not
 * emulate.
 */
import { Buffer } from 'node:buffer'
import { FetchClient } from '@c8y/client'
import { afterEach, beforeEach } from 'vitest'
import { createWorld } from '../../src'
import type { World } from '../../src'
import { createFakeWebSocket } from '../../src/realtime-entry'
import type { FakeWebSocketClass } from '../../src/realtime-entry'
import { seedBase } from './fork-base'

export interface FakePlatform {
  world: World
  /**
   * The world's consumer WebSocket, with `ws`-style Buffer messages.
   */
  FakeWebSocket: FakeWebSocketClass
  /**
   * Moves the fake's clock forward, so time-based behavior (bulk operation
   * ramps) happens without waiting.
   */
  advanceClock: (ms: number) => void
  /**
   * The frozen base of the world, with `fork: true`.
   */
  base?: World
}

interface FetchClientInternals {
  getUrl: (url: string, init?: object) => string
  getFetchOptions: (init?: object) => ConstructorParameters<typeof Request>[1]
  adjustOptionsForFormData: (options: ConstructorParameters<typeof Request>[1]) => ConstructorParameters<typeof Request>[1]
}

/**
 * Creates the world and routes the client and `fetch` to it.
 * @param options - Options
 * @param options.fork - Run on a fork of a frozen base world that has data of
 * its own (tests/contract/fork-base.ts), so every request also goes through
 * the copy-on-write overlay and its tombstones
 */
export function fakePlatform(options: { fork?: boolean } = {}): FakePlatform {
  let clockOffset = 0
  // every stored document is frozen, so a handler that changes one in place fails the run
  const plain = createWorld({ now: () => Date.now() + clockOffset, freezeDocuments: true })
  if (options.fork) {
    seedBase(plain)
  }
  const world = options.fork ? plain.fork() : plain

  FetchClient.prototype.fetch = async function (this: FetchClientInternals, url: string, init?: object) {
    const options = this.adjustOptionsForFormData(this.getFetchOptions(init)) as Record<string, any>
    const fullUrl = new URL(this.getUrl(url, init), world.baseUrl)
    // @c8y/client uploads with the Node `form-data` package (a stream, not a
    // WHATWG FormData): send its serialized bytes with its multipart boundary
    const body = options.body
    if (body && typeof body.getBuffer === 'function' && typeof body.getBoundary === 'function') {
      const headers = new Headers(options.headers)
      headers.set('content-type', `multipart/form-data; boundary=${body.getBoundary()}`)
      return world.fetch(new Request(fullUrl, { ...options, headers, body: body.getBuffer() }))
    }
    return world.fetch(new Request(fullUrl, options))
  } as unknown as FetchClient['fetch']

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init)
    return new URL(request.url).origin === new URL(world.baseUrl).origin ? world.fetch(request) : originalFetch(input, init)
  }) as typeof fetch

  beforeEach(() => {
    world.reset()
  })

  afterEach(() => {
    const unhandled = world.unhandled
    world.unhandled = []
    if (unhandled.length > 0) {
      throw new Error(`requests the fake does not support:\n${unhandled.map((call) => `  ${call.method} ${call.path} (${call.reason})`).join('\n')}`)
    }
  })

  return {
    world,
    FakeWebSocket: createFakeWebSocket(world.realtime, { encodeMessage: (text) => Buffer.from(text) }),
    advanceClock: (ms) => {
      clockOffset += ms
    },
    ...(options.fork ? { base: plain } : {}),
  }
}
