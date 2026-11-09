/**
 * Read-only tenant administration as a tenant admin sees it (verified on a
 * subtenant without tenant management rights): the tenant list and tenants
 * (`/tenant/tenants/**`), TFA settings, restricted roles, trusted
 * certificates, and login options with their access mappings. Writes are not
 * emulated (501).
 */
import type { C8yRequest } from '../types'
import type { TenantData } from '../store'
import { apiError, checkQuery, paged } from './http'

/**
 * A trusted certificate as stored in `TenantData.trustedCertificates`
 * (keyed by fingerprint).
 */
export interface StoredTrustedCertificate {
  fingerprint: string
  name: string
  status: 'ENABLED' | 'DISABLED'
  autoRegistrationEnabled: boolean
  version: number
  serialNumber?: string
  algorithmName?: string
  issuer?: string
  subject?: string
  notBefore?: string
  notAfter?: string
  certInPemFormat?: string
  tenantCertificateAuthority: boolean
  proofOfPossessionValid: boolean
  proofOfPossessionUnsignedVerificationCode?: string
  proofOfPossessionVerificationCodeUsableUntil?: string
}

/**
 * Input of a seeded trusted certificate. The fake does not parse
 * certificates: give the fields the platform derives from it (`issuer`,
 * `subject`, `notAfter`, ...) yourself.
 */
export interface C8yTrustedCertificateInput extends Partial<Omit<StoredTrustedCertificate, 'fingerprint'>> {
  /**
   * SHA-1 fingerprint, lowercase hex (the platform's key, matched case-sensitively).
   */
  fingerprint: string
}

/**
 * Stores seeded trusted certificates.
 * @param data - Tenant data
 * @param certificates - Seed input
 */
export function seedTrustedCertificates(data: TenantData, certificates: readonly C8yTrustedCertificateInput[]): void {
  for (const input of certificates) {
    if (typeof input.fingerprint !== 'string' || input.fingerprint === '') {
      throw new TypeError('seed(): a trusted certificate needs a fingerprint')
    }
    data.trustedCertificates.set(input.fingerprint, {
      version: 3,
      name: input.fingerprint,
      status: 'ENABLED',
      autoRegistrationEnabled: false,
      tenantCertificateAuthority: false,
      proofOfPossessionValid: false,
      ...input,
    })
  }
}

/**
 * A trusted certificate in the platform's key order (verified).
 * @param data - Tenant data
 * @param certificate - Stored certificate
 */
function renderCertificate(data: TenantData, certificate: Readonly<StoredTrustedCertificate>): Record<string, unknown> {
  const optional = (name: keyof StoredTrustedCertificate) => (certificate[name] === undefined ? {} : { [name]: certificate[name] })
  return {
    version: certificate.version,
    fingerprint: certificate.fingerprint,
    name: certificate.name,
    status: certificate.status,
    autoRegistrationEnabled: certificate.autoRegistrationEnabled,
    ...optional('serialNumber'),
    ...optional('algorithmName'),
    ...optional('issuer'),
    ...optional('subject'),
    ...optional('notBefore'),
    ...optional('notAfter'),
    proofOfPossessionValid: certificate.proofOfPossessionValid,
    ...optional('proofOfPossessionUnsignedVerificationCode'),
    ...optional('proofOfPossessionVerificationCodeUsableUntil'),
    ...optional('certInPemFormat'),
    tenantCertificateAuthority: certificate.tenantCertificateAuthority,
    self: `${data.world.baseUrl}/tenant/tenants/${data.tenant}/trusted-certificates/${certificate.fingerprint}`,
  }
}

const forbidden = () => apiError(403, 'security/Forbidden', 'Access Denied')

