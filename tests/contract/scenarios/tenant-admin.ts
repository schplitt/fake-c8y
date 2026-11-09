import { expect } from 'vitest'
import type { Client } from '@c8y/client'
import type { ContractScenario } from '../helpers'

async function api(client: Client, path: string) {
  const res = await client.core.fetch(path, { headers: { accept: 'application/json' } })
  const text = await res.text()
  let body: any
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  return { status: res.status, body, text }
}

const DAY_KEYS = ['day', 'deviceRequestCount', 'requestCount', 'alarmsCreatedCount', 'alarmsUpdatedCount', 'eventsCreatedCount', 'eventsUpdatedCount', 'inventoriesCreatedCount', 'inventoriesUpdatedCount', 'measurementsCreatedCount', 'operationsCreatedCount', 'operationsUpdatedCount', 'storageSize', 'deviceCount', 'deviceWithChildrenCount', 'deviceEndpointCount', 'subscribedApplications', 'resources', 'self', 'totalResourceCreateAndUpdateCount']
const SUMMED = ['deviceRequestCount', 'requestCount', 'alarmsCreatedCount', 'alarmsUpdatedCount', 'eventsCreatedCount', 'eventsUpdatedCount', 'inventoriesCreatedCount', 'inventoriesUpdatedCount', 'measurementsCreatedCount', 'operationsCreatedCount', 'operationsUpdatedCount']

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10)

function invalidDate(result: { status: number, body: any }, value: string) {
  expect(result.status).toBe(422)
  expect(result.body).toEqual({ error: `${value} is not a valid date./Invalid Data`, info: expect.any(String) })
}

function accessDenied(result: { status: number, body: any }) {
  expect(result.status).toBe(403)
  expect(result.body).toMatchObject({ error: 'security/Forbidden', message: 'Access Denied' })
}

