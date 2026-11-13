/**
 * The store of one kind of document (managed objects, users, tenant options,
 * ...) of one tenant. Every read and write of the fake goes through it, and
 * nobody changes a stored value in place: read it, copy what changes (or use
 * `update()`), and `set()` the copy.
 *
 * A collection can be frozen and then forked: a fork reads its base and then
 * its own overlay and writes only to the overlay. Deleting a base value
 * leaves a tombstone. The order of `keys()`/`values()`/`entries()` is the
 * order a plain `Map` with the same history would have: insertion order, an
 * overwrite keeps the position, a delete and a new `set()` moves the key to
 * the end.
 */
import { clone, deepFreeze } from './utils'

export interface CollectionOptions {
  /**
   * Deep-freezes every value on `set()`, so code that changes a stored value
   * in place throws (in strict mode code).
   */
  freezeValues?: boolean
}

/**
 * The keys a fork touched, with their values before (in the base) and after.
 * Untouched keys are equal in base and fork, so a diff of these two lists is
 * the diff of the whole collection.
 */
export interface TouchedEntries<V> {
  /**
   * Base values of changed and deleted keys, in the base's order.
   */
  before: Array<[string, V]>
  /**
   * Current values of changed and added keys, in the collection's order.
   */
  after: Array<[string, V]>
  /**
   * Base keys that were deleted and set again (in both lists): a diff shows
   * them as deleted and created, not as updated.
   */
  recreated: Set<string>
}

export class Collection<V> implements Iterable<[string, V]> {
  readonly #base: Collection<V> | undefined
  readonly #freezeValues: boolean
  /**
   * New values of base keys that keep their base position.
   */
  #changed = new Map<string, V>()
  /**
   * Keys after the base, in insertion order: new keys, and base keys that
   * were deleted and set again (they move to the end, like in a `Map`).
   */
  #added = new Map<string, V>()
  /**
   * Base keys removed from their base position (tombstones).
   */
  #hidden = new Set<string>()
  /**
   * Insertion number of every key in `#added` (an overwrite keeps it), so
   * `position()` needs no scan.
   */
  #addedOrder = new Map<string, number>()
  #nextOrder = 0
  #frozen = false
  /**
   * Counts the writes, for caches of derived values (`version`).
   */
  #version = 0
  /**
   * Position of every key, built on demand once the collection is frozen.
   */
  #index: Map<string, number> | undefined
  /**
   * Group indexes of a frozen collection (see `groupedBy()`), by grouping function.
   */
  #groups = new Map<object, Map<string, string[]>>()
  /**
   * Sort orders of a frozen collection (see `sortedBy()`), by sort key function.
   */
  #sorted = new Map<object, SortedEntries<V>>()
  /**
   * Group indexes of the own values (`#changed` and `#added`) of a writable
   * collection, by grouping function: built on the first `groupedBy()` and
   * kept up to date by every write, so a write costs O(1) and not a rebuild.
   */
  #ownGroups = new Map<object, OwnGroups>()
  /**
   * The own values (`#changed` and `#added`) of a writable collection in sort
   * order, by sort key function: built on the first `sortedBy()` and kept up
   * to date by every write.
   */
  #ownSorted = new Map<object, SortedEntries<V>>()

  constructor(entries: Iterable<readonly [string, V]> = [], options: CollectionOptions = {}, base?: Collection<V>) {
    this.#freezeValues = options.freezeValues ?? false
    this.#base = base
    for (const [key, value] of entries) {
      this.set(key, value)
    }
  }

  get frozen(): boolean {
    return this.#frozen
  }

  /**
   * Changes with every write: a value derived from the collection can be
   * cached until the version changes.
   */
  get version(): number {
    return this.#version
  }

  /**
   * The frozen collection this fork is built on, if any.
   */
  get base(): Collection<V> | undefined {
    return this.#base
  }

  /**
   * Whether this fork has not written anything (it then reads like its base).
   */
  get pristine(): boolean {
    return this.#untouchedBase() !== undefined
  }

  get size(): number {
    return this.#base ? this.#base.size - this.#hidden.size + this.#added.size : this.#added.size
  }

  has(key: string): boolean {
    if (this.#added.has(key)) {
      return true
    }
    return this.#base !== undefined && !this.#hidden.has(key) && this.#base.has(key)
  }

  get(key: string): Readonly<V> | undefined {
    const added = this.#added.get(key)
    if (added !== undefined || !this.#base) {
      return added
    }
    if (this.#hidden.has(key)) {
      return undefined
    }
    return this.#changed.has(key) ? this.#changed.get(key) : this.#base.get(key)
  }

