import type { TenantData } from '../store'
import { childIds, descendants } from '../store'
import { parseDateTime } from './http'
import { parseIsoTime } from '../utils'
import { boundedRegExp } from './bounded-regexp'

type WildcardPattern = ReturnType<typeof boundedRegExp>

/**
 * The Cumulocity inventory query language (OData 2.0 style), as documented in
 * "Query language" of the Cumulocity REST API docs and verified against a
 * real tenant:
 *
 * - `eq`, `gt`, `ge`, `lt`, `le`, `and`, `or`, `not(...)`, `not has(...)`, parentheses
 * - `has(fragment)`, `hasany(a, b)`, `bygroupid(id, …)`, `isinhierarchyof(id, …)`
 * - strings in single quotes; `*` wildcards match case-insensitively, exact
 *   matches are case-sensitive
 * - numbers: integers (`5`, `05`, `5d`); decimals need an `f`/`d` suffix
 *   (`3.5d`), otherwise they are strings. Values are typed: a number never
 *   matches a string property and a quoted value never matches a number
 * - `true`/`false` match booleans only; `null` matches a stored `null` only,
 *   never a missing property
 * - date-times via `.date` (`creationTime.date gt '2026-…'`): the literal
 *   needs a date and a time; anything else matches nothing
 * - `eq` on array properties matches any element (`customers.id eq '1'`)
 * - `has()`/`hasany()` on a standard property (`name`, `type`, …) match nothing
 * - a quoted left side (`'name' eq 'x'`) is accepted and read as the property
 * - `$orderby=field [asc|desc], …`; arrays sort by their smallest element
 *   ascending and their largest descending
 *
 * Function arguments are not validated: a non-numeric group id matches nothing
 * and a quoted fragment name works like an unquoted one. Anything else (`ne`,
 * upper-case operators, paths with `/` or `[`) is rejected with 422 like on the
 * platform.
 */
export interface ParsedQuery {
  filter: (document: Record<string, unknown>) => boolean
  orderBy: Array<{ field: string, descending: boolean }>
}

/**
 * A query the platform would reject (answered with 422).
 */
export class QuerySyntaxError extends Error {}

type Literal = string | number | boolean | null
interface Token { kind: 'word' | 'string' | 'punct', value: string }

const COMPARISONS = new Set(['eq', 'gt', 'ge', 'lt', 'le'])
// A property path or fragment name. The platform rejects `groups/id` and
// `externalIds["x"].id` (verified); other characters are left alone.
const PATH = /^[^/[\]]+$/
/**
 * Standard managed object properties, for which `has()` is "not supported"
 * (verified against the platform: the query matches nothing).
 */
const STANDARD_PROPERTIES = new Set(['id', 'self', 'name', 'type', 'owner', 'creationTime', 'lastUpdated', 'childDevices', 'childAssets', 'childAdditions', 'deviceParents', 'assetParents', 'additionParents'])

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const char = input[i]!
    if (/\s/.test(char)) {
      i++
    } else if (char === '(' || char === ')' || char === ',') {
      tokens.push({ kind: 'punct', value: char })
      i++
    } else if (char === '\'') {
      let value = ''
      i++
      while (i < input.length) {
        if (input[i] === '\'' && input[i + 1] === '\'') {
          value += '\''
          i += 2
        } else if (input[i] === '\'') {
          break
        } else {
          value += input[i++]
        }
      }
      if (i >= input.length) {
        throw new QuerySyntaxError('unterminated string')
      }
      i++
      tokens.push({ kind: 'string', value })
    } else {
      const value = /^[^\s(),']+/.exec(input.slice(i))![0]
      tokens.push({ kind: 'word', value })
      i += value.length
    }
  }
  return tokens
}

function literal(token: Token): Literal {
  if (token.kind === 'string') {
    return token.value
  }
  if (token.value === 'null') {
    return null
  }
  if (token.value === 'true' || token.value === 'false') {
    return token.value === 'true'
  }
  if (/^-?\d+[fd]?$/i.test(token.value)) {
    return Number.parseInt(token.value, 10)
  }
  const decimal = /^(-?\d+\.\d+)[fd]$/i.exec(token.value)
  if (decimal) {
    return Number(decimal[1])
  }
  // decimals without a suffix (and other bare words) are compared as strings
  return token.value
}

/**
 * Reads a dotted path from a document. Arrays on the way are flattened, so the
 * result is a list of all values at that path.
 * @param document - The document
 * @param path - e.g. `c8y_Hardware.serialNumber` or `customers.id`
 */
