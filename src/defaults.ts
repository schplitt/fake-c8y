import type { C8yUser } from './types'

/**
 * Values a world uses when its options leave them out.
 */
export const DEFAULTS = {
  tenant: 't12345',
  baseUrl: 'https://t12345.cumulocity.test',
  user: { userName: 'test-user', roles: [] } as C8yUser,
  bootstrapUser: 'servicebootstrap_test',
  settingsCategory: 'service',
} as const
