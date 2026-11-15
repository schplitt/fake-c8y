import { DEFAULTS } from './defaults'
import { encodeBase64 } from './utils'

/**
 * Credentials of a user of a world: the user name, its tenant, and a
 * password (checked only with `passwords: 'check'`). A `C8ySubscription` fits as it is.
 */
export interface C8yCredentials {
  tenant: string
  /**
   * User name, e.g. `'viewer'` or a service user like `'service_t12345'`.
   */
  user: string
  /**
   * @default DEFAULTS.userPassword
   */
  password?: string
}

/**
 * The `authorization` header value for Basic auth of a user:
 * `Basic base64(<tenant>/<user>:<password>)`, UTF-8 encoded. Works in every
 * runtime (no `btoa`, no `Buffer`).
 * @param credentials - Tenant, user name, and optional password
 * @returns The header value, `Basic` prefix included
 * @example
 * ```ts
 * const headers = { authorization: basicAuth({ tenant: world.tenant, user: 'viewer' }) }
 * ```
 */
export function basicAuth(credentials: C8yCredentials): string {
  const { tenant, user, password = DEFAULTS.userPassword } = credentials
  return `Basic ${encodeBase64(new TextEncoder().encode(`${tenant}/${user}:${password}`))}`
}
