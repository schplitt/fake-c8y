/**
 * Routes the real `@c8y/client` to a world. Entry: `fake-c8y/c8y-client`.
 *
 * `@c8y/client` is not a dependency: the caller passes its `FetchClient`
 * class, so this entry imports nothing from it.
 */
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

/**
 * Patches `FetchClient.prototype.fetch` of `@c8y/client`, which every request
 * of the client goes through (services and static helpers), so the world
 * answers them instead of the network. The client's own URL, query, and auth
 * header handling stays (`getUrl`, `getFetchOptions`,
 * `adjustOptionsForFormData`); uploads made with the Node `form-data` package
 * are sent as their serialized multipart bytes.
 * @param FetchClient - The `FetchClient` class of `@c8y/client`
 * @param world - The world, or a function returning it per request
 * @returns A function that puts the client's own `fetch` back
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
  const own = Object.getOwnPropertyDescriptor(prototype, 'fetch')
  const resolve = typeof world === 'function' ? world : () => world

  prototype.fetch = async function (this: FetchClientInternals, url: string, init?: object): Promise<Response> {
    const target = resolve()
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

  return () => {
    if (own) {
      Object.defineProperty(prototype, 'fetch', own)
    } else {
      Reflect.deleteProperty(prototype, 'fetch')
    }
  }
}