export function readValues(document: unknown, path: string): unknown[] {
  let values: unknown[] = [document]
  for (const key of path.split('.')) {
    values = values.flatMap((value) => {
      const items = Array.isArray(value) ? value : [value]
      return items.flatMap((item) => (item && typeof item === 'object' && Object.hasOwn(item, key)) ? [(item as Record<string, unknown>)[key]] : [])
    })
  }
  return values.flatMap((value) => Array.isArray(value) ? value : [value])
}

/**
 * Reads a single value from a dotted path (first match).
 * @param document - The document
 * @param path - Dotted path
 */
export function readPath(document: Record<string, unknown>, path: string): unknown {
  return readValues(document, path)[0]
}

/**
 * The regular expression of a `*` wildcard literal (case-insensitive), or
 * undefined for a literal without wildcards. Verified: a wildcard literal
 * supports regular expression syntax (`h.*` matches `hxo`, `a|b*` is an
 * alternative), anchored by the position of the stars: `x*` starts
 * with `x`, `*x` ends with `x`, `*x*` contains `x` (and keeps its stars as
 * `.*`, so `*?*` and `*+*` are valid); stars inside `x*` and `*x` are dropped
 * (`h*o*` is `^ho`), stars inside `*x*` or a literal without stars at either
 * end match anything (`h*o` matches `ahoy`, unanchored). `javaRegExp()`
 * translates the platform's syntax, and a literal it does not accept (`'*{*'`,
 * a trailing backslash) is rejected with 422. It is matched with a step limit
 * (`boundedRegExp()`).
 * @param expected - The literal
 */
function wildcard(expected: Literal): WildcardPattern | undefined {
  if (typeof expected !== 'string' || !expected.includes('*')) {
    return undefined
  }
  const starts = expected.startsWith('*')
  const ends = expected.endsWith('*')
  const source = starts && ends
    ? expected.replaceAll('*', '.*')
    : ends
      ? `^${expected.slice(0, -1).replaceAll('*', '')}`
      : starts
        ? `${expected.slice(1).replaceAll('*', '')}$`
        : expected.replaceAll('*', '.*')
  try {
    return javaRegExp(source)
  } catch {
    throw new QuerySyntaxError(`invalid wildcard pattern "${expected}"`)
  }
}

// platform shorthands JavaScript lacks (outside and inside a class)
const HORIZONTAL_SPACE = ' \\t\\xA0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000'
const VERTICAL_SPACE = '\\n\\x0B\\f\\r\\x85\\u2028\\u2029'
const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\s',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  word: '\\w',
  cntrl: '\\x00-\\x1F\\x7F',
  print: '\\x20-\\x7E',
  graph: '\\x21-\\x7E',
}
// platform escapes JavaScript lacks, as an expression (outside a class) and as class content
const JAVA_SHORTHANDS: Record<string, { outside: string, inClass?: string }> = {
  A: { outside: '^' },
  G: { outside: '^' },
  z: { outside: '$' },
  Z: { outside: '(?=\\n?$)' },
  h: { outside: `[${HORIZONTAL_SPACE}]`, inClass: HORIZONTAL_SPACE },
  H: { outside: `[^${HORIZONTAL_SPACE}]` },
  v: { outside: `[${VERTICAL_SPACE}]`, inClass: VERTICAL_SPACE },
  V: { outside: `[^${VERTICAL_SPACE}]` },
  R: { outside: `(?:\\r\\n|[${VERTICAL_SPACE}])` },
  X: { outside: '(?:\\P{M}\\p{M}*)' },
  e: { outside: '\\x1B', inClass: '\\x1B' },
}
// characters JavaScript (`u` flag) accepts escaped outside a class
const JS_SYNTAX = '^$\\.*+?()[]{}|/'

/**
 * A wildcard expression in the platform's syntax (verified on a real tenant)
 * translated to a JavaScript one with the `u` flag: `\Q...\E`, possessive quantifiers, atomic
 * groups, inline flags (`(?i)`, `(?-i)`, `(?s)`, `(?m)`, `(?x)`, applied to
 * the whole expression), `\A`, `\z`, `\Z`, `\G`, `\h`, `\v`, `\R`, `\X`,
 * `\e`, `\x{..}`, octal `\0..` (two digits at most), escaped punctuation, lone `]` and `}`, a `]`
 * first in a class, and POSIX classes (`[[:alpha:]]`). What the platform
 * rejects throws (`A`, `\p{IsAlphabetic}`, `\p{InGreek}`, `(?#...)`,
 * `(?u)`), as does what this translation does not know.
 * @param source - The platform's expression
 */
