/**
 * The applications every fake tenant starts with: the platform's standard
 * applications (owner `management`) a tenant is subscribed to.
 *
 * Read on a tenant of the eu-latest environment in November 2026 (ids,
 * names, keys, context paths, roles, and the manifest fields an agent reads).
 * Applications a tenant made itself, and optional ones of single customers,
 * are left out; `seed({ applications })` adds or replaces them.
 */
import type { StoredDocument, TenantData } from './store'
import { DEFAULT_APPLICATION_DATA } from './application-defaults.generated'

/**
 * The default applications, as stored (owner `management`).
 */
export const DEFAULT_APPLICATIONS: readonly StoredDocument[] = DEFAULT_APPLICATION_DATA

/**
 * Adds the default applications to a tenant and subscribes it to them; the
 * roles of the subscribed microservices join the role catalogue, like on the
 * platform.
 * @param data - Tenant data
 */
export function addDefaultApplications(data: TenantData): void {
  for (const application of DEFAULT_APPLICATIONS) {
    for (const role of (application.roles ?? []) as string[]) {
      if (!data.roles.has(role)) {
        data.roles.set(role, role)
      }
    }
    data.applications.set(application.id, application)
    data.applicationSubscriptions.set(application.id, application.type === 'MICROSERVICE'
      ? { id: application.id, owner: application.owner, serviceUser: `service_${application.name as string}`, password: 'service-password' }
      : { id: application.id, owner: application.owner })
  }
}
