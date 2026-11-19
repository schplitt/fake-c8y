/**
 * Notification 2.0 in the fake tenant: subscriptions, tokens, and consumer
 * WebSockets (in memory). Data changes are published to matching
 * subscriptions as frames in the platform's format:
 *
 * ```
 * <ackId>
 * /<tenant>/<api>/<sourceId>
 * CREATE | UPDATE | DELETE
 *
 * <JSON payload>
 * ```
 *
 * Subscriptions and tokens are tenant data (`TenantData.notificationSubscriptions`,
 * `TenantData.notificationTokens`): they fork, reset, snapshot, and diff with
 * the rest of the data. `Realtime` keeps what is not data: the consumer
 * sockets and the frames on their way. `world.reset()` and `world.restore()`
 * drop undelivered frames and close the sockets (open or connecting) whose token or
 * subscription is gone (with `CONSUMER_REMOVED`). `closeConsumers()` closes sockets from the server side
 * to test a client's reconnect path.
 * The consumer WebSocket is in `./websocket` (the `fake-c8y/realtime` entry).
 */
import type { StoredDocument } from './store'
import { scheduleReal, SettleTimeoutError, waitForQuiet } from './timers'

export type RealtimeApi = 'managedobjects' | 'measurements' | 'events' | 'alarms' | 'operations'

/**
 * Notification 2.0 subscription as stored by the fake.
 */
export interface NotificationSubscription {
  id: string
  tenant: string
  context: 'mo' | 'tenant'
  subscription: string
  source?: { id: string }
  subscriptionFilter?: { apis?: string[], typeFilter?: string }
  fragmentsToCopy?: string[]
  nonPersistent?: boolean
}

export interface NotificationToken {
  tenant: string
  subscription: string
  subscriber: string
  /**
   * When the token expires (epoch milliseconds); a socket cannot connect with
   * it from then on. Missing: it never expires (tokens of older snapshots).
   */
  expires?: number
}

export interface NotificationFrame {
  ackId: string
  text: string
}

/**
 * Standard properties, which `fragmentsToCopy` always keeps (verified for
 * events; assumed for the other APIs).
 */
const STANDARD_FIELDS = new Set(['id', 'self', 'type', 'text', 'time', 'source', 'creationTime', 'lastUpdated', 'severity', 'status', 'count', 'firstOccurrenceTime', 'deviceId', 'deviceName', 'description', 'failureReason', 'name', 'owner'])

/**
 * With `fragmentsToCopy`, the platform delivers only the named fragments next
 * to the standard properties.
 * @param document - The rendered object
 * @param fragments - The subscription's `fragmentsToCopy`
 */
function copyFragments(document: StoredDocument, fragments: string[] | undefined): StoredDocument {
  if (!fragments || fragments.length === 0) {
    return document
  }
  return Object.fromEntries(Object.entries(document).filter(([key]) => STANDARD_FIELDS.has(key) || fragments.includes(key))) as StoredDocument
}

function typesOf(typeFilter: unknown): string[] | undefined {
  if (typeof typeFilter !== 'string' || !typeFilter) {
    return undefined
  }
  const quoted = [...typeFilter.matchAll(/'([^']*)'/g)].map((match) => match[1]!)
  return quoted.length > 0 ? quoted : typeFilter.split(/\s+or\s+/).map((type) => type.trim())
}

/**
 * The token a consumer socket connects with (its URL's `token` parameter).
 * @param socket - The consumer socket
 */
export function tokenOf(socket: Pick<NotificationSocket, 'url'>): string {
  return new URL(socket.url).searchParams.get('token') ?? ''
}

/**
 * A consumer WebSocket connected to the fake (see `fake-c8y/realtime`).
 */
export interface NotificationSocket {
  readonly url: string
  readyState: number
  token: NotificationToken | undefined
  emit: (event: string, ...args: unknown[]) => void
  /**
   * Emits a delivered frame as a `message` event.
   */
  receive: (text: string) => void
  /**
   * Closes the socket (e.g. when its consumer is unsubscribed).
   */
  close: () => void
}

/**
 * WebSocket ready states.
 */
export const SOCKET_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const