function javaRegExp(source: string): WildcardPattern {
  const flags = new Set(['i', 'u'])
  let extended = false
  let out = ''
  let inClass = false
  const literal = (char: string) => (JS_SYNTAX.includes(char) || (inClass && char === '-') ? `\\${char}` : char)
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    const rest = source.slice(i)
    if (char === '\\') {
      const next = source[i + 1]
      if (next === undefined) {
        throw new SyntaxError('trailing backslash')
      }
      i++
      if (next === 'Q') {
        const close = source.indexOf('\\E', i + 1)
        const quoted = source.slice(i + 1, close === -1 ? undefined : close)
        out += [...quoted].map(literal).join('')
        i = close === -1 ? source.length : close + 1
        continue
      }
      if (/[^a-z0-9]/i.test(next)) {
        out += literal(next)
        continue
      }
      const shorthand = Object.hasOwn(JAVA_SHORTHANDS, next) ? JAVA_SHORTHANDS[next] : undefined
      if (shorthand) {
        out += inClass && shorthand.inClass !== undefined ? shorthand.inClass : shorthand.outside
        continue
      }
      const braced = /^\{([^}]*)\}/.exec(source.slice(i + 1))
      switch (next) {
        case 'u': throw new SyntaxError('\\u is not supported')
        case 'x':
          if (braced) {
            out += `\\u{${braced[1]}}`
            i += braced[0].length
            continue
          }
          break
        case 'p':
        case 'P':
          if (braced) {
            if (/^(?:Is|In|java)/.test(braced[1]!)) {
              throw new SyntaxError(`unsupported property ${braced[1]}`)
            }
            out += `\\${next}${braced[0]}`
            i += braced[0].length
            continue
          }
          break
        case '0': {
          // the platform reads at most two more octal digits
          const octal = /^[0-7]{1,2}/.exec(source.slice(i + 1))?.[0] ?? ''
          out += `\\u{${Number.parseInt(octal || '0', 8).toString(16)}}`
          i += octal.length
          continue
        }
      }
      out += `\\${next}`
      continue
    }
    if (inClass) {
      const posix = /^\[:(\^?)([a-z]+):\]/.exec(rest)
      if (posix && Object.hasOwn(POSIX_CLASSES, posix[2]!) && !posix[1]) {
        out += POSIX_CLASSES[posix[2]!]
        i += posix[0].length - 1
      } else if (char === '[') {
        out += '\\['
      } else {
        out += char
        inClass = char !== ']'
      }
      continue
    }
    if (extended && /\s/.test(char)) {
      continue
    }
    if (char === '[') {
      inClass = true
      const negated = source[i + 1] === '^'
      out += negated ? '[^' : '['
      i += negated ? 1 : 0
      if (source[i + 1] === ']') {
        out += '\\]'
        i++
      }
      continue
    }
    if (char === '(' && source[i + 1] === '?') {
      const group = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?([:)])/.exec(rest)
      if (group && (group[1] || group[2] !== undefined)) {
        for (const flag of `${group[1]}${group[2] ?? ''}`) {
          if (!'ismx'.includes(flag)) {
            throw new SyntaxError(`unsupported flag ${flag}`)
          }
        }
        for (const flag of group[1]!) {
          if (flag === 'x') {
            extended = true
          } else {
            flags.add(flag)
          }
        }
        for (const flag of group[2] ?? '') {
          if (flag === 'x') {
            extended = false
          } else {
            flags.delete(flag)
          }
        }
        out += group[3] === ':' ? '(?:' : ''
        i += group[0].length - 1
        continue
      }
      if (source[i + 2] === '>') {
        out += '(?:'
        i += 2
        continue
      }
    }
    if (char === '{') {
      const quantifier = /^\{\d+(?:,\d*)?\}/.exec(rest)
      if (quantifier) {
        out += quantifier[0]
        i += quantifier[0].length - 1
        if (source[i + 1] === '+') {
          i++
        }
        continue
      }
    }
    if ((char === '*' || char === '+' || char === '?') && source[i + 1] === '+') {
      // possessive: read as greedy
      out += char
      i++
      continue
    }
    out += char === ']' || char === '}' ? `\\${char}` : char
  }
  return boundedRegExp(out, [...flags].sort().join(''))
}

/**
 * Properties the platform stores as dates: compare them with `.date`.
 */