export const tenantAdminScenarios: ContractScenario[] = [
  {
    name: 'tenant statistics: every day up to today, oldest first, ranges by day start',
    verifies: ['statistics-days', 'statistics-total', 'statistics-invalid-date'],
    async run({ client }) {
      const today = utcDay(Date.now())
      const all = await api(client, '/tenant/statistics?pageSize=2000')
      expect(all.status).toBe(200)
      const days: any[] = all.body.usageStatistics
      expect(days.length).toBeGreaterThan(0)
      // consecutive UTC days, the last one today
      expect(days.at(-1).day).toBe(`${today}T00:00:00.000Z`)
      for (let i = 1; i < days.length; i++) {
        expect(Date.parse(days[i].day) - Date.parse(days[i - 1].day)).toBe(86_400_000)
      }
      expect(Object.keys(days[0])).toEqual(DAY_KEYS)
      for (const day of days) {
        // operations are not part of the total
        expect(day.totalResourceCreateAndUpdateCount).toBe(day.alarmsCreatedCount + day.alarmsUpdatedCount + day.eventsCreatedCount + day.eventsUpdatedCount + day.inventoriesCreatedCount + day.inventoriesUpdatedCount + day.measurementsCreatedCount)
        expect(day.self).toMatch(new RegExp(`/tenant/statistics/\\w+_${day.day.slice(0, 10).replaceAll('-', '')}$`))
        expect(day.resources).toEqual({ cpu: expect.any(Number), memory: expect.any(Number), usedBy: expect.any(Array) })
      }
      expect(all.body.statistics).toEqual({ pageSize: 2000, currentPage: 1 })
      expect(all.body.next).toEqual(expect.any(String))

      const totals = await api(client, '/tenant/statistics?pageSize=1&withTotalPages=true&withTotalElements=true')
      expect(totals.body.statistics).toEqual({ totalPages: days.length, pageSize: 1, currentPage: 1, totalElements: days.length })
      expect(totals.body.usageStatistics[0].day).toBe(days[0].day)

      // a day is in the range when its start is, both ends included
      const list = async (query: string) => (await api(client, `/tenant/statistics?pageSize=2000&${query}`)).body.usageStatistics.map((day: any) => day.day.slice(0, 10))
      expect(await list(`dateFrom=${today}&dateTo=${today}`)).toEqual([today])
      expect(await list(`dateFrom=${today}T00:00:01Z`)).toEqual([])
      expect(await list(`dateFrom=${today}T01:30:00%2B02:00`)).toEqual([today])
      expect(await list(`dateTo=${today}T00:00:00Z`)).toEqual(days.map((day) => day.day.slice(0, 10)))
      expect(await list(`dateFrom=${today}&dateTo=2020-01-01`)).toEqual([])

      invalidDate(await api(client, '/tenant/statistics?dateFrom=bad'), 'bad')
      invalidDate(await api(client, '/tenant/statistics?dateTo=2026-13-01'), '2026-13-01')
      invalidDate(await api(client, '/tenant/statistics?dateFrom=2026-10-01T12:00Z'), '2026-10-01T12:00Z')
      invalidDate(await api(client, '/tenant/statistics?dateFrom=2026-10-01T12:00:00'), '2026-10-01T12:00:00')
    },
  },
  {
    name: 'tenant statistics: summary sums the days, takes the last day\'s state',
    verifies: ['statistics-summary', 'statistics-invalid-date'],
    async run({ client, tenant }) {
      const today = utcDay(Date.now())
      const yesterday = utcDay(Date.now() - 86_400_000)
      const days: any[] = (await api(client, `/tenant/statistics?pageSize=2000&dateTo=${yesterday}`)).body.usageStatistics
      const summary = await api(client, `/tenant/statistics/summary?dateTo=${yesterday}&tenant=${tenant}`)
      expect(summary.status).toBe(200)
      const keys = ['self', ...SUMMED, 'storageSize', 'deviceCount', 'deviceWithChildrenCount', 'deviceEndpointCount', 'subscribedApplications', 'storageLimitPerDevice', ...(days.length > 0 ? ['resources'] : []), 'totalResourceCreateAndUpdateCount', 'day']
      expect(Object.keys(summary.body)).toEqual(keys)
      for (const name of [...SUMMED, 'totalResourceCreateAndUpdateCount']) {
        expect([name, summary.body[name]]).toEqual([name, days.reduce((sum, day) => sum + day[name], 0)])
      }
      const last = days.at(-1)
      expect(summary.body).toMatchObject({
        self: expect.stringMatching(/\/tenant\/statistics\/summary$/),
        storageSize: last?.storageSize ?? 0,
        deviceCount: last?.deviceCount ?? 0,
        deviceEndpointCount: last?.deviceEndpointCount ?? 0,
        subscribedApplications: last?.subscribedApplications ?? [],
        storageLimitPerDevice: 0,
        // today, whatever the range
        day: `${today}T00:00:00.000Z`,
      })
      if (days.length > 0) {
        expect(summary.body.resources.cpu).toBe(days.reduce((sum, day) => sum + day.resources.cpu, 0))
      }

      const empty = await api(client, '/tenant/statistics/summary?dateFrom=2020-01-01&dateTo=2020-01-02')
      expect(empty.body).not.toHaveProperty('resources')
      expect(empty.body).toMatchObject({ requestCount: 0, storageSize: 0, deviceCount: 0, subscribedApplications: [], totalResourceCreateAndUpdateCount: 0 })

      accessDenied(await api(client, '/tenant/statistics/summary?tenant=management'))
      accessDenied(await api(client, '/tenant/statistics/summary?tenant=t999999'))
      invalidDate(await api(client, '/tenant/statistics/summary?dateTo=bad'), 'bad')

      const all = await api(client, '/tenant/statistics/allTenantsSummary')
      expect(all.status).toBe(200)
      expect(all.body).toEqual([])
      invalidDate(await api(client, '/tenant/statistics/allTenantsSummary?dateFrom=bad'), 'bad')
    },
  },
  {
    name: 'tenant statistics: device statistics are not paged and wait for the day to end',
    verifies: ['statistics-devices', 'statistics-files-403', 'statistics-invalid-date'],
    async run({ client, tenant }) {
      const today = utcDay(Date.now())
      const path = `/tenant/statistics/device/${tenant}`
      const daily = await api(client, `${path}/daily/${today}`)
      expect(daily.status).toBe(200)
      expect(daily.body).toEqual({ self: expect.stringContaining(`${path}/daily/${today}?`), next: expect.stringContaining('currentPage=2'), statistics: [] })
      expect((await api(client, `${path}/monthly/${today}`)).body.statistics).toEqual([])
      expect((await api(client, `${path}/daily/${today}?withTotalPages=true`)).body).not.toHaveProperty('next')

      // yesterday and last month, whatever the tenant did: one page, all devices
      const yesterday = utcDay(Date.now() - 86_400_000)
      const first = await api(client, `${path}/daily/${yesterday}?pageSize=1`)
      for (const item of first.body.statistics) {
        expect(item).toEqual({ deviceId: expect.any(String), count: expect.any(Number) })
      }
      expect((await api(client, `${path}/daily/${yesterday}?pageSize=2000`)).body.statistics).toEqual(first.body.statistics)
      const second = await api(client, `${path}/daily/${yesterday}?pageSize=1&currentPage=2`)
      expect(second.body).toMatchObject({ prev: expect.any(String), next: expect.any(String), statistics: [] })
      const lastMonth = new Date()
      lastMonth.setUTCDate(1)
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1)
      const monthly = await api(client, `${path}/monthly/${utcDay(lastMonth.getTime())}`)
      for (const item of monthly.body.statistics) {
        expect(Object.keys(item).filter((key) => !['deviceType', 'deviceParents'].includes(key))).toEqual(['deviceId', 'count'])
        if (item.deviceParents) {
          expect(item.deviceParents.length).toBeGreaterThan(0)
        }
      }
      if (first.body.statistics.length > 0) {
        const { deviceId } = first.body.statistics[0]
        expect((await api(client, `${path}/daily/${yesterday}?deviceId=${deviceId}`)).body.statistics).toEqual([first.body.statistics[0]])
      }

      accessDenied(await api(client, `/tenant/statistics/device/management/daily/${today}`))
      invalidDate(await api(client, `${path}/daily/bad`), 'bad')
      invalidDate(await api(client, `${path}/monthly/2026-10`), '2026-10')

      // statistics files are for the management tenant
      accessDenied(await api(client, '/tenant/statistics/files'))
      accessDenied(await api(client, '/tenant/statistics/files/1'))
      accessDenied(await api(client, '/tenant/statistics/files/latest/2026-10-01'))
      invalidDate(await api(client, '/tenant/statistics/files/latest/2026-10'), '2026-10')
      invalidDate(await api(client, '/tenant/statistics/files?dateFrom=bad'), 'bad')
    },
  },
  {
    name: 'tenants: a tenant admin sees no tenants, its TFA settings, and its trusted certificates',
    verifies: ['tenant-read-403', 'trusted-certificate-unknown-404'],
    async run({ client, tenant }) {
      const list = await api(client, '/tenant/tenants')
      expect(list.status).toBe(200)
      expect(list.body).toMatchObject({ tenants: [], statistics: { pageSize: 5, currentPage: 1 }, next: expect.any(String) })
      const counted = await api(client, '/tenant/tenants?pageSize=1&withTotalPages=true')
      expect(counted.body.statistics).toEqual({ totalPages: 0, pageSize: 1, currentPage: 1 })
      expect(counted.body).not.toHaveProperty('next')
      accessDenied(await api(client, `/tenant/tenants/${tenant}`))
      accessDenied(await api(client, '/tenant/tenants/management'))

      const tfa = await api(client, `/tenant/tenants/${tenant}/tfa`)
      expect(tfa.status).toBe(200)
      expect(Object.keys(tfa.body)).toEqual(['strategy', 'enabledOnSystemLevel', 'enforcedOnSystemLevel', 'enabledOnTenantLevel', 'totpEnforcedOnTenantLevel', 'enforcedUsersGroup'])
      accessDenied(await api(client, '/tenant/tenants/t999999/tfa'))
      expect((await api(client, `/tenant/tenants/${tenant}/applications/restricted-roles`)).body).toEqual([])
      accessDenied(await api(client, '/tenant/tenants/management/applications/restricted-roles'))

      const certificates = await api(client, `/tenant/tenants/${tenant}/trusted-certificates?pageSize=2000&certificateAuthority=true`)
      expect(certificates.status).toBe(200)
      expect(certificates.body.statistics).toEqual({ pageSize: 2000, currentPage: 1 })
      const unfiltered = await api(client, `/tenant/tenants/${tenant}/trusted-certificates?pageSize=2000&certificateAuthority=false`)
      // the parameter does not filter
      expect(unfiltered.body.certificates).toEqual(certificates.body.certificates)
      for (const certificate of certificates.body.certificates) {
        expect(certificate.self).toMatch(new RegExp(`/tenant/tenants/${tenant}/trusted-certificates/${certificate.fingerprint}$`))
        const single = await api(client, `/tenant/tenants/${tenant}/trusted-certificates/${certificate.fingerprint}`)
        expect(single.body).toEqual(certificate)
        expect((await api(client, `/tenant/tenants/${tenant}/trusted-certificates/${certificate.fingerprint.toUpperCase()}`)).status).toBe(404)
      }
      const unknown = await api(client, `/tenant/tenants/${tenant}/trusted-certificates/${'0'.repeat(40)}`)
      expect([unknown.status, unknown.text]).toEqual([404, ''])
      accessDenied(await api(client, '/tenant/tenants/t999999/trusted-certificates'))
      accessDenied(await api(client, `/tenant/tenants/t999999/trusted-certificates/${'0'.repeat(40)}`))
    },
  },
  {
    name: 'login options: basic auth and OAI-Secure, by type or id, without access mappings',
    verifies: ['login-options', 'login-option-views', 'login-options-tenant-id', 'login-option-unknown-404'],
    async run({ client, tenant }) {
      const list = await api(client, '/tenant/loginOptions')
      expect(list.status).toBe(200)
      expect(list.body.self).toMatch(/\/tenant\/loginOptions\/$/)
      const options: any[] = list.body.loginOptions
      expect(options.map((option) => [option.type, option._type])).toEqual([['BASIC', 'BasicAuthConfig'], ['OAUTH2_INTERNAL', 'OAuth2Config']])
      expect(Object.keys(options[0])).toEqual(['id', 'type', 'userManagementSource', 'visibleOnLoginPage', 'tfaStrategy', 'self', 'greenMinLength', 'enforceStrength', '_type', 'strengthValidity'])
      expect(options[1]).toMatchObject({ initRequest: expect.stringContaining(`/tenant/oauth?tenant_id=${tenant}`), grantType: 'PASSWORD', visibleOnLoginPage: true, tfaSupported: true, greenMinLength: null })
      expect((await api(client, `/tenant/loginOptions?tenantId=${tenant}`)).body).toEqual(list.body)

      const basic = await api(client, '/tenant/loginOptions/basic')
      expect(basic.body).toEqual({ id: options[0].id, type: 'BASIC', visibleOnLoginPage: options[0].visibleOnLoginPage, userManagementSource: 'INTERNAL', authenticationRestrictions: { forbiddenClients: ['WEB_BROWSERS'], trustedUserAgents: [], forbiddenUserAgents: [] }, self: options[0].self })
      const oauth = await api(client, `/tenant/loginOptions/${options[1].id}`)
      expect(oauth.body).toEqual({ id: options[1].id, type: 'OAUTH2_INTERNAL', providerName: 'Cumulocity', visibleOnLoginPage: true, userManagementSource: 'INTERNAL', grantType: 'PASSWORD', sessionConfiguration: { absoluteTimeoutMillis: 1209600000, renewalTimeoutMillis: 86400000, maximumNumberOfParallelSessions: 5, userAgentValidationRequired: false }, self: options[1].self })

      for (const kind of ['accessMappings', 'inventoryAccessMappings']) {
        const mappings = await api(client, `/tenant/loginOptions/OAUTH2_INTERNAL/${kind}`)
        expect(mappings.body).toEqual({ self: expect.stringMatching(new RegExp(`/tenant/loginOptions/OAUTH2_INTERNAL/${kind}$`)), [kind]: [] })
        const one = await api(client, `/tenant/loginOptions/BASIC/${kind}/1`)
        expect(one.status).toBe(404)
        expect(one.body).toMatchObject({ error: 'tenants/Not Found', message: `Auth config with id '${options[0].id}' does not support dynamic access mapping` })
        expect((await api(client, `/tenant/loginOptions/OAUTH2/${kind}`)).body).toMatchObject({ error: 'tenants/Not Found', message: 'Cannot find OAUTH2 configuration' })
      }
      const unknown = await api(client, '/tenant/loginOptions/NOPE')
      expect(unknown.status).toBe(404)
      expect(unknown.body).toMatchObject({ error: 'tenants/Not Found', message: 'Cannot find NOPE configuration' })

      const management = await api(client, '/tenant/loginOptions?management=true')
      expect(management.body.self).toMatch(/^https?:\/\/management\.[^/]+\/tenant\/loginOptions\/$/)
      expect(management.body.loginOptions.map((option: any) => [option.type, option.visibleOnLoginPage])).toEqual([['BASIC', true]])
      const both = await api(client, `/tenant/loginOptions?tenantId=${tenant}&management=true`)
      expect(both.status).toBe(400)
      expect(both.body).toMatchObject({ error: 'LoginOptions/Bad Request', message: `Do not use 'management' flag while querying loginOptions of tenant with id: ${tenant}` })
      const other = await api(client, '/tenant/loginOptions?tenantId=t999999')
      expect(other.status).toBe(401)
      expect(other.body).toMatchObject({ error: 'security/Unauthorized', message: 'Invalid credentials!' })
    },
  },
]