/**
 * Close code and reason of a consumer socket whose token `world.reset()` or
 * `world.restore()` removed (also when its subscription is gone): the consumer
 * no longer exists, so a client should not reconnect with it. The platform
 * documents no close code for this; the code is fake-c8y's own, in the
 * application range (4000-4999), modeled on HTTP 410 Gone.
 */
export const CONSUMER_REMOVED = { code: 4410, reason: 'notification token removed' } as const

/**
 * Which consumer sockets `Realtime.closeConsumers()` closes, and how.
 */
export interface CloseConsumersOptions {
  /**
   * Only sockets of this tenant.
   */
  tenant?: string
  /**
   * Only sockets of this subscription name.
   */
  subscription?: string
  /**
   * Only sockets of this subscriber.
   */
  subscriber?: string
  /**
   * Only the sockets connected with this token.
   */
  token?: string
  /**
   * Close code the client sees, from 1000 to 4999. `1006` is allowed on
   * purpose: a peer never sends it, but it is what a client sees when the
   * connection drops.
   * @default 1006 (abnormal closure: the connection dropped)
   */
  code?: number
  /**
   * Close reason the client sees.
   * @default ''
   */
  reason?: string
}

export interface RealtimeOptions {
  /**
   * Runs a callback later (frame delivery, socket events).
   * @default the real `setTimeout(callback, 0)`, captured when fake-c8y is
   * loaded (fake timers installed later do not hold delivery back)
   */
  schedule?: (callback: () => void) => void
  /**
   * Requests the world is answering right now (handlers may still publish).
   */
  inflight?: () => number
  /**
   * The stored subscriptions of all tenants (the world's tenant data).
   * @default none
   */
  subscriptions?: () => Iterable<NotificationSubscription>
  /**
   * The stored tokens of all tenants, by token value (the world's tenant data).
   * @default none
   */
  tokens?: () => Iterable<[string, NotificationToken]>
  /**
   * The current time in epoch milliseconds (expired tokens are refused on connect).
   * @default `Date.now`
   */
  now?: () => number
}

/**
 * What a world's Notification 2.0 still has on its way (`realtime.status()`).
 */
export interface RealtimeStatus {
  /**
   * Requests the world is answering right now (handlers may still publish).
   */
  inflight: number
  /**
   * Callbacks scheduled and not run yet: frame deliveries, socket connects,
   * and socket events (`open`, `close`, `pong`).
   */
  scheduled: number
  /**
   * Sockets created whose connect has not run yet.
   */
  connecting: number
  /**
   * Frames delivered to a socket and not acknowledged yet.
   */
  unacknowledged: number
  /**
   * Frames held for a persistent subscription without an open consumer. They
   * are kept only once a consumer of the subscription has connected, like on
   * the platform. Informational: `settled()` does not wait for them.
   */
  backlog: number
  /**
   * Always 0.
   * @deprecated Nothing is kept before a consumer has connected, so no frame is held without a consumer.
   */
  unclaimed: number
}

export interface RealtimeSettledOptions {
  /**
   * Milliseconds to wait before rejecting.
   * @default 5000
   */
  timeout?: number
  /**
   * Milliseconds the world must stay settled without interruption before
   * `settled()` resolves. Raise it when a consumer acknowledges a frame and
   * only writes after a longer await of its own.
   * @default 20
   */
  quietMs?: number
}

/**
 * An open consumer socket (`realtime.consumers()`).
 */
export interface RealtimeConsumer {
  tenant: string
  subscription: string
  subscriber: string
  /**
   * The token the socket connected with.
   */
  token: string
}

/**
 * Result of `realtime.settled()`.
 */
export interface RealtimeSettledResult {
  /**
   * Milliseconds waited.
   */
  waitedMs: number
  /**
   * The status when it settled. `backlog` can be above 0:
   * `settled()` does not wait for stored frames.
   */
  status: RealtimeStatus
}

/**
 * Notification 2.0 of one world: consumer sockets and frames on their way.
 * Subscriptions and tokens are read from the world's tenant data.
 */
