/**
 * Wildcards are regular expressions matched with a step limit: a nested
 * quantifier answers fast instead of stalling the world, and a match that
 * needs too many steps counts as no match, like on the platform.
 */
import { describe, expect, it } from 'vitest'
import { createWorld } from '../../src'
import { boundedRegExp } from '../../src/api/bounded-regexp'

async function names(world: ReturnType<typeof createWorld>, filter: string) {
  const started = performance.now()
  const response = await world.fetch(new Request(`${world.baseUrl}/inventory/managedObjects?pageSize=100&query=${encodeURIComponent(`$filter=(${filter})`)}`, { headers: { accept: 'application/json' } }))
  const elapsed = performance.now() - started
  const body = await response.json() as { managedObjects: { name: string }[] }
  return { status: response.status, names: body.managedObjects.map((mo) => mo.name), elapsed }
}

describe('wildcard work limit', () => {
  it('answers a nested quantifier fast (platform: 200, no match)', async () => {
    const world = createWorld({ tenant: 't100' })
    world.device({ name: 'Harbor pump station north sector unit 12' })
    await names(world, `name eq 'warm*'`)
    const result = await names(world, `name eq '*(\\w+\\s?)+z*'`)
    expect(result.status).toBe(200)
    expect(result.names).toEqual([])
    expect(result.elapsed).toBeLessThan(50)
  })

  it('counts a match over the limit as no match, like the platform', async () => {
    // without the nested quantifier both match
    const world = createWorld({ tenant: 't100' })
    world.device({ name: `x-${'a'.repeat(12)}X` })
    world.device({ name: `x-${'a'.repeat(24)}X` })
    expect((await names(world, `name eq '*(?:(a+)+#|aX)'`)).names).toEqual([`x-${'a'.repeat(12)}X`])
    expect((await names(world, `name eq '*(?:a+#|aX)'`)).names).toHaveLength(2)
  })

  it('matches like a JavaScript RegExp within the limit', () => {
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!
    const quantified = (text: string) => /^(?:\^|\$|\\b|\(\?[=!]|\(\?<[=!])/.test(text) || random() < 0.5 ? text : `${text}${pick(['*', '+', '?', '{2}', '{1,3}', '{2,}'])}${random() < 0.3 ? '?' : ''}`
    function alternatives(depth: number): string {
      const sequence = () => Array.from({ length: 1 + Math.floor(random() * 3) }, () => quantified(atom(depth))).join('')
      return random() < 0.25 ? `${sequence()}|${sequence()}` : sequence()
    }
    function atom(depth: number): string {
      if (depth > 2 || random() < 0.5) {
        return pick(['a', 'b', 'A', ' ', '.', '[ab]', '[^a]', '\\w', '\\s', '\\d', 'é', '\\u{1F600}', '^', '$', '\\b'])
      }
      return `${pick(['(', '(?:', '(?=', '(?!', '(?<=', '(?<!', '(?<g>'])}${alternatives(depth + 1)})`
    }
    let checked = 0
    for (let i = 0; i < 2000; i++) {
      const source = alternatives(0).replace(/\(\?<g>/g, () => `(?<g${i}x${Math.floor(random() * 1e6)}>`)
      const flags = pick(['iu', 'u', 'imu', 'isu'])
      let native: RegExp
      try {
        native = new RegExp(source, flags)
      } catch {
        continue
      }
      const bounded = boundedRegExp(source, flags, 1e7)
      for (let j = 0; j < 5; j++) {
        const input = Array.from({ length: Math.floor(random() * 7) }, () => pick(['a', 'b', 'A', ' ', '1', '\n', 'é', '😀'])).join('')
        expect(bounded.test(input), `${source} /${flags} on ${JSON.stringify(input)}`).toBe(native.test(input))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(5000)
  })
})
