/**
 * Small replacements for runtime APIs the fake does not rely on, so it runs
 * in any JavaScript runtime with `fetch` types (Node, workers, iso4 isolates):
 * no `structuredClone`, `atob`/`btoa`, `Buffer`, `FormData`, or `Blob`.
 */

/**
 * Deep copy of a stored document: plain objects, arrays, and `Uint8Array`.
 * @param value - Value to copy
 */
export function clone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(clone) as T
  }
  if (value instanceof Uint8Array) {
    return value.slice() as T
  }
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__') {
        // an own key from JSON.parse: assigning it would set the prototype
        Object.defineProperty(copy, key, { value: clone(item), enumerable: true, writable: true, configurable: true })
      } else {
        copy[key] = clone(item)
      }
    }
    return copy as T
  }
  return value
}

/**
 * Freezes a stored value and everything in it (typed arrays stay writable:
 * they cannot be frozen).
 * @param value - Value to freeze
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) {
      deepFreeze(item)
    }
  }
  return value
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Encodes bytes as base64.
 * @param bytes - Bytes to encode
 */
export function encodeBase64(bytes: Uint8Array): string {
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    result += BASE64[(chunk >> 18) & 63]! + BASE64[(chunk >> 12) & 63]!
    result += i + 1 < bytes.length ? BASE64[(chunk >> 6) & 63]! : '='
    result += i + 2 < bytes.length ? BASE64[chunk & 63]! : '='
  }
  return result
}

/**
 * Decodes base64 (standard or URL-safe, padding optional). Invalid characters
 * are skipped, like `Buffer.from(text, 'base64')` does.
 * @param text - Base64 text
 */
export function decodeBase64(text: string): Uint8Array {
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of text.replace(/-/g, '+').replace(/_/g, '/')) {
    const value = BASE64.indexOf(char)
    if (value === -1) {
      continue
    }
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 255)
    }
  }
  return new Uint8Array(bytes)
}

/**
 * Hex encoding of a string's UTF-8 bytes.
 * @param text - Text to encode
 */
export function toHex(text: string): string {
  return [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * One part of a `multipart/form-data` body.
 */
export interface MultipartPart {
  name: string
  /**
   * Set for file parts.
   */
  filename: string | undefined
  /**
   * The part's `Content-Type`, if any.
   */
  contentType: string | undefined
  bytes: Uint8Array
}

/**
 * Parses a `multipart/form-data` body.
 * @param bytes - Request body
 * @param contentType - Request `Content-Type` with the `boundary` parameter
 * @returns The parts, or `undefined` if the body is not valid multipart
 */
export function parseMultipart(bytes: Uint8Array, contentType: string): MultipartPart[] | undefined {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  if (!boundary) {
    return undefined
  }
  const encoder = new TextEncoder()
  const delimiter = encoder.encode(`--${boundary[1] ?? boundary[2]}`)
  const decoder = new TextDecoder()
  const parts: MultipartPart[] = []
  let start = indexOf(bytes, delimiter, 0)
  if (start === -1) {
    return undefined
  }
  while (true) {
    start += delimiter.length
    // `--` after the delimiter closes the body
    if (bytes[start] === 45 && bytes[start + 1] === 45) {
      return parts
    }
    const next = indexOf(bytes, delimiter, start)
    if (next === -1) {
      return undefined
    }
    // the part sits between the CRLF after the delimiter and the CRLF before the next one
    const part = bytes.subarray(start + 2, next - 2)
    const headerEnd = indexOf(part, encoder.encode('\r\n\r\n'), 0)
    if (headerEnd === -1) {
      return undefined
    }
    const headers = decoder.decode(part.subarray(0, headerEnd)).split('\r\n')
    const disposition = headers.find((line) => /^content-disposition:/i.test(line)) ?? ''
    const type = headers.find((line) => /^content-type:/i.test(line))
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1]
    if (name !== undefined) {
      parts.push({
        name,
        filename: /\bfilename="([^"]*)"/i.exec(disposition)?.[1],
        contentType: type?.slice(type.indexOf(':') + 1).trim(),
        bytes: part.slice(headerEnd + 4),
      })
    }
    start = next
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  for (let i = from; i <= haystack.length - needle.length; i++) {
    let j = 0
    while (j < needle.length && haystack[i + j] === needle[j]) {
      j++
    }
    if (j === needle.length) {
      return i
    }
  }
  return -1
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * The number written by the decimal digits `value[from..to)`, or -1 if one is no digit.
 * @param value - The text
 * @param from - First index
 * @param to - Index after the last
 */
function digits(value: string, from: number, to: number): number {
  let result = 0
  for (let index = from; index < to; index++) {
    const digit = value.charCodeAt(index) - 48
    if (digit < 0 || digit > 9) {
      return -1
    }
    result = result * 10 + digit
  }
  return result
}

const ISO_TIME = /^([+-]?\d{1,9})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(?:(Z)|([+-])(\d{2}):?(\d{2}))?)?)?)?$/i

