/**
 * The user management content every fake tenant starts with: a catalogue of
 * the platform's core global roles, its default user groups, and its default
 * inventory roles.
 *
 * Read on a tenant of the eu-latest environment in November 2026. The
 * catalogue keeps the core platform roles; the roles of the default
 * microservices join it with their subscriptions (`src/application-defaults.ts`). The default groups keep their ids, names, and descriptions;
 * their roles are limited to the catalogue.
 */
import type { TenantData } from './store'

export const DEFAULT_ROLES: readonly string[] = [
  'ROLE_ALARM_ADMIN',
  'ROLE_ALARM_READ',
  'ROLE_APPLICATION_MANAGEMENT_ADMIN',
  'ROLE_APPLICATION_MANAGEMENT_READ',
  'ROLE_AUDIT_ADMIN',
  'ROLE_AUDIT_READ',
  'ROLE_BINARY_ADMIN',
  'ROLE_BINARY_CREATE',
  'ROLE_BINARY_READ',
  'ROLE_BULK_OPERATION_ADMIN',
  'ROLE_BULK_OPERATION_READ',
  'ROLE_CEP_MANAGEMENT_ADMIN',
  'ROLE_CEP_MANAGEMENT_READ',
  'ROLE_DATA_BROKER_ADMIN',
  'ROLE_DATA_BROKER_READ',
  'ROLE_DEVICE_CONTROL_ADMIN',
  'ROLE_DEVICE_CONTROL_READ',
  'ROLE_EMAIL_CREATE',
  'ROLE_EVENT_ADMIN',
  'ROLE_EVENT_READ',
  'ROLE_IDENTITY_ADMIN',
  'ROLE_IDENTITY_READ',
  'ROLE_INVENTORY_ADMIN',
  'ROLE_INVENTORY_CREATE',
  'ROLE_INVENTORY_READ',
  'ROLE_MANAGED_OBJECT_ADMIN',
  'ROLE_MANAGED_OBJECT_CREATE',
  'ROLE_MANAGED_OBJECT_READ',
  'ROLE_MEASUREMENT_ADMIN',
  'ROLE_MEASUREMENT_READ',
  'ROLE_NOTIFICATION_2_ADMIN',
  'ROLE_OPTION_MANAGEMENT_ADMIN',
  'ROLE_OPTION_MANAGEMENT_READ',
  'ROLE_RETENTION_RULE_ADMIN',
  'ROLE_RETENTION_RULE_READ',
  'ROLE_SCHEDULE_REPORT_ADMIN',
  'ROLE_SIMULATOR_ADMIN',
  'ROLE_SMART_RULE_INSTANCES_ADMIN',
  'ROLE_SMART_RULE_INSTANCES_READ',
  'ROLE_TENANT_MANAGEMENT_ADMIN',
  'ROLE_TENANT_MANAGEMENT_CREATE',
  'ROLE_TENANT_MANAGEMENT_READ',
  'ROLE_TENANT_MANAGEMENT_UPDATE',
  'ROLE_TENANT_STATISTICS_READ',
  'ROLE_USER_MANAGEMENT_ADMIN',
  'ROLE_USER_MANAGEMENT_CREATE',
  'ROLE_USER_MANAGEMENT_OWN_ADMIN',
  'ROLE_USER_MANAGEMENT_OWN_READ',
  'ROLE_USER_MANAGEMENT_PASSWORD_RESET',
  'ROLE_USER_MANAGEMENT_READ',
]

const READ = ['ROLE_ALARM_READ', 'ROLE_AUDIT_READ', 'ROLE_DEVICE_CONTROL_READ', 'ROLE_EVENT_READ', 'ROLE_IDENTITY_READ', 'ROLE_INVENTORY_READ', 'ROLE_MEASUREMENT_READ']
const DATA_ADMIN = ['ROLE_ALARM_ADMIN', 'ROLE_AUDIT_ADMIN', 'ROLE_DEVICE_CONTROL_ADMIN', 'ROLE_EVENT_ADMIN', 'ROLE_IDENTITY_ADMIN', 'ROLE_INVENTORY_ADMIN', 'ROLE_MEASUREMENT_ADMIN']

/**
 * The platform's default groups: `[id, name, description, roles]`.
 */