const DATE_PROPERTIES = new Set(['creationTime', 'lastUpdated'])

function compareOne(actual: unknown, operator: string, expected: Literal, asDate: boolean, pattern?: WildcardPattern): boolean {
  if (expected === null) {
    // verified: only a stored null, never a missing property
    return operator === 'eq' && actual === null
  }
  if (actual === null || actual === undefined || typeof actual === 'object') {
    return false
  }
  if (asDate) {
    const left = parseIsoTime(actual)
    const right = expected as number
    switch (operator) {
      case 'eq': return left === right
      case 'gt': return left > right
      case 'ge': return left >= right
      case 'lt': return left < right
      default: return left <= right
    }
  }
  // verified: values are typed (numbers, strings, booleans never match each other)
  if (typeof actual !== typeof expected) {
    return false
  }
  if (operator === 'eq') {
    return pattern ? pattern.test(String(actual)) : actual === expected
  }
  // verified: booleans order false before true (`flag gt false` matches true)
  const left = actual as number | string | boolean
  const right = expected
  switch (operator) {
    case 'gt': return left > right
    case 'ge': return left >= right
    case 'lt': return left < right
    default: return left <= right
  }
}

// A `.date` literal needs a date and a time (seconds, fraction, and zone optional)
const QUERY_DATE = /^\d{4}-\d{1,2}-\d{1,2}T\d{1,2}:\d{1,2}(:\d{1,2}(\.\d+)?)?(Z|[+-]\d{1,2}(:?\d{2})?)?$/

/**
 * Parses a `.date` literal the way the platform does (verified): a value
 * without a date and a time (`'2020-01-01'`, `'yesterday'`, lower-case `t`/`z`)
 * matches nothing, one with the right shape but impossible fields
 * (`'2020-13-01T00:00:00Z'`, a fraction longer than nine digits) is rejected
 * with 422.
 * @param value - The literal
 * @returns Epoch milliseconds, `NaN` (matches nothing), or `'invalid'` (422)
 */
function queryDate(value: string): number | 'invalid' {
  if (!QUERY_DATE.test(value)) {
    return Number.NaN
  }
  const withSeconds = value.replace(/^(\d{4}-\d{1,2}-\d{1,2}T\d{1,2}:\d{1,2})(?![:\d])/, '$1:00')
  const time = parseDateTime(withSeconds)
  return Number.isNaN(time) ? 'invalid' : time
}

/**
 * `has(fragment)`: the property exists. Standard properties are "not
 * supported": the platform matches nothing for them.
 * @param document
 * @param fragment
 */
function hasFragment(document: Record<string, unknown>, fragment: string): boolean {
  return !STANDARD_PROPERTIES.has(fragment.split('.')[0]!) && readValues(document, fragment).length > 0
}