/**
 * Reads an ISO 8601 time like the platform does (verified): a time without a
 * zone and a bare date are UTC, an offset counts, and the year may have a
 * sign (`+12345-01-01`, `+002026-01-01`). Never the host's time zone,
 * unlike `Date.parse()` for a time without a zone.
 * @param value - The time
 * @returns Epoch milliseconds, or `NaN` if it is no ISO time
 */
export function parseIsoTime(value: unknown): number {
  // the stored form (`2026-05-01T10:00:00.000Z`) without the regular
  // expression: sorting a big collection by time reads every time once
  if (typeof value === 'string' && value.length === 24 && value[4] === '-' && value[7] === '-' && value[10] === 'T' && value[13] === ':' && value[16] === ':' && value[19] === '.' && value[23] === 'Z') {
    const year = digits(value, 0, 4)
    const month = digits(value, 5, 7)
    const day = digits(value, 8, 10)
    const hour = digits(value, 11, 13)
    const minute = digits(value, 14, 16)
    const second = digits(value, 17, 19)
    const millis = digits(value, 20, 23)
    // `Date.UTC` reads years below 100 as 19xx: those take the general path
    if (year >= 100 && month >= 1 && month <= 12 && day >= 1 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59 && millis >= 0) {
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      return day <= (month === 2 ? (leap ? 29 : 28) : DAYS_IN_MONTH[month - 1]!) ? Date.UTC(year, month - 1, day, hour, minute, second, millis) : Number.NaN
    }
  }
  const match = typeof value === 'string' ? ISO_TIME.exec(value) : null
  if (!match) {
    return Number.NaN
  }
  // verified: a year, a month, or an hour without minutes is the start of it
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((field, index) => Number(field ?? (index === 1 || index === 2 ? 1 : 0))) as [number, number, number, number, number, number]
  const millis = Math.floor(Number(`0.${match[7] ?? '0'}`) * 1000)
  const date = new Date(0)
  // setUTCFullYear: `Date.UTC` reads years below 100 as 19xx
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millis)
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    return Number.NaN
  }
  const offset = match[9] === undefined ? 0 : (match[9] === '-' ? -1 : 1) * (Number(match[10]) * 60 + Number(match[11]))
  return date.getTime() - offset * 60_000
}

/**
 * The platform's form of a posted time (verified): UTC with milliseconds
 * (`2026-05-01T10:00:00.000Z`) for a time with `Z`, without a zone, or a bare
 * date; with an offset, the local time with milliseconds and the offset kept
 * (`2026-05-01T10:00:00.000+01:00`).
 * @param value - A time `parseIsoTime()` accepts
 */
export function normalizeIsoTime(value: string): string {
  const time = parseIsoTime(value)
  const match = ISO_TIME.exec(value)!
  if (match[9] === undefined) {
    return formatIsoTime(time)
  }
  const offset = (match[9] === '-' ? -1 : 1) * (Number(match[10]) * 60 + Number(match[11]))
  return `${formatIsoTime(time + offset * 60_000).slice(0, -1)}${match[9]}${match[10]}:${match[11]}`
}

/**
 * A time in the platform's form: like `toISOString()`, but years outside
 * 0 to 9999 as the platform prints them (verified): `12345-01-01T00:00:00.000Z` and
 * `-0001-01-01T00:00:00.000Z`, not `+012345` and `-000001`.
 * @param time - Epoch milliseconds
 */
export function formatIsoTime(time: number): string {
  const iso = new Date(time).toISOString()
  const year = new Date(time).getUTCFullYear()
  return `${year < 0 ? '-' : ''}${String(Math.abs(year)).padStart(4, '0')}${iso.slice(iso.indexOf('-', 1))}`
}

/**
 * The platform's error message for a time it cannot read.
 * @param value - The time as sent
 */
export function invalidTimeMessage(value: unknown): string {
  const text = String(value)
  // verified: the platform reads up to 9 year digits, and a leading `T` as the start of a time
  const valid = /^(?:-?\d{1,9}(?:-\d{2}(?:-\d{2}(?:T\d{2}(?::\d{2}(?::\d{2}(?:\.\d{1,9})?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?)?)?|T)/i.exec(text)?.[0] ?? ''
  return valid.length === 0 ? `Invalid format: "${text}"` : `Invalid format: "${text}" is malformed at "${text.slice(valid.length)}"`
}
