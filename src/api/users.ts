import type { C8yRequest, C8yUser } from '../types'
import type { StoredDocument, TenantData } from '../store'
import { nextSequence } from '../store'
import type { AuditChange } from './audit'
import { apiError, checkQuery, flag, paged, raw, repeatedParams } from './http'
import { auditGlobalRoleUpdated, auditInventoryRole, auditUser, listChange, valueChange } from './audit'
import { clone } from '../utils'

/**
 * Roles a user created through the API starts with (verified).
 */
export const NEW_USER_ROLES: readonly string[] = ['ROLE_USER_MANAGEMENT_OWN_READ', 'ROLE_USER_MANAGEMENT_OWN_ADMIN']

const PROFILE_FIELDS = ['firstName', 'lastName', 'phone', 'email', 'displayName', 'enabled', 'newsletter', 'owner', 'delegatedBy']
const PERMISSION_LEVELS = ['ADMIN', 'READ', '*']
const PERMISSION_SCOPES = ['ALARM', 'AUDIT', 'EVENT', 'MANAGED_OBJECT', 'MEASUREMENT', 'OPERATION', '*']
// verified: the user API answers an invalid paging parameter with this code
const PAGING_ERROR = 'REST API/Unprocessable Entity'

/**
 * A validation failure of a user management write, as the platform answers it.
 */
export class UserApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }

  response(): Response {
    // verified: a group id that is not an integer is answered with an empty 404
    return this.code === 'groups/Not Found' && /^Error retrieving group with id (?!-?\d+!)/.test(this.message)
      ? new Response(null, { status: 404 })
      : apiError(this.status, this.code, this.message)
  }
}

function fail(status: number, code: string, message: string): never {
  throw new UserApiError(status, code, message)
}

// ---------------------------------------------------------------------------
// audit records (verified texts: the audit table in docs/platform-behavior.md)

const AUTHORITY = 'com.cumulocity.model.user.Authority'
const GROUP = 'com.cumulocity.model.user.Group'
const INVENTORY_ASSIGNMENT = 'com.cumulocity.model.user.InventoryAssignment'
const INVENTORY_PERMISSION = 'com.cumulocity.model.role.inventory.InventoryPermission'

function auditUserRole(data: TenantData, userName: string, role: string, changeType: 'ADDED' | 'REMOVED'): void {
  auditUser(data, userName, 'updated', [listChange('roles', AUTHORITY, role, changeType)])
}

function auditMembership(data: TenantData, userName: string, group: StoredDocument, changeType: 'ADDED' | 'REMOVED'): void {
  auditUser(data, userName, 'updated', [listChange('global roles', GROUP, group.name as string, changeType)])
}

/**
 * An inventory assignment in audit records: `(managedObject=<id>, roles=[<role names>])`.
 * @param data - Tenant data
 * @param managedObject - Managed object id
 * @param roles - Inventory role ids
 */
function assignmentText(data: TenantData, managedObject: unknown, roles: string[]): string {
  return `(managedObject=${managedObject}, roles=[${roles.map((id) => data.inventoryRoles.get(id)?.name ?? id).join(', ')}])`
}

function permissionText(permission: Record<string, unknown>): string {
  return `${permission.scope}:${permission.type}:${permission.permission}`
}

// ---------------------------------------------------------------------------
// rendering

/**
 * Sorts like the platform: by the id's characters (verified: group `10` comes
 * before group `2`, user `EV` before `ev`).
 * @param items - Stored documents
 */
function byId(items: Iterable<StoredDocument>): StoredDocument[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function userBase(data: TenantData, userName: string): string {
  return `${data.world.baseUrl}/user/${data.tenant}/users/${userName}`
}

/**
 * A reference list embedded in a user or a group: every reference, with the
 * statistics of a first page of five (verified).
 * @param self - Collection URL
 * @param references - All references
 * @param query
 */
function embedded(self: string, references: unknown[], query = '') {
  return {
    self: `${self}?currentPage=1&pageSize=5${query}`,
    next: `${self}?currentPage=2&pageSize=5${query}`,
    references,
    statistics: { pageSize: 5, currentPage: 1 },
  }
}

export function renderRole(data: TenantData, name: string): { self: string, id: string, name: string } {
  return { self: `${data.world.baseUrl}/user/roles/${name}`, id: name, name }
}

export function renderGroup(data: TenantData, group: StoredDocument, query = ''): Record<string, unknown> {
  const self = `${data.world.baseUrl}/user/${data.tenant}/groups/${group.id}`
  return {
    self,
    customProperties: clone(group.customProperties ?? {}),
    id: Number(group.id),
    name: group.name,
    ...(group.description !== undefined ? { description: group.description } : {}),
    // verified: always empty, with this (broken) link
    users: { self: `${data.world.baseUrl}/${group.id}/users`, references: [] },
    roles: embedded(`${self}/roles`, (group.roles as string[]).map((role) => ({ self: `${self}/roles/${role}`, role: renderRole(data, role) })), query),
    devicePermissions: clone(group.devicePermissions ?? {}),
    applications: [],
  }
}

/**
 * Renders a stored user like `GET /user/{tenantId}/users/{userId}`.
 * @param data - Tenant data
 * @param user - Stored user
 * @param options - Rendering options
 * @param options.subusersCount - Add `subusersCount`
 * @param options.query - Extra query string (`&a=b`) of the embedded group and role links: the platform repeats the list's filters there
 */
export function renderUser(data: TenantData, user: StoredDocument, options: { subusersCount?: boolean, query?: string } = {}): Record<string, unknown> {
  const base = userBase(data, user.userName as string)
  const { id: _id, userName, roles, groups, customProperties, devicePermissions, passwordStrength, shouldResetPassword, enabled, lastPasswordChange, ...fields } = user
  const rendered: Record<string, unknown> = {
    // verified: `self` encodes the user name, the nested links do not
    self: `${data.world.baseUrl}/user/${data.tenant}/users/${encodeURIComponent(userName as string)}`,
    customProperties: clone(customProperties ?? {}),
    id: userName,
    userName,
    ...clone(fields),
    passwordStrength,
    shouldResetPassword,
    enabled,
    devicePermissions: clone(devicePermissions ?? {}),
    groups: embedded(`${base}/groups`, userGroups(data, user).map((group) => ({ self: `${base}/groups/${group.id}`, group: renderGroup(data, group, options.query) })), options.query),
    roles: embedded(`${base}/roles`, (roles as string[]).map((role) => ({ self: `${base}/roles/${role}`, role: renderRole(data, role) })), options.query),
    applications: [],
  }
  if (options.subusersCount) {
    rendered.subusersCount = [...data.users.values()].filter((other) => other.owner === userName).length
  }
  rendered.provisionedCertificates = []
  rendered.lastPasswordChange = lastPasswordChange
  return rendered
}

/**
 * Groups of a user, sorted by id like the platform.
 * @param data - Tenant data
 * @param user - Stored user
 */
function userGroups(data: TenantData, user: StoredDocument): StoredDocument[] {
  return byId((user.groups as string[]).map((id) => data.groups.get(id)).filter((group) => group !== undefined))
}

/**
 * Global roles of a user: its own roles, then the roles of its groups.
 * @param data - Tenant data
 * @param user - Stored user
 */
export function effectiveRoles(data: TenantData, user: StoredDocument): string[] {
  return [...new Set([...(user.roles as string[]), ...userGroups(data, user).flatMap((group) => group.roles as string[])])]
}

/**
 * Renders a stored user like `GET /user/currentUser`.
 * @param data - Tenant data
 * @param user - Stored user
 */
export function renderCurrentUser(data: TenantData, user: StoredDocument): Record<string, unknown> {
  const { id: _id, userName, roles: _roles, groups: _groups, customProperties: _custom, devicePermissions: _permissions, passwordStrength: _strength, enabled: _enabled, owner: _owner, shouldResetPassword, lastPasswordChange, ...fields } = user
  return {
    self: `${data.world.baseUrl}/user/currentUser`,
    id: userName,
    userName,
    ...clone(fields),
    shouldResetPassword,
    // verified for a user without two-factor authentication
    requiredAuthType: 'NONE',
    effectiveRoles: effectiveRoles(data, user).map((role) => renderRole(data, role)),
    lastPasswordChange,
  }
}

export function renderInventoryRole(data: TenantData, role: StoredDocument): Record<string, unknown> {
  return {
    id: Number(role.id),
    name: role.name,
    // verified: `null` when the role has none
    description: role.description ?? null,
    permissions: clone(role.permissions as unknown[]),
    self: `${data.world.baseUrl}/user/inventoryroles/${role.id}`,
  }
}

export function renderAssignment(data: TenantData, assignment: StoredDocument): Record<string, unknown> {
  return {
    // verified: the link has no tenant id
    self: `${data.world.baseUrl}/user/${assignment.user}/roles/inventory/${assignment.id}`,
    id: Number(assignment.id),
    managedObject: assignment.managedObject,
    roles: (assignment.roles as string[]).map((id) => data.inventoryRoles.get(id)).filter((role) => role !== undefined).map((role) => renderInventoryRole(data, role)),
  }
}

// ---------------------------------------------------------------------------
// writes, shared by the API and seeding

const userNotFound = (userName: string) => new UserApiError(404, 'users/Not Found', `Error retrieving user ${userName}! : Cannot find document with ID ${userName}`)
const groupNotFound = (id: string) => new UserApiError(404, 'groups/Not Found', `Error retrieving group with id ${id}! : Cannot find document with ID ${id}`)
const inventoryRoleNotFound = (id: string) => new UserApiError(404, 'users/Not Found', `Cannot find document with ID ${id}`)
const ownerNotFound = (userName: string) => new UserApiError(404, 'users/Not Found', `User with username '${userName}' does not exist! : Cannot find document with ID ${userName}`)

function getUser(data: TenantData, userName: string): StoredDocument {
  const user = data.users.get(userName)
  if (!user) {
    throw userNotFound(userName)
  }
  return user
}

function getGroup(data: TenantData, id: string): StoredDocument {
  const group = data.groups.get(id)
  if (!group) {
    throw groupNotFound(id)
  }
  return group
}

function checkEmail(email: unknown): void {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail(422, 'undefined/validationError', 'email field must contain a valid email address')
  }
}