export class Realtime {
  nextAck = 1
  sockets: Set<NotificationSocket> = new Set()
  /**
   * sockets created whose connect has not run yet
   */
  connecting: Set<NotificationSocket> = new Set()
  /**
   * frames waiting for a consumer of a subscription name (persistent subscriptions)
   */
  backlog: Map<string, NotificationFrame[]> = new Map()
  /**
   * subscriptions (by `key()`) a consumer has connected to: only they keep a
   * backlog, like on the platform
   */
  private connected: Set<string> = new Set()
  /**
   * delivered but not yet acknowledged frames, per socket
   */
  unacked: Map<NotificationSocket, Set<string>> = new Map()
  /**
   * Runs a callback later (the `schedule` option), counted in
   * `status().scheduled` until it ran.
   */
  readonly schedule: (callback: () => void) => void
  /**
   * callbacks given to `schedule` since the last `dropPending()` that have
   * not run yet
   */
  private tasks = 0
  private readonly inflight: () => number
  private readonly storedSubscriptions: () => Iterable<NotificationSubscription>
  private readonly storedTokens: () => Iterable<[string, NotificationToken]>
  private readonly now: () => number
  /**
   * frames scheduled for or delivered to a socket and not yet acknowledged,
   * by ack id (put back into the backlog when the socket closes)
   */
  private readonly outstanding: Map<NotificationSocket, Map<string, NotificationFrame>> = new Map()
  /**
   * Bumped by `dropPending()`: frames scheduled before are not delivered.
   */
  private generation = 0

  constructor(options: RealtimeOptions = {}) {
    const schedule = options.schedule ?? scheduleReal
    this.schedule = (callback) => {
      this.tasks++
      // dropPending() resets the count: a callback scheduled before no
      // longer counts, also if the schedule never calls it
      const generation = this.generation
      let ran = false
      schedule(() => {
        if (!ran) {
          ran = true
          if (generation === this.generation) {
            this.tasks--
          }
        }
        callback()
      })
    }
    this.inflight = options.inflight ?? (() => 0)
    this.storedSubscriptions = options.subscriptions ?? (() => [])
    this.storedTokens = options.tokens ?? (() => [])
    this.now = options.now ?? Date.now
  }

  /**
   * The stored subscriptions of all tenants (a copy of the list).
   */
  get subscriptions(): NotificationSubscription[] {
    return [...this.storedSubscriptions()]
  }

  /**
   * The stored tokens of all tenants, by token value (a copy of the map).
   */
  get tokens(): Map<string, NotificationToken> {
    return new Map(this.storedTokens())
  }

  connect(socket: NotificationSocket): void {
    this.connecting.delete(socket)
    if (socket.readyState === SOCKET_STATE.CLOSED) {
      // the client closed it while connecting: its close event is on its way
      return
    }
    const token = this.tokens.get(tokenOf(socket))
    // an expired token is refused like an unknown one; an open socket stays open
    if (!token || (typeof token.expires === 'number' && this.now() >= token.expires)) {
      socket.readyState = SOCKET_STATE.CLOSED
      socket.emit('error', new Error('Invalid notification token'))
      socket.emit('close', 1008, 'invalid token')
      return
    }
    socket.token = token
    socket.readyState = SOCKET_STATE.OPEN
    this.sockets.add(socket)
    this.unacked.set(socket, new Set())
    this.outstanding.set(socket, new Map())
    socket.emit('open')
    const key = this.key(token.tenant, token.subscription)
    this.connected.add(key)
    const waiting = this.backlog.get(key) ?? []
    this.backlog.delete(key)
    for (const frame of waiting) {
      this.deliver(socket, frame)
    }
  }

  /**
   * Removes a closed consumer socket. Its unacknowledged frames go back into
   * the subscription's backlog (`requeue()`), unless its token is no longer
   * stored (unsubscribe removed the consumer).
   * @param socket - The closed socket
   */
  disconnect(socket: NotificationSocket): void {
    const frames = [...(this.outstanding.get(socket)?.values() ?? [])]
    this.connecting.delete(socket)
    this.sockets.delete(socket)
    this.unacked.delete(socket)
    this.outstanding.delete(socket)
    const token = socket.token
    if (!token || frames.length === 0) {
      return
    }
    const key = tokenOf(socket)
    for (const [stored] of this.storedTokens()) {
      if (stored === key) {
        this.requeue(token, frames)
        return
      }
    }
  }

