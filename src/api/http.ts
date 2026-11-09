import type { C8yRequest } from '../types'
import type { C8yEndpoint } from '../capabilities.generated'
import { C8Y_ENDPOINTS } from '../capabilities.generated'
import type { TenantData } from '../store'
import { parseIsoTime } from '../utils'
import { ERROR_INFO, ERROR_MEDIA_TYPE } from './media'

/**
 * Thrown by an API handler for a request the fake cannot answer faithfully
 * (an endpoint feature it does not emulate). The test fails with the reason.
 */
export class UnsupportedRequestError extends Error {}

/**
 * Raw parts of a request handlers sometimes need (binary bodies, repeated params).
 */
export interface RawRequest {
  bytes: Uint8Array
  contentType: string
  params: URLSearchParams
}

export const rawRequests: WeakMap<C8yRequest, RawRequest> = new WeakMap()

/**
 * The raw parts of a request.
 * @param call - The request
 */
export function raw(call: C8yRequest): RawRequest {
  return rawRequests.get(call) ?? { bytes: new Uint8Array(), contentType: '', params: new URLSearchParams(call.query) }
}

/**
 * Query parameters given more than once, with all their values in order.
 * @param call - The request
 */
export function repeatedParams(call: C8yRequest): Array<[string, string[]]> {
  const params = raw(call).params
  return [...new Set(params.keys())].map((name): [string, string[]] => [name, params.getAll(name)]).filter(([, values]) => values.length > 1)
}

/**
 * Cumulocity-style error response.
 * @param status - HTTP status
 * @param error - Error code, e.g. `inventory/Not Found`
 * @param message - Human-readable message
 */
export function apiError(status: number, error: string, message: string): Response & { message: string } {
  // `message` is kept on the object for synchronous use (e.g. seeding errors)
  // verified: the error media type (with a stray space for 401) and the same `info` link for every error
  const contentType = status === 401 ? ERROR_MEDIA_TYPE.replace(';ver', ' ;ver') : ERROR_MEDIA_TYPE
  return Object.assign(Response.json({ error, message, info: ERROR_INFO }, { status, headers: { 'content-type': contentType } }), { message })
}

/**
 * Validates query parameters against the spec: parameters the real endpoint
 * knows but the fake does not emulate fail loudly; unknown parameters are
 * ignored, like the real API does.
 * @param endpoint - Endpoint key, e.g. `GET /inventory/managedObjects`
 * @param call - The request
 * @param supported - Parameters this fake endpoint emulates
 */
export function checkQuery(endpoint: C8yEndpoint, call: C8yRequest, supported: readonly string[]): void {
  const known: readonly string[] = C8Y_ENDPOINTS[endpoint].query
  for (const [name, value] of Object.entries(call.query)) {
    if (known.includes(name) && !supported.includes(name) && value !== '' && value !== 'false') {
      throw new UnsupportedRequestError(`query parameter "${name}" of ${endpoint} is not emulated`)
    }
  }
}

/**
 * Returns a 422 response if required body fields (from the spec) are missing.
 * @param endpoint - Endpoint key
 * @param body - Request body
 */
export function checkRequired(endpoint: C8yEndpoint, body: Record<string, unknown>): Response | undefined {
  const spec = C8Y_ENDPOINTS[endpoint] as { required?: readonly string[] }
  const missing = (spec.required ?? []).filter((field) => body[field] === undefined || body[field] === null)
  if (missing.length > 0) {
    return apiError(422, 'undefined/validationError', `Following mandatory fields should be included: ${missing.join(',')}`)
  }
  return undefined
}

/**
 * Reads a boolean query parameter.
 * @param call
 * @param name
 * @param fallback
 */
export function flag(call: C8yRequest, name: string, fallback = false): boolean {
  const value = call.query[name]
  // verified: case-insensitive; a flag that defaults to true is only turned
  // off by `false` (`withChildren=no` keeps the children)
  return value === undefined ? fallback : fallback ? value.toLowerCase() !== 'false' : value.toLowerCase() === 'true'
}

const TOTALS = ['withTotalElements', 'withTotalPages']

/**
 * A 31-based string hash with its upper 16 bits folded into the lower ones.
 * @param key - The key
 */
function javaHash(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (Math.imul(31, hash) + key.charCodeAt(i)) | 0
  }
  return hash ^ (hash >>> 16)
}

