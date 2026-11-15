/**
 * Log windows: `world.mark()`, `callsSince()`, `unhandledSince()`, and
 * `takeUnhandledSince()` (requests belong to the window in which they
 * started; the world keeps entries only for live marks).
 */
import { describe, expect, it } from 'vitest'
import { createWorld, UnsupportedRequestError } from '../../src'
import type { World } from '../../src'

const get = (world: World, path: string) => world.fetch(new Request(`${world.baseUrl}${path}`))
const paths = (entries: readonly { path: string }[]) => entries.map(({ path }) => path)

/**
 * Registers `GET /slow/:name`: it waits for `release()`, then fails as
 * unsupported, so its unhandled entry is recorded when it finishes.
 * @param world - The world
 */
function slowRoute(world: World): { release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  world.override('GET /slow/:name', async () => {
    await gate
    throw new UnsupportedRequestError('slow and unsupported')
  })
  return { release }
}

describe('log windows', () => {
  it('lists the calls and unhandled requests since a mark, without changing the log', async () => {
    const world = createWorld()
    await get(world, '/inventory/managedObjects')
    await get(world, '/nowhere/before')
    const mark = world.mark()
    expect(world.callsSince(mark)).toEqual([])
    await get(world, '/inventory/managedObjects?pageSize=1')
    await get(world, '/nowhere/after')
    expect(world.callsSince(mark).map(({ path, query }) => [path, query])).toEqual([['/inventory/managedObjects', { pageSize: '1' }], ['/nowhere/after', {}]])
    expect(paths(world.unhandledSince(mark))).toEqual(['/nowhere/after'])
    // the same objects as in the log since the reset, which stays whole
    expect(world.callsSince(mark)[0]).toBe(world.calls[2])
    expect(world.calls).toHaveLength(4)
    expect(paths(world.unhandled)).toEqual(['/nowhere/before', '/nowhere/after'])
    // an empty window from a mark to itself
    expect(world.callsSince(mark, mark)).toEqual([])
  })

  it('puts a request into the window in which it started, also across several marks', async () => {
    const world = createWorld()
    const { release } = slowRoute(world)
    const turn1 = world.mark()
    const pending = get(world, '/slow/a')
    const turn2 = world.mark()
    await get(world, '/nowhere/b')
    const turn3 = world.mark()
    expect(paths(world.unhandledSince(turn2))).toEqual(['/nowhere/b'])
    release()
    expect((await pending).status).toBe(501)
    // recorded after turn2 and turn3 were marked, but started before them
    expect(paths(world.callsSince(turn2))).toEqual(['/nowhere/b'])
    expect(paths(world.unhandledSince(turn2))).toEqual(['/nowhere/b'])
    expect(world.callsSince(turn3)).toEqual([])
    expect(paths(world.callsSince(turn1, turn2))).toEqual(['/slow/a'])
    expect(paths(world.unhandledSince(turn1, turn2))).toEqual(['/slow/a'])
    expect(paths(world.unhandledSince(turn1))).toEqual(['/nowhere/b', '/slow/a'])
  })

  it('gives per-turn windows between many marks', async () => {
    const world = createWorld()
    const turns = [world.mark()]
    for (let i = 0; i < 50; i++) {
      await get(world, `/nowhere/${i}`)
      turns.push(world.mark())
    }
    expect(turns.slice(1).map((end, i) => paths(world.callsSince(turns[i]!, end)))).toEqual(Array.from({ length: 50 }, (_, i) => [`/nowhere/${i}`]))
    // an end before the start is an empty window
    expect(world.callsSince(turns[2]!, turns[0])).toEqual([])
    expect(world.callsSince(turns[0]!, turns[2])).toHaveLength(2)
  })

  it('leaves out ranges with except, e.g. a restart inside a test', async () => {
    const world = createWorld()
    const test = world.mark()
    await get(world, '/inventory/managedObjects')
    const restart = world.mark()
    await get(world, '/nowhere/startup')
    const restarted = world.mark()
    await get(world, '/alarm/alarms')
    expect(paths(world.callsSince(test, undefined, { except: [{ from: restart, until: restarted }] }))).toEqual(['/inventory/managedObjects', '/alarm/alarms'])
    expect(world.unhandledSince(test, undefined, { except: [{ from: restart, until: restarted }] })).toEqual([])
    expect(paths(world.callsSince(test, undefined, { except: [{ from: restarted }] }))).toEqual(['/inventory/managedObjects', '/nowhere/startup'])
  })

  it('takes unhandled entries: later windows leave them out, late entries are taken next time', async () => {
    const world = createWorld()
    const { release } = slowRoute(world)
    const test1 = world.mark()
    await get(world, '/nowhere/a')
    const pending = get(world, '/slow/b')
    expect(paths(world.takeUnhandledSince(test1))).toEqual(['/nowhere/a'])
    // nothing new: nothing to take
    expect(world.takeUnhandledSince(test1)).toEqual([])
    const test2 = world.mark()
    release()
    await pending
    await get(world, '/nowhere/c')
    // the late entry belongs to test 1 and was not taken yet
    expect(paths(world.takeUnhandledSince(test1, test2))).toEqual(['/slow/b'])
    expect(world.takeUnhandledSince(test1, test2)).toEqual([])
    expect(paths(world.unhandledSince(test1))).toEqual(['/nowhere/c'])
    // calls stay for other readers (assertion matchers), and so do the log and coverage
    expect(paths(world.callsSince(test1, test2))).toEqual(['/nowhere/a', '/slow/b'])
    expect(world.calls).toHaveLength(3)
    expect(world.coverage().unhandled).toHaveLength(3)
  })

  it('does not depend on the calls and unhandled setters', async () => {
    const world = createWorld()
    const { release } = slowRoute(world)
    const mark = world.mark()
    await get(world, '/nowhere/done')
    const pending = get(world, '/slow/a')
    world.calls = []
    world.unhandled = []
    release()
    await pending
    // the setters' known limit: the request in flight lands in the new arrays
    expect(paths(world.unhandled)).toEqual(['/slow/a'])
    const after = world.mark()
    expect(paths(world.callsSince(mark))).toEqual(['/nowhere/done', '/slow/a'])
    expect(paths(world.unhandledSince(mark))).toEqual(['/nowhere/done', '/slow/a'])
    expect(world.unhandledSince(after)).toEqual([])
  })

  it('keeps override call counts, request ids, and usage statistics across marks', async () => {
    const world = createWorld({ now: () => Date.parse('2026-11-07T10:00:00Z') })
    const counts: number[] = []
    world.override('GET /custom', (_request, ctx) => {
      counts.push(ctx.callCount)
      return {}
    })
    await get(world, '/inventory/managedObjects')
    await get(world, '/custom')
    const mark = world.mark()
    await get(world, '/custom')
    expect(counts).toEqual([1, 2])
    expect(world.callsSince(mark).map(({ id }) => id)).toEqual([3])
    const statistics = await (await get(world, '/tenant/statistics?pageSize=2000')).json() as { usageStatistics: { requestCount: number }[] }
    // the three requests answered before the statistics request, two of them before the mark
    expect(statistics.usageStatistics.at(-1)!.requestCount).toBe(3)
  })

  it('puts the requests a service sends into the window of the request it answers', async () => {
    const world = createWorld()
    let later: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      later = resolve
    })
    world.service('assets', async (_request, ctx) => {
      await gate
      return (await ctx.fetch('/inventory/managedObjects')).json()
    })
    const test1 = world.mark()
    const pending = get(world, '/service/assets/list')
    const test2 = world.mark()
    later!()
    await pending
    expect(world.callsSince(test2)).toEqual([])
    const [outer, inner] = world.callsSince(test1, test2)
    expect([outer!.path, inner!.path, inner!.parent]).toEqual(['/service/assets/list', '/inventory/managedObjects', outer!.id])
  })

  it('ends marks with a reset: they throw, also as until', async () => {
    const world = createWorld()
    const { release } = slowRoute(world)
    const old = world.mark()
    await get(world, '/nowhere/a')
    const pending = get(world, '/slow/b')
    const checkpoint = world.checkpoint()
    world.reset({ to: checkpoint })
    expect(() => world.callsSince(old)).toThrow(/before the last reset/)
    const fresh = world.mark()
    expect(() => world.callsSince(fresh, old)).toThrow(/before the last reset/)
    expect(() => world.unhandledSince(fresh, undefined, { except: [{ from: old }] })).toThrow(TypeError)
    await get(world, '/nowhere/c')
    release()
    // the request from before the reset answers 503 and stays out
    expect((await pending).status).toBe(503)
    expect(paths(world.callsSince(fresh))).toEqual(['/nowhere/c'])
    expect(paths(world.unhandledSince(fresh))).toEqual(['/nowhere/c'])
    // releasing an ended mark does nothing
    old.release()
    world.reset()
    expect(() => world.callsSince(fresh)).toThrow(TypeError)
  })

  it('keeps marks across restore(), also to an older snapshot inside a window', async () => {
    const world = createWorld()
    const before = world.mark()
    await get(world, '/nowhere/a')
    const snapshot = world.snapshot()
    const mark = world.mark()
    await get(world, '/nowhere/b')
    world.restore(snapshot)
    await get(world, '/nowhere/c')
    expect(paths(world.callsSince(before))).toEqual(['/nowhere/a', '/nowhere/b', '/nowhere/c'])
    expect(paths(world.unhandledSince(mark))).toEqual(['/nowhere/b', '/nowhere/c'])
  })

  it('keeps only what live marks need, and released marks throw', async () => {
    const world = createWorld()
    // without a mark nothing is kept: a later mark starts empty
    await get(world, '/nowhere/unmarked')
    const first = world.mark()
    await get(world, '/nowhere/a')
    const second = world.mark()
    await get(world, '/nowhere/b')
    first.release()
    first.release()
    expect(() => world.callsSince(first)).toThrow(/released/)
    expect(() => world.callsSince(second, first)).toThrow(/released/)
    // the younger mark still sees its window
    expect(paths(world.callsSince(second))).toEqual(['/nowhere/b'])
    expect(paths(world.unhandledSince(second))).toEqual(['/nowhere/b'])
    second.release()
    const third = world.mark()
    await get(world, '/nowhere/c')
    expect(paths(world.callsSince(third))).toEqual(['/nowhere/c'])
    // the world's own log is unchanged
    expect(paths(world.calls)).toEqual(['/nowhere/unmarked', '/nowhere/a', '/nowhere/b', '/nowhere/c'])
  })

  it('belongs to one world: forks have their own log, a frozen base keeps its marks', async () => {
    const base = createWorld()
    const baseMark = base.mark()
    await get(base, '/nowhere/base')
    const [a, b] = [base.fork(), base.fork()]
    expect(() => a!.callsSince(baseMark)).toThrow(/marks of this world/)
    expect(() => base.callsSince(baseMark, a!.mark())).toThrow(TypeError)
    const markA = a!.mark()
    const markB = b!.mark()
    await get(a!, '/nowhere/a')
    await get(b!, '/inventory/managedObjects')
    expect(paths(a!.callsSince(markA))).toEqual(['/nowhere/a'])
    expect(paths(b!.callsSince(markB))).toEqual(['/inventory/managedObjects'])
    expect(b!.unhandledSince(markB)).toEqual([])
    // the frozen base still answers reads and keeps its log
    const frozenMark = base.mark()
    await get(base, '/inventory/managedObjects')
    expect(paths(base.callsSince(baseMark))).toEqual(['/nowhere/base', '/inventory/managedObjects'])
    expect(paths(base.callsSince(frozenMark))).toEqual(['/inventory/managedObjects'])
    a!.reset()
    expect(() => a!.callsSince(markA)).toThrow(TypeError)
  })
})
