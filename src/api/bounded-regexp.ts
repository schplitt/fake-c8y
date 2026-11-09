/**
 * A matcher for the regular expressions of query wildcards with a step
 * limit: on the platform a wildcard that needs too many steps counts as no
 * match and the request answers 200. A JavaScript `RegExp` has no such
 * limit, so the fake needs its own to answer the same way and to keep every
 * query fast.
 *
 * The expression is the JavaScript source `javaRegExp()` produces (`u` flag
 * syntax, validated by `new RegExp()` first). Deterministic pieces (literal
 * runs, classes, escapes, `.`, `^`, `$`, `\b`) are matched by sticky
 * `RegExp`s, so case folding, Unicode properties, and the flags behave as in
 * JavaScript; alternatives, groups, quantifiers, lookarounds, and back
 * references are matched here and every step counts against the limit. As on
 * the platform, a back reference to a group that did not take part fails, and a
 * capture keeps its value from an earlier iteration.
 */

/**
 * Steps one `test()` may take before it counts as no match. The platform
 * counts differently, so the limit is close to the platform's, not equal; it
 * keeps a document that hits it at about 10 ms.
 */
const MATCH_LIMIT = 250_000

type Node
  = | { kind: 'atom', source: string }
    | { kind: 'seq', items: Node[] }
    | { kind: 'alt', options: Node[] }
    | { kind: 'group', index: number | undefined, body: Node }
    | { kind: 'look', behind: boolean, negate: boolean, body: Node }
    | { kind: 'repeat', body: Node, min: number, max: number, greedy: boolean }
    | { kind: 'backref', ref: string }

type Continuation = (position: number) => boolean
type Matcher = (position: number, next: Continuation) => boolean

/**
 * A greedy `.*`.
 * @param node - The node
 */
function isDotStar(node: Node): boolean {
  return node.kind === 'repeat' && node.body.kind === 'atom' && node.body.source === '.' && node.min === 0 && node.max === Infinity && node.greedy
}

/**
 * Thrown when a match exceeds the limit (or the stack): no match.
 */
const LIMIT = Symbol('step limit')

function parse(source: string): { root: Node, groups: number, names: Map<string, number> } {
  let position = 0
  let groups = 0
  const names = new Map<string, number>()

  // one token: a node, or the source of a deterministic atom
  function token(): Node {
    const char = source[position]!
    if (char === '\\') {
      const rest = source.slice(position)
      const backref = /^\\([1-9]\d*)/.exec(rest) ?? /^\\k<([^>]+)>/.exec(rest)
      if (backref) {
        position += backref[0].length
        return { kind: 'backref', ref: backref[1]! }
      }
      const escape = /^\\(?:[pP]\{[^}]*\}|u\{[^}]*\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|c[a-zA-Z]|[\s\S])/.exec(rest)!
      position += escape[0].length
      return { kind: 'atom', source: escape[0] }
    }
    if (char === '[') {
      let end = position + 1
      while (source[end] !== ']') {
        end += source[end] === '\\' ? 2 : 1
      }
      const atom = source.slice(position, end + 1)
      position = end + 1
      return { kind: 'atom', source: atom }
    }
    if (char === '(') {
      const head = /^\((?:\?(?::|=|!|<=|<!|<([^>=!][^>]*)>))?/.exec(source.slice(position))![0]
      position += head.length
      const index = head === '(' || (head.startsWith('(?<') && !head.startsWith('(?<=') && !head.startsWith('(?<!')) ? ++groups : undefined
      if (index !== undefined && head.length > 1) {
        names.set(head.slice(3, -1), index)
      }
      const body = alternatives()
      position++ // ')'
      if (head === '(?=' || head === '(?!' || head === '(?<=' || head === '(?<!') {
        return { kind: 'look', behind: head.startsWith('(?<'), negate: head.endsWith('!'), body }
      }
      return { kind: 'group', index, body }
    }
    const char32 = String.fromCodePoint(source.codePointAt(position)!)
    position += char32.length
    return { kind: 'atom', source: char32 }
  }

  function quantifier(): { min: number, max: number, greedy: boolean } | undefined {
    const match = /^(?:([*+?])|\{(\d+)(,(\d*))?\})(\?)?/.exec(source.slice(position))
    if (!match) {
      return undefined
    }
    position += match[0].length
    const [min, max] = match[1] === '*'
      ? [0, Infinity]
      : match[1] === '+'
        ? [1, Infinity]
        : match[1] === '?'
          ? [0, 1]
          : [Number(match[2]), match[3] === undefined ? Number(match[2]) : match[4] === '' ? Infinity : Number(match[4])]
    return { min: min!, max: max!, greedy: match[5] === undefined }
  }

  function sequence(): Node {
    const items: Node[] = []
    let literal = ''
    const flush = () => {
      if (literal) {
        items.push({ kind: 'atom', source: literal })
        literal = ''
      }
    }
    while (position < source.length && source[position] !== '|' && source[position] !== ')') {
      const node = token()
      const repeat = quantifier()
      if (repeat) {
        flush()
        items.push({ kind: 'repeat', body: node, ...repeat })
      } else if (node.kind === 'atom') {
        literal += node.source
      } else {
        flush()
        items.push(node)
      }
    }
    flush()
    return items.length === 1 ? items[0]! : { kind: 'seq', items }
  }

  function alternatives(): Node {
    const options = [sequence()]
    while (source[position] === '|') {
      position++
      options.push(sequence())
    }
    return options.length === 1 ? options[0]! : { kind: 'alt', options }
  }

  return { root: alternatives(), groups, names }
}