const PASSWORD_SYMBOLS = '`~!@#$%^&*()_|+-=?;:\\\'",.<>{}[]\\\\/'

/**
 * The platform's password rules (verified): 8 to 32 characters of letters,
 * digits, and the listed symbols, with at least one lower-case letter, one
 * upper-case letter, one digit, and one symbol (the tenant enforces strong
 * passwords). Two messages: one for length and characters, one for the mix.
 * @param password - Password from the request
 */
function checkPassword(password: unknown): void {
  const characters = typeof password === 'string' ? [...password] : []
  const allowed = (char: string) => /[A-Za-z0-9]/.test(char) || PASSWORD_SYMBOLS.includes(char)
  const prefix = 'Error during password validation. : Password must have at least 8 characters and no more than 32 and '
  if (characters.length < 8 || characters.length > 32 || !characters.every(allowed)) {
    fail(422, 'users/Invalid Data', `${prefix}must contain only Latin1 characters.`)
  }
  const text = password as string
  if (!(/[a-z]/.test(text) && /[A-Z]/.test(text) && /\d/.test(text) && /[^A-Za-z0-9]/.test(text))) {
    fail(422, 'users/Invalid Data', `${prefix}can only contain letters, numbers and following symbols: ${PASSWORD_SYMBOLS}`)
  }
}

const JACKSON_SOURCE = '\n at [Source: REDACTED (`StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION` disabled); line: 1, column: 1]'

/**
 * Field types of a user body the platform checks while parsing (verified:
 * 400 `Failed to parse JSON string`, the column in the message is not emulated).
 * @param body - Request body
 * @param type
 */
function checkUserBodyTypes(body: Record<string, unknown>, type = 'com.cumulocity.rest.representation.user.UserRepresentation'): void {
  const reject = (field: string, message: string) => fail(400, 'Failed to parse JSON string', `${message}${JACKSON_SOURCE} (through reference chain: ${type}["${field}"])`)
  for (const field of ['enabled', 'sendPasswordResetEmail', 'newsletter', 'twoFactorAuthenticationEnabled', 'shouldResetPassword']) {
    const value = body[field]
    // verified: numbers and the strings "true" and "false" are accepted
    if (value !== undefined && value !== null && typeof value !== 'boolean' && typeof value !== 'number' && value !== 'true' && value !== 'false') {
      reject(field, typeof value === 'string' && value !== '' ? `Cannot deserialize value of type \`java.lang.Boolean\` from String "${value}": only "true" or "false" recognized` : `Cannot deserialize value of type \`java.lang.Boolean\` from ${typeof value === 'number' ? 'Integer' : 'Array'} value`)
    }
  }
  for (const field of ['customProperties', 'devicePermissions']) {
    const value = body[field]
    if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      reject(field, typeof value === 'string'
        ? `Cannot construct instance of \`java.util.LinkedHashMap\` (although at least one Creator exists): no String-argument constructor/factory method to deserialize from String value ('${value}')`
        : `Cannot deserialize value of type \`java.util.LinkedHashMap<java.lang.String,java.lang.Object>\` from ${Array.isArray(value) ? 'Array' : typeof value === 'number' ? 'Integer' : 'Boolean'} value`)
    }
  }
  const permissions = body.devicePermissions
  if (permissions && typeof permissions === 'object') {
    for (const value of Object.values(permissions)) {
      if (!Array.isArray(value)) {
        reject('devicePermissions', `Cannot construct instance of \`java.util.ArrayList\` (although at least one Creator exists): no String-argument constructor/factory method to deserialize from String value ('${String(value)}')`)
      }
    }
  }
}

/**
 * Phone numbers must be international (verified: the platform validates them
 * like a phone number library does; this accepts a plus sign and 11 to 13
 * digits, spaces ignored, not starting with 0).
 * @param phone - Phone from the request
 */
function checkPhone(phone: unknown): void {
  if (phone !== undefined && phone !== null && phone !== '' && !(typeof phone === 'string' && /^\+[1-9]\d{10,12}$/.test(phone.replace(/ /g, '')))) {
    fail(422, 'undefined/validationError', 'phone is required in the international phone number format +48 123 456 789')
  }
}

function checkTwoFactor(body: Record<string, unknown>, phone: unknown): void {
  if (body.twoFactorAuthenticationEnabled === true && (phone === undefined || phone === null || phone === '')) {
    fail(422, 'users/Invalid Data', 'Error during validation : Phone number must be provided.')
  }
}