/**
 * The query string of a `self`, `next`, or `prev` link. Verified: the
 * parameters (the request's parameters in order, then `pageSize`,
 * `currentPage`, and the `withTotal*` flags) come in hash table order: a
 * table sized for the request's parameter names plus two, by bucket of
 * `javaHash()`, keys in one bucket in insertion order.
 * A repeated parameter keeps all its values; values are encoded except
 * letters, digits, and `-._~` (a space is `%20`).
 * @param params - The request's parameters
 * @param pageSize - The page size
 * @param page - The linked page
 */
export function linkQuery(params: URLSearchParams, pageSize: number, page: number): string {
  const names = [...new Set(params.keys())]
  const rest = names.filter((name) => name !== 'pageSize' && name !== 'currentPage' && !TOTALS.includes(name))
  // verified on the user list: `username` goes in after the other filters
  const keys = [...rest.filter((name) => name !== 'username'), ...rest.filter((name) => name === 'username'), 'pageSize', 'currentPage', ...TOTALS.filter((name) => names.includes(name))]
  let capacity = 1
  while (capacity < names.length + 2) {
    capacity *= 2
  }
  // the table doubles once it holds more than three quarters of its capacity
  for (let size = 1; size <= keys.length; size++) {
    if (size > Math.floor(capacity * 0.75)) {
      capacity *= 2
    }
  }
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return keys
    .map((key, index) => ({ key, bucket: javaHash(key) & (capacity - 1), index }))
    .sort((a, b) => a.bucket - b.bucket || a.index - b.index)
    .flatMap(({ key }) => (key === 'pageSize' ? [String(pageSize)] : key === 'currentPage' ? [String(page)] : params.getAll(key)).map((value) => `${encode(key)}=${encode(value)}`))
    .join('&')
}

/**
 * Builds a paged collection response like Cumulocity's: `statistics`, `self`,
 * and `next`/`prev` links (`next` always, `prev` after the first page).
 * @param data - Tenant data (for the base URL of links)
 * @param call - The request (paging params)
 * @param collection - Property name, e.g. `managedObjects`
 * @param items - All matching items, in result order (or a lazy list that
 * builds only the requested slice)
 * @param items.slice
 * @param items.length
 * @param path - Collection path, e.g. `/inventory/managedObjects`
 * @param options - Paging options
 * @param options.statistics - `binaries`: always `totalPages`, never `totalElements`; `pages`: always `totalPages`, `totalElements` on request
 * @param options.errorCode - Error code of an invalid paging parameter (default `REST API/Unprocessable Entity`)
 * @param options.render - Builds the response object of an item; called only for the items on the requested page
 */
export function paged<T>(data: TenantData, call: C8yRequest, collection: string, items: { readonly length: number, slice: (start: number, end: number) => readonly T[] }, path: string, options: { statistics?: 'requested' | 'binaries' | 'pages', errorCode?: string, render?: (item: T) => unknown } = {}): Response {
  for (const name of ['pageSize', 'currentPage']) {
    const value = call.query[name]
    // verified: a 32-bit integer
    if (value !== undefined && (!/^-?\d+$/.test(value) || Math.abs(Number(value) + 0.5) > 2 ** 31)) {
      return apiError(422, options.errorCode ?? 'REST API/Unprocessable Entity', `Parameter '${name}' must have an integer value!`)
    }
  }
  // verified: 0 means 1, at most 2000
  const pageSize = Math.min(Math.max(Number.parseInt(call.query.pageSize ?? '5', 10), 1), 2000)
  const requestedPage = Number.parseInt(call.query.currentPage ?? '1', 10)
  const currentPage = Math.max(requestedPage, 1)
  const slice = items.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const page = options.render ? slice.map(options.render) : slice
  const link = (pageNumber: number) => `${data.world.baseUrl}${path}?${linkQuery(raw(call).params, pageSize, pageNumber)}`
  const totalPages = Math.ceil(items.length / pageSize)
  // verified: withTotalPages and withTotalElements count with any value but
  // `false` (in any case, also empty); the binaries list always has totalPages
  // and never totalElements
  const requested = (name: string) => call.query[name] !== undefined && call.query[name]!.toLowerCase() !== 'false'
  const withTotalPages = options.statistics === 'binaries' || options.statistics === 'pages' || requested('withTotalPages')
  // verified: the platform's key order; a negative page answers the first
  // page but echoes the number
  const statistics: Record<string, number> = {
    ...(withTotalPages ? { totalPages } : {}),
    pageSize,
    currentPage: requestedPage < 0 ? requestedPage : currentPage,
    ...(options.statistics !== 'binaries' && requested('withTotalElements') ? { totalElements: items.length } : {}),
  }
  return Response.json({
    // verified: a negative page is echoed in the self link too
    self: link(requestedPage < 0 ? requestedPage : currentPage),
    ...(currentPage > 1 ? { prev: link(currentPage - 1) } : {}),
    // verified: the next page is linked even past the end, unless the total
    // page count is known
    // verified: after a negative page comes the requested page plus one
    ...(withTotalPages && currentPage >= totalPages ? {} : { next: link((requestedPage < 0 ? requestedPage : currentPage) + 1) }),
    [collection]: page,
    statistics,
  })
}

