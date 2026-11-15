import type { World } from './index'

/**
 * The world requests go to, or a function that returns it on every request
 * (e.g. the current fork of a trial).
 */
export type WorldSource = Pick<World, 'fetch' | 'baseUrl'> | (() => Pick<World, 'fetch' | 'baseUrl'>)

export interface InterceptFetchOptions {
  /**
   * Origin whose requests the world answers, e.g. `'https://t1.cumulocity.test'`.
   * With it, the world (or its getter) is read only for requests to that
   * origin, so a lazy getter is not called for unrelated requests.
   * @default the origin of the world's `baseUrl`
   */
  origin?: string
}

interface Interception {
  resolve: () => Pick<World, 'fetch' | 'baseUrl'>
  origin: string | undefined
}

interface InterceptedFetch {
  /**
   * The `fetch` that was there before the first interception.
   */
  previous: typeof fetch
  /**
   * Active interceptions, oldest first.
   */
  stack: Interception[]
}

// the `fetch` functions interceptFetch() installed: the interceptions of one
// global share one installed function and its stack
const installed = new WeakMap<typeof fetch, InterceptedFetch>()

/**
 * Replaces `globalThis.fetch`: requests to the world's origin go to
 * `world.fetch()`, everything else (also relative URLs) to the `fetch` that
 * was there before. For code that calls the platform with the global `fetch`
 * instead of `@c8y/client`. Uses no Node APIs.
 *
 * Interceptions stack: the newest one whose origin matches answers. They can
 * be removed in any order; once all are, the original `fetch` is back, unless
 * something else replaced `globalThis.fetch` meanwhile (that is left alone).
 * @param world - The world, or a function returning it per request (e.g. the
 * current fork of a trial)
 * @param options - Options
 * @returns A function that removes this interception
 * @example
 * ```ts
 * const world = createWorld()
 * const restore = interceptFetch(() => world)
 * await fetch(`${world.baseUrl}/inventory/managedObjects`) // answered by the world
 * restore()
 * ```
 */
export function interceptFetch(world: WorldSource, options: InterceptFetchOptions = {}): () => void {
  const interception: Interception = {
    resolve: typeof world === 'function' ? world : () => world,
    origin: options.origin === undefined ? undefined : new URL(options.origin).origin,
  }
  let state = installed.get(globalThis.fetch)
  if (!state) {
    const own: InterceptedFetch = { previous: globalThis.fetch, stack: [] }
    const intercepted = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      let url: URL
      try {
        url = new URL(input instanceof Request ? input.url : String(input))
      } catch {
        // a relative URL: not the world's
        return own.previous.call(globalThis, input, init)
      }
      for (let i = own.stack.length - 1; i >= 0; i--) {
        const { resolve, origin } = own.stack[i]!
        if (origin !== undefined) {
          // read the world only for a match
          if (url.origin === origin) {
            return resolve().fetch(new Request(input, init))
          }
          continue
        }
        const target = resolve()
        if (url.origin === new URL(target.baseUrl).origin) {
          return target.fetch(new Request(input, init))
        }
      }
      return own.previous.call(globalThis, input, init)
    }
    installed.set(intercepted as typeof fetch, own)
    globalThis.fetch = intercepted as typeof fetch
    state = own
  }
  const stack = state.stack
  const previous = state.previous
  stack.push(interception)
  return () => {
    const index = stack.indexOf(interception)
    if (index < 0) {
      return
    }
    stack.splice(index, 1)
    if (stack.length === 0 && installed.get(globalThis.fetch)?.stack === stack) {
      installed.delete(globalThis.fetch)
      globalThis.fetch = previous
    }
  }
}
