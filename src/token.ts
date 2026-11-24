/**
 * Notification 2.0 tokens: JWT-shaped and stateless, `<header>.<claims>.<checksum>`
 * in base64url. The claims carry tenant, subscription, subscriber, expiry
 * (`exp`, seconds), and `shared` (only when true). The checksum is FNV-1a
 * (32 bit) over a fixed key and the `header.claims` text. It is not a
 * security measure: anyone can mint a token, and a token works in any world.
 * There are no random parts: the same claims give the same token.
 */
import type { NotificationToken } from './realtime'
import { decodeBase64Url, encodeBase64Url } from './utils'

const HEADER = encodeBase64Url(JSON.stringify({ alg: 'FNV1a', typ: 'JWT' }))
const KEY = 'fake-c8y notification token'

/**
 * FNV-1a (32 bit) of the key and the text's UTF-8 bytes, as base64url.
 * @param text - The `header.claims` text
 */
function checksum(text: string): string {
  let hash = 0x811C9DC5
  for (const byte of new TextEncoder().encode(KEY + text)) {
    hash = Math.imul(hash ^ byte, 0x01000193)
  }
  hash >>>= 0
  return encodeBase64Url(new Uint8Array([hash >>> 24, (hash >>> 16) & 255, (hash >>> 8) & 255, hash & 255]))
}

/**
 * Builds a token from its claims.
 * @param claims - Tenant, subscription, subscriber, expiry (epoch ms, stored in whole seconds, rounded up so the token never expires before it), shared
 */
export function mintToken(claims: NotificationToken): string {
  const body = encodeBase64Url(JSON.stringify({
    tenant: claims.tenant,
    subscription: claims.subscription,
    subscriber: claims.subscriber,
    // a lifetime too large for a number (Infinity) becomes the largest safe one
    exp: Math.min(Math.ceil(claims.expires / 1000), Number.MAX_SAFE_INTEGER),
    ...(claims.shared === true ? { shared: true } : {}),
  }))
  const signed = `${HEADER}.${body}`
  return `${signed}.${checksum(signed)}`
}

/**
 * Reads a token's claims.
 * @param value - The token
 * @param now - The current time (epoch ms); without it, expiry is not checked
 * @returns The claims (`expires` in epoch ms), or `undefined` for a token that does not parse, fails its checksum, or has expired
 */
export function parseToken(value: string, now?: number): NotificationToken | undefined {
  const parts = value.split('.')
  if (parts.length !== 3) {
    return undefined
  }
  const [header, body, sum] = parts as [string, string, string]
  if (checksum(`${header}.${body}`) !== sum) {
    return undefined
  }
  let claims: unknown
  try {
    JSON.parse(decodeBase64Url(header) ?? '')
    claims = JSON.parse(decodeBase64Url(body) ?? '')
  } catch {
    return undefined
  }
  if (typeof claims !== 'object' || claims === null) {
    return undefined
  }
  const { tenant, subscription, subscriber, exp, shared } = claims as Record<string, unknown>
  if (typeof tenant !== 'string' || typeof subscription !== 'string' || typeof subscriber !== 'string' || typeof exp !== 'number' || !Number.isFinite(exp) || (shared !== undefined && typeof shared !== 'boolean')) {
    return undefined
  }
  if (now !== undefined && now >= exp * 1000) {
    return undefined
  }
  return { tenant, subscription, subscriber, expires: exp * 1000, ...(shared ? { shared } : {}) }
}