function parseFilter(input: string, data: TenantData): ParsedQuery['filter'] {
  const tokens = tokenize(input)
  let position = 0
  const peek = () => tokens[position]
  const next = () => {
    const token = tokens[position++]
    if (!token) {
      throw new QuerySyntaxError('unexpected end')
    }
    return token
  }
  const expect = (value: string) => {
    if (next().value !== value) {
      throw new QuerySyntaxError(`expected "${value}"`)
    }
  }
  const argumentList = (kind: 'fragment' | 'id') => {
    expect('(')
    const args: string[] = []
    // verified: arguments are not checked against the data (`bygroupid(abc)`,
    // `has('x')` are accepted), but each is one quoted string or one word,
    // separated by commas: `bygroupid(12 34)`, `bygroupid(<5>)`, `has(.a)`,
    // `has(*)`, `bygroupid()` answer 422; a fragment name cannot start with a
    // digit or `-` (`has(1)`), an id can (`bygroupid(-1)`, not `bygroupid(-)`)
    while (true) {
      const token = next()
      if (token.kind === 'punct' || (token.kind === 'word' && (!PATH.test(token.value) || /[<>*#"]|^\.|^-$/.test(token.value) || (kind === 'fragment' && /^[\d-]/.test(token.value))))) {
        throw new QuerySyntaxError(`invalid function argument "${token.value}"`)
      }
      args.push(token.value)
      const separator = next()
      if (separator.value === ')') {
        return args
      }
      if (separator.value !== ',') {
        throw new QuerySyntaxError(`expected "," or ")" after "${token.value}"`)
      }
    }
  }
  const comparison = (): [string, Literal] => {
    const operator = next()
    if (operator.kind !== 'word' || !COMPARISONS.has(operator.value)) {
      throw new QuerySyntaxError(`unknown operator "${operator.value}"`)
    }
    return [operator.value, literal(next())]
  }

  function parseOr(): ParsedQuery['filter'] {
    let left = parseAnd()
    while (peek()?.kind === 'word' && peek()!.value === 'or') {
      next()
      const a = left
      const b = parseAnd()
      left = (document) => a(document) || b(document)
    }
    return left
  }

  function parseAnd(): ParsedQuery['filter'] {
    let left = parseUnary()
    while (peek()?.kind === 'word' && peek()!.value === 'and') {
      next()
      const a = left
      const b = parseUnary()
      left = (document) => a(document) && b(document)
    }
    return left
  }

  function parseUnary(): ParsedQuery['filter'] {
    const token = next()
    if (token.value === '(') {
      const inner = parseOr()
      expect(')')
      return inner
    }
    if (token.kind === 'punct') {
      throw new QuerySyntaxError(`unexpected "${token.value}"`)
    }
    // verified: a quoted left side ('name' eq 'x') is accepted and names the
    // property; keywords and functions are only recognized unquoted
    if (token.kind === 'word' && token.value === 'not') {
      // verified: `not` binds tighter than `and`/`or` and takes a parenthesized
      // expression, a function call, or another `not`; a bare comparison
      // (`not type eq 'x'`) is rejected
      const operand = peek()
      const negatesCall = operand?.kind === 'word' && (operand.value === 'not' || tokens[position + 1]?.value === '(')
      if (operand?.value !== '(' && !negatesCall) {
        throw new QuerySyntaxError('not needs a parenthesized expression or a function')
      }
      const inner = parseUnary()
      return (document) => !inner(document)
    }
    if (token.kind === 'word' && peek()?.value === '(') {
      switch (token.value) {
        case 'has': {
          const args = argumentList('fragment')
          if (args.length !== 1) {
            throw new QuerySyntaxError('has() accepts one argument')
          }
          return (document) => hasFragment(document, args[0]!)
        }
        case 'hasany': {
          const args = argumentList('fragment')
          return (document) => args.some((fragment) => hasFragment(document, fragment))
        }
        case 'bygroupid': {
          // direct members (child assets) of the given groups (the set is
          // built once per query, not per document)
          const args = argumentList('id')
          let members: Set<string> | undefined
          return (document) => (members ??= new Set(args.flatMap((group) => childIds(data, group, 'childAssets')))).has(String(document.id))
        }
        case 'isinhierarchyof': {
          // the given objects and all their children (assets, devices, additions), recursively
          const args = argumentList('id')
          let members: Set<string> | undefined
          return (document) => (members ??= descendants(data, args)).has(String(document.id))
        }
        default:
          throw new QuerySyntaxError(`unknown function ${token.value}()`)
      }
    }
    if (!PATH.test(token.value)) {
      throw new QuerySyntaxError(`invalid property path "${token.value}"`)
    }
    const [operator, value] = comparison()
    const asDate = token.value.endsWith('.date')
    const path = asDate ? token.value.slice(0, -'.date'.length) : token.value
    const date = asDate ? queryDate(String(value)) : undefined
    if (date === 'invalid') {
      throw new QuerySyntaxError(`invalid date "${String(value)}"`)
    }
    if (!asDate && DATE_PROPERTIES.has(path)) {
      // verified: the platform stores these as dates, a comparison with a
      // string (without `.date`) never matches
      return () => false
    }
    const expected = date ?? value
    const pattern = operator === 'eq' ? wildcard(expected) : undefined
    return (document) => {
      const values = readValues(document, path)
      return values.length === 0
        ? compareOne(undefined, operator, expected, asDate, pattern)
        : values.some((actual) => compareOne(actual, operator, expected, asDate, pattern))
    }
  }

  const filter = parseOr()
  if (position < tokens.length) {
    throw new QuerySyntaxError(`unexpected "${tokens[position]!.value}"`)
  }
  return filter
}

/**
 * Parses a `query`/`q` parameter value. Verified: the value is split at
 * `$filter=` and `$orderby=`; text before the first of them is ignored, and
 * so is a `$filter=` with nothing after it at the very end. Only the first two
 * parts count (both must be valid, later ones are not even checked):
 *
 * - one part: the filter or the order;
 * - a filter and an order (either way round): both;
 * - two filters: the second, but the first (and no order) once a `$orderby=`
 *   follows anywhere later;
 * - two orders: 422.
 *
 * `$orderby` takes comma-separated fields, each with an optional lower-case
 * `asc` or `desc`; anything else (`DESC`, a trailing comma, a third word) is
 * rejected with 422. An empty `$orderby=` sorts nothing.
 * @param raw - e.g. `$filter=(name eq 'Pump*') $orderby=name asc`
 * @param data - Tenant data (for `bygroupid()` and `isinhierarchyof()`)
 */
export function parseQuery(raw: string, data: TenantData): ParsedQuery {
  const split = raw.split(/(\$filter=|\$orderby=)/)
  const parts: Array<{ order: boolean, text: string }> = []
  for (let i = 1; i < split.length; i += 2) {
    const text = split[i + 1]!
    if (split[i] === '$orderby=' || text !== '') {
      parts.push({ order: split[i] === '$orderby=', text: text.trim() })
    }
  }
  if (split.length === 1) {
    parts.push({ order: false, text: raw.trim() })
  }
  const [first, second] = parts
  if (first?.order && second?.order) {
    throw new QuerySyntaxError('two $orderby parts')
  }
  // both of the first two parts are checked, whichever counts
  const checked = [first, second].map((part) => part && (part.order ? parseOrderBy(part.text) : (part.text ? parseFilter(part.text, data) : () => true)))
  let filter: ParsedQuery['filter'] = () => true
  let orderBy: ParsedQuery['orderBy'] = []
  if (first && second && !first.order && !second.order) {
    const orderFollows = parts.slice(2).some((part) => part.order)
    filter = checked[orderFollows ? 0 : 1] as ParsedQuery['filter']
  } else {
    for (const [index, part] of [first, second].entries()) {
      if (part?.order) {
        orderBy = checked[index] as ParsedQuery['orderBy']
      } else if (part) {
        filter = checked[index] as ParsedQuery['filter']
      }
    }
  }
  return { filter, orderBy }
}

function parseOrderBy(text: string): ParsedQuery['orderBy'] {
  const orderBy: ParsedQuery['orderBy'] = []
  if (text === '') {
    return orderBy
  }
  for (const part of text.split(',')) {
    const [field, direction, ...rest] = part.trim().split(/\s+/)
    if (!field || rest.length > 0 || (direction !== undefined && direction !== 'asc' && direction !== 'desc')) {
      throw new QuerySyntaxError(`invalid $orderby "${part}"`)
    }
    orderBy.push({ field, descending: direction === 'desc' })
  }
  return orderBy
}

/**
 * Sorts documents by `$orderby` fields.
 * @param items - Documents
 * @param orderBy - Sort fields
 */
export function applyOrderBy<T extends Record<string, unknown>>(items: T[], orderBy: ParsedQuery['orderBy']): T[] {
  if (orderBy.length === 0) {
    return items
  }
  // verified against the platform: missing values first (ascending), then
  // numbers, then strings (by character code), then booleans.
  // Ids are numeric on the platform. An array sorts by its smallest element
  // ascending and its largest descending.
  const rank = (value: unknown) => value === undefined || value === null ? 0 : typeof value === 'number' ? 1 : typeof value === 'string' ? 2 : 3
  const compare = (left: unknown, right: unknown) => rank(left) !== rank(right)
    ? rank(left) - rank(right)
    : (left as number | string) < (right as number | string) ? -1 : 1
  const sortKey = (document: T, field: string, descending: boolean): unknown => {
    if (field.endsWith('.date')) {
      // verified: sorts by the date (missing or unreadable dates first)
      const time = parseIsoTime(readValues(document, field.slice(0, -'.date'.length))[0])
      return Number.isNaN(time) ? undefined : time
    }
    const values = readValues(document, field).filter((value) => typeof value !== 'object' || value === null)
    if (field === 'id') {
      const id = Number(values[0])
      return Number.isNaN(id) ? undefined : id
    }
    return values.reduce<unknown>((best, value) => best === undefined ? value : (descending ? compare(value, best) > 0 : compare(value, best) < 0) ? value : best, undefined)
  }
  // keys once per document, not per comparison
  const keyed = items.map((item) => ({ item, keys: orderBy.map(({ field, descending }) => sortKey(item, field, descending)) }))
  keyed.sort((a, b) => {
    for (const [index, { descending }] of orderBy.entries()) {
      const left = a.keys[index]
      const right = b.keys[index]
      if (left === right || (rank(left) === 0 && rank(right) === 0)) {
        continue
      }
      const result = compare(left, right)
      return descending ? -result : result
    }
    return 0
  })
  return keyed.map(({ item }) => item)
}