const DEFAULT_GROUPS: Array<[number, string, string, string[]]> = [
  [1, 'business', 'Can access all devices and their data but has no management permission in the tenant', [...DATA_ADMIN, ...READ, 'ROLE_USER_MANAGEMENT_OWN_ADMIN', 'ROLE_USER_MANAGEMENT_OWN_READ', 'ROLE_RETENTION_RULE_READ', 'ROLE_BULK_OPERATION_READ', 'ROLE_DATA_BROKER_READ', 'ROLE_SMART_RULE_INSTANCES_ADMIN', 'ROLE_SMART_RULE_INSTANCES_READ']],
  [2, 'admins', 'Enables administrative permissions. The first user created for the tenant receives this role', [...DEFAULT_ROLES]],
  [3, 'readers', 'Can read all data (including users, in contrast to "Global Reader")', [...READ, 'ROLE_TENANT_STATISTICS_READ', 'ROLE_APPLICATION_MANAGEMENT_READ', 'ROLE_USER_MANAGEMENT_READ', 'ROLE_USER_MANAGEMENT_OWN_READ', 'ROLE_CEP_MANAGEMENT_READ', 'ROLE_OPTION_MANAGEMENT_READ', 'ROLE_RETENTION_RULE_READ', 'ROLE_BULK_OPERATION_READ', 'ROLE_DATA_BROKER_READ', 'ROLE_SMART_RULE_INSTANCES_READ']],
  [4, 'devices', 'A role marker for device users. After registration, a device automatically has this role', ['ROLE_MEASUREMENT_READ', 'ROLE_EVENT_READ', 'ROLE_ALARM_READ', 'ROLE_AUDIT_READ', 'ROLE_IDENTITY_ADMIN', 'ROLE_IDENTITY_READ', 'ROLE_INVENTORY_READ', 'ROLE_INVENTORY_CREATE', 'ROLE_DEVICE_CONTROL_READ']],
  [5, 'Tenant Manager', 'Can manage tenant wide configurations like applications, tenant options and retention rules', ['ROLE_TENANT_STATISTICS_READ', 'ROLE_TENANT_MANAGEMENT_READ', 'ROLE_TENANT_MANAGEMENT_ADMIN', 'ROLE_OPTION_MANAGEMENT_READ', 'ROLE_OPTION_MANAGEMENT_ADMIN', 'ROLE_APPLICATION_MANAGEMENT_READ', 'ROLE_APPLICATION_MANAGEMENT_ADMIN', 'ROLE_RETENTION_RULE_READ', 'ROLE_RETENTION_RULE_ADMIN', 'ROLE_DATA_BROKER_READ', 'ROLE_DATA_BROKER_ADMIN']],
  [6, 'CEP Manager', 'Has full access to all deployed CEP modules and SmartRules', ['ROLE_CEP_MANAGEMENT_READ', 'ROLE_CEP_MANAGEMENT_ADMIN', 'ROLE_SCHEDULE_REPORT_ADMIN']],
  [7, 'Devicemanagement User', 'Gives access to bulk operations and device management application. This does not include access to any device data.', ['ROLE_BULK_OPERATION_READ', 'ROLE_SIMULATOR_ADMIN']],
  [8, 'Cockpit User', 'User to work in Cockpit application. This does not include the access to any device data.', []],
  [9, 'Global User Manager', 'Can access and modify the full user hierarchy', ['ROLE_USER_MANAGEMENT_READ', 'ROLE_USER_MANAGEMENT_ADMIN']],
  [10, 'Shared User Manager', 'Can create new user as his own sub-users and manage this', ['ROLE_USER_MANAGEMENT_CREATE']],
  [11, 'Global Reader', 'Can read all data from all devices', ['ROLE_ALARM_READ', 'ROLE_MEASUREMENT_READ', 'ROLE_EVENT_READ', 'ROLE_INVENTORY_READ', 'ROLE_AUDIT_READ', 'ROLE_IDENTITY_READ', 'ROLE_DEVICE_CONTROL_READ', 'ROLE_SMART_RULE_INSTANCES_READ']],
  [12, 'Global Manager', 'Can read and write all data from all devices', ['ROLE_ALARM_READ', 'ROLE_ALARM_ADMIN', 'ROLE_MEASUREMENT_READ', 'ROLE_MEASUREMENT_ADMIN', 'ROLE_EVENT_READ', 'ROLE_EVENT_ADMIN', 'ROLE_INVENTORY_READ', 'ROLE_INVENTORY_ADMIN', 'ROLE_AUDIT_READ', 'ROLE_AUDIT_ADMIN', 'ROLE_IDENTITY_READ', 'ROLE_IDENTITY_ADMIN', 'ROLE_DEVICE_CONTROL_READ', 'ROLE_DEVICE_CONTROL_ADMIN', 'ROLE_SMART_RULE_INSTANCES_ADMIN', 'ROLE_SMART_RULE_INSTANCES_READ']],
]

/**
 * The platform's default inventory roles: `[id, name, description, [permission, scope, type][]]`.
 */
const DEFAULT_INVENTORY_ROLES: Array<[number, string, string, Array<[string, string, string]>]> = [
  [1, 'Reader', 'Can read all data of the asset.', [['READ', '*', '*']]],
  [2, 'Manager', 'Can read all data of the asset and manage all inventory data, but cannot perform operations. Can also acknowledge and clear alarms. Can create and updates dashboards.', [['READ', '*', '*'], ['ADMIN', 'MANAGED_OBJECT', '*'], ['ADMIN', 'ALARM', '*']]],
  [3, 'Operations: All', 'Can remotely manage the assets by sending operations to the device. This includes for example remote configuration, software update, etc. ', [['ADMIN', 'OPERATION', '*']]],
  [4, 'Operations: Restart Device', 'Can restart devices.', [['READ', 'MANAGED_OBJECT', '*'], ['ADMIN', 'OPERATION', 'c8y_Restart'], ['READ', 'OPERATION', 'c8y_Restart']]],
]

/**
 * Adds the user management data every tenant starts with: the role
 * catalogue, the default groups, and the default inventory roles.
 * @param data - A new tenant's data
 */
export function addDefaultUserManagement(data: TenantData): void {
  for (const role of DEFAULT_ROLES) {
    data.roles.set(role, role)
  }
  for (const [id, name, description, roles] of DEFAULT_GROUPS) {
    data.groups.set(String(id), { id: String(id), name, description, customProperties: {}, roles: [...roles], devicePermissions: {} })
  }
  let permission = 1
  for (const [id, name, description, permissions] of DEFAULT_INVENTORY_ROLES) {
    data.inventoryRoles.set(String(id), {
      id: String(id),
      name,
      description,
      permissions: permissions.map(([level, scope, type]) => ({ id: permission++, permission: level, scope, type })),
    })
  }
  data.sequences.set('group', DEFAULT_GROUPS.length + 1)
  data.sequences.set('inventoryRole', DEFAULT_INVENTORY_ROLES.length + 1)
  data.sequences.set('permission', permission)
  data.sequences.set('assignment', 1)
}
