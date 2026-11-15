import type { World } from './index'

/**
 * The world requests go to, or a function that returns it on every request
 * (e.g. the current fork of a trial).
 */
export type WorldSource = Pick<World, 'fetch' | 'baseUrl'> | (() => Pick<World, 'fetch' | 'baseUrl'>)

export interface InterceptFetchOptions {
  /**
   * Origin whose requests the world answers, e.g. `'https://t1.cumulocity.test'`.
   * @default the origin of the world's `baseUrl`
   */
  origin?: string
}

/**
 * Replaces `globalThis.fetch`: requests to the world's origin go to
 * `world.fetch()`, everything else to the `fetch` that was there before. For
 * code that calls the platform with the global `fetch` instead of
 * `@c8y/client`. Uses no Node APIs.
 * @param world - The world, or a function returning it per request (e.g. the
 * current fork of a trial)
 * @param options - Options
 * @returns A function that puts the previous `fetch` back (it does nothing
 * when `globalThis.fetch` was replaced again since: restore in reverse order)
 * @example
 * ```ts
 * const world = createWorld()
 * const restore = interceptFetch(() => world)
 * await fetch(`${world.baseUrl}/inventory/managedObjects`) // answered by the world
 * restore()
 * ```
 */
export function interceptFetch(world: WorldSource, options: InterceptFetchOptions = {}): () => void {
  const resolve = typeof world === 'function' ? world : () => world
  const previous = globalThis.fetch
  const intercepted = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    let url: URL | undefined
    try {
      url = new URL(input instanceof Request ? input.url : String(input))
    } catch {
      // a relative URL: not the world's
    }
    if (url) {
      const target = resolve()
      if (url.origin === new URL(options.origin ?? target.baseUrl).origin) {
        return target.fetch(new Request(input, init))
      }
    }
    return previous.call(globalThis, input, init)
  }
  globalThis.fetch = intercepted as typeof fetch
  return () => {
    if (globalThis.fetch === intercepted) {
      globalThis.fetch = previous
    }
  }
}
