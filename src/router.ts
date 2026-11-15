/**
 * Minimal route matcher for `c8y.override()` patterns.
 *
 * Patterns are `"[METHOD ]/path"`. Segments can be literals, `:name` (one
 * segment, captured as a param), `*` (one segment), or `**` (any rest, also
 * empty). Without a method, the pattern matches every method.
 */
export interface CompiledRoute {
  method: string | undefined
  segments: string[]
}

export function compileRoute(pattern: string): CompiledRoute {
  const trimmed = pattern.trim()
  const spaceIndex = trimmed.indexOf(' ')
  const method = spaceIndex === -1 ? undefined : trimmed.slice(0, spaceIndex).toUpperCase()
  const path = spaceIndex === -1 ? trimmed : trimmed.slice(spaceIndex + 1).trim()
  return { method, segments: splitPath(path) }
}

export function splitPath(path: string): string[] {
  return path.split('?')[0]!.split('/').filter(Boolean)
}

/**
 * Matches a request against a compiled route.
 * @param route - Compiled route
 * @param method - Request method (upper case)
 * @param segments - Request path segments (decoded)
 * @returns Captured params, or `undefined` when the route does not match
 */
export function matchRoute(route: CompiledRoute, method: string, segments: string[]): Record<string, string> | undefined {
  if (route.method && route.method !== method) {
    return undefined
  }
  const params: Record<string, string> = {}
  for (let i = 0; i < route.segments.length; i++) {
    const part = route.segments[i]!
    if (part === '**') {
      params._ = segments.slice(i).join('/')
      return params
    }
    const value = segments[i]
    if (value === undefined) {
      return undefined
    }
    if (part === '*') {
      continue
    }
    if (part.startsWith(':')) {
      params[part.slice(1)] = value
      continue
    }
    if (part !== value) {
      return undefined
    }
  }
  return segments.length === route.segments.length ? params : undefined
}

/**
 * Where the world keeps a recorded call's path segments, split before
 * decoding (`%2F` and `%3F` stay inside their segment), so recorded calls
 * match patterns exactly like `override()` matched the request. Not
 * enumerable: it does not show in the call log.
 */
export const CALL_SEGMENTS: unique symbol = Symbol('fake-c8y.segments')

/**
 * Remembers a call's path segments for `matchesCall()`.
 * @param call - A recorded call (or a copy of one)
 * @param segments - Its decoded path segments
 * @returns The call
 */
export function withSegments<T extends object>(call: T, segments: readonly string[] | undefined): T {
  if (segments) {
    Object.defineProperty(call, CALL_SEGMENTS, { value: segments, enumerable: false })
  }
  return call
}

/**
 * A copy of a recorded call with more fields (an unhandled request, a
 * platform error), keeping its path segments for `matchesCall()`.
 * @param call - The recorded call
 * @param fields - Fields to add or replace
 * @returns The copy
 */
export function copyCall<T extends object, F extends object>(call: T, fields: F): T & F {
  return withSegments({ ...call, ...fields }, (call as { [CALL_SEGMENTS]?: string[] })[CALL_SEGMENTS])
}

/**
 * Whether a recorded call matches a route pattern (the syntax of
 * `world.override()`), e.g. to count the calls to an endpoint. A call from
 * `world.calls`, `unhandled`, or `coverage()` matches exactly as the request
 * matched `override()` (also with an encoded `/` or `?` in a segment); for
 * another object the decoded `path` is split at `/`.
 * @param pattern - Route pattern (`"[METHOD ]/path"`), or a compiled one
 * @param call - A recorded call: its `method` and `path`
 * @param call.method - The call's method
 * @param call.path - The call's path (without query)
 * @returns Whether the call matches
 */
export function matchesCall(pattern: string | CompiledRoute, call: { method: string, path: string }): boolean {
  const route = typeof pattern === 'string' ? compileRoute(pattern) : pattern
  const recorded = (call as { [CALL_SEGMENTS]?: string[] })[CALL_SEGMENTS]
  return matchRoute(route, call.method.toUpperCase(), recorded ?? call.path.split('/').filter(Boolean)) !== undefined
}