/**
 * `/tenant/tenants/**` (reads).
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function tenantsApi(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  if (call.method !== 'GET') {
    return undefined
  }
  const [, , tenantId, resource, id, extra] = segments
  if (tenantId === undefined) {
    checkQuery('GET /tenant/tenants', call, ['currentPage', 'pageSize', 'withTotalPages', 'withTotalElements', 'company', 'domain', 'parent'])
    // verified: a tenant without subtenants lists none, not even itself
    return paged(data, call, 'tenants', [], '/tenant/tenants')
  }
  if (resource === undefined) {
    checkQuery('GET /tenant/tenants/{tenantId}', call, [])
    // verified: also for the own tenant
    return forbidden()
  }
  if (resource === 'tfa' && id === undefined) {
    checkQuery('GET /tenant/tenants/{tenantId}/tfa', call, [])
    return tenantId === data.tenant
      ? Response.json({ strategy: 'SMS', enabledOnSystemLevel: false, enforcedOnSystemLevel: false, enabledOnTenantLevel: false, totpEnforcedOnTenantLevel: false, enforcedUsersGroup: '' })
      : forbidden()
  }
  if (resource === 'applications' && id === 'restricted-roles' && extra === undefined) {
    checkQuery('GET /tenant/tenants/{tenantId}/applications/restricted-roles', call, [])
    return tenantId === data.tenant ? Response.json([]) : forbidden()
  }
  if (resource === 'trusted-certificates' && extra === undefined) {
    if (id === undefined) {
      // verified: `certificateAuthority` does not filter
      checkQuery('GET /tenant/tenants/{tenantId}/trusted-certificates', call, ['currentPage', 'pageSize', 'withTotalPages', 'withTotalElements', 'certificateAuthority'])
      if (tenantId !== data.tenant) {
        return forbidden()
      }
      return paged(data, call, 'certificates', [...data.trustedCertificates.values()], `/tenant/tenants/${tenantId}/trusted-certificates`, { render: (certificate) => renderCertificate(data, certificate) })
    }
    checkQuery('GET /tenant/tenants/{tenantId}/trusted-certificates/{fingerprint}', call, [])
    if (tenantId !== data.tenant) {
      return forbidden()
    }
    const certificate = data.trustedCertificates.get(id)
    // verified: 404 without a body
    return certificate ? Response.json(renderCertificate(data, certificate)) : new Response(null, { status: 404 })
  }
  return undefined
}

/**
 * A stable UUID-like id of a tenant's login option (the platform's are random).
 * @param tenant - Tenant id
 * @param type - Login option type
 */
function loginOptionId(tenant: string, type: string): string {
  let hash = 0x811C9DC5
  const hex: string[] = []
  for (let round = 0; round < 4; round++) {
    for (const char of `${round}/${tenant}/${type}`) {
      hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0
    }
    hex.push(hash.toString(16).padStart(8, '0'))
  }
  const text = hex.join('')
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-4${text.slice(13, 16)}-a${text.slice(17, 20)}-${text.slice(20, 32)}`
}

interface LoginOptionView {
  type: 'BASIC' | 'OAUTH2_INTERNAL'
  id: string
  /**
   * As `GET /tenant/loginOptions` lists it.
   */
  listed: Record<string, unknown>
  /**
   * As `GET /tenant/loginOptions/{typeOrId}` answers it.
   */
  single: Record<string, unknown>
}

/**
 * The login options of a tenant (verified on a subtenant: basic auth, not on
 * the login page, and OAI-Secure with the password grant; the management
 * tenant has only basic auth, on the login page).
 * @param baseUrl - The tenant's base URL
 * @param tenant - Tenant id
 * @param management - The management tenant's options instead
 */
function loginOptions(baseUrl: string, tenant: string, management = false): LoginOptionView[] {
  const url = new URL(baseUrl)
  const origin = management ? `${url.protocol}//management.${url.host.split('.').slice(1).join('.')}` : url.origin
  const self = (id: string) => `${origin}/tenant/loginOptions/${id}`
  const basicId = loginOptionId(management ? 'management' : tenant, 'BASIC')
  const basic: LoginOptionView = {
    type: 'BASIC',
    id: basicId,
    listed: { id: basicId, type: 'BASIC', userManagementSource: 'INTERNAL', visibleOnLoginPage: management, tfaStrategy: 'SMS', self: self(basicId), greenMinLength: null, enforceStrength: true, _type: 'BasicAuthConfig', strengthValidity: false },
    single: { id: basicId, type: 'BASIC', visibleOnLoginPage: management, userManagementSource: 'INTERNAL', authenticationRestrictions: { forbiddenClients: ['WEB_BROWSERS'], trustedUserAgents: [], forbiddenUserAgents: [] }, self: self(basicId) },
  }
  if (management) {
    return [basic]
  }
  const oauthId = loginOptionId(tenant, 'OAUTH2_INTERNAL')
  return [basic, {
    type: 'OAUTH2_INTERNAL',
    id: oauthId,
    listed: { id: oauthId, type: 'OAUTH2_INTERNAL', initRequest: `${origin}/tenant/oauth?tenant_id=${tenant}`, grantType: 'PASSWORD', userManagementSource: 'INTERNAL', visibleOnLoginPage: true, tfaStrategy: 'SMS', self: self(oauthId), greenMinLength: null, loginRedirectDomain: url.host, enforceStrength: true, _type: 'OAuth2Config', strengthValidity: false, tfaSupported: true },
    single: { id: oauthId, type: 'OAUTH2_INTERNAL', providerName: 'Cumulocity', visibleOnLoginPage: true, userManagementSource: 'INTERNAL', grantType: 'PASSWORD', sessionConfiguration: { absoluteTimeoutMillis: 1_209_600_000, renewalTimeoutMillis: 86_400_000, maximumNumberOfParallelSessions: 5, userAgentValidationRequired: false }, self: self(oauthId) },
  }]
}

