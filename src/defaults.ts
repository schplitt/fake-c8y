/**
 * Values a world uses when its options leave them out, and the passwords
 * harnesses put into credentials. By default the fake checks no passwords:
 * any value passes, these only keep wrappers from inventing their own. With
 * `passwords: 'check'`, `subscriptionPassword` is the default subscription's
 * real password; the others pass only for users without a password.
 *
 * Also exported from the light `fake-c8y/defaults` entry, which imports
 * nothing else (safe in a Vite or Vitest config). Keep this module free of
 * imports, also type imports.
 */
export const DEFAULTS = {
  tenant: 't12345',
  baseUrl: 'https://t12345.cumulocity.test',
  // typed inline, not as C8yUser: an import would pull the shared
  // declaration chunk into the light entry's types
  user: { userName: 'test-user', roles: [] } as { userName: string, roles: string[] },
  bootstrapUser: 'servicebootstrap_test',
  settingsCategory: 'service',
  /**
   * Password of the service users the world creates: the default
   * subscription (`service_<tenant>`) and services without a subscription
   * of their own.
   */
  subscriptionPassword: 'service-password',
  /**
   * Password for the bootstrap user's credentials (e.g. `C8Y_BOOTSTRAP_PASSWORD`).
   */
  bootstrapPassword: 'bootstrap-password',
  /**
   * Password for a world user's Basic auth (`basicAuth()` uses it when none is given).
   */
  userPassword: 'test-password',
} as const