  /**
   * After an unsubscribe closed its consumer's sockets: drops the
   * subscription's backlog and forgets that a consumer connected, like the
   * platform. Does nothing while another consumer of the subscription is
   * still open, so that consumer keeps its backlog once it closes.
   * @param tenant - The subscription's tenant
   * @param subscription - The subscription name
   */
  unsubscribed(tenant: string, subscription: string): void {
    if ([...this.sockets].some((socket) => socket.token?.tenant === tenant && socket.token.subscription === subscription)) {
      return
    }
    const key = this.key(tenant, subscription)
    this.backlog.delete(key)
    this.connected.delete(key)
  }

  acknowledge(socket: NotificationSocket, ackId: string): void {
    this.unacked.get(socket)?.delete(ackId)
    this.outstanding.get(socket)?.delete(ackId)
  }

  key(tenant: string, subscription: string): string {
    return `${tenant}\u0000${subscription}`
  }

  deliver(socket: NotificationSocket, frame: NotificationFrame): void {
    const generation = this.generation
    this.outstanding.get(socket)?.set(frame.ackId, frame)
    this.schedule(() => {
      if (generation !== this.generation) {
        // dropped by dropPending()
        return
      }
      if (socket.readyState !== SOCKET_STATE.OPEN) {
        return
      }
      this.unacked.get(socket)?.add(frame.ackId)
      socket.receive(frame.text)
    })
  }

  /**
   * Publishes a data change to every matching subscription.
   * @param tenant - Tenant of the data
   * @param api - Notification API, e.g. `measurements`
   * @param action - CREATE, UPDATE, or DELETE
   * @param document - The rendered object (for DELETE: `{ id }` plus its source)
   * @param sourceId - Device id the notification is about
   * @param subscriptions - The tenant's subscriptions (default: the stored ones)
   */
  publish(tenant: string, api: RealtimeApi, action: 'CREATE' | 'UPDATE' | 'DELETE', document: StoredDocument, sourceId: string | undefined, subscriptions: Iterable<NotificationSubscription> = this.storedSubscriptions()): void {
    const names = new Map<string, NotificationSubscription>()
    for (const subscription of subscriptions) {
      if (subscription.tenant !== tenant) {
        continue
      }
      const apis = Array.isArray(subscription.subscriptionFilter?.apis) ? subscription.subscriptionFilter.apis : ['*']
      if (!apis.includes('*') && !apis.includes(api)) {
        continue
      }
      if (subscription.context === 'mo' && subscription.source?.id !== sourceId) {
        continue
      }
      const types = typesOf(subscription.subscriptionFilter?.typeFilter)
      if (types && !types.includes(String(document.type))) {
        continue
      }
      names.set(subscription.subscription, subscription)
    }
    for (const [name, subscription] of names) {
      const ackId = String(this.nextAck++)
      // verified: a DELETE notification's payload is not JSON but an opaque
      // object string; the deleted object's id is only in the description
      const payload = action === 'DELETE'
        ? `com.cumulocity.notification.service.RealtimeDeletedObject$1@${(this.nextAck * 2654435761 >>> 0).toString(16)}`
        : JSON.stringify(copyFragments(document, subscription.fragmentsToCopy))
      const frame: NotificationFrame = {
        ackId,
        text: `${ackId}\n/${tenant}/${api}/${sourceId ?? document.id}\n${action}\n\n${payload}`,
      }
      const consumers = [...this.sockets].filter((socket) => socket.token?.tenant === tenant && socket.token.subscription === name)
      if (consumers.length > 0) {
        for (const socket of consumers) {
          this.deliver(socket, frame)
        }
      } else {
        const key = this.key(tenant, name)
        if (!subscription.nonPersistent && this.connected.has(key)) {
          this.backlog.set(key, [...(this.backlog.get(key) ?? []), frame])
        }
      }
    }
  }