  set(key: string, value: V): this {
    this.#writable()
    if (this.#freezeValues) {
      deepFreeze(value)
    }
    const changed = this.#base !== undefined && !this.#added.has(key) && !this.#hidden.has(key) && this.#base.has(key)
    const own = changed ? this.#changed : this.#added
    const previous = own.has(key) ? { value: own.get(key)! } : undefined
    if (changed) {
      this.#changed.set(key, value)
    } else {
      if (!this.#added.has(key)) {
        this.#addedOrder.set(key, this.#nextOrder++)
      }
      this.#added.set(key, value)
    }
    this.#indexOwn(key, changed, previous, { value })
    return this
  }

  delete(key: string): boolean {
    this.#writable()
    if (this.#added.has(key)) {
      this.#indexOwn(key, false, { value: this.#added.get(key)! }, undefined)
      this.#added.delete(key)
      this.#addedOrder.delete(key)
      // a re-added base key keeps its tombstone
      return true
    }
    if (this.#base && !this.#hidden.has(key) && this.#base.has(key)) {
      if (this.#changed.has(key)) {
        this.#indexOwn(key, true, { value: this.#changed.get(key)! }, undefined)
      }
      this.#hidden.add(key)
      this.#changed.delete(key)
      return true
    }
    return false
  }

