/**
 * The due-time queue of availability monitoring (src/availability.ts).
 */
export interface Entry {
  time: number
  id: string
  /**
   * Whether the device went UNAVAILABLE by the clock and its unavailability
   * alarm is still to come.
   */
  alarm: boolean
}

const NONE: Entry = { time: Number.POSITIVE_INFINITY, id: '', alarm: false }

/**
 * The queue's order: by due time, ties by device id, so a plain world and a
 * fork (sorted base plus own heap) evaluate due devices in the same order.
 * @param a - An entry
 * @param b - Another one
 */
function before(a: Entry, b: Entry): boolean {
  return a.time < b.time || (a.time === b.time && a.id < b.id)
}

/**
 * The due-time queue of a tenant.
 */
export class AvailabilityQueue {
  /**
   * Entries inherited from a frozen base, sorted by time and id (shared, never changed).
   */
  readonly #base: readonly Entry[]
  #cursor = 0
  /**
   * Own entries: a binary min-heap by time and id (`before()`).
   */
  #heap: Entry[] = []
  /**
   * The current entry of devices this queue scheduled itself (`NONE`:
   * none). Other heap entries of these devices, and their base entries, are
   * stale.
   */
  #scheduled = new Map<string, Entry>()
  /**
   * Whether the queue knows every device (a new or restored tenant is
   * scanned on the first tick).
   */
  built: boolean

  constructor(base: readonly Entry[] = [], built = false) {
    this.#base = base
    this.built = built
  }

  /**
   * A queue for a fork of the (frozen) world this queue belongs to.
   */
  fork(): AvailabilityQueue {
    return new AvailabilityQueue(this.#flat ?? this.#flatten(), this.built)
  }

  #flat: Entry[] | undefined

  /**
   * The pending entries as one sorted array (kept once frozen).
   */
  #flatten(): Entry[] {
    const entries: Entry[] = []
    for (let index = this.#cursor; index < this.#base.length; index++) {
      const entry = this.#base[index]!
      if (!this.#scheduled.has(entry.id)) {
        entries.push(entry)
      }
    }
    for (const entry of this.#heap) {
      if (this.#scheduled.get(entry.id) === entry) {
        entries.push(entry)
      }
    }
    entries.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    this.#flat = entries
    return entries
  }

  /**
   * Schedules a look at a device (replacing its earlier schedule).
   * @param id - Managed object id
   * @param time - Epoch milliseconds, `Infinity` for none
   * @param alarm - Whether the unavailability alarm is still to come
   */
  schedule(id: string, time: number, alarm = false): void {
    const current = this.#scheduled.get(id)
    if (current && current.time === time && current.alarm === alarm) {
      return
    }
    if (time === Number.POSITIVE_INFINITY) {
      this.#scheduled.set(id, NONE)
      return
    }
    const entry = { time, id, alarm }
    this.#scheduled.set(id, entry)
    push(this.#heap, entry)
  }

  /**
   * Removes and returns the next entry due at `now`, if any.
   * @param now - Epoch milliseconds
   */
  next(now: number): Entry | undefined {
    for (;;) {
      const fromBase = this.#base[this.#cursor]
      const own = this.#heap[0]
      if (fromBase && (!own || !before(own, fromBase))) {
        if (fromBase.time > now) {
          return undefined
        }
        this.#cursor++
        if (!this.#scheduled.has(fromBase.id)) {
          this.#scheduled.set(fromBase.id, NONE)
          return fromBase
        }
        continue
      }
      if (!own || own.time > now) {
        return undefined
      }
      pop(this.#heap)
      if (this.#scheduled.get(own.id) === own) {
        this.#scheduled.set(own.id, NONE)
        return own
      }
    }
  }
}

function push(heap: Entry[], entry: Entry): void {
  heap.push(entry)
  let index = heap.length - 1
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (!before(entry, heap[parent]!)) {
      break
    }
    heap[index] = heap[parent]!
    index = parent
  }
  heap[index] = entry
}

function pop(heap: Entry[]): void {
  const last = heap.pop()!
  if (heap.length === 0) {
    return
  }
  let index = 0
  for (;;) {
    const left = 2 * index + 1
    if (left >= heap.length) {
      break
    }
    const right = left + 1
    const child = right < heap.length && before(heap[right]!, heap[left]!) ? right : left
    if (!before(heap[child]!, last)) {
      break
    }
    heap[index] = heap[child]!
    index = child
  }
  heap[index] = last
}