  /**
   * What is still on its way, split up. `settled()` and `pending()` count
   * only the live work (`inflight`, `scheduled`, `connecting`,
   * `unacknowledged`); `backlog` is frames stored for subscriptions without
   * an open consumer, which may never be delivered. `unclaimed` is always 0.
   */
  status(): RealtimeStatus {
    let unacknowledged = 0
    for (const acks of this.unacked.values()) {
      unacknowledged += acks.size
    }
    let backlog = 0
    for (const frames of this.backlog.values()) {
      backlog += frames.length
    }
    return { inflight: this.inflight(), scheduled: this.tasks, connecting: this.connecting.size, unacknowledged, backlog, unclaimed: 0 }
  }

  /**
   * Waits until the live work is done, including notifications caused by the
   * consumers' own writes: no request in flight, no callback scheduled, no
   * socket connecting, and nothing delivered and unacknowledged, for
   * `quietMs` on the real timers. Frames stored for a subscription without
   * an open consumer (`status().backlog`) are not waited for: like the
   * platform, they stay stored until a consumer connects.
   * @param options - `timeout` (default 5000 ms), `quietMs` (default 20 ms)
   * @returns How long it waited and the status it settled with
   * @throws {SettleTimeoutError} when it is not settled within the timeout
   * @example
   * ```ts
   * world.seed({ measurements: [{ source: pump, type: 'c8y_Temperature', c8y_Temperature: { T: { value: 95, unit: 'C' } } }] })
   * await world.realtime.settled()
   * expect(world.db.alarms.find({ source: pump })).toHaveLength(1)
   * ```
   */
  async settled(options: RealtimeSettledOptions = {}): Promise<RealtimeSettledResult> {
    const timeout = options.timeout ?? 5000
    const { quiet, waitedMs } = await waitForQuiet(() => this.pending() === 0, { timeout, quietMs: options.quietMs ?? 20 })
    const status = this.status()
    if (!quiet) {
      throw new SettleTimeoutError('realtime.settled()', timeout, { inflight: status.inflight, scheduled: status.scheduled, connecting: status.connecting, unacknowledged: status.unacknowledged })
    }
    return { waitedMs, status }
  }

  /**
   * The live work `settled()` waits for: requests in flight, scheduled
   * callbacks, sockets connecting, and frames delivered and not yet
   * acknowledged. Stored frames (`status().backlog`) are not counted.
   */
  pending(): number {
    let count = this.inflight() + this.tasks + this.connecting.size
    for (const acks of this.unacked.values()) {
      count += acks.size
    }
    return count
  }

  /**
   * The open consumer sockets, one entry per socket (sockets still
   * connecting are not listed).
   * @param filter - Only sockets of this tenant, subscription, subscriber, or token (like `closeConsumers()`)
   * @returns New objects, in the order the sockets opened
   * @example
   * ```ts
   * await expect.poll(() => world.realtime.consumers({ subscription: 'alarms' }).length).toBe(1)
   * ```
   */
  consumers(filter: Pick<CloseConsumersOptions, 'tenant' | 'subscription' | 'subscriber' | 'token'> = {}): RealtimeConsumer[] {
    return [...this.sockets].filter((socket) => this.matches(socket, filter)).flatMap((socket) => socket.token
      ? [{ tenant: socket.token.tenant, subscription: socket.token.subscription, subscriber: socket.token.subscriber, token: tokenOf(socket) }]
      : [])
  }

  private matches(socket: NotificationSocket, filter: Pick<CloseConsumersOptions, 'tenant' | 'subscription' | 'subscriber' | 'token'>): boolean {
    const token = socket.token
    return (filter.tenant === undefined || token?.tenant === filter.tenant)
      && (filter.subscription === undefined || token?.subscription === filter.subscription)
      && (filter.subscriber === undefined || token?.subscriber === filter.subscriber)
      && (filter.token === undefined || tokenOf(socket) === filter.token)
  }

  /**
   * Drops undelivered notifications, also the ones already scheduled (data
   * reset between tests), and forgets which subscriptions had a consumer.
   */
  dropPending(): void {
    this.generation++
    this.tasks = 0
    this.backlog.clear()
    this.connected.clear()
    for (const acks of this.unacked.values()) {
      acks.clear()
    }
    for (const frames of this.outstanding.values()) {
      frames.clear()
    }
  }

