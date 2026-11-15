import type { C8yUser } from './types'

/**
 * Values a world uses when its options leave them out, and the passwords
 * harnesses put into credentials. The fake checks no passwords: any value
 * passes, these only keep wrappers from inventing their own.
 *
 * Also exported from the light `fake-c8y/defaults` entry, which imports
 * nothing else (safe in a Vite or Vitest config).
 */
export const DEFAULTS = {
  tenant: 't12345',
  baseUrl: 'https://t12345.cumulocity.test',
  user: { userName: 'test-user', roles: [] } as C8yUser,
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
