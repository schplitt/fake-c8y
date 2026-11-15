/**
 * Routes the real `@c8y/client` (`installFetchClient()`: every request goes
 * through `FetchClient.prototype.fetch`) and requests of the global `fetch`
 * to the platform's URL (`interceptFetch()`) to one world, the way a test
 * framework adapter does. Never uninstalls: Vitest isolates each test file,
 * so the patches end with the file. Resets the world before every test and
 * fails a test that sent a request the world does not emulate.
 */
import { FetchClient } from '@c8y/client'
import { afterEach, beforeEach } from 'vitest'
import { createWorld, interceptFetch } from '../../src'
import { installFetchClient } from '../../src/c8y-client'
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
  const plain = createWorld({ now: () => Date.now() + clockOffset, freezeDocuments: true, roles: 'enforce' })
  if (options.fork) {
    seedBase(plain)
  }
  const world = options.fork ? plain.fork() : plain

  installFetchClient(FetchClient, world)
  interceptFetch(world)

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
    FakeWebSocket: createFakeWebSocket(world.realtime, { flavor: 'ws' }),
    advanceClock: (ms) => {
      clockOffset += ms
    },
    ...(options.fork ? { base: plain } : {}),
  }
}