  /**
   * Keeps the own group indexes and sort orders up to date with a write of
   * an own value (in `#changed` or `#added`).
   * @param key - The key written
   * @param changed - Whether the value is (or was) in `#changed`
   * @param previous - The own value before the write, if any
   * @param next - The own value after the write (`undefined`: deleted)
   */
  #indexOwn(key: string, changed: boolean, previous: { value: V } | undefined, next: { value: V } | undefined): void {
    for (const [grouping, own] of this.#ownGroups) {
      const by = grouping as (value: V) => string | undefined
      const groups = changed ? own.changed : own.added
      const before = previous && by(previous.value)
      const after = next && by(next.value)
      if (previous && next && before === after) {
        continue
      }
      if (before !== undefined) {
        // a copy: a caller may be iterating the old list
        const keys = (groups.get(before) ?? []).filter((item) => item !== key)
        if (keys.length > 0) {
          groups.set(before, keys)
        } else {
          groups.delete(before)
        }
      }
      if (after !== undefined) {
        const keys = groups.get(after)
        if (!keys) {
          groups.set(after, [key])
        } else if (changed || !previous) {
          // the order of changed keys does not matter (see `groupedBy()`), a new key comes last
          keys.push(key)
        } else {
          // an overwrite that moved an added key to another group: by insertion order
          const order = this.#addedOrder
          const at = lowerBound(keys.length, (index) => order.get(keys[index]!)! > order.get(key)!)
          keys.splice(at, 0, key)
        }
      }
    }
    if (this.#ownSorted.size === 0) {
      return
    }
    const position = this.#ownPosition(key, changed)
    for (const [sortKey, own] of this.#ownSorted) {
      const by = sortKey as (value: V) => number
      if (previous) {
        const order = by(previous.value)
        const at = lowerBound(own.keys.length, (index) => !entryBefore(own, index, order, position))
        // a value changed in place (which nobody may do) has moved: find it by key
        spliceEntries(own, own.keys[at] === key ? at : own.keys.indexOf(key), 1)
      }
      if (next) {
        const order = by(next.value)
        const at = lowerBound(own.keys.length, (index) => !entryBefore(own, index, order, position))
        spliceEntries(own, at, 0, key, next.value, order, position)
      }
    }
  }

  /**
   * The position of an own key in a stable sort: a changed key at its base
   * position, an added one after the base in insertion order.
   * @param key - The key
   * @param changed - Whether the key is in `#changed`
   */
  #ownPosition(key: string, changed: boolean): number {
    const base = this.#base
    if (changed) {
      return base!.#positions().get(key)!
    }
    return (base ? base.#positions().size : 0) + this.#addedOrder.get(key)!
  }

  /**
   * Copies a stored value, lets `change` modify the copy, and stores it.
   * @param key - Key of the value
   * @param change - Modifies the copy
   * @returns The stored copy, or `undefined` if there is no value
   */
  update(key: string, change: (draft: V) => void): V | undefined {
    const current = this.get(key)
    if (current === undefined) {
      return undefined
    }
    const draft = clone(current) as V
    change(draft)
    this.set(key, draft)
    return draft
  }

  entries(): IterableIterator<[string, V]> {
    const base = this.#untouchedBase()
    if (base) {
      return base.entries()
    }
    return this.#base ? this.#merged(this.#base, (key, value): [string, V] => [key, value]) : this.#added.entries()
  }

  keys(): IterableIterator<string> {
    const base = this.#untouchedBase()
    if (base) {
      return base.keys()
    }
    return this.#base ? this.#merged(this.#base, (key) => key) : this.#added.keys()
  }

  values(): IterableIterator<V> {
    const base = this.#untouchedBase()
    if (base) {
      return base.values()
    }
    return this.#base ? this.#merged(this.#base, (_key, value) => value) : this.#added.values()
  }

  /**
   * The base, if this fork has not written anything (it then reads like its base).
   */
  #untouchedBase(): Collection<V> | undefined {
    return this.#base && this.#added.size === 0 && this.#hidden.size === 0 && this.#changed.size === 0 ? this.#base : undefined
  }

  /**
   * The base's entries without the hidden ones and with the changed values,
   * then the added ones.
   * @param base - The base collection
   * @param pick - What to yield of an entry
   */
  * #merged<T>(base: Collection<V>, pick: (key: string, value: V) => T): IterableIterator<T> {
    const hidden = this.#hidden.size > 0 ? this.#hidden : undefined
    const changed = this.#changed.size > 0 ? this.#changed : undefined
    for (const [key, value] of base.entries()) {
      if (hidden?.has(key)) {
        continue
      }
      yield pick(key, changed?.has(key) ? changed.get(key)! : value)
    }
    for (const [key, value] of this.#added) {
      yield pick(key, value)
    }
  }

  /**
   * An index of the keys by a value derived from the stored values, e.g.
   * external ids by managed object or events by source. A frozen collection
   * builds it once and keeps it; a writable one builds an index of its own
   * values on the first call and updates it on every write, and a fork layers
   * that on its base's index. Pass a module-level function, which is the
   * cache key.
   * @param by - The group of a value, or `undefined` for none
   * @returns The keys of a group, in collection order (the lookup sees later
   * writes; do not change the returned list)
   */
  groupedBy(by: (value: V) => string | undefined): (group: string) => readonly string[] {
    const base = this.#base
    if (!base) {
      // without a base, the own index is the whole index
      const { added } = this.#ownGroupsOf(by)
      return (group) => added.get(group) ?? []
    }
    if (this.#frozen) {
      let index = this.#groups.get(by)
      if (!index) {
        index = groupKeys(this.entries(), by)
        this.#groups.set(by, index)
      }
      return (group) => index.get(group) ?? []
    }
    const inBase = base.groupedBy(by)
    if (this.#untouchedBase()) {
      return inBase
    }
    const hidden = this.#hidden
    const changed = this.#changed
    const { changed: changedGroups, added: addedGroups } = this.#ownGroupsOf(by)
    return (group) => {
      let keys = inBase(group)
      if (hidden.size > 0 || changed.size > 0) {
        keys = keys.filter((key) => !hidden.has(key) && (!changed.has(key) || by(changed.get(key)!) === group))
      }
      // changed values that moved into this group keep their base position
      const movedIn = (changedGroups.get(group) ?? []).filter((key) => by(base.get(key) as V) !== group)
      if (movedIn.length > 0) {
        const positions = base.#positions()
        keys = [...keys, ...movedIn].sort((a, b) => positions.get(a)! - positions.get(b)!)
      }
      const added = addedGroups.get(group)
      return added ? [...keys, ...added] : keys
    }
  }

  /**
   * The values sorted by a number derived from each value, ascending, equal
   * numbers in collection order (what a stable sort of `values()` returns).
   * A frozen collection sorts once and keeps the order; a writable one keeps
   * its own values sorted through every write, and a fork merges them into
   * its base's order lazily, so a page costs O(page) and not O(collection).
   * Pass a module-level function, which is the cache key.
   *
   * The list is a view: read it before the next write (it throws after one).
   * @param by - The sort key of a value (not `NaN`)
   * @param options - Sort options
   * @param options.reverse - The whole order reversed: descending, equal
   * numbers in reverse collection order
   */
  sortedBy(by: (value: V) => number, options: { reverse?: boolean } = {}): SortedList<V> {
    const reverse = options.reverse ?? false
    const base = this.#base
    if (this.#frozen) {
      return new SortedView(this.#frozenSorted(by), undefined, undefined, this.size, reverse, () => {})
    }
    const version = this.#version
    const check = () => {
      if (this.#version !== version) {
        throw new TypeError('fake-c8y: a sorted list was read after a write to its collection; call sortedBy() again')
      }
    }
    if (!base) {
      return new SortedView(this.#ownSortedOf(by), undefined, undefined, this.size, reverse, check)
    }
    const inBase = base.#frozenSorted(by)
    if (this.#untouchedBase()) {
      return new SortedView(inBase, undefined, undefined, this.size, reverse, check)
    }
    const hidden = this.#hidden
    const changed = this.#changed
    return new SortedView(inBase, this.#ownSortedOf(by), (key) => hidden.has(key) || changed.has(key), this.size, reverse, check)
  }

  /**
   * The sort order of a frozen collection, sorted once.
   * @param by - The sort key of a value
   */
  #frozenSorted(by: (value: V) => number): SortedEntries<V> {
    let sorted = this.#sorted.get(by)
    if (!sorted) {
      sorted = sortEntries([...this.entries()].map(([key, value], position) => ({ key, value, order: by(value), position })))
      this.#sorted.set(by, sorted)
    }
    return sorted
  }

  /**
   * The own values in sort order (built on the first call, then kept up to
   * date by `set()` and `delete()`): changed values at their base position,
   * added ones after the base, like a stable sort of the whole collection.
   * @param by - The sort key of a value
   */
  #ownSortedOf(by: (value: V) => number): SortedEntries<V> {
    let sorted = this.#ownSorted.get(by)
    if (!sorted) {
      sorted = sortEntries([
        ...[...this.#changed].map(([key, value]) => ({ key, value, order: by(value), position: this.#ownPosition(key, true) })),
        ...[...this.#added].map(([key, value]) => ({ key, value, order: by(value), position: this.#ownPosition(key, false) })),
      ])
      this.#ownSorted.set(by, sorted)
    }
    return sorted
  }

  /**
   * The group index of the own values (built on the first call, then kept up
   * to date by `set()` and `delete()`).
   * @param by - The group of a value
   */
  #ownGroupsOf(by: (value: V) => string | undefined): OwnGroups {
    let groups = this.#ownGroups.get(by)
    if (!groups) {
      groups = { changed: groupKeys(this.#changed, by), added: groupKeys(this.#added, by) }
      this.#ownGroups.set(by, groups)
    }
    return groups
  }

  /**
   * The keys this fork wrote: changed, deleted, and added ones. For a
   * collection without a base, every key.
   */
  ownKeys(): Set<string> {
    return new Set([...this.#changed.keys(), ...this.#hidden, ...this.#added.keys()])
  }

  /**
   * A number that orders the key like `keys()` does (smaller comes first),
   * without a scan; not a dense index.
   * @param key - The key
   * @returns The key's order number, or `undefined` if it is not stored
   */
  position(key: string): number | undefined {
    const own = this.#addedOrder.get(key)
    if (own !== undefined) {
      return (this.#base ? this.#base.#orderLimit() : 0) + own
    }
    return this.#base && !this.#hidden.has(key) ? this.#base.position(key) : undefined
  }

  /**
   * Stored keys of a list in collection order (keys that are not stored are
   * left out).
   * @param keys - The keys
   */
  inOrder(keys: Iterable<string>): string[] {
    const positioned: Array<[string, number]> = []
    for (const key of keys) {
      const position = this.position(key)
      if (position !== undefined) {
        positioned.push([key, position])
      }
    }
    return positioned.sort((a, b) => a[1] - b[1]).map(([key]) => key)
  }

  /**
   * One more than the largest order number this collection has handed out.
   */
  #orderLimit(): number {
    return (this.#base ? this.#base.#orderLimit() : 0) + this.#nextOrder
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries()
  }

  /**
   * Makes the collection read-only (writes throw), e.g. to fork it.
   * @param deep - Also deep-freeze the stored values
   */
  freeze(deep = false): void {
    if (deep && !this.#freezeValues) {
      for (const value of this.values()) {
        deepFreeze(value)
      }
    }
    this.#frozen = true
  }

  /**
   * A copy-on-write collection on top of this frozen one.
   */
  fork(): Collection<V> {
    if (!this.#frozen) {
      throw new TypeError('fake-c8y: only a frozen collection can be forked')
    }
    return new Collection<V>([], { freezeValues: this.#freezeValues }, this)
  }

  /**
   * A writable copy with this collection's own writes on the same base: it
   * costs as much as the own writes (a collection without a base copies
   * everything), and its `touched()` is the same as this one's.
   */
  copy(): Collection<V> {
    const copy = new Collection<V>([], { freezeValues: this.#freezeValues }, this.#base)
    copy.#changed = new Map(this.#changed)
    copy.#added = new Map(this.#added)
    copy.#hidden = new Set(this.#hidden)
    copy.#addedOrder = new Map(this.#addedOrder)
    copy.#nextOrder = this.#nextOrder
    return copy
  }

  /**
   * Drops everything written since the collection was created: a fork shows
   * its base again, a collection without a base is empty.
   */
  discard(): void {
    this.#writable()
    this.#changed = new Map()
    this.#added = new Map()
    this.#addedOrder = new Map()
    this.#nextOrder = 0
    this.#hidden = new Set()
    this.#ownGroups = new Map()
    this.#ownSorted = new Map()
  }

  /**
   * Replaces the whole content. A fork keeps the base values the new content
   * has unchanged at their base position, so its `touched()` keys and its
   * diff stay small, and hides the others.
   * @param entries - The new content, in order
   */
  replace(entries: Iterable<readonly [string, V]>): void {
    this.discard()
    const base = this.#base
    if (!base) {
      for (const [key, value] of entries) {
        this.set(key, value)
      }
      return
    }
    const positions = base.#positions()
    const kept = new Set<string>()
    // base keys keep their position while they come in base order and before
    // any new key; everything after that goes to the end, like in a `Map`
    let last = -1
    let appending = false
    for (const [key, value] of entries) {
      const position = positions.get(key)
      if (!appending && position !== undefined && position > last) {
        last = position
        kept.add(key)
        if (JSON.stringify(value) !== JSON.stringify(base.get(key))) {
          this.set(key, value)
        }
        continue
      }
      appending = true
      if (position !== undefined && !kept.has(key)) {
        this.#hidden.add(key)
      }
      this.set(key, value)
    }
    for (const key of positions.keys()) {
      if (!kept.has(key)) {
        this.#hidden.add(key)
      }
    }
  }

  /**
   * The keys written since the fork, with their values before and after.
   * For a collection without a base, every value counts as added.
   */
  touched(): TouchedEntries<V> {
    const base = this.#base
    if (!base) {
      return { before: [], after: [...this.#added], recreated: new Set() }
    }
    const byPosition = (keys: Iterable<string>) => {
      const list = [...keys]
      if (list.length > 1) {
        const index = base.#positions()
        list.sort((a, b) => index.get(a)! - index.get(b)!)
      }
      return list
    }
    const before = byPosition(new Set([...this.#changed.keys(), ...this.#hidden])).map((key): [string, V] => [key, base.get(key) as V])
    const after = byPosition(this.#changed.keys()).map((key): [string, V] => [key, this.#changed.get(key)!])
    const recreated = new Set([...this.#added.keys()].filter((key) => this.#hidden.has(key)))
    return { before, after: [...after, ...this.#added], recreated }
  }

  #positions(): Map<string, number> {
    if (!this.#index) {
      this.#index = new Map()
      let position = 0
      for (const key of this.keys()) {
        this.#index.set(key, position++)
      }
    }
    return this.#index
  }

  #writable(): void {
    if (this.#frozen) {
      throw new TypeError('fake-c8y: this world is frozen (it is the base of forks); write to a fork instead')
    }
    this.#version++
  }
}

function groupKeys<V>(entries: Iterable<[string, V]>, by: (value: V) => string | undefined): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const [key, value] of entries) {
    const group = by(value)
    if (group !== undefined) {
      const keys = index.get(group)
      if (keys) {
        keys.push(key)
      } else {
        index.set(group, [key])
      }
    }
  }
  return index
}

/**
 * Group indexes of a collection's own values: of `#changed` (in no particular
 * order) and of `#added` (in insertion order).
 */
interface OwnGroups {
  changed: Map<string, string[]>
  added: Map<string, string[]>
}

/**
 * Keys, values, sort keys, and positions in the collection, in sort order
 * (parallel arrays).
 */
interface SortedEntries<V> {
  keys: string[]
  values: V[]
  orders: number[]
  positions: number[]
}

/**
 * A sorted list that is read lazily: `length`, a `slice()` that walks only up
 * to its end, and iteration.
 */
export interface SortedList<V> extends Iterable<V> {
  readonly length: number
  slice: (start?: number, end?: number) => V[]
}

/**
 * Whether the entry at `index` comes before the entry (`order`, `position`).
 * @param entries
 * @param index
 * @param order
 * @param position
 */
function entryBefore<V>(entries: SortedEntries<V>, index: number, order: number, position: number): boolean {
  const own = entries.orders[index]!
  return own < order || (own === order && entries.positions[index]! < position)
}

/**
 * The first index in `[0, length)` for which `after` holds (it must hold for
 * a suffix of the range).
 * @param length
 * @param after
 */
function lowerBound(length: number, after: (index: number) => boolean): number {
  let low = 0
  let high = length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (after(middle)) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  return low
}

function spliceEntries<V>(entries: SortedEntries<V>, at: number, remove: 0 | 1, ...entry: [] | [string, V, number, number]): void {
  if (entry.length === 0) {
    entries.keys.splice(at, remove)
    entries.values.splice(at, remove)
    entries.orders.splice(at, remove)
    entries.positions.splice(at, remove)
    return
  }
  const [key, value, order, position] = entry
  if (remove === 0 && at === entries.keys.length) {
    entries.keys.push(key)
    entries.values.push(value)
    entries.orders.push(order)
    entries.positions.push(position)
    return
  }
  entries.keys.splice(at, remove, key)
  entries.values.splice(at, remove, value)
  entries.orders.splice(at, remove, order)
  entries.positions.splice(at, remove, position)
}

/**
 * A merge of two sorted entry lists (a frozen base's order without its
 * `skip`ped keys, and a fork's own values), read lazily from either end.
 */
class SortedView<V> implements SortedList<V> {
  readonly #first: SortedEntries<V>
  readonly #second: SortedEntries<V> | undefined
  readonly #skip: ((key: string) => boolean) | undefined
  readonly #reverse: boolean
  readonly #check: () => void
  readonly length: number

  constructor(first: SortedEntries<V>, second: SortedEntries<V> | undefined, skip: ((key: string) => boolean) | undefined, length: number, reverse: boolean, check: () => void) {
    this.#first = first
    this.#second = second
    this.#skip = skip
    this.#reverse = reverse
    this.#check = check
    this.length = length
  }

  slice(start = 0, end: number = this.length): V[] {
    this.#check()
    const length = this.length
    const from = Math.max(0, start < 0 ? length + start : Math.min(start, length))
    const to = Math.max(0, end < 0 ? length + end : Math.min(end, length))
    if (to <= from) {
      return []
    }
    if (!this.#second && !this.#skip) {
      const values = this.#first.values
      return this.#reverse ? values.slice(length - to, length - from).reverse() : values.slice(from, to)
    }
    const page: V[] = []
    let index = 0
    for (const value of this.#walk()) {
      if (index >= to) {
        break
      }
      if (index >= from) {
        page.push(value)
      }
      index++
    }
    return page
  }

  * [Symbol.iterator](): Iterator<V> {
    this.#check()
    for (const value of this.#walk()) {
      yield value
      this.#check()
    }
  }

  * #walk(): Generator<V> {
    const first = this.#first
    const second = this.#second
    const skip = this.#skip ?? (() => false)
    const firstLength = first.keys.length
    const secondLength = second?.keys.length ?? 0
    if (!this.#reverse) {
      let i = 0
      let j = 0
      while (true) {
        while (i < firstLength && skip(first.keys[i]!)) {
          i++
        }
        const hasFirst = i < firstLength
        if (!hasFirst && j >= secondLength) {
          return
        }
        if (hasFirst && (j >= secondLength || entryBefore(first, i, second!.orders[j]!, second!.positions[j]!))) {
          yield first.values[i++]!
        } else {
          yield second!.values[j++]!
        }
      }
    }
    let i = firstLength - 1
    let j = secondLength - 1
    while (true) {
      while (i >= 0 && skip(first.keys[i]!)) {
        i--
      }
      const hasFirst = i >= 0
      if (!hasFirst && j < 0) {
        return
      }
      if (hasFirst && (j < 0 || !entryBefore(first, i, second!.orders[j]!, second!.positions[j]!))) {
        yield first.values[i--]!
      } else {
        yield second!.values[j--]!
      }
    }
  }
}

function sortEntries<V>(entries: Array<{ key: string, value: V, order: number, position: number }>): SortedEntries<V> {
  entries.sort((a, b) => a.order - b.order || a.position - b.position)
  return { keys: entries.map(({ key }) => key), values: entries.map(({ value }) => value), orders: entries.map(({ order }) => order), positions: entries.map(({ position }) => position) }
}
