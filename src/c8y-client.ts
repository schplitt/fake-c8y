/**
 * Routes the real `@c8y/client` to a world. Entry: `fake-c8y/c8y-client`.
 *
 * `@c8y/client` is not a dependency: the caller passes its `FetchClient`
 * class, so this entry imports nothing from it.
 */
import type { World } from './index'
import type { WorldSource } from './intercept'

export type { WorldSource } from './intercept'

/**
 * The part of `@c8y/client`'s `FetchClient` class that `installFetchClient()`
 * patches.
 */
export interface FetchClientClass {
  prototype: { fetch: unknown }
}

type RequestOptions = NonNullable<ConstructorParameters<typeof Request>[1]>

interface FetchClientInternals {
  getUrl: (url: string, init?: object) => string
  getFetchOptions: (init?: object) => RequestOptions
  adjustOptionsForFormData: (options: RequestOptions) => RequestOptions
}

/**
 * The Node `form-data` package's body: a stream, not a WHATWG `FormData`.
 */
interface NodeFormData {
  getBuffer: () => Uint8Array<ArrayBuffer>
  getBoundary: () => string
}

function isNodeFormData(body: unknown): body is NodeFormData {
  return typeof body === 'object' && body !== null
    && typeof (body as Partial<NodeFormData>).getBuffer === 'function'
    && typeof (body as Partial<NodeFormData>).getBoundary === 'function'
}

interface PatchedFetch {
  /**
   * The prototype's own `fetch` property before the first install.
   */
  own: PropertyDescriptor | undefined
  /**
   * Active installs, oldest first: the newest one answers.
   */
  stack: Array<() => Pick<World, 'fetch' | 'baseUrl'>>
}

// the `fetch` functions installFetchClient() put on a prototype: the installs
// on one prototype share one function and its stack
const installed = new WeakMap<object, PatchedFetch>()

/**
 * Patches `FetchClient.prototype.fetch` of `@c8y/client`, which every request
 * of the client goes through (services and static helpers), so the world
 * answers them instead of the network. The client's own URL, query, and auth
 * header handling stays (`getUrl`, `getFetchOptions`,
 * `adjustOptionsForFormData`); uploads made with the Node `form-data` package
 * are sent as their serialized multipart bytes.
 *
 * Installs stack: the newest one answers. They can be removed in any order;
 * once all are, the client's own `fetch` is back, unless something else
 * replaced `FetchClient.prototype.fetch` meanwhile (that is left alone).
 * @param FetchClient - The `FetchClient` class of `@c8y/client`
 * @param world - The world, or a function returning it per request
 * @returns A function that removes this install
 * @example
 * ```ts
 * import { FetchClient } from '@c8y/client'
 * import { createWorld } from 'fake-c8y'
 * import { installFetchClient } from 'fake-c8y/c8y-client'
 *
 * const world = createWorld()
 * const uninstall = installFetchClient(FetchClient, () => world)
 * ```
 */
export function installFetchClient(FetchClient: FetchClientClass, world: WorldSource): () => void {
  const prototype = FetchClient.prototype
  const resolve = typeof world === 'function' ? world : () => world
  let state = typeof prototype.fetch === 'function' ? installed.get(prototype.fetch) : undefined
  if (!state) {
    const own: PatchedFetch = { own: Object.getOwnPropertyDescriptor(prototype, 'fetch'), stack: [] }
    const patched = async function (this: FetchClientInternals, url: string, init?: object): Promise<Response> {
      const target = own.stack.at(-1)!()
      const requestOptions = this.adjustOptionsForFormData(this.getFetchOptions(init))
      const fullUrl = new URL(this.getUrl(url, init), target.baseUrl)
      const body: unknown = requestOptions.body
      if (isNodeFormData(body)) {
        const headers = new Headers(requestOptions.headers)
        headers.set('content-type', `multipart/form-data; boundary=${body.getBoundary()}`)
        return target.fetch(new Request(fullUrl, { ...requestOptions, headers, body: body.getBuffer() }))
      }
      return target.fetch(new Request(fullUrl, requestOptions))
    }
    installed.set(patched, own)
    prototype.fetch = patched
    state = own
  }
  const { stack, own } = state
  stack.push(resolve)
  return () => {
    const index = stack.indexOf(resolve)
    if (index < 0) {
      return
    }
    stack.splice(index, 1)
    if (stack.length === 0 && typeof prototype.fetch === 'function' && installed.get(prototype.fetch)?.stack === stack) {
      installed.delete(prototype.fetch)
      if (own) {
        Object.defineProperty(prototype, 'fetch', own)
      } else {
        Reflect.deleteProperty(prototype, 'fetch')
      }
    }
  }
}