/**
 * Parses a date query parameter the way the platform does (verified): fields
 * may have one digit (`2026-1-3T1:0:0Z`), a bare date is allowed, but a time
 * needs seconds and a zone (`2026-10-13T12:00Z` and `2026-10-13T12:00:00` are
 * invalid).
 * @param value - Query parameter value
 * @returns Epoch milliseconds, or `NaN` for an invalid date
 */
const parsedDates = new Map<string, number>()

export function parsePlatformDate(value: string): number {
  return /T[^Zz+-]*$/i.test(value.trim()) ? Number.NaN : parseDateTime(value)
}

/**
 * Like `parsePlatformDate()`, but a time without a zone is UTC (the query
 * language's `.date` literals).
 * @param value - The date
 * @returns Epoch milliseconds, or `NaN` for an invalid date
 */
export function parseDateTime(value: string): number {
  // filters parse the same bounds once per document: remember recent values
  const cached = parsedDates.get(value)
  if (cached !== undefined) {
    return cached
  }
  if (parsedDates.size >= 256) {
    parsedDates.clear()
  }
  const time = parsePlatformDateUncached(value)
  parsedDates.set(value, time)
  return time
}

function parsePlatformDateUncached(value: string): number {
  const match = /^([+-]?\d{4,9})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{1,2})(?::?(\d{2}))?)?)?$/i.exec(value.trim())
  if (!match) {
    return Number.NaN
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((field) => Number(field ?? 0))
  const fraction = match[7] ?? '0'
  const [sign, zoneHours, zoneMinutes] = [match[9], Number(match[10] ?? 0), Number(match[11] ?? 0)]
  const lastOfMonth = new Date(0)
  lastOfMonth.setUTCFullYear(year!, month!, 0)
  const zoneTooFar = zoneHours > 18 || (zoneHours === 18 && zoneMinutes > 0) || zoneMinutes > 59
  if (month! < 1 || month! > 12 || day! < 1 || day! > lastOfMonth.getUTCDate() || hour! > 23 || minute! > 59 || second! > 59 || zoneTooFar) {
    return Number.NaN
  }
  // `Date.UTC` reads years below 100 as 19xx; set the year explicitly
  const date = new Date(0)
  date.setUTCFullYear(year!, month! - 1, day!)
  date.setUTCHours(hour!, minute!, second!, Number(`0.${fraction}`) * 1000)
  const offset = sign === undefined ? 0 : (sign === '-' ? -1 : 1) * (zoneHours * 60 + zoneMinutes)
  return date.getTime() - offset * 60_000
}

/**
 * Filters documents by an inclusive-from, exclusive-to date range on a field.
 * @param value - ISO date of the document
 * @param from - Range start (inclusive), as the platform parses it
 * @param to - Range end (exclusive)
 */
export function inRange(value: unknown, from: string | undefined, to: string | undefined): boolean {
  const time = parseIsoTime(value)
  if (from !== undefined && time < parsePlatformDate(from)) {
    return false
  }
  if (to !== undefined && time >= parsePlatformDate(to)) {
    return false
  }
  return true
}

/**
 * Sorts documents by a date field.
 * @param items - Documents
 * @param field - Date field
 * @param newestFirst - Sort descending
 */
export function byTime<T extends Record<string, unknown>>(items: readonly T[], field: string, newestFirst: boolean): T[] {
  // each time is parsed once, not in every comparison; the sort is stable
  const keyed = items.map((item) => ({ item, time: parseIsoTime(item[field]) }))
  keyed.sort((a, b) => newestFirst ? b.time - a.time : a.time - b.time)
  return keyed.map(({ item }) => item)
}

/**
 * The source id of a measurement/event/alarm.
 * @param document
 */
export function sourceId(document: Record<string, unknown>): string | undefined {
  return (document.source as { id?: string } | undefined)?.id
}