  /**
   * Drops undelivered notifications and closes the sockets whose token or
   * subscription is no longer stored (after the data was reset or restored),
   * with `CONSUMER_REMOVED`, also the ones still connecting. The sockets that
   * stay open count as connected; a connecting one that stays counts once it opens.
   */
  resync(): void {
    this.dropPending()
    const tokens = new Map(this.storedTokens())
    const subscriptions = new Set([...this.storedSubscriptions()].map((subscription) => this.key(subscription.tenant, subscription.subscription)))
    for (const socket of [...this.sockets, ...this.connecting]) {
      const token = tokens.get(tokenOf(socket))
      if (token === undefined || !subscriptions.has(this.key(token.tenant, token.subscription))) {
        this.closeFromServer(socket, CONSUMER_REMOVED.code, CONSUMER_REMOVED.reason)
      } else if (socket.readyState === SOCKET_STATE.OPEN) {
        this.connected.add(this.key(token.tenant, token.subscription))
      }
    }
  }

  /**
   * Closes open consumer sockets from the server side, as if the connection
   * dropped or the platform closed it, to test a client's reconnect path. The
   * subscriptions and tokens stay stored, so the client can reconnect (with the
   * same token or a new one). When no other consumer of the subscription stays
   * open and the subscription is persistent, the frames the socket had not
   * acknowledged (delivered or still scheduled) go back into the subscription's
   * backlog, and frames published meanwhile wait there too: the next consumer
   * of the subscription that connects gets them. Otherwise they are lost for
   * this consumer. The platform's redelivery is not verified. The `close`
   * event is emitted synchronously.
   * @param options - Which sockets (all open ones by default), code, and reason
   * @returns How many sockets were closed
   * @example
   * ```ts
   * world.realtime.closeConsumers({ subscription: 'alarms', code: 1011, reason: 'internal error' })
   * ```
   */
  closeConsumers(options: CloseConsumersOptions = {}): number {
    const { code = 1006, reason = '' } = options
    if (!Number.isInteger(code) || code < 1000 || code > 4999) {
      throw new RangeError(`fake-c8y: closeConsumers() needs a close code from 1000 to 4999, got ${code}`)
    }
    let closed = 0
    for (const socket of [...this.sockets]) {
      if (!this.matches(socket, options)) {
        continue
      }
      // disconnect() puts the unacknowledged frames back
      this.closeFromServer(socket, code, reason)
      closed++
    }
    return closed
  }

  /**
   * Puts the unacknowledged frames of a closed consumer back into its
   * subscription's backlog (in ack order, before the frames published since),
   * when the subscription is persistent and has no other open consumer.
   * @param token - The closed consumer's token
   * @param frames - Its unacknowledged frames
   */
  private requeue(token: NotificationToken, frames: NotificationFrame[]): void {
    if (frames.length === 0 || [...this.sockets].some((socket) => socket.token?.tenant === token.tenant && socket.token.subscription === token.subscription)) {
      return
    }
    const persistent = [...this.storedSubscriptions()].some((subscription) => subscription.tenant === token.tenant && subscription.subscription === token.subscription && !subscription.nonPersistent)
    if (!persistent) {
      return
    }
    const key = this.key(token.tenant, token.subscription)
    const byAck = new Map([...frames, ...(this.backlog.get(key) ?? [])].map((frame) => [frame.ackId, frame]))
    this.backlog.set(key, [...byAck.values()].sort((a, b) => Number(a.ackId) - Number(b.ackId)))
  }

  private closeFromServer(socket: NotificationSocket, code: number, reason: string): void {
    this.disconnect(socket)
    socket.readyState = SOCKET_STATE.CLOSED
    socket.emit('close', code, reason)
  }

  /**
   * Closes every socket (with `1000`, like a normal close: it tears the
   * world's consumers down) and drops undelivered notifications.
   */
  clear(): void {
    for (const socket of this.sockets) {
      socket.readyState = SOCKET_STATE.CLOSED
      socket.emit('close', 1000, '')
    }
    this.sockets.clear()
    this.connecting.clear()
    this.unacked.clear()
    this.outstanding.clear()
    this.dropPending()
  }
}