function checkUserName(userName: unknown): string {
  if (userName === undefined || userName === null) {
    fail(422, 'undefined/validationError', 'userName is required')
  }
  const name = String(userName)
  if (name === '' || [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    fail(422, 'undefined/validationError', 'userName field cannot contain control characters')
  }
  if (/[\s/\\+$:]/.test(name)) {
    fail(422, 'undefined/validationError', 'userName field cannot contain whitespace, slashes nor any of (+$:) characters.')
  }
  return name
}

function toBoolean(value: unknown): boolean {
  return typeof value === 'number' ? value !== 0 : value === true || value === 'true'
}

function checkEmailLength(email: unknown): void {
  if (typeof email === 'string' && email.length > 256) {
    fail(422, 'undefined/validationError', 'email maximum length is 256 characters')
  }
}

function emailTaken(data: TenantData, email: string, except?: string): boolean {
  return [...data.users.values()].some((user) => user.userName !== except && typeof user.email === 'string' && user.email.toLowerCase() === email.toLowerCase())
}

/**
 * Creates a user like `POST /user/{tenantId}/users`.
 * @param data - Tenant data
 * @param body - Request body
 * @param roles - Global roles of the new user (default: the platform's two `OWN` roles)
 * @param options
 * @param options.seeding
 */
export function createUser(data: TenantData, body: Record<string, unknown>, roles: readonly string[] = NEW_USER_ROLES, options: { seeding?: boolean } = {}): StoredDocument {
  const { password } = body
  if (!options.seeding) {
    checkUserBodyTypes(body)
  }
  const userName = checkUserName(body.userName)
  if (!options.seeding && body.id !== undefined) {
    fail(422, 'undefined/validationError', 'id is not allowed here')
  }
  if (body.email === undefined || body.email === null || body.email === '') {
    fail(422, 'undefined/validationError', 'email is required')
  }
  checkEmail(body.email)
  checkEmailLength(body.email)
  const resetByEmail = body.sendPasswordResetEmail !== undefined && body.sendPasswordResetEmail !== null && toBoolean(body.sendPasswordResetEmail)
  if ((password === undefined || password === null || password === '') && !resetByEmail) {
    fail(422, 'undefined/validationError', 'Password is required.')
  }
  if (!options.seeding) {
    checkPhone(body.phone)
    checkTwoFactor(body, body.phone)
    for (const field of ['owner', 'delegatedBy']) {
      // verified: an empty owner is accepted and kept
      if (typeof body[field] === 'string' && body[field] !== '' && !data.users.has(body[field] as string)) {
        fail(422, 'users/Invalid Data', `User '${body[field]}' does not exist`)
      }
    }
  }
  if (password !== undefined && password !== null && password !== '' && !options.seeding) {
    checkPassword(password)
  }
  // verified: user names are case-sensitive (`EV.USR.A` next to `ev.usr.a`)
  if (data.users.has(userName)) {
    fail(409, 'users/Duplicate', `User with username or alias '${userName}' already exists! : Duplicated: ${userName}`)
  }
  if (emailTaken(data, body.email as string)) {
    fail(409, 'users/Duplicate', `User with email '${body.email}' already exists! : Duplicated: ${body.email}`)
  }
  for (const role of roles) {
    if (!data.roles.has(role)) {
      fail(422, 'usermangement/Invalid Data', 'The Given Role does not exist.')
    }
  }
  const user: StoredDocument = {
    id: userName,
    userName,
    customProperties: { ...clone((body.customProperties ?? {}) as Record<string, unknown>), userOrigin: 'BASIC' },
  }
  for (const field of PROFILE_FIELDS) {
    if (body[field] !== undefined && body[field] !== null && field !== 'enabled') {
      user[field] = field === 'newsletter' ? toBoolean(body[field]) : typeof body[field] === 'number' ? String(body[field]) : clone(body[field])
    }
  }
  Object.assign(user, {
    passwordStrength: 'GREEN',
    // verified: a user created without a password must set one
    shouldResetPassword: resetByEmail || (body.shouldResetPassword !== undefined && body.shouldResetPassword !== null && toBoolean(body.shouldResetPassword)) || password === undefined || password === null || password === '',
    enabled: body.enabled === undefined || body.enabled === null ? true : toBoolean(body.enabled),
    devicePermissions: clone(body.devicePermissions ?? {}),
    roles: [...roles],
    groups: [],
    lastPasswordChange: data.world.now(),
  })
  data.users.set(user.id, user)
  auditUser(data, user.id, 'created')
  return user
}

/**
 * Applies `PUT /user/{tenantId}/users/{userId}` to a copy of the user.
 * @param data - Tenant data
 * @param user - A copy of the stored user, changed in place (the caller stores it)
 * @param body - Request body
 * @param caller
 */
function updateUser(data: TenantData, user: StoredDocument, body: Record<string, unknown>, caller?: string): void {
  checkUserBodyTypes(body)
  if (body.userName !== undefined) {
    fail(422, 'undefined/validationError', 'userName is not allowed here')
  }
  // verified: null values are ignored
  const given = (field: string) => body[field] !== undefined && body[field] !== null
  if (given('email')) {
    checkEmail(body.email)
    checkEmailLength(body.email)
    // verified: the same address in another case counts as another user's, also the user's own
    if (body.email !== user.email && emailTaken(data, body.email as string)) {
      fail(422, 'users/Invalid Data', 'Email field error : Cannot change email for another user.')
    }
  }
  checkPhone(body.phone)
  checkTwoFactor(body, given('phone') ? body.phone : user.phone)
  if (given('password')) {
    // verified: only the user itself sets its password
    if (caller !== user.userName) {
      fail(422, 'undefined/validationError', 'Cannot change password for another user.')
    }
    checkPassword(body.password)
    user.lastPasswordChange = data.world.now()
    user.shouldResetPassword = false
  }
  if (given('shouldResetPassword')) {
    user.shouldResetPassword = toBoolean(body.shouldResetPassword)
  }
  // verified: these fields are audited, with lower-case names, in this order
  const audited: Array<[string, string]> = [['enabled', 'enabled'], ['lastName', 'lastname'], ['firstName', 'firstname']]
  const changes: AuditChange[] = audited
    .filter(([field]) => given(field) && body[field] !== user[field])
    .map(([field, attribute]) => valueChange(attribute, user[field], body[field]))
  for (const field of PROFILE_FIELDS) {
    // verified: an update keeps the owner
    if (given(field) && field !== 'owner') {
      user[field] = field === 'enabled' || field === 'newsletter' ? toBoolean(body[field]) : typeof body[field] === 'number' ? String(body[field]) : clone(body[field])
    }
  }
  auditUser(data, user.userName as string, 'updated', changes)
  if (given('devicePermissions')) {
    user.devicePermissions = clone(body.devicePermissions)
  }
  if (given('customProperties')) {
    // verified: merged into the existing properties, a null value removes one, userOrigin stays
    const merged: Record<string, unknown> = { ...(user.customProperties as object), ...clone(body.customProperties as object) }
    for (const [key, value] of Object.entries(merged)) {
      if (value === null) {
        delete merged[key]
      }
    }
    merged.userOrigin = (user.customProperties as Record<string, unknown>).userOrigin ?? 'BASIC'
    user.customProperties = merged
  }
}

/**
 * Deletes a user with its inventory assignments (its group memberships live on the user).
 * @param data - Tenant data
 * @param userName - User name
 */
export function deleteUser(data: TenantData, userName: string): boolean {
  if (!data.users.delete(userName)) {
    return false
  }
  auditUser(data, userName, 'deleted')
  // verified: the user's subusers lose their owner, their groups, and their
  // roles but the ones every new user has; their own subusers lose the same
  for (const user of [...data.users.values()]) {
    if (user.owner === userName) {
      const { owner: _owner, ...rest } = user
      const lostRoles = (user.roles as string[]).filter((role) => !NEW_USER_ROLES.includes(role))
      data.users.set(user.id, { ...rest, roles: (user.roles as string[]).filter((role) => NEW_USER_ROLES.includes(role)), groups: [] })
      cascadeToSubusers(data, user.id, lostRoles, user.groups as string[])
    }
  }
  for (const [id, assignment] of data.inventoryAssignments) {
    if (assignment.user === userName) {
      data.inventoryAssignments.delete(id)
    }
  }
  return true
}

/**
 * Takes roles and groups an owner lost from its subusers, and from theirs (verified).
 * @param data - Tenant data
 * @param owner - The owner's user name
 * @param roles - Global roles the owner lost
 * @param groups - Group ids the owner left
 */
function cascadeToSubusers(data: TenantData, owner: string, roles: string[], groups: string[]): void {
  if (roles.length === 0 && groups.length === 0) {
    return
  }
  for (const user of [...data.users.values()]) {
    if (user.owner !== owner) {
      continue
    }
    const lostRoles = (user.roles as string[]).filter((role) => roles.includes(role))
    const lostGroups = (user.groups as string[]).filter((group) => groups.includes(group))
    if (lostRoles.length > 0 || lostGroups.length > 0) {
      data.users.set(user.id, { ...user, roles: (user.roles as string[]).filter((role) => !lostRoles.includes(role)), groups: (user.groups as string[]).filter((group) => !lostGroups.includes(group)) })
      cascadeToSubusers(data, user.id, lostRoles, lostGroups)
    }
  }
}

/**
 * The owner of a subuser, if it has one. A subuser gets only the groups its
 * owner is a member of and the roles the owner has (also through its
 * groups); anything else answers 403 (verified).
 * @param data - Tenant data
 * @param user - The user
 */
function storedOwner(data: TenantData, user: StoredDocument): StoredDocument | undefined {
  return typeof user.owner === 'string' && user.owner !== '' ? data.users.get(user.owner) : undefined
}

const accessDenied = () => new UserApiError(403, 'security/Forbidden', 'Access Denied')

/**
 * Creates a group like `POST /user/{tenantId}/groups`.
 * @param data - Tenant data
 * @param body - Request body
 */
export function createGroup(data: TenantData, body: Record<string, unknown>): StoredDocument {
  checkUserBodyTypes(body, 'com.cumulocity.rest.representation.user.GroupRepresentation')
  if (body.name === undefined || body.name === null || body.name === '') {
    fail(422, 'usermangement/Invalid Data', 'A Groupname has to be provided when posting to group collection')
  }
  const name = String(body.name)
  checkGroupName(data, name, undefined)
  const roles = (body.roles ?? []) as string[]
  for (const role of roles) {
    if (!data.roles.has(role)) {
      fail(422, 'usermangement/Invalid Data', 'The Given Role does not exist.')
    }
  }
  const id = String(nextSequence(data, 'group'))
  const group: StoredDocument = {
    id,
    name,
    ...(body.description !== undefined && body.description !== null ? { description: String(body.description) } : {}),
    customProperties: clone((body.customProperties ?? {}) as object),
    roles: [...new Set(roles)],
    devicePermissions: clone((body.devicePermissions ?? {}) as object),
  }
  data.groups.set(id, group)
  return group
}

function checkGroupName(data: TenantData, name: string, except: string | undefined): void {
  if (name.length > 254) {
    fail(422, 'undefined/validationError', 'name maximum length is 254 characters')
  }
  // verified: group names are case-sensitive
  if ([...data.groups.values()].some((group) => group.name === name && group.id !== except)) {
    fail(409, 'groups/Duplicate', `Group '${name}' already exists! : Duplicated: ${name}`)
  }
}

/**
 * Deletes a group; its users stay and lose the membership, each with a
 * `User updated` audit record (verified).
 * @param data - Tenant data
 * @param id - Group id
 */
export function deleteGroup(data: TenantData, id: string): boolean {
  const group = data.groups.get(id)
  if (!group) {
    return false
  }
  data.groups.delete(id)
  for (const user of [...data.users.values()]) {
    if ((user.groups as string[]).includes(id)) {
      data.users.set(user.id, { ...user, groups: (user.groups as string[]).filter((member) => member !== id) })
      auditMembership(data, user.userName as string, group, 'REMOVED')
    }
  }
  return true
}

/**
 * Adds a user to a group like `POST /user/{tenantId}/groups/{groupId}/users`.
 * @param data - Tenant data
 * @param group - Group
 * @param userName - User name
 */
export function addGroupMember(data: TenantData, group: StoredDocument, userName: string): StoredDocument {
  const prefix = `Error retrieving data for group with id ${group.id} and user with username ${userName}! : `
  const user = data.users.get(userName) ?? fail(422, 'groups/Invalid Data', `${prefix}Cannot find document with ID ${userName}`)
  if ((user.groups as string[]).includes(group.id)) {
    fail(409, 'groups/Duplicate', `${prefix}Group ${group.id} already has user ${userName} as member!`)
  }
  const updated = { ...user, groups: [...user.groups as string[], group.id] }
  data.users.set(userName, updated)
  auditMembership(data, userName, group, 'ADDED')
  return updated
}

const INVENTORY_ROLE_TYPE = 'com.cumulocity.rest.representation.role.inventory.InventoryRoleRepresentation'

function checkPermissions(permissions: unknown): Array<Record<string, unknown>> {
  if (permissions === undefined || permissions === null) {
    return []
  }
  if (!Array.isArray(permissions)) {
    // verified: answered while parsing the body
    return fail(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`java.util.ArrayList<com.cumulocity.rest.representation.role.inventory.InventoryPermissionRepresentation>\` from ${jsonTokenName(permissions)}${JACKSON_SOURCE} (through reference chain: ${INVENTORY_ROLE_TYPE}["permissions"])`)
  }
  return permissions.map((permission: Record<string, unknown>) => {
    // verified: checked in this order, one at a time, before the values
    for (const field of ['type', 'permission', 'scope']) {
      if (permission?.[field] === undefined || permission[field] === null) {
        fail(422, 'undefined/validationError', `${field} is required`)
      }
    }
    if (!PERMISSION_LEVELS.includes(permission.permission as string)) {
      fail(422, 'undefined/validationError', 'permission invalid value')
    }
    if (!PERMISSION_SCOPES.includes(permission.scope as string)) {
      fail(422, 'undefined/validationError', 'scope invalid value')
    }
    return permission
  })
}

/**
 * Stored permissions for a create or update. A permission the role already
 * has (same permission, scope, and type) keeps its id (verified); the
 * platform lists the permissions of an update in no stable order, the fake
 * by id.
 * @param data - Tenant data
 * @param permissions - Requested permissions
 * @param existing - The role's current permissions
 */
function storePermissions(data: TenantData, permissions: Array<Record<string, unknown>>, existing: Array<Record<string, unknown>> = []) {
  const key = (permission: Record<string, unknown>) => `${String(permission.permission)}\u0000${String(permission.scope)}\u0000${String(permission.type)}`
  const kept = new Map(existing.map((permission) => [key(permission), permission]))
  const stored = permissions.map((permission) => {
    const old = kept.get(key(permission))
    if (old) {
      kept.delete(key(permission))
      return old
    }
    return { id: nextSequence(data, 'permission'), type: String(permission.type), scope: permission.scope, permission: permission.permission }
  })
  return existing.length > 0 ? stored.sort((a, b) => Number(a.id) - Number(b.id)) : stored
}

/**
 * The name of a JSON value's token as the platform's parse error names it.
 * @param value - The value
 */
function jsonTokenName(value: unknown): string {
  if (typeof value === 'string') {
    return 'String value (token `JsonToken.VALUE_STRING`)'
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'Integer value (token `JsonToken.VALUE_NUMBER_INT`)' : 'Floating-point value (token `JsonToken.VALUE_NUMBER_FLOAT`)'
  }
  if (typeof value === 'boolean') {
    return `Boolean value (token \`JsonToken.VALUE_${value ? 'TRUE' : 'FALSE'}\`)`
  }
  return 'Object value (token `JsonToken.START_OBJECT`)'
}

function checkInventoryRoleBody(body: Record<string, unknown>, creating: boolean): void {
  if (creating && body.id !== undefined && body.id !== null) {
    // verified (an update ignores the id)
    fail(422, 'undefined/validationError', 'id is not allowed here')
  }
  if (creating && (body.name === undefined || body.name === null)) {
    // verified: an empty name is accepted
    fail(422, 'undefined/validationError', 'name is required')
  }
  if (typeof body.name === 'string' && body.name.length > 50) {
    fail(422, 'undefined/validationError', 'name size must be between 0 and 50')
  }
}

/**
 * Scalars of an inventory role become strings, like the platform's JSON mapping does.
 * @param value - Field value
 */
function inventoryRoleText(value: unknown): unknown {
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
}

function checkInventoryRoleName(data: TenantData, name: string): void {
  if ([...data.inventoryRoles.values()].some((role) => role.name === name)) {
    fail(409, 'users/Duplicate', `InventoryRole with name ${name} already exists!`)
  }
}

/**
 * Creates an inventory role like `POST /user/inventoryroles`.
 * @param data - Tenant data
 * @param body - Request body
 */
export function createInventoryRole(data: TenantData, body: Record<string, unknown>): StoredDocument {
  checkInventoryRoleBody(body, true)
  const permissions = checkPermissions(body.permissions)
  const name = inventoryRoleText(body.name) as string
  checkInventoryRoleName(data, name)
  const id = String(nextSequence(data, 'inventoryRole'))
  const role: StoredDocument = {
    id,
    name,
    ...(body.description !== undefined && body.description !== null ? { description: inventoryRoleText(body.description) } : {}),
    permissions: storePermissions(data, permissions),
  }
  data.inventoryRoles.set(id, role)
  auditInventoryRole(data, { id, name: role.name as string }, 'created')
  return role
}

/**
 * Inventory role ids from a request's `roles` (`[{ id }]`), checked to exist.
 * @param data - Tenant data
 * @param userName - User name (for the error)
 * @param roles - Requested roles
 */
function assignmentRoles(data: TenantData, userName: string, roles: unknown): string[] {
  if (roles !== undefined && roles !== null && !Array.isArray(roles)) {
    // verified
    fail(400, 'Failed to parse JSON string', `Cannot deserialize value of type \`java.util.ArrayList<${INVENTORY_ROLE_TYPE}>\` from ${jsonTokenName(roles)}${JACKSON_SOURCE} (through reference chain: com.cumulocity.rest.representation.user.InventoryAssignmentRepresentation["roles"])`)
  }
  const ids = (Array.isArray(roles) ? roles : []).map((role: { id?: unknown }) => role?.id === undefined || role.id === null ? undefined : String(role.id))
  for (const id of ids) {
    if (id === undefined || !data.inventoryRoles.has(id)) {
      // verified: a role without an id (also one with only a `self` link) reads 'null'
      fail(404, 'users/Not Found', `Error adding user inventory assignments ${userName}! : Inventory role 'null' with id '${id === undefined ? 'null' : `ID [type=com_cumulocity_model_idtype_GId, value=${id}]`}' does not exist!`)
    }
  }
  return [...new Set(ids as string[])]
}

/**
 * Assigns inventory roles on a managed object like `POST /user/{tenantId}/users/{userId}/roles/inventory`.
 * @param data - Tenant data
 * @param userName - User name
 * @param body - `{ managedObject, roles: [{ id }] }`
 */
export function createAssignment(data: TenantData, userName: string, body: Record<string, unknown>): StoredDocument {
  if (!data.users.has(userName)) {
    throw ownerNotFound(userName)
  }
  if (body.managedObject === undefined || body.managedObject === null || body.managedObject === '') {
    fail(422, 'undefined/validationError', 'managedObject is required')
  }
  const managedObject = String(body.managedObject)
  const roles = assignmentRoles(data, userName, body.roles)
  if (!data.managedObjects.has(managedObject)) {
    fail(404, 'users/Not Found', `Managed object with id '${managedObject}' does not exist! : Cannot find document with ID ${managedObject}`)
  }
  // verified: one assignment per user and managed object
  if ([...data.inventoryAssignments.values()].some((assignment) => assignment.user === userName && assignment.managedObject === managedObject)) {
    fail(409, 'users/Duplicate', `Error adding user inventory assignments ${userName}! : Inventory role is already assigned to the '${managedObject}' managed object!`)
  }
  const assignment: StoredDocument = { id: String(nextSequence(data, 'assignment')), user: userName, managedObject, roles }
  data.inventoryAssignments.set(assignment.id, assignment)
  auditUser(data, userName, 'updated', [listChange('inventoryAssignment', INVENTORY_ASSIGNMENT, assignmentText(data, managedObject, roles), 'ADDED')])
  return assignment
}

// ---------------------------------------------------------------------------
// request handling

/**
 * The last path segment of a reference's `self` link after `marker`.
 * @param self - Link
 * @param marker - Path segment before the id, e.g. `users`
 */
function idFromSelf(self: unknown, marker: string): string | undefined {
  if (typeof self !== 'string') {
    return undefined
  }
  const match = new RegExp(`/${marker}/([^/?#]+)/?(?:[?#].*)?$`).exec(self)
  return match ? decodeURIComponent(match[1]!) : undefined
}

/**
 * The role a role reference body names. A reference without a `self` link
 * fails with 500 on the platform (verified for groups).
 * @param data - Tenant data
 * @param body - `{ role: { self } }`
 */
function referencedRole(data: TenantData, body: Record<string, any>): string {
  if (body?.role === undefined || body.role === null) {
    fail(422, 'undefined/validationError', 'role is required')
  }
  if (typeof body.role !== 'object' || Array.isArray(body.role)) {
    fail(400, 'Failed to parse JSON string', `Cannot construct instance of \`com.cumulocity.rest.representation.user.RoleRepresentation\` (although at least one Creator exists): no String-argument constructor/factory method to deserialize from String value ('${String(body.role)}')${JACKSON_SOURCE} (through reference chain: com.cumulocity.rest.representation.user.RoleReferenceRepresentation["role"])`)
  }
  const self = body.role.self
  if (self === undefined || self === null) {
    fail(500, 'general/internalError', 'Cannot invoke "java.lang.CharSequence.length()" because "this.text" is null')
  }
  // verified: the name is everything after `/user/roles/` (a query or trailing slash belongs to it)
  const match = /\/user\/roles\/(.+)$/.exec(String(self))
  if (!match) {
    fail(422, 'usermangement/Invalid Data', `Could not Identify the role referenced by: ${String(self)}`)
  }
  const name = decodeURIComponent(match![1]!)
  if (!data.roles.has(name)) {
    fail(422, 'usermangement/Invalid Data', 'The Given Role does not exist.')
  }
  return name
}

function checkPaging(call: C8yRequest): void {
  for (const name of ['pageSize', 'currentPage']) {
    const value = call.query[name]
    if (value !== undefined && !/^-?\d+$/.test(value)) {
      fail(422, PAGING_ERROR, `Parameter '${name}' must have an integer value!`)
    }
  }
}

/**
 * The query string the platform repeats in the embedded links of a user or
 * group (verified): every parameter but the paging ones, encoded.
 * @param call - The request
 */
function linkQuery(call: C8yRequest): string {
  const repeated = new Map(repeatedParams(call))
  return Object.entries(call.query)
    .filter(([name]) => name !== 'pageSize' && name !== 'currentPage')
    .flatMap(([name, value]) => (repeated.get(name) ?? [value]).map((one) => `&${name}=${encodeURIComponent(one).replace(/\*/g, '%2A')}`))
    .join('')
}

const body = (call: C8yRequest) => ((call.body && typeof call.body === 'object') ? call.body : {}) as Record<string, any>
const created = (value: unknown) => Response.json(value, { status: 201 })
const noContent = () => new Response(null, { status: 204 })

const USER_LIST_PARAMS = ['currentPage', 'groups', 'onlyDevices', 'owner', 'pageSize', 'username', 'usernameContains', 'withApps', 'withGroups', 'withSubusersCount', 'withTotalElements', 'withTotalPages']

/**
 * User API: users, groups, global roles, inventory roles, inventory
 * assignments, and device permissions. `GET /user/currentUser` is a built-in
 * route of the world.
 * @param call - The request
 * @param segments - Path segments
 * @param data - Tenant data
 */
export function users(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  try {
    return userRequest(call, segments, data)
  } catch (error) {
    if (error instanceof UserApiError) {
      return error.response()
    }
    throw error
  }
}

function userRequest(call: C8yRequest, segments: string[], data: TenantData): Response | undefined {
  const [, first, resource, id, sub, subId, subSubId] = segments
  const { method } = call
  const length = segments.length

  if (first === 'roles') {
    if (method === 'GET' && length === 2) {
      checkQuery('GET /user/roles', call, ['currentPage', 'pageSize', 'withTotalElements', 'withTotalPages'])
      checkPaging(call)
      // verified: sorted by name, total pages always
      return paged(data, call, 'roles', [...data.roles.keys()].sort(), '/user/roles', { statistics: 'pages', render: (role) => renderRole(data, role) })
    }
    if (method === 'GET' && length === 3) {
      checkQuery('GET /user/roles/{name}', call, [])
      return data.roles.has(resource!)
        ? Response.json(renderRole(data, resource!))
        : apiError(404, 'authorities/Not Found', `Cannot find document with ID ${resource}`)
    }
    return undefined
  }

  if (first === 'inventoryroles') {
    return inventoryRoles(call, data, resource, length)
  }

  if (first === 'devicePermissions' && length === 3 && method === 'GET') {
    checkQuery('GET /user/devicePermissions/{id}', call, [])
    // verified for objects without permissions (also unknown ids): both lists empty
    const holders = (items: Iterable<StoredDocument>, key: string) => [...items]
      .filter((item) => (item.devicePermissions as Record<string, unknown> | undefined)?.[resource!] !== undefined)
      .map((item) => ({ id: key === 'userName' ? item.userName : Number(item.id), [key]: item[key], devicePermissions: { [resource!]: clone((item.devicePermissions as Record<string, unknown>)[resource!]) } }))
    return Response.json({ users: holders(data.users.values(), 'userName'), groups: holders(data.groups.values(), 'name') })
  }

  if (first === undefined || !['users', 'userByName', 'groups', 'groupByName'].includes(resource ?? '')) {
    return undefined
  }
  const route = tenantRoute(method, resource!, length, sub, subId)
  if (!route) {
    return undefined
  }
  if (first !== data.tenant) {
    // verified
    return apiError(403, 'userManagement/Forbidden', 'authenticated user\'s tenant different from the one in URL path')
  }
  return route(call, data, { id: id!, sub, subId, subSubId })
}

interface Params { id: string, sub: string | undefined, subId: string | undefined, subSubId: string | undefined }
type Handler = (call: C8yRequest, data: TenantData, params: Params) => Response

/**
 * Handlers of `/user/{tenantId}/...` requests by `METHOD resource segments[ sub[ inventory]]`.
 */
const TENANT_ROUTES: Record<string, Handler | undefined> = {
  'GET users 3': listUsers,
  'POST users 3': (call, data) => created(renderUser(data, createUser(data, body(call)))),
  'GET users 4': (call, data, { id }) => {
    checkQuery('GET /user/{tenantId}/users/{userId}', call, [])
    return Response.json(renderUser(data, getUser(data, id), { query: linkQuery(call) }))
  },
  'GET userByName 4': (call, data, { id }) => {
    checkQuery('GET /user/{tenantId}/userByName/{username}', call, [])
    return Response.json(renderUser(data, getUser(data, id), { query: linkQuery(call) }))
  },
  'PUT users 4': (call, data, { id }) => {
    const user = clone(getUser(data, id))
    updateUser(data, user, body(call), call.user)
    data.users.set(id, user)
    return Response.json(renderUser(data, user, { query: linkQuery(call) }))
  },
  'DELETE users 4': (_call, data, { id }) => deleteUser(data, id) ? noContent() : userNotFound(id).response(),
  'GET users 5 groups': (call, data, { id }) => {
    checkQuery('GET /user/{tenantId}/users/{userId}/groups', call, ['currentPage', 'pageSize', 'withTotalElements', 'withTotalPages'])
    checkPaging(call)
    const user = data.users.get(id)
    if (!user) {
      throw ownerNotFound(id)
    }
    const base = userBase(data, id)
    return paged(data, call, 'references', userGroups(data, user), `/user/${data.tenant}/users/${id}/groups`, {
      statistics: 'pages',
      render: (group) => ({ self: `${base}/groups/${group.id}`, group: renderGroup(data, group, linkQuery(call)) }),
    })
  },
  'POST users 5 roles': (call, data, { id }) => {
    const user = getUser(data, id)
    const role = referencedRole(data, body(call))
    const owner = storedOwner(data, user)
    if (owner && !effectiveRoles(data, owner).includes(role)) {
      throw accessDenied()
    }
    // verified: assigning a role the user has is accepted
    if (!(user.roles as string[]).includes(role)) {
      data.users.set(id, { ...user, roles: [...user.roles as string[], role] })
      auditUserRole(data, id, role, 'ADDED')
    }
    // verified: this link has no `/user/{tenantId}` prefix
    return created({ self: `${data.world.baseUrl}/users/${id}/roles/${role}`, role: renderRole(data, role) })
  },
  'DELETE users 6 roles': (_call, data, { id, subId }) => {
    const prefix = `Error retrieving data for user id ${id} and authority with authorityName ${subId}! : `
    const user = data.users.get(id) ?? fail(404, 'users/Not Found', `${prefix}Cannot find document with ID ${id}`)
    if (!data.roles.has(subId!)) {
      fail(404, 'users/Not Found', `${prefix}Cannot find document with ID ${subId}`)
    }
    const roles = user.roles as string[]
    if (!roles.includes(subId!)) {
      fail(404, 'users/Not Found', `User ${id} does not contain authority with authorityName ${subId} !`)
    }
    data.users.set(id, { ...user, roles: roles.filter((role) => role !== subId) })
    auditUserRole(data, id, subId!, 'REMOVED')
    // verified: only a role removed from the owner itself is taken from its subusers, not one removed from its group
    cascadeToSubusers(data, id, [subId!], [])
    return noContent()
  },
  'GET users 6 roles inventory': (call, data, { id }) => {
    checkQuery('GET /user/{tenantId}/users/{userId}/roles/inventory', call, [])
    if (!data.users.has(id)) {
      throw ownerNotFound(id)
    }
    const assignments = byId([...data.inventoryAssignments.values()].filter((assignment) => assignment.user === id))
    // verified: no paging, and no tenant id in the link
    return Response.json({ self: `${data.world.baseUrl}/user/${id}/roles/inventory`, inventoryAssignments: assignments.map((assignment) => renderAssignment(data, assignment)) })
  },
  'POST users 6 roles inventory': (call, data, { id }) => Response.json(renderAssignment(data, createAssignment(data, id, body(call)))),
  'GET users 7 roles inventory': (_call, data, { id, subSubId }) => Response.json(renderAssignment(data, getAssignment(data, id, subSubId!))),
  'PUT users 7 roles inventory': (call, data, { id, subSubId }) => {
    const assignment = getAssignment(data, id, subSubId!)
    const roles = assignmentRoles(data, id, body(call).roles)
    const before = assignmentText(data, assignment.managedObject, assignment.roles as string[])
    const after = assignmentText(data, assignment.managedObject, roles)
    const updated = { ...assignment, roles }
    data.inventoryAssignments.set(assignment.id, updated)
    if (before !== after) {
      auditUser(data, id, 'updated', [listChange('inventoryAssignment', INVENTORY_ASSIGNMENT, after, 'ADDED'), listChange('inventoryAssignment', INVENTORY_ASSIGNMENT, before, 'REMOVED')])
    }
    return Response.json(renderAssignment(data, updated))
  },
  'DELETE users 7 roles inventory': (_call, data, { id, subSubId }) => {
    if (!data.users.has(id)) {
      // verified
      fail(500, 'general/internalError', `Cannot find document with ID ${id}`)
    }
    const assignment = getAssignment(data, id, subSubId!)
    data.inventoryAssignments.delete(assignment.id)
    auditUser(data, id, 'updated', [listChange('inventoryAssignment', INVENTORY_ASSIGNMENT, assignmentText(data, assignment.managedObject, assignment.roles as string[]), 'REMOVED')])
    return noContent()
  },

  'GET groups 3': (call, data) => {
    checkQuery('GET /user/{tenantId}/groups', call, ['currentPage', 'pageSize', 'withTotalElements', 'withTotalPages'])
    checkPaging(call)
    return paged(data, call, 'groups', byId(data.groups.values()), `/user/${data.tenant}/groups`, { statistics: 'pages', render: (group) => renderGroup(data, group, linkQuery(call)) })
  },
  'POST groups 3': (call, data) => created(renderGroup(data, createGroup(data, { ...body(call), roles: [] }), linkQuery(call))),
  'GET groups 4': (call, data, { id }) => {
    checkQuery('GET /user/{tenantId}/groups/{groupId}', call, [])
    return Response.json(renderGroup(data, getGroup(data, id), linkQuery(call)))
  },
  'GET groupByName 4': (call, data, { id }) => {
    checkQuery('GET /user/{tenantId}/groupByName/{groupName}', call, [])
    // verified: case-sensitive
    const group = [...data.groups.values()].find((item) => item.name === id)
      ?? fail(404, 'groups/Not Found', `Error retrieving group ${id}! : No group for name ${id}!`)
    return Response.json(renderGroup(data, group, linkQuery(call)))
  },
  'PUT groups 4': (call, data, { id }) => {
    checkQuery('PUT /user/{tenantId}/groups/{groupId}', call, ['forceLogout'])
    const group = clone(getGroup(data, id))
    const update = body(call)
    checkUserBodyTypes(update, 'com.cumulocity.rest.representation.user.GroupRepresentation')
    if (update.name === undefined || update.name === null || update.name === '') {
      fail(422, 'usermangement/Invalid Data', 'A Groupname has to be provided when updating the group.')
    }
    checkGroupName(data, String(update.name), id)
    group.name = String(update.name)
    if (update.description !== undefined && update.description !== null) {
      group.description = String(update.description)
    }
    if (update.customProperties && typeof update.customProperties === 'object') {
      group.customProperties = { ...(group.customProperties as object), ...clone(update.customProperties) }
    }
    if (update.devicePermissions !== undefined) {
      group.devicePermissions = clone(update.devicePermissions)
    }
    data.groups.set(id, group)
    return Response.json(renderGroup(data, group, linkQuery(call)))
  },
  'DELETE groups 4': (call, data, { id }) => {
    checkQuery('DELETE /user/{tenantId}/groups/{groupId}', call, ['forceLogout'])
    return deleteGroup(data, id) ? noContent() : groupNotFound(id).response()
  },
  'GET groups 5 users': (call, data, { id }) => {
    checkQuery('GET /user/{tenantId}/groups/{groupId}/users', call, ['currentPage', 'pageSize', 'withApps', 'withGroups', 'withTotalElements'])
    checkPaging(call)
    getGroup(data, id)
    const members = byId([...data.users.values()].filter((user) => (user.groups as string[]).includes(id)))
    return paged(data, call, 'references', members, `/user/${data.tenant}/groups/${id}/users`, {
      statistics: 'pages',
      render: (user) => ({ self: `${data.world.baseUrl}/user/${data.tenant}/groups/${id}/users/${user.userName}`, user: renderUser(data, user, { query: linkQuery(call) }) }),
    })
  },
  'POST groups 5 users': (call, data, { id }) => {
    const group = getGroup(data, id)
    const userName = idFromSelf(body(call).user?.self, 'users')
      ?? fail(422, 'usermangement/Invalid Data', 'Could not Identify the user by provided self link.')
    const member = data.users.get(userName)
    const owner = member && storedOwner(data, member)
    if (owner && !(owner.groups as string[]).includes(group.id)) {
      throw accessDenied()
    }
    const user = addGroupMember(data, group, userName)
    return created({ self: `${data.world.baseUrl}/user/${data.tenant}/groups/${id}/users/${userName}`, user: renderUser(data, user, { query: linkQuery(call) }) })
  },
  'DELETE groups 6 users': (_call, data, { id, subId }) => {
    // verified: an unknown user is a server error, a user outside the group is fine
    const group = getGroup(data, id)
    const user = data.users.get(subId!) ?? fail(500, 'general/internalError', `Cannot find document with ID ${subId}`)
    if ((user.groups as string[]).includes(id)) {
      data.users.set(user.id, { ...user, groups: (user.groups as string[]).filter((member) => member !== id) })
      auditMembership(data, subId!, group, 'REMOVED')
      cascadeToSubusers(data, subId!, [], [id])
    }
    return noContent()
  },
  'GET users 5 roles': (call, data, { id }) => {
    // not in the spec: no parameter check
    checkPaging(call)
    const user = getUser(data, id)
    // verified: these links have no `/user/{tenantId}` prefix
    return paged(data, call, 'references', user.roles as string[], `/users/${id}/roles`, {
      statistics: 'binaries',
      render: (role) => ({ self: `${data.world.baseUrl}/users/${id}/roles/${role}`, role: renderRole(data, role) }),
    })
  },
  'GET users 6 roles': (_call, data, { id, subId }) => {
    const prefix = `Error retrieving data for user id ${id} and authority with authorityName ${subId}! : `
    const user = getUser(data, id)
    if (!data.roles.has(subId!)) {
      fail(404, 'users/Not Found', `${prefix}Cannot find document with ID ${subId}`)
    }
    if (!(user.roles as string[]).includes(subId!)) {
      fail(404, 'users/Not Found', `User ${id} does not contain authority with authorityName ${subId} !`)
    }
    // verified: a role of the user cannot be read on its own
    return new Response(null, { status: 405 })
  },
  'GET groups 6 roles': (_call, data, { id, subId }) => {
    const prefix = `Error retrieving data for group with id ${id} and authority with authorityName ${subId}! : `
    const group = getGroup(data, id)
    if (!data.roles.has(subId!)) {
      fail(422, 'groups/Invalid Data', `${prefix}Cannot find document with ID ${subId}`)
    }
    if (!(group.roles as string[]).includes(subId!)) {
      fail(404, 'groups/Not Found', `${prefix}Group ${id} has no authority ${subId} assigned!`)
    }
    return new Response(null, { status: 405 })
  },
  'GET groups 5 roles': (call, data, { id }) => {
    checkQuery('GET /user/{tenantId}/groups/{groupId}/roles', call, ['currentPage', 'pageSize'])
    checkPaging(call)
    const group = getGroup(data, id)
    // verified: these links have no `/user/{tenantId}` prefix and an extra `users`
    return paged(data, call, 'references', group.roles as string[], `/groups/${id}/users/roles`, {
      statistics: 'binaries',
      render: (role) => ({ self: `${data.world.baseUrl}/groups/${id}/users/roles/${role}`, role: renderRole(data, role) }),
    })
  },
  'POST groups 5 roles': (call, data, { id }) => {
    const group = getGroup(data, id)
    const role = referencedRole(data, body(call))
    if ((group.roles as string[]).includes(role)) {
      fail(409, 'groups/Duplicate', `Error retrieving data for group with id ${id} and authority with authorityName ${role}! : Group ${id} already has authority ${role} assigned!`)
    }
    data.groups.set(id, { ...group, roles: [...group.roles as string[], role] })
    auditGlobalRoleUpdated(data, { id, name: group.name as string }, [listChange('roles', AUTHORITY, role, 'ADDED')])
    return created({ self: `${data.world.baseUrl}/groups/${id}/users/roles/${role}`, role: renderRole(data, role) })
  },
  'DELETE groups 6 roles': (_call, data, { id, subId }) => {
    const group = getGroup(data, id)
    const prefix = `Error retrieving data for group with id ${id} and authority with authorityName ${subId}! : `
    if (!data.roles.has(subId!)) {
      fail(422, 'groups/Invalid Data', `${prefix}Cannot find document with ID ${subId}`)
    }
    if (!(group.roles as string[]).includes(subId!)) {
      fail(404, 'groups/Not Found', `${prefix}Group ${id} has no authority ${subId} assigned!`)
    }
    data.groups.set(id, { ...group, roles: (group.roles as string[]).filter((role) => role !== subId) })
    auditGlobalRoleUpdated(data, { id, name: group.name as string }, [listChange('roles', AUTHORITY, subId!, 'REMOVED')])
    return noContent()
  },
}

/**
 * The handler of a `/user/{tenantId}/...` request, or `undefined` for a path or method the fake does not emulate.
 * @param method - Request method
 * @param resource - `users`, `userByName`, `groups`, or `groupByName`
 * @param length - Number of path segments
 * @param sub - Segment after the id
 * @param subId - Segment after `sub`
 */
function tenantRoute(method: string, resource: string, length: number, sub: string | undefined, subId: string | undefined): Handler | undefined {
  if (sub === 'roles' && subId === 'inventory' && length >= 6) {
    return TENANT_ROUTES[`${method} ${resource} ${length} roles inventory`]
  }
  return TENANT_ROUTES[`${method} ${resource} ${length}${sub === undefined ? '' : ` ${sub}`}`]
}

function getAssignment(data: TenantData, userName: string, id: string): StoredDocument {
  if (!data.users.has(userName)) {
    throw ownerNotFound(userName)
  }
  const assignment = data.inventoryAssignments.get(id)
  if (!assignment || assignment.user !== userName) {
    fail(404, 'users/Not Found', `Inventory Assignment with id 'ID [type=com_cumulocity_model_idtype_GId, value=${id}]' not found in user '${userName}' : Inventory assignment not found!`)
  }
  return assignment!
}

function listUsers(call: C8yRequest, data: TenantData): Response {
  checkQuery('GET /user/{tenantId}/users', call, USER_LIST_PARAMS)
  checkPaging(call)
  const { username, usernameContains, owner } = call.query
  if (username !== undefined && usernameContains !== undefined) {
    // verified
    fail(422, 'undefined/validationError', 'Cannot use both filters: usernameContains and username. Set only one of them.')
  }
  let items = byId(data.users.values())
  // verified: both filters are case-insensitive
  if (username) {
    items = items.filter((user) => (user.userName as string).toLowerCase().startsWith(username.toLowerCase()))
  }
  if (usernameContains) {
    items = items.filter((user) => (user.userName as string).toLowerCase().includes(usernameContains.toLowerCase()))
  }
  if (owner) {
    items = items.filter((user) => user.owner === owner)
  }
  const groups = raw(call).params.getAll('groups').flatMap((value) => value.split(',')).filter(Boolean)
  if (groups.length > 0) {
    items = items.filter((user) => (user.groups as string[]).some((group) => groups.includes(group)))
  }
  // verified: device users (`device_*`) are listed only with onlyDevices=true
  const onlyDevices = flag(call, 'onlyDevices')
  items = items.filter((user) => (user.userName as string).startsWith('device_') === onlyDevices)
  const subusersCount = flag(call, 'withSubusersCount')
  // verified: the embedded links repeat the list's other parameters
  const query = linkQuery(call)
  return paged(data, call, 'users', items, `/user/${data.tenant}/users`, { errorCode: PAGING_ERROR, render: (user) => renderUser(data, user, { subusersCount, query }) })
}

function inventoryRoles(call: C8yRequest, data: TenantData, id: string | undefined, length: number): Response | undefined {
  const { method } = call
  if (length === 2 && method === 'GET') {
    checkQuery('GET /user/inventoryroles', call, ['currentPage', 'pageSize', 'withTotalElements'])
    checkPaging(call)
    return paged(data, call, 'roles', byId(data.inventoryRoles.values()), '/user/inventoryroles', { statistics: 'pages', render: (role) => renderInventoryRole(data, role) })
  }
  if (length === 2 && method === 'POST') {
    return created(renderInventoryRole(data, createInventoryRole(data, body(call))))
  }
  if (length !== 3 || !['GET', 'PUT', 'DELETE'].includes(method)) {
    return undefined
  }
  const stored = data.inventoryRoles.get(id!)
  if (!stored) {
    // verified: an id that is not an integer answers an empty 404
    return /^-?\d+$/.test(id!) ? inventoryRoleNotFound(id!).response() : new Response(null, { status: 404 })
  }
  const role: StoredDocument = clone(stored)
  if (method === 'GET') {
    checkQuery('GET /user/inventoryroles/{id}', call, [])
    return Response.json(renderInventoryRole(data, role))
  }
  if (method === 'PUT') {
    const update = body(call)
    checkInventoryRoleBody(update, false)
    // verified: a rename to a taken name is accepted (only creation checks it);
    // the permissions are replaced also when the body has none (missing or
    // `null` clears them), `null` for the name or description is ignored
    const permissions = checkPermissions(update.permissions)
    const name = update.name === null ? undefined : inventoryRoleText(update.name)
    // verified order: permissions added, the new name, permissions removed
    const changes: AuditChange[] = []
    const before = (role.permissions as Array<Record<string, unknown>>).map(permissionText)
    const after = permissions.map(permissionText)
    changes.push(...after.filter((text) => !before.includes(text)).map((text) => listChange('permissions', INVENTORY_PERMISSION, text, 'ADDED')))
    if (name !== undefined && name !== role.name) {
      changes.push(valueChange('name', role.name, name))
    }
    changes.push(...before.filter((text) => !after.includes(text)).map((text) => listChange('permissions', INVENTORY_PERMISSION, text, 'REMOVED')))
    role.permissions = storePermissions(data, permissions, role.permissions as Array<Record<string, unknown>>)
    if (name !== undefined) {
      role.name = name
    }
    if (update.description !== undefined && update.description !== null) {
      role.description = inventoryRoleText(update.description)
    }
    data.inventoryRoles.set(role.id, role)
    auditInventoryRole(data, { id: role.id, name: role.name as string }, 'updated', changes)
    return Response.json(renderInventoryRole(data, role))
  }
  if ([...data.inventoryAssignments.values()].some((assignment) => (assignment.roles as string[]).includes(role.id))) {
    // verified
    return apiError(422, 'undefined/validationError', 'Cannot remove used InventoryRole')
  }
  data.inventoryRoles.delete(role.id)
  auditInventoryRole(data, { id: role.id, name: role.name as string }, 'removed')
  return noContent()
}

/**
 * Stores the world's current user (`createWorld({ user })`, `world.setUser()`)
 * as a user of its tenant, or updates it. Its `roles` replace the user's
 * global roles (unknown names join the role catalogue), its `groups` (names
 * or ids) replace its group memberships.
 * @param data - Tenant data of the user's tenant
 * @param input - The world's user
 */
export function upsertWorldUser(data: TenantData, input: C8yUser): void {
  const { userName, roles = [], tenant: _tenant, groups, ...fields } = input
  const stored = data.users.get(userName)
  const user: StoredDocument = stored
    ? clone(stored)
    : { id: userName, userName, customProperties: {}, passwordStrength: 'GREEN', shouldResetPassword: false, enabled: true, devicePermissions: {}, roles: [], groups: [], lastPasswordChange: data.world.now() }
  Object.assign(user, clone(fields))
  for (const role of roles) {
    if (!data.roles.has(role)) {
      data.roles.set(role, role)
    }
  }
  user.roles = [...new Set(roles)]
  if (groups !== undefined) {
    user.groups = groups.map((group) => groupId(data, group))
  }
  data.users.set(userName, user)
}

/**
 * The id of a group given by name or id (seeding).
 * @param data - Tenant data
 * @param group - Group name or id
 */
export function groupId(data: TenantData, group: string | number): string {
  const found = data.groups.get(String(group)) ?? [...data.groups.values()].find((item) => item.name === group)
  if (!found) {
    throw new TypeError(`unknown group ${group}`)
  }
  return found.id
}

/**
 * The id of an inventory role given by name or id (seeding).
 * @param data - Tenant data
 * @param role - Inventory role name or id
 */
export function inventoryRoleId(data: TenantData, role: string | number): string {
  const found = data.inventoryRoles.get(String(role)) ?? [...data.inventoryRoles.values()].find((item) => item.name === role)
  if (!found) {
    throw new TypeError(`unknown inventory role ${role}`)
  }
  return found.id
}