/**
 * Compiles a JavaScript regular expression source into a matcher with a work
 * limit. Throws a `SyntaxError` for an invalid expression, like `RegExp`.
 * @param source - The expression (JavaScript syntax with the `u` flag)
 * @param flags - The flags (must include `u`)
 * @param limit - Steps one `test()` may take
 */
export function boundedRegExp(source: string, flags: string, limit: number = MATCH_LIMIT): { test: (input: string) => boolean } {
  // eslint-disable-next-line no-new
  new RegExp(source, flags)
  const { root, groups, names } = parse(source)
  const ignoreCase = flags.includes('i')
  let input = ''
  let steps = 0
  const captures: number[] = Array.from({ length: 2 * (groups + 1) }, () => -1)
  const step = () => {
    if (++steps > limit) {
      throw LIMIT
    }
  }

  const dotAll = flags.includes('s')

  /**
   * A greedy `.*` and the atom after it (`*x*` starts so): tries the places
   * the atom matches, last first, which is the order backtracking reaches
   * them, with one native search per place instead of one step per character.
   * @param source - The atom
   */
  function dotStarThen(source: string): Matcher {
    const sticky = new RegExp(source, `${flags}y`)
    const search = new RegExp(source, `${flags}g`)
    return (at, next) => {
      let stop = input.length
      if (!dotAll) {
        const lineBreak = /[\n\r\u2028\u2029]/g
        lineBreak.lastIndex = at
        stop = lineBreak.exec(input)?.index ?? input.length
      }
      const starts: number[] = []
      for (let from = at; from <= stop;) {
        step()
        search.lastIndex = from
        const found = search.exec(input)
        if (!found || found.index > stop) {
          break
        }
        const start = Math.max(found.index, from)
        starts.push(start)
        from = start + 1
      }
      for (let i = starts.length - 1; i >= 0; i--) {
        step()
        sticky.lastIndex = starts[i]!
        if (sticky.test(input) && next(sticky.lastIndex)) {
          return true
        }
      }
      return false
    }
  }

  function compile(node: Node): Matcher {
    switch (node.kind) {
      case 'atom': {
        const pattern = new RegExp(node.source, `${flags}y`)
        return (at, next) => {
          step()
          pattern.lastIndex = at
          if (!pattern.test(input)) {
            return false
          }
          return next(pattern.lastIndex)
        }
      }
      case 'seq': {
        const matchers: Matcher[] = []
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i]!
          const following = node.items[i + 1]
          if (isDotStar(item) && following?.kind === 'atom') {
            matchers.push(dotStarThen(following.source))
            i++
          } else {
            matchers.push(compile(item))
          }
        }
        return matchers.reduceRight<Matcher>((rest, first) => (at, next) => first(at, (end) => rest(end, next)), (at, next) => next(at))
      }
      case 'alt': {
        const options = node.options.map(compile)
        return (at, next) => options.some((option) => option(at, next))
      }
      case 'group': {
        const body = compile(node.body)
        const index = node.index
        if (index === undefined) {
          return body
        }
        return (at, next) => body(at, (end) => {
          const start = captures[2 * index]!
          const stop = captures[2 * index + 1]!
          captures[2 * index] = at
          captures[2 * index + 1] = end
          if (next(end)) {
            return true
          }
          captures[2 * index] = start
          captures[2 * index + 1] = stop
          return false
        })
      }
      case 'look': {
        const body = compile(node.body)
        const { behind, negate } = node
        return (at, next) => {
          step()
          const saved = captures.slice()
          let found = false
          if (behind) {
            for (let start = at; start >= 0 && !found; start--) {
              found = body(start, (end) => end === at)
            }
          } else {
            found = body(at, () => true)
          }
          if (found === negate) {
            captures.splice(0, captures.length, ...saved)
            return false
          }
          if (negate) {
            captures.splice(0, captures.length, ...saved)
          }
          return next(at)
        }
      }
      case 'backref': {
        const index = /^\d+$/.test(node.ref) ? Number(node.ref) : names.get(node.ref)!
        return (at, next) => {
          step()
          const start = captures[2 * index]!
          if (start < 0) {
            return false
          }
          const captured = input.slice(start, captures[2 * index + 1])
          const candidate = input.slice(at, at + captured.length)
          const same = captured === candidate || (ignoreCase && (captured.toLowerCase() === candidate.toLowerCase() || captured.toUpperCase() === candidate.toUpperCase()))
          return same && next(at + captured.length)
        }
      }
      case 'repeat': {
        const { min, max, greedy } = node
        if (node.body.kind === 'atom') {
          // a deterministic atom: collect the ends without nesting calls
          const pattern = new RegExp(node.body.source, `${flags}y`)
          // `.` (one code point, no line break without `s`) without a RegExp call
          const advance = node.body.source === '.'
            ? (at: number) => {
                step()
                const code = input.charCodeAt(at)
                if (at >= input.length || (!dotAll && (code === 10 || code === 13 || code === 0x2028 || code === 0x2029))) {
                  return -1
                }
                return (code & 0xFC00) === 0xD800 && (input.charCodeAt(at + 1) & 0xFC00) === 0xDC00 ? at + 2 : at + 1
              }
            : (at: number) => {
                step()
                pattern.lastIndex = at
                return pattern.test(input) && pattern.lastIndex !== at ? pattern.lastIndex : -1
              }
          if (greedy) {
            return (at, next) => {
              const ends = [at]
              while (ends.length - 1 < max) {
                const end = advance(ends.at(-1)!)
                if (end < 0) {
                  break
                }
                ends.push(end)
              }
              for (let count = ends.length - 1; count >= min; count--) {
                step()
                if (next(ends[count]!)) {
                  return true
                }
              }
              return false
            }
          }
          return (at, next) => {
            for (let count = 0, end = at; ; count++) {
              if (count >= min && next(end)) {
                return true
              }
              end = count < max ? advance(end) : -1
              if (end < 0) {
                return false
              }
            }
          }
        }
        const body = compile(node.body)
        const repeat = (count: number, at: number, next: Continuation): boolean => {
          step()
          const more = () => count < max && body(at, (end) => (end === at && count >= min) ? false : repeat(count + 1, end, next))
          return greedy ? more() || (count >= min && next(at)) : (count >= min && next(at)) || more()
        }
        return (at, next) => repeat(0, at, next)
      }
    }
  }

  const matcher = compile(root)
  // an expression that starts with a greedy `.*` (as `*x*` does)
  // only needs to start at 0 and after line breaks (with `s`: only at 0)
  const first = root.kind === 'seq' ? root.items[0] : root
  // a leading atom finds the next possible start natively (it cannot backtrack)
  const leadingAtom = first?.kind === 'atom' ? new RegExp(first.source, `${flags}g`) : undefined
  const leadingDotStar = first !== undefined && isDotStar(first)
  return {
    test(value) {
      input = value
      steps = 0
      try {
        for (let start = 0; start <= value.length; start++) {
          if (leadingAtom) {
            step()
            leadingAtom.lastIndex = start
            const found = leadingAtom.exec(value)
            if (!found) {
              return false
            }
            // with `u`, a start inside a surrogate pair is found at the pair
            start = Math.max(start, found.index)
          }
          const code = value.charCodeAt(start)
          if (code >= 0xDC00 && code <= 0xDFFF && start > 0 && (value.charCodeAt(start - 1) & 0xFC00) === 0xD800) {
            continue
          }
          if (leadingDotStar && start > 0 && (flags.includes('s') || !/[\n\r\u2028\u2029]/.test(value[start - 1]!))) {
            continue
          }
          captures.fill(-1)
          if (matcher(start, () => true)) {
            return true
          }
        }
        return false
      } catch (error) {
        if (error === LIMIT || error instanceof RangeError) {
          return false
        }
        throw error
      }
    },
  }
}