/**
 * `/tenant/loginOptions/**` (reads).
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function loginOptionsApi(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  if (call.method !== 'GET') {
    return undefined
  }
  const [, , typeOrId, mappings, mappingId, extra] = segments
  const baseUrl = data.world.baseUrl
  if (typeOrId === undefined) {
    checkQuery('GET /tenant/loginOptions', call, ['management', 'tenantId'])
    const { tenantId } = call.query
    const management = call.query.management?.toLowerCase() === 'true'
    if (tenantId !== undefined && management) {
      return apiError(400, 'LoginOptions/Bad Request', `Do not use 'management' flag while querying loginOptions of tenant with id: ${tenantId}`)
    }
    if (tenantId !== undefined && tenantId !== data.tenant) {
      // verified for an unknown tenant (the fake answers the same for other
      // tenants of the world)
      return apiError(401, 'security/Unauthorized', 'Invalid credentials!')
    }
    const options = loginOptions(baseUrl, tenantId ?? data.tenant, management)
    const origin = management ? new URL(String(options[0]!.listed.self)).origin : new URL(baseUrl).origin
    // verified: no paging, a trailing slash in `self`
    return Response.json({ self: `${origin}/tenant/loginOptions/`, loginOptions: options.map((option) => option.listed) })
  }
  if (extra !== undefined || (mappings !== undefined && mappings !== 'accessMappings' && mappings !== 'inventoryAccessMappings')) {
    return undefined
  }
  const endpoint = mappings === undefined
    ? 'GET /tenant/loginOptions/{typeOrId}'
    : mappingId === undefined
      ? `GET /tenant/loginOptions/{typeOrId}/${mappings}` as const
      : `GET /tenant/loginOptions/{typeOrId}/${mappings}/{id}` as const
  checkQuery(endpoint, call, [])
  // verified: the type in any case, or the id
  const option = loginOptions(baseUrl, data.tenant).find((candidate) => candidate.id === typeOrId || candidate.type === typeOrId.toUpperCase())
  if (!option) {
    return apiError(404, 'tenants/Not Found', `Cannot find ${typeOrId} configuration`)
  }
  if (mappings === undefined) {
    return Response.json(option.single)
  }
  if (mappingId === undefined) {
    // verified: empty for the built-in login options
    return Response.json({ self: `${new URL(baseUrl).origin}/tenant/loginOptions/${typeOrId}/${mappings}`, [mappings]: [] })
  }
  return apiError(404, 'tenants/Not Found', `Auth config with id '${option.id}' does not support dynamic access mapping`)
}
